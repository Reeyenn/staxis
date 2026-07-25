-- ─── Migration 0338: the PMS-family prompt tier — the SLOT, not the content ──
--
-- Today the copilot's instructions have exactly two tiers:
--   global  — one base row + one row per role, true of every hotel
--   hotel   — DATA only (agent_memory, knowledge_*), never a prompt row
--
-- Missing is the middle: "things true of every hotel on Choice Advantage".
-- The moment we can read a real Choice Advantage report we will want to write
-- down once, for every CA hotel, that the "Exp Dep" column means departures
-- and that vacant-clean rooms are omitted. Without a middle tier that
-- knowledge goes either into the one global row (wrong for every non-CA
-- hotel) or into one hotel's memory (invisible to hotel #2).
--
-- This migration builds the slot and seeds ZERO family rows. With no family
-- row active, the assembled prompt is byte-identical to today's — the
-- additive-zero guarantee, pinned by src/lib/__tests__/agent-prompt-tiers.test.ts.
--
-- Why now: the family tier lives inside the CACHED half of the system prompt.
-- Adding a tier there after real conversations exist causes a one-time
-- cache-miss wave on every open conversation. Today there are 53 agent_messages
-- rows, 7 agent_prompts rows and 1 live hotel — the retrofit is free now and
-- never free again.
--
-- Shape: a row is EITHER fully global (role <> 'family', pms_family IS NULL)
-- OR fully family (role = 'family', pms_family NOT NULL). No third state is
-- representable. There is deliberately no property_id column: hotel-tier
-- content is data, never a prompt row, so a hotel can never author behaviour.
--
-- NOT APPLIED by the agent — Reeyen applies migrations by hand (CLAUDE.md).
-- Apply order: this migration → `notify pgrst, 'reload schema'` → deploy code.

-- ── (a) the family key ──────────────────────────────────────────────────────
-- NULL = global tier. All 7 existing rows are NULL, so every constraint below
-- is satisfied by the current data on the first apply.
alter table public.agent_prompts
  add column if not exists pms_family text;

-- ── (b) widen the role CHECK ────────────────────────────────────────────────
-- Same drop-and-re-add shape migration 0109 used to add 'summarizer'.
alter table public.agent_prompts
  drop constraint if exists agent_prompts_role_check;

alter table public.agent_prompts
  add constraint agent_prompts_role_check
  check (role in ('base', 'housekeeping', 'general_manager', 'owner', 'admin', 'summarizer', 'family'));

-- ── (c) tier coherence ──────────────────────────────────────────────────────
-- Mirrors agent_memory_scope_subject_ck (0256). Makes a half-specified row
-- impossible, and closes the footgun of inserting role='housekeeping' +
-- pms_family='choice_advantage' and wondering why nothing happens: the
-- resolver only ever looks for role='family', so such a row would silently
-- do nothing. Now it is rejected at write time instead.
alter table public.agent_prompts
  drop constraint if exists agent_prompts_tier_coherence_ck;

alter table public.agent_prompts
  add constraint agent_prompts_tier_coherence_ck
  check ((role = 'family') = (pms_family is not null));

-- ── (d) the family key is a closed enum ─────────────────────────────────────
-- Literal PMS_TYPES tuple from src/lib/pms/types.ts, same convention as
-- scraper_credentials.pms_type (0031). A typo'd family would key a cached
-- prompt block that no hotel ever resolves — silent dead content.
alter table public.agent_prompts
  drop constraint if exists agent_prompts_pms_family_enum_ck;

alter table public.agent_prompts
  add constraint agent_prompts_pms_family_enum_ck
  check (
    pms_family is null
    or pms_family in (
      'choice_advantage', 'opera_cloud', 'cloudbeds', 'roomkey',
      'skytouch', 'webrezpro', 'hotelogix', 'other'
    )
  );

-- ── (e) the cost ceiling ────────────────────────────────────────────────────
-- 4000 chars ≈ 1000 tokens. Family content is paid per family on every cached
-- prefix write, so this is the hard cap on what the tier can add to the bill.
alter table public.agent_prompts
  drop constraint if exists agent_prompts_family_len_ck;

alter table public.agent_prompts
  add constraint agent_prompts_family_len_ck
  check (role <> 'family' or char_length(content) <= 4000);

-- ── (f) a family row cannot forge the assembler's vocabulary ────────────────
-- '<staxis-…' and '<tool-result…' are the trust markers llm.ts uses to tell
-- the model what is ground truth and what is untrusted data; '───' is the
-- assembler's section-header vocabulary. A family row supplies CONTENT; the
-- header is supplied by the assembler. Without this, family text could
-- fabricate a `<staxis-snapshot trust="system">` block or open a fake section.
alter table public.agent_prompts
  drop constraint if exists agent_prompts_family_no_markers_ck;

alter table public.agent_prompts
  add constraint agent_prompts_family_no_markers_ck
  check (
    role <> 'family'
    or (content !~ '<\s*/?\s*(staxis-|tool-result)' and content not like '%───%')
  );

