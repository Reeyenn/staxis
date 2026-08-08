/**
 * GET /api/inventory/ai-status?propertyId=<uuid>
 *
 * Live status JSON for the AI Helper overlay on `/inventory`. Returns:
 *   - aiMode                     — 'off' | 'auto' | 'always-on'
 *   - daysSinceFirstCount
 *   - itemsTotal / itemsWithModel / itemsGraduated / itemsExpectedToGraduate
 *   - overfitRatio               — average validation_mae/training_mae across active
 *                                  models. Indicates fit-tightness (model overfitting),
 *                                  NOT the activation gate. Renamed from currentMaeRatio
 *                                  in honesty-audit Phase 2 (2026-05-22) — same number,
 *                                  honest name.
 *   - currentMaeRatioVsMean      — average validation_mae/mean_observed_rate. This IS
 *                                  the activation-gate ratio (see
 *                                  ml-service/src/training/inventory_rate.py
 *                                  inventory_graduation_mae_ratio < 0.10). Reads
 *                                  hyperparameters.mean_observed_rate from each
 *                                  active model_run. Returns null until the trainer
 *                                  populates that field on next retrain (~7 days).
 *                                  This is what "% off" in the UI SHOULD have been
 *                                  showing all along — overfitRatio (val/train) was
 *                                  the wrong number.
 *   - currentMaeRatio            — @deprecated alias for overfitRatio. Kept one
 *                                  release so existing UI readers (CountSheet/
 *                                  SimpleSheet) don't break atomically when ai-status
 *                                  ships before the UI cutover (Phase 4).
 *   - lastInferenceAt            — ISO timestamp of most-recent prediction row.
 *   - lastInferenceStale         — true when lastInferenceAt is null OR older than 26h.
 *                                  Threshold picked to flag a single missed daily cron
 *                                  with 2h grace, surfacing BEFORE the doctor's
 *                                  ~48h heartbeat warn threshold so operators see
 *                                  the signal in the GM UI before the doctor alerts.
 *   - predictionsLast7Days       — count of inventory_rate_predictions rows in the
 *                                  last 7 days. 0 with itemsWithModel>0 indicates a
 *                                  probable cron outage even if lastInferenceAt looks
 *                                  fresh (e.g. one prediction landed yesterday but
 *                                  the cron has been failing for a week).
 *
 * Auth: the shared request authorization facade. The page is reachable by any
 * authenticated user with property access (not just owner).
 *
 * The page renders these numbers in plain English for the GM:
 *   "Day 12. The AI has learned 23 of your 87 items well. 4 items are
 *    confident enough to auto-fill. We expect another 12 to graduate in
 *    the next 2 weeks."
 */

