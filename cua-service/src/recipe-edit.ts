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
import { requiredLearnedFor, contextualColumnsFor, optionalColumnsFor } from './target-contract.js';
import type { KnowledgeFile } from './knowledge-file.js';
import type { Recipe } from './types.js';

/**
 * feature/cua-column-editor — per-COLUMN edits within an existing feed, on top
 * of the original per-FEED `delete_feeds`. All three are non-browser, non-Claude
 * recipe-surgery: load the live active map, mutate the jsonb, re-sign (the app
 * physically can't — RECIPE_SIGNING_KEY is Fly-only), promote under the
 * never-zero-active base guard. Drafts are edited app-side (unsigned) and never
 * reach this handler.
 *   - delete_column     — stop capturing one column (known or custom). Refuses
 *                         a feed's ESSENTIAL/CONTEXTUAL contract columns (the
 *                         data the app depends on) and refuses emptying a feed.
 *   - add_custom_column — capture an EXTRA page column the warehouse has no slot
 *                         for, into the table's `raw` jsonb bucket. The selector
 *                         is authored app-side from the detected header index.
 */
export type RecipeEditJobInput =
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'delete_feeds';
      delete_target_keys: string[];
    }
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'delete_column';
      feed_key: string;
      column_name: string;
    }
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'add_custom_column';
      feed_key: string;
      column_key: string;
      selector: string;
    };

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

/** Load the family's CURRENT active map (authoritative base — never a stale
 *  enqueue-time snapshot). Shared by every edit op. */
async function loadActiveMap(
  pmsFamily: string,
): Promise<{ ok: true; active: ActiveRow } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('id, version, knowledge')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { ok: false, error: `could not load active map: ${error.message}` };
  const active = (data as ActiveRow | null) ?? null;
  if (!active) return { ok: false, error: `no active map for ${pmsFamily} — nothing to edit` };
  return { ok: true, active };
}

/** Reconstruct → re-sign → save-as-draft → promote a mutated action set. The
 *  re-wrap carries the active envelope's login/hints/translations verbatim;
 *  saveDraftKnowledgeFile signs it (RECIPE_SIGNING_KEY is Fly-only, so the app
 *  can't). promoteEditedDraft is base-guarded + never-zero-active: if the active
 *  moved underneath us, the new version stays parked as a draft. Shared by all
 *  ops so re-sign/promote semantics never drift between them. */
async function saveAndPromote(args: {
  pmsFamily: string;
  active: ActiveRow;
  newActions: Record<string, unknown>;
  notes: string;
  successMessage: string;
  resultExtras: Record<string, unknown>;
  jobId: string;
  logLabel: string;
}): Promise<RecipeEditHandlerResult> {
  const { pmsFamily, active, newActions, notes, successMessage, resultExtras, jobId, logLabel } = args;
  const knowledge = active.knowledge;
  const afterGaps = computeFeedGaps(newActions as Recipe['actions']);

  const recipe = {
    schema: 1 as const,
    description: knowledge.description,
    login: knowledge.login,
    actions: newActions,
    hints: knowledge.hints,
    valueTranslations: knowledge.valueTranslations,
    dateFormat: knowledge.dateFormat,
  } as unknown as Recipe;

  const saved = await saveDraftKnowledgeFile(pmsFamily, recipe, 'draft', afterGaps, notes);
  if (!saved.ok) return { ok: false, error: `could not save edited recipe: ${saved.error}` };

  const promote = await promoteEditedDraft({
    pmsFamily, draftId: saved.id, expectedActiveId: active.id,
  });
  const promotionDecision = promote.ok
    ? 'auto_promote'
    : promote.reason === 'base_changed' ? 'park_base_changed' : 'park_draft';
  const promotionReason = promote.ok
    ? successMessage
    : promote.reason === 'base_changed'
      ? 'The live map changed while editing — saved as a draft to review in Manage maps'
      : `Saved v${saved.version} as a draft but could not make it live${promote.detail ? `: ${promote.detail}` : ''}`;

  log.info(`recipe-edit: ${logLabel} complete`, {
    jobId, pmsFamily, newVersion: saved.version, promotionDecision,
  });

  // knowledge_file_id is REQUIRED for the live/[jobId] route's draftMap to
  // resolve this run's map. Keep keys snake_case to match the mapper contract.
  return {
    ok: true,
    result: {
      knowledge_file_id: saved.id,
      knowledge_file_version: saved.version,
      promotion_decision: promotionDecision,
      promotion_reason: promotionReason,
      ...resultExtras,
    },
  };
}

