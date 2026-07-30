# Cron triggers

This codebase has TWO sets of cron-style routes that look identical at the URL level but are triggered by different schedulers. Reading `vercel.json` alone gives a misleading picture — many `/api/cron/*` routes exist but aren't in `vercel.json` because they're triggered externally.

Source of truth: this document. If you add a new cron-shaped route, list it here.

## Triggered by Vercel Cron (declared in `vercel.json`)

These 14 schedules run automatically as part of Vercel deploys. Auth via `CRON_SECRET` header set by Vercel.

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/agent-sweep-reservations` | `*/5 * * * *` | Every 5 min. Cancel agent_costs reservations stuck in 'reserved' state for >5 min. |
| `/api/cron/sweep-account-lifecycle` | `*/5 * * * *` | Finish durable account disable/reactivate intents after an interrupted request. |
| `/api/cron/process-agent-schedules` | `*/5 * * * *` | Deliver due agent reminders and recurring Communications tasks. |
| `/api/cron/agent-archive-stale-conversations` | `0 3 * * *` | Daily 03:00 UTC. Move long-idle agent conversations to the archive tier. |
| `/api/cron/agent-summarize-long-conversations` | `*/30 * * * *` | Every 30 min. Fold conversations with >50 unsummarized messages into a summary turn (Haiku-driven). |
| `/api/cron/agent-consolidate-memory` | `0 5 * * *` | Consolidate durable hotel memory overnight. |
| `/api/cron/agent-heal-counters` | `0 4 * * *` | Daily 04:00 UTC. Reconcile agent_conversations counter drift via `staxis_heal_conversation_counters`. |
| `/api/cron/walkthrough-heal-stale` | `*/30 * * * *` | Every 30 min. Recover stranded walkthrough_runs via `staxis_walkthrough_heal_stale`. |
| `/api/cron/sweep-orphan-auth-users` | `0 7 * * *` | Remove incomplete sign-up auth users without an account row. |
| `/api/cron/sweep-mfa-verified-sessions` | `0 */6 * * *` | Remove expired trusted-device verification sessions. |
| `/api/cron/pms-auth-codes-purge` | `45 4 * * *` | Retention for the whole PMS report intake: old login codes, old inbox emails, and raw report files — including deleting immediately any report quarantined for containing a card number. |
| `/api/cron/agent-costs-rollup` | `20 5 * * *` | The ONLY owner of `agent_costs` retention. Folds each month into `agent_costs_monthly`, verifies the fold reproduces the raw sum exactly, and prunes raw rows only for verified months older than 6 months. |
| `/api/cron/pms-observations-purge` | `40 5 * * *` | Retention sweep for the five append-only PMS observation tables via 0343's sanctioned purge function. 5-year window — a no-op until report ingestion restarts. |
| `/api/cron/vercel-watchdog` | `*/5 * * * *` | Poll the production doctor and alert when the app is unhealthy. |

## Triggered externally (NOT in `vercel.json`)

These routes also live under `/api/cron/*` (or `/api/agent/*`) and accept `CRON_SECRET`, but are kicked off by some other scheduler. Re-deploying without their trigger configured means they stop running.

| Path | Trigger | Cadence | Purpose |
|---|---|---|---|
| `/api/cron/enqueue-property-pulls` | **DORMANT** — `.github/workflows/pull-jobs-cron.yml` has no `schedule:` block | Never | Was: enqueue a PMS pull per connected property for the CUA robot. Robot decommissioned 2026-07-25 — the route also self-refuses while `CUA_DECOMMISSIONED` is true in `src/lib/pms/decommission.ts`. Route code kept dormant; see `cua-service/README.md` to re-enable. |
| `/api/cron/webhook-dedup-purge` | **DORMANT** (2026-07-27 chore audit) | Never | Both dedup tables have no live writer: the Sentry producer was deleted 2026-07-17, and `stripe_processed_events` has never held a row because `/api/stripe/webhook` is inert while billing is unconfigured. **Re-schedule the day billing goes live** — that route writes a row per delivery and this is its only pruner. |
| `/api/cron/expire-help-requests` | **DORMANT** (2026-07-27 chore audit) | Never | Its producer is the decommissioned robot's human-assist flow. All 4 prod rows expired 2026-07-01; it was a proven no-op 288×/day. Re-schedule when cua-service runs mapper jobs again. |
| `/api/cron/claude-sessions-purge` | **DORMANT** (2026-07-27 chore audit) | Never | `claude_sessions` has never held a row — the writer is a developer-laptop hook whose POSTs die on the vercel.app→getstaxis.com 308. Developer tooling, not a hotel chore. Re-enable the hook and this cron together or not at all. |
| `/api/cron/run-findings` | **DORMANT** by design — the AI master switch | Never | The nightly per-hotel findings pass (demote, detect, judge). Unscheduled since it shipped 2026-07-26: the founder turns the AI on, not a deploy. Intended schedule `0 6 * * *`. See "The AI master switch" below. |
| `/api/cron/findings-sweep` | **DORMANT** by design — the AI master switch | Never | The weekly discovery pass over a rotating sample of hotels; proposes new detectors into the founder's promotion queue. Intended schedule `0 7 * * 1`. See "The AI master switch" below. |
| `/api/cron/findings-janitor` | **DORMANT** by design — the AI master switch | Never | Retention for the findings engine, shipped unscheduled like `run-findings` and `findings-sweep`. Deletes only settled `findings_ai_spend` rows and surplus `finding_runs`; refuses to touch `findings`, `finding_actions`, `finding_detector_state` or `finding_sweep_runs`. Intended schedule `40 7 * * 1`, behind the sweep. See "The AI master switch" below. |
| `/api/cron/run-management-patterns` | **DORMANT** by design — the AI master switch | Never | The management-company equivalent: refreshes the live portfolio queue and retries the shadow-only v2 evaluator, for every management company. Briefly scheduled `0 8 * * *` on 2026-07-29 and parked again the same day on the owner's ruling — the AI layer goes on all at once, and the only management company in production today is the seeded demo one. Intended schedule `0 8 * * *`. Its scheduled discovery excludes demo-only portfolios; the company queue's page-open fallback does not, so live demos still generate cards. See "The AI master switch" below. |
| `/api/cron/ml-aggregate-priors` | GitHub Actions | Daily, post-training | Aggregate Bayesian priors after the training run. |
| `/api/cron/ml-predict-inventory` | GitHub Actions | Multiple times/day | Run inventory rate predictions across all properties. |
| `/api/cron/ml-retention-purge` | **DORMANT** — schedule commented out in `.github/workflows/ml-retention-purge.yml` since 2026-05-30 | Never | Retention for `prediction_log`, `app_events`, `phone_pairings`. **`agent_costs` was removed 2026-07-27** — the books have one owner, `agent-costs-rollup`. Deletes in bounded batches with a per-run cap, and supports `?dryRun=true`; run the dry run FIRST when re-enabling. |
| `/api/cron/ml-run-inference` | GitHub Actions | Daily ~05:30 CT | Demand/supply/optimizer inference across all properties. Sharded. |
| `/api/cron/ml-shadow-evaluate` | GitHub Actions | Per shadow-model deploy | Validate shadow model accuracy before promotion. |
| `/api/cron/ml-train-demand` | GitHub Actions | Daily | Retrain demand model (XGBoost quantile). |
| `/api/cron/ml-train-supply` | GitHub Actions | Daily | Retrain supply (cleaning duration) model. |
| `/api/cron/ml-train-inventory` | GitHub Actions | Daily | Retrain inventory consumption-rate model. |
| `/api/cron/purge-old-error-logs` | GitHub Actions | Weekly | Compact `app_events.error_*` rows past retention. |
| `/api/cron/schedule-auto-fill` | GitHub Actions | Every morning ~07:00 local | Auto-fill schedule_assignments for properties with `auto_fill_enabled = true`. |
| `/api/cron/scraper-weekly-digest` | GitHub Actions | Weekly | Per-PMS scraper health digest to the ops channel. |
| `/api/cron/seal-daily` | GitHub Actions | Daily, end-of-day local | Seal the day's records — locks `rooms` from edits, freezes the ML training rows. |

> **If you add a NEW cron-style route**: declare it in `vercel.json` and remove it from this list, OR add it to the external table above with the exact workflow file or scheduler that triggers it. Routes that aren't in EITHER list are silently dead.

## The AI master switch

**The entire AI findings layer is unscheduled on purpose, and it goes on in ONE act.** The founder's standing ruling: nothing in this layer runs on a timer until the first real hotel is onboarded. Until then every one of these routes is hand-callable with the `CRON_SECRET` bearer, which is how each gets exercised against real data before it is ever scheduled.

**Do not schedule one of these on its own.** That is exactly what happened on 2026-07-29 — `run-management-patterns` was given a daily schedule in isolation, on a production fleet whose only management company is the seeded demo one, so the single effect would have been paid AI runs against fake data. It was parked again the same day.

### The four crons, and the schedule each one wants

| Route | Heartbeat name | Schedule to restore | `cadenceHours` for the doctor |
|---|---|---|---|
| `/api/cron/run-findings` | `run-findings` | `0 6 * * *` | 24 |
| `/api/cron/findings-sweep` | `findings-sweep` | `0 7 * * 1` | 168 |
| `/api/cron/findings-janitor` | `findings-janitor` | `40 7 * * 1` | 168 |
| `/api/cron/run-management-patterns` | `run-management-patterns` | `0 8 * * *` | 24 |

### The checklist — four files, four rows each

For **every** route in the table above, add its row to all four places. The `cron-cadences` and `cron-coverage` tests fail loudly if you do three of the four, so a half-finished switch cannot ship.

1. **`vercel.json`** → `{ "path": "<route>", "schedule": "<schedule>" }`
2. **`src/lib/cron-schedule-registry.ts`** → `{ heartbeatName: '<name>', source: { kind: 'vercel', cronPath: '<route>' }, cronExpr: '<schedule>' }`
3. **`src/app/api/admin/doctor/route.ts`** → an `EXPECTED_CRONS` entry with the `cadenceHours` from the table
4. **`src/app/api/admin/mission/workers/route.ts`** → a `WORKER_META` line, so the chore shows up in Mission Control

Then: deploy, and confirm each route appears in the Vercel **Cron Jobs** tab. After the first tick, `select route, last_run_at from cron_heartbeats order by last_run_at desc` should show all four.

### Two things to check before flipping it

- **The per-hotel spend cap is real money.** `run-findings` makes one batched model call per hotel per night and `findings-sweep` one per sampled hotel; both reserve against the per-hotel-per-day findings cap. Turning the layer on for N hotels is an N-shaped cost change, not a fixed one.
- **Demo data.** `run-management-patterns`'s scheduled discovery already excludes companies whose whole portfolio is `properties.is_test` hotels (`src/lib/company/demo-portfolio.ts`). The hotel-level crons have no equivalent filter — if the demo hotels are still in production when the switch goes on, decide deliberately whether they should be getting nightly findings runs.

## How to verify

- Vercel-scheduled: see the **Cron Jobs** tab of the Vercel project dashboard. Each invocation logs in **Functions**.
- Externally triggered: `gh workflow list` shows the GitHub Actions side; per-route invocation logs land in Vercel **Functions** logs (filter by route).
- All routes write a `cron_heartbeats` row on success — `select route, last_run_at from cron_heartbeats order by last_run_at desc` is the fastest "is this thing running?" check.

## Audit reference

See `.claude/reports/cost-hotpaths-audit.md` section 9 ("Polling and intervals") for the cost analysis of each cron's fan-out.