import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { createRequestAuthorization } from '@/lib/authorization/request';
import { inventoryAiAuthorizationRefusalResponse } from '@/lib/inventory-ai-authorization';
import {
  activeInventoryItemIds,
  filterInventoryMlRowsToActiveItems,
} from '@/lib/inventory-ml-active';
import { err, ApiErrorCode } from '@/lib/api-response';
import {
  fetchInventoryAiRows,
  inventoryAiUnavailableResponse,
  requireInventoryAiResult,
} from '@/lib/inventory-ai-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// Honesty-audit Phase 2: stale-inference threshold. One missed daily cron
// (24h) + 2h grace = 26h. The doctor's cron_heartbeats_fresh check warns at
// roughly cadenceHours*2 + skew ≈ 48.25h for daily crons (see
// src/app/api/admin/doctor/route.ts:2310-2316). Surfacing stale at 26h in the
// GM-facing UI gives operators earlier signal that "something needs checking"
// before the doctor pages.
const STALE_INFERENCE_HOURS = 26;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const authorization = createRequestAuthorization(req, { requestId });
  const session = await authorization.requireSession();
  if (!session.ok) return session.response;

  const propertyId = new URL(req.url).searchParams.get('propertyId');
  if (!isUuid(propertyId)) {
    return err('invalid_property_id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const hotel = await session.authorizeHotel({
    propertyId,
    intent: 'read',
    checks: [{ kind: 'section', section: 'inventory' }],
  });
  if (!hotel.ok) return inventoryAiAuthorizationRefusalResponse(hotel, requestId);

  try {
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();

    // Use the service-role client so the multi-table aggregate doesn't fight
    // RLS. The auth check above guarantees the caller is authorized.
    const [propRes, countRes, itemRows, runRows, predictionRows, predictionsLast7Rows] = await Promise.all([
      supabaseAdmin
        .from('properties')
        .select('inventory_ai_mode')
        .eq('id', propertyId)
        .maybeSingle(),
      supabaseAdmin
        .from('inventory_counts')
        .select('id,counted_at')
        .eq('property_id', propertyId)
        .order('counted_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle(),
      fetchInventoryAiRows<{ id: string }>(
        'inventory items',
        (from, to) => supabaseAdmin
          .from('inventory')
          .select('id')
          .eq('property_id', propertyId)
          .is('archived_at', null)
          .order('id', { ascending: true })
          .range(from, to),
        2_000,
      ),
      fetchInventoryAiRows<{
        id: string;
        item_id: string | null;
        validation_mae: number | null;
        training_mae: number | null;
        auto_fill_enabled: boolean | null;
        training_row_count: number | null;
        consecutive_passing_runs: number | null;
        hyperparameters: Record<string, unknown> | null;
      }>(
        'active inventory model runs',
        (from, to) => supabaseAdmin
          .from('model_runs')
          // Also pull `hyperparameters` (JSONB) for the persisted
          // mean_observed_rate used by the true activation-gate ratio.
          .select('id,item_id,validation_mae,training_mae,auto_fill_enabled,training_row_count,consecutive_passing_runs,hyperparameters')
          .eq('property_id', propertyId)
          .eq('layer', 'inventory_rate')
          .eq('is_active', true)
          .order('id', { ascending: true })
          .range(from, to),
        2_000,
      ),
      fetchInventoryAiRows<{ id: string; item_id: string | null; predicted_at: string | null }>(
        'latest inventory inference',
        (from, to) => supabaseAdmin
          .from('inventory_rate_predictions')
          .select('id,item_id,predicted_at')
          .eq('property_id', propertyId)
          .order('predicted_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
        50_000,
      ),
      // Seven days is bounded by active item count × seven daily writes. Pull
      // item ids so archived items can be excluded from the health signal.
      fetchInventoryAiRows<{ id: string; item_id: string | null; predicted_at: string | null }>(
        'seven-day inventory predictions',
        (from, to) => supabaseAdmin
          .from('inventory_rate_predictions')
          .select('id,item_id,predicted_at')
          .eq('property_id', propertyId)
          .gte('predicted_at', sevenDaysAgoIso)
          .order('predicted_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
        50_000,
      ),
    ]);

    const property = requireInventoryAiResult('property AI mode', propRes);
    const firstCount = requireInventoryAiResult('first inventory count', countRes);
    const aiMode = ((property?.inventory_ai_mode ?? 'auto') as string) as 'off' | 'auto' | 'always-on';
    const firstCountAt = firstCount?.counted_at ? new Date(firstCount.counted_at).getTime() : null;
    const daysSinceFirstCount = firstCountAt
      ? Math.max(0, Math.floor((Date.now() - firstCountAt) / 86400000))
      : 0;
    const activeItemIds = activeInventoryItemIds(itemRows);
    const itemsTotal = activeItemIds.size;
    const runs = filterInventoryMlRowsToActiveItems(runRows, activeItemIds);
    const itemsWithModel = runs.length;
    const itemsGraduated = runs.filter((r) => r.auto_fill_enabled).length;
    const itemsExpectedToGraduate = runs.filter((r) => {
      if (r.auto_fill_enabled) return false;
      const passes = Number(r.consecutive_passing_runs ?? 0);
      const enough = Number(r.training_row_count ?? 0) >= 30;
      return passes >= 3 || enough;
    }).length;

    // ── overfitRatio: validation_mae / training_mae (fit-tightness) ──────
    // The number that USED to be called currentMaeRatio. It tells you whether
    // a model is overfitting (high ratio = looser on test than train). It is
    // NOT the activation gate.
    let overfitRatio: number | null = null;
    const overfitRatios: number[] = [];
    for (const r of runs) {
      const mae = r.validation_mae;
      const trainMae = r.training_mae;
      if (mae !== null && mae !== undefined && trainMae !== null && trainMae !== undefined && Number(trainMae) > 0) {
        overfitRatios.push(Number(mae) / Number(trainMae));
      }
    }
    if (overfitRatios.length > 0) {
      overfitRatio = overfitRatios.reduce((a, b) => a + b, 0) / overfitRatios.length;
    }

    // ── currentMaeRatioVsMean: validation_mae / mean_observed_rate ───────
    // The REAL activation gate ratio (see inventory_graduation_mae_ratio in
    // ml-service/src/config.py). The "% off" label in the UI maps to THIS
    // number. Reads the new mean_observed_rate key persisted in hyperparameters
    // by the trainer (Phase 2 one-line change in inventory_rate.py).
    // Returns null until the next weekly retrain populates that field.
    let currentMaeRatioVsMean: number | null = null;
    const gateRatios: number[] = [];
    for (const r of runs) {
      const mae = r.validation_mae;
      const hp = (r.hyperparameters ?? null) as Record<string, unknown> | null;
      const meanRaw = hp ? hp.mean_observed_rate : null;
      const mean = typeof meanRaw === 'number' ? meanRaw : Number(meanRaw);
      if (
        mae !== null &&
        mae !== undefined &&
        Number.isFinite(mean) &&
        mean > 1e-9
      ) {
        gateRatios.push(Number(mae) / mean);
      }
    }
    if (gateRatios.length > 0) {
      currentMaeRatioVsMean = gateRatios.reduce((a, b) => a + b, 0) / gateRatios.length;
    }

    const activePredictions = filterInventoryMlRowsToActiveItems(predictionRows, activeItemIds);
    const lastInferenceAt = activePredictions[0]?.predicted_at ?? null;
    const lastInferenceStale = (() => {
      if (!lastInferenceAt) return true;
      const ageHours = (Date.now() - new Date(lastInferenceAt).getTime()) / 3600000;
      return ageHours > STALE_INFERENCE_HOURS;
    })();
    const predictionsLast7Days = filterInventoryMlRowsToActiveItems(
      predictionsLast7Rows,
      activeItemIds,
    ).length;

    return NextResponse.json({
      ok: true,
      requestId,
      data: {
        aiMode,
        daysSinceFirstCount,
        itemsTotal,
        itemsWithModel,
        itemsGraduated,
        itemsExpectedToGraduate,
        overfitRatio,
        currentMaeRatioVsMean,
        /** @deprecated Use `overfitRatio` instead. Kept one release for
         *  backward compat with CountSheet.tsx + SimpleSheet.tsx readers. */
        currentMaeRatio: overfitRatio,
        lastInferenceAt,
        lastInferenceStale,
        predictionsLast7Days,
      },
    });
  } catch (e) {
    log.error('inventory/ai-status: failed', { requestId, err: e as Error });
    return inventoryAiUnavailableResponse(requestId);
  }
}
