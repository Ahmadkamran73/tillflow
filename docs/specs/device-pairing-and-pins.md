# Register pairing, staff PINs and manager override (Phase 1 · Step 1.7)

Implements PLAN §10 (Auth). Replaces the step 1.6 stand-in (`authenticateRegister` accepting any signed-in member).

## Goals

- A till is a **paired device**, not a signed-in user. It holds one revocable device token and no Supabase session, so nobody can reach the back office from it.
- Whoever is serving unlocks the till with a **4–6 digit PIN**. A PIN means nothing on an unpaired device.
- Refunds, discounts above a limit and no-sale drawer opens need a **manager or owner PIN**, and every override is in `audit_log`.

## Pairing

1. A manager or owner opens Settings > Tills and presses **Pair** on a till. The app makes an 8-character code from a 31-symbol alphabet (no I, L, O, 0, 1), stores only its SHA-256 (`register_pairing_codes.code_hash`) and shows the code once. It expires in 10 minutes; a new code voids the till's earlier unused ones (`public.create_pairing_code`).
2. On the device, `/register/pair`: the code goes to `POST /api/v1/register/pair`. The server makes 32 random bytes, stores only their SHA-256 on `registers.device_token_hash` (`ops.pair_register`: code locked `for update`, single use, expiry checked) and sets an **httpOnly, SameSite=Strict** cookie (`__Host-tf_device` over HTTPS). Pairing again replaces the token, so the old device stops working.
3. Every till request is authenticated by `authenticateDevice()` (`src/lib/device/auth.ts`) → `ops.device_auth(token_hash)`. The shop and the till come from the token, never from a URL or payload. Unknown, revoked or closed-shop tokens are 401; a token for another shop is 404.
4. **Revoke** (`public.revoke_register`): clears the token and voids open codes. Sales already on the device stay there (outbox) and sync once the till is paired again.

Rate limits: `pair` 10 per 15 min per IP (Postgres, fails closed); `pin-device` 30 per 15 min per register.

## PINs and lockout

- Set by the person themselves (Settings > My till PIN; owners and managers for now): validated by `pinSchema` (4–6 digits, not one repeated digit, not a straight run), hashed with **Argon2id** (hash-wasm, 19 MiB, t=2, p=1) on the server, stored as `memberships.pin_hash` through `public.set_my_pin_hash`. A manager clears a cashier's PIN (`public.reset_member_pin`); only an owner clears a manager's or owner's.
- `POST /api/v1/register/unlock` (device token required): `ops.pin_attempt_begin` **reserves** an attempt before the PIN is checked (`for update`, counter +1; at 5 the person is locked for 15 minutes, audited as `staff.pin_locked`), then `pin_attempt_finish` records the result. So parallel guesses cannot exceed five. Wrong PIN, unknown person and no-PIN all answer `invalid`.
- **Offline**: the catalogue feed carries each staff member's Argon2 hash. The till checks a PIN against it (`src/lib/register/staff.ts`) with the same rule (attempt counted first, 5 failures → 15 minutes, kept in IndexedDB). A server lock is copied to the device, and server-side failures are counted there too, so going offline never buys guesses.
- The till locks on load, on the Lock button and after 5 minutes without a touch. Memory only: a reload locks it.

## Manager override

A till can never *claim* that a manager approved something. The server checks the manager's PIN (`/api/v1/register/unlock` with `purpose=override` and `approvalFor`) and, on success, issues a **single-use approval** (`register_approvals`, `ops.issue_approval`): one register, one purpose (`discount`, `no_sale`, `refund`), valid for 30 minutes of the sale's or event's own time, spent at most once. The sale or event carries only that approval's id; `ops.record_sale` and `ops.record_register_events` **derive the approver from the row** (and re-check they are still a manager or owner). The wire format has no field for naming an approver.

