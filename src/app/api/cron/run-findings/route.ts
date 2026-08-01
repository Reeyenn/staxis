/**
 * GET | POST /api/cron/run-findings — THE NIGHTLY PASS, END TO END.
 *
 * One route, three stages, in this order and no other:
 *
 *   1. DEMOTE   every check is measured against this hotel's own engagement.
 *               A check shown and ignored long enough steps down a rung; one
 *               that has run out of rungs rests and is not run tonight at all.
 *   2. DETECT   every remaining detector runs and what it found is reconciled
 *               against the ledger: a re-found problem UPDATES its existing row,
 *               a silenced one stays quiet unless it outgrew the silence, and a
 *               problem that stopped appearing expires.
 *   3. JUDGE    one batched model call per hotel sorts and phrases what is
 *               open, inside the per-hotel findings spend cap, falling back to
 *               deterministic phrasing on any failure.
 *
 * Chained deliberately rather than split into two crons: judging a half-written
 * picture of a hotel is worse than not judging it, and two schedules is two
 * chances for the second one not to fire.
 *
 * Writes `findings`, `finding_runs` and `finding_detector_state` — the detectors
 * read, they never emit. cleaning_tasks, agent_nudges and agent_memory are
 * written by exactly the same code paths as before this route existed.
 *
 * DORMANT ON PURPOSE (2026-07-26). There is no vercel.json entry: the founder
 * turns this on, not a deploy. To enable, two coordinated changes:
 *   1. vercel.json                        → { "path": "/api/cron/run-findings", "schedule": "0 6 * * *" }
 *   2. src/lib/automation/job-catalog.ts  → promote its staged row to active
 * Do not do it for this route alone. The AI layer goes on in one act, and
 * docs/cron-triggers.md, "The AI master switch", is the single checklist that
 * covers all four of its crons (this one, findings-sweep, findings-janitor and
 * run-management-patterns).
 * Until then it is callable by hand with the cron bearer, which is how it gets
 * exercised against a real hotel before it is ever scheduled.
 *
 * Query params:
 *   propertyId (optional, uuid)   — run only this hotel
 *   dryRun     (optional, 'true') — detect and reconcile in memory, write
 *                                   nothing, and skip both the demotion pass
 *                                   and the judge
 *   rearm      (optional, string) — put one rested check back on duty at the
 *                                   named hotel and run nothing else. Requires
 *                                   propertyId. This is the "re-armable" half
 *                                   of self-demotion; it lives here rather than
 *                                   behind a new admin route because it is one
 *                                   operator action on the same subsystem.
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
  rearmDetector,
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
  const rearm = (url.searchParams.get('rearm') ?? '').trim();

  if (rawPropertyId && !isUuid(rawPropertyId)) {
    return err('propertyId must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  // Re-arming is a decision about ONE hotel's check, and doing it fleet-wide by
  // forgetting a parameter would silently undo every demotion the system has
  // ever earned. It requires the hotel to be named.
  if (rearm) {
    if (!rawPropertyId) {
      return err('rearm requires propertyId', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    const result = await rearmDetector(rawPropertyId, rearm);
    log.info('[run-findings] detector re-armed by hand', {
      requestId,
      propertyId: rawPropertyId,
      detectorId: rearm,
      changed: result.changed,
    });
    return ok({ rearmed: result }, { requestId });
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
        // "N checks resting" — a check this hotel ignored into silence. Counted
        // apart from skipped, which means the data was not there.
        detectorsDormant: acc.detectorsDormant + s.detectorsDormant,
        demotions: acc.demotions + s.demotions.length,
        // Checks that got LOUDER tonight, because somebody took them up again.
        // Counted apart from demotions — one number holding both directions
        // would report a quiet night and a busy one identically.
        rearms: acc.rearms + s.rearms.length,
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
        detectorsDormant: 0,
        demotions: 0,
        rearms: 0,
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
