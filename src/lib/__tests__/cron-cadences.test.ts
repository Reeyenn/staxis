/**
 * Drift-prevention test for the doctor's cron freshness check.
 *
 * Why this exists:
 *   The doctor's `cron_heartbeats_fresh` check uses an EXPECTED_CRONS
 *   array that encodes "this workflow runs every N hours". Each entry
 *   pairs with a `.github/workflows/*.yml` file containing the actual
 *   cron schedule. If those drift — e.g., someone changes a workflow's
 *   schedule from every-5-min to every-10-min but forgets to update
 *   the doctor — the freshness check will fire false alarms (or worse,
 *   silently allow a slowed-down cron). May 2026 audit pass-6 caught
 *   exactly this: `process-sms-jobs` was listed at 3-min cadence in
 *   the doctor, but the workflow had always been every-5-min. Post-
 *   deploy smoke test flaked for three commits straight before the
 *   misalignment was caught by hand.
 *
 *   These tests are the permanent fix. They run on every PR (joined
 *   to the existing `npm run test` suite) and fail with a clear
 *   message naming the file and the drifted value if anyone ever
 *   changes the cadence in one place without the other.
 *
 * Scope: the three known directions of drift —
 *   1) Workflow file's cron expression changes (or someone renames
 *      the file) without updating the registry.
 *   2) EXPECTED_CRONS.cadenceHours disagrees with the cron expression
 *      it claims to represent.
 *   3) A cron name appears in one source but not the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXPECTED_CRONS } from '@/app/api/admin/doctor/route';

/**
 * Single source of truth — what each cron heartbeat is supposed to fire
 * at, and where its schedule lives (GitHub Actions workflow file OR
 * vercel.json). Add a new row here whenever you wire up a new cron.
 *
 * cronExpr must be the EXACT string from the source file. For GH
 * workflows the test accepts either single or double quotes around
 * the value; for vercel.json it must appear in the JSON `schedule`
 * field exactly.
 */
type ScheduleSource =
  | { kind: 'github'; workflowFile: string }
  | { kind: 'vercel' };

