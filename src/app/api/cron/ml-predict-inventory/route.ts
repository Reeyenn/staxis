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
import { runWithConcurrency } from '@/lib/parallel';
import { listMlShardUrls, resolveMlShardUrl } from '@/lib/ml-routing';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
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
    log.warn('ml-predict-inventory: ML service not configured', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  // Pull `timezone` so each property's "tomorrow" is computed against its
  // own local clock (a Florida hotel must not predict a Texas-timed date).
  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone, inventory_ai_mode');
  if (error) {
    return NextResponse.json({ ok: false, error: errToString(error), requestId }, { status: 500 });
  }

  // Partition into "skipped" and "eligible" before fan-out so ai_off rows
  // don't occupy parallel slots. Codex follow-up 2026-05-13 (A1):
  // also skip-and-emit for properties with null timezone — same path
  // ml-run-inference uses. Without this the inventory cron silently
  // defaults to America/Chicago for non-Texas hotels (the bug Phase 3.5
  // was supposed to close, missed on this cron).
  type PropertyRow = { id: string; name: string; timezone: string | null; inventory_ai_mode?: string };
  const eligible: PropertyRow[] = [];
  const skipped: Array<{ property_id: string; status: string; detail?: string }> = [];
  for (const property of (properties ?? []) as PropertyRow[]) {
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
    const propertyTz = property.timezone as string;
    const mlServiceUrl = resolveMlShardUrl(property.id)!;
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/predict/inventory-rate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ property_id: property.id, property_timezone: propertyTz }),
      signal: AbortSignal.timeout(75_000),
    });
    const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
    log.info('ml-predict-inventory: result', {
      requestId, property_id: property.id,
      predicted: (json as { predicted?: number }).predicted ?? null,
    });

    // Codex follow-up 2026-05-13 (A2): if the ML service returned a
    // property_misconfigured error (e.g. for a field caught Python-side
    // we don't pre-check here), persist the event and return a clean
    // skipped outcome.
    const errStr = (json as { error?: string }).error;
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
    // predictions are absent. Same hardening A2/A6 added to the
    // training crons; was missed here.
    if (typeof errStr === 'string' || !res.ok) {
      return {
        status: 'error',
        detail: errStr ?? (json as { http?: number }).http ?? `HTTP ${res.status}`,
      };
    }
    return json;
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
