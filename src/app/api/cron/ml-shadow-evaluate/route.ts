/**
 * GET /api/cron/ml-shadow-evaluate
 *
 * Daily cron (after the 7-day soak completes for any shadow model).
 * Promotes shadow ML models to active when they match or beat the
 * currently-active model's validation MAE, or rejects them on
 * underperformance. The active model keeps serving in either case until
 * a successful promotion lands, so a bad retrain can't silently take
 * down Count Mode autofill — the "auto-rollback" half of the design.
 *
 * Shadow models are written by the weekly training cron when an item
 * already has a graduated active model (see
 * ml-service/src/training/inventory_rate.py). They sit at
 * is_shadow=true, is_active=false, shadow_promoted_at=null for 7 days,
 * then this cron decides their fate.
 *
 * Promotion criterion (Phase 5 — validation_mae comparison, simple):
 *   shadow.validation_mae <= active.validation_mae * (1 + tolerance)
 *
 * Tolerance is 5% — we promote shadows that match or slightly improve
 * the active. A future iteration can swap this for a fresh-actuals
 * comparison (predict in parallel, MAE vs counts over the 7-day window)
 * which is more rigorous but needs more inference infrastructure.
 *
 * Scope: inventory_rate only for now (Phase 5). Demand/supply/optimizer
 * shadows can opt in by setting is_shadow=true at training time; this
 * cron iterates ALL layers, not just inventory.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bumped from 60 (Hobby cap) to 300 (Pro cap). This route is lighter
// than the training/inference routes (DB queries + comparisons, no
// ML service calls) but at fleet scale 1000+ shadow rows × ~50ms
// per evaluation can exceed 60s. No sharding param here — the
// .limit(500) above already caps per-tick work; if we cross the
// 300s threshold we'll dial limit down + run more frequently.
export const maxDuration = 300;

const SOAK_DAYS = 7;
const MAE_TOLERANCE = 0.05; // shadow may be up to 5% worse than active to promote

type ShadowRow = {
  id: string;
  property_id: string;
  layer: string;
  item_id: string | null;
  validation_mae: number | null;
  shadow_started_at: string | null;
};

type ActiveRow = {
  id: string;
  validation_mae: number | null;
  auto_fill_enabled: boolean | null;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const cutoffIso = new Date(Date.now() - SOAK_DAYS * 86400 * 1000).toISOString();

  // Find shadow models that have been soaking ≥7 days and haven't been
  // promoted yet. We don't filter by layer here; the cron handles every
  // layer that opts into shadow mode (inventory_rate is the only one
  // today; demand/supply can adopt by writing is_shadow=true on retrain).
  //
  // FIFO order on shadow_started_at — at fleet scale the limit could
  // truncate the result set, and starving the oldest shadow is worse
  // than starving the newest (oldest has been waiting longest for a
  // verdict, and its target active is the one most likely to still be
  // around for comparison).
  const { data: shadows, error: shErr } = await supabaseAdmin
    .from('model_runs')
    .select('id, property_id, layer, item_id, validation_mae, shadow_started_at')
    .eq('is_shadow', true)
    .is('shadow_promoted_at', null)
    .lte('shadow_started_at', cutoffIso)
    .order('shadow_started_at', { ascending: true })
    .limit(500);

  if (shErr) {
    log.error('ml-shadow-evaluate: shadow query failed', { requestId, err: shErr as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(shErr) }, { status: 500 });
  }

  const results: Array<{
    shadow_run_id: string;
    layer: string;
    item_id: string | null;
    verdict: 'promoted' | 'rejected' | 'error';
    detail?: unknown;
  }> = [];

  for (const shadow of (shadows ?? []) as ShadowRow[]) {
    try {
      // Look up the corresponding active row for the same (property, layer,
      // item_id). For demand/supply/optimizer, item_id will be null on both
      // sides; for inventory_rate it'll be the item uuid.
      let activeQuery = supabaseAdmin
        .from('model_runs')
        .select('id, validation_mae, auto_fill_enabled')
        .eq('property_id', shadow.property_id)
        .eq('layer', shadow.layer)
        .eq('is_active', true)
        .eq('is_shadow', false);
      activeQuery = shadow.item_id
        ? activeQuery.eq('item_id', shadow.item_id)
        : activeQuery.is('item_id', null);

      const { data: actives, error: actErr } = await activeQuery.limit(1);
      if (actErr) throw actErr;
      const active = (actives ?? [])[0] as ActiveRow | undefined;

      if (!active) {
        // Active was deactivated or deleted while the shadow was soaking.
        // Under the shadow-gating contract, a shadow only gets written
        // when an active+graduated model existed at training time — so a
        // missing active later means somebody (admin, manual cleanup,
        // accidental deletion) intentionally removed it. Promoting the
        // shadow would silently resurrect ML predictions that the
        // operator just turned off. Reject instead.
        await rejectShadow(shadow.id, shadow.validation_mae, 'active_disabled_during_soak');
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'rejected',
          detail: { reason: 'active_disabled_during_soak' },
        });
        continue;
      }

      const shadowMae = shadow.validation_mae;
      const activeMae = active.validation_mae;
      // Codex adversarial review 2026-05-13 (I-C6): the prior version
      // promoted on null MAE ("can't make a confidence-based decision,
      // bias toward fresher data"). But a null MAE often signals that
      // validation FAILED (insufficient holdout, NaN inputs, etc.) —
      // promoting an unvalidated shadow over a validated active model
      // is exactly the silent regression that shadow mode exists to
      // prevent. Fail closed instead: skip promotion, log loudly, leave
      // the shadow in place for the next cron tick.
      if (shadowMae === null || activeMae === null) {
        log.warn('ml-shadow-evaluate: skipping promotion on null MAE', {
          requestId,
          shadow_run_id: shadow.id,
          active_run_id: active.id,
          shadow_mae: shadowMae,
          active_mae: activeMae,
        });
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'rejected',
          detail: { reason: 'null_mae', shadowMae, activeMae },
        });
        continue;
      }

      const promote = shadowMae <= activeMae * (1 + MAE_TOLERANCE);

      if (promote) {
        await promoteShadow(shadow.id, active.id);
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'promoted',
          detail: { shadowMae, activeMae },
        });
      } else {
        await rejectShadow(shadow.id, shadowMae, 'shadow_underperformed');
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'rejected',
          detail: { shadowMae, activeMae, ratio: shadowMae / activeMae },
        });
      }
    } catch (err) {
      log.error('ml-shadow-evaluate: per-shadow handler failed', {
        requestId, shadow_run_id: shadow.id, err: err as Error,
      });
      results.push({
        shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
        verdict: 'error', detail: errToString(err),
      });
    }
  }

  log.info('ml-shadow-evaluate: pass complete', {
    requestId, evaluated: results.length,
  });

  const anyVerdictError = results.some((r) => r.verdict === 'error');
  if (!anyVerdictError) {
    await writeCronHeartbeat('ml-shadow-evaluate', {
      requestId,
      notes: {
        evaluated: results.length,
        promoted: results.filter((r) => r.verdict === 'promoted').length,
        rejected: results.filter((r) => r.verdict === 'rejected').length,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    requestId,
    evaluated: results.length,
    results,
  });
}

/**
 * Promote a shadow to active. Atomic via the `promote_shadow_model_run`
 * Postgres function (migration 0072) — one UPDATE flips the prior active
 * to inactive and the shadow to active in a single statement, so a mid-
 * promotion failure can't leave the item without an active model.
 */
async function promoteShadow(shadowId: string, activeId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('promote_shadow_model_run', {
    p_shadow_id: shadowId,
    p_active_id: activeId,
  });
  if (error) throw error;
}

/**
 * Reject a shadow. Marks it as ended with the supplied reason so the
 * admin audit log shows why it was killed; the existing active keeps
 * serving without modification.
 */
async function rejectShadow(
  shadowId: string,
  shadowMae: number | null,
  reason: 'shadow_underperformed' | 'active_disabled_during_soak',
): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from('model_runs')
    .update({
      is_shadow: false,
      is_active: false,
      deactivated_at: nowIso,
      deactivation_reason: reason,
      shadow_evaluation_mae: shadowMae,
    })
    .eq('id', shadowId);
}
