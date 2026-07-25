# Data Layer Invariants

This document is the canonical reference for every invariant the PMS / report
data layer depends on. When you change the data layer, consult this list. When
you add a new invariant, append it here AND add the constraint that enforces it.

## Why this exists

`src/lib/agent/INVARIANTS.md` did this for the AI layer after round 12 of
agent review found that the system encoded implicit invariants in code rather
than in the database. The data layer has the same problem with higher stakes:
every number the product shows and every number the AI states comes from these
tables. A silently-dropped report row is not a crash — it is a hotel making a
staffing decision on a number that is quietly wrong, and nobody finding out.

The report-ingestion pivot is why this doc exists NOW rather than later. The
pms_* schema is nearly empty (22 of 28 tables have no rows), which means the
constraints below cost one migration today and cost a backfill plus a data-loss
window once real report data is flowing.

## Doctrine

Before adding any table, column, or write path to the data layer:
1. List its invariants below.
2. Add the constraint that enforces each (CHECK, trigger, partial unique index,
   RPC precondition, or a lint rule in `scripts/audit-data-invariants.mjs`).
3. If the invariant truly cannot be enforced at the DB level, document **why**
   and add a test instead.

Code-level enforcement ("the function checks this before insert") counts as
**NOT ENFORCED** for the purpose of this doctrine. It WILL drift over time
across review rounds.

**This doc is machine-checked.** `scripts/audit-data-invariants.mjs` runs in
`npm run lint` (a CI gate) and fails the build when an `Enforced by:` line names
a constraint, trigger, index, or function that no migration defines. The doc
cannot claim an enforcement that does not exist. It was written after that check
caught a real drift in the agent doc (INV-16 named an index
`agent_prompts_active_per_role_uniq`; the real one is `..._uq`).

## Format

Each invariant has:
- **ID** (DINV-n)
- **Statement** of the invariant
- **Enforced by** (constraint/trigger/index/lint name, or "NOT ENFORCED" + why)
- **Assumed by** (file where code relies on it)
- **History** (the concrete failure it prevents)

## Invariants

### DINV-1: every per-hotel pms_* fact row carries a non-null property_id

Every `pms_*` fact row names the hotel it belongs to, and no read path returns
rows for a property the caller lacks access to. The only exceptions are
`pms_knowledge_files`, `pms_table_schemas`, `pms_writeback_recipes` — shared
across every hotel on a PMS family by design — and `pms_feed_catalog`, which is
global: it names the feed TYPES that exist and which table each lands in. The
per-hotel half of that (do we expect this feed, how often, is it late) is
`pms_feed_expectations`, which does carry `property_id`.

- **Enforced by:**
  - DB: `property_id uuid not null references public.properties(id)` on all 25
    tenant-scoped `pms_*` tables (verified present today; a single-column
    `primary key` counts, since PK implies NOT NULL).
  - LINT: `scripts/audit-data-invariants.mjs` fails a NEW `pms_*` table with no
    non-null `property_id` unless it is on the family-scoped allowlist. Plus the
    pre-existing `scripts/audit-rls-policy-coverage.mjs` and
    `scripts/audit-api-route-tenant-scope.mjs`, both already in `npm run lint`.
  - TEST: the hermetic tenant-scope eval
    (`tenant_scope_model_args_cannot_redirect_the_property`) proves a tool
    handler is handed the SERVER-side property even when the model names another
    hotel in its arguments, and a registry-derived test fails if any tool's
    input schema ever accepts a property argument at all.
- **KNOWN GAP — the per-handler `.eq('property_id', …)` filter is NOT covered by
  the hermetic bank.** Hermetic evals stub the tool handler, so a handler that
  dropped its property filter would still pass. That check needs a database
  (pglite or a live RLS test) and is the highest-value follow-up to this doc.
  Stating the gap is the point: a green hermetic suite must not be read as "no
  hotel can see another hotel's rows".
- **Assumed by:** every `src/lib/agent/tools/*` handler, `src/lib/db/*`
- **History:** the recurring RLS silent-empty-state bug class (three incidents
  in eight days, `RUNBOOKS.md`) is the same root cause seen from the other side —
  tenancy that lives in code rather than in the schema.

### DINV-2: dated facts store the hotel's LOCAL business date

Every dated fact stores the property's local business date as a `date` column,
derived from `properties.timezone` via `propertyLocalToday()` — never from
`now()::date`. A report emailed at 11pm Central lands on that day's business
date, not tomorrow's UTC date.

