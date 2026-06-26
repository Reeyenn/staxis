-- 0290 — 2026-06-26 pre-onboarding audit: voice-cost ingest columns + per-property
-- RLS policies for the 16 tenant tables that had RLS enabled but ZERO policies.
--
-- Part A — agent_voice_sessions: 3 additive columns so /api/cron/ingest-voice-costs
--   can settle each ended ElevenLabs Conversational AI session's platform minutes
--   into the agent_costs ledger (the daily $ cap was missing voice entirely).
--   Table is service-role-only (allowlisted); the cron reads via supabaseAdmin.
--
-- Part B — RLS coverage: 16 public tenant tables (comms_*, financial/CapEx/budget,
--   labor_wage_settings, schedule_*) shipped with `enable row level security` but no
--   policy. RLS-on + no-policy = deny-all, which is SAFE, but the runtime doctor's
--   checkSupabaseRlsPolicyCoverage flags them (they're not on its allowlist) and 503s
--   the deploy smoke gate. We add tenant-scoped SELECT policies — restoring the
--   cross-tenant safety net and flipping the doctor green — WITHOUT opening writes
--   (every write still goes through /api with supabaseAdmin, which bypasses RLS).
--   Scoping:
--     * comms_*               → user_owns_property(property_id)   (staff-wide read)
--     * financial/CapEx/budget/wage → user_manages_property(property_id) (manager-only;
--       these tables ALSO already `revoke all ... from anon, authenticated`, so the
--       policy is doctor-coverage only — the REVOKE stays the real deny-all guard.
--       We deliberately do NOT re-grant.)
--     * schedule_*            → user_manages_property(property_id)  (manager-only feature)
--   anon stays denied everywhere (user_owns_property/user_manages_property return
--   false when auth.uid() is null → public pages keep their deny-all posture).

-- ─── Part A: voice-cost ingest columns ───────────────────────────────────────
alter table public.agent_voice_sessions
  add column if not exists elevenlabs_cost_ingested_at   timestamptz,
  add column if not exists elevenlabs_call_duration_secs integer,
  add column if not exists elevenlabs_cost_usd           numeric(10, 6);

-- Partial index for the cron's claim query (unbilled, bound sessions).
create index if not exists agent_voice_sessions_cost_ingest_idx
  on public.agent_voice_sessions (last_turn_at)
  where elevenlabs_conversation_id is not null
    and elevenlabs_cost_ingested_at is null;

-- ─── Part B: tenant-scoped SELECT policies ───────────────────────────────────
-- Every policy AND-s public.mfa_verified_or_grace() (migration 0159) so a
-- signed-in-but-not-MFA-verified session reads zero rows — the codebase-wide
-- posture the audit-mfa-gate-policies lint enforces. Fail loudly if that
-- function isn't present (it must be, on any DB past 0159).
do $$
begin
  if to_regprocedure('public.mfa_verified_or_grace()') is null then
    raise exception 'apply migration 0159 first — mfa_verified_or_grace() missing';
  end if;
end $$;

-- ─── manager-scoped tenant helper (mirrors 0003 hardening) ────────────────────
-- Manager-tier variant of user_owns_property: true iff the caller is a Staxis
-- admin OR has p_id in property_access AND a manager-tier role (owner /
-- general_manager) — the same trio canViewFinancials() gates on. SECURITY
-- DEFINER + pinned search_path so it can read accounts without recursing into
-- accounts' own RLS and isn't search-path-injectable (Supabase lint + the
-- audit-security-definer-search-path script require this).
create or replace function user_manages_property(p_id uuid) returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.accounts a
    where a.data_user_id = auth.uid()
      and (
        a.role = 'admin'
        or (p_id = any (a.property_access) and a.role in ('owner', 'general_manager'))
      )
  );
$$;

revoke all on function user_manages_property(uuid) from public;
grant execute on function user_manages_property(uuid) to anon, authenticated, service_role;

-- ─── Part B.1: comms_* — staff-wide property-scoped SELECT ────────────────────
-- Restores cross-tenant isolation + makes future realtime possible. Reads/writes
-- today all go through /api/comms/* with supabaseAdmin (service-role bypasses
-- RLS), so this changes no current behavior; it only scopes any direct
-- authenticated client read to the caller's own property. No write policy.
drop policy if exists comms_acknowledgements_select_tenant on public.comms_acknowledgements;
create policy comms_acknowledgements_select_tenant on public.comms_acknowledgements
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_conversations_select_tenant on public.comms_conversations;
create policy comms_conversations_select_tenant on public.comms_conversations
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_log_entries_select_tenant on public.comms_log_entries;
create policy comms_log_entries_select_tenant on public.comms_log_entries
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_log_replies_select_tenant on public.comms_log_replies;
create policy comms_log_replies_select_tenant on public.comms_log_replies
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_members_select_tenant on public.comms_members;
create policy comms_members_select_tenant on public.comms_members
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_messages_select_tenant on public.comms_messages;
create policy comms_messages_select_tenant on public.comms_messages
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_presence_select_tenant on public.comms_presence;
create policy comms_presence_select_tenant on public.comms_presence
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_reactions_select_tenant on public.comms_reactions;
create policy comms_reactions_select_tenant on public.comms_reactions
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists comms_tasks_select_tenant on public.comms_tasks;
create policy comms_tasks_select_tenant on public.comms_tasks
  for select to authenticated using (user_owns_property(property_id) and public.mfa_verified_or_grace());

-- ─── Part B.2: financial / CapEx / budget / wage — manager-only SELECT ────────
-- These tables already `revoke all ... from anon, authenticated`, so the policy
-- is doctor-coverage only (the REVOKE remains the real deny-all guard). Kept
-- manager-scoped so it stays correct if a grant is ever added. No write policy.
drop policy if exists financial_expenses_select_mgr on public.financial_expenses;
create policy financial_expenses_select_mgr on public.financial_expenses
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists labor_wage_settings_select_mgr on public.labor_wage_settings;
create policy labor_wage_settings_select_mgr on public.labor_wage_settings
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists capex_projects_select_mgr on public.capex_projects;
create policy capex_projects_select_mgr on public.capex_projects
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists capex_line_items_select_mgr on public.capex_line_items;
create policy capex_line_items_select_mgr on public.capex_line_items
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists department_budgets_select_mgr on public.department_budgets;
create policy department_budgets_select_mgr on public.department_budgets
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

-- ─── Part B.3: schedule_* — manager-only feature, manager-scoped SELECT ───────
drop policy if exists schedule_templates_select_mgr on public.schedule_templates;
create policy schedule_templates_select_mgr on public.schedule_templates
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists schedule_week_signoffs_select_mgr on public.schedule_week_signoffs;
create policy schedule_week_signoffs_select_mgr on public.schedule_week_signoffs
  for select to authenticated using (user_manages_property(property_id) and public.mfa_verified_or_grace());

-- PostgREST caches the schema — reload so the new columns/policies are visible.
notify pgrst, 'reload schema';

-- ─── Track the migration ─────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0290',
  'audit 2026-06-26: agent_voice_sessions voice-cost ingest columns + user_manages_property() helper + tenant-scoped SELECT RLS policies for 16 flagged comms_*/financial/CapEx/budget/wage/schedule tables (no write policies; financial REVOKE preserved).'
)
on conflict (version) do nothing;
