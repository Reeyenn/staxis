/**
 * ML Schedule Helpers — P6 integration utilities
 *
 * Optimizer inputs_snapshot parsing + honest model-state classification.
 * Imported by the housekeeping forecast route (and unit tests).
 */

/**
 * Honest model-state classification surfaced to the UI tile / tooltip.
 *
 * Derived from the Python optimizer's `inputs_snapshot` keys:
 *   - `'fitted'`              — L1 demand AND L2 supply trained from this hotel
 *   - `'warming-up'`          — any backing layer is `algorithm='cold-start-cohort-prior'`
 *                               (cohort benchmark, not learned-from-this-hotel)
 *   - `'capacity-unavailable'` — L1 fitted but < 10 supply predictions for
 *                               this date → optimizer dropped to L1-only path;
 *                               recommendation is from aggregate demand only,
 *                               no per-room model ran
 *
 * Backward-compat: rows written before Phase 1.2 don't carry these keys.
 * Default to `'warming-up'` (fail-honest, not fail-AI).
 */
export type OptimizerModelKind = 'fitted' | 'warming-up' | 'capacity-unavailable';

export interface OptimizerInputsSnapshot {
  l1_is_cold_start?: unknown;
  l2_any_cold_start?: unknown;
  used_l2_supply?: unknown;
  l2_prediction_count?: unknown;
  l1_algorithm?: unknown;
  l2_algorithms?: unknown;
  both_layers_cold_start?: unknown;
}

export function parseInputsSnapshot(raw: unknown): OptimizerInputsSnapshot {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as OptimizerInputsSnapshot;
  }
  // Some Supabase writers stringify JSONB; tolerate both shapes.
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function deriveModelKind(snap: OptimizerInputsSnapshot): {
  modelKind: OptimizerModelKind;
  warmupReason: string | null;
} {
  // Treat missing keys as warming-up (fail-honest). Old rows from before
  // Phase 1.2 will hit this branch and the UI will downgrade to "Industry
  // estimate · learning" — better than mislabeling them "AI recommendation".
  const hasKeys =
    snap.l1_is_cold_start !== undefined ||
    snap.l2_any_cold_start !== undefined ||
    snap.used_l2_supply !== undefined;
  if (!hasKeys) {
    return { modelKind: 'warming-up', warmupReason: 'pre-phase-1.2 row (kind metadata absent)' };
  }

  const l1Cold = snap.l1_is_cold_start === true;
  const l2Cold = snap.l2_any_cold_start === true;
  const usedL2 = snap.used_l2_supply === true;
  const l2Count = typeof snap.l2_prediction_count === 'number' ? snap.l2_prediction_count : 0;

  if (!usedL2) {
    return {
      modelKind: 'capacity-unavailable',
      warmupReason: `L1 ${l1Cold ? 'cold-start' : 'fitted'}; L2 capacity model unavailable (${l2Count} supply predictions)`,
    };
  }
  if (l1Cold || l2Cold) {
    const l1Note = l1Cold ? 'cold-start' : 'fitted';
    const l2Note = l2Cold ? 'cold-start' : 'fitted';
    return { modelKind: 'warming-up', warmupReason: `L1 ${l1Note}; L2 ${l2Note}` };
  }
  return { modelKind: 'fitted', warmupReason: null };
}
