// ═══════════════════════════════════════════════════════════════════════════
// ML cockpit data layer — REAL Supabase queries.
//
// Originally this file was empty stubs (May 7) that unblocked production
// deploys when the admin/ml/_components/* import surface was wider than the
// db.ts implementation. The cockpit pages all rendered "0" / "No data".
//
// This rewrite swaps each stub for a real Postgres query against the ML
// tables defined in:
//   • supabase/migrations/0012_cleaning_events.sql
//   • supabase/migrations/0021_ml_infrastructure.sql
//   • supabase/migrations/0023_ml_post_review_fixes.sql
//
// All queries are scoped by property_id and rely on RLS (the supabase
// browser client uses the signed-in user's JWT — `user_owns_property()`
// gates each row). No service-role key needed for reads on the cockpit.
//
// Filename retained for backward compatibility — db.ts re-exports from here.
// Rename to ml-cockpit.ts in a follow-up cleanup if desired.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr } from './_common';

// ─── Types consumed by admin/ml components ────────────────────────────────

export interface HKAdoption {
  staffId: string;
  staffName: string;
  roomsAssigned: number;
  roomsWithEvent: number;
  adoptionPct: number;
}

export interface ModelRun {
  id: string;
  layer: 'demand' | 'supply' | 'optimizer';
  isActive: boolean;
  trainingRowCount: number;
  validationMae: number | null;
  beatsBaselinePct: number | null;
  modelVersion: string;
  algorithm: string;
  trainedAt: string;
}

export interface PredictionDisagreement {
  id: string;
  date: string;
  layer1TotalP50: number;
  layer2SummedP50: number;
  disagreementPct: number;
}

export interface PredictionOverride {
  id: string;
  date: string;
  optimizerRecommendation: number;
  manualHeadcount: number;
  overrideReason: string | null;
}

export interface DemandPrediction {
  id: string;
  date: string;
  predictedMinutesP25: number;
  predictedMinutesP50: number;
  predictedMinutesP75: number;
  predictedMinutesP90: number;
}

export interface CleaningEventStats {
  total: number;
  last7d: number;
  last24h: number;
  distinctStaff: number;
  distinctRooms: number;
}

export interface PipelineHealthSnapshot {
  lastTrainingRunAt?: Date;
  lastInferenceRunAt?: Date;
  lastShadowLogAt?: Date;
}

export interface MAEPoint {
  date: string;
  mae: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const isoNow = () => new Date().toISOString();
const isoMinus = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const dateOnlyMinus = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * Top-line cleaning-events stats for the Data Fuel Gauge.
 *
 * Counts rows from `cleaning_events` excluding 'discarded' (sub-3-min
 * accidental taps) so the number reflects real cleans. distinctStaff /
 * distinctRooms are computed in JS — Postgres doesn't return DISTINCT counts
 * via the supabase-js client without an RPC, and the volumes per property
 * are tiny.
 */
export async function getCleaningEventStats(pid: string): Promise<CleaningEventStats> {
  // Pull every non-discarded event's (staff_id, room_number, created_at) for
  // the property. Single round-trip; capped at 100k rows defensively.
  const { data, error } = await supabase
    .from('cleaning_events')
    .select('staff_id,room_number,created_at')
    .eq('property_id', pid)
    .neq('status', 'discarded')
    .limit(100000);
  if (error) {
    logErr('getCleaningEventStats', error);
    return { total: 0, last7d: 0, last24h: 0, distinctStaff: 0, distinctRooms: 0 };
  }
  const rows = data ?? [];
  const now = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;
  const ms7d = 7 * ms24h;
  const staffSet = new Set<string>();
  const roomSet = new Set<string>();
  let last24h = 0;
  let last7d = 0;
  for (const r of rows) {
    if (r.staff_id) staffSet.add(r.staff_id);
    if (r.room_number) roomSet.add(r.room_number);
    const t = r.created_at ? new Date(r.created_at).getTime() : 0;
    const age = now - t;
    if (age <= ms24h) last24h++;
    if (age <= ms7d) last7d++;
  }
  return {
    total: rows.length,
    last7d,
    last24h,
    distinctStaff: staffSet.size,
    distinctRooms: roomSet.size,
  };
}

/**
 * Per-day count of cleaning events for the gauge's trend chart.
 * Returns an array of N most-recent days, oldest first, with zeros for
 * days that had no events so the line chart doesn't have gaps.
 */
export async function getCleaningEventsPerDay(
  pid: string,
  days: number,
): Promise<Array<{ date: string; count: number }>> {
  const since = dateOnlyMinus(days - 1);
  const { data, error } = await supabase
    .from('cleaning_events')
    .select('date')
    .eq('property_id', pid)
    .neq('status', 'discarded')
    .gte('date', since)
    .limit(100000);
  if (error) {
    logErr('getCleaningEventsPerDay', error);
    return [];
  }
  const buckets = new Map<string, number>();
  for (const r of data ?? []) {
    if (!r.date) continue;
    buckets.set(r.date, (buckets.get(r.date) ?? 0) + 1);
  }
  // Build a complete window so the chart x-axis is continuous.
  const out: Array<{ date: string; count: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso.slice(5), count: buckets.get(iso) ?? 0 });
  }
  return out;
}

