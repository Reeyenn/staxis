// ═══════════════════════════════════════════════════════════════════════════
// ML cockpit data layer — STUBS.
//
// The ML feature (src/app/admin/ml/_components/*) is in active development.
// Several admin-only components import functions and types from @/lib/db
// that haven't been implemented yet. Production deploys have been broken
// since the feature landed because the build trips on the missing exports.
//
// To unblock production deploys WITHOUT scope-creeping into the ML feature
// itself, this module provides empty-result stubs and minimal type shapes.
// The admin pages all gracefully render "No data available" / "Loading..."
// states when these return empty, so the UX is acceptable until the real
// implementations land.
//
// When the real implementations are written, REPLACE this file (or remove
// it from db.ts re-exports) — don't merge with it. Keeping the stub module
// separate makes it obvious what's still TODO.
// ═══════════════════════════════════════════════════════════════════════════

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

// ─── Stubbed reads ────────────────────────────────────────────────────────
//
// All return empty results. The admin pages render their empty states
// when these resolve to [] / null / 0. No exceptions, no console noise —
// the goal is "compiles cleanly, renders cleanly".

export async function getAdoptionPerHK(_pid: string, _days: number): Promise<HKAdoption[]> {
  return [];
}

export async function getCleaningEventStats(_pid: string): Promise<CleaningEventStats> {
  return { total: 0, last7d: 0, last24h: 0, distinctStaff: 0, distinctRooms: 0 };
}

export async function getCleaningEventsPerDay(
  _pid: string,
  _days: number,
): Promise<Array<{ date: string; count: number }>> {
  return [];
}

export async function getRecentDisagreements(
  _pid: string,
  _limit: number,
): Promise<PredictionDisagreement[]> {
  return [];
}

export async function getRecentModelRuns(
  _pid: string,
  _limit: number,
): Promise<ModelRun[]> {
  return [];
}

export async function getPipelineHealth(_pid: string): Promise<PipelineHealthSnapshot> {
  return {};
}

export async function getRecentOverrides(
  _pid: string,
  _limit: number,
): Promise<PredictionOverride[]> {
  return [];
}

export async function getRollingShadowMAE(
  _pid: string,
  _kind: 'demand' | 'supply',
  _days: number,
): Promise<MAEPoint[]> {
  return [];
}

export async function getDemandPredictionForDate(
  _pid: string,
  _date: string,
): Promise<DemandPrediction | null> {
  return null;
}