export async function runRecipeEditJob(
  input: RecipeEditJobInput,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  switch (input.edit_op) {
    case 'delete_feeds':      return runDeleteFeeds(input, jobId);
    case 'delete_column':     return runDeleteColumn(input, jobId);
    case 'add_custom_column': return runAddCustomColumn(input, jobId);
    default:                  return { ok: false, error: `unsupported edit_op: ${String((input as { edit_op?: unknown }).edit_op)}` };
  }
}

async function runDeleteFeeds(
  input: Extract<RecipeEditJobInput, { edit_op: 'delete_feeds' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
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

  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  const presentKeys = Object.keys(actions);

  const removable = targetKeys.filter((k) => k in actions);
  if (removable.length === 0) {
    return { ok: false, error: `none of [${targetKeys.join(', ')}] are in the active map for ${input.pms_family}` };
  }

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

  return saveAndPromote({
    pmsFamily: input.pms_family,
    active,
    newActions,
    notes: `coverage-editor: removed ${removable.join(', ')} (from v${active.version})`,
    successMessage: `Removed ${removable.join(', ')} and made the map live`,
    logLabel: 'delete_feeds',
    jobId,
    resultExtras: {
      edit_op: 'delete_feeds',
      deleted_targets: removable,
      requested_targets: targetKeys,
      present_before: presentKeys,
    },
  });
}

/** A feed's contract columns the app depends on — ESSENTIAL (identity, e.g.
 *  guest_name) + CONTEXTUAL (page-context dates derived at poll time). Deleting
 *  one would cripple the feed for every hotel on the family, so it's refused.
 *  Empty for non-core feeds (no contract → every column is freely removable). */
function undeletableColumnsFor(actionKey: string): Set<string> {
  const key = actionKey as keyof Recipe['actions'];
  return new Set<string>([...requiredLearnedFor(key), ...contextualColumnsFor(key)]);
}

/** Deep-clone one action's jsonb (recipes are plain JSON — no functions/dates),
 *  so a column mutation never aliases the loaded active row. */
function cloneAction(action: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(action ?? {})) as Record<string, unknown>;
}

async function runDeleteColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'delete_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const feedKey = typeof input.feed_key === 'string' ? input.feed_key : '';
  const columnName = typeof input.column_name === 'string' ? input.column_name : '';
  if (!feedKey || !columnName) {
    return { ok: false, error: 'feed_key and column_name are required' };
  }

  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  if (!(feedKey in actions)) {
    return { ok: false, error: `"${feedKey}" isn't a feed in the active map for ${input.pms_family}` };
  }

  const action = cloneAction(actions[feedKey]);
  const parse = (action.parse ?? {}) as Record<string, unknown>;
  const hint = (parse.hint ?? {}) as Record<string, unknown>;
  const columns = (hint.columns ?? {}) as Record<string, unknown>;
  const customColumns = (hint.customColumns ?? {}) as Record<string, unknown>;
  const inlineFields = (parse.fields ?? {}) as Record<string, unknown>;     // inline_text feeds
  const tiered = (hint.columnsTiered ?? {}) as Record<string, unknown>;

  const inKnown = columnName in columns;
  const inCustom = columnName in customColumns;
  const inInline = columnName in inlineFields;
  if (!inKnown && !inCustom && !inInline) {
    return { ok: false, error: `"${columnName}" isn't a column on "${feedKey}".` };
  }

  // A custom column is never a contract column — always removable. A typed
  // (known/inline) column gets the essential/contextual guard.
  if (!inCustom && undeletableColumnsFor(feedKey).has(columnName)) {
    return {
      ok: false,
      error: `"${columnName}" is a core column this feed depends on and can't be removed.`,
    };
  }

  if (inKnown) { delete columns[columnName]; delete tiered[columnName]; }
  if (inCustom) delete customColumns[columnName];
  if (inInline) delete inlineFields[columnName];

  // Never strip a feed down to zero columns (its data would become empty rows).
  const remaining = Object.keys(columns).length + Object.keys(customColumns).length + Object.keys(inlineFields).length;
  if (remaining === 0) {
    return { ok: false, error: 'refusing to remove the only column left on this feed — remove the whole feed instead.' };
  }

  // Re-attach the mutated sub-objects (omit empty maps to keep the shape clean).
  if (Object.keys(columns).length > 0 || 'columns' in hint) hint.columns = columns;
  if (Object.keys(customColumns).length > 0) hint.customColumns = customColumns;
  else delete hint.customColumns;
  if (Object.keys(tiered).length > 0) hint.columnsTiered = tiered;
  else delete hint.columnsTiered;
  if ('hint' in parse) parse.hint = hint;
  if (Object.keys(inlineFields).length > 0 || 'fields' in parse) parse.fields = inlineFields;
  action.parse = parse;

  const newActions: Record<string, unknown> = { ...actions, [feedKey]: action };

  return saveAndPromote({
    pmsFamily: input.pms_family,
    active,
    newActions,
    notes: `coverage-editor: removed column ${feedKey}.${columnName} (from v${active.version})`,
    successMessage: `Removed the "${columnName}" column and made the map live`,
    logLabel: 'delete_column',
    jobId,
    resultExtras: {
      edit_op: 'delete_column',
      feed_key: feedKey,
      column_name: columnName,
      was_custom: inCustom,
    },
  });
}

