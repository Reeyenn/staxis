// ═══════════════════════════════════════════════════════════════════════════
// ML Infrastructure — data layer for the /admin/ml cockpit
//
// Readonly queries over model_runs, predictions, disagreements, overrides,
// and pipeline metrics. All rows are RLS-scoped via owner_id checks.
// No writes here — the ML service owns the write path.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  PostgresChangesPayload,
} from './_common';
import { supabase, logErr, subscribeTable } from './_common';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelRun {
  id: string;
  propertyId: string;
  layer: 'demand' | 'supply' | 'optimizer';
  trainedAt: Date;
  trainingRowCount: number;
  modelVersion: string;
  algorithm: string;
  validationMae: number | null;
  baselineMae: number | null;
  beatsBaselinePct: number | null;
  isActive: boolean;
  activatedAt: Date | null;
  consecutivePassingRuns: number;
}

export interface DemandPrediction {
  id: string;
  propertyId: string;
  date: string;
  predictedMinutesP50: number;
  predictedMinutesP25?: number;
  predictedMinutesP75?: number;
  predictedMinutesP90?: number;
  modelRunId: string;
  predictedAt: Date;
}

export interface PredictionLogEntry {
  id: string;
  propertyId: string;
  layer: 'demand' | 'supply';
  date: string;
  predictedValue: number;
  actualValue: number;
  absError: number;
  modelRunId: string;
  loggedAt: Date;
}

export interface PredictionDisagreement {
  id: string;
  propertyId: string;
  date: string;
  layer1TotalP50: number;
  layer2SummedP50: number;
  disagreementPct: number;
  detectedAt: Date;
}

export interface PredictionOverride {
  id: string;
  propertyId: string;
  date: string;
  optimizerRecommendation: number;
  manualHeadcount: number;
  overrideReason?: string;
  overrideAt: Date;
  outcomeRecordedAt?: Date;
  outcomeActualMinutesWorked?: number;
  outcomeCompletedOnTime?: boolean;
}

export interface MLFeatureFlags {
  propertyId: string;
  predictionsEnabled: boolean;
  demandLayerEnabled: boolean;
  supplyLayerEnabled: boolean;
  optimizerEnabled: boolean;
  shadowModeEnabled: boolean;
  targetCompletionProb: number;
  updatedAt: Date;
}

// ─── Mappers ────────────────────────────────────────────────────────────────

function fromModelRunRow(r: Record<string, unknown>): ModelRun {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    layer: String(r.layer) as 'demand' | 'supply' | 'optimizer',
    trainedAt: new Date(String(r.trained_at)),
    trainingRowCount: Number(r.training_row_count),
    modelVersion: String(r.model_version),
    algorithm: String(r.algorithm),
    validationMae: r.validation_mae ? Number(r.validation_mae) : null,
    baselineMae: r.baseline_mae ? Number(r.baseline_mae) : null,
    beatsBaselinePct: r.beats_baseline_pct ? Number(r.beats_baseline_pct) : null,
    isActive: Boolean(r.is_active),
    activatedAt: r.activated_at ? new Date(String(r.activated_at)) : null,
    consecutivePassingRuns: Number(r.consecutive_passing_runs ?? 0),
  };
}

function fromDemandPredictionRow(r: Record<string, unknown>): DemandPrediction {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    date: String(r.date),
    predictedMinutesP50: Number(r.predicted_minutes_p50),
    predictedMinutesP25: r.predicted_minutes_p25 ? Number(r.predicted_minutes_p25) : undefined,
    predictedMinutesP75: r.predicted_minutes_p75 ? Number(r.predicted_minutes_p75) : undefined,
    predictedMinutesP90: r.predicted_minutes_p90 ? Number(r.predicted_minutes_p90) : undefined,
    modelRunId: String(r.model_run_id),
    predictedAt: new Date(String(r.predicted_at)),
  };
}

function fromPredictionLogRow(r: Record<string, unknown>): PredictionLogEntry {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    layer: String(r.layer) as 'demand' | 'supply',
    date: String(r.date),
    predictedValue: Number(r.predicted_value),
    actualValue: Number(r.actual_value),
    absError: Number(r.abs_error),
    modelRunId: String(r.model_run_id),
    loggedAt: new Date(String(r.logged_at)),
  };
}

