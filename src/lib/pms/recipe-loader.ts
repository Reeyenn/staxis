/**
 * Recipe loader — server-only helpers for reading/writing pms_recipes.
 *
 * Used by:
 *   - The CUA worker (cua-service/) to fetch the recipe to replay, or to
 *     persist a freshly-learned recipe.
 *   - Next.js API routes that need to know "do we already have a recipe
 *     for this PMS type?" before queueing an onboarding job.
 *
 * Never imported into client components — uses supabase-admin which has
 * the service-role key.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { Recipe } from './recipe';
import { isRecipeShape } from './recipe';
import type { PMSType } from './types';

export interface StoredRecipe {
  id: string;
  pmsType: PMSType;
  version: number;
  recipe: Recipe;
  status: 'draft' | 'active' | 'deprecated';
  learnedByPropertyId: string | null;
  notes: string | null;
}

/**
 * Returns the highest-version active recipe for a PMS type, or null if
 * none exists (caller should kick off a CUA mapping run).
 */
export async function loadActiveRecipe(pmsType: PMSType): Promise<StoredRecipe | null> {
  const { data, error } = await supabaseAdmin
    .from('pms_recipes')
    .select('id, pms_type, version, recipe, status, learned_by_property_id, notes')
    .eq('pms_type', pmsType)
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  if (!isRecipeShape(data.recipe)) return null;

  return {
    id: data.id as string,
    pmsType: data.pms_type as PMSType,
    version: data.version as number,
    recipe: data.recipe as Recipe,
    status: data.status as 'draft' | 'active' | 'deprecated',
    learnedByPropertyId: (data.learned_by_property_id as string) ?? null,
    notes: (data.notes as string) ?? null,
  };
}

/**
 * Inserts a new recipe row in 'draft' status. The CUA worker calls this
 * after a successful mapping run. Promotion to 'active' happens after the
 * first successful end-to-end pull (handled by the worker, not here).
 */
export async function saveDraftRecipe(args: {
  pmsType: PMSType;
  recipe: Recipe;
  learnedByPropertyId: string;
  notes?: string;
}): Promise<{ id: string; version: number } | { error: string }> {
  // 2026-05-12 (Codex audit follow-up): atomic RPC replaces the previous
  // SELECT max(version) → JS-increment → INSERT pattern. The RPC holds
  // pg_advisory_xact_lock keyed on the pms_type and does the version
  // compute + insert in one transaction — no more 23505 retries. See
  // migration 0078_atomic_recipe_version.sql.
  const { data, error } = await supabaseAdmin.rpc('staxis_insert_draft_recipe', {
    p_pms_type: args.pmsType,
    p_recipe: args.recipe as unknown as Record<string, unknown>,
    p_learned_by_property_id: args.learnedByPropertyId,
    p_notes: args.notes ?? null,
  });
  if (error) return { error: error.message ?? 'failed to save draft recipe' };

  // The RPC returns a single-row table with (id, version). Supabase's
  // .rpc() resolves that to an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    return { error: 'staxis_insert_draft_recipe returned no row' };
  }
  const r = row as { id?: string; version?: number };
  if (!r.id || typeof r.version !== 'number') {
    return { error: 'staxis_insert_draft_recipe row missing id/version' };
  }
  return { id: r.id, version: r.version };
}

/**
 * Promote a draft to active. Called by the worker after the first
 * end-to-end pull using this recipe succeeds. Demotes any older active
 * recipes for the same PMS to 'deprecated' in the same transaction.
 */
export async function promoteRecipeToActive(recipeId: string): Promise<{ ok: true } | { error: string }> {
  const { data: row, error: fetchErr } = await supabaseAdmin
    .from('pms_recipes')
    .select('id, pms_type, status')
    .eq('id', recipeId)
    .maybeSingle();

  if (fetchErr || !row) return { error: fetchErr?.message ?? 'recipe not found' };
  if (row.status === 'active') return { ok: true };
  if (row.status === 'deprecated') return { error: 'cannot promote deprecated recipe' };

  // 2026-05-12 (Codex audit fix): previously did demote + promote as two
  // separate updates. If the demote succeeded but the promote failed,
  // the PMS would end up with ZERO active recipes — every subsequent
  // loadActiveRecipe() returns null and that PMS silently stops
  // onboarding new properties until manual repair. Use the atomic
  // RPC (migration 0039_atomic_recipe_swap_and_job_claim.sql) which
  // does both ops in a single plpgsql transaction; if the promote
  // fails the demote rolls back.
  const { error: rpcErr } = await supabaseAdmin.rpc('staxis_swap_active_recipe', {
    p_new_recipe_id: recipeId,
    p_pms_type: row.pms_type,
  });
  if (rpcErr) return { error: rpcErr.message };

  return { ok: true };
}
