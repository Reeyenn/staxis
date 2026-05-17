/**
 * GET /api/admin/ml/inventory/cockpit-data[?propertyId=<uuid>]
 *
 * Returns the entire inventory ML cockpit dataset in one round-trip.
 *
 * Two modes (same response shape, different scope):
 *   • No `propertyId` query → NETWORK MODE. Aggregates across every
 *     property on the platform.
 *   • With `propertyId`     → SINGLE-HOTEL MODE. Scoped to that property.
 *
 * Auth: requireAdmin. Uses supabaseAdmin so we can read across properties
 * (anon + RLS would filter out everything except properties the user
 * directly owns — fine for a GM, wrong for a platform admin).
 *
 * Response shape:
 *   {
 *     mode: 'network' | 'single',
 *     selectedProperty: { id, name } | null,
 *     properties: PropertySidebarEntry[],
 *     aggregate: AggregateStats,
 *     recentAnomalies: AnomalyRow[],
 *     topCounters: AdoptionRow[],
 *   }
 *
 * The cockpit page calls this once per visit; panels render from this
 * payload via props.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getInventoryNextScheduled } from '@/lib/ml-cron-schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const TRAINING_FRESH_SEC = 8 * 86400;       // 8 days — cron is weekly
const PREDICTION_FRESH_SEC = 36 * 3600;     // 36 hours — cron is daily

// Test-property flag comes from properties.is_test (migration 0068).
// Test properties are EXCLUDED from fleet aggregates but still listed
// in the sidebar with a 🧪 chip. Replaces an earlier name-regex
// heuristic that caused false positives on hotel names containing
// "test" and false negatives on test properties named differently.

// ─── Types ────────────────────────────────────────────────────────────────

export interface PropertySidebarEntry {
  id: string;
  name: string;
  brand: string | null;
  daysSinceFirstCount: number;
  itemsTotal: number;
  itemsGraduated: number;
  status: 'healthy' | 'warming' | 'issue';
  lastTrainingAt: string | null;
  lastPredictionAt: string | null;
  countsLast7d: number;
  /** Counts in the last hour — "active right now" indicator. */
  countsLast1h: number;
  /** ISO timestamp the property was added to the platform. */
  joinedAt: string | null;
  /** True for properties matching the test-property heuristic; excluded from fleet aggregates. */
  isTest: boolean;
}

export interface AggregateStats {
  hotelCount: number;
  totalCounts: number;
  totalCountsLast7d: number;
  totalCountsLast24h: number;
  totalCountsLast1h: number;
  totalItems: number;
  totalItemsGraduated: number;
  totalItemsLearning: number;
  fleetMedianDay: number;
  daysOfHistoryRange: { min: number; max: number };
  healthCounts: { healthy: number; warming: number; issue: number };
  daysToNextMilestoneMedian: number | null;
  nextMilestoneLabel: string;
  // Per-phase histogram counts (5 buckets: started, predicting, first-grad, mostly, mature)
  phaseHistogram: Array<{ phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }>;
  // Per-day count series (last 30 days, summed across hotels in network mode)
  dailyCountSeries: Array<{ date: string; recorded: number }>;
  // Pipeline freshness across the slice
  lastTrainingRunAt: string | null;
  lastInferenceWriteAt: string | null;
  lastAnomalyFiredAt: string | null;
  predictionsLast24h: number;
  activeItemModelCount: number;
  /** Next scheduled training cron firing (ISO). Computed at request time. */
  nextTrainingAt: string;
  /** Next scheduled inference cron firing (ISO). Computed at request time. */
  nextPredictionAt: string;
}

export interface CockpitAnomalyRow {
  id: string;
  itemId: string | null;
  itemName: string;
  reason: string;
  severity: 'info' | 'warn' | 'critical';
  ts: string;
  propertyId: string;
  propertyName: string;
}

export interface CockpitAdoptionRow {
  countedBy: string;
  countCount: number;
  itemsTouched: number;
  lastCountedAt: string | null;
  propertyId: string;
  propertyName: string;
}

