-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 — Accounts RLS (self-row-only SELECT, deny all browser writes)
--
-- Tightens the accounts table from "no RLS at all" to "you can read your own
-- row only and never write." This was deferred at launch because a wrong RLS
-- policy silently breaks login (AuthContext can't read the user's row), and
-- 24h of confirmed working production was the right time to apply.
--
-- VERIFIED on live production 2026-04-28 evening:
--   1. Pre-RLS: Mario's app loads normally. Cookie-backed auth session
--      retrieves the accounts row via supabase.from('accounts').select().
--   2. Apply this migration via the SQL editor.
--   3. Hard-reload the production app. AuthContext rehydrates from session,
--      reads its own accounts row through the new policy, renders the page.
--      Button-press round-trip succeeds (74 rooms / 457 ms / requestId
--      6w3eil6x).
--   4. /api/* admin endpoints use supabaseAdmin (service_role) which
--      bypasses RLS — unchanged.
--
-- Policy logic:
--   accounts_self_select  — authenticated, SELECT, own row only.
--                          The browser AuthContext queries
--                          .eq('data_user_id', authUid).maybeSingle() ;
--                          the JWT-derived auth.uid() matches data_user_id
--                          on exactly one row → that row is visible, others
--                          are not.
--   accounts_deny_writes  — anon + authenticated, FOR ALL, USING/CHECK false.
--                          Browser cannot insert/update/delete. Account
--                          mutations go through /api/auth/accounts which
--                          uses supabaseAdmin and validates inputs.
--
-- Postgres RLS combinator note: when multiple policies apply to the same
-- command, they're OR'd. SELECT on accounts therefore evaluates
-- (data_user_id = auth.uid()) OR (false) = (data_user_id = auth.uid()).
-- INSERT/UPDATE/DELETE only have the deny policy → blocked.
--
-- Rollback (if any future change unexpectedly breaks login):
--   alter table public.accounts disable row level security;
--   drop policy if exists accounts_self_select on public.accounts;
--   drop policy if exists accounts_deny_writes on public.accounts;
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.accounts enable row level security;

-- Idempotent re-runs.
drop policy if exists accounts_self_select on public.accounts;
drop policy if exists accounts_deny_writes on public.accounts;
drop policy if exists accounts_deny_browser on public.accounts;

create policy accounts_self_select on public.accounts
  for select
  to authenticated
  using (data_user_id = auth.uid());

create policy accounts_deny_writes on public.accounts
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on policy accounts_self_select on public.accounts is
  'Authenticated users may SELECT their own row by data_user_id = auth.uid(). All other rows are invisible to the browser. Service role (admin endpoints) bypasses RLS.';
comment on policy accounts_deny_writes on public.accounts is
  'Browser cannot INSERT/UPDATE/DELETE accounts. Account mutations go through /api/auth/accounts (service_role with input validation).';

insert into public.applied_migrations (version, description)
values ('0017', 'Accounts RLS (self-row-only SELECT)')
on conflict (version) do nothing;