const SCHEDULE_REGISTRY: ReadonlyArray<{
  heartbeatName: string;
  source: ScheduleSource;
  cronExpr: string;
}> = [
  // Tight cadences (sub-hourly) — Vercel native cron (May 2026 audit
  // pass-6: moved from GH Actions, which was silently throttling these
  // to 60-200 min intervals). Vercel Pro supports per-minute precision.
  { heartbeatName: 'process-sms-jobs',      source: { kind: 'vercel' },                                              cronExpr: '*/5 * * * *' },
  { heartbeatName: 'scraper-health',        source: { kind: 'vercel' },                                              cronExpr: '*/15 * * * *' },
  // seal-daily stays on GH Actions — hourly cadence is well within
  // GH's reliable range.
  { heartbeatName: 'seal-daily',            source: { kind: 'github', workflowFile: 'seal-daily-cron.yml' },         cronExpr: '5 * * * *' },
  // Daily — most live in ml-cron.yml's multi-cron list
  { heartbeatName: 'ml-run-inference',      source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '30 10 * * *' },
  { heartbeatName: 'ml-predict-inventory',  source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 11 * * *' },
  { heartbeatName: 'ml-aggregate-priors',   source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 12 * * *' },
  { heartbeatName: 'ml-shadow-evaluate',    source: { kind: 'github', workflowFile: 'ml-shadow-evaluate-cron.yml' }, cronExpr: '30 11 * * *' },
  { heartbeatName: 'purge-old-error-logs',  source: { kind: 'github', workflowFile: 'purge-old-error-logs-cron.yml' }, cronExpr: '30 9 * * *' },
  // expire-trials is a Vercel native cron (vercel.json), not GH Actions.
  { heartbeatName: 'expire-trials',         source: { kind: 'vercel' },                                              cronExpr: '0 9 * * *' },
  // Weekly
  { heartbeatName: 'ml-train-demand',       source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 8 * * 0' },
  { heartbeatName: 'ml-train-supply',       source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '30 8 * * 0' },
  { heartbeatName: 'ml-train-inventory',    source: { kind: 'github', workflowFile: 'ml-cron.yml' },                 cronExpr: '0 9 * * 0' },
  { heartbeatName: 'scraper-weekly-digest', source: { kind: 'github', workflowFile: 'scraper-weekly-digest-cron.yml' }, cronExpr: '0 14 * * 6' },
];

/**
 * Convert a cron expression to cadence-in-hours. Handles the patterns
 * our workflows actually use. Not a general-purpose parser — if a future
 * cron uses something more exotic (multiple time fields, day lists,
 * ranges), extend this and add a test case.
 *
 * Pattern recognition (cron field order is minute hour dom month dow):
 *   every-N-minutes form    (e.g. star-slash-5 in the minute field) → N/60 hours
 *   numeric minute, star elsewhere                                   → 1 hour (hourly)
 *   numeric minute + hour, dom/month/dow all star                    → 24 hours (daily)
 *   numeric minute + hour, dow numeric, dom/month star               → 168 hours (weekly)
 *
 * Throws a clear error on unrecognized shapes (or on a wildcard minute,
 * which would fire every minute) so a new cron forces an explicit
 * decision rather than silently being treated as 1h.
 */
export function cadenceHoursFromCron(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron "${cron}" does not have 5 fields (minute hour dom month dow)`);
  }
  const [minute, hour, dom, month, dow] = parts;

  // Every-N-minutes form. Reject `* * * * *` (every minute) — we never
  // want a workflow that tight, and accepting it would mask typos.
  if (minute.startsWith('*/')) {
    const n = Number(minute.slice(2));
    if (!Number.isFinite(n) || n < 1 || n > 59) {
      throw new Error(`cron "${cron}" has unsupported minute step "${minute}"`);
    }
    if (hour !== '*' || dom !== '*' || month !== '*' || dow !== '*') {
      throw new Error(`cron "${cron}" combines */N minutes with constrained hour/day — unhandled shape`);
    }
    return n / 60;
  }
  if (minute === '*') {
    throw new Error(`cron "${cron}" uses '*' for minute — that would fire every minute, refusing to compute cadence`);
  }

  // Numeric minute. Distinguish hourly / daily / weekly by which higher
  // fields are constrained.
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 1; // every hour at minute M
  }
  if (hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    return 24; // once per day at H:M
  }
  if (hour !== '*' && dom === '*' && month === '*' && dow !== '*') {
    return 168; // once per week at H:M on day D
  }

  throw new Error(`cron "${cron}" has unrecognized shape — add a case to cadenceHoursFromCron()`);
}

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows');
const VERCEL_JSON_PATH = join(process.cwd(), 'vercel.json');

describe('cron cadences', () => {
  describe('cadenceHoursFromCron', () => {
    it('parses every-N-minutes form', () => {
      assert.equal(cadenceHoursFromCron('*/5 * * * *'),  5 / 60);
      assert.equal(cadenceHoursFromCron('*/15 * * * *'), 15 / 60);
      assert.equal(cadenceHoursFromCron('*/30 * * * *'), 30 / 60);
    });
    it('parses hourly form', () => {
      assert.equal(cadenceHoursFromCron('5 * * * *'), 1);
      assert.equal(cadenceHoursFromCron('0 * * * *'), 1);
    });
    it('parses daily form', () => {
      assert.equal(cadenceHoursFromCron('30 10 * * *'), 24);
      assert.equal(cadenceHoursFromCron('0 11 * * *'),  24);
    });
    it('parses weekly form', () => {
      assert.equal(cadenceHoursFromCron('0 8 * * 0'),  168);
      assert.equal(cadenceHoursFromCron('0 14 * * 6'), 168);
    });
    it('rejects every-minute and unrecognized shapes', () => {
      assert.throws(() => cadenceHoursFromCron('* * * * *'), /every minute/);
      assert.throws(() => cadenceHoursFromCron('5 * 1 * *'), /unrecognized/);
      assert.throws(() => cadenceHoursFromCron('not enough fields'), /5 fields/);
    });
  });

  it('every source file contains the expected cron expression', () => {
    for (const entry of SCHEDULE_REGISTRY) {
      if (entry.source.kind === 'github') {
        const path = join(WORKFLOWS_DIR, entry.source.workflowFile);
        const content = readFileSync(path, 'utf8');
        const hasSingleQuoted = content.includes(`cron: '${entry.cronExpr}'`);
        const hasDoubleQuoted = content.includes(`cron: "${entry.cronExpr}"`);
        assert.ok(
          hasSingleQuoted || hasDoubleQuoted,
          `${path} does not contain the cron schedule \`${entry.cronExpr}\` for heartbeat ` +
          `"${entry.heartbeatName}". Either the workflow drifted (update SCHEDULE_REGISTRY ` +
          `to match) or the registry above is stale (update the workflow).`,
        );
      } else {
        // Vercel native cron — vercel.json's crons[] array.
        const content = readFileSync(VERCEL_JSON_PATH, 'utf8');
        const json = JSON.parse(content) as { crons?: Array<{ path: string; schedule: string }> };
        const match = (json.crons ?? []).find((c) => c.path.endsWith(`/${entry.heartbeatName}`));
        assert.ok(
          match,
          `vercel.json crons[] has no entry for path ending with "/${entry.heartbeatName}". ` +
          `Either add one with schedule "${entry.cronExpr}" or remove this row from SCHEDULE_REGISTRY.`,
        );
        assert.equal(
          match.schedule, entry.cronExpr,
          `vercel.json crons[] entry for "${entry.heartbeatName}" has schedule "${match.schedule}" ` +
          `but SCHEDULE_REGISTRY expects "${entry.cronExpr}".`,
        );
      }
    }
  });

  it('every heartbeatName has a matching EXPECTED_CRONS entry with the right cadenceHours', () => {
    for (const entry of SCHEDULE_REGISTRY) {
      const expected = EXPECTED_CRONS.find((c) => c.name === entry.heartbeatName);
      assert.ok(
        expected,
        `EXPECTED_CRONS in src/app/api/admin/doctor/route.ts is missing an entry for ` +
        `"${entry.heartbeatName}". Add { name: '${entry.heartbeatName}', cadenceHours: ` +
        `${cadenceHoursFromCron(entry.cronExpr)}, description: '...' }.`,
      );
      const computed = cadenceHoursFromCron(entry.cronExpr);
      const sourceLabel = entry.source.kind === 'github'
        ? entry.source.workflowFile
        : 'vercel.json';
      assert.equal(
        Number(expected.cadenceHours.toFixed(6)),
        Number(computed.toFixed(6)),
        `Heartbeat "${entry.heartbeatName}": doctor's EXPECTED_CRONS says ` +
        `cadenceHours=${expected.cadenceHours}, but the cron expression \`${entry.cronExpr}\` ` +
        `in ${sourceLabel} works out to ${computed}. Update one of them so they agree.`,
      );
    }
  });

  it('every EXPECTED_CRONS entry has a matching SCHEDULE_REGISTRY entry', () => {
    // Reverse-direction drift: a new cron name showed up in the doctor
    // but nobody added the workflow → registry entry. Without this
    // assertion, the doctor would silently report "missing heartbeat"
    // forever.
    for (const c of EXPECTED_CRONS) {
      const entry = SCHEDULE_REGISTRY.find((e) => e.heartbeatName === c.name);
      assert.ok(
        entry,
        `EXPECTED_CRONS has "${c.name}" but SCHEDULE_REGISTRY in this test does not. ` +
        `Add an entry { heartbeatName: '${c.name}', workflowFile: '<file>.yml', cronExpr: '...' }.`,
      );
    }
  });
});
