-- ═══════════════════════════════════════════════════════════════════════════
-- 0365 — THE COMPANY RULEBOOK
--
-- 0364 gave a person a job at a scope. This gives the COMPANY a voice.
--
-- A management company runs 5-50 hotels on rules that are the company's, not
-- any one hotel's: "all our hotels use Ecolab", "orders over $500 need VP
-- sign-off", "checkout is 11". Until now the only place a durable fact could
-- live was `agent_memory`, which is keyed by ONE hotel — so a VP had to type
-- the same sentence into twenty hotels and re-type it into hotel twenty-one.
--
-- THREE TABLES, THREE DIFFERENT JOBS:
--
--   company_knowledge        the rulebook itself — prose facts, same
--                            confirm/edit/remove life-cycle as the hotel Knows
--                            screen. Confirmed facts reach the copilot of every
--                            hotel in the company via the new `company` prompt
--                            tier.
--   company_authority_rules  the STRUCTURED reading of an approval fact. "Orders
--                            over $500 need VP sign-off" is stored as
--                            (purchase_order, 50000 cents, vp) so routing later
--                            runs on numbers, deterministically, instead of
--                            re-interpreting English on every card. The rule is
--                            written ONLY when a human confirms the fact.
--   company_access_settings  the questions asked once at setup: can GMs see the
--                            book, is cross-hotel AI chat on, who besides the
--                            owner may edit.
--
-- WHY A NEW TABLE AND NOT A COLUMN ON agent_memory
-- `agent_memory` is deny-all RLS and its ONE per-tenant guarantee is that every
-- read carries `.eq('property_id', …)`. A company fact has no property_id. Bolt
-- an organization_id onto that table and every one of those existing reads
-- gains a class of row it does not filter — the tenant wall would stop being a
-- single condition anybody can check. The key is genuinely different, so the
-- table is.
--
-- SECURITY POSTURE — identical to 0325/0364:
--   * deny-all RLS for anon/authenticated. These rows are never browser-read.
--   * service_role holds the DML; the ORGANIZATION filter in
--     src/lib/company/rulebook.ts is the tenant boundary, exactly as the
--     property filter is for agent_memory. Wall B (across companies) is that
--     every read and write below is keyed by organization_id and the app
--     resolves that id only through `companyForProperty` / the caller's own
--     hats.
--   * content that could forge a prompt boundary is rejected at the DATABASE,
--     not only in the renderer — mirroring agent_prompts_family_no_markers_ck
--     (0338). The company tier lands in the CACHED system block ABOVE the
--     hotel's own facts, so it is the highest-authority text a customer can put
--     in front of the model. It gets the strongest input constraint we have.
--
-- @rls: service-role-only — the rulebook, its frozen authority rules and the
-- company's access choices are all keyed by ORGANIZATION, not by property, and
-- are never browser-readable. Every read and write flows through Next API
-- routes using supabaseAdmin, gated on the caller's own hats
-- (src/lib/company/rulebook-access.ts). Note that the RLS-coverage audit does
-- not yet treat `organization_id` as a tenant column — see the annotation on
-- each table below.
--
-- Manual prod apply (project_migration_application_manual.md). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── The rulebook ──────────────────────────────────────────────────────────
-- @rls: service-role-only — organization-scoped authorization data; deny-all
-- for anon/authenticated, tenant filter enforced in src/lib/company/rulebook.ts.

