/**
 * recipe-edit — feature/cua-coverage-editor.
 *
 * The worker handler for the `mapper.edit_recipe` job kind: a NON-browser,
 * non-Claude recipe edit. v1 supports one op, `delete_feeds` — removing one or
 * more feeds from a PMS family's active recipe.
 *
 * WHY this must run on the worker (not a Next /api route): a recipe change has
 * to be re-signed (HMAC over the `knowledge` envelope), and RECIPE_SIGNING_KEY
 * is a Fly-only secret. The Next app physically can't produce a valid signature
 * — an app-written recipe would be REFUSED at load under enforce mode. So the
 * delete-feed route enqueues this job; the worker loads the LIVE active map,
 * drops the feed, re-signs a new draft version (reusing the mapper's exact
 * saveDraftKnowledgeFile path), and promotes it under the never-zero-active,
 * base-guarded primitive (promoteEditedDraft).
 *
 * SAFETY:
 *  - loads the CURRENT active at run time (never trusts a stale enqueue-time
 *    snapshot) and demotes only THAT exact row when promoting → no stale-base
 *    overwrite of a concurrent recipe change;
 *  - refuses to drop a feed that would introduce a NEW required-feed gap
 *    (the 4 core feeds the app depends on), or empty the recipe entirely;
 *  - never strands the family at zero active (promoteEditedDraft rolls back).
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { saveDraftKnowledgeFile, computeFeedGaps } from './mapping-driver.js';
import { promoteEditedDraft } from './knowledge-file.js';
import type { KnowledgeFile } from './knowledge-file.js';
import type { Recipe } from './types.js';

export interface RecipeEditJobInput {
  pms_family: string;
  property_id: string;
  edit_op: 'delete_feeds';
  delete_target_keys: string[];
}

export type RecipeEditHandlerResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

interface ActiveRow {
  id: string;
  version: number;
  knowledge: KnowledgeFile;
}

/**
 * The 4 REQUIRED feeds the app depends on — mirror of mapping-driver's
 * REQUIRED_TARGETS / src/lib/pms/feed-status.ts. Deleting any of these is
 * refused UNCONDITIONALLY here (the app route refuses it too, but the worker is
 * the authoritative guard): a required feed that's already gap-listed would
 * sneak past a "newly-missing" diff, so we reject by name, not by gap delta.
 */
const REQUIRED_KEYS = new Set<string>([
  'getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders',
]);

