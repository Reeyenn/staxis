/**
 * GET /api/inventory/ai-report?propertyId=<uuid>
 *
 * Per-item "report card" for the AI screen at `/inventory/ai`. The inventory
 * tab itself is 100% manual (no ML numbers); this screen is the one place the
 * AI's silent background predictions are surfaced honestly.
 *
 * Returns one row per inventory item the AI has any signal for, with:
 *   - itemId / itemName
 *   - predictedDailyRate       — the AI's latest learned daily usage (null = none)
 *   - predictedCurrentStock    — the AI's latest predicted on-hand (null = none)
 *   - predictedAt              — ISO timestamp of that prediction (null = none)
 *   - lastActualRate           — most recent observed daily rate from prediction_log
 *   - lastPredictedRate        — the prediction that was paired against it
 *   - lastErrorPct             — |predicted − actual| / actual × 100 (null = no pair)
 *   - loggedAt                 — when that comparison was recorded
 *   - status                   — 'graduated' | 'learning' | 'not-enough-data'
 *   - countEvents              — distinct count events logged for this item
 *   - eventsNeeded             — graduation threshold (15, prospective-gate rebuild)
 *
 * Plus the same summary block the AI-status endpoint returns (items tracked,
 * graduated, gate-ratio accuracy, last-inference freshness) so the page can
 * render the header + per-item list from a single fetch.
 *
 * Auth: requireSession + userHasPropertyAccess. Reachable by any authenticated
 * user with property access (matches ai-status — no extra capability gate).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { propertyLocalToday, addDaysInTz } from '@/lib/schedule/local-date';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// One missed daily cron (24h) + 2h grace. Mirrors ai-status STALE_INFERENCE_HOURS.
const STALE_INFERENCE_HOURS = 26;

// Graduation threshold — the AI needs this many clean count windows per item
// before auto-fill is even considered. Matches ml-service's prospective gate
// (config inventory_graduation_min_events = 15, 2026-07-05 rebuild — the old
// 30-event retrain-streak gate was replaced by prospective prediction_log
// evidence; see ml-service/src/training/_prospective_gate.py).
const EVENTS_NEEDED = 15;

// Gate B threshold — prospective predicted-vs-actual pairs required. Matches
// ml-service config inventory_graduation_min_prospective_pairs.
const PAIRS_NEEDED = 8;

// How far back the robot-data-gap census looks. One NULL day voids every
// learning window spanning it, so the report warns as soon as gaps exist.
const OCCUPANCY_CENSUS_DAYS = 14;

type ItemStatus = 'graduated' | 'learning' | 'not-enough-data';

interface ReportItem {
  itemId: string;
  itemName: string;
  predictedDailyRate: number | null;
  predictedCurrentStock: number | null;
  predictedAt: string | null;
  lastActualRate: number | null;
  lastPredictedRate: number | null;
  lastErrorPct: number | null;
  loggedAt: string | null;
  status: ItemStatus;
  countEvents: number;
  eventsNeeded: number;
  // ── True graduation progress (2026-07-05 accuracy pass) ──────────────
  // countEvents alone lied: an item can sit at "15 of 15 counts" forever
  // while windows keep getting voided or pairs never accumulate. These are
  // the trainer's ACTUAL gate readings, persisted in model_runs.
  cleanWindows: number | null;       // gate A progress (training_row_count)
  prospectivePairs: number | null;   // gate B progress (graduation_n_pairs)
  pairsNeeded: number;               // gate B threshold (8)
  pairSpanDays: number | null;       // gate C progress
  graduationWape: number | null;     // gate D reading (fraction, e.g. 0.22)
  graduationReason: string | null;   // machine code: why not graduated yet
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const propertyId = new URL(req.url).searchParams.get('propertyId');
  if (!isUuid(propertyId)) {
    return err('invalid_property_id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();

    // Service-role client so the multi-table aggregate doesn't fight RLS.
    // The auth check above guarantees the caller is authorized.
    const censusStart = new Date(Date.now() - (OCCUPANCY_CENSUS_DAYS + 2) * 86400000)
      .toISOString().slice(0, 10);

    const [itemsRes, runsRes, predsRes, logRes, countsRes, lastPredRes, predsLast7Res, occRes, propRes] =
      await Promise.all([
        supabaseAdmin
          .from('inventory')
          .select('id,name')
          .eq('property_id', propertyId)
          .limit(2000),
        supabaseAdmin
          .from('model_runs')
          .select('item_id,validation_mae,auto_fill_enabled,training_row_count,hyperparameters')
          .eq('property_id', propertyId)
          .eq('layer', 'inventory_rate')
          .eq('is_active', true)
          .limit(2000),
        // Latest prediction per item (most-recent-first, first hit wins in JS).
        supabaseAdmin
          .from('inventory_rate_predictions')
          .select('item_id,predicted_daily_rate,predicted_current_stock,predicted_at')
          .eq('property_id', propertyId)
          .order('predicted_at', { ascending: false })
          .limit(4000),
        // Latest predicted-vs-actual comparison per item.
        supabaseAdmin
          .from('prediction_log')
          .select('predicted_value,actual_value,logged_at,inventory_count_id')
          .eq('property_id', propertyId)
          .eq('layer', 'inventory_rate')
          .order('logged_at', { ascending: false })
          .limit(4000),
        // All count rows (item_id + counted_at) — bucket distinct events per item in JS.
        supabaseAdmin
          .from('inventory_counts')
          .select('item_id,counted_at')
          .eq('property_id', propertyId)
          .limit(100000),
        // Most-recent prediction overall — drives lastInferenceAt / stale flag.
        supabaseAdmin
          .from('inventory_rate_predictions')
          .select('predicted_at')
          .eq('property_id', propertyId)
          .order('predicted_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from('inventory_rate_predictions')
          .select('property_id', { count: 'exact', head: true })
          .eq('property_id', propertyId)
          .gte('predicted_at', sevenDaysAgoIso),
        // Robot-data census: which recent days have real checkout/stayover
        // numbers? NULL (or a missing row) = robot gap = every learning
        // window spanning that day is voided. Drives the starvation banner.
        supabaseAdmin
          .from('daily_logs')
          .select('date,checkouts,stayovers')
          .eq('property_id', propertyId)
          .gte('date', censusStart)
          .limit(OCCUPANCY_CENSUS_DAYS + 4),
        // Timezone for the census: daily_logs.date is a property-LOCAL day
        // sealed through local yesterday — walking UTC dates here would fire
        // the gap banner every evening on a healthy hotel.
        supabaseAdmin
          .from('properties')
          .select('timezone')
          .eq('id', propertyId)
          .maybeSingle(),
      ]);

    const items = (itemsRes.data ?? []) as Array<{ id: string; name: string }>;
    const runs = (runsRes.data ?? []) as Array<{
      item_id: string | null;
      validation_mae: number | null;
      auto_fill_enabled: boolean | null;
      training_row_count: number | null;
      hyperparameters: Record<string, unknown> | null;
    }>;

    // Latest prediction per item.
    const predByItem = new Map<string, { rate: number | null; stock: number | null; at: string | null }>();
    for (const p of (predsRes.data ?? []) as Array<Record<string, unknown>>) {
      const id = String(p.item_id);
      if (predByItem.has(id)) continue;
      predByItem.set(id, {
        rate: p.predicted_daily_rate != null ? Number(p.predicted_daily_rate) : null,
        stock: p.predicted_current_stock != null ? Number(p.predicted_current_stock) : null,
        at: (p.predicted_at as string) ?? null,
      });
    }

    // prediction_log rows carry no item_id column — pair them back to items via
    // the inventory_count they were logged against. Look up the count → item_id.
    const logRows = (logRes.data ?? []) as Array<{
      predicted_value: number | null;
      actual_value: number | null;
      logged_at: string | null;
      inventory_count_id: string | null;
    }>;
    const logCountIds = Array.from(
      new Set(logRows.map((r) => r.inventory_count_id).filter((v): v is string => !!v)),
    );
    const countIdToItem = new Map<string, string>();
    if (logCountIds.length > 0) {
      // Chunk the IN() list so a hotel with a long comparison history stays
      // well under PostgREST's URL-length ceiling.
      const CHUNK = 200;
      for (let i = 0; i < logCountIds.length; i += CHUNK) {
        const slice = logCountIds.slice(i, i + CHUNK);
        const { data: cRows } = await supabaseAdmin
          .from('inventory_counts')
          .select('id,item_id')
          .in('id', slice);
        for (const c of (cRows ?? []) as Array<{ id: string; item_id: string }>) {
          countIdToItem.set(String(c.id), String(c.item_id));
        }
      }
    }
    // Latest comparison per item (logRows already sorted newest-first).
    const logByItem = new Map<
      string,
      { predicted: number; actual: number; errorPct: number | null; loggedAt: string | null }
    >();
    for (const r of logRows) {
      const itemId = r.inventory_count_id ? countIdToItem.get(r.inventory_count_id) : undefined;
      if (!itemId || logByItem.has(itemId)) continue;
      const predicted = r.predicted_value != null ? Number(r.predicted_value) : 0;
      const actual = r.actual_value != null ? Number(r.actual_value) : 0;
      const errorPct = actual > 1e-9 ? (Math.abs(predicted - actual) / actual) * 100 : null;
      logByItem.set(itemId, { predicted, actual, errorPct, loggedAt: r.logged_at });
    }

    // Distinct count events per item (dedupe by counted_at timestamp).
    const countEventsByItem = new Map<string, Set<string>>();
    for (const c of (countsRes.data ?? []) as Array<{ item_id: string | null; counted_at: string | null }>) {
      if (!c.item_id || !c.counted_at) continue;
      const id = String(c.item_id);
      const set = countEventsByItem.get(id) ?? new Set<string>();
      set.add(new Date(c.counted_at).toISOString());
      countEventsByItem.set(id, set);
    }

    // Per-item run signal — graduated flag + the trainer's REAL gate readings
    // (persisted in hyperparameters at every Sunday retrain).
    const runByItem = new Map<string, {
      graduated: boolean;
      rowCount: number;
      pairs: number | null;
      spanDays: number | null;
      wape: number | null;
      reason: string | null;
      windowsDropped: number;
      minWindows: number | null;
      minPairs: number | null;
    }>();
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    for (const r of runs) {
      if (!r.item_id) continue;
      const hp = (r.hyperparameters ?? {}) as Record<string, unknown>;
      runByItem.set(String(r.item_id), {
        graduated: !!r.auto_fill_enabled,
        rowCount: Number(r.training_row_count ?? 0),
        pairs: numOrNull(hp.graduation_n_pairs),
        spanDays: numOrNull(hp.graduation_span_days),
        wape: numOrNull(hp.graduation_wape),
        reason: typeof hp.graduation_reason === 'string' ? hp.graduation_reason : null,
        windowsDropped: numOrNull(hp.windows_dropped_incomplete) ?? 0,
        // Thresholds the trainer ACTUALLY applied (persisted per retrain,
        // env-overridable Python-side) — the TS constants are fallbacks for
        // runs that predate this field.
        minWindows: numOrNull(hp.graduation_min_windows),
        minPairs: numOrNull(hp.graduation_min_pairs),
      });
    }

    // Build one report row per item that has ANY AI signal (a prediction, a
    // trained model, or a logged comparison). Items with none are omitted —
    // the page shows the honest empty state when the whole list is empty.
    const reportItems: ReportItem[] = [];
    for (const it of items) {
      const pred = predByItem.get(it.id) ?? null;
      const run = runByItem.get(it.id) ?? null;
      const logged = logByItem.get(it.id) ?? null;
      if (!pred && !run && !logged) continue;

      const countEvents = countEventsByItem.get(it.id)?.size ?? run?.rowCount ?? 0;
      let status: ItemStatus;
      if (run?.graduated) status = 'graduated';
      else if (countEvents >= EVENTS_NEEDED || run) status = 'learning';
      else status = 'not-enough-data';

      reportItems.push({
        itemId: it.id,
        itemName: it.name,
        predictedDailyRate: pred?.rate ?? null,
        predictedCurrentStock: pred?.stock ?? null,
        predictedAt: pred?.at ?? null,
        lastActualRate: logged?.actual ?? null,
        lastPredictedRate: logged?.predicted ?? null,
        lastErrorPct: logged?.errorPct ?? null,
        loggedAt: logged?.loggedAt ?? null,
        status,
        countEvents,
        eventsNeeded: run?.minWindows ?? EVENTS_NEEDED,
        cleanWindows: run ? run.rowCount : null,
        prospectivePairs: run?.pairs ?? null,
        pairsNeeded: run?.minPairs ?? PAIRS_NEEDED,
        pairSpanDays: run?.spanDays ?? null,
        graduationWape: run?.wape ?? null,
        graduationReason: run?.reason ?? null,
      });
    }

    // Sort: graduated first, then learning, then not-enough-data; within a
    // group, most-recently-predicted first so the freshest signal reads at top.
    const order: Record<ItemStatus, number> = { graduated: 0, learning: 1, 'not-enough-data': 2 };
    reportItems.sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      const at = a.predictedAt ? new Date(a.predictedAt).getTime() : 0;
      const bt = b.predictedAt ? new Date(b.predictedAt).getTime() : 0;
      return bt - at;
    });

    // ── Summary block (mirrors ai-status) ────────────────────────────────
    const itemsTotal = items.length;
    const itemsWithModel = runs.length;
    const itemsGraduated = runs.filter((r) => r.auto_fill_enabled).length;

    // Gate ratio = validation_mae / mean_observed_rate, averaged across active
    // models. This is the honest "% off" figure (see ai-status Phase 2 notes).
    let gateRatio: number | null = null;
    const gateRatios: number[] = [];
    for (const r of runs) {
      const mae = r.validation_mae;
      const hp = (r.hyperparameters ?? null) as Record<string, unknown> | null;
      const meanRaw = hp ? hp.mean_observed_rate : null;
      const mean = typeof meanRaw === 'number' ? meanRaw : Number(meanRaw);
      if (mae !== null && mae !== undefined && Number.isFinite(mean) && mean > 1e-9) {
        gateRatios.push(Number(mae) / mean);
      }
    }
    if (gateRatios.length > 0) {
      gateRatio = gateRatios.reduce((a, b) => a + b, 0) / gateRatios.length;
    }

    const lastInferenceAt = lastPredRes.data?.predicted_at ?? null;
    const lastInferenceStale = (() => {
      if (!lastInferenceAt) return true;
      const ageHours = (Date.now() - new Date(lastInferenceAt).getTime()) / 3600000;
      return ageHours > STALE_INFERENCE_HOURS;
    })();
    const predictionsLast7Days = predsLast7Res.count ?? 0;

    // ── Robot-data-gap census (starvation visibility) ────────────────────
    // Fresh predictions keep flowing even when ZERO learning is happening —
    // without this, "AI learning normally" and "AI has accumulated nothing
    // for a month" look identical on this screen.
    //
    // Two false-alarm guards:
    //   • Days are PROPERTY-LOCAL, starting at local yesterday — the seal
    //     only ever writes local yesterday, so a UTC walk would flag "local
    //     today" as missing every evening on a healthy US hotel.
    //   • Days before the property's first daily_logs row don't count — a
    //     hotel onboarded 3 days ago is not "missing" 11 pre-go-live days,
    //     and those can never be repaired. No rows at all → no census (the
    //     empty/no-jobs states already cover brand-new hotels).
    const occRows = (occRes.data ?? []) as Array<{ date: string; checkouts: number | null; stayovers: number | null }>;
    const occByDate = new Map<string, boolean>();
    let earliestLogDate: string | null = null;
    for (const r of occRows) {
      const d = String(r.date);
      occByDate.set(d, r.checkouts !== null && r.stayovers !== null);
      if (earliestLogDate === null || d < earliestLogDate) earliestLogDate = d;
    }
    const tz = (propRes.data?.timezone as string | null) ?? null;
    const localToday = propertyLocalToday(new Date(), tz);
    let occupancyDaysMissing = 0;
    if (earliestLogDate !== null) {
      for (let back = 1; back <= OCCUPANCY_CENSUS_DAYS; back++) {
        const d = addDaysInTz(localToday, -back);
        if (d < earliestLogDate) break; // pre-go-live — not a robot gap
        if (!occByDate.get(d)) occupancyDaysMissing += 1;
      }
    }
    const windowsDroppedIncomplete = Array.from(runByItem.values())
      .reduce((acc, r) => acc + r.windowsDropped, 0);

    return ok(
      {
        summary: {
          itemsTotal,
          itemsWithModel,
          itemsGraduated,
          itemsTracked: reportItems.length,
          gateRatio,
          lastInferenceAt,
          lastInferenceStale,
          predictionsLast7Days,
          eventsNeeded: EVENTS_NEEDED,
          pairsNeeded: PAIRS_NEEDED,
          occupancyDaysMissing,
          occupancyCensusDays: OCCUPANCY_CENSUS_DAYS,
          windowsDroppedIncomplete,
        },
        items: reportItems,
      },
      { requestId },
    );
  } catch (e) {
    log.error('inventory/ai-report: failed', { requestId, err: e as Error });
    return err('internal_error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
