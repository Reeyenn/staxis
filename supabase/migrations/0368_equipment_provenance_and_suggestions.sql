-- ═══════════════════════════════════════════════════════════════════════════
-- 0368 — Equipment: who put it there, and the question that offers to.
--
-- ═══ WHAT THIS MIGRATION IS *NOT* ═══
-- It is not a new `equipment` table, and it does not add
-- `work_orders.equipment_id` or `preventive_tasks.equipment_id`.
--
-- All three of those ALREADY EXIST and are live. `public.equipment` shipped in
-- 0029, was dropped in 0141 when nothing read it, and was revived in 0249 with
-- a real screen behind it; 0249 also re-added `work_orders.equipment_id`,
-- `work_orders.repair_cost` and `preventive_tasks.equipment_id`, all nullable,
-- all ON DELETE SET NULL. The production database has six equipment rows and
-- two work orders linked to one today. Writing a second registry — even a
-- narrower one — would have given a hotel two equipment lists that disagree,
-- and the first symptom would have been a pattern card about a compressor the
-- other list said had been replaced. CLAUDE.md's "extend before you add" is
-- exactly this case, and the check that proves it is a psql read, not a memory.
--
-- So this migration is the honest DELTA between what the equipment feature
-- already had and what the equipment-list work needs: provenance on an asset,
-- and somewhere for a suggested asset to live between being offered and being
-- accepted.
--
-- ── 1. Provenance on an asset ─────────────────────────────────────────────
-- The registry has always recorded WHAT a piece of equipment is and never WHO
-- said so. That was fine while the only author was a manager typing into a
-- form. It stops being fine the moment Staxis can offer to create one, because
-- "the hotel put this in" is the entire basis on which the equipment list is
-- trusted — the same philosophy as the knowledge base. An asset that appeared
-- because a pattern in the work-order text suggested it and a manager tapped
-- yes is still the hotel's assertion, but it is a DIFFERENT KIND of assertion
-- from one somebody typed out, and a registry that cannot tell them apart
-- cannot answer "where did this come from?" six months later.
--
-- `created_from` is therefore two values and will stay two values: a human
-- typed it, or a human accepted an offer to create it. There is no third state
-- in which Staxis creates equipment on its own, and no column here would make
-- one possible.
--
-- ── 2. The suggestion's home ──────────────────────────────────────────────
-- The offer itself rides the EXISTING drip-question machinery
-- (`agent_knowledge_questions`, 0359): one question per session, never the same
-- one twice, an ignored question gone for the day, declined means never again.
-- Those four promises took real work to get right and a second question surface
-- would either duplicate them or quietly break one — see
-- src/lib/findings/ask-drip.ts, which made the same call for findings.
--
-- Riding it needs two things the ledger does not have:
--
--   category 'equipment'          a question about tracking a thing is not one
--                                 of the five operational-signal categories
--                                 wearing the closest available label.
--
--   suggested_equipment_name      the term a "yes" turns into a row. WITHOUT a
--                                 column, the answer path would have to recover
--                                 it by splitting `topic` — and a feature that
--                                 parses an identifier out of a key string
--                                 breaks silently the first time the key format
--                                 changes. `equipment_id` is the other half:
--                                 the row a "yes" created, stored the same way
--                                 `memory_id` (0359) and `finding_id` (0362)
--                                 already record what an answer produced.
--
-- ACCESS MODEL — UNCHANGED, AND BOTH TABLES ARE ALREADY DENY-ALL.
-- `public.equipment` is service-role-only (0249): anon and authenticated are
-- revoked and carry a `for all … using (false)` policy, and every read/write
-- goes through /api/maintenance/equipment/* behind requireSession +
-- userHasPropertyAccess + the manage_equipment capability.
-- `public.agent_knowledge_questions` is the same posture (0359), reached only
-- through /api/memory/question behind loadManagerCaller + managerManagesHotel.
-- Columns added to a table inherit its policies and its table-level grants, so
-- there is nothing to re-grant and no new surface to police.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Who put this asset on the list ──────────────────────────────────────
-- ON DELETE SET NULL on the account: staff leave, and an asset must never
-- disappear (or become undeletable) because the manager who logged it did.
alter table public.equipment
  add column if not exists created_by_account_id uuid
    references public.accounts(id) on delete set null,
  add column if not exists created_by_name text,
  add column if not exists created_from text not null default 'manual';

comment on column public.equipment.created_by_account_id is
  'The account that put this asset on the list, or null for the rows that predate 0368 (and for anyone since deleted). Added 0368.';

comment on column public.equipment.created_by_name is
  'Display name captured at creation time, so the registry can still say who logged an asset after that person leaves. Free text, same convention as work_orders.submitted_by_name.';

comment on column public.equipment.created_from is
  'How this asset came to exist: ''manual'' — somebody typed it into the registry form; ''suggestion'' — Staxis noticed the same equipment word in several work orders, asked, and a manager tapped yes. There is deliberately no value meaning "Staxis created this on its own": the hotel puts equipment in, always. Added 0368.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'equipment_created_from_ck'
  ) then
    alter table public.equipment
      add constraint equipment_created_from_ck
      check (created_from in ('manual', 'suggestion'));
  end if;
end $$;

-- Cheap, and the only question this column is ever asked: "which of these did
-- the hotel accept from a suggestion?" Partial, because 'manual' is and should
-- remain the overwhelming majority.
create index if not exists equipment_property_suggested_idx
  on public.equipment (property_id)
  where created_from = 'suggestion';

-- ── 2. A drip question that offers to track a piece of equipment ───────────
alter table public.agent_knowledge_questions
  add column if not exists suggested_equipment_name text,
  add column if not exists equipment_id uuid
    references public.equipment(id) on delete set null;

comment on column public.agent_knowledge_questions.suggested_equipment_name is
  'For category ''equipment'': the term this question offers to start tracking, exactly as it will be written into equipment.name. Stored rather than recovered from `topic`, because a feature that parses an identifier out of a key string fails silently the first time the key format changes. Null for every other category. Added 0368.';

comment on column public.agent_knowledge_questions.equipment_id is
  'The equipment row a "yes" on this question created. Null until answered, null forever on a decline, and null if the asset is later deleted. Mirrors memory_id (0359) and finding_id (0362): the ledger records what the answer produced. Added 0368.';

-- The name is written straight into `equipment.name`, which the API validates
-- at 120 characters. The database refuses anything the API would, so a row that
-- could never be turned into an asset cannot be stored as an offer to.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_knowledge_questions_suggested_equipment_name_ck'
  ) then
    alter table public.agent_knowledge_questions
      add constraint agent_knowledge_questions_suggested_equipment_name_ck
      check (
        suggested_equipment_name is null
        or (char_length(btrim(suggested_equipment_name)) between 1 and 120)
      );
  end if;
end $$;

-- An 'equipment' question with nothing to create is an offer whose button
-- cannot do anything — the manager taps yes and the app has to invent a name or
-- fail. Refused here so no code path can produce one.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_knowledge_questions_equipment_needs_name_ck'
  ) then
    alter table public.agent_knowledge_questions
      add constraint agent_knowledge_questions_equipment_needs_name_ck
      check (category <> 'equipment' or suggested_equipment_name is not null);
  end if;
end $$;

-- ── 3. 'equipment' joins the category set ──────────────────────────────────
-- Replaced rather than widened in place: the constraint is a plain list and
-- rewriting it is the whole change.
alter table public.agent_knowledge_questions
  drop constraint if exists agent_knowledge_questions_category_ck;

alter table public.agent_knowledge_questions
  add constraint agent_knowledge_questions_category_ck
  check (category in (
    -- the five operational-signal categories (0359)
    'maintenance', 'complaint', 'noise', 'inspection', 'cleaning',
    -- a finding the judge sorted as a question (0362)
    'finding',
    -- an offer to start tracking a piece of equipment (0368)
    'equipment'
  ));

-- ── 4. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0368',
  'Equipment provenance + the suggestion that offers to create one. Adds NO table and NO link column: public.equipment, work_orders.equipment_id and preventive_tasks.equipment_id all already exist and are live (0249, revived from 0029/0030). equipment gains created_by_account_id / created_by_name / created_from (''manual'' | ''suggestion'', CHECK-constrained — there is no value meaning Staxis created it alone) plus a partial index on the suggested rows. agent_knowledge_questions gains suggested_equipment_name (the term a yes turns into a row, stored rather than parsed back out of topic) and equipment_id (what the yes produced, mirroring memory_id/finding_id), with CHECKs that an equipment question always names something creatable and that the name fits the 120-char limit the API enforces. The category CHECK gains ''equipment''. RLS unchanged: both tables are already service-role-only deny-all and new columns inherit their policies and grants.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
