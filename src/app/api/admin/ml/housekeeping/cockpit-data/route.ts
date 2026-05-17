/**
 * GET /api/admin/ml/housekeeping/cockpit-data[?propertyId=<uuid>]
 *
 * Mirror of /api/admin/ml/inventory/cockpit-data but for housekeeping ML.
 * Returns the entire cockpit dataset for the Housekeeping tab in one
 * round-trip.
 *
 * Two modes:
 *   • No `propertyId` → NETWORK MODE — aggregate across every platform property
 *   • With `propertyId` → SINGLE-HOTEL MODE — scoped to one property
 *
 * Auth: requireAdmin. Uses supabaseAdmin so admins can read across hotels.
 *
 * Status pips per hotel:
 *   • 🟢 healthy  — last training within 8 days AND last prediction within 36h
 *   • 🟡 warming  — no training or prediction has happened yet
 *   • 🔴 issue    — pipeline is stale beyond the freshness windows
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getHKNextScheduled } from '@/lib/ml-cron-schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const TRAINING_FRESH_SEC = 8 * 86400;
const PREDICTION_FRESH_SEC = 36 * 3600;

// Test-property flag comes from properties.is_test (migration 0068).
// Test properties are excluded from fleet aggregates but still listed
// in the sidebar with a 🧪 chip. Same model as inventory cockpit.

// ─── Types ────────────────────────────────────────────────────────────────

export interface HKPropertyEntry {
  id: string;
  name: string;
  brand: string | null;
  daysSinceFirstEvent: number;
  staffActive: number;
  modelsActive: number;
  status: 'healthy' | 'warming' | 'issue';
  lastTrainingAt: string | null;
  lastInferenceAt: string | null;
  eventsLast7d: number;
  /** Recorded events in the last hour — "working right now" indicator. */
  eventsLast1h: number;
  /** ISO timestamp the property was added to the platform. */
  joinedAt: string | null;
  /** True for test/canary properties; excluded from fleet aggregates. */
  isTest: boolean;
}

export interface HKAggregateStats {
  hotelCount: number;
  totalEvents: number;
  totalEventsLast7d: number;
  totalEventsLast24h: number;
  totalEventsLast1h: number;
  totalDiscardedEvents: number;
  distinctStaff: number;
  distinctRooms: number;
  fleetMedianDay: number;
  daysOfHistoryRange: { min: number; max: number };
  healthCounts: { healthy: number; warming: number; issue: number };
  daysToNextMilestoneMedian: number | null;
  nextMilestoneLabel: string;
  phaseHistogram: Array<{ phaseId: string; phaseLabel: string; phaseDay: number; hotelCount: number }>;
  dailyEventSeries: Array<{ date: string; recorded: number; discarded: number }>;
  lastTrainingRunAt: string | null;
  lastInferenceWriteAt: string | null;
  lastOverrideAt: string | null;
  predictionsLast24h: number;
  activeModelRunCount: number;
  optimizerActive: boolean;
  /** Next scheduled training cron firing (ISO). */
  nextTrainingAt: string;
  /** Next scheduled inference cron firing (ISO). */
  nextPredictionAt: string;
}

export interface HKOverrideRow {
  id: string;
  date: string;
  optimizerRecommendation: number;
  manualHeadcount: number;
  overrideReason: string | null;
  propertyId: string;
  propertyName: string;
}

export interface HKAdoptionRow {
  staffId: string;
  staffName: string;
  roomsAssigned: number;
  roomsWithEvent: number;
  adoptionPct: number;
  propertyId: string;
  propertyName: string;
}

export interface HKCockpitDataResponse {
  ok: true;
  requestId: string;
  data: {
    mode: 'network' | 'single';
    selectedProperty: { id: string; name: string } | null;
    properties: HKPropertyEntry[];
    aggregate: HKAggregateStats;
    recentOverrides: HKOverrideRow[];
    topAdoption: HKAdoptionRow[];
  };
}

