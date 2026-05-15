/**
 * GET /api/cron/ml-train-inventory
 *
 * Weekly cron (Sunday 04:00 CT, +60min after demand) that triggers
 * inventory_rate training on the Python ML service for every active
 * property. One model per (property × item) gets trained.
 *
 * Auth: Bearer ${CRON_SECRET} via requireCronSecret.
 *
 * Schedule lives in .github/workflows/ml-cron.yml.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { runWithConcurrency } from '@/lib/parallel';
import { listMlShardUrls } from '@/lib/ml-routing';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { triggerMlTraining } from '@/lib/ml-invoke';
import {
  emitPropertyMisconfiguredEvent,
  parsePropertyMisconfiguredError,
  MISCONFIG_STATUSES,
} from '@/lib/ml-misconfigured-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const shardUrls = listMlShardUrls();
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (shardUrls.length === 0 || !mlServiceSecret) {
    log.warn('ml-train-inventory: ML service not configured', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, inventory_ai_mode');
  if (error) {
    return NextResponse.json({ ok: false, error: errToString(error), requestId }, { status: 500 });
  }

  // Skip ai_off properties before fan-out so they don't take a parallel slot.
  type PropertyRow = { id: string; name: string; inventory_ai_mode?: string };
  const eligible: PropertyRow[] = [];
  const skipped: Array<{ property_id: string; status: string }> = [];
  for (const property of (properties ?? []) as PropertyRow[]) {
    if (property.inventory_ai_mode === 'off') {
      skipped.push({ property_id: property.id, status: 'skipped_ai_off' });
    } else {
      eligible.push(property);
    }
  }

  // Parallel fan-out (concurrency 3 — inventory training is the heaviest
  // stage; one call iterates every inventory.id in the property).
  // Phase M3.5 (2026-05-14): inline fetch migrated to triggerMlTraining
  // helper. Inventory uses a longer 75s timeout (vs demand/supply's 45s)
  // because per-item training fans out to N items per property.
  const outcomes = await runWithConcurrency(eligible, async (property) => {
    const result = await triggerMlTraining(property.id, 'inventory-rate', {
      requestId, timeoutMs: 75_000,
    });
    const json = (result.detail ?? {}) as Record<string, unknown>;
    log.info('ml-train-inventory: result', {
      requestId,
      property_id: property.id,
      elapsedMs: result.elapsedMs,
      items_trained: (json as { items_trained?: number }).items_trained ?? null,
    });

    // Codex follow-up 2026-05-13 (A2 + A6): persist property_misconfigured
    // events from training; map error responses to status: 'error' so
    // the heartbeat is suppressed correctly. Inventory training catches
    // total_rooms misconfiguration before the per-item loop, so this is
    // where we hear about it.
    const errStr = result.error;
    if (typeof errStr === 'string' && errStr.startsWith('property_misconfigured:')) {
      const parsed = parsePropertyMisconfiguredError(errStr);
      if (parsed) {
        await emitPropertyMisconfiguredEvent({
          requestId,
          propertyId: property.id,
          layer: 'inventory_rate',
          field: parsed.field,
          originalField: parsed.originalField,
          value: parsed.value,
        });
      }
      return { ...json, status: 'skipped' };
    }
    if (typeof errStr === 'string' || !result.ok) {
      return { ...json, status: 'error' };
    }
    return json;
  }, 3);

  const results = [
    ...skipped,
    ...outcomes.map((o) => {
      if (o.ok) {
        // ── Inspect ML response status (May 2026 audit pass-5) ─────────
        // Previously this hardcoded status:'ok' regardless of the ML
        // service's actual response. An HTTP 500 with {error:'...'} or
        // an HTTP 200 with {status:'error'} would still be reported as
        // 'ok' here, masking real training failures. Now we propagate
        // the ML service's own status field — same shape as ml-train-
        // demand and ml-train-supply.
        const mlStatus = (o.value as { status?: string }).status ?? 'ok';
        return { property_id: o.input.id, status: mlStatus, detail: o.value };
      }
      log.error('ml-train-inventory: ML service call failed', {
        requestId, property_id: o.input.id, err: o.error as Error,
      });
      return { property_id: o.input.id, status: 'error', detail: errToString(o.error) };
    }),
  ];

  const anyError = results.some((r) => r.status === 'error');
  // Codex round-3 (D2) + round-4 (G4): heartbeat-degraded on misconfig.
  // MISCONFIG_STATUSES contains 'skipped' (NOT 'skipped_ai_off' — that's
  // intentional admin setting, not a misconfig). Shared across all
  // 4 ML crons.
  const propertiesMisconfigured = results.filter((r) => MISCONFIG_STATUSES.has(r.status)).length;
  if (!anyError) {
    await writeCronHeartbeat('ml-train-inventory', {
      requestId,
      status: propertiesMisconfigured > 0 ? 'degraded' : 'ok',
      notes: {
        properties_processed: results.length,
        properties_misconfigured: propertiesMisconfigured,
      },
    });
  }
  // Outer ok reflects inner state — see ml-train-demand for full notes.
  return NextResponse.json(
    {
      ok: !anyError,
      requestId,
      properties_processed: results.length,
      results,
    },
    { status: anyError ? 502 : 200 },
  );
}
