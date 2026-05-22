/**
 * GET /api/cron/ml-auto-rollback
 *
 * Daily cron at 06:45 CDT (11:45 UTC). Triggers the Phase 7 v2 auto-rollback
 * pipeline on the ml-service:
 *
 *   1. Backfill prediction_log over the 3-day correction window.
 *   2. For each (property, layer) with an active fitted housekeeping
 *      model and n>=21 mature paired observations, run the paired
 *      Wilcoxon signed-rank test (active vs same-DOW historical actual).
 *   3. Apply 14-day cooldown filter (skip recently-rolled-back pairs).
 *   4. Apply Benjamini-Hochberg false-discovery correction at
 *      AUTO_ROLLBACK_FDR_ALPHA across the fleet.
 *   5. For each surviving rejection, execute_rollback (dry-run or live).
 *
 * For every rollback (real OR dry-run-would-fire), writes one row to
 * app_events.event_type='ml_auto_rollback_fired' with full diagnostics.
 * Real fires also Sentry.captureMessage at 'error' severity so on-call
 * gets a high-severity alert.
 *
 * Why a separate cron from ml-shadow-evaluate: shadow-evaluate is the
 * inventory-style shadow promotion gate (validation_mae comparison).
 * Auto-rollback is the post-deployment drift detector. Different
 * statistic, different cadence, different failure modes — orthogonal.
 *
 * Auth: Bearer ${CRON_SECRET}, matching the other ml-cron routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { classifyMlServiceConfig, listMlShardUrls } from '@/lib/ml-routing';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The orchestrator runs backfill + check + execute serially across
// all properties. Pro plan maxDuration is 300s; the ml-service-side
// timeout is bounded by the AbortSignal.timeout below.
export const maxDuration = 300;

interface PairResult {
  property_id: string;
  layer: 'demand' | 'supply';
  decision:
    | 'evaluated'
    | 'no_data'
    | 'cooldown_skip'
    | 'rollback_indicated'
    | 'rejection_dismissed_direction';
  active_mae: number | null;
  baseline_mae: number | null;
  pvalue: number | null;
  adjusted_pvalue: number | null;
  execute?: {
    decision?: string;
    deactivated_model_run_id?: string | null;
    active_model_run_id?: string | null;
    dry_run?: boolean;
    error?: string;
  };
}

interface OrchestratorResponse {
  phase_backfill?: Record<string, unknown>;
  phase_check?: {
    pairs_evaluated?: number;
    pairs_no_data?: number;
    pairs_cooldown_skip?: number;
    pairs_rollback_indicated?: number;
  };
  rollbacks_fired?: number;
  dry_run_would_fire?: number;
  execute_failures?: Array<{ property_id: string; layer: string; error?: string }>;
  dry_run?: boolean;
  alpha?: number;
  results?: PairResult[];
  error?: string;
}

/** Best-effort app_events writer. NEVER throws — failure to log an
 *  event must not stop the cron from finishing the rest of the fleet. */