function fromDisagreementRow(r: Record<string, unknown>): PredictionDisagreement {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    date: String(r.date),
    layer1TotalP50: Number(r.layer1_total_p50),
    layer2SummedP50: Number(r.layer2_summed_p50),
    disagreementPct: Number(r.disagreement_pct),
    detectedAt: new Date(String(r.detected_at)),
  };
}

function fromOverrideRow(r: Record<string, unknown>): PredictionOverride {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    date: String(r.date),
    optimizerRecommendation: Number(r.optimizer_recommendation),
    manualHeadcount: Number(r.manual_headcount),
    overrideReason: r.override_reason ? String(r.override_reason) : undefined,
    overrideAt: new Date(String(r.override_at)),
    outcomeRecordedAt: r.outcome_recorded_at ? new Date(String(r.outcome_recorded_at)) : undefined,
    outcomeActualMinutesWorked: r.outcome_actual_minutes_worked ? Number(r.outcome_actual_minutes_worked) : undefined,
    outcomeCompletedOnTime: r.outcome_completed_on_time != null ? Boolean(r.outcome_completed_on_time) : undefined,
  };
}

function fromMLFeatureFlagsRow(r: Record<string, unknown>): MLFeatureFlags {
  return {
    propertyId: String(r.property_id),
    predictionsEnabled: Boolean(r.predictions_enabled ?? true),
    demandLayerEnabled: Boolean(r.demand_layer_enabled ?? true),
    supplyLayerEnabled: Boolean(r.supply_layer_enabled ?? true),
    optimizerEnabled: Boolean(r.optimizer_enabled ?? true),
    shadowModeEnabled: Boolean(r.shadow_mode_enabled ?? true),
    targetCompletionProb: Number(r.target_completion_prob ?? 0.95),
    updatedAt: new Date(String(r.updated_at)),
  };
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function subscribeToActiveModelRuns(
  propertyId: string,
  callback: (runs: ModelRun[]) => void,
): Promise<() => void> {
  return subscribeTable(
    `ml-active-runs-${propertyId}`,
    'model_runs',
    `property_id=eq.${propertyId}`,
    async () => {
      const { data, error } = await supabase
        .from('model_runs')
        .select('*')
        .eq('property_id', propertyId)
        .eq('is_active', true)
        .order('trained_at', { ascending: false });
      if (error) { logErr('subscribeToActiveModelRuns', error); throw error; }
      return (data ?? []).map(fromModelRunRow);
    },
    callback,
    (payload) => String(payload.new?.property_id) === propertyId || String(payload.old?.property_id) === propertyId,
  );
}

export async function getRecentModelRuns(
  propertyId: string,
  limit: number = 10,
): Promise<ModelRun[]> {
  const { data, error } = await supabase
    .from('model_runs')
    .select('*')
    .eq('property_id', propertyId)
    .order('trained_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('getRecentModelRuns', error); throw error; }
  return (data ?? []).map(fromModelRunRow);
}

export async function getDemandPredictionForDate(
  propertyId: string,
  date: string,
): Promise<DemandPrediction | null> {
  const { data, error } = await supabase
    .from('demand_predictions')
    .select('*')
    .eq('property_id', propertyId)
    .eq('date', date)
    .maybeSingle();
  if (error) { logErr('getDemandPredictionForDate', error); throw error; }
  return data ? fromDemandPredictionRow(data) : null;
}

export async function getOptimizerResultForDate(
  propertyId: string,
  date: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('optimizer_results')
    .select('*')
    .eq('property_id', propertyId)
    .eq('date', date)
    .maybeSingle();
  if (error) { logErr('getOptimizerResultForDate', error); throw error; }
  return data ?? null;
}

export async function getRollingShadowMAE(
  propertyId: string,
  layer: 'demand' | 'supply',
  days: number = 14,
): Promise<Array<{ date: string; mae: number }>> {
  // Fetch prediction_log entries for the last N days and aggregate by date
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('prediction_log')
    .select('date, abs_error')
    .eq('property_id', propertyId)
    .eq('layer', layer)
    .gte('logged_at', startDate.toISOString())
    .order('date', { ascending: true });

  if (error) { logErr('getRollingShadowMAE', error); throw error; }

  // Aggregate by date
  const byDate = new Map<string, number[]>();
  (data ?? []).forEach(row => {
    const d = String(row.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(Number(row.abs_error));
  });

  const result: Array<{ date: string; mae: number }> = [];
  Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([date, errors]) => {
      const mae = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
      result.push({ date, mae });
    });

  return result;
}

export async function getCleaningEventStats(
  propertyId: string,
): Promise<{
  total: number;
  last7d: number;
  last24h: number;
  distinctStaff: number;
  distinctRooms: number;
}> {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: total, error: err1 } = await supabase
    .from('cleaning_events')
    .select('id')
    .eq('property_id', propertyId);
  if (err1) { logErr('getCleaningEventStats-total', err1); throw err1; }

  const { data: l7d, error: err2 } = await supabase
    .from('cleaning_events')
    .select('id')
    .eq('property_id', propertyId)
    .gte('done_at', last7d.toISOString());
  if (err2) { logErr('getCleaningEventStats-7d', err2); throw err2; }

  const { data: l24h, error: err3 } = await supabase
    .from('cleaning_events')
    .select('id')
    .eq('property_id', propertyId)
    .gte('done_at', last24h.toISOString());
  if (err3) { logErr('getCleaningEventStats-24h', err3); throw err3; }

  const { data: staff, error: err4 } = await supabase
    .from('cleaning_events')
    .select('staff_id')
    .eq('property_id', propertyId)
    .gte('done_at', last7d.toISOString());
  if (err4) { logErr('getCleaningEventStats-staff', err4); throw err4; }

  const { data: rooms, error: err5 } = await supabase
    .from('cleaning_events')
    .select('room_number')
    .eq('property_id', propertyId)
    .gte('done_at', last7d.toISOString());
  if (err5) { logErr('getCleaningEventStats-rooms', err5); throw err5; }

  const distinctStaff = new Set((staff ?? []).map(r => r.staff_id)).size;
  const distinctRooms = new Set((rooms ?? []).map(r => r.room_number)).size;

  return {
    total: (total ?? []).length,
    last7d: (l7d ?? []).length,
    last24h: (l24h ?? []).length,
    distinctStaff,
    distinctRooms,
  };
}

export async function getAdoptionPerHK(
  propertyId: string,
  days: number = 7,
): Promise<Array<{ staffId: string; staffName: string; roomsAssigned: number; roomsWithEvent: number; adoptionPct: number }>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Get all cleaning events for this period
  const { data: events, error: evErr } = await supabase
    .from('cleaning_events')
    .select('staff_id, staff_name')
    .eq('property_id', propertyId)
    .gte('done_at', startDate.toISOString());
  if (evErr) { logErr('getAdoptionPerHK-events', evErr); throw evErr; }

  // Get all schedule assignments for this period
  const { data: assigns, error: asErr } = await supabase
    .from('schedule_assignments')
    .select('crew')
    .eq('property_id', propertyId)
    .gte('date', startDate.toISOString().split('T')[0]);
  if (asErr) { logErr('getAdoptionPerHK-assigns', asErr); throw asErr; }

  // Count events per HK
  const eventsByHK = new Map<string, { count: number; name: string }>();
  (events ?? []).forEach(e => {
    const id = String(e.staff_id);
    const name = String(e.staff_name || '');
    if (!eventsByHK.has(id)) {
      eventsByHK.set(id, { count: 0, name });
    }
    const entry = eventsByHK.get(id)!;
    entry.count += 1;
    if (name && !entry.name) entry.name = name;
  });

  // Count assignments per HK (crew is a UUID array in schedule_assignments)
  const assignsByHK = new Map<string, number>();
  (assigns ?? []).forEach(row => {
    const crew = row.crew as string[] | null | undefined;
    if (Array.isArray(crew)) {
      crew.forEach(staffId => {
        assignsByHK.set(staffId, (assignsByHK.get(staffId) ?? 0) + 1);
      });
    }
  });

  // Merge and compute adoption %
  const result: Array<{ staffId: string; staffName: string; roomsAssigned: number; roomsWithEvent: number; adoptionPct: number }> = [];
  const allStaffIds = new Set([...eventsByHK.keys(), ...assignsByHK.keys()]);
  allStaffIds.forEach(staffId => {
    const evEntry = eventsByHK.get(staffId);
    const assigned = assignsByHK.get(staffId) ?? 0;
    const withEvent = evEntry?.count ?? 0;
    const adoptionPct = assigned > 0 ? Math.round((withEvent / assigned) * 100) : 0;
    result.push({
      staffId,
      staffName: evEntry?.name ?? '',
      roomsAssigned: assigned,
      roomsWithEvent: withEvent,
      adoptionPct,
    });
  });

  return result.sort((a, b) => b.adoptionPct - a.adoptionPct);
}

