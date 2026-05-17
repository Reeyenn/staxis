# Audit Remediation — Execution Summary

**Branch:** `claude/relaxed-nobel-01d65a` (ahead of `origin/main` by 7 commits)
**Generated:** 2026-05-17
**Plan:** [`_master-fix-plan.md`](./_master-fix-plan.md)

## TL;DR

Seven commits closing the residual findings from six previously-merged
audit branches. The bulk of the audit remediation was already landed on
`main` via the earlier audit-branch merges; this sweep targets the
specific items the verification pass identified as either un-wired, only
partially implemented, or staged but not in scope of the prior commit.

| Cluster | Commit | Audit ref | What changed |
|---|---|---|---|
| 1 | `08dc225` | concurrency #1 (HIGH) | Wire `staxis_remove_property_access` RPC into auth/team DELETE route |
| 5 | `dc333f8` | data-model residual | New migration 0149: COMMENT on agent_messages.tool_call_id / claude_usage_log.job_id / stripe_processed_events; update doctor's EXPECTED_MIGRATIONS_STATIC |
| 2 | `1535c4e` | cost-hotpaths #5 tail | Narrow `.select('*')` on staff / properties / cleaning_events; route through asRecordRows / asRecordRow |
| 3 | `e2e7f7b` | cost-hotpaths #2 | Bump 30s admin pollers to 60s in admin/agent + laundry/[id] |
| 4 | `f5be26e` + `2b857c6` | logging-PII S2 (P3) | Per-route Sentry `tracesSampler` in sentry-base.ts; wired into server + edge configs; type-aligned to `TracesSamplerSamplingContext` |
| 6 | `7922507` | env-vars cleanup | Rewrite stale "legacy fallback still accepted" comments in three example files |

**Verification (final state):**
- `npx tsc --noEmit`: clean (no errors, no `--skipLibCheck` needed after `npm install` brought worktree deps in sync with `package.json`).
- `npm run lint`: clean (eslint + scripts/check-env-access.mjs).
- `npm run test`: **721 / 721 pass** (10 new cases for `shouldSampleTransaction`).
- `npm run build`: clean — 54 / 54 static pages, all API routes compile.

## What was already done (verified, no action)

Three parallel verification agents read each finding against the current
working tree and reported state. The bulk of the work was already on
`main` before this sweep started:

