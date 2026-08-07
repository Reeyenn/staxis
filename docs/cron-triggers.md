# Cron triggers

This codebase has TWO sets of cron-style routes that look identical at the URL level but are triggered by different schedulers. Reading `vercel.json` alone gives a misleading picture — many `/api/cron/*` routes exist but aren't in `vercel.json` because they're triggered externally.

Runtime trigger sources are `vercel.json` and `.github/workflows/*`. The
behavior-preserving inventory is `src/lib/automation/job-catalog.ts`; Mission
Control and the legacy schedule/cadence projections are derived from its active
rows. This document is an operator guide, not executable metadata.

If you add a new cron-shaped route, add one catalog row even when the route is
staged, manual-only, or retired. Adding a catalog row never schedules the job.

## Triggered by Vercel Cron (declared in `vercel.json`)

These 19 schedules run automatically as part of Vercel deploys. Auth via `CRON_SECRET` header set by Vercel.

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/agent-sweep-reservations` | `*/5 * * * *` | Every 5 min. Cancel agent_costs reservations stuck in 'reserved' state for >5 min. |
| `/api/cron/sweep-account-lifecycle` | `*/5 * * * *` | Finish durable account disable/reactivate intents after an interrupted request. |
| `/api/cron/process-agent-schedules` | `*/5 * * * *` | Deliver due agent reminders and recurring Communications tasks. |
| `/api/cron/agent-archive-stale-conversations` | `0 3 * * *` | Daily 03:00 UTC. Move long-idle agent conversations to the archive tier. |
| `/api/cron/agent-summarize-long-conversations` | `*/30 * * * *` | Every 30 min. Fold conversations with >50 unsummarized messages into a summary turn (Haiku-driven). |
| `/api/cron/agent-consolidate-memory` | `0 5 * * *` | Consolidate durable hotel memory overnight. |
| `/api/cron/agent-heal-counters` | `0 4 * * *` | Daily 04:00 UTC. Reconcile agent_conversations counter drift via `staxis_heal_conversation_counters`. |
| `/api/cron/sweep-orphan-auth-users` | `0 7 * * *` | Remove incomplete sign-up auth users without an account row. |
| `/api/cron/sweep-mfa-verified-sessions` | `0 */6 * * *` | Remove expired trusted-device verification sessions. |
| `/api/cron/pms-auth-codes-purge` | `45 4 * * *` | Retention for the whole PMS report intake: old login codes, old inbox emails, and raw report files — including deleting immediately any report quarantined for containing a card number. |
| `/api/cron/agent-costs-rollup` | `20 5 * * *` | The ONLY owner of `agent_costs` retention. Folds each month into `agent_costs_monthly`, verifies the fold reproduces the raw sum exactly, and prunes raw rows only for verified months older than 6 months. |
| `/api/cron/pms-observations-purge` | `40 5 * * *` | Retention sweep for the five append-only PMS observation tables via 0343's sanctioned purge function. 5-year window — a no-op until report ingestion restarts. |
| `/api/cron/vercel-watchdog` | `*/5 * * * *` | Poll the production doctor and alert when the app is unhealthy. |
| `/api/cron/run-findings` | `0 6 * * *` | The nightly pass: demote, detect, then one batched judge call per hotel. Switched on 2026-08-06. |
| `/api/cron/findings-sweep` | `0 7 * * 1` | Weekly detector discovery across a sample of hotels. Switched on 2026-08-06. |
| `/api/cron/findings-janitor` | `40 7 * * 1` | Retention for settled findings-engine run data, behind the sweep it tidies. Switched on 2026-08-06. |
| `/api/cron/run-management-patterns` | `0 8 * * *` | The management-company pass. Switched on 2026-08-06. |
| `/api/cron/companion-event-wake` | `*/10 * * * *` | Every 10 min. One deterministic look at each hotel's `activity_log` for flagged events; a model call only where some landed. Not part of the four-cron AI master switch (see below). |

## Triggered by active GitHub schedules

These are the only uncommented GitHub `schedule:` entries that invoke Staxis
operations. The catalog parity test reads the workflow files directly.

| Target | Workflow | Schedule | Purpose |
|---|---|---|---|
| `/api/cron/ml-aggregate-priors` | `ml-cron.yml` | `30 7 * * 0` | Weekly inventory cohort priors before training. |
| `/api/cron/ml-train-inventory` | `ml-cron.yml` | `0 9 * * 0` | Weekly inventory-rate training. |
| `/api/cron/ml-predict-inventory` | `ml-cron.yml` | `0 11 * * *` | Daily inventory-rate prediction. |
| `/api/cron/purge-old-error-logs` | `purge-old-error-logs-cron.yml` | `30 9 * * *` | Daily error-log retention. |
| `/api/admin/robot-walk/report` | `robot-walk.yml` | `0 10 * * *` | Nightly browser walkthrough of the live site. |
| Workflow only | `dependency-audit.yml` | `17 9 * * 1` | Weekly dependency advisory check. |

### The nightly robot walkthrough

The odd one out on the table above: the workflow is not an HTTP call on a timer,
it is a real Chromium that signs into `https://getstaxis.com` at the seeded Robot
Hotel and uses the app. The route in the Target column is where it REPORTS to,
and is what writes the heartbeat.

