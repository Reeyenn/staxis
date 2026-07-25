-- ═══════════════════════════════════════════════════════════════════════════
-- 0362 — The findings learning loop: the library shrinks, and it can grow.
--
-- WHAT THIS IS
-- Phase 1 gave findings a ledger (0360) and Phase 2 gave them a judge (0361).
-- Both only ever ADD: more detectors, more cards. A watcher that can only grow
-- ends as a screen nobody reads. This migration is the other direction —
--
--   • self-demotion    a check whose findings are shown and ignored, at THIS
--                      hotel, quietly steps down and eventually rests
--   • the weekly sweep the discovery pass that can propose a NEW check, having
--                      first had to reproduce its own claim against real data
--   • the ask wiring   a finding the judge turned into a question renders
--                      through the one question surface that already exists
--
-- WHY THREE SMALL ADDITIONS AND NOT ONE BIG TABLE ("extend before you add")
--
--   findings.last_shown_on          an ADDED COLUMN, not a table. The
--                                   shown/acted/ignored counters have existed
--                                   since 0360 as scaffold; all that was
--                                   missing was "have we already counted a show
--                                   today", and that is one date.
--
--   finding_detector_state          a NEW table, unavoidably. Demotion state is
--                                   per (hotel, detector). `findings` is per
--                                   PROBLEM, `finding_runs` is per RUN, and
--                                   nothing in the schema is keyed the way this
--                                   is. It is also the only place a re-arm can
--                                   live: derived state would re-demote a
--                                   re-armed check on the very next night,
--                                   because the counters that demoted it are
--                                   still there.
--
--   finding_sweep_runs              a NEW table rather than a `run_kind` column
--                                   on finding_runs. Mixing them would put a
--                                   sweep row where `latestRun()` looks, and
--                                   the card screen would announce "checked 0
--                                   things last night" on a night 34 things
--                                   were checked. finding_runs exists to make a
--                                   quiet system distinguishable from a dead
--                                   one; a second kind of row inside it defeats
--                                   exactly that.
--
--   agent_knowledge_questions       an ADDED COLUMN (+ one widened CHECK). The
--     .finding_id                   drip-question ledger already owns "asked
--                                   once, never twice, at most one a session".
--                                   A finding-derived question is another
--                                   question, not another question SYSTEM, so
--                                   it goes in the same ledger and carries a
--                                   pointer back to the finding it resolves.
--
--   knowledge_promotions            a widened CHECK. The founder's queue is the
--     .source_kind                  ONLY door into shared knowledge (0353) and
--                                   this migration does not add a second one —
--                                   it teaches the existing one to say where a
--                                   machine-authored detector proposal came
--                                   from, instead of letting it wear
--                                   'extraction' as a disguise.
--
-- THE PRIVACY RULE THIS MIGRATION IS SHAPED BY
-- A promoted detector must be property-agnostic BY CONSTRUCTION. A detector
-- that encodes "rooms 400-410" or "$1,240" is one hotel's data crossing into
-- every hotel that shares its PMS family — a tenant leak wearing a feature's
-- clothes. That guard lives in code (sweep-promotion.ts) because it is a
-- content check, but the reason it exists is recorded here: nothing in this
-- migration gives a sweep a way into `knowledge_promotions` that skips it.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY for both new tables, mirroring findings
-- (0360) and agent_memory (0256): anon + authenticated deny-all.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent. Apply → `notify pgrst, 'reload schema'` → deploy code.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. findings.last_shown_on — one show per day, not one per page load ────
-- WHY A DATE AND NOT A TIMESTAMP: "was this card already counted as shown
-- today?" is a calendar question, and the hotel's calendar is the one that
-- counts. Without it a manager who refreshes the queue eleven times has
-- "shown" eleven times, and a detector would demote itself on one anxious
-- morning.
alter table public.findings
  add column if not exists last_shown_on date;

comment on column public.findings.last_shown_on is
  'Hotel-local date this finding was last counted as SHOWN to a manager. Guards shown_count against a refresh loop: a card shown twice in one day counts once. Added 0362.';

