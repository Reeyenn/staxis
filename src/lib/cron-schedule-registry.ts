/**
 * Single source of truth — what each cron heartbeat is supposed to fire
 * at, and where its schedule lives (GitHub Actions workflow file OR
 * vercel.json). Add a new row here whenever you wire up a new cron.
 *
 * Why this is in src/lib (not the test folder):
 *   Two test files consume it — cron-cadences.test.ts (drift-prevention
 *   against EXPECTED_CRONS + the workflow files / vercel.json) and
 *   cron-coverage.test.ts (drift-prevention against actual route.ts
 *   writeCronHeartbeat calls). Keeping the registry in shipped code
 *   (rather than a test-only const) avoids cross-test-file imports.
 *
 * cronExpr must be the EXACT string from the source file. For GH
 * workflows the test accepts either single or double quotes around
 * the value; for vercel.json it must appear in the JSON `schedule`
 * field exactly.
 */

export type ScheduleSource =
  | { kind: 'github'; workflowFile: string }
  | { kind: 'vercel'; cronPath: string };

export interface ScheduleEntry {
  heartbeatName: string;
  source: ScheduleSource;
  cronExpr: string;
}

export const SCHEDULE_REGISTRY: ReadonlyArray<ScheduleEntry> = [
  // Tight cadences (sub-hourly) — Vercel native cron (May 2026 audit
  // pass-6: moved from GH Actions, which was silently throttling these
  // to 60-200 min intervals). Vercel Pro supports per-minute precision.
  // process-sms-jobs MOVED to Vercel native (2026-06-26 pre-onboarding
  // audit): the GH Actions schedule was throttled ~17× (observed 1.4h-stale
  // heartbeat on a 5-min cron), so SMS-link delivery drained late — exactly
  // the failure FAILSAFES.md warns about for sub-30-min GH crons. The GH
  // workflow .github/workflows/sms-jobs-cron.yml is KEPT as a redundant
  // backup scheduler (failsafe #4 — don't disable workflows); dual-firing is
  // safe because staxis_claim_sms_jobs uses FOR UPDATE SKIP LOCKED (no
  // double-send). This entry is the scheduler of record (Vercel).
  // Plan v4 (2026-05-24): removed `scraper-health` cron entry — Railway
  // scraper service is gone, `vercel-watchdog` (5-min, listed below) is
  // its replacement.
  { heartbeatName: 'agent-nudges-check',                source: { kind: 'vercel', cronPath: '/api/agent/nudges/check' },                     cronExpr: '*/5 * * * *' },
  { heartbeatName: 'compliance-reminders',              source: { kind: 'vercel', cronPath: '/api/cron/compliance-reminders' },             cronExpr: '0 * * * *' },
  { heartbeatName: 'compliance-anomaly-sweep',          source: { kind: 'vercel', cronPath: '/api/cron/compliance-anomaly-sweep' },          cronExpr: '*/30 * * * *' },
  { heartbeatName: 'agent-sweep-reservations',          source: { kind: 'vercel', cronPath: '/api/cron/agent-sweep-reservations' },          cronExpr: '*/5 * * * *' },
  { heartbeatName: 'agent-summarize-long-conversations',source: { kind: 'vercel', cronPath: '/api/cron/agent-summarize-long-conversations' },cronExpr: '*/30 * * * *' },
  { heartbeatName: 'agent-consolidate-memory',          source: { kind: 'vercel', cronPath: '/api/cron/agent-consolidate-memory' },          cronExpr: '0 5 * * *' },
  { heartbeatName: 'walkthrough-heal-stale',            source: { kind: 'vercel', cronPath: '/api/cron/walkthrough-heal-stale' },             cronExpr: '*/30 * * * *' },
  // Plan v4 (2026-05-24): removed `seed-rooms-daily` — depended on the
  // legacy `rooms` table (dropped in v4).
  { heartbeatName: 'sweep-orphan-auth-users',           source: { kind: 'vercel', cronPath: '/api/cron/sweep-orphan-auth-users' },             cronExpr: '*/30 * * * *' },
  { heartbeatName: 'sweep-mfa-verified-sessions',       source: { kind: 'vercel', cronPath: '/api/cron/sweep-mfa-verified-sessions' },         cronExpr: '0 */6 * * *' },
  // Hourly per-property seal-daily. Reads today_property_counts_v1
  // (Plan v4 bridge → pms_in_house_snapshot + pms_reservations).
  { heartbeatName: 'seal-daily', source: { kind: 'vercel', cronPath: '/api/cron/seal-daily' }, cronExpr: '5 * * * *' },
  // Daily Lost & Found disposal sweep — auto-expires items past their 90-day
  // hold and nudges GMs about items nearing disposal.
  { heartbeatName: 'lost-found-disposal-check', source: { kind: 'vercel', cronPath: '/api/cron/lost-found-disposal-check' }, cronExpr: '0 16 * * *' },
  // Daily — most live in ml-cron.yml's multi-cron list
  { heartbeatName: 'ml-run-inference',      source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '30 10 * * *' },
  { heartbeatName: 'ml-predict-inventory',  source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 11 * * *' },
  // 2026-05-24: removed `ml-aggregate-priors` — cross-fleet cohort
  // aggregation is a no-op at N<5 hotels per cohort. Cron still fires
  // (ml-cron.yml schedule) but its heartbeat isn't tracked.
  { heartbeatName: 'purge-old-error-logs',  source: { kind: 'github', workflowFile: 'purge-old-error-logs-cron.yml' }, cronExpr: '30 9 * * *' },
  // Daily schedule auto-build. Reads today_room_work_v1 (Plan v4
  // bridge → pms_room_status_log + pms_reservations) for the per-room
  // work list, computes optimal HK assignments, writes them via the
  // atomic schedule-auto-fill RPC.
  { heartbeatName: 'schedule-auto-fill', source: { kind: 'github', workflowFile: 'schedule-auto-fill-cron.yml' }, cronExpr: '0 12 * * *' },
  { heartbeatName: 'schedule-auto-fill', source: { kind: 'github', workflowFile: 'schedule-auto-fill-cron.yml' }, cronExpr: '0 1 * * *' },
  // expire-trials is a Vercel native cron (vercel.json), not GH Actions.
  { heartbeatName: 'expire-trials',                     source: { kind: 'vercel', cronPath: '/api/cron/expire-trials' },                    cronExpr: '0 9 * * *' },
  { heartbeatName: 'agent-archive-stale-conversations', source: { kind: 'vercel', cronPath: '/api/cron/agent-archive-stale-conversations' },cronExpr: '0 3 * * *' },
  { heartbeatName: 'claude-sessions-purge',             source: { kind: 'vercel', cronPath: '/api/cron/claude-sessions-purge' },             cronExpr: '30 3 * * *' },
  { heartbeatName: 'agent-heal-counters',               source: { kind: 'vercel', cronPath: '/api/cron/agent-heal-counters' },              cronExpr: '0 4 * * *' },
  { heartbeatName: 'webhook-dedup-purge',               source: { kind: 'vercel', cronPath: '/api/cron/webhook-dedup-purge' },              cronExpr: '15 4 * * *' },
  { heartbeatName: 'pms-auth-codes-purge',              source: { kind: 'vercel', cronPath: '/api/cron/pms-auth-codes-purge' },             cronExpr: '45 4 * * *' },
  // feat/cua-partial-promotion: daily retry of feeds the robot hasn't
  // learned (active knowledge files with feedGaps). 10:00 UTC — after the
  // 3am-local nightly CUA restarts have settled across US timezones.
  { heartbeatName: 'pms-backfill-missing-feeds',        source: { kind: 'vercel', cronPath: '/api/cron/pms-backfill-missing-feeds' },       cronExpr: '0 10 * * *' },
  // Weekly
  { heartbeatName: 'ml-train-demand',       source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 8 * * 0' },
  { heartbeatName: 'ml-train-supply',       source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '30 8 * * 0' },
  { heartbeatName: 'ml-train-inventory',    source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 9 * * 0' },
  { heartbeatName: 'ml-retention-purge',    source: { kind: 'github', workflowFile: 'ml-retention-purge.yml' },      cronExpr: '0 8 * * *' },
  // Plan v4 (2026-05-24): removed `scraper-weekly-digest` — Railway
  // scraper observability cron.
  // Plan v4 (2026-05-23): replaces scraper/vercel-watchdog.js (Railway
  // process killed in the v4 cutover). Polls /api/admin/doctor every 5
  // min and alerts Sentry/SMS on fail with business-hours-only bumps.
  { heartbeatName: 'vercel-watchdog',       source: { kind: 'vercel', cronPath: '/api/cron/vercel-watchdog' },                  cronExpr: '*/5 * * * *' },
  // 2026-05-24: cua-parity-diff retired — shadow gate removed; new
  // generic-table-writer is the only write path now.
  // Migration 0210: cleaning-rules engine. Reads pms_* → writes
  // cleaning_tasks every 5 min. Idempotent.
  { heartbeatName: 'run-rules-engine',      source: { kind: 'vercel', cronPath: '/api/cron/run-rules-engine' },                 cronExpr: '*/5 * * * *' },
  // 2026-05-25: auto-assignment cron. Fires every 15 min unconditionally.
  // The engine is idempotent (skips tasks with an is_active hk_assignments
  // row) and `runForProperty` computes "today" per the property's own
  // timezone — so a single UTC-tick line handles every timezone without
  // a hardcoded shift-start gate. Rationale + rejected alternatives are
  // documented in the route file header.
  { heartbeatName: 'run-auto-assign',       source: { kind: 'vercel', cronPath: '/api/cron/run-auto-assign' },                  cronExpr: '*/15 * * * *' },
  // 2026-05-24: sick-callout coverage flow (feature #6). Every 5 min,
  // sweeps callout_events for rows whose redistribute_at has passed
  // (or whose 'after_current_room' guard is now satisfied) and fires
  // the redistribute. Acts as a safety net for the inline path on the
  // report routes — if their inline call failed transiently, this picks
  // up the slack.
  // Plan v8 Phase B (migration 0217): every 5 min, flips
  // mapping_help_requests past expires_at from 'pending' to 'expired'
  // and deletes the corresponding screenshot objects from the
  // mapping-screenshots Supabase Storage bucket. Without this the
  // 15-min TTL pending rows + their screenshots would accumulate
  // forever.
  { heartbeatName: 'expire-help-requests', source: { kind: 'vercel', cronPath: '/api/cron/expire-help-requests' },                cronExpr: '*/5 * * * *' },
  // 2026-05-24: daily + weekly housekeeping reports (feature #17). Daily
  // cron fires every 30 min so it can hit every property's local 4pm/
  // 6pm/8pm/10pm slot regardless of timezone. Weekly cron is the same
  // shape — the route itself skips non-Sunday runs early.
  // 2026-05-30: complaints — satisfaction-callback-due nudges + high-severity
  // escalation SMS. Idempotent via callback_nudged_at / escalation_nudged_at.
  // 2026-05-31: financials — daily overspend-forecast + spend-anomaly sweep.
  // Texts the property alert phone; idempotent/no-spam via app_events dedup.
];
