/**
 * GET /api/cron/ml-predict-inventory
 *
 * Daily cron (06:00 CT, +30min after the housekeeping demand inference) that
 * generates inventory_rate predictions for tomorrow for every active property.
 * One prediction row per (property × item) with an active model.
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
import { runWithConcurrency, applyShardFilter } from '@/lib/parallel';
import { classifyMlServiceConfig } from '@/lib/ml-routing';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  emitPropertyMisconfiguredEvent,
  parsePropertyMisconfiguredError,
  MISCONFIG_STATUSES,
} from '@/lib/ml-misconfigured-events';
import { predictInventoryRates } from '@/lib/ml-predict-invoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 300s (Vercel Pro cap) to match the sibling ML crons — the real per-run
// ceiling. Sharding is PLUMBED but DORMANT: applyShardFilter (below) reads
// ?shard_offset/&shard_count, but the GitHub workflow currently calls this
// route with a bare URL, so shard_count defaults to 1 and one invocation
// carries the whole fleet within the 300s budget. To actually split the fleet
// at scale, add a strategy.matrix to the predict-inventory job in ml-cron.yml
// and append the shard params to the curl (keep the matrix length and
// shard_count in lockstep). The 90s cap this replaced killed the run mid-fleet.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const config = classifyMlServiceConfig();
  if (config.state === 'disabled') {
    log.warn('ml-predict-inventory: ML service not configured', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }
  if (config.state === 'drift') {
    log.error('ml-predict-inventory: ML service config drift', { requestId, missing: config.missing });
    return NextResponse.json(
      { ok: false, error: 'ml_service_config_drift', missing: config.missing, requestId },
      { status: 503 },
    );
  }

  // Pull `timezone` so each property's "tomorrow" is computed against its
  // own local clock (a Florida hotel must not predict a Texas-timed date).
  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone, inventory_ai_mode')
    .order('id');  // stable order so sharding is deterministic across calls
  if (error) {
    return NextResponse.json({ ok: false, error: errToString(error), requestId }, { status: 500 });
  }

  // Shard filter: the GitHub workflow can dispatch N parallel jobs with
  // ?shard_offset=K&shard_count=N to split the fan-out across the fleet.
  // Defaults to no sharding. MUST be applied to the raw ordered list BEFORE
  // the eligible/skipped partition — the modulo math assumes every shard sees
  // the same ordered list, so partitioning first would skip/double-process.
  const sharded = applyShardFilter((properties ?? []) as Array<Record<string, unknown>>, new URL(req.url).searchParams);
  log.info('ml-predict-inventory: start', { requestId, shardHeader: sharded.header });

  // Partition into "skipped" and "eligible" before fan-out so ai_off rows
  // don't occupy parallel slots. Codex follow-up 2026-05-13 (A1):
  // also skip-and-emit for properties with null timezone — same path
  // ml-run-inference uses. Without this the inventory cron silently
  // defaults to America/Chicago for non-Texas hotels (the bug Phase 3.5
  // was supposed to close, missed on this cron).
  type PropertyRow = { id: string; name: string; timezone: string | null; inventory_ai_mode?: string };
  const eligible: PropertyRow[] = [];
  const skipped: Array<{ property_id: string; status: string; detail?: string }> = [];
  for (const property of (sharded.items as unknown as PropertyRow[])) {
    if (property.inventory_ai_mode === 'off') {
      skipped.push({ property_id: property.id, status: 'skipped_ai_off' });
    } else if (!property.timezone) {
      log.warn('ml-predict-inventory: property missing timezone — skip', {
        requestId, property_id: property.id, property_name: property.name,
      });
      await emitPropertyMisconfiguredEvent({
        requestId,
        propertyId: property.id,
        layer: 'inventory_rate',
        field: 'timezone',
        value: null,
      });
      skipped.push({
        property_id: property.id,
        status: 'skipped',
        detail: 'property_misconfigured: timezone is null',
      });
    } else {
      eligible.push(property);
    }
  }

  // Parallel fan-out (concurrency 5).
  const outcomes = await runWithConcurrency(eligible, async (property) => {
    // Phase E2E (2026-05-22): fetch+parse+shape validation moved into
    // predictInventoryRates so a malformed FastAPI response can't slip
    // past the JSON cast and land as `predicted: null` with status 'ok'.
    const result = await predictInventoryRates(property.id, {
      propertyTimezone: property.timezone as string,
      requestId,
    });
    const predicted =
      typeof (result.detail as { predicted?: number } | undefined)?.predicted === 'number'
        ? (result.detail as { predicted?: number }).predicted
        : null;
    log.info('ml-predict-inventory: result', {
      requestId, property_id: property.id,
      predicted,
    });

    // Codex follow-up 2026-05-13 (A2): if the ML service returned a
    // property_misconfigured error (e.g. for a field caught Python-side
    // we don't pre-check here), persist the event and return a clean
    // skipped outcome.
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
      return { status: 'skipped', detail: errStr };
    }
    // Codex round-3 review 2026-05-13 (D2): the prior code did `return json`
    // here, which let `{error: 'No active model'}` or HTTP 500s fall
    // through. Result mapper defaults missing `status` to 'ok' →
    // anyError stays false → heartbeat goes green while inventory
    // predictions are absent. The wrapper now sets ok=false for all
    // those cases.
    if (!result.ok) {
      return {
        status: 'error',
        detail: errStr ?? result.http ?? `HTTP ${result.http ?? '???'}`,
      };
    }
    return result.detail ?? {};
  }, 5);

  const results = [
    ...skipped,
    ...outcomes.map((o) => {
      if (o.ok) {
        // Inspect ML response status — see ml-train-inventory for notes.
        const mlStatus = (o.value as { status?: string }).status ?? 'ok';
        return { property_id: o.input.id, status: mlStatus, detail: o.value };
      }
      log.error('ml-predict-inventory: ML service call failed', {
        requestId, property_id: o.input.id, err: o.error as Error,
      });
      return { property_id: o.input.id, status: 'error', detail: errToString(o.error) };
    }),
  ];

  const anyError = results.some((r) => r.status === 'error');
  // Codex round-4 (G4): MISCONFIG_STATUSES now lives in the shared
  // helper module so all 4 ML crons (this + 3 training crons) read
  // the same contract. Adding a new skipped reason there forces an
  // update in one place.
  const propertiesMisconfigured = results.filter((r) => MISCONFIG_STATUSES.has(r.status)).length;
  if (!anyError) {
    await writeCronHeartbeat('ml-predict-inventory', {
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