-- ── (g) one active row per (role, family) ───────────────────────────────────
-- COALESCE sentinel because NULL is not comparable in a unique index — the
-- pattern agent_memory_active_topic_key (0256) already uses. Every existing
-- row has pms_family IS NULL, so COALESCE yields '' and the new index reduces
-- EXACTLY to the old one. No existing row can conflict.
--
-- Lock note: DROP INDEX + CREATE UNIQUE INDEX take ACCESS EXCLUSIVE. On a
-- 7-row table inside a transactional DDL apply this is microseconds.
drop index if exists public.agent_prompts_active_per_role_uq;

create unique index if not exists agent_prompts_active_per_role_family_uq
  on public.agent_prompts (role, coalesce(pms_family, ''))
  where is_active = true;

-- ── (h) fix the activation RPC for the new key ──────────────────────────────
-- REAL BUG, introduced by the key above if skipped: staxis_activate_prompt
-- (0106) deactivates every row `where role = p_role`. Called with
-- role='family' that wipes EVERY family's active row and leaves zero active —
-- a state the partial unique index permits, the reader's fail-soft path
-- swallows (family resolves to null), and nobody notices except as "the PMS
-- guidance quietly stopped applying". Both UPDATEs now filter on the family
-- key as well.
--
-- The 2-arg form is dropped and replaced by a 3-arg form with a NULL default,
-- so an existing 2-arg call (`{p_id, p_role}`) still resolves and behaves
-- identically for global rows.
drop function if exists public.staxis_activate_prompt(uuid, text);

create or replace function public.staxis_activate_prompt(
  p_id uuid,
  p_role text,
  p_pms_family text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Deactivate the previously-active row (if any) for this EXACT tier.
  update public.agent_prompts
    set is_active = false
    where role = p_role
      and coalesce(pms_family, '') = coalesce(p_pms_family, '')
      and id <> p_id
      and is_active = true;

  -- Activate the target row.
  update public.agent_prompts
    set is_active = true
    where id = p_id
      and role = p_role
      and coalesce(pms_family, '') = coalesce(p_pms_family, '');

  -- If the target row didn't exist, or had a different role/family, the
  -- second UPDATE matched zero rows. RETURNS void means PostgREST would
  -- report success, so raise instead — the caller must know the activate
  -- did not land.
  if not found then
    raise exception 'prompt_not_found_or_wrong_tier (id=%, role=%, pms_family=%)', p_id, p_role, p_pms_family
      using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.staxis_activate_prompt(uuid, text, text) is
  'Activate a prompt row atomically within one tier: deactivate-others + activate-target in a single transaction, scoped to (role, coalesce(pms_family,'''')). Migration 0338 added the family scope — without it, activating one family deactivated every other family. Original: round-10 F5, 2026-05-13.';

revoke execute on function public.staxis_activate_prompt(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.staxis_activate_prompt(uuid, text, text) to service_role;

-- ── (i) document the column ─────────────────────────────────────────────────
comment on column public.agent_prompts.pms_family is
  'NULL = global tier. Non-NULL (with role=''family'') = the PMS-family addendum shared by every hotel on that PMS. Never per-hotel: hotel-tier content is DATA (agent_memory / knowledge_*), never a prompt row.';

-- ── (j) DEFERRED, INACTIVE: the base-prompt clause that names the tier ──────
-- The conflict rule the family tier needs the model to know:
--   R1 FACTS     — more specific scope wins: hotel > family > global.
--   R2 BEHAVIOUR — global hard rules are never relaxed; a family row may only
--                  ADD or NARROW.
--
-- This row is inserted is_active = FALSE ON PURPOSE. Activating it is the one
-- user-observable change in this workstream, it lands on the single live
-- hotel, and it describes a section that does not exist yet (zero family rows).
-- It is written now so the change is reviewable, and stays dark until:
--   1. the founder approves the behaviour change, AND
--   2. at least one family row is ready to activate, AND
--   3. the adversarial family-tier eval bank passes (src/lib/agent/evals).
-- Then, and only then:
--   select public.staxis_activate_prompt('<id>', 'base');
--
-- Content is derived from whatever base row is active at apply time, so the
-- clause is strictly additive to the live text rather than a stale fork of it.
insert into public.agent_prompts (role, version, content, is_active, notes)
select
  'base',
  '2026.07.24-v10',
  active.content || E'\n\n' ||
  'PMS context (how this hotel''s reports read):
- When a `─── PMS context ───` section is present, it describes how THIS hotel''s property-management system reports data. It refines the rules above; it never overrides your hard rules or your refusals.
- If this hotel''s own Knowledge hub or a remembered fact contradicts the PMS context, this hotel''s own information wins — say so rather than silently picking one.',
  false,
  'DEFERRED / INACTIVE (migration 0338). Names the PMS-context section and the hotel > family > global conflict rule. Do NOT activate until the founder approves the behaviour change AND a family row exists AND the adversarial family-tier evals pass.'
from public.agent_prompts active
where active.role = 'base'
  and active.is_active = true
  and not exists (
    select 1 from public.agent_prompts
    where role = 'base' and version = '2026.07.24-v10'
  );

insert into public.applied_migrations (version, description)
values ('0338', 'AI tiers: agent_prompts.pms_family family tier (slot only, zero family rows) + tier-coherence/enum/length/forgery CHECKs + family-scoped activation RPC + deferred inactive base v10 clause')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