export interface CockpitDataResponse {
  ok: true;
  requestId: string;
  data: {
    mode: 'network' | 'single';
    selectedProperty: { id: string; name: string } | null;
    properties: PropertySidebarEntry[];
    aggregate: AggregateStats;
    recentAnomalies: CockpitAnomalyRow[];
    topCounters: CockpitAdoptionRow[];
  };
}

// ─── Phase definitions (kept in lockstep with InventoryTimeline.tsx) ──────

const PHASES = [
  { id: 'started',    label: 'Started learning',     day: 0  },
  { id: 'predicting', label: 'First predictions',    day: 14 },
  { id: 'first-grad', label: 'First items auto-fill', day: 30 },
  { id: 'mostly',     label: 'Most items graduated', day: 60 },
  { id: 'mature',     label: 'Mature',               day: 90 },
] as const;

function phaseIndexFor(day: number): number {
  return PHASES.reduce((latest, p, idx) => (day >= p.day ? idx : latest), 0);
}

function nextMilestoneFor(day: number): { label: string; daysToNext: number | null } {
  const next = PHASES.find((p) => p.day > day);
  if (!next) return { label: 'Mature', daysToNext: null };
  return { label: next.label, daysToNext: next.day - day };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const propertyIdParam = new URL(req.url).searchParams.get('propertyId');
  if (propertyIdParam !== null && !isUuid(propertyIdParam)) {
    return err('invalid_property_id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    // 1. Properties — basic metadata for sidebar + aggregation scoping
    const { data: allProps, error: propsErr } = await supabaseAdmin
      .from('properties')
      .select('id, name, brand, inventory_ai_mode, created_at, is_test')
      .order('name', { ascending: true });
    if (propsErr) throw propsErr;
    const propsList = allProps ?? [];

    // Decide scope: list of property IDs to aggregate over.
    //
    // Network mode excludes test properties (is_test = true) from the
    // aggregate so a sandbox hotel doesn't pull "fleet median day" toward
    // 0. Test properties still appear in the sidebar with a 🧪 chip and
    // can be drilled into via ?propertyId=<uuid>; they just don't count
    // toward network rollups.
    const scopeIds: string[] = propertyIdParam
      ? propsList.filter((p) => p.id === propertyIdParam).map((p) => p.id)
      : propsList.filter((p) => !p.is_test).map((p) => p.id);

    if (propertyIdParam && scopeIds.length === 0) {
      return err('property_not_found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

    // 2. Inventory counts — pull all rows for the scope (capped); compute
    //    per-property buckets in JS. At small N this is fine; at scale we
    //    move per-property aggregation server-side via a view.
    //
    // Phase K (2026-05-13): the SQL-aggregation refactor for this and the
    // other count loops below is documented in
    // ~/.claude/plans/codex-hey-pretty-scalable-kernighan.md (Commit 5).
    // Deferred from Phase K because (a) Beaumont has 112 inventory_counts
    // total and the cockpit is sub-second today, and (b) the refactor
    // needs a 2nd migration this PR which violates the J3 30-day "no new
    // migrations" discipline. Pick this up when fleet > 10 properties OR
    // total rows > 100k OR cockpit response > 2s in prod.
    const { data: countRows } = await supabaseAdmin
      .from('inventory_counts')
      .select('property_id, item_id, counted_at')
      .in('property_id', scopeIds)
      .limit(200000);
    const counts = countRows ?? [];

    // 3. Inventory items — for itemsTotal per property
    const { data: itemRows } = await supabaseAdmin
      .from('inventory')
      .select('id, property_id')
      .in('property_id', scopeIds);
    const items = itemRows ?? [];

    // 4. Active inventory_rate models — for itemsGraduated per property
    const { data: runRows } = await supabaseAdmin
      .from('model_runs')
      .select('property_id, item_id, auto_fill_enabled, trained_at, is_active')
      .in('property_id', scopeIds)
      .eq('layer', 'inventory_rate')
      .eq('is_active', true);
    const runs = runRows ?? [];

    // 5. Inventory rate predictions — for last prediction time + count last 24h
    const { data: predRows } = await supabaseAdmin
      .from('inventory_rate_predictions')
      .select('property_id, predicted_at')
      .in('property_id', scopeIds)
      .order('predicted_at', { ascending: false })
      .limit(50000);
    const preds = predRows ?? [];

    // 6. Anomalies (app_events with event_type='inventory_anomaly')
    const { data: anomalyRows } = await supabaseAdmin
      .from('app_events')
      .select('id, property_id, metadata, ts')
      .in('property_id', scopeIds)
      .eq('event_type', 'inventory_anomaly')
      .order('ts', { ascending: false })
      .limit(100);
    const anomalies = anomalyRows ?? [];

    // 7. Counts per staff (for adoption) — last 30 days
    const { data: adoptionRows } = await supabaseAdmin
      .from('inventory_counts')
      .select('property_id, counted_by, item_id, counted_at')
      .in('property_id', scopeIds)
      .gte('counted_at', since30d)
      .limit(100000);
    const adoption = adoptionRows ?? [];

    // ── Build per-property buckets ──
    const propByName = new Map<string, string>();    // id -> name
    for (const p of propsList) propByName.set(p.id, p.name);
    const brandByProp = new Map<string, string | null>();
    for (const p of propsList) brandByProp.set(p.id, p.brand ?? null);

    // First count timestamp per property (earliest counted_at)
    const firstCountByProp = new Map<string, number>();
    for (const c of counts) {
      const t = c.counted_at ? new Date(c.counted_at).getTime() : 0;
      if (!t) continue;
      const pid = c.property_id as string;
      const prev = firstCountByProp.get(pid);
      if (prev === undefined || t < prev) firstCountByProp.set(pid, t);
    }

    // Counts per-property (with last-7d / last-24h / last-1h tallies + items touched + last-counted)
    interface PropCountTally {
      total: number; last7d: number; last24h: number; last1h: number;
      itemsSet: Set<string>; latest: number;
    }
    const tallyByProp = new Map<string, PropCountTally>();
    for (const c of counts) {
      const pid = c.property_id as string;
      if (!tallyByProp.has(pid)) {
        tallyByProp.set(pid, { total: 0, last7d: 0, last24h: 0, last1h: 0, itemsSet: new Set(), latest: 0 });
      }
      const t = c.counted_at ? new Date(c.counted_at).getTime() : 0;
      const entry = tallyByProp.get(pid)!;
      entry.total += 1;
      if (c.item_id) entry.itemsSet.add(c.item_id);
      const age = Date.now() - t;
      if (age <= 3600000) entry.last1h += 1;
      if (age <= 86400000) entry.last24h += 1;
      if (age <= 7 * 86400000) entry.last7d += 1;
      if (t > entry.latest) entry.latest = t;
    }

    // Items per property
    const itemsByProp = new Map<string, number>();
    for (const it of items) {
      const pid = it.property_id as string;
      itemsByProp.set(pid, (itemsByProp.get(pid) ?? 0) + 1);
    }

    // Active models + graduated counts per property
    const activeByProp = new Map<string, number>();
    const graduatedByProp = new Map<string, number>();
    const lastTrainingByProp = new Map<string, number>();
    for (const r of runs) {
      const pid = r.property_id as string;
      activeByProp.set(pid, (activeByProp.get(pid) ?? 0) + 1);
      if (r.auto_fill_enabled) graduatedByProp.set(pid, (graduatedByProp.get(pid) ?? 0) + 1);
      const t = r.trained_at ? new Date(r.trained_at).getTime() : 0;
      if (t > (lastTrainingByProp.get(pid) ?? 0)) lastTrainingByProp.set(pid, t);
    }

    // Last prediction per property
    const lastPredByProp = new Map<string, number>();
    let predLast24h = 0;
    for (const p of preds) {
      const pid = p.property_id as string;
      const t = p.predicted_at ? new Date(p.predicted_at).getTime() : 0;
      if (t > (lastPredByProp.get(pid) ?? 0)) lastPredByProp.set(pid, t);
      if (Date.now() - t <= 86400000) predLast24h += 1;
    }

    // ── Build sidebar entries (always all platform properties, regardless of scope) ──
    const sidebarProperties: PropertySidebarEntry[] = propsList.map((p) => {
      // For sidebar status, we need single-property metrics even when in network mode.
      // Because sidebar properties are ALL platform properties (unscoped), but our
      // bulk fetches above were scoped. So if the page is in single-hotel mode, the
      // sidebar non-selected hotels won't have count data here — fine, we mark
      // unknown as 'warming' until next sidebar navigation.
      const tally = tallyByProp.get(p.id);
      const firstAt = firstCountByProp.get(p.id) ?? null;
      const days = firstAt ? Math.max(0, Math.floor((Date.now() - firstAt) / 86400000)) : 0;
      const lastTr = lastTrainingByProp.get(p.id) ?? null;
      const lastPr = lastPredByProp.get(p.id) ?? null;

      const trainOk = lastTr !== null && (Date.now() - lastTr) / 1000 <= TRAINING_FRESH_SEC;
      const predOk = lastPr !== null && (Date.now() - lastPr) / 1000 <= PREDICTION_FRESH_SEC;
      const everRanAny = lastTr !== null || lastPr !== null;
      const status: 'healthy' | 'warming' | 'issue' =
        !everRanAny ? 'warming'
        : trainOk && predOk ? 'healthy'
        : 'issue';

      return {
        id: p.id,
        name: p.name,
        brand: p.brand ?? null,
        daysSinceFirstCount: days,
        itemsTotal: itemsByProp.get(p.id) ?? 0,
        itemsGraduated: graduatedByProp.get(p.id) ?? 0,
        status,
        lastTrainingAt: lastTr ? new Date(lastTr).toISOString() : null,
        lastPredictionAt: lastPr ? new Date(lastPr).toISOString() : null,
        countsLast7d: tally?.last7d ?? 0,
        countsLast1h: tally?.last1h ?? 0,
        joinedAt: (p as { created_at?: string }).created_at ?? null,
        isTest: Boolean(p.is_test),
      };
    });

    // ── Sidebar properties for hotels NOT in scope: fetch their per-hotel
    //    summary so the sidebar shows real stats. This applies in two cases:
    //    1) single-hotel mode → other hotels are out of scope
    //    2) network mode → test properties are filtered from scope
    {
      const otherPids = propsList.map((p) => p.id).filter((id) => !scopeIds.includes(id));
      if (otherPids.length > 0) {
        const [otherCountsRes, otherItemsRes, otherRunsRes, otherPredsRes] = await Promise.all([
          supabaseAdmin
            .from('inventory_counts')
            .select('property_id, item_id, counted_at')
            .in('property_id', otherPids)
            .limit(100000),
          supabaseAdmin
            .from('inventory')
            .select('id, property_id')
            .in('property_id', otherPids),
          supabaseAdmin
            .from('model_runs')
            .select('property_id, auto_fill_enabled, trained_at')
            .in('property_id', otherPids)
            .eq('layer', 'inventory_rate')
            .eq('is_active', true),
          supabaseAdmin
            .from('inventory_rate_predictions')
            .select('property_id, predicted_at')
            .in('property_id', otherPids)
            .order('predicted_at', { ascending: false })
            .limit(10000),
        ]);
        // Patch sidebar entries for other hotels
        const otherFirst = new Map<string, number>();
        const otherTally = new Map<string, number>();    // count_last7d
        const otherLast1h = new Map<string, number>();
        for (const c of otherCountsRes.data ?? []) {
          const pid = c.property_id as string;
          const t = c.counted_at ? new Date(c.counted_at).getTime() : 0;
          if (t && (otherFirst.get(pid) ?? Infinity) > t) otherFirst.set(pid, t);
          const age = Date.now() - t;
          if (age <= 7 * 86400000) {
            otherTally.set(pid, (otherTally.get(pid) ?? 0) + 1);
          }
          if (age <= 3600000) {
            otherLast1h.set(pid, (otherLast1h.get(pid) ?? 0) + 1);
          }
        }
        const otherItemsCount = new Map<string, number>();
        for (const it of otherItemsRes.data ?? []) {
          const pid = it.property_id as string;
          otherItemsCount.set(pid, (otherItemsCount.get(pid) ?? 0) + 1);
        }
        const otherGrad = new Map<string, number>();
        const otherLastTr = new Map<string, number>();
        for (const r of otherRunsRes.data ?? []) {
          const pid = r.property_id as string;
          if (r.auto_fill_enabled) otherGrad.set(pid, (otherGrad.get(pid) ?? 0) + 1);
          const t = r.trained_at ? new Date(r.trained_at).getTime() : 0;
          if (t > (otherLastTr.get(pid) ?? 0)) otherLastTr.set(pid, t);
        }
        const otherLastPr = new Map<string, number>();
        for (const p of otherPredsRes.data ?? []) {
          const pid = p.property_id as string;
          const t = p.predicted_at ? new Date(p.predicted_at).getTime() : 0;
          if (t > (otherLastPr.get(pid) ?? 0)) otherLastPr.set(pid, t);
        }
        for (const entry of sidebarProperties) {
          // Skip in-scope properties — they already have correct data from the
          // main fetch. We only patch out-of-scope hotels here.
          if (scopeIds.includes(entry.id)) continue;
          const firstAt = otherFirst.get(entry.id) ?? null;
          entry.daysSinceFirstCount = firstAt
            ? Math.max(0, Math.floor((Date.now() - firstAt) / 86400000)) : 0;
          entry.itemsTotal = otherItemsCount.get(entry.id) ?? 0;
          entry.itemsGraduated = otherGrad.get(entry.id) ?? 0;
          entry.countsLast7d = otherTally.get(entry.id) ?? 0;
          entry.countsLast1h = otherLast1h.get(entry.id) ?? 0;
          const lastTr = otherLastTr.get(entry.id) ?? null;
          const lastPr = otherLastPr.get(entry.id) ?? null;
          entry.lastTrainingAt = lastTr ? new Date(lastTr).toISOString() : null;
          entry.lastPredictionAt = lastPr ? new Date(lastPr).toISOString() : null;
          const trainOk = lastTr !== null && (Date.now() - lastTr) / 1000 <= TRAINING_FRESH_SEC;
          const predOk = lastPr !== null && (Date.now() - lastPr) / 1000 <= PREDICTION_FRESH_SEC;
          const everRanAny = lastTr !== null || lastPr !== null;
          entry.status = !everRanAny ? 'warming' : (trainOk && predOk) ? 'healthy' : 'issue';
        }
      }
    }

    // ── Aggregate stats ──
    const scopedSidebar = sidebarProperties.filter((p) => scopeIds.includes(p.id));
    const dayValues = scopedSidebar.map((p) => p.daysSinceFirstCount);
    const fleetMedianDay = scopedSidebar.length > 0
      ? Math.round(median(dayValues))
      : 0;
    const fleetMedianMilestone = nextMilestoneFor(fleetMedianDay);

    const totalCounts = counts.length;
    const totalCountsLast7d = scopedSidebar.reduce((s, p) => s + p.countsLast7d, 0);
    const totalCountsLast24h = scopedSidebar.reduce((s, p) => s + (tallyByProp.get(p.id)?.last24h ?? 0), 0);
    const totalCountsLast1h = scopedSidebar.reduce((s, p) => s + p.countsLast1h, 0);
    const totalItems = scopedSidebar.reduce((s, p) => s + p.itemsTotal, 0);
    const totalItemsGraduated = scopedSidebar.reduce((s, p) => s + p.itemsGraduated, 0);
    const totalItemsLearning = Math.max(0, totalItems - totalItemsGraduated);

    const healthCounts = scopedSidebar.reduce((acc, p) => {
      acc[p.status] += 1;
      return acc;
    }, { healthy: 0, warming: 0, issue: 0 } as { healthy: number; warming: number; issue: number });

    // Days of history range (per property; show min/max across the scope)
    const daysOfHistoryRange = {
      min: dayValues.length > 0 ? Math.min(...dayValues) : 0,
      max: dayValues.length > 0 ? Math.max(...dayValues) : 0,
    };

    // Phase histogram — number of hotels in each phase bucket
    const phaseHistogram = PHASES.map((p, idx) => ({
      phaseId: p.id,
      phaseLabel: p.label,
      phaseDay: p.day,
      hotelCount: scopedSidebar.filter((sp) => phaseIndexFor(sp.daysSinceFirstCount) === idx).length,
    }));

    // Daily count series (last 30 days, summed across the scope)
    const buckets = new Map<string, number>();
    for (const c of counts) {
      if (!c.counted_at) continue;
      const day = String(c.counted_at).slice(0, 10);
      buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
    const dailyCountSeries: Array<{ date: string; recorded: number }> = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      dailyCountSeries.push({ date: iso.slice(5), recorded: buckets.get(iso) ?? 0 });
    }

    // Last activity timestamps across the scope
    const lastTrainingRunAt = (() => {
      const ts = scopedSidebar.map((p) => p.lastTrainingAt).filter((s): s is string => !!s);
      return ts.length > 0 ? ts.sort().reverse()[0] : null;
    })();
    const lastInferenceWriteAt = (() => {
      const ts = scopedSidebar.map((p) => p.lastPredictionAt).filter((s): s is string => !!s);
      return ts.length > 0 ? ts.sort().reverse()[0] : null;
    })();
    const lastAnomalyFiredAt = anomalies[0]?.ts ?? null;

    const aggregate: AggregateStats = {
      hotelCount: scopedSidebar.length,
      totalCounts,
      totalCountsLast7d,
      totalCountsLast24h,
      totalCountsLast1h,
      totalItems,
      totalItemsGraduated,
      totalItemsLearning,
      fleetMedianDay,
      daysOfHistoryRange,
      healthCounts,
      daysToNextMilestoneMedian: fleetMedianMilestone.daysToNext,
      nextMilestoneLabel: fleetMedianMilestone.label,
      phaseHistogram,
      dailyCountSeries,
      lastTrainingRunAt,
      lastInferenceWriteAt,
      lastAnomalyFiredAt,
      predictionsLast24h: predLast24h,
      activeItemModelCount: scopedSidebar.reduce((s, p) => s + (activeByProp.get(p.id) ?? 0), 0),
      ...getInventoryNextScheduled(),
    };

    // ── Recent anomalies (with hotel name) ──
    const recentAnomalies: CockpitAnomalyRow[] = anomalies.slice(0, 30).map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        itemId: typeof meta.item_id === 'string' ? meta.item_id : null,
        itemName: typeof meta.item_name === 'string' ? meta.item_name : '(item)',
        reason: typeof meta.reason === 'string' ? meta.reason : '',
        severity: (typeof meta.severity === 'string' && ['info', 'warn', 'critical'].includes(meta.severity))
          ? (meta.severity as 'info' | 'warn' | 'critical')
          : 'warn',
        ts: r.ts,
        propertyId: r.property_id as string,
        propertyName: propByName.get(r.property_id as string) ?? '(unknown)',
      };
    });

    // ── Adoption / counters (with hotel name) ──
    interface AdoptionAcc {
      countedBy: string;
      propertyId: string;
      count: number;
      items: Set<string>;
      latest: number;
    }
    const adoptionByKey = new Map<string, AdoptionAcc>();
    for (const r of adoption) {
      const who = r.counted_by ?? '(unknown)';
      const pid = r.property_id as string;
      const key = `${pid}|${who}`;
      if (!adoptionByKey.has(key)) {
        adoptionByKey.set(key, { countedBy: who, propertyId: pid, count: 0, items: new Set(), latest: 0 });
      }
      const e = adoptionByKey.get(key)!;
      e.count += 1;
      if (r.item_id) e.items.add(r.item_id);
      const t = r.counted_at ? new Date(r.counted_at).getTime() : 0;
      if (t > e.latest) e.latest = t;
    }
    const topCounters: CockpitAdoptionRow[] = Array.from(adoptionByKey.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((e) => ({
        countedBy: e.countedBy,
        countCount: e.count,
        itemsTouched: e.items.size,
        lastCountedAt: e.latest > 0 ? new Date(e.latest).toISOString() : null,
        propertyId: e.propertyId,
        propertyName: propByName.get(e.propertyId) ?? '(unknown)',
      }));

    const selectedProperty = propertyIdParam
      ? { id: propertyIdParam, name: propByName.get(propertyIdParam) ?? '' }
      : null;

    return ok({
      mode: propertyIdParam ? 'single' : 'network',
      selectedProperty,
      properties: sidebarProperties,
      aggregate,
      recentAnomalies,
      topCounters,
    } as CockpitDataResponse['data'], { requestId });
  } catch (e) {
    log.error('cockpit-data: failed', { requestId, err: e as Error });
    return err('internal_error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
