/**
 * POST /api/inventory/post-count-process
 *
 * Server-side post-processing after Count Mode saves a batch of counts.
 * Runs two jobs:
 *
 *   1. Compare observed consumption (between this count and the previous
 *      count for each item) against the model's predicted daily rate. If
 *      divergence > 50%, write to `app_events` with
 *      event_type='inventory_anomaly'. The cockpit's
 *      InventoryRecentAnomaliesTable picks these up.
 *
 *   2. Pair each item's most recent inventory_rate_predictions row with the
 *      observed actual rate, write to `prediction_log`. This feeds the
 *      InventoryShadowMAEChart and the graduation gate's MAE calculation.
 *
 * Body: { propertyId: uuid, itemIds: uuid[] }
 *   - itemIds is the list of item IDs that were just counted.
 *
 * Auth: requireSession + userHasPropertyAccess. Best-effort — failures here
 * never block the user; the count itself is already saved client-side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { detectRateAnomalies, type RateObservation } from '@/lib/inventory-anomaly';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface CountRow {
  id: string;
  item_id: string;
  item_name: string;
  counted_stock: number;
  counted_at: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  let body: { propertyId?: unknown; itemIds?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (!isUuid(body.propertyId)) {
    return NextResponse.json({ ok: false, error: 'invalid_property_id' }, { status: 400 });
  }
  if (!Array.isArray(body.itemIds) || !body.itemIds.every(isUuid)) {
    return NextResponse.json({ ok: false, error: 'invalid_item_ids' }, { status: 400 });
  }
  const itemIds = body.itemIds as string[];
  const propertyId = body.propertyId;

  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (itemIds.length === 0) {
    return NextResponse.json({ ok: true, requestId, anomalies: 0, predictionLogs: 0 });
  }

  // Honor the property AI mode kill-switch
  const { data: prop } = await supabaseAdmin
    .from('properties')
    .select('inventory_ai_mode')
    .eq('id', propertyId)
    .maybeSingle();
  if (((prop?.inventory_ai_mode ?? 'auto') as string) === 'off') {
    return NextResponse.json({
      ok: true,
      requestId,
      anomalies: 0,
      predictionLogs: 0,
      note: 'ai_mode_off',
    });
  }

  let anomalies = 0;
  let predictionLogs = 0;

  try {
    // Pull the most recent and second-most-recent count for each item.
    // Bulk fetch for the union of items, then bucket in JS.
    const { data: rows, error } = await supabaseAdmin
      .from('inventory_counts')
      .select('id,item_id,item_name,counted_stock,counted_at')
      .eq('property_id', propertyId)
      .in('item_id', itemIds)
      .order('counted_at', { ascending: false })
      .limit(itemIds.length * 4);
    if (error || !rows) {
      log.warn('post-count-process: count fetch failed', { requestId, err: error });
      return NextResponse.json({ ok: false, error: 'fetch_failed', requestId }, { status: 500 });
    }

    // Group by item_id, keep first 2 (most recent + previous)
    const byItem = new Map<string, CountRow[]>();
    for (const r of rows as CountRow[]) {
      const arr = byItem.get(r.item_id) ?? [];
      if (arr.length < 2) arr.push(r);
      byItem.set(r.item_id, arr);
    }

    // Most-recent prediction per item (any item with a prediction recent enough to compare)
    const { data: predRows } = await supabaseAdmin
      .from('inventory_rate_predictions')
      .select('id,item_id,predicted_daily_rate,model_run_id,predicted_at')
      .eq('property_id', propertyId)
      .in('item_id', itemIds)
      .order('predicted_at', { ascending: false })
      .limit(itemIds.length * 4);
    const predByItem = new Map<string, { id: string; predicted_daily_rate: number; model_run_id: string; predicted_at: string }>();
    for (const p of predRows ?? []) {
      const key = String(p.item_id);
      if (!predByItem.has(key)) predByItem.set(key, p as { id: string; predicted_daily_rate: number; model_run_id: string; predicted_at: string });
    }

    // Codex adversarial review 2026-05-13 (I-C3): observed rate must net
    // out orders received and discards logged in the window between counts.
    // The prior formula (older - newer) / days attributed ALL stock loss
    // to consumption — a 20-unit order in the window would underestimate
    // consumption by 20, and a discard would inflate it. Real formula
    // (matches Python ML training):
    //   consumption = max(0, older + orders - discards - newer)
    //   rate = consumption / days
    // The inventory_observed_rate_v view (migration 0085) does this in
    // SQL. Pull pre-computed rates by newer_count_id and use them.
    const newerCountIds = Array.from(byItem.values())
      .filter(arr => arr.length >= 2)
      .map(arr => arr[0].id);
    const observedByNewerCountId = new Map<string, number>();
    if (newerCountIds.length > 0) {
      const { data: rateRows, error: rateErr } = await supabaseAdmin
        .from('inventory_observed_rate_v')
        .select('newer_count_id, observed_rate')
        .in('newer_count_id', newerCountIds);
      if (rateErr) {
        log.warn('post-count-process: observed-rate view query failed', { requestId, err: rateErr });
      }
      for (const r of rateRows ?? []) {
        observedByNewerCountId.set(String(r.newer_count_id), Number(r.observed_rate ?? 0));
      }
    }

    // Build observations + prediction_log rows
    const observations: RateObservation[] = [];
    const predictionLogRows: Array<Record<string, unknown>> = [];

    for (const itemId of itemIds) {
      const counts = byItem.get(itemId) ?? [];
      if (counts.length < 2) continue;            // Need 2 counts to compute a rate
      const newer = counts[0];
      const older = counts[1];
      const tNewer = new Date(newer.counted_at).getTime();
      const tOlder = new Date(older.counted_at).getTime();
      const days = Math.max((tNewer - tOlder) / 86400000, 0.5);
      // Codex post-merge review 2026-05-13 (M-2b): if the v2 view
      // (migration 0096) rejected this pair (day-1 floor, missing-data
      // filter, etc.), DON'T fabricate an observation via the legacy
      // (older - newer) / days formula — that formula ignores orders +
      // discards and pollutes shadow MAE precisely when the data is
      // dirty enough that the view refused to compute. Honest "no
      // observation" beats a systematically wrong one.
      if (!observedByNewerCountId.has(newer.id)) {
        continue;
      }
      const observed = observedByNewerCountId.get(newer.id) as number;
      const pred = predByItem.get(itemId);
      if (!pred) continue;
      observations.push({
        itemId,
        itemName: newer.item_name,
        predictedDailyRate: Number(pred.predicted_daily_rate),
        observedDailyRate: observed,
        daysSinceLastCount: days,
      });
      predictionLogRows.push({
        property_id: propertyId,
        layer: 'inventory_rate',
        prediction_id: pred.id,
        inventory_count_id: newer.id,
        date: newer.counted_at.slice(0, 10),
        predicted_value: Number(pred.predicted_daily_rate),
        actual_value: observed,
        model_run_id: pred.model_run_id,
        logged_at: new Date().toISOString(),
      });
    }

    // Write prediction_log rows in batch
    if (predictionLogRows.length > 0) {
      const { error: plErr } = await supabaseAdmin.from('prediction_log').insert(predictionLogRows);
      if (plErr) {
        log.warn('post-count-process: prediction_log insert failed', { requestId, err: plErr });
      } else {
        predictionLogs = predictionLogRows.length;
      }
    }

    // Run anomaly detection on observations
    const findings = detectRateAnomalies(observations);
    if (findings.length > 0) {
      const events = findings.map((f) => ({
        property_id: propertyId,
        user_id: session.userId,
        user_role: 'owner',           // best-effort; the cockpit doesn't filter on this
        event_type: 'inventory_anomaly',
        metadata: {
          item_id: f.itemId,
          item_name: f.itemName,
          reason: f.message,
          severity: f.severity,
          predicted_rate: f.predictedDailyRate,
          observed_rate: f.observedDailyRate,
        },
      }));
      const { error: aeErr } = await supabaseAdmin.from('app_events').insert(events);
      if (aeErr) {
        log.warn('post-count-process: app_events insert failed', { requestId, err: aeErr });
      } else {
        anomalies = events.length;
      }
    }

    return NextResponse.json({
      ok: true,
      requestId,
      anomalies,
      predictionLogs,
    });
  } catch (e) {
    log.error('post-count-process: exception', { requestId, err: e as Error });
    return NextResponse.json({ ok: false, error: 'internal_error', requestId }, { status: 500 });
  }
}