async function writeRollbackEvent(
  pair: PairResult,
  fired: boolean,
  requestId: string,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('app_events').insert({
      event_type: 'ml_auto_rollback_fired',
      property_id: pair.property_id,
      payload: {
        layer: pair.layer,
        active_mae: pair.active_mae,
        baseline_mae: pair.baseline_mae,
        pvalue: pair.pvalue,
        adjusted_pvalue: pair.adjusted_pvalue,
        deactivated_model_run_id: pair.execute?.deactivated_model_run_id ?? null,
        active_model_run_id: pair.execute?.active_model_run_id ?? null,
        dry_run: pair.execute?.dry_run ?? !fired,
        request_id: requestId,
      },
    });
    if (error) {
      log.warn('ml-auto-rollback: app_events insert failed', {
        requestId, error: error.message ?? String(error),
        property_id: pair.property_id, layer: pair.layer,
      });
    }
  } catch (e) {
    log.warn('ml-auto-rollback: app_events insert threw', {
      requestId, err: e as Error,
      property_id: pair.property_id, layer: pair.layer,
    });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const config = classifyMlServiceConfig();
  if (config.state === 'disabled') {
    log.warn('ml-auto-rollback: ML service not configured — skipping', { requestId });
    return NextResponse.json({ ok: true, skipped: 'ML service not configured yet', requestId });
  }
  if (config.state === 'drift') {
    log.error('ml-auto-rollback: ML service config drift', { requestId, missing: config.missing });
    return NextResponse.json(
      { ok: false, error: 'ml_service_config_drift', missing: config.missing, requestId },
      { status: 503 },
    );
  }
  const { secret: mlServiceSecret } = config;

  // Single-shard call to the FIRST configured shard. The orchestrator
  // queries Supabase (shared across shards) for all eligible properties
  // and processes them all in one batch. We intentionally do NOT split
  // across shards because the BH-FDR correction MUST run across the
  // whole fleet in one batch — sharding the p-values would defeat the
  // FDR control. The work is mostly Supabase queries + scipy on small
  // arrays, so concentrating it on one Railway instance is fine.
  const shardUrls = listMlShardUrls();
  if (shardUrls.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'ml_service_url_unresolved', requestId },
      { status: 503 },
    );
  }
  const mlServiceUrl = shardUrls[0];

  const t0 = Date.now();
  let orchestrator: OrchestratorResponse;
  try {
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/monitor/run-daily-rollback-pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({}), // empty body = process all properties
      signal: AbortSignal.timeout(280_000),
    });
    orchestrator = await res.json().catch(() => ({ error: 'non_json_response' }) as OrchestratorResponse);
    if (!res.ok) {
      log.error('ml-auto-rollback: orchestrator HTTP non-2xx', {
        requestId, status: res.status, body: orchestrator,
      });
      return NextResponse.json(
        { ok: false, error: 'orchestrator_failed', detail: orchestrator, requestId },
        { status: 502 },
      );
    }
  } catch (e) {
    log.error('ml-auto-rollback: orchestrator unreachable', { requestId, err: e as Error });
    return NextResponse.json(
      { ok: false, error: errToString(e), requestId },
      { status: 502 },
    );
  }

  const elapsedMs = Date.now() - t0;
  const dryRun = orchestrator.dry_run ?? true;
  const rolledBackPairs = (orchestrator.results ?? []).filter(
    (r) => r.execute?.decision === 'rolled_back' || r.execute?.decision === 'would_fire',
  );

  // Write one app_events row per fire (real or dry-run). Sentry-capture
  // ONLY on real fires (dry-run logs are not on-call-worthy).
  for (const pair of rolledBackPairs) {
    const fired = pair.execute?.decision === 'rolled_back';
    await writeRollbackEvent(pair, fired, requestId);
    if (fired) {
      try {
        Sentry.captureMessage('ml_auto_rollback_fired', {
          level: 'error',
          extra: {
            property_id: pair.property_id,
            layer: pair.layer,
            active_mae: pair.active_mae,
            baseline_mae: pair.baseline_mae,
            pvalue: pair.pvalue,
            adjusted_pvalue: pair.adjusted_pvalue,
            deactivated_model_run_id: pair.execute?.deactivated_model_run_id,
            request_id: requestId,
          },
        });
      } catch (e) {
        log.warn('ml-auto-rollback: Sentry capture failed', { requestId, err: e as Error });
      }
    }
  }

  await writeCronHeartbeat('ml-auto-rollback', {
    requestId,
    notes: {
      dry_run: dryRun,
      rollbacks_fired: orchestrator.rollbacks_fired ?? 0,
      dry_run_would_fire: orchestrator.dry_run_would_fire ?? 0,
      pairs_evaluated: orchestrator.phase_check?.pairs_evaluated ?? 0,
      execute_failures: (orchestrator.execute_failures ?? []).length,
      elapsed_ms: elapsedMs,
    },
  });

  log.info('ml-auto-rollback: pass complete', {
    requestId,
    dryRun,
    rollbacks_fired: orchestrator.rollbacks_fired,
    dry_run_would_fire: orchestrator.dry_run_would_fire,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    requestId,
    dry_run: dryRun,
    rollbacks_fired: orchestrator.rollbacks_fired ?? 0,
    dry_run_would_fire: orchestrator.dry_run_would_fire ?? 0,
    pairs_evaluated: orchestrator.phase_check?.pairs_evaluated ?? 0,
    pairs_no_data: orchestrator.phase_check?.pairs_no_data ?? 0,
    pairs_cooldown_skip: orchestrator.phase_check?.pairs_cooldown_skip ?? 0,
    execute_failures: orchestrator.execute_failures ?? [],
    elapsed_ms: elapsedMs,
  });
}