-- ── 2. finding_detector_state — demotion, per hotel, per detector ──────────
-- @rls: service-role-only — written by the findings runner, read by nothing
-- outside server code. No anon path, no browser path.
--
-- PER-HOTEL IS THE WHOLE POINT. One hotel ignoring the supply-spend card must
-- not silence it at a hotel where it is the most useful thing on the screen.
-- The unique index below is that guarantee: state is keyed by (property_id,
-- detector_id), so there is nowhere for a fleet-wide demotion to be written.
create table if not exists public.finding_detector_state (
  id                      uuid primary key default gen_random_uuid(),

  property_id             uuid not null references public.properties(id) on delete cascade,
  -- Matches DetectorDeclaration.id (src/lib/findings/registry.ts) and
  -- findings.detector_id. Not an FK — detectors live in code, not in a table.
  detector_id             text not null check (char_length(detector_id) between 1 and 64),

  -- How many rungs down the ladder this detector has fallen AT THIS HOTEL.
  -- The ladder is propose → recommend → fyi → dormant, and where a detector
  -- starts is its own declared default, so the absolute disposition is
  -- computed in code from (default, steps_down) rather than stored here. 3 is
  -- the floor: past fyi there is only rest.
  steps_down              integer not null default 0 check (steps_down between 0 and 3),

  -- Resting. The runner skips it entirely and counts it in the run summary as
  -- a check that is resting — NOT as a check that was skipped for want of
  -- data, which is a different sentence about a different problem.
  dormant                 boolean not null default false,
  dormant_since           timestamptz,

  -- ── the baseline: why a demotion cannot cascade ─────────────────────────
  -- Engagement counters on `findings` are cumulative and per-problem. These
  -- record the totals ALREADY ACCOUNTED FOR at this detector's last transition
  -- (or its last re-arm). Every demotion decision reads only what has happened
  -- since. Without this, the ten ignored shows that demoted propose→recommend
  -- would still be sitting there tomorrow, demote it again, and a check would
  -- fall from propose to dormant in three nights on one week of evidence.
  baseline_shown          integer not null default 0 check (baseline_shown >= 0),
  baseline_acted          integer not null default 0 check (baseline_acted >= 0),
  baseline_at             timestamptz not null default now(),

  -- A human put this check back on duty. Re-arming resets steps_down and the
  -- baseline, so the evidence that rested it does not immediately rest it
  -- again — the check gets a genuinely fresh hearing.
  rearmed_at              timestamptz,

  -- [{ at, from, to, shown, acted, span_days, reason }] — every transition,
  -- appended, never overwritten. A demotion nobody can see the reason for is
  -- indistinguishable from a bug.
  transitions             jsonb not null default '[]'::jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- Resting and "resting since" travel together, in both directions.
  constraint finding_detector_state_dormancy_paired check (
    dormant = (dormant_since is not null)
  )
);

-- ONE state row per (hotel, detector). This index IS the per-hotel guarantee:
-- there is no row shape that could express a fleet-wide demotion.
create unique index if not exists finding_detector_state_property_detector_uq
  on public.finding_detector_state (property_id, detector_id);

comment on table public.finding_detector_state is
  'Per (hotel, detector) demotion state for the findings layer: how far down the propose→recommend→fyi→dormant ladder this check has fallen AT THIS HOTEL, the engagement already accounted for, and every transition. Per-hotel by construction — one hotel ignoring a card must never silence it for another. Service-role-only. Added 0362.';
comment on column public.finding_detector_state.steps_down is
  'Rungs fallen from the detector''s own declared default disposition. The absolute disposition is (default, steps_down) resolved in code, because two detectors can start on different rungs.';
comment on column public.finding_detector_state.baseline_shown is
  'Cumulative shown_count already accounted for at the last transition or re-arm. Demotion reads only engagement since this point, so one week of ignoring cannot cascade a check from propose to dormant.';
comment on column public.finding_detector_state.transitions is
  'Append-only log of every demotion and re-arm: when, from, to, the counters behind it, and why.';

