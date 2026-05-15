/**
 * GET /api/cron/ml-train-supply
 *
 * Weekly cron (Sunday 03:30 CT, 30 min after demand training). Same shape
 * as /api/cron/ml-train-demand but POSTs to /train/supply on the Python
 * ML service.
 *
 * Spaced 30 min after demand training so the Railway service isn't doing
 * two heavy loads concurrently — it's a small Railway instance.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { runWithConcurrency, applyShardFilter } from '@/lib/parallel';
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
// Bumped from 60 (Hobby cap) to 300 (Pro cap). Fleet-scale headroom.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const shardUrls = listMlShardUrls();
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (shardUrls.length === 0 || !mlServiceSecret) {
    log.warn('ml-train-supply: ML service not configured — skipping', { requestId });
    return NextResponse.json({ ok: true, skipped: 'ML service not configured yet', requestId });
  }

  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .order('id');
  if (error) {
    log.error('ml-train-supply: properties read failed', { requestId, err: error as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
  }

  // Sharding for fleet scale. See ml-train-demand for full notes.
  const url = new URL(req.url);
  const sharded = applyShardFilter(properties ?? [], url.searchParams);
  log.info('ml-train-supply: start', { requestId, shardHeader: sharded.header });

  // Parallel fan-out (concurrency 5) — see ml-train-demand route header.
  // Phase M3.5 (2026-05-14): the inline fetch was migrated to the shared
  // triggerMlTraining helper (src/lib/ml-invoke.ts) so the same network
  // contract (Bearer auth, timeout, shard routing, structured logging)
  // is enforced from one place across all 4 ml-train callers + the
  // M3.1 on-onboard hook. Cron-specific error mapping (the
  // property_misconfigured event emit + heartbeat status shape) stays
  // here — that's load-bearing for the doctor's degraded-heartbeat check.
  const outcomes = await runWithConcurrency(sharded.items, async (property) => {
    const result = await triggerMlTraining(property.id, 'supply', { requestId });

    // Codex follow-up 2026-05-13 (A2 + A6): persist property_misconfigured
    // events from training; map error responses to status: 'error' so
    // the heartbeat is suppressed correctly.
    const errStr = result.error;
    if (typeof errStr === 'string' && errStr.startsWith('property_misconfigured:')) {
      const parsed = parsePropertyMisconfiguredError(errStr);
      if (parsed) {
        await emitPropertyMisconfiguredEvent({
          requestId,
          propertyId: property.id,
          layer: 'supply',
          field: parsed.field,
          originalField: parsed.originalField,
          value: parsed.value,
        });
      }
      return { status: 'skipped', detail: errStr };
    }
    if (typeof errStr === 'string' || !result.ok) {
      return {
        status: 'error',
        detail: errStr ?? result.http ?? `HTTP ${result.http}`,
      };
    }
    return { status: result.status, detail: result.detail };
  }, 5);

  const results = outcomes.map((o) => {
    if (o.ok) return { property_id: o.input.id, status: o.value.status, detail: o.value.detail };
    log.error('ml-train-supply: ML service call failed', { requestId, property_id: o.input.id, err: o.error as Error });
    return { property_id: o.input.id, status: 'error', detail: errToString(o.error) };
  });

  const anyError = results.some((r) => r.status === 'error');
  // Codex round-3 (D2) + round-4 (G4): heartbeat-degraded on misconfig.
  // MISCONFIG_STATUSES is the shared single source of truth.
  const propertiesMisconfigured = results.filter((r) => MISCONFIG_STATUSES.has(r.status)).length;
  if (!anyError) {
    await writeCronHeartbeat('ml-train-supply', {
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
    { ok: !anyError, requestId, results },
    { status: anyError ? 502 : 200 },
  );
}
