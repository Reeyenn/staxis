-- Phase 2B / Door B fix (audit 2026-05-22) — session-scoped MFA-verified state.
--
-- Replaces the user-bound design the senior pass killed. User-bound was
-- theater: if Maria had any trusted device anywhere, every login token she
-- (or an attacker with her stolen password) received was flagged
-- mfa_verified=true. The attacker could PostgREST direct with that token
-- and read everything Maria could.
--
-- Session-bound design: one row per Supabase auth.sessions row that has
-- completed the /api/auth/trust-device step. The custom_access_token_hook
-- (migration 0160) reads the event payload's session_id (from
-- event -> 'claims' ->> 'session_id') and checks for a matching row to
-- compute mfa_verified=true. An attacker creating a NEW session via
-- stolen-password curl gets a fresh session_id with no row → false.
--
-- Lifecycle:
--   - INSERT: /api/auth/trust-device extracts session_id from the bearer
--     JWT and inserts a row after the trusted_devices insert succeeds.
--   - DELETE: /api/auth/revoke-trust deletes ALL of the user's rows
--     (sign-out kills every session_id's trust).
--   - FK CASCADE: auth.sessions deletion cascades; janitor cron sweeps
--     any drift.

create table if not exists public.mfa_verified_sessions (
  -- Supabase auth.sessions.id (each sign-in/refresh-token-issue creates one).
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz not null default now(),
  -- Diagnostic only; not used for security decisions.
  verified_from_ip text,
  verified_from_ua text
);

create index if not exists mfa_verified_sessions_user_idx
  on public.mfa_verified_sessions (user_id);

-- Service-role + supabase_auth_admin only. Never readable by anon or
-- authenticated roles.
alter table public.mfa_verified_sessions enable row level security;

revoke all on public.mfa_verified_sessions from anon, authenticated, public;
grant select, insert, delete on public.mfa_verified_sessions to supabase_auth_admin;

create policy mfa_verified_sessions_auth_admin_all on public.mfa_verified_sessions
  as permissive for all to supabase_auth_admin
  using (true) with check (true);

comment on table public.mfa_verified_sessions is
  'Phase 2B / Door B fix (audit 2026-05-22, senior-pass redesign). One row '
  'per Supabase auth session that has completed trust-device. The '
  'custom_access_token_hook reads event -> claims ->> session_id and checks '
  'for a matching row to compute mfa_verified=true. Bound to session_id '
  '(not user_id) so an attacker creating a fresh session via stolen '
  'password cannot inherit trust from the user''s other devices.';

-- ── Helper: public.mfa_verified_or_grace() ────────────────────────────
--
-- Used by every gated RLS policy. Returns true if the JWT carries
-- mfa_verified=true, OR if the claim is missing (grace default for legacy
-- JWTs during the 24h soak window). Migration 0162 will CREATE OR REPLACE
-- this function to return coalesce(..., false), tightening the grace
-- default without re-ALTERing all ~50 policies.
--
-- LANGUAGE sql + STABLE so Postgres can inline it into RLS USING/CHECK
-- clauses (verify via EXPLAIN ANALYZE post-deploy; fall back to inlined
-- expressions if inlining doesn't happen).

create or replace function public.mfa_verified_or_grace()
returns boolean
language sql
stable
security invoker
as $$
  select coalesce((auth.jwt() ->> 'mfa_verified')::boolean, true);
$$;

grant execute on function public.mfa_verified_or_grace() to authenticated, anon, public;

comment on function public.mfa_verified_or_grace() is
  'Phase 2B helper. Returns mfa_verified claim from the JWT, or TRUE if '
  'missing (grace window). Migration 0162 flips the default to FALSE after '
  'a 24h soak.';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0159',
  'Audit 2026-05-22 Phase 2B: mfa_verified_sessions table (session-bound design) + mfa_verified_or_grace() helper.'
)
on conflict (version) do nothing;
