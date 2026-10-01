-- Hand-written: a least-privilege role for the app's privileged connection (JOBS_DATABASE_URL),
-- so that connection is NOT the `postgres` owner (tenant-isolation audit M2).
--   tillflow_ops may: execute the ops.* SECURITY DEFINER functions, and own the pgboss schema
--   (pg-boss creates and drops queue partitions at runtime).
--   tillflow_ops may NOT: read or write any business table, or anything else in public/app.
-- It is created NOLOGIN. The owner enables it once per project in the Supabase SQL editor, with a
-- password that lives only in the password manager (never in a migration or in chat):
--   alter role tillflow_ops with login password '...';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tillflow_ops') then
    create role tillflow_ops nologin noinherit;
  end if;
end
$$;

-- The migrating role must be a member to hand ownership of the pgboss objects over.
grant tillflow_ops to postgres;

-- ops: call the functions, nothing else.
grant usage on schema ops to tillflow_ops;
grant execute on all functions in schema ops to tillflow_ops;
alter default privileges in schema ops grant execute on functions to tillflow_ops;

-- pgboss: the role owns the schema and every object in it.
alter schema pgboss owner to tillflow_ops;

do $$
declare
  r record;
begin
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pgboss' and c.relkind in ('r', 'p')
  loop
    execute format('alter table pgboss.%I owner to tillflow_ops', r.relname);
  end loop;

  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pgboss' and c.relkind = 'S'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))
  loop
    execute format('alter sequence pgboss.%I owner to tillflow_ops', r.relname);
  end loop;

  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pgboss'
  loop
    execute format('alter function pgboss.%I(%s) owner to tillflow_ops', r.proname, r.args);
  end loop;

  for r in
    select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'pgboss' and t.typtype in ('e', 'd', 'c')
      and not exists (select 1 from pg_class c where c.reltype = t.oid)
  loop
    execute format('alter type pgboss.%I owner to tillflow_ops', r.typname);
  end loop;
end
$$;

-- Objects tillflow_ops creates later in pgboss stay closed to clients.
alter default privileges for role tillflow_ops in schema pgboss
  revoke all on tables from public, anon, authenticated;
alter default privileges for role tillflow_ops in schema pgboss
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role tillflow_ops in schema pgboss
  revoke execute on functions from public, anon, authenticated;