-- ── 3. finding_sweep_runs — what the weekly discovery pass did ─────────────
-- @rls: service-role-only.
--
-- Its job is the same as finding_runs': make an absence legible. A sweep that
-- found nothing worth proposing, a sweep that never ran because the hotel was
-- not in this week's sample, and a sweep that was refused by the spend cap all
-- leave the findings table looking identical, and only one of them is fine.
--
-- It also carries the HYPOTHESIS LEDGER. Every claim the model made is written
-- here with its verdict, including — especially — the ones a real query could
-- not reproduce. That miss rate is the only evidence of whether the
-- reproduce-or-die filter is doing work or theatre.
create table if not exists public.finding_sweep_runs (
  id                      uuid primary key default gen_random_uuid(),

  property_id             uuid not null references public.properties(id) on delete cascade,

  run_at                  timestamptz not null default now(),
  -- The hotel's own business date. Sampling rotates on "when was this hotel
  -- last swept", and that is a calendar answer.
  run_date                date not null,

  --   model               a call was made and its hypotheses were tested
  --   skipped_cap         this hotel's daily findings-AI budget was exhausted
  --   skipped_thin        not enough history here for aggregates to mean anything
  --   fallback_error      the provider failed, timed out, or was unreachable
  --   fallback_malformed  the reply broke the output contract and was refused
  mode                    text not null check (mode in (
                            'model','skipped_cap','skipped_thin','fallback_error','fallback_malformed'
                          )),

  hypotheses              integer not null default 0 check (hypotheses >= 0),
  -- Survived a real deterministic query against this hotel's own data.
  reproduced              integer not null default 0 check (reproduced >= 0),
  -- Did not. Logged and dead. This is the hallucination filter's scoreboard.
  irreproducible          integer not null default 0 check (irreproducible >= 0),

  -- Reproduced candidates that stayed at this hotel as a recommendation.
  candidates_local        integer not null default 0 check (candidates_local >= 0),
  -- Reproduced candidates that reached the founder's promotion queue.
  candidates_promoted     integer not null default 0 check (candidates_promoted >= 0),

  cost_usd                numeric not null default 0 check (cost_usd >= 0),
  model                   text,

  -- PROPERTY-AGNOSTIC candidate signatures reproduced in this run. Deliberately
  -- a top-level array and not buried in `detail`: counting how many DISTINCT
  -- hotels have reproduced the same candidate is what decides whether it is a
  -- quirk of one hotel or a check worth proposing to a family, and that count
  -- has to be a cheap indexed query. A signature never contains a room number,
  -- an item name, an amount, or anything else belonging to one hotel.
  signatures              text[] not null default '{}',

  -- { hypotheses: [{ claim, check, verdict, reason }], candidates: [...] }.
  -- The model's own sentences live HERE and are never rendered to a manager —
  -- what a manager sees is written by code from the reproducer's numbers.
  detail                  jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now()
);

create index if not exists finding_sweep_runs_property_run_at_idx
  on public.finding_sweep_runs (property_id, run_at desc);

-- The rotation read: "which hotels have gone longest without a sweep".
create index if not exists finding_sweep_runs_run_at_idx
  on public.finding_sweep_runs (run_at desc);

-- The cross-hotel read: "how many hotels have reproduced this candidate".
create index if not exists finding_sweep_runs_signatures_idx
  on public.finding_sweep_runs using gin (signatures);

comment on table public.finding_sweep_runs is
  'One row per hotel per weekly AI-sweep execution: what mode it ran in, how many hypotheses the model made, how many survived being reproduced by a real query, what that produced, and what it cost. The hypothesis ledger and the sampling rotation both live here. Service-role-only. Added 0362.';
comment on column public.finding_sweep_runs.irreproducible is
  'Hypotheses a real deterministic query could not reproduce. They are logged and dead — this count is the hallucination filter''s visible miss rate.';
comment on column public.finding_sweep_runs.signatures is
  'Property-agnostic identities of the candidates reproduced in this run. Never contains a room number, item name or amount: it exists to count DISTINCT hotels backing a candidate, which is the bar a candidate must clear before it may be proposed as shared knowledge.';

-- ── 4. finding_runs.detectors_dormant — resting is not skipping ────────────
-- "3 checks could not run for want of data" and "3 checks are resting because
-- this hotel ignores them" are different sentences about different problems.
-- Folding the second into detectors_skipped would make a working system look
-- like a starved one.
alter table public.finding_runs
  add column if not exists detectors_dormant integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'finding_runs_detectors_dormant_ck'
  ) then
    alter table public.finding_runs
      add constraint finding_runs_detectors_dormant_ck check (detectors_dormant >= 0);
  end if;
end $$;

comment on column public.finding_runs.detectors_dormant is
  'Detectors this hotel has demoted all the way to rest. Counted separately from detectors_skipped: resting is a decision the hotel''s own behaviour made, not an absence of data.';