/**
 * Per-housekeeper adoption — what fraction of the rooms each staff member
 * was scheduled for actually got a cleaning_events row over the lookback
 * window. Joins the schedule_assignments table (rooms assigned) against
 * cleaning_events (rooms with a Done tap).
 *
 * If schedule_assignments is sparse (the property doesn't pre-assign and
 * Maria sets status manually), falls back to "rooms touched / total active
 * staff cleans" which still gives a useful adoption signal.
 */
export async function getAdoptionPerHK(pid: string, days: number): Promise<HKAdoption[]> {
  const sinceDate = dateOnlyMinus(days - 1);

  const [assignmentsRes, eventsRes, staffRes] = await Promise.all([
    supabase
      .from('schedule_assignments')
      .select('staff_id,room_number,date')
      .eq('property_id', pid)
      .gte('date', sinceDate)
      .limit(50000),
    supabase
      .from('cleaning_events')
      .select('staff_id,room_number,date')
      .eq('property_id', pid)
      .neq('status', 'discarded')
      .gte('date', sinceDate)
      .limit(50000),
    supabase
      .from('staff')
      .select('id,name')
      .eq('property_id', pid)
      .limit(500),
  ]);

  if (eventsRes.error) {
    logErr('getAdoptionPerHK events', eventsRes.error);
    return [];
  }

  const staffNames = new Map<string, string>();
  for (const s of staffRes.data ?? []) staffNames.set(s.id, s.name);

  // Build assigned-rooms set per staff (fallback to events themselves if
  // schedule_assignments has no rows for this window).
  const assignedByStaff = new Map<string, Set<string>>();
  for (const a of assignmentsRes.data ?? []) {
    if (!a.staff_id) continue;
    const key = `${a.date}:${a.room_number}`;
    if (!assignedByStaff.has(a.staff_id)) assignedByStaff.set(a.staff_id, new Set());
    assignedByStaff.get(a.staff_id)!.add(key);
  }
  const eventsByStaff = new Map<string, Set<string>>();
  for (const e of eventsRes.data ?? []) {
    if (!e.staff_id) continue;
    const key = `${e.date}:${e.room_number}`;
    if (!eventsByStaff.has(e.staff_id)) eventsByStaff.set(e.staff_id, new Set());
    eventsByStaff.get(e.staff_id)!.add(key);
  }

  const out: HKAdoption[] = [];
  const staffIds = new Set<string>([
    ...assignedByStaff.keys(),
    ...eventsByStaff.keys(),
  ]);
  for (const sid of staffIds) {
    const assigned = assignedByStaff.get(sid)?.size ?? 0;
    const withEvent = eventsByStaff.get(sid)?.size ?? 0;
    // If assignments exist, denominator is assigned. Else fall back to
    // events as both numerator AND denominator (100%) — represents
    // "nothing to compare against" cleanly.
    const denom = assigned > 0 ? assigned : withEvent;
    const pct = denom > 0 ? Math.round((withEvent / denom) * 100) : 0;
    out.push({
      staffId: sid,
      staffName: staffNames.get(sid) ?? 'Unknown',
      roomsAssigned: assigned,
      roomsWithEvent: withEvent,
      adoptionPct: pct,
    });
  }
  // Sort by adoption descending, then by name for stability.
  out.sort((a, b) => b.adoptionPct - a.adoptionPct || a.staffName.localeCompare(b.staffName));
  return out;
}

/**
 * Most recent training runs for the cockpit's run history table. Layered
 * alongside is_active so the UI can highlight which version is in production.
 */
export async function getRecentModelRuns(pid: string, limit: number): Promise<ModelRun[]> {
  const { data, error } = await supabase
    .from('model_runs')
    .select('id,layer,is_active,training_row_count,validation_mae,beats_baseline_pct,model_version,algorithm,trained_at')
    .eq('property_id', pid)
    .order('trained_at', { ascending: false })
    .limit(limit);
  if (error) {
    logErr('getRecentModelRuns', error);
    return [];
  }
  return (data ?? []).map(r => ({
    id: r.id,
    layer: r.layer,
    isActive: !!r.is_active,
    trainingRowCount: r.training_row_count ?? 0,
    validationMae: r.validation_mae,
    beatsBaselinePct: r.beats_baseline_pct,
    modelVersion: r.model_version ?? '',
    algorithm: r.algorithm ?? '',
    trainedAt: r.trained_at ?? '',
  }));
}

/**
 * Pipeline freshness — last training run, last inference write, last
 * shadow-MAE log. Powers the "is the pipeline alive?" panel.
 */
