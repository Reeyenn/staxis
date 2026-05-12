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
  // 2026-05-12 (Codex audit): two concurrent CUA mapping runs for the same
  // pms_type both saw version N and tried to insert N+1, causing the
  // pms_recipes_pms_type_version_key unique constraint (migration 0033) to
  // reject one and lose its work. Retry-with-fresh-lookup on the
  // unique-violation code (Postgres 23505) handles bounded contention
  // without needing a sequence migration.
  //
  // Follow-up note: a proper atomic RPC (staxis_insert_draft_recipe with
  // pg_advisory_xact_lock) is queued — needs a Supabase migration applied
  // by the operator. Until then this retry loop is the safety net.
  const MAX_ATTEMPTS = 5;
  let lastErr: { message?: string } | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: latest } = await supabaseAdmin
      .from('pms_recipes')
      .select('version')
      .eq('pms_type', args.pmsType)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = ((latest?.version as number) ?? 0) + 1;

    const { data, error } = await supabaseAdmin
      .from('pms_recipes')
      .insert({
        pms_type: args.pmsType,
        version: nextVersion,
        recipe: args.recipe,
        status: 'draft',
        learned_by_property_id: args.learnedByPropertyId,
        notes: args.notes ?? null,
      })
      .select('id, version')
      .single();

    if (!error && data) {
      return { id: data.id as string, version: data.version as number };
    }
    // 23505 = unique_violation. Anything else: don't retry.
    if (error && (error as { code?: string }).code !== '23505') {
      return { error: error.message ?? 'failed to save draft recipe' };
    }
    lastErr = error;
  }
  return { error: `failed to save draft recipe after ${MAX_ATTEMPTS} version collisions: ${lastErr?.message ?? 'unknown'}` };
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