- **Enforced by:** **NOT DB-ENFORCED**, and here is why: a CHECK constraint
  cannot see the property's timezone from inside the row, and a trigger that
  did the lookup would silently rewrite a value the parser deliberately chose
  (a restatement of an older business date is legitimate). Backed instead by:
  - LINT: `scripts/audit-data-invariants.mjs` (type-shape gate — a `pms_*`
    column named `*_date` must be `date`, not `timestamptz`).
  - TEST: parser fixtures feeding a UTC-midnight-straddling timestamp and
    asserting the assigned business date equals the property-local date.
- **Assumed by:** `src/lib/schedule/local-date.ts` consumers,
  `src/lib/agent/context.ts` (`snapshot.today`)
- **History:** documented gap, stated with its reason rather than papered over.

### DINV-3: every pms_* fact row names the ingestion event that produced it

Given any number the product shows or the AI states, the exact report email,
parser version, and parse run behind it is one join away.

- **Enforced by:**
  - DB: `source_ingest_id uuid not null references <ingest table>(id)` on every
    `pms_*` fact table. **CURRENTLY ABSENT** — `pms_revenue_daily` has
    `last_synced_at` and a `raw` jsonb but no FK to any source row.
  - LINT: `scripts/audit-data-invariants.mjs` fails any `pms_*` fact table
    created in migration **0350 or later** that lacks the column.
- **KNOWN GAP — enforced going forward, not retroactively.** The FK target is
  the ingest table that the report-ingestion workstream owns and has not yet
  named; a column pointing at nothing is worse than a documented gap. Because 22
  of 28 `pms_*` tables are empty, adding it lands NOT NULL with no backfill when
  that table exists. **Trigger condition: the first report-ingestion migration.**
- **Assumed by:** every "where did this number come from" question the AI must
  answer honestly.
- **History:** written before the ingestion pipeline so lineage is a
  precondition of the first parser, not a retrofit after the first wrong number.
- **Carve-out — dictionaries are not facts.** `pms_dimension_values` (0356) is
  on `NON_FACT_PMS_TABLES`. It holds one row per distinct raw channel / room
  class / rate plan string a property has *ever* printed, accumulated across
  every report that mentioned it. No single ingestion event produced that row,
  so a lineage stamp would have to name one report arbitrarily — a receipt that
  points at the wrong thing is worse than an honest absence. `first_seen_at`,
  `last_seen_at` and `seen_count` carry what is actually knowable. The same
  reasoning covers `staff_aliases` (0356), which is not a `pms_*` table and so
  is out of the lint's scope anyway.

### DINV-4: a parsed report writes every row it parsed, or fails loudly

`rows_parsed = rows_written + rows_rejected`, always. A partial write is
impossible.

- **Enforced by:**
  - DB (PLANNED): CHECK constraint `pms_ingest_row_accounting` on the ingest table, plus
    the fact-table insert and the ingest-row update executing in ONE transaction.
    **The write RPC itself belongs to the ingestion workstream** — this doc owns
    the invariant and the constraint; that workstream owns the mechanism, or the
    two ship the same surface twice.
  - DOCTOR: an accounting check that fails when an ingest row's `rows_written`
    disagrees with `count(*)` of facts carrying that `source_ingest_id`.
  - TEST: every golden fixture set must include at least one REJECT case
    (truncated file, shifted column, empty body) whose expected output is
    `{ok: false, reason}`. A parser that returns partial rows on a malformed
    report fails the build.
- **KNOWN GAP — PLANNED, blocked on the ingest table existing.**
- **History:** the failure this prevents is the quiet one: a report format
  changes, the parser silently reads 40 of 100 rows, occupancy looks low, and
  the hotel under-staffs on a number nobody knows is partial.

### DINV-5: correcting a fact never destroys the prior value

A restated report SUPERSEDES; it does not overwrite. "What did we believe on the
3rd, before the correction on the 5th?" is always answerable.

- **Enforced by:**
  - DB: a BEFORE-UPDATE trigger on each `pms_*` fact table rejecting any UPDATE
    that changes a measure column (forcing supersede-by-insert), plus a partial
    unique index on `(property_id, business_date) WHERE superseded_at IS NULL`
    defining the single current row.
  - Precedent already in this repo: `inventory_audit_history` (migrations
    0326/0327) and the `agent_memory_active_topic_key` partial unique index
    (migration 0256).
- **KNOWN GAP — PLANNED, blocked on the ingestion write path.** Landing the
  trigger before the ingestion workstream is written against supersede semantics
  would fail at runtime rather than at build time. **The two workstreams must
  agree on the write path before either ships.**
- **History:** cost is a doubled row per correction — irrelevant at 42 MB.

### DINV-6: money is an integer count of cents

Every monetary quantity is an integer count of cents in a column whose name ends
in `_cents`. No floats, no dollars, no ambiguity.