export async function getRecentDisagreements(
  propertyId: string,
  limit: number = 20,
): Promise<PredictionDisagreement[]> {
  const { data, error } = await supabase
    .from('prediction_disagreement')
    .select('*')
    .eq('property_id', propertyId)
    .order('detected_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('getRecentDisagreements', error); throw error; }
  return (data ?? []).map(fromDisagreementRow);
}

export async function getRecentOverrides(
  propertyId: string,
  limit: number = 20,
): Promise<PredictionOverride[]> {
  const { data, error } = await supabase
    .from('prediction_overrides')
    .select('*')
    .eq('property_id', propertyId)
    .order('override_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('getRecentOverrides', error); throw error; }
  return (data ?? []).map(fromOverrideRow);
}

export async function getMLFeatureFlags(
  propertyId: string,
): Promise<MLFeatureFlags | null> {
  const { data, error } = await supabase
    .from('ml_feature_flags')
    .select('*')
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) { logErr('getMLFeatureFlags', error); throw error; }
  return data ? fromMLFeatureFlagsRow(data) : null;
}

export async function setMLFeatureFlag(
  propertyId: string,
  key: keyof Omit<MLFeatureFlags, 'propertyId' | 'updatedAt'>,
  value: unknown,
): Promise<void> {
  const colMap: Record<string, string> = {
    predictionsEnabled: 'predictions_enabled',
    demandLayerEnabled: 'demand_layer_enabled',
    supplyLayerEnabled: 'supply_layer_enabled',
    optimizerEnabled: 'optimizer_enabled',
    shadowModeEnabled: 'shadow_mode_enabled',
    targetCompletionProb: 'target_completion_prob',
  };
  const col = colMap[key];
  if (!col) throw new Error(`Unknown ML feature flag: ${key}`);

  const { error } = await supabase
    .from('ml_feature_flags')
    .update({ [col]: value, updated_at: new Date().toISOString() })
    .eq('property_id', propertyId);
  if (error) { logErr('setMLFeatureFlag', error); throw error; }
}

export async function getCleaningEventsPerDay(
  propertyId: string,
  days: number = 30,
): Promise<Array<{ date: string; count: number }>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const { data, error } = await supabase
    .from('cleaning_events')
    .select('done_at')
    .eq('property_id', propertyId)
    .gte('done_at', startDate.toISOString());
  if (error) { logErr('getCleaningEventsPerDay', error); throw error; }

  const byDate = new Map<string, number>();
  (data ?? []).forEach(row => {
    const doneAt = row.done_at ? new Date(String(row.done_at)) : null;
    if (doneAt) {
      const dateStr = doneAt.toISOString().split('T')[0];
      byDate.set(dateStr, (byDate.get(dateStr) ?? 0) + 1);
    }
  });

  const result: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    result.push({ date: dateStr, count: byDate.get(dateStr) ?? 0 });
  }

  return result;
}

export async function getPipelineHealth(
  propertyId: string,
): Promise<{
  lastTrainingRunAt?: Date;
  lastTrainingStatus?: string;
  lastInferenceRunAt?: Date;
  lastInferenceCount?: number;
  lastShadowLogAt?: Date;
}> {
  // Last training run (from model_runs)
  const { data: lastRun } = await supabase
    .from('model_runs')
    .select('trained_at')
    .eq('property_id', propertyId)
    .order('trained_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Last prediction (inference)
  const { data: lastPred } = await supabase
    .from('demand_predictions')
    .select('predicted_at')
    .eq('property_id', propertyId)
    .order('predicted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Last shadow log entry
  const { data: lastLog } = await supabase
    .from('prediction_log')
    .select('logged_at')
    .eq('property_id', propertyId)
    .order('logged_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    lastTrainingRunAt: lastRun?.trained_at ? new Date(String(lastRun.trained_at)) : undefined,
    lastInferenceRunAt: lastPred?.predicted_at ? new Date(String(lastPred.predicted_at)) : undefined,
    lastShadowLogAt: lastLog?.logged_at ? new Date(String(lastLog.logged_at)) : undefined,
  };
}
