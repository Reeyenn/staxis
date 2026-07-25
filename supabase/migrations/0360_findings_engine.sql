-- ═══════════════════════════════════════════════════════════════════════════
-- 0360 — The findings ledger: one problem, one row, for as long as it is true.
--
-- WHAT THIS IS
-- Staxis already detects things in three separate places (the cleaning rules
-- engine, the nudge checks, the operational-signal aggregators). Each one
-- invented its own idea of "have I already said this?", and none of them can
-- answer "what does this hotel currently have wrong?". This table is that
-- answer: a durable, per-hotel ledger of PROBLEMS, written by one nightly
-- runner, deduped by the database rather than by the politeness of whichever
-- detector happened to run.
--
-- THE SILENCER IS THE SCHEMA, NOT A FEATURE
-- A detector that finds the same problem tonight that it found last night must
-- UPDATE the existing row ("now 5 work orders"), never stack a second card. The
-- partial unique index below is that guarantee. Code can forget; a unique index
-- cannot. Statuses:
--
--   open           first sighting, nobody has responded
--   updated        still open, and the evidence moved since the manager last
--                  saw it (this is what "now 5 work orders" looks like)
--   known_problem  the manager armed the silencer: never surface again EXCEPT
--                  on escalation (4 known work orders must not silence 9)
--   muted          gone, unconditionally, no escalation
--   resolved       dealt with; a recurrence is a genuinely NEW row, because a
--                  problem that comes back after a fix is new information
--   expired        the detector stopped finding it and the grace window lapsed
--
-- open / updated / known_problem / muted are ACTIVE — at most one per problem
-- per hotel, enforced below. resolved / expired are ARCHIVE — many allowed, so
-- a recurrence can open a fresh row and the history stays intact.
--
-- WHY NOT agent_pending_actions (the "extend before you add" justification)
-- That table is the copilot's frozen-args proposal queue: conversation_id and
-- account_id are both NOT NULL with ON DELETE CASCADE, and rows carry a
-- ~10-minute TTL. A proactive finding has no conversation and no author, must
-- outlive both the chat and the manager's account, and must persist for weeks.
-- Putting findings there would mean every finding died when a conversation was
-- archived. (INV-25 records the same lesson for the copilot's own proposals.)
-- Nothing else fits either: agent_nudges is a per-USER notification inbox whose
-- dedupe index only covers status='pending'; agent_memory holds FACTS, and an
-- open problem is not a fact; agent_knowledge_questions records what we ASKED,
-- not what is wrong; cleaning_tasks is one department's work list.
--
-- PRICE IS ALWAYS A RANGE (founder call, 2026-07-26)
-- "$200–400", never "$340". A point estimate is a lie told confidently, and a
-- manager who catches one stops believing the other numbers. The CHECK below
-- refuses a degenerate range (high must be strictly greater than low), so the
-- schema itself cannot store a disguised point estimate. No basis in the
-- hotel's own numbers ⇒ leave both NULL and say nothing about money.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY, mirroring agent_memory (0256) and
-- agent_knowledge_questions (0359): anon + authenticated deny-all. Everything
-- reaches this through server code that scopes by property_id.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md). The
-- table is inert until a later phase renders it, so deploy order is safe either
-- way. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. findings ────────────────────────────────────────────────────────────
-- @rls: service-role-only — written by the nightly findings runner and read by
-- server code that already knows which hotel it is acting for. No anon path,
-- no browser path.
create table if not exists public.findings (
  id                      uuid primary key default gen_random_uuid(),

  -- Tenancy. Cascades: offboarding a hotel removes what we found there.
  property_id             uuid not null references public.properties(id) on delete cascade,

  -- Which registered detector produced this. Stable slug, matches
  -- DetectorDeclaration.id in src/lib/findings/registry.ts.
  detector_id             text not null check (char_length(detector_id) between 1 and 64),

  -- THE identity of the problem, independent of its size. Always prefixed with
  -- detector_id, so two detectors can never collide. The count lives in
  -- `magnitude` and in the evidence, NEVER in this key — otherwise "4 work
  -- orders" and "5 work orders" would be two different problems and the ledger
  -- would grow a new card every night, which is the exact failure this table
  -- exists to prevent.
  dedupe_key              text not null check (char_length(dedupe_key) between 1 and 200),

  -- A deterministic, template-generated sentence. Phrasing by a model comes in
  -- a later phase and overwrites nothing: this column is what the row means
  -- with no model in the loop at all.
  summary                 text not null check (char_length(summary) between 1 and 500),

  severity                text not null check (severity in ('critical','attention','info')),

  -- What the system proposes doing about it. The detector declares a default;
  -- a later judging phase may re-sort it. 'drop' means "judged not worth
  -- surfacing" — kept rather than deleted so the decision is auditable.
  disposition             text not null default 'fyi'
                            check (disposition in ('propose','recommend','fyi','ask','drop')),

  status                  text not null default 'open' check (status in (
                            'open','updated','resolved','known_problem','muted','expired'
                          )),

  -- ── the receipt ──────────────────────────────────────────────────────────
  -- Which query a human (or a later verification pass) can re-run to check the
  -- claim, and the arguments it was run with. A finding that cannot be
  -- reproduced is a rumour.
  receipt_query_id        text not null check (char_length(receipt_query_id) between 1 and 120),
  -- { params, values, basis, window_days, … } — the numbers behind `summary`.
  evidence                jsonb not null default '{}'::jsonb,
  -- When the underlying DATA was true, which is not when we looked at it.
  as_of                   timestamptz,
  -- Age of the OLDEST input this claim rests on. A conclusion drawn from a
  -- nine-day-old towel count is a question, not an instruction, and this column
  -- is what lets a later phase know the difference.
  weakest_input_age_days  numeric check (weakest_input_age_days is null or weakest_input_age_days >= 0),

  -- The one number that says how BIG the problem is (work-order count, minutes
  -- over, rooms affected). Escalation compares against this, so it must be
  -- monotonic in "worse" — bigger always means worse.
  magnitude               numeric not null default 0,

  -- ── the price tag: a RANGE or nothing ────────────────────────────────────
  price_low_cents         integer,
  price_high_cents        integer,
  price_currency          text not null default 'USD' check (char_length(price_currency) = 3),
  -- "based on your last 3 plumber invoices" — where the range came from.
  price_basis             text check (price_basis is null or char_length(price_basis) between 1 and 300),

  -- ── lifecycle ────────────────────────────────────────────────────────────
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  occurrence_count        integer not null default 1 check (occurrence_count >= 1),

  status_changed_at       timestamptz not null default now(),
  -- SET NULL: the record that someone silenced this outlives their account.
  status_changed_by       uuid references public.accounts(id) on delete set null,
  resolved_at             timestamptz,

  -- The magnitude at the moment the manager tapped "known problem". Escalation
  -- is measured against THIS, not against the first sighting: arming the
  -- silencer at 4 is consent to 4, not consent to 9.
  silenced_at_magnitude   numeric,
  escalated_at            timestamptz,

  -- ── self-demotion scaffold (later phase) ─────────────────────────────────
  -- Per-FINDING counters; per-DETECTOR demotion aggregates them by detector_id.
  -- A detector whose findings are shown a lot and acted on never has earned its
  -- way down from propose → fyi → off. Written by the UI phase, not by Phase 1.
  shown_count             integer not null default 0 check (shown_count >= 0),
  acted_count             integer not null default 0 check (acted_count >= 0),
  ignored_count           integer not null default 0 check (ignored_count >= 0),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- A price tag is a RANGE or it is absent. Never a point estimate wearing a
  -- range's clothes (low = high), never inverted, never negative.
  constraint findings_price_is_a_range check (
    (price_low_cents is null and price_high_cents is null)
    or (
      price_low_cents is not null and price_high_cents is not null
      and price_low_cents >= 0
      and price_high_cents > price_low_cents
    )
  ),

  -- Time only moves forward.
  constraint findings_seen_window_ordered check (last_seen_at >= first_seen_at)
);

