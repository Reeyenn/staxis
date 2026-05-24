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
  // process-sms-jobs + scraper-health stayed on GH Actions per audit-02
  // (single-source-of-truth doctrine: all SMS-firing crons in one
  // observable channel).
  { heartbeatName: 'process-sms-jobs',                  source: { kind: 'github', workflowFile: 'sms-jobs-cron.yml' },                       cronExpr: '*/5 * * * *' },
  { heartbeatName: 'scraper-health',                    source: { kind: 'github', workflowFile: 'scraper-health-cron.yml' },                 cronExpr: '*/15 * * * *' },
  { heartbeatName: 'agent-nudges-check',                source: { kind: 'vercel', cronPath: '/api/agent/nudges/check' },                     cronExpr: '*/5 * * * *' },
  { heartbeatName: 'agent-sweep-reservations',          source: { kind: 'vercel', cronPath: '/api/cron/agent-sweep-reservations' },          cronExpr: '*/5 * * * *' },
  { heartbeatName: 'agent-summarize-long-conversations',source: { kind: 'vercel', cronPath: '/api/cron/agent-summarize-long-conversations' },cronExpr: '*/30 * * * *' },
  { heartbeatName: 'doctor-check',                      source: { kind: 'vercel', cronPath: '/api/cron/doctor-check' },                       cronExpr: '0 * * * *' },
  { heartbeatName: 'walkthrough-heal-stale',            source: { kind: 'vercel', cronPath: '/api/cron/walkthrough-heal-stale' },             cronExpr: '*/30 * * * *' },
  { heartbeatName: 'walkthrough-health-alert',          source: { kind: 'vercel', cronPath: '/api/cron/walkthrough-health-alert' },           cronExpr: '*/10 * * * *' },
  { heartbeatName: 'seed-rooms-daily',                  source: { kind: 'vercel', cronPath: '/api/cron/seed-rooms-daily' },                   cronExpr: '10 * * * *' },
  { heartbeatName: 'sweep-orphan-auth-users',           source: { kind: 'vercel', cronPath: '/api/cron/sweep-orphan-auth-users' },             cronExpr: '*/30 * * * *' },
  { heartbeatName: 'sweep-mfa-verified-sessions',       source: { kind: 'vercel', cronPath: '/api/cron/sweep-mfa-verified-sessions' },         cronExpr: '0 */6 * * *' },
  // Moved to Vercel native 2026-05-17 after a GH Actions scheduler stall
  // dropped 4 consecutive ticks and the doctor flagged seal-daily stale.
  { heartbeatName: 'seal-daily',                        source: { kind: 'vercel', cronPath: '/api/cron/seal-daily' },                          cronExpr: '5 * * * *' },
  // Daily — most live in ml-cron.yml's multi-cron list
  { heartbeatName: 'ml-run-inference',      source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '30 10 * * *' },
  { heartbeatName: 'ml-predict-inventory',  source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 11 * * *' },
  { heartbeatName: 'ml-aggregate-priors',   source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 12 * * *' },
  { heartbeatName: 'ml-shadow-evaluate',    source: { kind: 'github', workflowFile: 'ml-shadow-evaluate-cron.yml' }, cronExpr: '30 11 * * *' },
  { heartbeatName: 'purge-old-error-logs',  source: { kind: 'github', workflowFile: 'purge-old-error-logs-cron.yml' }, cronExpr: '30 9 * * *' },
  // schedule-auto-fill fires from two cron slots in the same workflow.
  // Both write the same heartbeat — the cadence stays 24h regardless of
  // which slot fired most recently.
  { heartbeatName: 'schedule-auto-fill',    source: { kind: 'github', workflowFile: 'schedule-auto-fill-cron.yml' }, cronExpr: '0 12 * * *' },
  { heartbeatName: 'schedule-auto-fill',    source: { kind: 'github', workflowFile: 'schedule-auto-fill-cron.yml' }, cronExpr: '0 1 * * *' },
  // expire-trials is a Vercel native cron (vercel.json), not GH Actions.
  { heartbeatName: 'expire-trials',                     source: { kind: 'vercel', cronPath: '/api/cron/expire-trials' },                    cronExpr: '0 9 * * *' },
  { heartbeatName: 'agent-archive-stale-conversations', source: { kind: 'vercel', cronPath: '/api/cron/agent-archive-stale-conversations' },cronExpr: '0 3 * * *' },
  { heartbeatName: 'claude-sessions-purge',             source: { kind: 'vercel', cronPath: '/api/cron/claude-sessions-purge' },             cronExpr: '30 3 * * *' },
  { heartbeatName: 'agent-heal-counters',               source: { kind: 'vercel', cronPath: '/api/cron/agent-heal-counters' },              cronExpr: '0 4 * * *' },
  { heartbeatName: 'webhook-dedup-purge',               source: { kind: 'vercel', cronPath: '/api/cron/webhook-dedup-purge' },              cronExpr: '15 4 * * *' },
  { heartbeatName: 'agent-weekly-digest',               source: { kind: 'vercel', cronPath: '/api/cron/agent-weekly-digest' },              cronExpr: '0 9 * * 0' },
  // Weekly
  { heartbeatName: 'ml-train-demand',       source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 8 * * 0' },
  { heartbeatName: 'ml-train-supply',       source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '30 8 * * 0' },
  { heartbeatName: 'ml-train-inventory',    source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 9 * * 0' },
  { heartbeatName: 'ml-retention-purge',    source: { kind: 'github', workflowFile: 'ml-retention-purge.yml' },      cronExpr: '0 8 * * *' },
  { heartbeatName: 'scraper-weekly-digest', source: { kind: 'github', workflowFile: 'scraper-weekly-digest-cron.yml' }, cronExpr: '0 14 * * 6' },
  // Plan v4 (2026-05-23): replaces scraper/vercel-watchdog.js (Railway
  // process killed in the v4 cutover). Polls /api/admin/doctor every 5
  // min and alerts Sentry/SMS on fail with business-hours-only bumps.
  { heartbeatName: 'vercel-watchdog',       source: { kind: 'vercel', cronPath: '/api/cron/vercel-watchdog' },                  cronExpr: '*/5 * * * *' },
];