export async function runRecipeEditJob(
  input: RecipeEditJobInput,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  if (input.edit_op !== 'delete_feeds') {
    return { ok: false, error: `unsupported edit_op: ${String(input.edit_op)}` };
  }
  // Normalize to a unique list of non-empty string keys (the payload is jsonb —
  // duplicates / non-strings must not flow into the delete/log/result paths).
  const targetKeys = [
    ...new Set(
      (Array.isArray(input.delete_target_keys) ? input.delete_target_keys : [])
        .filter((k): k is string => typeof k === 'string' && k.length > 0),
    ),
  ];
  if (targetKeys.length === 0) {
    return { ok: false, error: 'delete_target_keys is empty — nothing to delete' };
  }
  // Unconditional required-feed guard (defense-in-depth vs the app route).
  const requiredHit = targetKeys.filter((k) => REQUIRED_KEYS.has(k));
  if (requiredHit.length > 0) {
    return { ok: false, error: `refusing to delete core feed(s): ${requiredHit.join(', ')} — re-point with Edit instead` };
  }

  // 1. Load the CURRENT active map (authoritative base — ignore any stale
  //    enqueue-time version).
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('id, version, knowledge')
    .eq('pms_family', input.pms_family)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    return { ok: false, error: `could not load active map: ${error.message}` };
  }
  const active = (data as ActiveRow | null) ?? null;
  if (!active) {
    return { ok: false, error: `no active map for ${input.pms_family} — nothing to edit` };
  }

  const knowledge = active.knowledge;
  const actions = (knowledge?.actions ?? {}) as Record<string, unknown>;
  const presentKeys = Object.keys(actions);

  // 2. Determine which requested keys are actually present.
  const removable = targetKeys.filter((k) => k in actions);
  if (removable.length === 0) {
    return { ok: false, error: `none of [${targetKeys.join(', ')}] are in the active map for ${input.pms_family}` };
  }

  // 3. Build the post-delete action set + guards.
  const newActions: Record<string, unknown> = { ...actions };
  for (const k of removable) delete newActions[k];

  if (Object.keys(newActions).length === 0) {
    return { ok: false, error: 'refusing to delete the last feed — the recipe would be empty' };
  }

  // Required-feed guard: deleting a feed must not introduce a NEW missing-
  // required gap vs the current active (the app depends on the 4 core feeds).
  const beforeRequired = new Set(
    computeFeedGaps(actions as Recipe['actions']).missingRequired.map((g) => g.target),
  );
  const afterGaps = computeFeedGaps(newActions as Recipe['actions']);
  const newlyMissingRequired = afterGaps.missingRequired
    .map((g) => g.target)
    .filter((t) => !beforeRequired.has(t));
  if (newlyMissingRequired.length > 0) {
    return {
      ok: false,
      error: `refusing to delete required feed(s): ${newlyMissingRequired.join(', ')} — they are core feeds the app depends on. Re-point them with Edit instead.`,
    };
  }

  // 4. Re-sign + save a new draft version. The reconstructed recipe carries the
  //    active envelope's login/hints/translations verbatim; saveDraftKnowledgeFile
  //    re-wraps + signs it (KnowledgeFile↔Recipe types are intentionally loose —
  //    knowledge-file.ts:90-92 — so the boundary cast is runtime-correct).
  const recipe = {
    schema: 1 as const,
    description: knowledge.description,
    login: knowledge.login,
    actions: newActions,
    hints: knowledge.hints,
    valueTranslations: knowledge.valueTranslations,
    dateFormat: knowledge.dateFormat,
  } as unknown as Recipe;

  const saved = await saveDraftKnowledgeFile(
    input.pms_family,
    recipe,
    'draft',
    afterGaps,
    `coverage-editor: removed ${removable.join(', ')} (from v${active.version})`,
  );
  if (!saved.ok) {
    return { ok: false, error: `could not save edited recipe: ${saved.error}` };
  }

  // 5. Promote the new draft under the never-zero-active, base-guarded primitive.
  //    If the active moved underneath us, the draft stays parked for review.
  const promote = await promoteEditedDraft({
    pmsFamily: input.pms_family,
    draftId: saved.id,
    expectedActiveId: active.id,
  });

  const promotionDecision = promote.ok
    ? 'auto_promote'
    : promote.reason === 'base_changed'
      ? 'park_base_changed'
      : 'park_draft';
  const promotionReason = promote.ok
    ? `Removed ${removable.join(', ')} and made v${saved.version} live`
    : promote.reason === 'base_changed'
      ? 'The live map changed while removing the feed — saved as a draft to review in Manage maps'
      : `Saved v${saved.version} as a draft but could not make it live${promote.detail ? `: ${promote.detail}` : ''}`;

  log.info('recipe-edit: delete_feeds complete', {
    jobId, pmsFamily: input.pms_family, removed: removable,
    newVersion: saved.version, promotionDecision,
  });

  return {
    ok: true,
    // knowledge_file_id is REQUIRED for the live/[jobId] route's draftMap to
    // resolve this run's map (strict knowledge_file_id resolution, no family
    // fallback). Keep aggregate keys snake_case to match the mapper contract.
    result: {
      knowledge_file_id: saved.id,
      knowledge_file_version: saved.version,
      edit_op: 'delete_feeds',
      deleted_targets: removable,
      requested_targets: targetKeys,
      present_before: presentKeys,
      promotion_decision: promotionDecision,
      promotion_reason: promotionReason,
    },
  };
}