-- ═══ THE SILENCER, IN THE DATABASE ═══
-- At most ONE active row per (hotel, problem). A second nightly run that finds
-- the same problem CANNOT insert — it gets a unique violation and must update
-- the row that already exists. That is the whole "one problem = one card"
-- guarantee, and it holds even when two runners race.
--
-- 'muted' and 'known_problem' are inside the index on purpose: a silenced
-- problem must block a fresh open row, or the silencer would be defeated by
-- simply inserting again tomorrow. 'resolved' and 'expired' are outside it on
-- purpose: a problem that comes back after being fixed is new information and
-- deserves its own row and its own first_seen_at.
create unique index if not exists findings_one_active_per_problem_uq
  on public.findings (property_id, dedupe_key)
  where status in ('open','updated','known_problem','muted');

-- The queue read: "what is wrong at this hotel right now, worst first".
create index if not exists findings_property_status_idx
  on public.findings (property_id, status, severity, last_seen_at desc);

-- The demotion read: per-detector shown/acted/ignored aggregates.
create index if not exists findings_property_detector_idx
  on public.findings (property_id, detector_id, status);

comment on table public.findings is
  'One row per (hotel, problem) for as long as the problem exists. Written by the nightly findings runner; deduped by findings_one_active_per_problem_uq so a re-find UPDATES the open row instead of stacking a duplicate. known_problem/muted are silenced states that still occupy the slot (so a silenced problem cannot be re-inserted); resolved/expired are archival, so a recurrence opens a genuinely new row. Service-role-only. Added 0360.';