| Action | Rule | Where it is recorded |
| --- | --- | --- |
| Discount above `organisations.discount_override_bp` (default 1000 = 10%, owner-editable in Settings, audited before/after) of any line, or of the whole sale | Manager/owner PIN on the till before payment. The server re-checks with `discountNeedsOverride` (`src/lib/money`, exact integer maths, 2-cent rounding slack) and needs a valid approval id; without one (or with a spent/expired/forged/other-till id) the sale is rejected `discount_needs_approval` and held in Needs attention | `sales.cashier_user_id`; audit row `sale.discount_override` (`approval: pin_verified`, approver, discount) in the same transaction as the sale |
| No-sale drawer open | Manager/owner PIN | Queued as a register event, sent to `POST /api/v1/sync/events`, audit row `register.no_sale` under the event's own id (idempotent). With an approval id: `approval: pin_verified` and the verified approver. Without one (checked offline): `approval: unverified_offline`, no approver, the manager the till named only as `claimed_approver` |
| Refund | Event kind `refund_override` and API are in place; the refund flow itself is Phase 2 | `override.refund` (same rules as no-sale) |

**Offline** the PIN is checked against the cached hash, so the till cannot get a server proof: an over-limit discount rung up offline is *held* for a manager ("Try again" in the back office is the manager's own approval, from their signed-in session), and a drawer event is logged as unverified. The drawer physically opens either way.

## Known limits (accepted for 1.7, see STATUS)

- Cached PIN hashes (needed for offline unlock) go to every paired till, owners' and managers' included. Anyone who can read a till's IndexedDB can brute-force a 4–6 digit PIN offline, and the offline attempt counter lives on the device. Mitigations: a stolen till is revoked at once; an offline-derived PIN still cannot approve a discount *for the server* without an online PIN check, which keeps the real lockout. A PIN learned this way does let someone unlock the till and approve things at the till, though. Consider 6-digit PINs for managers, and wiping the shop's IndexedDB when the server answers 401.
- Revoking a till does not erase what is on it (catalogue, staff names and hashes, outbox, cached pages) until the till next hears a 401.
- The cashier on a sale is chosen by the till (it must be staff of the shop). A stolen *paired* till can ring sales as any staff member without their PIN; it cannot approve a discount.
- Anyone at a paired till can submit 5 wrong PINs for a manager and lock them for 15 minutes (audited as `staff.pin_locked`).
- A 4-digit PIN allows about 480 online guesses per person per day.
- The shop's discount limit comes from the till's cache: after the owner lowers it, an offline till may let a discount through that the server then holds.
- The 2-cent rounding slack is flat: a limit of 0 does not stop discounts of 2 cents or less, and several line percentages at exactly the limit on x.5-cent prices can total a cent or two over (a spurious manager prompt, never a bypass). Meal deals are not covered by the rule yet.

## Data

Migration `0021` (generated): `memberships.display_name/pin_set_at/pin_failed_count/pin_locked_until`, `organisations.discount_override_bp`, `register_pairing_codes`. `0022` (hand-written): column grants (PIN hash and counter never readable or writable by clients), RLS on `register_pairing_codes` (managers read, no client writes), `app.device_register` (the only token lookup), `app.is_manager`, the `public.*` back-office functions and the `ops.*` device functions, replaced `ops.record_sale` and `ops.record_sync_rejection` (a rejection naming a non-member is recorded with no actor instead of blocking the queue). All `public.*` functions check the role through the `app.*` helpers and write `audit_log`.

## Out of scope

- Cashier accounts: there is no invite flow yet, so cashiers cannot sign in to set their own PIN. Until it exists only owners and managers have PINs.
- Sales queued on a device before this step have no cashier and show up in Needs attention.
- Migration note: `0021` (generated) adds columns and `register_pairing_codes`; `0022` (generated) adds `register_approvals`; `0023` (hand-written) holds RLS, grants and every function. Drizzle's snapshot numbering is out of step with the hand-written files (see STATUS); the new snapshots are `0021_snapshot.json` and `0022_snapshot.json`.