// ─── Phases (housekeeping-specific timeline) ──────────────────────────────
//
// Phase day thresholds chosen to match the realistic ML readiness curve:
//
//   • Day 0   — First cleaning event recorded
//   • Day 30  — Demand model training threshold (~200 events typical)
//   • Day 60  — Supply model training (per-room cleaning time)
//   • Day 90  — Optimizer activates → Maria gets daily headcount recommendation
//   • Day 120 — Mature: accuracy ~±10%, override rate falling
//
// Activation is gated on event volume + accuracy in addition to time, but
// these day markers are realistic for a ~75-room hotel with daily cleans.

const PHASES = [
  { id: 'started',   label: 'Started recording',     day: 0   },
  { id: 'demand',    label: 'Demand model trains',   day: 30  },
  { id: 'supply',    label: 'Supply model trains',   day: 60  },
  { id: 'optimizer', label: 'Optimizer activates',   day: 90  },
  { id: 'mature',    label: 'Mature',                day: 120 },
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
    const { data: allProps, error: propsErr } = await supabaseAdmin
      .from('properties')
      .select('id, name, brand, created_at, is_test')
      .order('name', { ascending: true });
    if (propsErr) throw propsErr;
    const propsList = allProps ?? [];

    // Network mode excludes test properties (is_test = true) from the
    // aggregate. Test properties still appear in the sidebar with a 🧪
    // chip and can be drilled into via ?propertyId=<uuid>.
    const scopeIds: string[] = propertyIdParam
      ? propsList.filter((p) => p.id === propertyIdParam).map((p) => p.id)
      : propsList.filter((p) => !p.is_test).map((p) => p.id);

    if (propertyIdParam && scopeIds.length === 0) {
      return err('property_not_found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const since30d = new Date(Date.now() - 30 * 86400000).toISOString();
    const sinceDate30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    // Pull a wider set than the 30-day window for the phase calculation —
    // Day 0 might be 6+ months ago for some hotels.
    // Phase K (2026-05-13): the SQL-aggregation refactor for these
    // count loops is documented in
    // ~/.claude/plans/codex-hey-pretty-scalable-kernighan.md (Commit 5).
    // Deferred from Phase K because (a) Beaumont has 361 cleaning_events
    // total and the cockpit is sub-second today, and (b) the refactor
    // needs a 2nd migration this PR which violates the J3 30-day "no new
    // migrations" discipline. Pick this up when fleet > 10 properties OR
    // total rows > 100k OR cockpit response > 2s in prod.
    const [eventsAllRes, eventsRecentRes, modelRunsRes, overridesRes, scheduleRes, staffRes] = await Promise.all([
      // All events for cumulative stats + first-event lookup. Capped.
      supabaseAdmin
        .from('cleaning_events')
        .select('property_id, staff_id, room_number, status, created_at, date')
        .in('property_id', scopeIds)
        .limit(200000),
      // Recent (last 30 days) for daily-per-day chart
      supabaseAdmin
        .from('cleaning_events')
        .select('property_id, status, date')
        .in('property_id', scopeIds)
        .gte('date', sinceDate30d)
        .limit(100000),
      supabaseAdmin
        .from('model_runs')
        .select('property_id, layer, is_active, trained_at')
        .in('property_id', scopeIds)
        .in('layer', ['demand', 'supply', 'optimizer'])
        .eq('is_active', true)
        .limit(2000),
      supabaseAdmin
        .from('prediction_overrides')
        .select('id, property_id, date, optimizer_recommendation, manual_headcount, override_reason')
        .in('property_id', scopeIds)
        .order('date', { ascending: false })
        .limit(50),
      supabaseAdmin
        .from('schedule_assignments')
        .select('property_id, staff_id, room_number, date')
        .in('property_id', scopeIds)
        .gte('date', sinceDate30d)
        .limit(50000),
      supabaseAdmin
        .from('staff')
        .select('id, name, property_id')
        .in('property_id', scopeIds)
        .limit(2000),
    ]);

    if (eventsAllRes.error) throw eventsAllRes.error;

    const eventsAll = eventsAllRes.data ?? [];
    const eventsRecent = eventsRecentRes.data ?? [];
    const modelRuns = modelRunsRes.data ?? [];
    const overrides = overridesRes.data ?? [];
    const scheduleAssignments = scheduleRes.data ?? [];
    const staffRows = staffRes.data ?? [];

    const propByName = new Map<string, string>();
    for (const p of propsList) propByName.set(p.id, p.name);

    // Per-hotel buckets
    interface PropTally {
      total: number;
      last7d: number;
      last24h: number;
      last1h: number;
      discarded: number;
      staffSet: Set<string>;
      roomSet: Set<string>;
      firstAt: number;
      eventsLast7dRecorded: number;
    }
    const tally = new Map<string, PropTally>();
    for (const e of eventsAll) {
      const pid = e.property_id as string;
      if (!tally.has(pid)) {
        tally.set(pid, { total: 0, last7d: 0, last24h: 0, last1h: 0, discarded: 0, staffSet: new Set(), roomSet: new Set(), firstAt: Infinity, eventsLast7dRecorded: 0 });
      }
      const t = tally.get(pid)!;
      const status = (e.status as string) ?? '';
      if (status === 'discarded') t.discarded += 1;
      if (status !== 'discarded') {
        t.total += 1;
        if (e.staff_id) t.staffSet.add(e.staff_id);
        if (e.room_number) t.roomSet.add(e.room_number);
      }
      const ts = e.created_at ? new Date(e.created_at).getTime() : 0;
      if (ts > 0 && ts < t.firstAt) t.firstAt = ts;
      const age = Date.now() - ts;
      if (age <= 3600000 && status !== 'discarded') t.last1h += 1;
      if (age <= 86400000 && status !== 'discarded') t.last24h += 1;
      if (age <= 7 * 86400000 && status !== 'discarded') t.last7d += 1;
    }

    // Active model runs per property (any of demand/supply/optimizer)
    const modelsByProp = new Map<string, { count: number; layers: Set<string>; lastTrainingAt: number }>();
    for (const r of modelRuns) {
      const pid = r.property_id as string;
      if (!modelsByProp.has(pid)) {
        modelsByProp.set(pid, { count: 0, layers: new Set(), lastTrainingAt: 0 });
      }
      const m = modelsByProp.get(pid)!;
      m.count += 1;
      m.layers.add(r.layer as string);
      const t = r.trained_at ? new Date(r.trained_at).getTime() : 0;
      if (t > m.lastTrainingAt) m.lastTrainingAt = t;
    }

    // Last inference per property — pull demand_predictions
    const { data: demandPredsRes } = await supabaseAdmin
      .from('demand_predictions')
      .select('property_id, predicted_at')
      .in('property_id', scopeIds)
      .order('predicted_at', { ascending: false })
      .limit(2000);
    const lastInferByProp = new Map<string, number>();
    let predLast24h = 0;
    for (const p of demandPredsRes ?? []) {
      const pid = p.property_id as string;
      const t = p.predicted_at ? new Date(p.predicted_at).getTime() : 0;
      if (t > (lastInferByProp.get(pid) ?? 0)) lastInferByProp.set(pid, t);
      if (Date.now() - t <= 86400000) predLast24h += 1;
    }

    // ── Build property entries (sidebar status pips) ──
    const properties: HKPropertyEntry[] = propsList.map((p) => {
      const t = tally.get(p.id);
      const firstAt = t && t.firstAt !== Infinity ? t.firstAt : null;
      const days = firstAt ? Math.max(0, Math.floor((Date.now() - firstAt) / 86400000)) : 0;
      const lastTr = modelsByProp.get(p.id)?.lastTrainingAt ?? null;
      const lastIn = lastInferByProp.get(p.id) ?? null;
      const trainOk = lastTr !== null && (Date.now() - lastTr) / 1000 <= TRAINING_FRESH_SEC;
      const predOk = lastIn !== null && (Date.now() - lastIn) / 1000 <= PREDICTION_FRESH_SEC;
      const everRanAny = lastTr !== null || lastIn !== null;
      const status: 'healthy' | 'warming' | 'issue' =
        !everRanAny ? 'warming'
        : trainOk && predOk ? 'healthy'
        : 'issue';
      return {
        id: p.id,
        name: p.name,
        brand: p.brand ?? null,
        daysSinceFirstEvent: days,
        staffActive: t ? t.staffSet.size : 0,
        modelsActive: modelsByProp.get(p.id)?.count ?? 0,
        status,
        lastTrainingAt: lastTr ? new Date(lastTr).toISOString() : null,
        lastInferenceAt: lastIn ? new Date(lastIn).toISOString() : null,
        eventsLast7d: t?.last7d ?? 0,
        eventsLast1h: t?.last1h ?? 0,
        joinedAt: (p as { created_at?: string }).created_at ?? null,
        isTest: Boolean(p.is_test),
      };
    });

    // ── Sidebar properties for hotels NOT in scope: fetch their per-hotel
    //    summary too, otherwise their sidebar entries show empty stats
    //    (mirrors the inventory cockpit's behavior). Also covers test
    //    properties when network mode excludes them from the main fetch.
    const otherPids = propsList.map((p) => p.id).filter((id) => !scopeIds.includes(id));
    if (otherPids.length > 0) {
      const [otherEventsRes, otherRunsRes, otherPredsRes] = await Promise.all([
        supabaseAdmin
          .from('cleaning_events')
          .select('property_id, staff_id, room_number, status, created_at')
          .in('property_id', otherPids)
          .limit(100000),
        supabaseAdmin
          .from('model_runs')
          .select('property_id, trained_at')
          .in('property_id', otherPids)
          .in('layer', ['demand', 'supply', 'optimizer'])
          .eq('is_active', true),
        supabaseAdmin
          .from('demand_predictions')
          .select('property_id, predicted_at')
          .in('property_id', otherPids)
          .order('predicted_at', { ascending: false })
          .limit(2000),
      ]);
      const otherFirst = new Map<string, number>();
      const otherLast7d = new Map<string, number>();
      const otherLast1h = new Map<string, number>();
      const otherStaff = new Map<string, Set<string>>();
      for (const e of otherEventsRes.data ?? []) {
        const pid = e.property_id as string;
        const t = e.created_at ? new Date(e.created_at).getTime() : 0;
        const status = (e.status as string) ?? '';
        if (!t) continue;
        if (status === 'discarded') continue;
        if ((otherFirst.get(pid) ?? Infinity) > t) otherFirst.set(pid, t);
        const age = Date.now() - t;
        if (age <= 7 * 86400000) otherLast7d.set(pid, (otherLast7d.get(pid) ?? 0) + 1);
        if (age <= 3600000) otherLast1h.set(pid, (otherLast1h.get(pid) ?? 0) + 1);
        if (e.staff_id) {
          if (!otherStaff.has(pid)) otherStaff.set(pid, new Set());
          otherStaff.get(pid)!.add(e.staff_id);
        }
      }
      const otherModels = new Map<string, number>();
      const otherLastTr = new Map<string, number>();
      for (const r of otherRunsRes.data ?? []) {
        const pid = r.property_id as string;
        otherModels.set(pid, (otherModels.get(pid) ?? 0) + 1);
        const t = r.trained_at ? new Date(r.trained_at).getTime() : 0;
        if (t > (otherLastTr.get(pid) ?? 0)) otherLastTr.set(pid, t);
      }
      const otherLastIn = new Map<string, number>();
      for (const p of otherPredsRes.data ?? []) {
        const pid = p.property_id as string;
        const t = p.predicted_at ? new Date(p.predicted_at).getTime() : 0;
        if (t > (otherLastIn.get(pid) ?? 0)) otherLastIn.set(pid, t);
      }
      for (const entry of properties) {
        if (scopeIds.includes(entry.id)) continue;
        const firstAt = otherFirst.get(entry.id) ?? null;
        entry.daysSinceFirstEvent = firstAt
          ? Math.max(0, Math.floor((Date.now() - firstAt) / 86400000)) : 0;
        entry.staffActive = otherStaff.get(entry.id)?.size ?? 0;
        entry.modelsActive = otherModels.get(entry.id) ?? 0;
        entry.eventsLast7d = otherLast7d.get(entry.id) ?? 0;
        entry.eventsLast1h = otherLast1h.get(entry.id) ?? 0;
        const lastTr = otherLastTr.get(entry.id) ?? null;
        const lastIn = otherLastIn.get(entry.id) ?? null;
        entry.lastTrainingAt = lastTr ? new Date(lastTr).toISOString() : null;
        entry.lastInferenceAt = lastIn ? new Date(lastIn).toISOString() : null;
        const trainOk = lastTr !== null && (Date.now() - lastTr) / 1000 <= TRAINING_FRESH_SEC;
        const predOk = lastIn !== null && (Date.now() - lastIn) / 1000 <= PREDICTION_FRESH_SEC;
        const everRanAny = lastTr !== null || lastIn !== null;
        entry.status = !everRanAny ? 'warming' : (trainOk && predOk) ? 'healthy' : 'issue';
      }
    }

    // Scoped sidebar (only the hotels we aggregate over)
    const scopedProps = properties.filter((p) => scopeIds.includes(p.id));
    const dayValues = scopedProps.map((p) => p.daysSinceFirstEvent);
    const fleetMedianDay = scopedProps.length > 0 ? Math.round(median(dayValues)) : 0;
    const nextMilestone = nextMilestoneFor(fleetMedianDay);

    // Aggregate counts
    const totalEvents = scopedProps.reduce((s, p) => s + (tally.get(p.id)?.total ?? 0), 0);
    const totalEventsLast7d = scopedProps.reduce((s, p) => s + (tally.get(p.id)?.last7d ?? 0), 0);
    const totalEventsLast24h = scopedProps.reduce((s, p) => s + (tally.get(p.id)?.last24h ?? 0), 0);
    const totalEventsLast1h = scopedProps.reduce((s, p) => s + (tally.get(p.id)?.last1h ?? 0), 0);
    const totalDiscardedEvents = scopedProps.reduce((s, p) => s + (tally.get(p.id)?.discarded ?? 0), 0);
    const distinctStaff = (() => {
      const set = new Set<string>();
      for (const p of scopedProps) {
        const t = tally.get(p.id);
        if (!t) continue;
        for (const s of t.staffSet) set.add(s);
      }
      return set.size;
    })();
    const distinctRooms = (() => {
      const set = new Set<string>();
      for (const p of scopedProps) {
        const t = tally.get(p.id);
        if (!t) continue;
        for (const r of t.roomSet) set.add(r);
      }
      return set.size;
    })();

    const healthCounts = scopedProps.reduce((acc, p) => { acc[p.status] += 1; return acc; },
      { healthy: 0, warming: 0, issue: 0 } as { healthy: number; warming: number; issue: number });

    const daysOfHistoryRange = {
      min: dayValues.length > 0 ? Math.min(...dayValues) : 0,
      max: dayValues.length > 0 ? Math.max(...dayValues) : 0,
    };

    const phaseHistogram = PHASES.map((p, idx) => ({
      phaseId: p.id,
      phaseLabel: p.label,
      phaseDay: p.day,
      hotelCount: scopedProps.filter((sp) => phaseIndexFor(sp.daysSinceFirstEvent) === idx).length,
    }));

    // Daily series (recorded vs discarded), 30 days
    const recordedByDate = new Map<string, number>();
    const discardedByDate = new Map<string, number>();
    for (const e of eventsRecent) {
      if (!e.date) continue;
      const day = String(e.date);
      const status = (e.status as string) ?? '';
      if (status === 'discarded') discardedByDate.set(day, (discardedByDate.get(day) ?? 0) + 1);
      else recordedByDate.set(day, (recordedByDate.get(day) ?? 0) + 1);
    }
    const dailyEventSeries: Array<{ date: string; recorded: number; discarded: number }> = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      dailyEventSeries.push({
        date: iso.slice(5),
        recorded: recordedByDate.get(iso) ?? 0,
        discarded: discardedByDate.get(iso) ?? 0,
      });
    }

    const lastTrainingRunAt = (() => {
      const ts = scopedProps.map((p) => p.lastTrainingAt).filter((s): s is string => !!s);
      return ts.length > 0 ? ts.sort().reverse()[0] : null;
    })();
    const lastInferenceWriteAt = (() => {
      const ts = scopedProps.map((p) => p.lastInferenceAt).filter((s): s is string => !!s);
      return ts.length > 0 ? ts.sort().reverse()[0] : null;
    })();
    const lastOverrideAt = overrides[0]?.date ?? null;

    const optimizerActive = modelRuns.some((r) => r.layer === 'optimizer' && r.is_active);

    const aggregate: HKAggregateStats = {
      hotelCount: scopedProps.length,
      totalEvents,
      totalEventsLast7d,
      totalEventsLast24h,
      totalEventsLast1h,
      totalDiscardedEvents,
      distinctStaff,
      distinctRooms,
      fleetMedianDay,
      daysOfHistoryRange,
      healthCounts,
      daysToNextMilestoneMedian: nextMilestone.daysToNext,
      nextMilestoneLabel: nextMilestone.label,
      phaseHistogram,
      dailyEventSeries,
      lastTrainingRunAt,
      lastInferenceWriteAt,
      lastOverrideAt,
      predictionsLast24h: predLast24h,
      activeModelRunCount: scopedProps.reduce((s, p) => s + p.modelsActive, 0),
      optimizerActive,
      ...getHKNextScheduled(),
    };

    // Recent overrides (with hotel names)
    const recentOverrides: HKOverrideRow[] = overrides.slice(0, 30).map((r) => ({
      id: r.id,
      date: r.date,
      optimizerRecommendation: Number(r.optimizer_recommendation ?? 0),
      manualHeadcount: Number(r.manual_headcount ?? 0),
      overrideReason: r.override_reason ?? null,
      propertyId: r.property_id as string,
      propertyName: propByName.get(r.property_id as string) ?? '(unknown)',
    }));

    // Top adoption: per-staff (assigned vs touched) across the scope
    const staffNames = new Map<string, string>();
    for (const s of staffRows) staffNames.set(s.id, s.name);
    interface AdoptionAcc {
      staffId: string;
      propertyId: string;
      assigned: Set<string>;
      withEvent: Set<string>;
    }
    const adoptionByKey = new Map<string, AdoptionAcc>();
    for (const a of scheduleAssignments) {
      if (!a.staff_id) continue;
      const key = `${a.property_id}|${a.staff_id}`;
      if (!adoptionByKey.has(key)) {
        adoptionByKey.set(key, { staffId: a.staff_id, propertyId: a.property_id as string, assigned: new Set(), withEvent: new Set() });
      }
      adoptionByKey.get(key)!.assigned.add(`${a.date}:${a.room_number}`);
    }
    for (const e of eventsRecent) {
      if ((e.status as string) === 'discarded') continue;
      const fullEvent = eventsAll.find((x) => x.property_id === e.property_id && x.status === e.status && x.date === e.date);
      const sid = fullEvent?.staff_id;
      if (!sid) continue;
      const key = `${e.property_id}|${sid}`;
      if (!adoptionByKey.has(key)) {
        adoptionByKey.set(key, { staffId: sid, propertyId: e.property_id as string, assigned: new Set(), withEvent: new Set() });
      }
      const room = fullEvent?.room_number;
      if (room) adoptionByKey.get(key)!.withEvent.add(`${e.date}:${room}`);
    }
    const topAdoption: HKAdoptionRow[] = Array.from(adoptionByKey.values())
      .map((a) => {
        const denom = a.assigned.size > 0 ? a.assigned.size : a.withEvent.size;
        const pct = denom > 0 ? Math.round((a.withEvent.size / denom) * 100) : 0;
        return {
          staffId: a.staffId,
          staffName: staffNames.get(a.staffId) ?? 'Unknown',
          roomsAssigned: a.assigned.size,
          roomsWithEvent: a.withEvent.size,
          adoptionPct: pct,
          propertyId: a.propertyId,
          propertyName: propByName.get(a.propertyId) ?? '(unknown)',
        };
      })
      .sort((a, b) => b.roomsWithEvent - a.roomsWithEvent || b.adoptionPct - a.adoptionPct)
      .slice(0, 15);

    const selectedProperty = propertyIdParam
      ? { id: propertyIdParam, name: propByName.get(propertyIdParam) ?? '' }
      : null;

    return ok({
      mode: propertyIdParam ? 'single' : 'network',
      selectedProperty,
      properties,
      aggregate,
      recentOverrides,
      topAdoption,
    } as HKCockpitDataResponse['data'], { requestId });
  } catch (e) {
    log.error('hk cockpit-data: failed', { requestId, err: e as Error });
    return err('internal_error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
