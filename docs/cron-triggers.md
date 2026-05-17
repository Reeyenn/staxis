# Cron triggers

This codebase has TWO sets of cron-style routes that look identical at the URL level but are triggered by different schedulers. Reading `vercel.json` alone gives a misleading picture — many `/api/cron/*` routes exist but aren't in `vercel.json` because they're triggered externally.

Source of truth: this document. If you add a new cron-shaped route, list it here.

## Triggered by Vercel Cron (declared in `vercel.json`)

These 13 schedules run automatically as part of Vercel deploys. Auth via `CRON_SECRET` header set by Vercel.

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/expire-trials` | `0 9 * * *` | Daily 09:00 UTC. Expire trial accounts past their grace period. |
| `/api/cron/process-sms-jobs` | `*/5 * * * *` | Every 5 min. Claim a batch of pending SMS jobs from `sms_jobs` and send via Twilio. |
| `/api/cron/scraper-health` | `*/15 * * * *` | Every 15 min. Watchdog pulse for the PMS scraper service. |
| `/api/agent/nudges/check` | `*/5 * * * *` | Every 5 min. For each property with recent agent activity (RPC `staxis_active_property_ids_for_nudges`, migration 0132), evaluate nudge conditions. |
| `/api/cron/agent-sweep-reservations` | `*/5 * * * *` | Every 5 min. Cancel agent_costs reservations stuck in 'reserved' state for >5 min. |
| `/api/cron/agent-archive-stale-conversations` | `0 3 * * *` | Daily 03:00 UTC. Move long-idle agent conversations to the archive tier. |
| `/api/cron/agent-summarize-long-conversations` | `*/30 * * * *` | Every 30 min. Fold conversations with >50 unsummarized messages into a summary turn (Haiku-driven). |
| `/api/cron/agent-heal-counters` | `0 4 * * *` | Daily 04:00 UTC. Reconcile agent_conversations counter drift via `staxis_heal_conversation_counters`. |
| `/api/cron/agent-weekly-digest` | `0 9 * * 0` | Sundays 09:00 UTC. Per-property weekly activity digest email. |
| `/api/cron/doctor-check` | `0 * * * *` | Hourly. Run the doctor health checks and persist results to `cron_heartbeats`. |
| `/api/cron/walkthrough-heal-stale` | `*/30 * * * *` | Every 30 min. Recover stranded walkthrough_runs via `staxis_walkthrough_heal_stale`. |
| `/api/cron/walkthrough-health-alert` | `*/10 * * * *` | Every 10 min. Page on walkthrough error spikes. |
| `/api/cron/seed-rooms-daily` | `10 * * * *` | At minute 10 of every hour. Seed `rooms` rows for properties whose local-day has just rolled forward. |

## Triggered externally (NOT in `vercel.json`)

These routes also live under `/api/cron/*` (or `/api/agent/*`) and accept `CRON_SECRET`, but are kicked off by some other scheduler. Re-deploying without their trigger configured means they stop running.

| Path | Trigger | Cadence | Purpose |
|---|---|---|---|
| `/api/cron/enqueue-property-pulls` | GitHub Actions workflow `.github/workflows/*` | Every 15 min | Enqueue a PMS pull per connected property — work happens in the scraper service, not Vercel. |
| `/api/cron/ml-aggregate-priors` | GitHub Actions | Daily, post-training | Aggregate Bayesian priors after the training run. |
| `/api/cron/ml-predict-inventory` | GitHub Actions | Multiple times/day | Run inventory rate predictions across all properties. |
| `/api/cron/ml-retention-purge` | GitHub Actions | Weekly | Apply retention policies to ML feature tables. |
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

## How to verify

- Vercel-scheduled: see the **Cron Jobs** tab of the Vercel project dashboard. Each invocation logs in **Functions**.
- Externally triggered: `gh workflow list` shows the GitHub Actions side; per-route invocation logs land in Vercel **Functions** logs (filter by route).
- All routes write a `cron_heartbeats` row on success — `select route, last_run_at from cron_heartbeats order by last_run_at desc` is the fastest "is this thing running?" check.

## Audit reference

See `.claude/reports/cost-hotpaths-audit.md` section 9 ("Polling and intervals") for the cost analysis of each cron's fan-out.
