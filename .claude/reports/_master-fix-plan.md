# Master Fix Plan — Audit Remediation Sweep (2026-05-17)

## Scope inventory

This worktree's `.claude/reports/` contains 7 audit reports (not 14 as the
brief described; the missing audits — dead-code, dependencies, error-handling,
database, test-coverage, authorization, request-tracing — were either folded
into the present 7 or already resolved on `main` via earlier audit-branch
merges; the relevant commits are catalogued in section 2).

| # | Report | State on `main` |
|---|---|---|
| 1 | `concurrency-audit.md` | 16/17 resolved by migration 0139 + code merges. **Finding #1 NOT WIRED** at the route layer — RPC exists, route still uses read-modify-write. |
| 2 | `cost-hotpaths-audit.md` | 7/15 root-cause fixes landed. 6 deferred (Haiku routing, shared-cache lift, CUA NOTIFY, browser context cache, hoist-snapshot reversed, public poll). 2 unresolved (admin pollers, narrow remaining wide selects). |
| 3 | `data-model-map.md` | Migrations 0141 + 0142 land dead-schema drop + 6 FK enforcements. 1 missing FK left (prediction_log.inventory_count_id) + 3 polymorphic/external IDs need COMMENT documentation. |
| 4 | `env-vars-audit.md` | All major findings closed (canonical `env.ts` modules, CI guard, example rewrite). 3 stale comments remain. |
| 5 | `external-api-audit.md` | All 8 findings resolved via `external-service-config.ts` + `externalFetch` centralization + auth-rollback logging. |
| 6 | `logging-pii-audit.md` | 12/13 resolved (H1, H2, H3, M1–M5, F1, F2, L1). S2 (per-route `tracesSampler`) was tagged P3 and remains open. |
| 7 | `type-safety-audit.md` | H1–M8 all resolved per the report's own status section. Two deferrals (Database type wiring; M6 mechanical sweep) were explicitly punted to follow-ups and remain out of scope per the audit author. |

## 2. Prior remediation already on `main`

Earlier audit-branch merges have landed the bulk of remediation. Selected:

```
3a0b65b audit: fix all 17 concurrency findings           (#38, merged main)
725e206 Merge audit/type-safety                            (#39, merged main)
8f5b000 Merge audit/env-vars                              (#41, merged main)
164d22e Merge audit/external-api-calls                    (#42, merged main)
3db035a audit: act on data-model findings
b8dd434 fix(observability): root-cause fixes from logging & PII audit
102ae6a audit: cost and hot paths
+ multiple perf/* commits implementing cost-hotpaths recs (d798ffe, fe7a910, f5d3412, 9ed1df1, d1145d4, ec17ed3, 1d713c4)
19c8d3b fix(audit): close 17 remaining findings from request-tracing audit (#43)
6e0109c fix(audit): close final 3 deferred audit findings (#44)
04923a3 fix(p0): encrypt PMS credentials end-to-end (audit Flow 2 #1) (#37)
bd84225 fix(error-handling): finish audit long tail
b5c0aa4 fix(db): close audit-deferred items
43eeb8b fix(db): close P0-P3 findings from DB-access audit
a7a1f27 fix(auth): close two medium-severity findings
68ef072 fix(error-handling): audit phases 1-5
```

Verification was conducted by three parallel agents that read each finding's
current state on this worktree (which is `origin/main` HEAD `371584e`). The
clusters below are the residual.

## 3. Root-cause clusters to execute

Ordered by (a) dependency, (b) risk, (c) blast radius. Each cluster has a
single canonical fix that resolves every instance of the class.

### Cluster 1 — Concurrency #1: property-access race not wired

**Class of bug:** Concurrent removals from different hotels on the same
account read the same `property_access` array, each computes a local diff,
and the second write clobbers the first — silently re-granting a hotel a
manager had just removed. The atomic-SQL fix RPC was authored in migration
0139 but the route handler was never updated to call it.

