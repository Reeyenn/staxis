-- Single-use, short-TTL proof that a user just completed a successful
-- password sign-in. Phase 2A of the 2026-05-22 auth audit (Hole #1:
-- passwordless OTP could mint a trusted device).
--
-- Trust-device refuses to issue a staxis_device cookie unless one of
-- these rows exists for the user, unused and unexpired. Without the
-- row, an attacker who can read the user's email OTP can no longer
-- establish a persistent trusted device.
--
-- Rows are written from inside the custom_access_token_hook function
-- (migration 0158) when Supabase Auth tags the JWT issuance with
-- authentication_method='password'. The hook is invoked by Supabase
-- itself — an attacker calling signInWithOtp directly cannot fake the
-- method, so no proof row gets written for OTP-only sign-ins.
--
-- One additional write path: /api/auth/use-join-code inserts a row
-- explicitly after successful signup, because admin.createUser does
-- not fire the hook (it issues no client JWT) and the very next client
-- step is signInWithOtp.

create table if not exists public.password_signin_proofs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  -- Optional context for incident review.
  user_agent text,
  ip text
);

create index if not exists password_signin_proofs_user_unused_idx
  on public.password_signin_proofs (user_id, expires_at)
  where used_at is null;

-- Sweep: a janitorial index so we can periodically purge old rows.
create index if not exists password_signin_proofs_expires_at_idx
  on public.password_signin_proofs (expires_at);

-- Service-role + supabase_auth_admin only — never readable or writable
-- from browser, anon, or authenticated roles. supabase_auth_admin is
-- granted INSERT separately so the auth hook (which runs as that role)
-- can write rows.
alter table public.password_signin_proofs enable row level security;

revoke all on public.password_signin_proofs from anon, authenticated, public;
grant insert on public.password_signin_proofs to supabase_auth_admin;
grant select on public.password_signin_proofs to supabase_auth_admin;
-- No policy needed for supabase_auth_admin — RLS only blocks roles with
-- explicit policies. service_role bypasses RLS entirely (admin client),
-- and supabase_auth_admin gets through via the table grants above plus
-- a permissive policy below:
create policy password_signin_proofs_auth_admin_all on public.password_signin_proofs
  as permissive
  for all
  to supabase_auth_admin
  using (true)
  with check (true);

comment on table public.password_signin_proofs is
  'Audit 2026-05-22 Hole #1 fix. One row per successful password sign-in; '
  'trust-device requires one unused+unexpired row to issue staxis_device. '
  'Closes the email-OTP-without-password attack: an attacker who can read '
  'a staff inbox can complete OTP and get a JWT, but cannot establish a '
  'persistent trusted device because they never produced a password proof. '
  'Rows are written by the custom_access_token_hook (migration 0158) when '
  'authentication_method=''password'', plus a server-side write in '
  '/api/auth/use-join-code for the initial signup flow.';

notify pgrst, 'reload schema';

-- Self-register for the doctor's supabase_migrations_applied check.
insert into public.applied_migrations (version, description)
values (
  '0157',
  'Audit 2026-05-22 Hole #1: password_signin_proofs single-use table gates trust-device.'
)
on conflict (version) do nothing;
