-- 0328: make hotel account invites and join codes service-role-only.
--
-- These tables contain authentication capability material and onboarding
-- metadata. Migration 0067 intentionally let authenticated hotel owners query
-- and mutate them directly through PostgREST. The application no longer needs
-- that browser path: every manager action and every public acceptance flow is
-- mediated by a server route using supabaseAdmin, with its own authorization,
-- rate-limit, audit, and atomicity checks.
--
-- Leaving the old owner-scoped policies in place creates a second, weaker API:
-- anyone with a signed-in browser session can bypass the route-level role and
-- lifecycle checks by talking to PostgREST directly. Close that path at both
-- PostgreSQL layers:
--   1. remove every policy that targets public/anon/authenticated, including
--      policies added out-of-band under a different name;
--   2. revoke all object privileges from browser roles;
--   3. retain explicit deny policies as durable documentation;
--   4. explicitly grant the DML used by the server routes to service_role.
--
-- Service-role bypasses RLS, so /api/auth/invites, /api/auth/join-codes,
-- /api/auth/accept-invite, /api/auth/use-join-code, and the server-side
-- onboarding routes continue to work. No raw invite token is stored: the
-- account_invites table contains only the SHA-256 token hash.
--
-- Idempotent and safe to re-run.

alter table public.account_invites enable row level security;
alter table public.hotel_join_codes enable row level security;

-- Drop the two known historical policies explicitly so migration-tree audit
-- tooling can derive the final state without needing to interpret PL/pgSQL.
drop policy if exists account_invites_manage_for_own_hotels
  on public.account_invites;
drop policy if exists hotel_join_codes_manage_for_own_hotels
  on public.hotel_join_codes;

-- Also remove any browser policy created manually or by an unmerged migration.
-- Policies exclusive to service_role are left alone.
do $migration$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename in ('account_invites', 'hotel_join_codes')
       and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end
$migration$;

revoke all privileges on table public.account_invites
  from public, anon, authenticated;
revoke all privileges on table public.hotel_join_codes
  from public, anon, authenticated;

grant select, insert, update, delete on table public.account_invites
  to service_role;
grant select, insert, update, delete on table public.hotel_join_codes
  to service_role;

drop policy if exists account_invites_deny_browser
  on public.account_invites;
create policy account_invites_deny_browser
  on public.account_invites
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists hotel_join_codes_deny_browser
  on public.hotel_join_codes;
create policy hotel_join_codes_deny_browser
  on public.hotel_join_codes
  for all to anon, authenticated
  using (false)
  with check (false);

comment on policy account_invites_deny_browser on public.account_invites is
  'Service-role only. Invite reads/writes and public acceptance are mediated by authenticated, rate-limited server routes using supabaseAdmin.';
comment on policy hotel_join_codes_deny_browser on public.hotel_join_codes is
  'Service-role only. Code reads/writes and public redemption are mediated by authenticated or capability-checked server routes using supabaseAdmin.';

comment on table public.account_invites is
  'Hotel account invitation metadata and SHA-256 token hashes. Service-role only; all access is through /api/auth/invites or /api/auth/accept-invite.';
comment on table public.hotel_join_codes is
  'Hotel onboarding join-code capabilities. Service-role only; all access is through authenticated/capability-checked server routes.';

insert into public.applied_migrations (version, description)
values (
  '0328',
  'lock account_invites and hotel_join_codes to service-role-only; remove direct anon/authenticated PostgREST access'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