comment on column public.findings.dedupe_key is
  'Stable identity of the PROBLEM, detector-prefixed, never containing the measurement. "4 work orders" and "9 work orders" on room 214 are the same problem and therefore the same key.';

comment on column public.findings.magnitude is
  'How big the problem is, on a scale where bigger is always worse. Escalation out of known_problem compares this against silenced_at_magnitude.';

comment on column public.findings.silenced_at_magnitude is
  'The magnitude the manager consented to when they tapped "known problem". Escalation is measured from here, so arming the silencer at 4 does not silence 9.';

comment on column public.findings.evidence is
  'The receipt: the query parameters, the values behind the summary, and the basis text. A finding that cannot be reproduced from this is a rumour.';

comment on column public.findings.price_low_cents is
  'Low end of a RANGE, in cents. Both price bounds are null or both are set, and high is strictly greater than low — the schema refuses a point estimate (founder call 2026-07-26: "$200-400", never "$340").';

comment on column public.findings.weakest_input_age_days is
  'Age in days of the OLDEST input this claim rests on. A conclusion drawn from stale data is a question, not an instruction.';

-- ── 2. finding_runs — the null-result artifact ─────────────────────────────
-- @rls: service-role-only.
--
-- "Checked 34 things, 33 normal" is a load-bearing sentence: a silent system
-- and a broken one are otherwise indistinguishable, and the findings table by
-- definition holds nothing on a quiet night. This row is the proof the runner
-- ran at all. It is NOT cron_heartbeats: that is one global row per cron, over-
-- written every tick, with no idea which hotels were covered or what was
-- skipped for want of data.
create table if not exists public.finding_runs (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references public.properties(id) on delete cascade,

  run_at                  timestamptz not null default now(),
  -- The hotel's own business date. "Did we check this hotel today?" is a
  -- calendar question and the hotel's calendar is the one that counts.
  run_date                date not null,

  detectors_registered    integer not null default 0 check (detectors_registered >= 0),
  detectors_checked       integer not null default 0 check (detectors_checked >= 0),
  -- Ran nowhere near enough data to say anything. Distinct from "checked and
  -- found nothing" — silence for want of data is not a clean bill of health.
  detectors_skipped       integer not null default 0 check (detectors_skipped >= 0),
  detectors_failed        integer not null default 0 check (detectors_failed >= 0),

  findings_opened         integer not null default 0 check (findings_opened >= 0),
  findings_updated        integer not null default 0 check (findings_updated >= 0),
  findings_suppressed     integer not null default 0 check (findings_suppressed >= 0),
  findings_escalated      integer not null default 0 check (findings_escalated >= 0),
  findings_expired        integer not null default 0 check (findings_expired >= 0),

  duration_ms             integer check (duration_ms is null or duration_ms >= 0),
  -- [{ detector_id, error }] — a detector that threw is recorded, never hidden.
  errors                  jsonb not null default '[]'::jsonb,

  created_at              timestamptz not null default now()
);

create index if not exists finding_runs_property_run_at_idx
  on public.finding_runs (property_id, run_at desc);

comment on table public.finding_runs is
  'One row per hotel per findings-runner execution: how many detectors were registered, checked, skipped for insufficient data, and failed, and what the run did to the ledger. The liveness artifact — it is how "we checked and everything is normal" is told apart from "the runner has been dead for a week". Service-role-only. Added 0360.';

comment on column public.finding_runs.detectors_skipped is
  'Detectors that did not run because their declared minimum data was not present. Silence for want of data is not a clean bill of health, so it is counted separately from a detector that ran and found nothing.';

-- ── 3. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.findings enable row level security;
revoke all on public.findings from public, anon, authenticated;
grant select, insert, update, delete on public.findings to service_role;
drop policy if exists findings_deny_all on public.findings;
create policy findings_deny_all on public.findings
  for all to anon, authenticated using (false) with check (false);

alter table public.finding_runs enable row level security;
revoke all on public.finding_runs from public, anon, authenticated;
grant select, insert, update, delete on public.finding_runs to service_role;
drop policy if exists finding_runs_deny_all on public.finding_runs;
create policy finding_runs_deny_all on public.finding_runs
  for all to anon, authenticated using (false) with check (false);

-- ── 4. updated_at trigger (shared fn from 0202) ────────────────────────────
drop trigger if exists set_updated_at on public.findings;
create trigger set_updated_at before update on public.findings
  for each row execute function public._pms_set_updated_at();

-- ── 5. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0360',
  'findings + finding_runs: the unified findings ledger. findings_one_active_per_problem_uq is the database-level "one problem = one row" guarantee (a re-find must UPDATE, never duplicate) and it covers the silenced states so known_problem/muted cannot be defeated by re-inserting; resolved/expired sit outside it so a recurrence opens a new row. findings_price_is_a_range refuses a point estimate. finding_runs is the per-hotel null-result liveness artifact. Both service-role-only (deny-all anon+authenticated).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