- **Concurrency** — 16/17 closed by migration 0139 + prior code merges.
  Spot-checked: `staxis_release_join_code_slot` RPC wired in
  `auth/use-join-code/route.ts`, `staxis_record_ml_failure` wired in
  `ml-failure-counters.ts`, `processed_twilio_webhooks` /
  `processed_sentry_webhooks` dedup tables present + used, Resend
  Idempotency-Key header set in `email/resend.ts`, cross-tab `storage`
  listeners in `LanguageContext` + `PropertyContext`, in-flight Map dedup
  in `property-config.ts` + `agent/context.ts`. The one un-wired item
  (#1, the property-access race) is Cluster 1 below.
- **Type-safety** — H1–M8 closed per the audit's own status section.
  Spot-checked: `src/types/database.types.ts` (5,369 LOC), runtime
  narrowers `parseStringField` / `parseUnionField` / `parseArrayField` /
  `parseRecordField`, agent tool helpers using `parseRoomRow` /
  `parseStaffRow` predicates, `IdempotencyRow` interface with single cast,
  `LogFields` accepting `unknown` via index signature.
- **Env-vars** — all major findings closed via the canonical `env.ts` /
  `env-client.ts` / `cua-service/src/env.ts` / `scraper/env.js` modules
  plus the CI guard at `scripts/check-env-access.mjs`. Verified: zero
  `process.env.X` reads outside the env modules in the source tree.
  Residual: stale doc comments (Cluster 6 below).
- **External-API** — all 8 findings closed via
  `src/lib/external-service-config.ts` + `externalFetch` centralization
  (`ANTHROPIC_WALKTHROUGH_TIMEOUT_MS`, `STRIPE_MAX_NETWORK_RETRIES`,
  etc.) plus auth-rollback `log.error` + `captureException` paths.
  Nothing residual.
- **Logging-PII** — H1, H2, H3, M1–M5, F1, F2, L1 all closed. H3 fix
  went further than the audit asked by extracting
  `getBaseSentryOptions()` into a shared module. S2 (per-route
  `tracesSampler`) was tagged P3 — done in Cluster 4 below.
- **Cost-hotpaths** — 7/15 fixes already landed (`d798ffe`, `fe7a910`,
  `f5d3412`, `9ed1df1`, `d1145d4`, `ec17ed3`, `1d713c4`). #2 + #5 tail
  done in this sweep; the rest are deferred for legitimate reasons (see
  §"NOT in scope" below).
- **Data-model** — migration `0141_drop_dead_schema.sql` drops 8 dead
  tables + dead FK columns; `0142_enforce_missing_fks.sql` enforces 6
  FKs + documents 3 polymorphic columns. The audit's residual flag on
  `prediction_log.inventory_count_id` was a verification false positive
  (the FK was already added in `0062_inventory_ml_foundation.sql` line
  106-107). The remaining undocumented columns are addressed in
  Cluster 5 below.

## Per-cluster details

### Cluster 1 — `08dc225` — fix(concurrency): wire staxis_remove_property_access RPC

**Audit:** [concurrency-audit.md](./concurrency-audit.md) finding #1 (HIGH, auth-bypass class).

**Problem.** Migration 0139 authored two atomic RPCs to close the
property-access race, but the route handler at
`src/app/api/auth/team/route.ts` never made the call. The DELETE branch
was still doing `SELECT property_access → array.filter → UPDATE`, which
is exactly the read-modify-write the audit identified — two managers
removing the same user from different hotels could each compute a stale
`next` array and clobber each other, silently re-granting a hotel one of
them just removed.

**Fix.** Replace the three round-trips with the existing RPC. The
`array_remove` inside the UPDATE is atomic, the RETURNING clause gives
us the remaining count for the audit log, and the contract return value
(-1 vs >=0) preserves the 404 vs idempotent-success branch.

**Files touched.**
- `src/app/api/auth/team/route.ts` (DELETE handler, lines ~287–333)

### Cluster 5 — `dc333f8` — fix(data-model): document polymorphic + external ID columns

**Audit:** [data-model-map.md](./data-model-map.md) residual.

**Problem.** Migration `0142_enforce_missing_fks.sql` enforced 8 FKs and
documented 3 polymorphic columns. A follow-up verification pass flagged
three more `<entity>_id` columns that look like FKs but cannot be
enforced as such:

- `agent_messages.tool_call_id` — text, an external
  Anthropic / OpenAI tool-call ID.
- `claude_usage_log.job_id` — polymorphic between `onboarding_jobs.id`
  and `pull_jobs.id` depending on workload.
- `stripe_processed_events` — write-only by design (Stripe webhook
  idempotency insert-then-check ledger).

**Fix.** New migration `0149_document_polymorphic_and_external_ids.sql`
adds `COMMENT ON COLUMN` / `COMMENT ON TABLE` for each, so the next
data-model audit doesn't re-flag them and so the rationale is
discoverable from `\d+` in psql. Pure DDL metadata — no data movement.

Also bumps the doctor's `EXPECTED_MIGRATIONS_STATIC` fallback list to
include 0143–0149. The on-disk discover path was already picking these
up at runtime, but the static fallback was stale for any environment
without filesystem access (Vercel Edge).

**Files touched.**
- `supabase/migrations/0149_document_polymorphic_and_external_ids.sql` (new)
- `src/app/api/admin/doctor/route.ts` (`EXPECTED_MIGRATIONS_STATIC`)

**Per project convention:** the migration file is committed but NOT
applied to prod. Manual apply will follow the existing process. The
doctor's `applied_migrations` check will flag 0149 as pending after the
deploy, which is the intended signal to apply it.

### Cluster 2 — `1535c4e` — perf(db): narrow .select('*') on hot tables

**Audit:** [cost-hotpaths-audit.md](./cost-hotpaths-audit.md) recommendation #5/#13 (tail).

**Problem.** The rooms helper was narrowed in commit `ec17ed3` but
`staff`, `properties`, and `cleaning_events` still issued `.select('*')`.
Wide selects pull every column on every fetch — including ML feature
columns the UI never reads (cleaning_events has ~10 such columns from
migration 0021) — multiplied across realtime refetches.

**Fix.** Same root-cause pattern as the rooms fix: declare a column
constant in lock-step with `fromXxxRow()`, use it everywhere the table
is read. New constants:

- `STAFF_COLS` (17 columns) in `src/lib/db/staff.ts`
- `PROPERTY_COLS` (22 columns) in `src/lib/db/properties.ts`
- `CLEANING_EVENT_COLS` (16 columns) in `src/lib/db/cleaning-events.ts`

Each call site routes the result through the existing `asRecordRows` /
`asRecordRow` helpers in `src/lib/db/_common.ts` to satisfy the
supabase-js typing (a runtime-concatenated select string narrows the
return to `GenericStringError[]`, a known SDK quirk).

**Files touched.**
- `src/lib/db/staff.ts`
- `src/lib/db/properties.ts`
- `src/lib/db/cleaning-events.ts`
- `src/lib/db/housekeeper-helpers.ts` (uses `STAFF_COLS` from staff.ts)

### Cluster 3 — `e2e7f7b` — perf(admin): bump 30s admin pollers to 60s

**Audit:** [cost-hotpaths-audit.md](./cost-hotpaths-audit.md) recommendation #2.

**Problem.** Two admin pollers were still at 30s when the audit
recommends 60s (HealthBanner already moved). Each open admin tab issues
2× as many requests as needed.

**Fix.** Bump interval to 60s with a comment explaining the cadence
matches HealthBanner.

**Files touched.**
- `src/app/admin/agent/page.tsx` (fetchMetrics interval)
- `src/app/laundry/[id]/page.tsx` (loadBootstrap interval)

### Cluster 4 — `f5be26e` + `2b857c6` — fix(observability): per-route Sentry tracesSampler

**Audit:** [logging-pii-audit.md](./logging-pii-audit.md) finding S2 (tagged P3).

**Problem.** A global `tracesSampleRate: 0.1` lets one high-QPS endpoint
(`/api/events`, `/api/sms-reply`) burn through the monthly Sentry quota
and starve the rare-but-interesting routes (admin doctor, agent
commands) we actually want traced.

**Fix.** `shouldSampleTransaction(ctx)` in `src/lib/sentry-base.ts`:

- 0.0 for healthchecks
- 0.01 for `/api/events` and `/api/sms-reply` (high-QPS)
- 0.05 for `/api/cron/*`, `/api/agent/voice-brain`, and
  `/api/agent/nudges/check` (predictable fan-out, low diagnostic value)
- Otherwise `inheritOrSampleWith(0.1)` so distributed traces stay coherent

Wired into both `sentry.server.config.ts` and `sentry.edge.config.ts`
via the shared module — same root-cause discipline that fixed H3 (no
config drift between runtimes).

The first cut compiled in isolation but mismatched Sentry's actual SDK
signature (`TracesSamplerSamplingContext` is flat, not nested). The
follow-up `2b857c6` re-shaped the sampler to match Sentry's typing
exactly and added inheritance semantics.

**Files touched.**
- `src/lib/sentry-base.ts`
- `sentry.server.config.ts`
- `sentry.edge.config.ts`
- `src/lib/__tests__/sentry-base.test.ts` (+10 cases pinning the policy)

### Cluster 6 — `7922507` — docs(env): drop stale 'legacy fallback' comments

**Audit:** [env-vars-audit.md](./env-vars-audit.md) residual.

**Problem.** Commit `c0f5df2` dropped the legacy fallback names from the
Zod schemas in `src/lib/env.ts`, `scraper/env.js`, and
`cua-service/src/env.ts`. Three comment blocks in the example files
still advertised the old "STILL ACCEPTED during the migration window"
wording, which would mislead a contributor into setting
`TWILIO_PHONE_NUMBER` / `MANAGER_PHONE` / `SUPABASE_URL` and finding
their env unexpectedly missing at boot.

**Fix.** Rewrite each comment block to point at the canonical names and
note that the doctor still recognises legacy names so it can surface
"hey, the env you set isn't being read" rather than silent disablement.

**Files touched.**
- `.env.local.example` (lines 8-13)
- `scraper/.env.example` (lines 5-7)
- `cua-service/src/env.ts` (header comment)

## NOT in scope — intentionally deferred / out of bug class

Items from the seven audits that were considered and explicitly NOT
addressed in this sweep, with reasoning.

### Cost-hotpaths

- **#3 (housekeeper public poll 4s → 6-8s).** The team commented at the
  code site defending the 4s value as deliberate and added
  `subscribeTable` debouncing + local payload reducers (`d1145d4`) as
  the root-cause fix for refetch amplification. The 4s remains
  intentional.
- **#6 (lift hotel-snapshot cache to KV / Vercel Data Cache).**
  Infrastructure choice — code-side fix is correct; cross-instance
  dedup needs ops decision on cache infra. Documented as a 60s
  eventual-consistency SLA in the source comment.
- **#7 (Haiku model routing for simple commands).** Blocked on the
  eval-harness work the audit comment calls out; `pickModel()` still
  hard-returns `'sonnet'`. Largest deferred cost win in the codebase
  but not actionable until evals are written.
- **#10 (hoist `buildHotelSnapshot` outside SSE stream).** The team
  explicitly chose the opposite — inline comments at the call site
  (`voice-brain/chat/completions/route.ts:294-300, 319`) document the
  first-byte trade-off. This audit recommendation is effectively
  rejected on its merits.
- **#13, #14 (CUA browser-context cache, PG NOTIFY claim loop).**
  Backend optimizations that are not bug-class issues. Schedule as
  capacity / cost work, not as audit follow-up.

### Type-safety

- **Database<T> generic on supabase admin client.** Explicitly deferred
  by the audit author — exposes ~266 additional drift/typing issues
  worth a dedicated PR.
- **M6 mechanical sweep of remaining client `.json()` consumers.**
  Pattern established with `WalkthroughOverlay`; remainder is
  mechanical and explicitly punted by the audit author to a follow-up.

### Logging-PII

- **Recommendation 10 (ESLint rule flagging `console.*` with PII-
  shaped identifiers).** Recommendation, not a finding — skipped to
  keep scope tight. Worth picking up as a separate hygiene PR.

### Data-model

- **`ml_feature_flags`** flagged as "read-only" by the static audit but
  the Python ml-service (`ml-service/src/optimizer/monte_carlo.py:213`)
  reads it at runtime. False positive — no action needed.
- **`voice-recordings` storage bucket cleanup.** Manual Supabase UI
  task per the audit, not a code change.

## Issues discovered during execution (not in original audits)

1. **Worktree `node_modules` out of sync with `package.json`.** The
   worktree shared `node_modules` with the parent project, which had
   `eslint-config-next@15.2.4` while this worktree's `package.json`
   declares `^16.2.6`. `npm run lint` failed with
   "nextCoreWebVitalsConfig is not iterable" until a fresh `npm install`
   in the worktree resolved it. The type-safety audit had documented
   this as pre-existing.

   Action taken: ran `npm install` in the worktree to resolve. Not
   committed (node_modules is gitignored). Other worktrees opened in
   this state will need the same fix; flagging as a setup-doc
   improvement but not blocking.

2. **`fromCleaningEventRow` declared as a private function (not
   exported).** The cost-hotpaths fix exposes `CLEANING_EVENT_COLS` at
   module level but `fromCleaningEventRow` itself stays file-private —
   in line with the existing pattern. If a future caller outside
   `cleaning-events.ts` wants to map a row, it should call the existing
   public helpers (`getCleaningEventByPair`, `getCleaningEventsForRange`)
   rather than re-derive the column list.

3. **`prediction_log.inventory_count_id` already had a FK** added in
   migration `0062_inventory_ml_foundation.sql` line 106-107. The
   data-model verification agent's grep didn't catch the inline
   `references inventory_counts(id) on delete set null` clause. Cluster
   5 was scoped down accordingly — no new FK migration was needed for
   this column.

## Verification snapshot

```
$ npm run test
ℹ tests 721
ℹ pass 721
ℹ fail 0
ℹ duration_ms 4410

$ npx tsc --noEmit
(clean — no errors)

$ npm run lint
✓ check-env-access: scanned src, cua-service/src, scraper, no direct process.env reads outside canonical env modules.

$ npm run build
✓ Compiled successfully in 5.3s
✓ Generating static pages (54/54) in 249ms
```

## Commit list (this sweep)

```
2b857c6 fix(observability): align tracesSampler with Sentry TracesSamplerSamplingContext
7922507 docs(env): drop stale 'legacy fallback still accepted' comments
f5be26e fix(observability): per-route Sentry tracesSampler
e2e7f7b perf(admin): bump 30s admin pollers to 60s
1535c4e perf(db): narrow .select('*') on staff/properties/cleaning_events
dc333f8 fix(data-model): document polymorphic and external ID columns
08dc225 fix(concurrency): wire staxis_remove_property_access RPC into team DELETE
```

Master fix plan: [`_master-fix-plan.md`](./_master-fix-plan.md).
