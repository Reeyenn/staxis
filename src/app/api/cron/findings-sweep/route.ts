/**
 * GET | POST /api/cron/findings-sweep — THE WEEKLY DISCOVERY PASS.
 *
 * Picks a rotating SAMPLE of hotels (never-swept first, then longest-since),
 * and for each one: aggregates its own numbers, asks a model in a single call
 * what looks odd that nothing already watches, then re-queries the hotel's real
 * data to test every suggestion. Whatever cannot be reproduced is logged and
 * dies. Whatever survives becomes either a recommendation at that hotel or —
 * only once two hotels on the same PMS family have independently reproduced it
 * — a property-agnostic PROPOSAL in the founder's promotion queue. Nothing
 * registers itself as a detector; a human still decides.
 *
 * WHY SAMPLED, AND WHY THAT MAKES IT CHEAP
 * A finding is about one hotel; a detector is about all of them. Whatever is
 * learned at three hotels generalises, so sweeping every hotel every week buys
 * repetition. Every call also passes through the SAME per-hotel-per-day
 * findings spend cap the nightly judge reserves against — over the cap, the
 * hotel is skipped and the run row says so.
 *
 * Writes `finding_sweep_runs` (always, including on a skip — a sweep that never
 * ran and a sweep that found nothing must be tellable apart), `findings` for
 * local recommendations, and `knowledge_promotions` via staxis_propose_promotion
 * for the rare candidate that clears the bar.
 *
 * DORMANT ON PURPOSE (2026-07-26). There is no vercel.json entry: the founder
 * turns this on, not a deploy. To enable, four places:
 *   1. vercel.json                        → { "path": "/api/cron/findings-sweep", "schedule": "0 7 * * 1" }
 *   2. src/lib/cron-schedule-registry.ts  → { heartbeatName: 'findings-sweep', source: { kind: 'vercel', cronPath: '/api/cron/findings-sweep' }, cronExpr: '0 7 * * 1' }
 *   3. src/app/api/admin/doctor/route.ts  → EXPECTED_CRONS entry, cadenceHours: 168
 *   4. src/app/api/admin/mission/workers/route.ts → WORKER_META line
 * Do not do it for this route alone. The AI layer goes on in one act, and
 * docs/cron-triggers.md, "The AI master switch", is the single checklist that
 * covers all four of its crons (this one, run-findings, findings-janitor and
 * run-management-patterns).
 * Weekly, on a Monday, AFTER the nightly run — the sweep is more useful when it
 * can see what the detectors currently have open.
 *
 * Query params:
 *   propertyId (optional, uuid) — sweep exactly this hotel, ignoring the sample
 *   sample     (optional, int)  — how many hotels to sweep, 1-25
 *
 * Auth: CRON_SECRET bearer (shared with the rest of /api/cron/*).
 */

import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { SWEEP_SAMPLE_SIZE, sweepFleet } from '@/lib/findings/sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const url = new URL(req.url);
  const rawPropertyId = url.searchParams.get('propertyId');
  const rawSample = url.searchParams.get('sample');

  if (rawPropertyId && !isUuid(rawPropertyId)) {
    return err('propertyId must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const sampleSize = rawSample ? Number(rawSample) : SWEEP_SAMPLE_SIZE;
  if (!Number.isFinite(sampleSize) || sampleSize < 1 || sampleSize > 25) {
    return err('sample must be between 1 and 25', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const result = await sweepFleet({
      sampleSize,
      propertyIds: rawPropertyId ? [rawPropertyId] : undefined,
    });

    const totals = result.runs.reduce(
      (acc, run) => ({
        hotelsSwept: acc.hotelsSwept + 1,
        hypotheses: acc.hypotheses + run.hypotheses,
        reproduced: acc.reproduced + run.reproduced,
        // The hallucination filter's miss rate, in the cron response as well as
        // in the ledger. A number nobody can see is a number nobody checks.
        irreproducible: acc.irreproducible + run.irreproducible,
        candidatesLocal: acc.candidatesLocal + run.candidatesLocal,
        candidatesPromoted: acc.candidatesPromoted + run.candidatesPromoted,
        skippedForCap: acc.skippedForCap + (run.mode === 'skipped_cap' ? 1 : 0),
        costUsd: Math.round((acc.costUsd + run.costUsd) * 1e6) / 1e6,
      }),
      {
        hotelsSwept: 0,
        hypotheses: 0,
        reproduced: 0,
        irreproducible: 0,
        candidatesLocal: 0,
        candidatesPromoted: 0,
        skippedForCap: 0,
        costUsd: 0,
      },
    );

    // A provider outage is not a degraded sweep, it is a sweep that did not
    // happen — and the next weekly pass will pick the same hotels up again,
    // because the rotation is "longest since swept" and a failed run still
    // records. Degraded is therefore about the ones that broke, not the ones
    // that found nothing.
    const broken = result.runs.filter(
      (run) => run.mode === 'fallback_error' || run.mode === 'fallback_malformed',
    );
    const degraded = broken.length > 0;
    if (degraded) {
      log.error('[findings-sweep] some hotels produced nothing usable', {
        requestId,
        ...totals,
        broken: broken.map((run) => ({ property_id: run.propertyId, mode: run.mode })),
      });
    } else {
      log.info('[findings-sweep] weekly pass completed', {
        requestId,
        eligible: result.eligible,
        ...totals,
      });
    }

    await writeCronHeartbeat('findings-sweep', {
      requestId,
      status: degraded ? 'degraded' : 'ok',
      notes: { ...totals, eligible: result.eligible, scoped: Boolean(rawPropertyId) },
    });

    return ok(
      {
        totals,
        eligible: result.eligible,
        sampled: result.sampled,
        perProperty: result.runs,
      },
      { requestId },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('[findings-sweep] failed', { requestId, error: msg });
    return err(`findings sweep failed: ${msg}`, {
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