create table if not exists public.company_knowledge (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- lower_snake_case dedupe key. Restating the same subject later must produce
  -- the same slug, so a correction replaces rather than accumulates.
  topic text not null,
  content text not null,
  category text not null default 'standards',
  source text not null default 'explicit_user',
  review_state text not null default 'confirmed',
  is_active boolean not null default true,
  -- ── the structured readings, both written only at confirm time ───────────
  -- A comparable setting this fact pins ('housekeeping_start_time') and its
  -- canonical value ('08:00'). NULL for every fact that is only prose.
  policy_key text,
  policy_value text,
  created_by_account_id uuid references public.accounts(id) on delete set null,
  created_by_name text,
  created_by_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_knowledge is
  'The company rulebook. Confirmed rows render into the `company` prompt tier for EVERY hotel the organization operates. Scoped by organization_id — that filter is the tenant boundary.';
comment on column public.company_knowledge.policy_key is
  'Set at confirm time when the fact pins a setting Staxis actually stores per hotel (see src/lib/company/rulebook-policy.ts). Drives the settings-contradiction line. NULL = prose only.';

alter table public.company_knowledge
  drop constraint if exists company_knowledge_category_ck;
alter table public.company_knowledge
  add constraint company_knowledge_category_ck
  check (category in ('standards', 'money', 'vendors', 'people', 'guests'));

alter table public.company_knowledge
  drop constraint if exists company_knowledge_source_ck;
alter table public.company_knowledge
  add constraint company_knowledge_source_ck
  check (source in ('explicit_user', 'inferred', 'correction'));

alter table public.company_knowledge
  drop constraint if exists company_knowledge_review_state_ck;
alter table public.company_knowledge
  add constraint company_knowledge_review_state_ck
  check (review_state in ('unreviewed', 'confirmed'));

alter table public.company_knowledge
  drop constraint if exists company_knowledge_len_ck;
alter table public.company_knowledge
  add constraint company_knowledge_len_ck
  check (
    char_length(topic) between 1 and 80
    and char_length(content) between 1 and 500
    and (policy_key is null or char_length(policy_key) <= 64)
    and (policy_value is null or char_length(policy_value) <= 64)
  );

-- The forgery guard. A rulebook fact is rendered inside a trust envelope that
-- the RENDERER supplies; content that could close that envelope, forge a
-- <staxis-…> marker, or open a fake `─── … ───` section would be
-- typographically indistinguishable from Staxis's own rules in the cached
-- block. The eval bank's first live run proved exactly this attack lands
-- (INV-TIER-8, on the PMS-family tier, which sits BELOW this one).
alter table public.company_knowledge
  drop constraint if exists company_knowledge_no_markers_ck;
alter table public.company_knowledge
  add constraint company_knowledge_no_markers_ck
  check (
    content !~* '<\s*/?\s*(staxis-|tool-result)'
    and position('───' in content) = 0
  );

-- A topic is unique among the LIVE facts. A removed fact keeps its row for the
-- audit trail, and a later re-statement of the same subject starts a fresh,
-- unconfirmed row rather than silently reviving a confirmed one.
create unique index if not exists company_knowledge_one_live_topic_uq
  on public.company_knowledge (organization_id, topic)
  where is_active;

create index if not exists company_knowledge_live_by_org_idx
  on public.company_knowledge (organization_id, review_state, category)
  where is_active;

-- A row extracted by the model is NEVER established truth. Enforced here rather
-- than trusted to a caller, exactly as 0358 does for agent_memory: the badge in
-- the UI is a label, THIS is the guarantee.
create or replace function public._staxis_company_knowledge_review_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'inferred' then
    new.review_state := 'unreviewed';
  end if;
  -- A fact nobody has confirmed has no structured reading. Otherwise an
  -- unapproved extraction could quietly change who has to sign off on money.
  if new.review_state <> 'confirmed' then
    new.policy_key := null;
    new.policy_value := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public._staxis_company_knowledge_review_state()
  from public, anon, authenticated;

drop trigger if exists trg_company_knowledge_review_state on public.company_knowledge;
create trigger trg_company_knowledge_review_state
  before insert or update on public.company_knowledge
  for each row execute function public._staxis_company_knowledge_review_state();

-- ─── Frozen authority rules ────────────────────────────────────────────────
--
-- "Orders over $500 need VP sign-off" as three columns. The VP queue reads
-- THIS, never the sentence — a router that re-reads prose per card is a router
-- whose answer can change while nobody edited anything.
--
-- @rls: service-role-only — organization-scoped authorization data; deny-all
-- for anon/authenticated, tenant filter enforced in src/lib/company/authority.ts.

create table if not exists public.company_authority_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_kind text not null,
  -- Cents, so no float ever decides whether something needs a signature.
  threshold_cents bigint not null,
  -- "over $500" and "$500 or more" are different rules and a $500.00 order is
  -- exactly where they disagree. Storing which one the company said is cheaper
  -- than an off-by-a-penny argument about a purchase order later.
  threshold_inclusive boolean not null default false,
  approver_role text not null,
  -- The confirmed fact this rule was frozen from. Deleting the fact deletes the
  -- rule: a rulebook line the company took out must not keep gating money.
  source_fact_id uuid not null references public.company_knowledge(id) on delete cascade,
  is_active boolean not null default true,
  created_by_account_id uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_authority_rules is
  'The structured reading of an approval fact, frozen at confirm time. Read via authorityRuleFor(orgId, actionKind, amountCents). Never re-derived from prose.';

alter table public.company_authority_rules
  drop constraint if exists company_authority_rules_action_kind_ck;
alter table public.company_authority_rules
  add constraint company_authority_rules_action_kind_ck
  check (action_kind in (
    'purchase_order', 'invoice', 'expense', 'capital_project', 'refund', 'comp', 'contract'
  ));

alter table public.company_authority_rules
  drop constraint if exists company_authority_rules_approver_ck;
alter table public.company_authority_rules
  add constraint company_authority_rules_approver_ck
  check (approver_role in ('owner', 'vp', 'finance', 'general_manager'));

alter table public.company_authority_rules
  drop constraint if exists company_authority_rules_threshold_ck;
alter table public.company_authority_rules
  add constraint company_authority_rules_threshold_ck
  check (threshold_cents >= 0 and threshold_cents <= 1000000000);

-- One live rule per confirmed fact. Two facts may legitimately describe the
-- same action kind at different thresholds ("over $500 → VP", "over $5,000 →
-- owner"), which is why the natural key is NOT unique — the reader picks the
-- highest threshold the amount clears.
create unique index if not exists company_authority_rules_one_per_fact_uq
  on public.company_authority_rules (source_fact_id)
  where is_active;

create index if not exists company_authority_rules_lookup_idx
  on public.company_authority_rules (organization_id, action_kind, threshold_cents)
  where is_active;

-- A line the company takes out must not keep gating money — and that must not
-- depend on a second app call succeeding after the first one already committed.
-- src/lib/company/rulebook.ts retires the rule too, which is what makes the
-- outcome visible to the caller; THIS is what makes it true.
create or replace function public._staxis_retire_rules_with_fact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.is_active and not new.is_active then
    update public.company_authority_rules r
       set is_active = false, updated_at = now()
     where r.source_fact_id = new.id and r.is_active;
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_retire_rules_with_fact()
  from public, anon, authenticated;

drop trigger if exists trg_company_knowledge_retire_rules on public.company_knowledge;
create trigger trg_company_knowledge_retire_rules
  after update of is_active on public.company_knowledge
  for each row execute function public._staxis_retire_rules_with_fact();

-- ─── Access choices, asked once ────────────────────────────────────────────
--
-- @rls: service-role-only — organization-scoped authorization data; deny-all
-- for anon/authenticated, read through companyAccessSetting()
-- (src/lib/company/rulebook-access.ts).

create table if not exists public.company_access_settings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  setting_key text not null,
  setting_value text not null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, setting_key)
);