It needs three things set outside this repository, all of them one-time:

| What | Where | Value |
|---|---|---|
| `ROBOT_WALK_PASSWORD` | GitHub Actions secret | The robot manager's password, the same one given to `scripts/robot-walk/seed.ts`. |
| `ROBOT_WALK_PROPERTY_ID` | GitHub Actions **variable** | The seeded hotel's id. The walk refuses to change anything if the account it signed in as is standing anywhere else. |
| `SKIP_2FA_USER_IDS` | Vercel env | Must include the robot manager's auth user id, or sign-in stops for a one-time code nobody will read. |

Its heartbeat is stricter than the others on purpose: it lands only when every
step passed, so "on time" on the Mission Control row reads as "a manager could
still do all of it last night". A failed step goes to Recent errors naming the
step. Details in `src/lib/automation/robot-walk.ts`.

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

**ON since 2026-08-06.** The founder's standing ruling was that nothing in this layer runs on a timer until the first real hotel is onboarded; that condition is met and the switch was flipped. All four routes are now in `vercel.json` and `active` in the job catalog.

**The other half of the ruling still stands and always will: these four move TOGETHER.** On 2026-07-29 `run-management-patterns` was given a daily schedule in isolation, on a production fleet whose only management company is the seeded demo one, so the single effect would have been paid AI runs against fake data. It was parked again the same day. Parking one of them now has the mirror-image failure: a heartbeat the doctor expects forever and a stage of the pipeline nothing runs.

`cron-cadences.test.ts` asserts all four are scheduled. It used to assert none of them was; the assertion was inverted, not deleted, in the commit that flipped the switch.

### The four crons

| Route | Heartbeat name | Schedule | `cadenceHours` for the doctor |
|---|---|---|---|
| `/api/cron/run-findings` | `run-findings` | `0 6 * * *` | 24 |
| `/api/cron/findings-sweep` | `findings-sweep` | `0 7 * * 1` | 168 |
| `/api/cron/findings-janitor` | `findings-janitor` | `40 7 * * 1` | 168 |
| `/api/cron/run-management-patterns` | `run-management-patterns` | `0 8 * * *` | 24 |

### The checklist — runtime trigger plus catalog state

Unchanged, and it is the checklist for moving them in EITHER direction. For **every** route in the table above, make both changes. The job-catalog, cron-cadence, and cron-coverage tests fail loudly if the trigger and catalog drift, so a half-finished switch cannot ship.

1. **`vercel.json`** → `{ "path": "<route>", "schedule": "<schedule>" }`
2. **`src/lib/automation/job-catalog.ts`** → the row's `lifecycle`, with the
   exact runner/source/schedule and its Doctor and Mission metadata.

Do not edit `SCHEDULE_REGISTRY`, `EXPECTED_CRONS`, or Mission Control metadata
separately; they are catalog projections.

