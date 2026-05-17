/**
 * GET /api/admin/pms-coverage
 *
 * Returns one row per supported PMS type with the state of its active
 * recipe + how many properties are currently using it. Powers the
 * /admin/pms page — Reeyen's "what does our agent already know how to
 * do" view.
 *
 * Per-PMS fields:
 *   - active recipe id, version, created_at (or null if never mapped)
 *   - mapped action set (which of the 4 actions the recipe covers)
 *   - propertyCount — how many properties currently set to this PMS
 *   - latestJob — the most recent onboarding_job for this pms_type:
 *       status / step / progress / error / age
 *
 * No mutations — read-only. The /api/admin/regenerate-recipe endpoint
 * still owns the mutation path (queueing a fresh mapping job).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { PMS_REGISTRY } from '@/lib/pms/registry';
import type { PMSType } from '@/lib/pms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const TARGET_ACTIONS = ['getRoomStatus', 'getArrivals', 'getDepartures', 'getStaffRoster'] as const;
type TargetAction = (typeof TARGET_ACTIONS)[number];

interface CoverageRow {
  pmsType: PMSType;
  label: string;
  hint: string;
  tier: 1 | 2 | 3;
  runtime: 'railway' | 'fly';
  recipe: {
    id: string;
    version: number;
    createdAt: string;
    actionsCaptured: TargetAction[];
    actionsMissing: TargetAction[];
    coveragePct: number; // 0..100, share of TARGET_ACTIONS captured
  } | null;
  propertyCount: number;
  latestJob: {
    id: string;
    status: string;
    step: string | null;
    progressPct: number | null;
    error: string | null;
    createdAt: string;
  } | null;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  // Pull active recipes (one per pms_type, status='active' is unique by
  // contract — see staxis_swap_active_recipe RPC).
  const { data: activeRecipes, error: recipeErr } = await supabaseAdmin
    .from('pms_recipes')
    .select('id, pms_type, version, created_at, recipe')
    .eq('status', 'active');

  if (recipeErr) {
    return err(`Could not load recipes: ${recipeErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Per-PMS property counts. Properties without a pms_type are skipped.
  // We do an aggregate count by pms_type with a single RPC-less query.
  const { data: properties, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('pms_type');

  if (propErr) {
    return err(`Could not load properties: ${propErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const propertyCountByPms = new Map<string, number>();
  for (const p of properties ?? []) {
    if (!p.pms_type) continue;
    propertyCountByPms.set(p.pms_type, (propertyCountByPms.get(p.pms_type) ?? 0) + 1);
  }

  // Latest onboarding_job per pms_type. Cheap query — we only need 1
  // per type. Fetch the last 100 jobs, then keep the newest per pms.
  const { data: recentJobs, error: jobErr } = await supabaseAdmin
    .from('onboarding_jobs')
    .select('id, pms_type, status, step, progress_pct, error, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (jobErr) {
    return err(`Could not load jobs: ${jobErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const latestJobByPms = new Map<string, NonNullable<typeof recentJobs>[number]>();
  for (const j of recentJobs ?? []) {
    if (!j.pms_type) continue;
    if (!latestJobByPms.has(j.pms_type)) {
      latestJobByPms.set(j.pms_type, j);
    }
  }

  // Build one CoverageRow per registered PMS (skip 'other' — it's a
  // catch-all input value, not a real PMS).
  const pmsTypes = Object.keys(PMS_REGISTRY).filter((t) => t !== 'other') as PMSType[];

  const rows: CoverageRow[] = pmsTypes.map((pmsType) => {
    const def = PMS_REGISTRY[pmsType];
    const recipeRow = (activeRecipes ?? []).find((r) => r.pms_type === pmsType);
    const captured: TargetAction[] = [];
    const missing: TargetAction[] = [];

    if (recipeRow && recipeRow.recipe && typeof recipeRow.recipe === 'object') {
      const actions = (recipeRow.recipe as { actions?: Record<string, unknown> }).actions ?? {};
      for (const a of TARGET_ACTIONS) {
        if (actions[a]) captured.push(a);
        else missing.push(a);
      }
    } else {
      missing.push(...TARGET_ACTIONS);
    }

    const recipe = recipeRow
      ? {
          id: recipeRow.id,
          version: recipeRow.version,
          createdAt: recipeRow.created_at,
          actionsCaptured: captured,
          actionsMissing: missing,
          coveragePct: Math.round((captured.length / TARGET_ACTIONS.length) * 100),
        }
      : null;

    const job = latestJobByPms.get(pmsType);
    const latestJob = job
      ? {
          id: job.id,
          status: job.status,
          step: job.step,
          progressPct: job.progress_pct,
          error: job.error,
          createdAt: job.created_at,
        }
      : null;

    return {
      pmsType,
      label: def.label,
      hint: def.hint,
      tier: def.tier,
      runtime: def.runtime,
      recipe,
      propertyCount: propertyCountByPms.get(pmsType) ?? 0,
      latestJob,
    };
  });

  // Sort: PMSes WITH active recipes first (by coverage desc), then
  // unmapped ones (by property count desc — most-needed first).
  rows.sort((a, b) => {
    const aHas = a.recipe ? 1 : 0;
    const bHas = b.recipe ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    if (a.recipe && b.recipe) return b.recipe.coveragePct - a.recipe.coveragePct;
    return b.propertyCount - a.propertyCount;
  });

  return ok({ pmsTypes: rows }, { requestId });
}
