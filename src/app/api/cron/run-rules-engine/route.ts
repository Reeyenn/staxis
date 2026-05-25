/**
 * GET /api/cron/run-rules-engine
 *
 * Runs the cleaning-rules engine: reads the live pms_* tables, fires
 * the configured rules, and upserts the resulting tasks into
 * cleaning_tasks. Idempotent — re-running on the same PMS state
 * produces no observable change.
 *
 * Cadence: every 5 minutes via Vercel cron (see vercel.json). For
 * tighter latency on important state changes (e.g. departure flip,
 * new VIP arrival), the CUA worker can hit this endpoint with
 * `?propertyId=<uuid>` on demand — that's the entry point for the
 * sub-30s response path. Wiring up the CUA-side call is a separate
 * branch.
 *
 * Query params:
 *   propertyId (optional, uuid)  — run only this property
 *   dryRun     (optional, 'true') — evaluate rules but don't write
 *   verbose    (optional, 'true') — include per-room outcomes in the response
 *
 * Auth: CRON_SECRET bearer (shared with the rest of /api/cron/*).
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  runRulesEngineForAllProperties,
  runRulesEngineForProperty,
  type EngineOptions,
  type PropertyRunResult,
} from '@/lib/rules-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const url = new URL(req.url);
  const rawPropertyId = url.searchParams.get('propertyId');
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const verbose = url.searchParams.get('verbose') === 'true';

  if (rawPropertyId && !UUID_RE.test(rawPropertyId)) {
    return err('propertyId must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const opts: EngineOptions = { dryRun, verbose };

  try {
    let results: PropertyRunResult[];
    if (rawPropertyId) {
      results = [await runRulesEngineForProperty(rawPropertyId, opts)];
    } else {
      results = await runRulesEngineForAllProperties(opts);
    }

    const totals = results.reduce(
      (acc, r) => ({
        propertiesRun: acc.propertiesRun + 1,
        roomsEvaluated: acc.roomsEvaluated + r.rooms_evaluated,
        tasksUpserted: acc.tasksUpserted + r.tasks_upserted,
        tasksSkippedInProgress:
          acc.tasksSkippedInProgress + r.tasks_skipped_in_progress,
        roomsNoTask: acc.roomsNoTask + r.rooms_no_task,
        errorCount: acc.errorCount + r.errors.length,
      }),
      {
        propertiesRun: 0,
        roomsEvaluated: 0,
        tasksUpserted: 0,
        tasksSkippedInProgress: 0,
        roomsNoTask: 0,
        errorCount: 0,
      },
    );

    // Treat ANY property-level error as a degraded run. Without this,
    // the doctor saw a fresh `ok` heartbeat even when migration 0210 was
    // missing and every property's engine call was throwing — masking a
    // full engine outage as a healthy cron. (Post-merge sweep: Codex
    // Finding #4.)
    //
    // We also escalate the noise level: log.error ships to Sentry
    // (log.warn does not), so the operator actually sees the failure.
    if (totals.errorCount > 0) {
      log.error('[run-rules-engine] partial errors', {
        requestId,
        ...totals,
        errors: results.flatMap((r) =>
          r.errors.map((e) => ({ property_id: r.property_id, ...e })),
        ),
      });
    } else {
      // Structured success log so operators can answer "did the 9:05 run
      // actually create tasks?" from logs alone, without inspecting
      // discarded response bodies. (Codex Finding #12 — fixed alongside
      // the Critical heartbeat fix because it's the same observability gap.)
      log.info('[run-rules-engine] run completed', {
        requestId,
        ...totals,
        dryRun,
        scoped: Boolean(rawPropertyId),
      });
    }

    const degraded = totals.errorCount > 0;
    await writeCronHeartbeat('run-rules-engine', {
      requestId,
      status: degraded ? 'degraded' : 'ok',
      notes: {
        ...totals,
        dryRun,
        scoped: Boolean(rawPropertyId),
      },
    });

    return ok({ totals, perProperty: results }, { requestId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('[run-rules-engine] failed', { requestId, error: msg });
    return err(`rules engine failed: ${msg}`, {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