comment on table public.company_access_settings is
  'Company-wide access choices. Read via companyAccessSetting(orgId, key), which returns the documented default when no row exists.';

alter table public.company_access_settings
  drop constraint if exists company_access_settings_shape_ck;
alter table public.company_access_settings
  add constraint company_access_settings_shape_ck
  check (
    -- LOCKED ON, in the database. The founder's ruling: a GM should be able to
    -- read the policies they are governed by. The row exists so later code can
    -- ask the question through one interface; the CHECK is why the answer
    -- cannot quietly become "no".
    (setting_key = 'gms_see_rulebook' and setting_value = 'true')
    or (setting_key = 'cross_hotel_ai_chat' and setting_value in ('true', 'false'))
    or (setting_key = 'rulebook_editors'
        and setting_value in ('owner_only', 'owner_and_vp', 'company_scope'))
    or (setting_key = 'setup_completed_at' and setting_value ~ '^\d{4}-\d{2}-\d{2}T')
  );

-- ─── The one writer ────────────────────────────────────────────────────────
--
-- Upsert-by-topic under the same per-organization advisory lock 0325/0364 use,
-- with a cap so one pasted document cannot become a thousand-line rulebook that
-- is re-sent, cached, in every conversation of every hotel in the company.

create or replace function public.staxis_store_company_fact(
  p_organization_id uuid,
  p_topic text,
  p_content text,
  p_category text default 'standards',
  p_source text default 'explicit_user',
  p_created_by_account_id uuid default null,
  p_created_by_name text default null,
  p_created_by_role text default null,
  p_cap int default 150
)
returns table (fact_id uuid, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.company_knowledge%rowtype;
  v_live int;
  v_id uuid;
begin
  if p_organization_id is null or coalesce(btrim(p_topic), '') = ''
     or coalesce(btrim(p_content), '') = '' then
    raise exception 'a company fact needs an organization, a topic and content'
      using errcode = '22023';
  end if;

  perform public._staxis_lock_organization(p_organization_id);

  select * into v_existing
  from public.company_knowledge k
  where k.organization_id = p_organization_id
    and k.topic = p_topic
    and k.is_active
  for update;

  if found then
    -- A CONFIRMED fact outranks a fresh extraction of the same subject. The
    -- company already decided what this line says; a re-uploaded PDF does not
    -- get to quietly reword it. (Same deference 0260/0261 gives human facts.)
    if v_existing.review_state = 'confirmed' and p_source = 'inferred' then
      return query select v_existing.id, 'skipped'::text;
      return;
    end if;

    update public.company_knowledge k
       set content = p_content,
           category = p_category,
           source = p_source,
           review_state = case when p_source = 'inferred' then 'unreviewed' else k.review_state end,
           created_by_account_id = coalesce(p_created_by_account_id, k.created_by_account_id),
           created_by_name = coalesce(p_created_by_name, k.created_by_name),
           created_by_role = coalesce(p_created_by_role, k.created_by_role)
     where k.id = v_existing.id;
    return query select v_existing.id, 'updated'::text;
    return;
  end if;

  select count(*) into v_live
  from public.company_knowledge k
  where k.organization_id = p_organization_id and k.is_active;
  if v_live >= p_cap then
    return query select null::uuid, 'company_full'::text;
    return;
  end if;

  insert into public.company_knowledge (
    organization_id, topic, content, category, source,
    created_by_account_id, created_by_name, created_by_role
  ) values (
    p_organization_id, p_topic, p_content, p_category, p_source,
    p_created_by_account_id, p_created_by_name, p_created_by_role
  ) returning id into v_id;

  return query select v_id, 'inserted'::text;
end;
$$;

revoke all on function public.staxis_store_company_fact(uuid, text, text, text, text, uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.staxis_store_company_fact(uuid, text, text, text, text, uuid, text, text, int)
  to service_role;

-- ─── Permissions / RLS ─────────────────────────────────────────────────────

alter table public.company_knowledge enable row level security;
revoke all on public.company_knowledge from public, anon, authenticated;
grant select, insert, update, delete on public.company_knowledge to service_role;
drop policy if exists company_knowledge_deny_browser on public.company_knowledge;
create policy company_knowledge_deny_browser on public.company_knowledge
  for all to anon, authenticated using (false) with check (false);

alter table public.company_authority_rules enable row level security;
revoke all on public.company_authority_rules from public, anon, authenticated;
grant select, insert, update, delete on public.company_authority_rules to service_role;
drop policy if exists company_authority_rules_deny_browser on public.company_authority_rules;
create policy company_authority_rules_deny_browser on public.company_authority_rules
  for all to anon, authenticated using (false) with check (false);

alter table public.company_access_settings enable row level security;
revoke all on public.company_access_settings from public, anon, authenticated;
grant select, insert, update, delete on public.company_access_settings to service_role;
drop policy if exists company_access_settings_deny_browser on public.company_access_settings;
create policy company_access_settings_deny_browser on public.company_access_settings
  for all to anon, authenticated using (false) with check (false);

insert into public.applied_migrations (version, description)
values ('0365', 'the company rulebook: shared facts, frozen authority rules, access choices')
on conflict (version) do nothing;
