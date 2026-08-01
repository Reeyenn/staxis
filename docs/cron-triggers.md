# Cron triggers

This codebase has TWO sets of cron-style routes that look identical at the URL level but are triggered by different schedulers. Reading `vercel.json` alone gives a misleading picture — many `/api/cron/*` routes exist but aren't in `vercel.json` because they're triggered externally.

Runtime trigger sources are `vercel.json` and `.github/workflows/*`. The
behavior-preserving inventory is `src/lib/automation/job-catalog.ts`; Mission
Control and the legacy schedule/cadence projections are derived from its active
rows. This document is an operator guide, not executable metadata.

If you add a new cron-shaped route, add one catalog row even when the route is
staged, manual-only, or retired. Adding a catalog row never schedules the job.

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

## Triggered by active GitHub schedules

These are the only uncommented GitHub `schedule:` entries that invoke Staxis
operations. The catalog parity test reads the workflow files directly.

| Target | Workflow | Schedule | Purpose |
|---|---|---|---|
| `/api/cron/ml-aggregate-priors` | `ml-cron.yml` | `30 7 * * 0` | Weekly inventory cohort priors before training. |
| `/api/cron/ml-train-inventory` | `ml-cron.yml` | `0 9 * * 0` | Weekly inventory-rate training. |
| `/api/cron/ml-predict-inventory` | `ml-cron.yml` | `0 11 * * *` | Daily inventory-rate prediction. |
| `/api/cron/purge-old-error-logs` | `purge-old-error-logs-cron.yml` | `30 9 * * *` | Daily error-log retention. |
| Workflow only | `dependency-audit.yml` | `17 9 * * 1` | Weekly dependency advisory check. |

## Manual, event-driven, and retired operations

- Housekeeping ML training/inference and ML retention remain manual-only.
- The sharded memory-consolidation workflow is a manual alternate runner; the
  normal unsharded job remains on Vercel.
- The ML smoke and Sentry test workflows are manual-only.
- The retained ML shadow-evaluation and auto-rollback workflow jobs reference
  API routes that are no longer present and are cataloged as retired.
- The CUA pull workflow is retained but manual dispatch is a guarded no-op.
- `/api/agent/nudges/check` writes a heartbeat but currently has no repository
  scheduler, so it is cataloged as staged.
- Push/pull-request and post-deploy workflows are cataloged as event-driven,
  not as timed jobs.

All other `/api/cron/*` routes are explicitly classified in the catalog as
staged, manual-only, or retired. No route is considered scheduled merely
because its handler still exists.

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

### The checklist — runtime trigger plus catalog state

For **every** route in the table above, make both changes. The job-catalog,
cron-cadence, and cron-coverage tests fail loudly if the trigger and catalog
drift, so a half-finished switch cannot ship.

1. **`vercel.json`** → `{ "path": "<route>", "schedule": "<schedule>" }`
2. **`src/lib/automation/job-catalog.ts`** → change the existing staged row to
   `active`, record the exact runner/source/schedule, and provide Doctor and
   Mission metadata.

Do not edit `SCHEDULE_REGISTRY`, `EXPECTED_CRONS`, or Mission Control metadata
separately; they are catalog projections.

Then: deploy, and confirm each route appears in the Vercel **Cron Jobs** tab. After the first tick, `select route, last_run_at from cron_heartbeats order by last_run_at desc` should show all four.

### Two things to check before flipping it

- **The per-hotel spend cap is real money.** `run-findings` makes one batched model call per hotel per night and `findings-sweep` one per sampled hotel; both reserve against the per-hotel-per-day findings cap. Turning the layer on for N hotels is an N-shaped cost change, not a fixed one.
- **Demo data.** `run-management-patterns`'s scheduled discovery already excludes companies whose whole portfolio is `properties.is_test` hotels (`src/lib/company/demo-portfolio.ts`). The hotel-level crons have no equivalent filter — if the demo hotels are still in production when the switch goes on, decide deliberately whether they should be getting nightly findings runs.

## How to verify

- Vercel-scheduled: see the **Cron Jobs** tab of the Vercel project dashboard. Each invocation logs in **Functions**.
- Externally triggered: `gh workflow list` shows the GitHub Actions side; per-route invocation logs land in Vercel **Functions** logs (filter by route).
- Routes with a cataloged heartbeat write `cron_heartbeats` on success — `select route, last_run_at from cron_heartbeats order by last_run_at desc` is the fastest "is this thing running?" check.

## Audit reference

See `.claude/reports/cost-hotpaths-audit.md` section 9 ("Polling and intervals") for the cost analysis of each cron's fan-out.
