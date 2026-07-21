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
  // The old process-sms-jobs transport was retired with Twilio on 2026-07-17.
  // Agent reminders and recurring Communications tasks now have their own
  // transport-independent five-minute scheduler below.
  // Plan v4 (2026-05-24): removed `scraper-health` cron entry — Railway
  // scraper service is gone, `vercel-watchdog` (5-min, listed below) is
  // its replacement.
  //
  // 2026-07-19 (owner call, pre-launch trim): unscheduled the crons that
  // only matter once a hotel is live on the PMS robot — agent-nudges-check,
  // seal-daily, lost-found-disposal-check, schedule-auto-fill,
  // expire-trials, pms-backfill-missing-feeds, run-rules-engine,
  // run-auto-assign. Route code is KEPT dormant; to re-enable one, restore
  // its vercel.json entry (or workflow file), its row here, its
  // EXPECTED_CRONS row in the doctor, and its WORKER_META line in
  // /api/admin/mission/workers. (compliance-reminders and
  // compliance-anomaly-sweep were deleted outright the same day with the
  // whole compliance section.)
  { heartbeatName: 'agent-sweep-reservations',          source: { kind: 'vercel', cronPath: '/api/cron/agent-sweep-reservations' },          cronExpr: '*/5 * * * *' },
  { heartbeatName: 'process-agent-schedules',           source: { kind: 'vercel', cronPath: '/api/cron/process-agent-schedules' },           cronExpr: '*/5 * * * *' },
  { heartbeatName: 'agent-summarize-long-conversations',source: { kind: 'vercel', cronPath: '/api/cron/agent-summarize-long-conversations' },cronExpr: '*/30 * * * *' },
  { heartbeatName: 'agent-consolidate-memory',          source: { kind: 'vercel', cronPath: '/api/cron/agent-consolidate-memory' },          cronExpr: '0 5 * * *' },
  { heartbeatName: 'walkthrough-heal-stale',            source: { kind: 'vercel', cronPath: '/api/cron/walkthrough-heal-stale' },             cronExpr: '*/30 * * * *' },
  // Plan v4 (2026-05-24): removed `seed-rooms-daily` — depended on the
  // legacy `rooms` table (dropped in v4).
  // 2026-07-19: sweep-orphan-auth-users slowed from every-30-min to daily
  // (owner call) — pre-launch there are almost no sign-ups to reconcile.
  { heartbeatName: 'sweep-orphan-auth-users',           source: { kind: 'vercel', cronPath: '/api/cron/sweep-orphan-auth-users' },             cronExpr: '0 7 * * *' },
  { heartbeatName: 'sweep-mfa-verified-sessions',       source: { kind: 'vercel', cronPath: '/api/cron/sweep-mfa-verified-sessions' },         cronExpr: '0 */6 * * *' },
  // Daily — most live in ml-cron.yml's multi-cron list
  { heartbeatName: 'ml-predict-inventory',  source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 11 * * *' },
  // 2026-05-24: removed `ml-aggregate-priors` — cross-fleet cohort
  // aggregation is a no-op at N<5 hotels per cohort. Cron still fires
  // (ml-cron.yml schedule) but its heartbeat isn't tracked.
  { heartbeatName: 'purge-old-error-logs',  source: { kind: 'github', workflowFile: 'purge-old-error-logs-cron.yml' }, cronExpr: '30 9 * * *' },
  { heartbeatName: 'agent-archive-stale-conversations', source: { kind: 'vercel', cronPath: '/api/cron/agent-archive-stale-conversations' },cronExpr: '0 3 * * *' },
  { heartbeatName: 'claude-sessions-purge',             source: { kind: 'vercel', cronPath: '/api/cron/claude-sessions-purge' },             cronExpr: '30 3 * * *' },
  { heartbeatName: 'agent-heal-counters',               source: { kind: 'vercel', cronPath: '/api/cron/agent-heal-counters' },              cronExpr: '0 4 * * *' },
  { heartbeatName: 'webhook-dedup-purge',               source: { kind: 'vercel', cronPath: '/api/cron/webhook-dedup-purge' },              cronExpr: '15 4 * * *' },
  { heartbeatName: 'pms-auth-codes-purge',              source: { kind: 'vercel', cronPath: '/api/cron/pms-auth-codes-purge' },             cronExpr: '45 4 * * *' },
  // Weekly
  { heartbeatName: 'ml-train-inventory',    source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 9 * * 0' },
  // Plan v4 (2026-05-24): removed `scraper-weekly-digest` — Railway
  // scraper observability cron.
  // Plan v4 (2026-05-23): replaces scraper/vercel-watchdog.js (Railway
  // process killed in the v4 cutover). Polls /api/admin/doctor every 5
  // min and alerts Sentry/SMS on fail with business-hours-only bumps.
  { heartbeatName: 'vercel-watchdog',       source: { kind: 'vercel', cronPath: '/api/cron/vercel-watchdog' },                  cronExpr: '*/5 * * * *' },
  // Plan v8 Phase B (migration 0217): every 5 min, flips
  // mapping_help_requests past expires_at from 'pending' to 'expired'
  // and deletes the corresponding screenshot objects from the
  // mapping-screenshots Supabase Storage bucket. Without this the
  // 15-min TTL pending rows + their screenshots would accumulate
  // forever.
  { heartbeatName: 'expire-help-requests', source: { kind: 'vercel', cronPath: '/api/cron/expire-help-requests' },                cronExpr: '*/5 * * * *' },
];