- **Enforced by:** LINT — `scripts/audit-data-invariants.mjs` fails any
  migration adding a `numeric`/`double precision`/`real` column whose name reads
  like money without a `_cents` suffix. Two exemptions, both deliberate:
  - `*_usd` — sub-cent AI token telemetry (`agent_costs.cost_usd` is
    $0.0004-scale; integer cents is the WRONG unit there, so these are exempt by
    convention rather than parked in the legacy list forever).
  - `KNOWN_LEGACY_MONEY_COLUMNS` — the 14 pre-existing product-side dollar
    columns (inventory costing, equipment, daily logs). The list may SHRINK, and
    `src/lib/__tests__/data-invariants.test.ts` fails if it grows. The audit also
    fails on a STALE entry, so fixing a column forces removing its exemption.
- **Assumed by:** `pms_revenue_daily` (already entirely `*_cents bigint`)
- **History:** the pms_* layer is clean today. This rule exists so the
  report-ingestion pivot cannot re-import the debt the product side already has.

### DINV-7: no cohort aggregate below the minimum contributor count — PLANNED-NOT-ENFORCED

No cross-property or cohort aggregate is shown to a user or stated by the AI when
fewer than 5 properties contribute to it. Below the threshold the answer is
"not enough hotels yet", never a number.

- **Enforced by:** **PLANNED-NOT-ENFORCED.** There is exactly one customer, and
  no cross-property aggregate query surface exists anywhere in the codebase
  today. Building a SECURITY DEFINER threshold function now would be enforcement
  for a caller that does not exist, and the doctrine explicitly permits a
  documented gap.
- **Trigger condition — enforce BEFORE hotel #2's data becomes comparable.** The
  moment a second hotel's facts land, a two-hotel "average" makes the first
  hotel's numbers inferable by arithmetic. The enforcement, when it lands: the
  aggregate is computed only by a SECURITY DEFINER function that returns NULL
  below the threshold and takes NO N argument, so no caller can pass a smaller
  one, plus an eval where the agent is asked "how do we compare to other hotels"
  with a 2-property cohort and must answer with the honesty phrasing.
- **History:** written down rather than remembered — the failure mode is
  discovering it the week hotel #2 signs.

### DINV-8: a booking is one row for its whole life, and it never comes back from the dead

A reservation, its cancellation and its no-show are the same object in three
states, not three objects. Nothing can put the system in a position where the
arrivals list and the cancellation list disagree about the same guest.

- **Enforced by:**
  - DB (structural): `pms_no_shows` and `pms_cancellations` no longer exist —
    migration `0354_reservation_lifecycle_consolidation.sql` folded them onto
    `pms_reservations`. The pre-existing `UNIQUE (property_id,
    pms_reservation_id)` is now the only place a booking can live.
  - DB (coherence): CHECK constraints `pms_res_cancel_coherent`,
    `pms_res_noshow_coherent`, `pms_res_fee_requires_cancel`,
    `pms_res_date_order`, `pms_res_booked_before_arrival` (0354). A NULL status
    stays storable on purpose — "the PMS did not print one" is a real state; what
    is forbidden is the contradiction.
  - DB (reconciliation): BEFORE UPDATE trigger
    `staxis_pms_reservation_status_guard()` (0354). A reservation never moves
    from `cancelled` / `no_show` / `checked_out` back to `booked` / `checked_in`
    unless the incoming row carries a strictly later `status_changed_at`. Every
    other column still updates, so a newer report can still correct a guest name.
  - TEST: `src/lib/__tests__/pms-reshape-invariants.integration.test.ts` applies
    the real migrations to PGlite and tries each forbidden write.
- **Why the trigger is the load-bearing part.** Consolidation created a risk the
  three-table shape did not have: three report feeds now upsert the SAME row.
  0341's `pms_reject_stale_ingest` only compares runs of the same `report_kind`,
  so it cannot stop a late arrivals report from un-cancelling a booking a
  cancellations report already closed. Without this trigger the hotel prepares a
  room for someone who is not coming.
- **Related, not covered:** `nights_derived` is a GENERATED column
  (`departure_date - arrival_date`) deliberately NOT constrained to agree with
  the PMS-reported `num_nights`. A PMS that counts day-use stays differently
  would fail an entire upsert batch, and the writer sends one batch per report.
  Disagreement is a reporting signal, not a reason to reject the night's data.
- **History:** D3-SHAPE, re-derived 2026-07-25 against the post-housekeeping-
  rewrite codebase.

### DINV-9: a report can never overwrite what a member of staff did

What the PMS told us and what Staxis knows are two tables. Neither writer can
reach the other's columns.

