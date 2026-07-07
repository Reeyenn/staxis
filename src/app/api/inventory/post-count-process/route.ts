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
 *   2. Pair each item's WINDOW-INTEGRATED prediction (mean of the daily
 *      predictions covering the days between the two counts — see
 *      lib/inventory-window-pairing) with the observed actual rate, write to
 *      `prediction_log`. This feeds the InventoryShadowMAEChart and the
 *      graduation gate. The cron sweep in /api/cron/ml-predict-inventory
 *      writes the same pairs for counts this fire-and-forget call missed.
 *
 * Body: { propertyId: uuid, itemIds: uuid[] }
 *   - itemIds is the list of item IDs that were just counted.
 *
 * Auth: requireSession + userHasPropertyAccess. Best-effort — failures here
 * never block the user; the count itself is already saved client-side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { detectRateAnomalies, type RateObservation } from '@/lib/inventory-anomaly';
import {
  buildWindowPairs,
  localDateOf,
  type CountWindow,
} from '@/lib/inventory-window-pairing';
import { fetchWindowPredictions, insertFreshPairs } from '@/lib/inventory-pairing-sweep';
import { getOrMintRequestId, log } from '@/lib/log';
import { recordAppEvent } from '@/lib/event-recorder';
import { ok, err, ApiErrorCode } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface CountRow {
  id: string;
  item_id: string;
  item_name: string;
  counted_at: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  let body: { propertyId?: unknown; itemIds?: unknown };
  try { body = await req.json(); } catch {
    return err('invalid_json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!isUuid(body.propertyId)) {
    return err('invalid_property_id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!Array.isArray(body.itemIds) || !body.itemIds.every(isUuid)) {
    return err('invalid_item_ids', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const itemIds = body.itemIds as string[];
  const propertyId = body.propertyId;

  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  // Section gate (add-on, on top of the tenant guard above): if Inventory is
  // turned off for this hotel, block the count post-processing entirely.
  const sectionGate = await requireSectionEnabled(req, propertyId, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;
  if (itemIds.length === 0) {
    return ok({ anomalies: 0, predictionLogs: 0 }, { requestId });
  }

  // Honor the property AI mode kill-switch
  const { data: prop } = await supabaseAdmin
    .from('properties')
    .select('inventory_ai_mode, timezone')
    .eq('id', propertyId)
    .maybeSingle();
  if (((prop?.inventory_ai_mode ?? 'auto') as string) === 'off') {
    return ok({
      anomalies: 0,
      predictionLogs: 0,
      note: 'ai_mode_off',
    }, { requestId });
  }

  let anomalies = 0;
  let predictionLogs = 0;

  try {
    // Pull the most recent and second-most-recent count for each item.
    // Bulk fetch for the union of items, then bucket in JS.
    const { data: rows, error } = await supabaseAdmin
      .from('inventory_counts')
      .select('id,item_id,item_name,counted_at')
      .eq('property_id', propertyId)
      .in('item_id', itemIds)
      .order('counted_at', { ascending: false })
      .limit(itemIds.length * 4);
    if (error || !rows) {
      log.warn('post-count-process: count fetch failed', { requestId, err: error });
      return err('fetch_failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }

    // Group by item_id, keep first 2 (most recent + previous)
    const byItem = new Map<string, CountRow[]>();
    for (const r of rows as CountRow[]) {
      const arr = byItem.get(r.item_id) ?? [];
      if (arr.length < 2) arr.push(r);
      byItem.set(r.item_id, arr);
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

    // Build the count windows the view accepted. Window day-boundaries are
    // PROPERTY-local (an evening count is a next-day UTC timestamp — slicing
    // UTC would shift the window for evening-counting hotels).
    //
    // Codex post-merge review 2026-05-13 (M-2b), still load-bearing: if the
    // observed-rate view rejected this pair (day-1 floor, missing-data
    // filter, etc.), DON'T fabricate an observation — honest "no
    // observation" beats a systematically wrong one.
    const tz = (prop?.timezone as string | null) || 'America/Chicago';
    const windows: CountWindow[] = [];
    const daysByCountId = new Map<string, number>();
    for (const itemId of itemIds) {
      const counts = byItem.get(itemId) ?? [];
      if (counts.length < 2) continue;            // Need 2 counts to compute a rate
      const newer = counts[0];
      const older = counts[1];
      if (!observedByNewerCountId.has(newer.id)) continue;
      const olderLocalDate = localDateOf(older.counted_at, tz);
      const newerLocalDate = localDateOf(newer.counted_at, tz);
      if (!olderLocalDate || !newerLocalDate) continue;
      const tNewer = new Date(newer.counted_at).getTime();
      const tOlder = new Date(older.counted_at).getTime();
      daysByCountId.set(newer.id, Math.max((tNewer - tOlder) / 86400000, 0.5));
      windows.push({
        itemId,
        itemName: newer.item_name,
        newerCountId: newer.id,
        olderLocalDate,
        newerLocalDate,
        observedRate: observedByNewerCountId.get(newer.id) as number,
      });
    }

    // Daily predictions covering the union of the windows. The pair compares
    // the MEAN predicted daily rate over the window's own days against the
    // realized mean rate over those same days — same units, same horizon.
    // (The old single-latest-prediction pairing compared one day's forecast
    // against a week's average: 10-25% phantom error from day-of-week swings.)
    // Fetch + write go through the SHARED helpers in inventory-pairing-sweep
    // so a count-time pair and a swept pair can never drift apart.
    const observations: RateObservation[] = [];
    if (windows.length > 0) {
      const minDate = windows.reduce((a, w) => (w.olderLocalDate < a ? w.olderLocalDate : a), windows[0].olderLocalDate);
      const maxDate = windows.reduce((a, w) => (w.newerLocalDate > a ? w.newerLocalDate : a), windows[0].newerLocalDate);
      const predictions = await fetchWindowPredictions({
        propertyId,
        itemIds: Array.from(new Set(windows.map((w) => w.itemId))),
        minDate,
        maxDate,
        requestId,
      });

      const { pairs, skippedLowCoverage } = buildWindowPairs(windows, predictions ?? []);
      if (skippedLowCoverage > 0) {
        log.info('post-count-process: windows skipped for low prediction coverage', {
          requestId, propertyId, skipped: skippedLowCoverage,
        });
      }
      const pairedCountIds = new Set(pairs.map((p) => p.newerCountId));
      for (const pair of pairs) {
        observations.push({
          itemId: pair.itemId,
          itemName: pair.itemName,
          predictedDailyRate: pair.predictedRate,
          observedDailyRate: pair.observedRate,
          daysSinceLastCount: daysByCountId.get(pair.newerCountId) ?? pair.windowDays,
        });
      }

      // Anomaly screening must NOT be gated on window coverage: during a
      // predict-cron outage (exactly when coverage fails) a theft-scale
      // discrepancy still needs to surface. For windows without a pair, fall
      // back to the item's newest in-range prediction as the anomaly
      // baseline. These fallback observations feed detectRateAnomalies ONLY —
      // they never become prediction_log rows (graduation evidence stays
      // window-integrated or absent).
      const newestByItem = new Map<string, { rate: number; at: string }>();
      for (const p of predictions ?? []) {
        const prev = newestByItem.get(p.itemId);
        if (!prev || p.predictedAt > prev.at) newestByItem.set(p.itemId, { rate: p.rate, at: p.predictedAt });
      }
      for (const w of windows) {
        if (pairedCountIds.has(w.newerCountId)) continue;
        const fallback = newestByItem.get(w.itemId);
        if (!fallback || !Number.isFinite(fallback.rate)) continue;
        observations.push({
          itemId: w.itemId,
          itemName: w.itemName,
          predictedDailyRate: fallback.rate,
          observedDailyRate: w.observedRate,
          daysSinceLastCount: daysByCountId.get(w.newerCountId) ?? 1,
        });
      }

      predictionLogs = await insertFreshPairs({ propertyId, pairs, requestId });
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
      // recordAppEvent handles insert failure (structured console.error +
      // rate-limited Sentry escalation) — never throws. We optimistically
      // set anomalies count because the helper logs failures itself.
      await recordAppEvent(events);
      anomalies = events.length;
    }

    return ok({ anomalies, predictionLogs }, { requestId });
  } catch (e) {
    log.error('post-count-process: exception', { requestId, err: e as Error });
    return err('internal_error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