const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/;
const RESERVED_CUSTOM_KEYS = new Set<string>([
  'raw', 'id', 'property_id', 'captured_at', 'changed_at', 'created_at', 'updated_at',
]);

/** The full typed contract column set for a feed (essential ∪ contextual ∪
 *  optional). A custom column must never reuse one of these — they're captured
 *  into their typed slot automatically; a same-named custom column would route
 *  to `raw` and shadow it. Empty for non-core feeds (no contract). */
function contractColumnsFor(actionKey: string): Set<string> {
  const key = actionKey as keyof Recipe['actions'];
  return new Set<string>([...requiredLearnedFor(key), ...contextualColumnsFor(key), ...optionalColumnsFor(key)]);
}

async function runAddCustomColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'add_custom_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const feedKey = typeof input.feed_key === 'string' ? input.feed_key : '';
  const columnKey = typeof input.column_key === 'string' ? input.column_key.trim() : '';
  const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
  if (!feedKey || !columnKey || !selector) {
    return { ok: false, error: 'feed_key, column_key and selector are required' };
  }
  if (!CUSTOM_KEY_RE.test(columnKey)) {
    return { ok: false, error: `"${columnKey}" isn't a valid column name (use letters, numbers and underscores).` };
  }
  if (RESERVED_CUSTOM_KEYS.has(columnKey)) {
    return { ok: false, error: `"${columnKey}" is a reserved name — pick another.` };
  }
  if (contractColumnsFor(feedKey).has(columnKey)) {
    return { ok: false, error: `"${columnKey}" is a standard field the robot already captures — no need to add it.` };
  }

  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  if (!(feedKey in actions)) {
    return { ok: false, error: `"${feedKey}" isn't a feed in the active map for ${input.pms_family}` };
  }

  const action = cloneAction(actions[feedKey]);
  const parse = (action.parse ?? {}) as Record<string, unknown>;
  if (parse.mode !== 'table') {
    return { ok: false, error: 'Custom columns can only be added to a page-table feed.' };
  }
  const hint = (parse.hint ?? {}) as Record<string, unknown>;
  const columns = (hint.columns ?? {}) as Record<string, unknown>;
  const customColumns = (hint.customColumns ?? {}) as Record<string, unknown>;

  // A custom column can never shadow a typed warehouse column or duplicate an
  // existing custom one (the app route checks this too; the worker is authoritative).
  if (columnKey in columns) {
    return { ok: false, error: `"${columnKey}" is already a captured column on this feed.` };
  }
  if (columnKey in customColumns) {
    return { ok: false, error: `"${columnKey}" is already a custom column on this feed.` };
  }

  customColumns[columnKey] = selector;
  hint.customColumns = customColumns;
  parse.hint = hint;
  action.parse = parse;
  const newActions: Record<string, unknown> = { ...actions, [feedKey]: action };

  return saveAndPromote({
    pmsFamily: input.pms_family,
    active,
    newActions,
    notes: `coverage-editor: added custom column ${feedKey}.${columnKey} (from v${active.version})`,
    successMessage: `Added the "${columnKey}" column and made the map live`,
    logLabel: 'add_custom_column',
    jobId,
    resultExtras: {
      edit_op: 'add_custom_column',
      feed_key: feedKey,
      column_key: columnKey,
    },
  });
}