export async function getPipelineHealth(pid: string): Promise<PipelineHealthSnapshot> {
  const [trainRes, predRes, logRes] = await Promise.all([
    supabase
      .from('model_runs')
      .select('trained_at')
      .eq('property_id', pid)
      .order('trained_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('demand_predictions')
      .select('predicted_at')
      .eq('property_id', pid)
      .order('predicted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('prediction_log')
      .select('logged_at')
      .eq('property_id', pid)
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    lastTrainingRunAt: trainRes.data?.trained_at ? new Date(trainRes.data.trained_at) : undefined,
    lastInferenceRunAt: predRes.data?.predicted_at ? new Date(predRes.data.predicted_at) : undefined,
    lastShadowLogAt: logRes.data?.logged_at ? new Date(logRes.data.logged_at) : undefined,
  };
}

/**
 * Recent disagreements between Layer 1 (top-down demand) and Layer 2
 * (bottom-up supply summed). Big disagreements = something to investigate.
 */
export async function getRecentDisagreements(pid: string, limit: number): Promise<PredictionDisagreement[]> {
  const { data, error } = await supabase
    .from('prediction_disagreement')
    .select('id,date,layer1_total_p50,layer2_summed_p50,disagreement_pct')
    .eq('property_id', pid)
    .order('date', { ascending: false })
    .limit(limit);
  if (error) {
    logErr('getRecentDisagreements', error);
    return [];
  }
  return (data ?? []).map(r => ({
    id: r.id,
    date: r.date,
    layer1TotalP50: Number(r.layer1_total_p50 ?? 0),
    layer2SummedP50: Number(r.layer2_summed_p50 ?? 0),
    disagreementPct: Number(r.disagreement_pct ?? 0),
  }));
}

/**
 * Maria's recent overrides — when she manually changed the recommended
 * headcount. The reason field, when present, is the most useful training
 * signal we have for Layer 3.
 */
export async function getRecentOverrides(pid: string, limit: number): Promise<PredictionOverride[]> {
  const { data, error } = await supabase
    .from('prediction_overrides')
    .select('id,date,optimizer_recommendation,manual_headcount,override_reason')
    .eq('property_id', pid)
    .order('date', { ascending: false })
    .limit(limit);
  if (error) {
    logErr('getRecentOverrides', error);
    return [];
  }
  return (data ?? []).map(r => ({
    id: r.id,
    date: r.date,
    optimizerRecommendation: r.optimizer_recommendation ?? 0,
    manualHeadcount: r.manual_headcount ?? 0,
    overrideReason: r.override_reason ?? null,
  }));
}

/**
 * Rolling daily MAE for the shadow chart. Joins prediction_log against the
 * cleaning_events actuals and averages absolute error per day. For the
 * supply layer, predicted_value/actual_value are minutes; for demand, sum
 * of minutes per day.
 */
export async function getRollingShadowMAE(
  pid: string,
  kind: 'demand' | 'supply',
  days: number,
): Promise<MAEPoint[]> {
  const since = isoMinus(days);
  const { data, error } = await supabase
    .from('prediction_log')
    .select('predicted_value,actual_value,logged_at,layer')
    .eq('property_id', pid)
    .eq('layer', kind)
    .gte('logged_at', since)
    .not('actual_value', 'is', null)
    .limit(50000);
  if (error) {
    logErr('getRollingShadowMAE', error);
    return [];
  }
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const r of data ?? []) {
    if (r.predicted_value == null || r.actual_value == null || !r.logged_at) continue;
    const day = String(r.logged_at).slice(0, 10);
    const b = buckets.get(day) ?? { sum: 0, n: 0 };
    b.sum += Math.abs(Number(r.predicted_value) - Number(r.actual_value));
    b.n += 1;
    buckets.set(day, b);
  }
  return Array.from(buckets.entries())
    .map(([date, b]) => ({ date: date.slice(5), mae: b.n > 0 ? b.sum / b.n : 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The active (most-recent) demand prediction for a given operational date.
 * Used by Today's Predictions panel.
 */
export async function getDemandPredictionForDate(
  pid: string,
  date: string,
): Promise<DemandPrediction | null> {
  const { data, error } = await supabase
    .from('demand_predictions')
    .select('id,date,predicted_minutes_p25,predicted_minutes_p50,predicted_minutes_p75,predicted_minutes_p90')
    .eq('property_id', pid)
    .eq('date', date)
    .order('predicted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logErr('getDemandPredictionForDate', error);
    return null;
  }
  if (!data) return null;
  return {
    id: data.id,
    date: data.date,
    predictedMinutesP25: Number(data.predicted_minutes_p25 ?? 0),
    predictedMinutesP50: Number(data.predicted_minutes_p50 ?? 0),
    predictedMinutesP75: Number(data.predicted_minutes_p75 ?? 0),
    predictedMinutesP90: Number(data.predicted_minutes_p90 ?? 0),
  };
}

// Suppress no-unused-vars on isoNow if a future query needs it.
void isoNow;