- **Enforced by:**
  - DB (structural, report → app): the 29 Staxis-owned workflow columns are no
    longer on `pms_housekeeping_assignments`. Migration
    `0355_housekeeping_mirror_state_split.sql` moved them to `public.room_work`.
    A housekeeping report physically cannot address a column that is not on the
    table it writes.
  - DB (structural, app → report): `pms_housekeeping_assignments.ingest_run_id`
    is NOT NULL with no default (0341). Every row must name the report that
    produced it, and an app write has no report to name — so the app cannot
    write the mirror even by accident. This replaces the REVOKE + SECURITY
    DEFINER write-gate the original design proposed: same wall, already built,
    nothing extra to remember to route through.
  - TEST: `pms-reshape-invariants.integration.test.ts` starts a clean, lands a
    report over it, and asserts the ticked checklist survives.
- **Where both sides have an opinion, and who wins.** Exactly two columns, both
  decided in `mergeMirrorAndWork` (`src/lib/pms-rooms-server.ts`) and unit-tested
  in `src/lib/__tests__/pms-rooms-server.test.ts`:
  - *Assignment* — `room_work.assigned_staff_id` (a real person a human picked)
    beats `pms_housekeeping_assignments.housekeeper_name` (a string another
    system printed). Falls back to name matching when nobody has assigned it.
  - *Do-not-disturb* — `room_work.dnd_active` is NULLABLE. NULL means Staxis has
    no opinion and the report decides; `true`/`false` both mean a person told us,
    and a person beats a 30-minute-old file. An `OR` here would trap a room on
    DND forever after one stale report.
- **KNOWN GAP — `room_work` has no foreign key to `pms_rooms_inventory`.** "Every
  row of work belongs to a room this hotel has" is a true invariant the database
  could enforce, and deliberately does not. Inventory is written by the report
  ingest; `room_work` is written by a housekeeper standing in a doorway. A late,
  partial or differently-spelled report would turn a Start tap into a 500 mid
  shift. Production already carries one such orphan. A dangling row is a
  reporting nuisance; a broken button is someone's job. **Trigger condition:**
  revisit if orphans ever exceed a handful, and fix it by reconciling inventory,
  not by breaking the tap.
- **History:** D3-SHAPE, 2026-07-25. The premise was verified fresh rather than
  inherited: the app's own writes to `pms_housekeeping_assignments` were ALREADY
  failing the 0341 NOT NULL, which is the two-owners problem announcing itself.

### DINV-10: one name means one person, and the definition of "same name" lives in the database

- **Enforced by:**
  - DB: `UNIQUE (property_id, alias_norm)` on `staff_aliases`, where `alias_norm`
    is a GENERATED ALWAYS ... STORED column (migration
    `0356_canonical_dimensions.sql`). Two divergent TypeScript `normalizeName()`
    implementations already exist in this repo — `src/lib/pms-rooms-server.ts`
    strips diacritics, `src/lib/inventory-match.ts` strips punctuation — and they
    disagree. The database computing it once is the fix.
  - DB: composite FK `(staff_id, property_id) REFERENCES staff (id, property_id)`
    on `staff_aliases`, and `(assigned_staff_id, property_id)` on `room_work`.
    An alias or an assignment pointing at another hotel's staff member is not
    representable. `ON DELETE SET NULL` is column-scoped so removing a
    housekeeper unassigns her rooms without deleting the record that the work
    happened.
  - DB: `room_work_assigned_source_chk` — an assignment always says how it was
    decided (`manager` / `alias_exact` / `alias_first_name` / `pms_import`).
    Written as two AND-ed clauses, not the obvious OR of two branches: in the OR
    form the second branch evaluates to NULL when `assigned_source` is NULL, and
    a CHECK accepts NULL — the constraint would allow the exact row it exists to
    forbid.
- **Fills from real events only.** `staff_aliases` is written when a human links
  a name to a person (`recordStaffAlias`, source `manager`). Inferred matches are
  deliberately NOT recorded: a guess is not a receipt, and writing one launders
  it into a fact. An empty table behaves exactly like the code did before it
  existed, which is what makes it safe to ship ahead of the data.
- **Same shape for categories:** `pms_dimension_values` holds one row per
  distinct raw channel / room-class / rate-plan string, with `canonical_code`
  NULL until somebody says what it means. Readers use
  `coalesce(canonical_code, raw_value)`, so an unmapped value degrades to itself
  rather than vanishing from a report. See the DINV-3 carve-out for why it
  carries no lineage stamp.
- **History:** D3-SHAPE, 2026-07-25.

## Related

- AI-layer invariants: `src/lib/agent/INVARIANTS.md` (INV-1 … INV-27)
- Tenant-scope lint: `scripts/audit-rls-policy-coverage.mjs`,
  `scripts/audit-api-route-tenant-scope.mjs`
- This doc's own checker: `scripts/audit-data-invariants.mjs`
