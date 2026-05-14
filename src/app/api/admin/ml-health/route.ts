/**
 * GET /api/admin/ml-health?propertyId=<uuid>
 *
 * Per-property ML health snapshot used by /admin/properties/[id]'s
 * ML Health panel. Answers: "why doesn't hotel X have predictions?"
 * without psql.
 *
 * Layers covered:
 *   - inventory  → inventory_rate_predictions (latest predicted_at + count today)
 *   - demand     → model_runs (active row) + demand_predictions (latest)
 *   - supply     → model_runs (active row) + supply_predictions (latest)
 *   - optimizer  → model_runs (active row) + optimizer_results (latest)
 *
 * For demand/supply the active row's algorithm tells the operator at a
 * glance whether the property is in cold-start (cohort prior, wide
 * bands) or graduated (full Bayesian / XGBoost). Cold-start rows are
 * marked with the literal string 'cold-start-cohort-prior' written by
 * src/training/_cold_start.py:install_cold_start.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

type Layer = 'inventory_rate' | 'demand' | 'supply' | 'optimizer';

interface ActiveModel {
  id: string;
  algorithm: string;
  modelVersion: string;
  trainedAt: string;
  isColdStart: boolean;
  trainingRowCount: number;
  validationMae: number | null;
  beatsBaselinePct: number | null;
  consecutivePassingRuns: number | null;
}

interface LayerHealth {
  layer: Layer;
  activeModel: ActiveModel | null;
  lastPredictionAt: string | null;
  predictionCountToday: number;
  note: string | null;
}

const today = (): string => new Date().toISOString().slice(0, 10);

async function fetchLayerFromModelRuns(
  propertyId: string,
  layer: Layer,
): Promise<ActiveModel | null> {
  // model_runs has a partial unique index on (property_id, layer) WHERE
  // is_active=true so this returns at most one row.
  // Phase M3.1: read is_cold_start as the canonical flag (was: string match
  // on algorithm). Migration 0123 added the column + backfilled existing rows.
  const { data } = await supabaseAdmin
    .from('model_runs')
    .select('id, algorithm, model_version, trained_at, training_row_count, validation_mae, beats_baseline_pct, consecutive_passing_runs, is_cold_start')
    .eq('property_id', propertyId)
    .eq('layer', layer)
    .eq('is_active', true)
    .maybeSingle();

  if (!data) return null;

  return {
    id: data.id as string,
    algorithm: data.algorithm as string,
    modelVersion: data.model_version as string,
    trainedAt: data.trained_at as string,
    isColdStart: (data.is_cold_start as boolean) === true,
    trainingRowCount: (data.training_row_count as number) ?? 0,
    validationMae: data.validation_mae as number | null,
    beatsBaselinePct: data.beats_baseline_pct as number | null,
    consecutivePassingRuns: data.consecutive_passing_runs as number | null,
  };
}

async function fetchPredictionStats(
  propertyId: string,
  table: string,
  dateColumn: string,
  predictedAtColumn: string,
): Promise<{ lastPredictionAt: string | null; predictionCountToday: number }> {
  // Latest predicted_at across ALL rows for this property — tells us
  // when the inference cron last wrote anything, regardless of which
  // operational date it was predicting for.
  const { data: latest } = await supabaseAdmin
    .from(table)
    .select(predictedAtColumn)
    .eq('property_id', propertyId)
    .order(predictedAtColumn, { ascending: false })
    .limit(1)
    .maybeSingle();

  // Count of rows whose target date is today — tells us "did inference
  // produce a usable prediction for the current operating day?"
  const { count } = await supabaseAdmin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .eq(dateColumn, today());

  return {
    lastPredictionAt: latest ? ((latest as unknown as Record<string, unknown>)[predictedAtColumn] as string) : null,
    predictionCountToday: count ?? 0,
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const idV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = idV.value!;

  const { data: prop } = await supabaseAdmin
    .from('properties')
    .select('brand, region, size_tier')
    .eq('id', pid)
    .maybeSingle();

  if (!prop) return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  // All four layers live in model_runs (migration 0062 broadened the
  // layer check to include 'inventory_rate'). Inventory and demand+supply
  // can each surface a cold-start algorithm — the operator sees that
  // distinction at a glance via the activeModel.isColdStart flag.
  const [inventoryModel, demandModel, supplyModel, optimizerModel] = await Promise.all([
    fetchLayerFromModelRuns(pid, 'inventory_rate'),
    fetchLayerFromModelRuns(pid, 'demand'),
    fetchLayerFromModelRuns(pid, 'supply'),
    fetchLayerFromModelRuns(pid, 'optimizer'),
  ]);

  const [inventoryStats, demandStats, supplyStats, optimizerStats] = await Promise.all([
    fetchPredictionStats(pid, 'inventory_rate_predictions', 'predicted_for_date', 'predicted_at'),
    fetchPredictionStats(pid, 'demand_predictions', 'date', 'predicted_at'),
    fetchPredictionStats(pid, 'supply_predictions', 'date', 'predicted_at'),
    fetchPredictionStats(pid, 'optimizer_results', 'date', 'ran_at'),
  ]);

  const layers: LayerHealth[] = [
    {
      layer: 'inventory_rate',
      activeModel: inventoryModel,
      lastPredictionAt: inventoryStats.lastPredictionAt,
      predictionCountToday: inventoryStats.predictionCountToday,
      note: inventoryStats.lastPredictionAt
        ? null
        : 'No inventory predictions yet — runs after the first inventory count.',
    },
    {
      layer: 'demand',
      activeModel: demandModel,
      lastPredictionAt: demandStats.lastPredictionAt,
      predictionCountToday: demandStats.predictionCountToday,
      note: !demandModel
        ? 'No active model — training cron has not run yet for this property.'
        : null,
    },
    {
      layer: 'supply',
      activeModel: supplyModel,
      lastPredictionAt: supplyStats.lastPredictionAt,
      predictionCountToday: supplyStats.predictionCountToday,
      note: !supplyModel
        ? 'No active model — training cron has not run yet for this property.'
        : null,
    },
    {
      layer: 'optimizer',
      activeModel: optimizerModel,
      lastPredictionAt: optimizerStats.lastPredictionAt,
      predictionCountToday: optimizerStats.predictionCountToday,
      note: !optimizerModel
        ? 'Optimizer cron is currently paused (waits on demand+supply baking ~7 days).'
        : null,
    },
  ];

  return ok({
    cohort: {
      brand: prop.brand as string | null,
      region: prop.region as string | null,
      sizeTier: prop.size_tier as string | null,
    },
    layers,
  }, { requestId });
}