**One change to fix every instance:** Wire `staxis_remove_property_access`
RPC into [src/app/api/auth/team/route.ts:267-333](src/app/api/auth/team/route.ts:267).
Audit [concurrency #1](.claude/reports/concurrency-audit.md).

This is the highest-blast-radius open item (auth bypass / re-grant), so it
goes first.

### Cluster 2 — Cost-hotpaths #5: wide selects on hot tables

**Class of bug:** `db/` helpers select every column via `.select('*')` for
domain tables the UI only needs a slice of. The audit listed `rooms`,
`staff`, `properties`, `cleaning_events`. The rooms helpers were narrowed in
commit `ec17ed3`. Staff / properties / cleaning-events are still wide.

**One change to fix every instance:** Narrow the SELECT at the canonical
mapper boundary (`src/lib/db/staff.ts`, `properties.ts`, `cleaning-events.ts`).
Choose the column set by intersecting what `fromXxxRow` mappers actually
read.

### Cluster 3 — Cost-hotpaths #2: 30s admin pollers

**Class of bug:** Two admin pages poll at 30s when the audit recommends 60s
(other admin surfaces already moved). Quick win.

**One change to fix every instance:** Bump
[src/app/admin/agent/page.tsx](src/app/admin/agent/page.tsx) and
[src/app/laundry/[id]/page.tsx](src/app/laundry/[id]/page.tsx).

### Cluster 4 — Logging-pii S2: per-route Sentry trace sampler

**Class of bug:** `tracesSampleRate: 0.1` is global; a single noisy route can
crowd out lower-volume routes when the quota is hit. P3 per the audit but
trivial to add now.

**One change to fix every instance:** Add a `tracesSampler` callback to the
shared `getBaseSentryOptions()` in `src/lib/sentry-base.ts` so all three
runtimes (client/server/edge) get the same routing logic.

### Cluster 5 — Data-model: missing FK + polymorphic-ID documentation

**Class of bug:** 0142 enforced 6 implied FKs but left 4 columns un-addressed.
One needs an actual FK; three are polymorphic or external IDs and should be
documented via `COMMENT ON COLUMN` so future readers don't try to enforce.

**One change to fix every instance:** New migration `0149_close_remaining_implied_fks.sql`:
- `prediction_log.inventory_count_id` → FK to `inventory_counts(id) ON DELETE SET NULL`
- `agent_messages.tool_call_id` → COMMENT (external Anthropic/OpenAI tool-call ID)
- `claude_usage_log.job_id` → COMMENT (text field; may be onboarding_jobs OR pull_jobs depending on context)
- Same pass: COMMENT on `stripe_processed_events` and `ml_feature_flags` so the next data-model audit doesn't re-flag them as dead.

Migration is staged but NOT applied (per project convention — manual prod apply).

### Cluster 6 — Env-vars: stale "legacy fallback" comments

**Class of bug:** Three files advertise legacy fallback names that the
schema layer no longer accepts (commit `c0f5df2` dropped them). Doc drift,
not a behavior bug.

**One change to fix every instance:** Update the comment blocks in
`.env.local.example`, `scraper/.env.example`, and `cua-service/src/env.ts`
to reflect that the legacy names are no longer accepted.

## 4. Items intentionally NOT in scope

- **Cost-hotpaths #3** (4s housekeeper poll → 6-8s): the team commented at
  the code site defending the 4s value as a deliberate sweet spot and added
  subscribeTable debouncing + local payload reducers (commits `d1145d4`,
  audit-acknowledged in `src/lib/db/_common.ts:217-241`) as the root-cause
  fix for refetch amplification. The 4s remains intentional.
- **Cost-hotpaths #6** (lift hotel-snapshot cache to KV/Vercel Data Cache):
  infrastructure choice — code-side fix is correct; cross-instance dedup
  needs ops decision on cache infra.
- **Cost-hotpaths #7** (Haiku model routing): blocked on eval harness per
  audit comment; not a residual bug.
- **Cost-hotpaths #10** (hoist `buildHotelSnapshot` before SSE): the team
  explicitly chose the opposite — comments at the call site (lines 294-300,
  319) document the choice and the trade-off.
- **Cost-hotpaths #13, #14** (CUA browser-context cache, PG NOTIFY claim
  loop): backend optimizations that are not bug-class issues.
- **Type-safety deferrals**: full `Database<T>`-typed admin client + the
  remaining client `.json()` sweep are explicitly punted by the audit
  author for separate PRs.
- **Logging-pii recommendation 10** (ESLint rule for log-PII): a
  recommendation, not a finding. Skipped to keep scope tight.

## 5. Execution order

1. Cluster 1 (CRITICAL — security)
2. Cluster 5 (correctness + integrity)
3. Cluster 2 (perf root-cause; narrow selects)
4. Cluster 3 (perf one-liners)
5. Cluster 4 (observability)
6. Cluster 6 (doc cleanup)

After each cluster: `npm run typecheck`, `npm run lint`, `npm run test`,
`npm run build` if any frontend-shaped change. Commit per cluster with a
descriptive message referencing the audit + finding number(s).

Final pass writes `.claude/reports/_fix-execution-summary.md`.
