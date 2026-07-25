-- ═══════════════════════════════════════════════════════════════════════════
-- 0353 — The knowledge promotion queue (Staxis-side, founder-only)
--
-- WHY THIS TABLE EXISTS
-- Staxis AI holds knowledge in three tiers:
--     GLOBAL          true of every hotel        (agent_prompts, role<>'family')
--     PMS/BRAND FAMILY true of every hotel on that PMS (agent_prompts 0338)
--     THIS HOTEL       walled off, never leaves  (agent_memory 0256, knowledge_*)
-- Hotel-specific always wins on conflict.
--
-- Anything that moves UP a tier — a lesson learned at one hotel becoming
-- knowledge shared with hotels that never generated it — crosses a PRIVACY
-- boundary. That decision is the founder's alone. Hotels must never see this
-- queue and must never learn that their data contributed to shared knowledge.
-- That is why this table is service-role-only and read exclusively through
-- /api/admin/mission/promotions behind requireAdmin.
--
-- THIS IS NOT THE HOTEL-FACING APPROVAL QUEUE. agent_pending_actions is where
-- a GM approves an AI *action* ("order towels", "flip room 214"). Different
-- audience, different consequences. The two must never be merged.
--
-- THE SAFEGUARDS THIS TABLE ENCODES
--   1. Nothing auto-promotes. A row lands as 'pending'; a human decides.
--   2. Every item shows its evidence: the claim, the tier it wants to enter,
--      how many hotels and observations back it, over what window, where it
--      came from.
--   3. The higher the tier, the higher the bar. family ≥ 2 supporting hotels;
--      global ≥ 3 AND validated on a hotel that produced none of the evidence.
--      Enforced by CHECK, not by convention.
--   4. Promoted knowledge EXPIRES (75 days, the agent_memory consolidation TTL)
--      unless re-confirmed.
--   5. Reversible with a visible blast radius: applied_property_ids freezes
--      which hotels the promotion reached while it was live, and
--      previous_target_row_id remembers what to put back on retract.
--   6. A REJECT IS PERMANENT. staxis_propose_promotion refuses to re-open a
--      rejected topic — the same refusal agent_memory's consolidator makes for
--      a manager-deleted topic. Retracting is NOT rejecting: a retracted topic
--      may be proposed again.
--   7. Aggregate / cross-hotel claims need a minimum group size of 5 SUPPORTING
--      hotels (excluding whichever hotel asked) or the system refuses to
--      propose them at all rather than answering weakly. With one hotel in the
--      fleet no aggregate item can ever be proposed — which is the point.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY, mirroring agent_memory (0256) and the
-- pms_* tables: anon + authenticated deny-all, service_role full. There is no
-- property_id on this table on purpose — it is Staxis-side fleet data, not
-- tenant data, so there is no tenant column to scope by and no hotel-visible
-- read path to build.
--
-- NOT APPLIED by the agent — migrations are applied by hand (CLAUDE.md).
-- Apply order: this migration → `notify pgrst, 'reload schema'` → deploy code.
-- The reading code tolerates this table being absent (the admin header and the
-- Mission Control panel degrade to "unavailable" rather than 500ing), so the
-- deploy is safe in either order.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. knowledge_promotions ────────────────────────────────────────────────
-- @rls: service-role-only — Staxis-side founder queue, read/written only via
-- /api/admin/mission/promotions behind requireAdmin. No anon/authenticated
-- path, and deliberately no hotel-visible path at all.
create table if not exists public.knowledge_promotions (
  id                      uuid primary key default gen_random_uuid(),

  -- ── WHAT IS CLAIMED ──────────────────────────────────────────────────────
  -- `topic` is the stable identity of the claim and the key the permanent
  -- rejection tombstone is keyed on. Same role as agent_memory.topic.
  topic                   text not null check (char_length(topic) between 1 and 120),
  claim                   text not null check (char_length(claim) between 1 and 500),
  evidence_summary        text check (evidence_summary is null or char_length(evidence_summary) <= 1000),
  -- The exact text that would go live if approved.
  proposed_content        text not null check (char_length(proposed_content) between 1 and 8000),
  -- What actually went live. Differs from proposed_content on edit-then-approve.
  final_content           text check (final_content is null or char_length(final_content) between 1 and 8000),

  -- ── WHICH TIER IT WANTS TO ENTER ─────────────────────────────────────────
  -- source_tier NULL = authored from scratch (no hotel's data was lifted).
  -- When it is set it must be strictly BELOW target_tier: this table only ever
  -- describes knowledge moving UP.
  source_tier             text check (source_tier in ('hotel','family')),
  target_tier             text not null check (target_tier in ('family','global')),
  pms_family              text,

  -- ── WHERE IT CAME FROM ───────────────────────────────────────────────────
  origin                  text not null check (origin in ('learned','authored')),
  source_kind             text not null
                            check (source_kind in ('agent_memory','consolidation','eval','extraction','migration','human')),
  source_ref              text,
  -- Which hotels contributed the evidence. Never leaves this table — it exists
  -- so the founder can audit the privacy cost of a promotion before making it.
  source_property_ids     uuid[] not null default '{}',

  -- ── EVIDENCE ─────────────────────────────────────────────────────────────
  -- supporting_hotel_count counts DISTINCT hotels backing the claim, EXCLUDING
  -- whichever hotel triggered the question. That exclusion is what makes the
  -- aggregate minimum-group-size rule meaningful.
  supporting_hotel_count  integer not null default 0 check (supporting_hotel_count >= 0),
  observation_count       integer not null default 0 check (observation_count >= 0),
  evidence_window_start   timestamptz,
  evidence_window_end     timestamptz,
  -- Global tier only: was this confirmed true at a hotel that contributed none
  -- of the evidence above? "Must be true at a hotel nobody has seen."
  holdout_validated       boolean not null default false,
  -- An aggregate / cross-hotel claim ("hotels like yours run 3 housekeepers").
  is_aggregate            boolean not null default false,

  -- ── MACHINE-CHECKABLE GATES ──────────────────────────────────────────────
  -- Closed vocabulary so a typo cannot invent a gate nothing evaluates, which
  -- would read as "approved" while silently never being checked.
  preconditions           text[] not null default '{}',

  -- ── WHAT IT TOUCHES ON APPROVE ───────────────────────────────────────────
  target_table            text check (target_table in ('agent_prompts')),
  target_row_id           uuid,
  -- The row that was active in this tier before the promotion went live, so a
  -- retract puts the previous behaviour BACK instead of leaving the tier empty.
  previous_target_row_id  uuid,

  -- ── LIFECYCLE ────────────────────────────────────────────────────────────
  -- pending → approved → (re-confirmed …) → retracted
  -- pending → rejected  (PERMANENT — never proposed again)
  status                  text not null default 'pending'
                            check (status in ('pending','approved','rejected','retracted')),
  decided_at              timestamptz,
  decided_by_account_id   uuid,
  decision_note           text,

  approved_at             timestamptz,
  expires_at              timestamptz,
  reconfirmed_at          timestamptz,
  reconfirm_count         integer not null default 0 check (reconfirm_count >= 0),

  retracted_at            timestamptz,
  -- Blast radius, frozen at approve and widened at retract: which hotels this
  -- promotion actually reached while it was live. Kept as ids (not a join) so
  -- the record survives a hotel being deleted.
  applied_property_ids    uuid[] not null default '{}',

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- Knowledge only ever moves UP a tier here.
  constraint knowledge_promotions_tier_up_ck check (
    source_tier is null
    or (source_tier = 'hotel'  and target_tier in ('family','global'))
    or (source_tier = 'family' and target_tier = 'global')
  ),

  -- A learned item MUST name the tier it was lifted from. Without this an
  -- automatic proposer could launder hotel data as "authored".
  constraint knowledge_promotions_learned_has_source_ck check (
    origin <> 'learned' or source_tier is not null
  ),

  -- Family key coherence + closed enum — same shape agent_prompts uses (0338).
  constraint knowledge_promotions_family_ck check ((target_tier = 'family') = (pms_family is not null)),
  constraint knowledge_promotions_family_enum_ck check (
    pms_family is null
    or pms_family in ('choice_advantage','opera_cloud','cloudbeds','roomkey',
                      'skytouch','webrezpro','hotelogix','other')
  ),

  -- THE BAR. Higher tier, higher bar. Authored items are exempt from the
  -- hotel-count bar (a human deliberately wrote them; there is no borrowed
  -- hotel data to justify) but NOT from the aggregate rule below.
  constraint knowledge_promotions_bar_ck check (
    origin = 'authored'
    or (
      supporting_hotel_count >= (case when target_tier = 'global' then 3 else 2 end)
      and (target_tier <> 'global' or holdout_validated)
    )
  ),

  -- Minimum group size for aggregate/cross-hotel claims, regardless of origin.
  constraint knowledge_promotions_aggregate_group_ck check (
    not is_aggregate or supporting_hotel_count >= 5
  ),

  -- Closed precondition vocabulary.
  constraint knowledge_promotions_preconditions_ck check (
    preconditions <@ array['family_row_exists']::text[]
  ),

  constraint knowledge_promotions_target_ref_ck check ((target_table is null) = (target_row_id is null)),

  -- Only a pending row lacks a decision stamp.
  constraint knowledge_promotions_decided_ck check ((status = 'pending') = (decided_at is null)),

  -- A live promotion always has the text that went live and an expiry date.
  constraint knowledge_promotions_approved_ck check (
    status <> 'approved'
    or (final_content is not null and approved_at is not null and expires_at is not null)
  ),

  constraint knowledge_promotions_retracted_ck check (
    (status = 'retracted') = (retracted_at is not null)
  ),

  constraint knowledge_promotions_window_ck check (
    evidence_window_start is null or evidence_window_end is null
    or evidence_window_end >= evidence_window_start
  )
);

comment on table public.knowledge_promotions is
  'Founder-only queue for knowledge moving UP a tier (hotel → PMS family → global) and for authored global behaviour changes. Service-role-only; read/written solely by /api/admin/mission/promotions behind requireAdmin. NOT the hotel-facing agent_pending_actions queue — different audience, different consequences, never merge them. Added 0353.';

comment on column public.knowledge_promotions.topic is
  'Stable slug identifying the claim. The key the permanent rejection tombstone is enforced on — once a topic is rejected, staxis_propose_promotion refuses to open it again.';
comment on column public.knowledge_promotions.supporting_hotel_count is
  'DISTINCT hotels backing the claim, EXCLUDING whichever hotel asked. The exclusion is what makes the aggregate minimum-group-size rule (5) meaningful.';
comment on column public.knowledge_promotions.applied_property_ids is
  'Blast radius: the hotels this promotion reached while it was live. Frozen at approve, widened at retract. Ids not a join, so the record survives a hotel being deleted.';
comment on column public.knowledge_promotions.previous_target_row_id is
  'What was active in this tier before the promotion. Retract restores it — without this, retracting a base-prompt promotion would leave the tier with zero active rows.';

-- One OPEN or LIVE item per (target tier, family, topic). A rejected or
-- retracted row does not block — rejection is enforced by the RPC (permanent),
-- retraction deliberately allows a fresh proposal later.
-- COALESCE sentinel because NULL is not comparable in a unique index — the
-- pattern agent_memory_active_topic_key (0256) already uses.
create unique index if not exists knowledge_promotions_open_topic_uq
  on public.knowledge_promotions (target_tier, coalesce(pms_family, ''), topic)
  where status in ('pending','approved');

-- The queue read: pending first, newest first.
create index if not exists knowledge_promotions_status_created_idx
  on public.knowledge_promotions (status, created_at desc);

-- Expiry sweep / "needs re-confirming" read.
create index if not exists knowledge_promotions_expiry_idx
  on public.knowledge_promotions (expires_at)
  where status = 'approved';

-- Tombstone lookup by the propose RPC.
create index if not exists knowledge_promotions_topic_idx
  on public.knowledge_promotions (topic);

-- ── 2. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.knowledge_promotions enable row level security;
revoke all on public.knowledge_promotions from public, anon, authenticated;
grant select, insert, update, delete on public.knowledge_promotions to service_role;
drop policy if exists knowledge_promotions_deny_all on public.knowledge_promotions;
create policy knowledge_promotions_deny_all on public.knowledge_promotions
  for all to anon, authenticated using (false) with check (false);

-- ── 3. updated_at trigger (shared fn from 0202/0211) ───────────────────────
drop trigger if exists set_updated_at on public.knowledge_promotions;
create trigger set_updated_at before update on public.knowledge_promotions
  for each row execute function public._pms_set_updated_at();

-- ── 4. RPC: staxis_propose_promotion ───────────────────────────────────────
-- THE automatic entry point. Behaviour changes and learned knowledge flow into
-- the queue through this function — nothing waits on a human flipping a switch
-- to get IN; a human only decides what gets OUT.
--
-- Returns (promotion_id, action) instead of raising, so an automatic proposer
-- running in a cron never crashes on a duplicate or a refusal. Mirrors
-- staxis_store_memory's (memory_id, action) contract from 0256.
--
--   inserted           a new pending item is in the queue
--   already_pending    an identical item is already waiting for a decision
--   already_promoted   this claim is already live at this tier
--   refused_rejected   PERMANENT — the founder rejected this topic before
--   below_bar          the evidence does not clear the bar for this tier
--
-- Serialized on the topic key by an advisory lock so two proposers racing can
-- never both insert, and can never straddle a rejection landing.
create or replace function public.staxis_propose_promotion(
  p_topic                  text,
  p_claim                  text,
  p_proposed_content       text,
  p_target_tier            text,
  p_origin                 text,
  p_source_kind            text,
  p_pms_family             text default null,
  p_source_tier            text default null,
  p_evidence_summary       text default null,
  p_source_ref             text default null,
  p_source_property_ids    uuid[] default '{}',
  p_supporting_hotel_count integer default 0,
  p_observation_count      integer default 0,
  p_evidence_window_start  timestamptz default null,
  p_evidence_window_end    timestamptz default null,
  p_holdout_validated      boolean default false,
  p_is_aggregate           boolean default false,
  p_preconditions          text[] default '{}',
  p_target_table           text default null,
  p_target_row_id          uuid default null
)
returns table(promotion_id uuid, action text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_family   text := coalesce(p_pms_family, '');
  v_id       uuid;
  v_status   text;
begin
  -- Serialize every proposal for this exact (tier, family, topic).
  v_lock_key := ('x' || substr(md5('knowledge_promotions:' || p_target_tier || ':' || v_family || ':' || p_topic), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- 1) PERMANENT REJECTION. Checked across every tier/family for this topic:
  --    if the founder said no to this claim, no proposer gets to re-ask it by
  --    aiming at a different tier. Same refusal the memory consolidator makes
  --    for a manager-deleted topic.
  select id into v_id
    from public.knowledge_promotions
   where topic = p_topic and status = 'rejected'
   limit 1;
  if found then
    return query select v_id, 'refused_rejected'::text;
    return;
  end if;

  -- 2) Already open or live at this tier?
  select id, status into v_id, v_status
    from public.knowledge_promotions
   where topic = p_topic
     and target_tier = p_target_tier
     and coalesce(pms_family, '') = v_family
     and status in ('pending','approved')
   limit 1;
  if found then
    return query select v_id, (case when v_status = 'approved' then 'already_promoted' else 'already_pending' end)::text;
    return;
  end if;

  -- 3) The bar. Mirrors knowledge_promotions_bar_ck / _aggregate_group_ck, but
  --    returns a code instead of raising so the caller can log and move on.
  if p_is_aggregate and coalesce(p_supporting_hotel_count, 0) < 5 then
    return query select null::uuid, 'below_bar'::text;
    return;
  end if;
  if p_origin <> 'authored' then
    if coalesce(p_supporting_hotel_count, 0) < (case when p_target_tier = 'global' then 3 else 2 end) then
      return query select null::uuid, 'below_bar'::text;
      return;
    end if;
    if p_target_tier = 'global' and not coalesce(p_holdout_validated, false) then
      return query select null::uuid, 'below_bar'::text;
      return;
    end if;
  end if;

  insert into public.knowledge_promotions (
    topic, claim, evidence_summary, proposed_content,
    source_tier, target_tier, pms_family,
    origin, source_kind, source_ref, source_property_ids,
    supporting_hotel_count, observation_count,
    evidence_window_start, evidence_window_end,
    holdout_validated, is_aggregate, preconditions,
    target_table, target_row_id
  ) values (
    p_topic, p_claim, p_evidence_summary, p_proposed_content,
    p_source_tier, p_target_tier, p_pms_family,
    p_origin, p_source_kind, p_source_ref, coalesce(p_source_property_ids, '{}'),
    coalesce(p_supporting_hotel_count, 0), coalesce(p_observation_count, 0),
    p_evidence_window_start, p_evidence_window_end,
    coalesce(p_holdout_validated, false), coalesce(p_is_aggregate, false), coalesce(p_preconditions, '{}'),
    p_target_table, p_target_row_id
  )
  returning id into v_id;

  return query select v_id, 'inserted'::text;
end;
$$;

comment on function public.staxis_propose_promotion(text,text,text,text,text,text,text,text,text,text,uuid[],integer,integer,timestamptz,timestamptz,boolean,boolean,text[],text,uuid) is
  'The automatic entry point into the founder promotion queue. Returns (promotion_id, action) where action in (inserted|already_pending|already_promoted|refused_rejected|below_bar). A rejected topic is refused forever, across every tier. Added 0353.';

revoke execute on function public.staxis_propose_promotion(text,text,text,text,text,text,text,text,text,text,uuid[],integer,integer,timestamptz,timestamptz,boolean,boolean,text[],text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_propose_promotion(text,text,text,text,text,text,text,text,text,text,uuid[],integer,integer,timestamptz,timestamptz,boolean,boolean,text[],text,uuid)
  to service_role;

-- ── 5. Seed the first real item: the deferred base-prompt v10 clause ───────
-- Migration 0338 left a base-prompt row INACTIVE on purpose and documented
-- that activating it needs a manual `select staxis_activate_prompt(...)`. A
-- behaviour change that waits on the founder remembering an RPC call is a
-- behaviour change that never happens. It belongs in the queue instead.
--
-- It carries the machine-checkable precondition 0338 named: at least one
-- ACTIVE family row must exist, or the clause describes a section that never
-- renders. With zero family rows today this item is visible but NOT approvable
-- — the panel shows the reason. That is correct, not a bug.
--
-- origin='authored': a human wrote this clause; no hotel's data was lifted, so
-- there is no supporting-hotel bar to clear.
insert into public.knowledge_promotions (
  topic, claim, evidence_summary, proposed_content,
  source_tier, target_tier, pms_family,
  origin, source_kind, source_ref,
  preconditions, target_table, target_row_id
)
select
  'base_prompt_pms_context_clause',
  'Teach the copilot how to read a PMS-context section, and that a hotel''s own information always wins when it disagrees with shared knowledge.',
  'Written by hand in migration 0338 and left switched off. Before approving: at least one PMS-family instruction must be live (checked automatically), and the adversarial family-tier evals in src/lib/agent/evals must pass (checked by you).',
  p.content,
  null,
  'global',
  null,
  'authored',
  'migration',
  '0338',
  array['family_row_exists']::text[],
  'agent_prompts',
  p.id
from public.agent_prompts p
where p.role = 'base'
  and p.version = '2026.07.24-v10'
  and p.is_active = false
  and not exists (
    select 1 from public.knowledge_promotions k where k.topic = 'base_prompt_pms_context_clause'
  );

-- ── 6. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0353',
  'knowledge_promotions: founder-only queue for knowledge moving up a tier (hotel → PMS family → global) plus authored global behaviour changes. Service-role-only (deny-all anon+authenticated). Tier bars + aggregate min-group-size 5 as CHECKs; permanent rejection tombstone + automatic entry via staxis_propose_promotion; 75-day expiry and previous_target_row_id for reversibility. Seeds the deferred base-prompt v10 clause from 0338 as the first pending item.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