**After the deploy that carries this**, confirm each route appears in the Vercel **Cron Jobs** tab. After the first tick, `select route, last_run_at from cron_heartbeats order by last_run_at desc` should show all four. Nothing outside the repository has to be configured: Vercel reads `vercel.json` on deploy and the routes already authenticate with the `CRON_SECRET` Vercel sets, which is the same secret the other fourteen use.

### Two live consequences of the switch being on

- **The per-hotel spend cap is real money.** `run-findings` makes one batched model call per hotel per night and `findings-sweep` one per sampled hotel; both reserve against the per-hotel-per-day findings cap. The bill is N-shaped in hotels, not fixed.
- **Demo data, and the asymmetry between the two levels.** `run-management-patterns`'s scheduled discovery excludes companies whose whole portfolio is `properties.is_test` (`src/lib/company/demo-portfolio.ts`), and that exclusion is untouched. **The hotel-level crons still have no equivalent filter:** `runFindingsForAllProperties` scans every row of `properties`, test hotels included, so each seeded demo hotel now costs one judge call a night. That was a known, documented decision point before the switch and it remains open. Deciding it is a deliberate act with its own diff, either by adding an `is_test` filter to the fleet scan or by removing the demo hotels from production.

## The companion's ten-minute look

`/api/cron/companion-event-wake` is an AI job and is deliberately **not** one of
the four above. The master switch exists because those four are one pipeline
that must move together; this one is a separate subsystem with its own
ceilings, and coupling it to them would mean neither could be parked without
parking the other.

It is also shaped so that scheduling it is a much smaller commitment:

- **A quiet hotel costs one indexed read.** No model call, no reservation, no
  prompt, no row written. The decision to spend is a pure function over rows a
  query already filtered (`decideWake` in
  `src/lib/companion/event-wake/events.ts`), and a hotel where nothing went
  wrong produces none.
- **Two ceilings, both real.** `MAX_WAKES_PER_DAY` (six, hotel-local, held in
  `companion_event_wake_state`) is the cheap one and bites first. Behind it is a
  dollar hold against the same per-hotel-per-day pool the findings layer uses,
  at a tenth of that pool ($0.25/hotel/day at today's envelope,
  `FEATURE_CAP_SHARE` in `src/lib/findings/judge-budget.ts`).
- **Demo hotels sit out the scheduled pass.** Unlike `run-findings`, this one
  does filter `properties.is_test` in discovery. An explicit `?propertyId=` runs
  whatever it is told.
- **Its model is locked.** `companion.event_wake` is `modelSwitchable: false` in
  the AI feature registry, because the dollar ceiling is sized against the model
  it runs on. Switching it OFF in the AI Control Center is untouched and is the
  supported way to stop it.
- **It prepares, it never acts.** At most one short sentence per wake, written
  into the companion's own record. Whether it is ever said is decided later by
  `src/lib/companion/manners.ts`, against the same daily speech budget, the same
  minimum gap and the same declines as everything else the companion volunteers.
- **A skipped hotel is still a watched hotel.** Every stop in `sweepProperty` is
  either "I looked and there is nothing here" (the cursor advances) or "I could
  not look" (it does not). The doctor's staleness warning only means anything
  while that holds. See RUNBOOKS.md, "Doctor warns companion event sweep ... not
  looked at in over 30 min".

Turning it off: remove the `vercel.json` entry and flip the catalog row's
`lifecycle` to `staged` with `schedule: null`, in the same commit. The
job-catalog parity test fails loudly on a half-finished change.

## How to verify

- Vercel-scheduled: see the **Cron Jobs** tab of the Vercel project dashboard. Each invocation logs in **Functions**.
- Externally triggered: `gh workflow list` shows the GitHub Actions side; per-route invocation logs land in Vercel **Functions** logs (filter by route).
- Routes with a cataloged heartbeat write `cron_heartbeats` on success — `select route, last_run_at from cron_heartbeats order by last_run_at desc` is the fastest "is this thing running?" check.

## Audit reference

See `.claude/reports/cost-hotpaths-audit.md` section 9 ("Polling and intervals") for the cost analysis of each cron's fan-out.
