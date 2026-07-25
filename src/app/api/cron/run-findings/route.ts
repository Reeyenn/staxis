/**
 * GET | POST /api/cron/run-findings
 *
 * Runs every registered detector for every hotel and reconciles what they found
 * against the findings ledger: a re-found problem UPDATES its existing row, a
 * silenced one stays quiet unless it outgrew the silence, and a problem that
 * stopped appearing expires. Writes only `findings` and `finding_runs` — the
 * detectors read, they never emit. cleaning_tasks, agent_nudges and agent_memory
 * are written by exactly the same code paths as before this route existed.
 *
 * DORMANT ON PURPOSE (2026-07-26). There is no vercel.json entry yet: the
 * ledger is inert until a later phase renders it, and the house convention
 * (see src/lib/cron-schedule-registry.ts) is that a route whose output nobody
 * can see yet stays unscheduled rather than burning a nightly pass per hotel.
 * To turn it on, four places:
 *   1. vercel.json                        → { "path": "/api/cron/run-findings", "schedule": "0 6 * * *" }
 *   2. src/lib/cron-schedule-registry.ts  → { heartbeatName: 'run-findings', source: { kind: 'vercel', cronPath: '/api/cron/run-findings' }, cronExpr: '0 6 * * *' }
 *   3. src/app/api/admin/doctor/route.ts  → EXPECTED_CRONS entry, cadenceHours: 24
 *   4. src/app/api/admin/mission/workers/route.ts → WORKER_META line
 * Until then it is callable by hand with the cron bearer, which is how Phase 2
 * will exercise it against a real hotel before scheduling it.
 *
 * Query params:
 *   propertyId (optional, uuid)   — run only this hotel
 *   dryRun     (optional, 'true') — detect and reconcile in memory, write nothing
 *
 * Auth: CRON_SECRET bearer (shared with the rest of /api/cron/*).
 */

import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  runFindingsForAllProperties,
  runFindingsForProperty,
  type FindingRunSummary,
} from '@/lib/findings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const url = new URL(req.url);
  const rawPropertyId = url.searchParams.get('propertyId');
  const dryRun = url.searchParams.get('dryRun') === 'true';

  if (rawPropertyId && !isUuid(rawPropertyId)) {
    return err('propertyId must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    let summaries: FindingRunSummary[];
    if (rawPropertyId) {
      summaries = [await runFindingsForProperty(rawPropertyId, { dryRun })];
    } else {
      summaries = (await runFindingsForAllProperties({ dryRun })).summaries;
    }

    const totals = summaries.reduce(
      (acc, s) => ({
        propertiesRun: acc.propertiesRun + 1,
        detectorsChecked: acc.detectorsChecked + s.detectorsChecked,
        detectorsSkipped: acc.detectorsSkipped + s.detectorsSkipped,
        detectorsFailed: acc.detectorsFailed + s.detectorsFailed,
        findingsOpened: acc.findingsOpened + s.findingsOpened,
        findingsUpdated: acc.findingsUpdated + s.findingsUpdated,
        findingsSuppressed: acc.findingsSuppressed + s.findingsSuppressed,
        findingsEscalated: acc.findingsEscalated + s.findingsEscalated,
        findingsExpired: acc.findingsExpired + s.findingsExpired,
        errorCount: acc.errorCount + s.errors.length,
      }),
      {
        propertiesRun: 0,
        detectorsChecked: 0,
        detectorsSkipped: 0,
        detectorsFailed: 0,
        findingsOpened: 0,
        findingsUpdated: 0,
        findingsSuppressed: 0,
        findingsEscalated: 0,
        findingsExpired: 0,
        errorCount: 0,
      },
    );

    // A detector that threw is a partial outage of the watcher. Escalate the
    // log level so it reaches Sentry and mark the heartbeat degraded, rather
    // than returning 200 over a night where nothing was actually checked.
    const degraded = totals.errorCount > 0 || totals.detectorsFailed > 0;
    if (degraded) {
      log.error('[run-findings] partial errors', {
        requestId,
        ...totals,
        errors: summaries.flatMap((s) =>
          s.errors.map((e) => ({ property_id: s.propertyId, ...e })),
        ),
      });
    } else {
      log.info('[run-findings] run completed', { requestId, ...totals, dryRun });
    }

    await writeCronHeartbeat('run-findings', {
      requestId,
      status: degraded ? 'degraded' : 'ok',
      notes: { ...totals, dryRun, scoped: Boolean(rawPropertyId) },
    });

    return ok({ totals, perProperty: summaries }, { requestId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('[run-findings] failed', { requestId, error: msg });
    return err(`findings run failed: ${msg}`, {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

/** Same handler, same auth — so a manual kick can use either verb. */
export async function POST(req: NextRequest) {
  return GET(req);
}
