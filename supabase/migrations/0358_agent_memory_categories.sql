-- ═══════════════════════════════════════════════════════════════════════════
-- 0358 — agent_memory: category buckets + review state
--
-- Backs the manager-facing "Knows" view (the Staxis section's second tab):
-- "here is what I know, here is where I learned it, tell me if I'm wrong."
--
-- Two columns, both on the EXISTING table (extend before you add):
--
--   category      One of five manager-legible buckets the Knows screen groups
--                 by: rooms | people | rhythm | vendors | guests. There was no
--                 grouping dimension at all before this; without one the screen
--                 is an undifferentiated 200-row list.
--
--   review_state  'unreviewed' | 'confirmed'. A fact a manager pasted or
--                 uploaded is EXTRACTED BY A MODEL from untrusted content, so
--                 it must NOT become established truth before a human looks at
--                 it. Unreviewed rows are excluded from the copilot's per-turn
--                 memory read (src/lib/db/agent-memory.ts getActiveMemoryForTurn)
--                 — that exclusion, not a UI badge, is the real guarantee.
--                 Everything that exists today backfills to 'confirmed' and the
--                 column DEFAULTS to 'confirmed', so no existing write path
--                 changes behavior.
--
-- THE NULL HOLE: agent_memory is written by paths this migration does not
-- touch — the `remember` agent tool (LLM-authored topics), nightly
-- consolidation, and operational-signal detection. Rather than edit every call
-- site and hope none is ever added, a BEFORE INSERT/UPDATE trigger classifies
-- any row that arrives without a category. The DB is therefore the single
-- classifier; app code passes a category only when a HUMAN (or the extraction
-- pass, subject to review) chose one. NOT NULL is safe because the trigger runs
-- first and the classifier never returns null.
--
-- Manual prod apply (project_migration_application_manual.md). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The classifier ───────────────────────────────────────────────────────
-- Deterministic, ordered keyword rules over (topic, content). Ordering is the
-- whole policy: the operational-signal topic slugs (owned by
-- src/lib/agent/operational-signals.ts) are matched FIRST because their shape
-- is guaranteed, then the free-text rules run most-specific to least.
--
-- 'rhythm' is the declared SAFE DEFAULT: a fact that matches nothing is a fact
-- about how this hotel runs. Misfiling is a cosmetic error the manager fixes
-- with Edit; a crash or a NULL is not.
create or replace function public.staxis_classify_memory_category(
  p_topic text,
  p_content text
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_topic text := lower(coalesce(p_topic, ''));
  v_all   text := lower(coalesce(p_topic, '') || ' ' || coalesce(p_content, ''));
begin
  -- Operational-signal slugs (stable, generated — never free text).
  if v_topic like 'op\_maint%' or v_topic like 'op\_inspect\_fail%' or v_topic like 'op\_clean\_slow%' then
    return 'rooms';
  elsif v_topic like 'op\_complaint%' then
    return 'guests';
  elsif v_topic like 'op\_noise\_floor%' then
    return 'rhythm';
  end if;

  -- Free text, most specific first.
  if v_all ~ '(vendor|supplier|distributor|contractor|plumber|electrician|exterminator|pest control|linen service|laundry service|elevator company|account number|account #|service call|invoice|purchase order|rep name|sales rep)' then
    return 'vendors';
  elsif v_all ~ '(staff|employee|housekeep|room attendant|front desk|maintenance tech|engineer|supervisor|manager|gm |general manager|shift|schedule for|works |trains |hire|payroll|breakfast attendant|laundry attendant|night audit)' then
    return 'people';
  elsif v_all ~ '(guest|complaint|review|check-?in|check-?out|loyalty|rewards member|group block|wedding|pet policy|no-?show|walk-?in|folio)' then
    return 'guests';
  elsif v_all ~ '(room |rooms |suite|floor |ac |a/c|hvac|air condition|plumbing|toilet|shower|tv|television|wifi|wi-fi|elevator|door lock|keycard|ice machine|pool|boiler|water heater|balcony|connecting)' then
    return 'rooms';
  elsif v_all ~ '(breakfast|busy|slow season|peak|weekend|weekday|occupancy|rush|arrival pattern|departure pattern|morning|evening|overnight|holiday|event)' then
    return 'rhythm';
  end if;

  return 'rhythm';
end;
$$;

comment on function public.staxis_classify_memory_category(text, text) is
  'Deterministic bucket for an agent_memory row: rooms|people|rhythm|vendors|guests. Ordered keyword rules; operational-signal topic slugs matched first. Falls back to the safe default rhythm. Added 0358.';

revoke execute on function public.staxis_classify_memory_category(text, text) from public, anon, authenticated;
grant  execute on function public.staxis_classify_memory_category(text, text) to service_role;

-- ── 2. Columns (nullable first so the backfill can run) ─────────────────────
alter table public.agent_memory add column if not exists category     text;
alter table public.agent_memory add column if not exists review_state text;

-- ── 3. Backfill ─────────────────────────────────────────────────────────────
update public.agent_memory
   set category = public.staxis_classify_memory_category(topic, content)
 where category is null;

-- Everything that predates this migration was already reaching the copilot as
-- established truth. Marking it 'confirmed' preserves exactly that behavior —
-- this migration must not silently mute a hotel's existing memory. The one
-- exception is source='inferred', which no shipped write path produces today
-- and which from here on means "model-extracted, not yet reviewed"; the same
-- rule the trigger below enforces is applied to the backfill so the two can
-- never disagree.
update public.agent_memory
   set review_state = case when source = 'inferred' then 'unreviewed' else 'confirmed' end
 where review_state is null;

-- ── 4. The no-NULL-hole trigger ─────────────────────────────────────────────
create or replace function public.staxis_agent_memory_fill_facets()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.category is null then
    new.category := public.staxis_classify_memory_category(new.topic, new.content);
  end if;

  -- THE HARD RULE. source='inferred' means "a model pulled this out of text a
  -- manager pasted or a file they uploaded" — untrusted content, not yet seen
  -- by a human. Such a row is ALWAYS unreviewed, on insert and on update, with
  -- no way for a caller to opt out. Confirming a fact is therefore not a flag
  -- flip: the app promotes source to explicit_user/correction (a human now owns
  -- it), which is also what makes the 0260/0261 auto-overwrite protections
  -- apply to it for free.
  --
  -- Without the UPDATE half of this rule, re-uploading a document that
  -- restates an already-confirmed topic would run staxis_store_memory's
  -- upsert branch, swap source to 'inferred', and leave review_state
  -- 'confirmed' — quietly turning unreviewed content into established truth.
  if new.source = 'inferred' then
    new.review_state := 'unreviewed';
  elsif new.review_state is null then
    new.review_state := 'confirmed';
  end if;

  return new;
end;
$$;

comment on function public.staxis_agent_memory_fill_facets() is
  'BEFORE INSERT/UPDATE on agent_memory: fills category (via staxis_classify_memory_category) when absent, and FORCES review_state=unreviewed for any source=inferred row (model-extracted from manager-supplied text/files). Other rows default to confirmed. Lets both columns be NOT NULL without editing every write path. Added 0358.';

drop trigger if exists staxis_agent_memory_fill_facets on public.agent_memory;
create trigger staxis_agent_memory_fill_facets
  before insert or update on public.agent_memory
  for each row execute function public.staxis_agent_memory_fill_facets();

-- ── 5. Constraints (safe now: backfilled + trigger in place) ────────────────
-- DELIBERATELY NO COLUMN DEFAULTS. A DEFAULT is applied BEFORE row triggers
-- fire, so NEW.category would never be NULL and the classifier above would
-- never run — every row written by a path that doesn't name a category would
-- silently land in one bucket. (Caught by the integration suite: the first
-- version of this migration had `set default 'rhythm'` and every uncategorized
-- row came out 'rhythm'.)
--
-- The same reasoning applies to review_state, and there it matters more: with
-- a DEFAULT of 'confirmed', an insert that somehow bypassed the trigger would
-- mark model-extracted content as established truth. With no default, such an
-- insert fails the NOT NULL check instead. Fail loudly, not quietly.
alter table public.agent_memory alter column category     drop default;
alter table public.agent_memory alter column review_state drop default;
alter table public.agent_memory alter column category     set not null;
alter table public.agent_memory alter column review_state set not null;

alter table public.agent_memory drop constraint if exists agent_memory_category_check;
alter table public.agent_memory add constraint agent_memory_category_check
  check (category in ('rooms','people','rhythm','vendors','guests'));

alter table public.agent_memory drop constraint if exists agent_memory_review_state_check;
alter table public.agent_memory add constraint agent_memory_review_state_check
  check (review_state in ('unreviewed','confirmed'));

comment on column public.agent_memory.category is
  'Manager-legible bucket for the Knows screen: rooms|people|rhythm|vendors|guests. NOT NULL with NO default — filled by the staxis_agent_memory_fill_facets trigger, which a default would pre-empt. Added 0358.';
comment on column public.agent_memory.review_state is
  'unreviewed = extracted from manager-pasted text or an uploaded file and NOT yet approved by a human; excluded from the copilot per-turn memory read. confirmed = established truth. NOT NULL with NO default: source=inferred forces unreviewed via the fill-facets trigger, and everything else is stamped confirmed there, so an insert that bypassed the trigger fails loudly instead of quietly publishing unreviewed content. Added 0358.';

-- ── 6. Index — the Knows screen reads one property''s active rows grouped by
--       bucket; the per-turn read now also filters review_state. ────────────
create index if not exists agent_memory_property_facets_idx on public.agent_memory
  (property_id, is_active, review_state, category);

-- ── 7. Bookkeeping + schema reload ──────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0358',
  'agent_memory: add category (rooms|people|rhythm|vendors|guests) + review_state (unreviewed|confirmed) for the manager Knows screen. Deterministic SQL classifier + BEFORE INSERT/UPDATE trigger fill both on every write path (no NULL hole); existing rows backfill to confirmed so copilot behavior is unchanged.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