-- ── 5. agent_knowledge_questions.finding_id — one question surface ─────────
-- A finding the judge sorted as 'ask' is a QUESTION, and Staxis has exactly one
-- place it asks a manager a question. Rather than build a second question card
-- with its own idea of "at most one per session" and "never twice", a
-- finding-derived question is written into the SAME ledger and carries a
-- pointer to the finding an answer resolves.
--
-- ON DELETE SET NULL, not CASCADE: the record that a manager was asked
-- something outlives the finding that prompted it.
alter table public.agent_knowledge_questions
  add column if not exists finding_id uuid references public.findings(id) on delete set null;

create index if not exists agent_knowledge_questions_finding_idx
  on public.agent_knowledge_questions (finding_id)
  where finding_id is not null;

comment on column public.agent_knowledge_questions.finding_id is
  'The findings row this question came from, when it came from one. A yes marks that finding a known problem; a no resolves it. Null for the operational-signal questions that predate 0362.';

-- The category vocabulary gains one value. A finding-derived question is not a
-- maintenance/complaint/noise/inspection/cleaning signal — it came from a
-- detector, and saying so is more honest than picking the closest of five
-- labels that do not apply.
alter table public.agent_knowledge_questions
  drop constraint if exists agent_knowledge_questions_category_check;
alter table public.agent_knowledge_questions
  drop constraint if exists agent_knowledge_questions_category_ck;
alter table public.agent_knowledge_questions
  add constraint agent_knowledge_questions_category_ck check (category in (
    'maintenance','complaint','noise','inspection','cleaning','finding'
  ));

-- ── 6. knowledge_promotions.source_kind — say where it came from ───────────
-- The founder's queue already refuses to auto-promote anything (0353). What it
-- could not do was tell him that an item was written by a machine sweep rather
-- than lifted out of a conversation. Widening the vocabulary is cheaper and far
-- more honest than letting a sweep wear 'extraction' as a disguise.
alter table public.knowledge_promotions
  drop constraint if exists knowledge_promotions_source_kind_check;
alter table public.knowledge_promotions
  drop constraint if exists knowledge_promotions_source_kind_ck;
alter table public.knowledge_promotions
  add constraint knowledge_promotions_source_kind_ck check (source_kind in (
    'agent_memory','consolidation','eval','extraction','migration','human','findings_sweep'
  ));

-- ── 7. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.finding_detector_state enable row level security;
revoke all on public.finding_detector_state from public, anon, authenticated;
grant select, insert, update, delete on public.finding_detector_state to service_role;
drop policy if exists finding_detector_state_deny_all on public.finding_detector_state;
create policy finding_detector_state_deny_all on public.finding_detector_state
  for all to anon, authenticated using (false) with check (false);

alter table public.finding_sweep_runs enable row level security;
revoke all on public.finding_sweep_runs from public, anon, authenticated;
grant select, insert, update, delete on public.finding_sweep_runs to service_role;
drop policy if exists finding_sweep_runs_deny_all on public.finding_sweep_runs;
create policy finding_sweep_runs_deny_all on public.finding_sweep_runs
  for all to anon, authenticated using (false) with check (false);

-- ── 8. updated_at trigger (shared fn from 0202) ────────────────────────────
drop trigger if exists set_updated_at on public.finding_detector_state;
create trigger set_updated_at before update on public.finding_detector_state
  for each row execute function public._pms_set_updated_at();

-- ── 9. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0362',
  'The findings learning loop. findings.last_shown_on makes a show a per-day event so a refresh loop cannot demote a detector. finding_detector_state holds per-(hotel,detector) demotion — per-hotel by construction, with a baseline that stops one week of ignoring cascading a check from propose to dormant, and an append-only transition log. finding_sweep_runs is the weekly AI sweep''s liveness artifact, hypothesis ledger (including the irreproducible ones — the hallucination filter''s visible miss rate) and the property-agnostic signature index that decides whether a candidate is one hotel''s quirk or worth proposing to a family. finding_runs.detectors_dormant separates resting from starved. agent_knowledge_questions.finding_id routes a judged-ask finding through the ONE existing question surface instead of building a second. knowledge_promotions.source_kind gains findings_sweep so machine authorship is visible in the founder queue.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
