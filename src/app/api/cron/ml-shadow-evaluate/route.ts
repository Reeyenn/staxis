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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  const { data: shadows, error: shErr } = await supabaseAdmin
    .from('model_runs')
    .select('id, property_id, layer, item_id, validation_mae, shadow_started_at')
    .eq('is_shadow', true)
    .is('shadow_promoted_at', null)
    .lte('shadow_started_at', cutoffIso)
    .limit(500);

  if (shErr) {
    log.error('ml-shadow-evaluate: shadow query failed', { requestId, err: shErr as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(shErr) }, { status: 500 });
  }

  const results: Array<{
    shadow_run_id: string;
    layer: string;
    item_id: string | null;
    verdict: 'promoted' | 'rejected' | 'no_active_found' | 'error';
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
        // Active was deleted/deactivated while shadow was soaking. Promote
        // the shadow unconditionally — there's nothing to compare it to,
        // and the alternative (leaving it shadow forever) would mean no
        // model serves predictions for this item.
        await promoteShadow(shadow.id, null);
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'no_active_found',
        });
        continue;
      }

      const shadowMae = shadow.validation_mae;
      const activeMae = active.validation_mae;
      // If either MAE is missing (very early-stage models), promote — we
      // can't make a confidence-based decision and the shadow is at least
      // as recent as the active. Bias toward fresher data.
      const promote =
        shadowMae === null || activeMae === null
          ? true
          : shadowMae <= activeMae * (1 + MAE_TOLERANCE);

      if (promote) {
        await promoteShadow(shadow.id, active.id);
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'promoted',
          detail: { shadowMae, activeMae },
        });
      } else {
        await rejectShadow(shadow.id, shadowMae);
        results.push({
          shadow_run_id: shadow.id, layer: shadow.layer, item_id: shadow.item_id,
          verdict: 'rejected',
          detail: { shadowMae, activeMae, ratio: activeMae ? shadowMae! / activeMae : null },
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

  return NextResponse.json({
    ok: true,
    requestId,
    evaluated: results.length,
    results,
  });
}

/**
 * Promote a shadow to active. Atomic-ish (two updates; if the second
 * fails the first leaves us with two actives, which the next training
 * pass will resolve — and the partial-unique index on inventory_rate
 * predictions catches duplicate writes).
 */
async function promoteShadow(shadowId: string, activeId: string | null): Promise<void> {
  const nowIso = new Date().toISOString();

  if (activeId) {
    await supabaseAdmin
      .from('model_runs')
      .update({
        is_active: false,
        deactivated_at: nowIso,
        deactivation_reason: 'superseded_by_shadow_promotion',
      })
      .eq('id', activeId);
  }

  await supabaseAdmin
    .from('model_runs')
    .update({
      is_active: true,
      is_shadow: false,
      shadow_promoted_at: nowIso,
      activated_at: nowIso,
    })
    .eq('id', shadowId);
}

/**
 * Reject a shadow — it underperformed the active. Mark it as ended;
 * the existing active keeps serving without modification.
 */
async function rejectShadow(shadowId: string, shadowMae: number | null): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from('model_runs')
    .update({
      is_shadow: false,
      is_active: false,
      deactivated_at: nowIso,
      deactivation_reason: 'shadow_underperformed',
      shadow_evaluation_mae: shadowMae,
    })
    .eq('id', shadowId);
}
