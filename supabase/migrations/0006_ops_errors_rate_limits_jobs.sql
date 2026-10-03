-- Hand-written: platform "ops" tables, so errors, rate limits and job state live in our own Postgres.
--   error_events  our own error log (grouped by fingerprint)
--   rate_limits   fixed-window counters for the auth rate limiter
--   job_runs      last-run guards for scheduled jobs, and the worker heartbeat
-- These are platform tables, not business tables, so they have no org_id (like tax_rates).
-- Clients never touch them: RLS is on with an explicit deny-all policy, and every grant to
-- anon/authenticated is revoked. The app reaches them only through the SECURITY DEFINER
-- functions in schema `ops`, which only service_role (and the owner) may execute, and which
-- PostgREST does not expose (only public and graphql_public are exposed).

create schema ops;
revoke all on schema ops from public;
grant usage on schema ops to service_role;

-- ---------------------------------------------------------------- tables

create table public.error_events (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique check (fingerprint ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('server', 'browser', 'job')),
  message text not null,
  stack text,
  route text,
  environment text,
  -- Allow-listed, scrubbed context only (route, method, status, commit, org_id/user_id as UUIDs).
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object' and pg_column_size(context) < 4000),
  count integer not null default 1,
  status text not null default 'new' check (status in ('new', 'resolved', 'ignored')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_alerted_at timestamptz
);
create index error_events_last_seen_idx on public.error_events (last_seen_at);

create table public.rate_limits (
  bucket text not null check (length(bucket) between 1 and 40),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null default now(),
  hits integer not null default 1,
  primary key (bucket, key_hash)
);
create index rate_limits_window_start_idx on public.rate_limits (window_start);

create table public.job_runs (
  job text not null check (length(job) between 1 and 60),
  period text not null check (length(period) between 1 and 40),
  ran_at timestamptz not null default now(),
  primary key (job, period)
);

alter table public.error_events enable row level security;
alter table public.rate_limits enable row level security;
alter table public.job_runs enable row level security;

create policy error_events_deny_all on public.error_events as restrictive for all
  to anon, authenticated using (false) with check (false);
create policy rate_limits_deny_all on public.rate_limits as restrictive for all
  to anon, authenticated using (false) with check (false);
create policy job_runs_deny_all on public.job_runs as restrictive for all
  to anon, authenticated using (false) with check (false);

revoke all on public.error_events, public.rate_limits, public.job_runs from public, anon, authenticated;

-- ---------------------------------------------------------------- errors

-- Upserts one occurrence. Returns whether an alert email should go out: only when the
-- fingerprint is new, or was 'resolved' and came back; never for 'ignored'; at most once per
-- fingerprint per hour; never for browser reports (anyone can post those, so they reach the
-- owner only through the daily digest); and at most 10 alerts per hour in total. The alert is claimed with a conditional UPDATE under the row lock, so two
-- app instances cannot both send.
create function ops.record_error(
  p_fingerprint text,
  p_source text,
  p_message text,
  p_stack text,
  p_route text,
  p_environment text,
  p_context jsonb default '{}'::jsonb
) returns table (is_new boolean, should_alert boolean, occurrences integer)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer;
  v_status text;
  v_inserted boolean;
  v_prev_status text;
  v_alert boolean := false;
begin
  select e.status into v_prev_status from public.error_events e where e.fingerprint = p_fingerprint;

  insert into public.error_events as e (fingerprint, source, message, stack, route, environment, context)
  values (p_fingerprint, p_source, left(p_message, 1000), left(p_stack, 8000),
          left(p_route, 300), left(p_environment, 20), coalesce(p_context, '{}'::jsonb))
  on conflict (fingerprint) do update
    set count = e.count + 1,
        last_seen_at = now(),
        message = excluded.message,
        stack = coalesce(excluded.stack, e.stack),
        route = coalesce(excluded.route, e.route),
        context = excluded.context,
        status = case when e.status = 'resolved' then 'new' else e.status end
  returning e.id, e.count, e.status, (e.xmax = 0) into v_id, v_count, v_status, v_inserted;
  -- xmax = 0: the row was inserted, not updated.

  if v_status <> 'ignored' and p_source <> 'browser'
     and (v_inserted or v_prev_status = 'resolved')
     and (select count(*) from public.error_events a
          where a.last_alerted_at > now() - interval '1 hour') < 10 then
    update public.error_events e set last_alerted_at = now()
    where e.id = v_id and (e.last_alerted_at is null or e.last_alerted_at < now() - interval '1 hour')
    returning true into v_alert;
  end if;

  return query select v_inserted, coalesce(v_alert, false), v_count;
end
$$;

-- Unresolved errors seen since p_since, busiest first (for the daily digest).
create function ops.error_digest(p_since timestamptz)
returns table (fingerprint text, source text, message text, route text, occurrences integer,
               status text, first_seen_at timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select e.fingerprint, e.source, e.message, e.route, e.count, e.status, e.first_seen_at, e.last_seen_at
  from public.error_events e
  where e.last_seen_at >= p_since and e.status = 'new'
  order by e.count desc
  limit 50
$$;

create function ops.prune_error_events(p_days integer default 90) returns integer
language sql volatile security definer set search_path = ''
as $$
  with gone as (
    delete from public.error_events where last_seen_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*)::integer from gone
$$;

-- ---------------------------------------------------------------- rate limits

-- Atomic fixed-window counter: one INSERT ... ON CONFLICT DO UPDATE holds the row lock, so
-- concurrent callers are counted one at a time. Refused attempts still count, but never extend
-- the window. Returns whether this attempt is allowed, how many are left in the window, and
-- how many seconds until the window resets (0 when allowed).
create function ops.check_rate_limit(
  p_bucket text,
  p_key_hash text,
  p_max integer,
  p_window_seconds integer
) returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language sql volatile security definer set search_path = ''
as $$
  with hit as (
    insert into public.rate_limits as r (bucket, key_hash, window_start, hits)
    values (p_bucket, p_key_hash, now(), 1)
    on conflict (bucket, key_hash) do update
      set hits = case when r.window_start <= now() - make_interval(secs => p_window_seconds)
                      then 1 else r.hits + 1 end,
          window_start = case when r.window_start <= now() - make_interval(secs => p_window_seconds)
                              then now() else r.window_start end
    returning r.hits, r.window_start
  )
  select hit.hits <= p_max,
         greatest(p_max - hit.hits, 0),
         case when hit.hits <= p_max then 0
              else greatest(ceil(extract(epoch from
                     hit.window_start + make_interval(secs => p_window_seconds) - now()))::integer, 1)
         end
  from hit
$$;

create function ops.cleanup_rate_limits() returns integer
language sql volatile security definer set search_path = ''
as $$
  with gone as (
    delete from public.rate_limits where window_start < now() - interval '1 day' returning 1
  )
  select count(*)::integer from gone
$$;

-- ---------------------------------------------------------------- jobs

-- Returns true exactly once per (job, period), so a job that runs hourly can do its daily work
-- once, on whichever instance and hour gets there first (catch-up after the app was asleep).
create function ops.claim_job_run(p_job text, p_period text) returns boolean
language sql volatile security definer set search_path = ''
as $$
  with claimed as (
    insert into public.job_runs (job, period) values (p_job, p_period)
    on conflict do nothing
    returning 1
  )
  select exists (select 1 from claimed)
$$;

create function ops.prune_job_runs(p_days integer default 30) returns integer
language sql volatile security definer set search_path = ''
as $$
  with gone as (
    delete from public.job_runs
    where job <> 'heartbeat' and ran_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*)::integer from gone
$$;

create function ops.touch_heartbeat() returns void
language sql volatile security definer set search_path = ''
as $$
  insert into public.job_runs (job, period, ran_at) values ('heartbeat', 'latest', now())
  on conflict (job, period) do update set ran_at = now()
$$;

-- Seconds since the worker last beat, or null if it never has. Also the health check's DB probe.
create function ops.heartbeat_age_seconds() returns integer
language sql stable security definer set search_path = ''
as $$
  select extract(epoch from now() - ran_at)::integer
  from public.job_runs where job = 'heartbeat' and period = 'latest'
$$;

-- ---------------------------------------------------------------- grants

revoke all on all functions in schema ops from public, anon, authenticated;
grant execute on all functions in schema ops to service_role;
-- Functions added to ops later must not become executable by PUBLIC by default.
alter default privileges in schema ops revoke execute on functions from public;
