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
 *
 * ── ACTIVE-map ops vs DRAFT-targeted ops (feature/cua-parked-draft-editor) ──
 *
 * The ops below come in two families that share the SAME per-op mutation +
 * validation logic (the `mutate*` helpers) but differ in WHERE they write:
 *
 *   - ACTIVE ops (`delete_feeds` / `delete_column` / `add_custom_column` /
 *     `set_column`): load the family's LIVE active map, mutate, re-sign as a
 *     NEW draft version, and PROMOTE it (base-guarded, never-zero-active).
 *     These are the original live-map edits — behavior byte-identical.
 *
 *   - DRAFT ops (`draft_delete_feeds` / `draft_delete_column` /
 *     `draft_add_custom_column` / `draft_set_column`): load ONE specific PARKED
 *     draft row by id, apply the SAME mutation, re-sign, and UPDATE THAT ROW IN
 *     PLACE — no new version, no promote, no status change. The draft keeps its
 *     id so the admin UI's draftId stays valid across successive edits.
 *
 *     WHY the draft ops exist: parked drafts are signed at learn time. Editing
 *     their `knowledge` jsonb from the Next app (the old coverage-editor path)
 *     mutated the envelope WITHOUT re-signing, so under enforce mode the row's
 *     signature no longer matched — loadActive REFUSED it. Re-signing has to
 *     happen on the worker (RECIPE_SIGNING_KEY is Fly-only), so the app now
 *     enqueues these ops instead of writing jsonb directly. A row that is
 *     signed-but-stale, or even NULL-signature, is STILL editable here: the op
 *     re-signs, which is the healing path for any already-broken draft.
 *
 *   DELIBERATE CONTRACT DESIGN — these are NEW op names, not a `draft_id`
 *   parameter bolted onto the existing active ops. An OLD deployed worker that
 *   receives, say, `draft_delete_feeds` hits the switch's default and fails
 *   CLOSED with "unsupported edit_op" — it can NEVER silently interpret a
 *   draft-targeted edit as an edit to the LIVE active map. A shared `draft_id`
 *   param on the existing ops would have made an old worker do exactly that.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { saveDraftKnowledgeFile, computeFeedGaps } from './mapping-driver.js';
import { promoteEditedDraft } from './knowledge-file.js';
import { signRecipe, isRecipeSigningConfigured } from './recipe-signing.js';
import { env } from './env.js';
import { requiredLearnedFor, contextualColumnsFor, optionalColumnsFor } from './target-contract.js';
import type { KnowledgeFile } from './knowledge-file.js';
import type { Recipe } from './types.js';

/**
 * The Supabase client the DRAFT-targeted ops read/write through. Defaults to the
 * service-role singleton (production). Kept as an injectable module-level seam
 * ONLY so the draft ops (loadDraftRow + the in-place re-sign UPDATE) can be
 * unit-tested against a fake client without a live DB — the ACTIVE ops still go
 * through mapping-driver / knowledge-file's own singleton, unchanged. Never call
 * __setDbForTests outside tests.
 */
let db: SupabaseClient = supabase;
/** Test-only: swap the draft-op DB client. Returns a restore fn. */
export function __setDbForTests(fake: SupabaseClient): () => void {
  const prev = db;
  db = fake;
  return () => { db = prev; };
}

/**
 * feature/cua-column-editor — per-COLUMN edits within an existing feed, on top
 * of the original per-FEED `delete_feeds`. All three are non-browser, non-Claude
 * recipe-surgery: load the live active map, mutate the jsonb, re-sign (the app
 * physically can't — RECIPE_SIGNING_KEY is Fly-only), promote under the
 * never-zero-active base guard.
 *
 * feature/cua-parked-draft-editor — the `draft_*` twins of each op target ONE
 * parked draft row by id and UPDATE it in place (re-signed), instead of
 * promoting a new active version. Same mutation logic, different write target.
 *   - delete_feeds      — remove whole feeds from the recipe.
 *   - delete_column     — stop capturing one column (known or custom). Refuses
 *                         a feed's ESSENTIAL/CONTEXTUAL contract columns (the
 *                         data the app depends on) and refuses emptying a feed.
 *   - add_custom_column — capture an EXTRA page column the warehouse has no slot
 *                         for, into the table's `raw` jsonb bucket. The selector
 *                         is authored app-side from the detected header index.
 *   - set_column        — re-point an existing column (core/contract OR custom)
 *                         at a different page column.
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
      /** fix/cua-freeform-capture — 'page' = a one-off value (read once, stamped
       *  on every row); 'row' (default) = a per-row column cell. */
      scope?: 'row' | 'page';
    }
  | {
      // fix/cua-repoint-column — RE-POINT an existing column (core/contract OR
      // custom) at a different page column. Unlike add_custom_column this ALLOWS
      // a contract column name (it IS that column) and REPLACES its selector.
      pms_family: string;
      property_id: string;
      edit_op: 'set_column';
      feed_key: string;
      column_name: string;
      selector: string;
    }
  // ── DRAFT-targeted twins (feature/cua-parked-draft-editor) ────────────────
  // Each mirrors the active op above but carries `draft_id` and edits THAT one
  // parked draft row in place (re-signed, no promote). property_id is carried
  // for parity/audit but NOT used to locate the row — a draft is family-scoped.
  //
  // NEW op names on purpose (see file header): an old worker fails closed on
  // these rather than misinterpreting them as active-map edits.
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'draft_delete_feeds';
      draft_id: string;
      feed_keys: string[];
    }
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'draft_delete_column';
      draft_id: string;
      feed_key: string;
      column_name: string;
    }
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'draft_add_custom_column';
      draft_id: string;
      feed_key: string;
      column_key: string;
      selector: string;
      scope?: 'row' | 'page';
    }
  | {
      pms_family: string;
      property_id: string;
      edit_op: 'draft_set_column';
      draft_id: string;
      feed_key: string;
      column_name: string;
      selector: string;
      /** Whether the target is a founder-added custom column (routes to
       *  customColumns) vs a core/known/inline column. Carried explicitly so
       *  the mutation matches the app's intent; the mutation also self-detects
       *  which bucket the column currently lives in, so this is advisory. */
      is_custom: boolean;
    };

export type RecipeEditHandlerResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

interface ActiveRow {
  id: string;
  version: number;
  knowledge: KnowledgeFile;
}

/** A parked draft row loaded for a `draft_*` op. Same shape as ActiveRow plus
 *  the columns the in-place re-sign UPDATE preserves/appends. */
interface DraftRow {
  id: string;
  version: number;
  knowledge: KnowledgeFile;
  notes: string | null;
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
 *  enqueue-time snapshot). Shared by every ACTIVE edit op. */
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

/**
 * Load ONE specific parked draft by id, scoped to the payload's family. Shared
 * by every DRAFT edit op. Fails CLOSED (error result) when the row is missing,
 * not a draft, soft-deleted, or belongs to a DIFFERENT family than the payload
 * claims — so a mis-routed or stale job can never mutate the wrong recipe. We do
 * NOT use loadActiveMap here: a draft is exactly the row we must NOT confuse
 * with the live active map.
 */
async function loadDraftRow(
  pmsFamily: string,
  draftId: string,
): Promise<{ ok: true; draft: DraftRow } | { ok: false; error: string }> {
  if (typeof draftId !== 'string' || draftId.length === 0) {
    return { ok: false, error: 'draft_id is required' };
  }
  const { data, error } = await db
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, knowledge, notes, deleted_at')
    .eq('id', draftId)
    .maybeSingle();
  if (error) return { ok: false, error: `could not load draft: ${error.message}` };
  const row = (data as Record<string, unknown> | null) ?? null;
  if (!row) return { ok: false, error: `no draft with id ${draftId}` };
  // Fail-closed guards. Each is a distinct reason so a mis-routed job surfaces a
  // clear error instead of silently editing something it shouldn't.
  if (row.deleted_at != null) {
    return { ok: false, error: `draft ${draftId} has been deleted — cannot edit` };
  }
  if (row.status !== 'draft') {
    return { ok: false, error: `${draftId} is not a draft (status=${String(row.status)}) — draft ops only edit parked drafts` };
  }
  if (row.pms_family !== pmsFamily) {
    return {
      ok: false,
      error: `draft ${draftId} belongs to ${String(row.pms_family)}, not ${pmsFamily} — refusing (family mismatch)`,
    };
  }
  const knowledge = row.knowledge as KnowledgeFile | null;
  if (!knowledge || typeof knowledge !== 'object' || knowledge.schema !== 1) {
    return { ok: false, error: `draft ${draftId} has a malformed knowledge envelope` };
  }
  return {
    ok: true,
    draft: {
      id: row.id as string,
      version: row.version as number,
      knowledge,
      notes: typeof row.notes === 'string' ? row.notes : null,
    },
  };
}

/**
 * The mutation half of one edit op, decoupled from WHERE it's written. Each
 * `mutate*` helper takes the current `actions` map + the (already type-narrowed)
 * payload and returns the new actions plus the bookkeeping strings, OR a
 * fail-closed error. Both the ACTIVE and DRAFT paths call the SAME helper, so
 * guard rails + validation can NEVER drift between them.
 */
interface MutationOutcome {
  newActions: Record<string, unknown>;
  /** Appended to `notes` (draft path) / passed as the draft note (active path). */
  notes: string;
  /** Human-readable success line surfaced to the admin. */
  successMessage: string;
  /** Op-specific fields folded into the result payload. */
  resultExtras: Record<string, unknown>;
}
type MutationResult =
  | { ok: true; mutation: MutationOutcome }
  | { ok: false; error: string };

/** Reconstruct → re-sign → save-as-draft → promote a mutated action set. The
 *  re-wrap carries the active envelope's login/hints/translations verbatim;
 *  saveDraftKnowledgeFile signs it (RECIPE_SIGNING_KEY is Fly-only, so the app
 *  can't). promoteEditedDraft is base-guarded + never-zero-active: if the active
 *  moved underneath us, the new version stays parked as a draft. Shared by all
 *  ACTIVE ops so re-sign/promote semantics never drift between them. */
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

/**
 * Re-sign a mutated DRAFT envelope and UPDATE THE SAME ROW in place — the draft
 * counterpart to saveAndPromote. No new version, no promote, no status change:
 * the row keeps its id (so the admin UI's draftId stays valid) and its version.
 *
 * The re-wrap mirrors saveDraftKnowledgeFile's envelope EXACTLY so signed===
 * stored at load: schema/description/login/actions/hints, the two optional
 * learned-translation keys (only when present), and the freshly-recomputed
 * feedGaps (only when non-empty). `verification` (if the draft carried one from
 * learn time) is preserved verbatim — an edit doesn't re-verify, but dropping
 * the field would change the signed shape.
 *
 * Signing is REQUIRED for a draft op: the whole point is to re-sign so the row
 * loads under enforce mode. If signing isn't configured (dev), we UPDATE with a
 * NULL signature — matching saveDraftKnowledgeFile's "no key → save unsigned"
 * behavior, so a dev worker still functions and a signing-configured prod worker
 * always produces a valid signature.
 */
async function resignAndUpdateDraft(args: {
  pmsFamily: string;
  draft: DraftRow;
  newActions: Record<string, unknown>;
  notes: string;
  successMessage: string;
  resultExtras: Record<string, unknown>;
  jobId: string;
  logLabel: string;
}): Promise<RecipeEditHandlerResult> {
  const { pmsFamily, draft, newActions, notes, successMessage, resultExtras, jobId, logLabel } = args;
  const k = draft.knowledge;
  const afterGaps = computeFeedGaps(newActions as Recipe['actions']);

  // Build the exact envelope saveDraftKnowledgeFile would (minus the version-
  // stamped default description — we keep the draft's own description). Optional
  // keys are included ONLY when present/non-empty, so the signed shape matches a
  // freshly-inserted draft's and old field-less rows stay byte-compatible.
  const knowledge: Record<string, unknown> = {
    schema: 1,
    ...(k.description !== undefined ? { description: k.description } : {}),
    login: k.login,
    actions: newActions,
    hints: k.hints ?? {},
    ...(k.valueTranslations ? { valueTranslations: k.valueTranslations } : {}),
    ...(k.dateFormat ? { dateFormat: k.dateFormat } : {}),
    ...(afterGaps.missingRequired.length > 0 || afterGaps.missingBusinessCritical.length > 0
      ? { feedGaps: afterGaps }
      : {}),
    ...(k.verification ? { verification: k.verification } : {}),
  };

  // canonicalJson-stability (mirrors saveDraftKnowledgeFile): sign AND store the
  // JSON-normalized envelope so the signed bytes equal exactly what jsonb
  // persists and reads back.
  const stored = JSON.parse(JSON.stringify(knowledge)) as Record<string, unknown>;

  let signatureBytes: Buffer | null = null;
  let signedWithKeyId: string | null = null;
  let signedAt: string | null = null;
  if (isRecipeSigningConfigured()) {
    try {
      const sig = signRecipe(stored as unknown as Recipe);
      signatureBytes = sig.signature;
      signedWithKeyId = sig.signedWithKeyId;
      signedAt = sig.signedAt;
    } catch (err) {
      // Enforce mode: refuse to leave the row UNSIGNED (that's the exact bug
      // this feature fixes — an unsigned/stale draft that enforce-mode refuses).
      if (env.RECIPE_SIGNING_ENFORCE === 'enforce') {
        const msg = `signRecipe failed under enforce mode — refusing to update draft unsigned: ${(err as Error).message}`;
        log.warn('recipe-edit: ' + msg, { pmsFamily, draftId: draft.id });
        return { ok: false, error: msg };
      }
      log.warn('recipe-edit: signRecipe failed — updating draft unsigned (warn mode)', {
        err: (err as Error).message, pmsFamily, draftId: draft.id,
      });
    }
  } else {
    log.info('recipe-edit: signing key not configured — updating draft unsigned', {
      pmsFamily, draftId: draft.id,
    });
  }

  // Append a short note; keep the draft's existing history.
  const nowIso = new Date().toISOString();
  const appended = `${draft.notes ? draft.notes + '\n' : ''}Edited (${logLabel}) at ${nowIso}: ${notes}`;

  // UPDATE THE SAME ROW: no new version, no promote, no status change. Guard on
  // status='draft' + deleted_at IS NULL so a concurrent promote/delete between
  // our load and here can't have us stomp a now-active or removed row.
  const { data: updated, error: updErr } = await db
    .from('pms_knowledge_files')
    .update({
      knowledge: stored,
      // Same PostgREST bytea HEX-literal encoding as saveDraftKnowledgeFile —
      // passing the raw Buffer would JSON-serialize it into the bytea column.
      signature: signatureBytes ? '\\x' + signatureBytes.toString('hex') : null,
      signed_with_key_id: signedWithKeyId,
      signed_at: signedAt,
      notes: appended,
    })
    .eq('id', draft.id)
    .eq('pms_family', pmsFamily)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .select('id, version')
    .maybeSingle();

  if (updErr) return { ok: false, error: `could not update draft: ${updErr.message}` };
  if (!updated) {
    // The row changed underneath us (promoted / deleted / family moved). Don't
    // retry — surface it so the admin re-opens the (now different) draft.
    return { ok: false, error: `draft ${draft.id} was no longer an editable draft — refresh Manage maps and retry` };
  }

  log.info(`recipe-edit: ${logLabel} (draft) complete`, {
    jobId, pmsFamily, draftId: draft.id, draftVersion: updated.version as number,
  });

  // Mirror the active path's result shape so the web's live/[jobId] poller works
  // unchanged. knowledge_file_id = the DRAFT id (its id is stable across edits).
  return {
    ok: true,
    result: {
      knowledge_file_id: updated.id as string,
      knowledge_file_version: updated.version as number,
      // Draft edits never promote — a distinct decision the poller can surface
      // as "saved to the draft" rather than "made live".
      promotion_decision: 'draft_updated',
      promotion_reason: successMessage,
      ...resultExtras,
    },
  };
}

export async function runRecipeEditJob(
  input: RecipeEditJobInput,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  switch (input.edit_op) {
    // ── ACTIVE-map ops (load active → mutate → new version → promote) ──
    case 'delete_feeds':      return runDeleteFeeds(input, jobId);
    case 'delete_column':     return runDeleteColumn(input, jobId);
    case 'add_custom_column': return runAddCustomColumn(input, jobId);
    case 'set_column':        return runSetColumnSelector(input, jobId);
    // ── DRAFT-targeted ops (load draft → same mutate → re-sign in place) ──
    case 'draft_delete_feeds':      return runDraftDeleteFeeds(input, jobId);
    case 'draft_delete_column':     return runDraftDeleteColumn(input, jobId);
    case 'draft_add_custom_column': return runDraftAddCustomColumn(input, jobId);
    case 'draft_set_column':        return runDraftSetColumn(input, jobId);
    // An OLD worker that never learned the draft_* ops lands here and fails
    // CLOSED, rather than silently reinterpreting a draft edit as a live-map
    // edit (which a shared `draft_id` param on the existing ops would have
    // risked). Fail-closed is the whole reason draft_* are separate names.
    default:                  return { ok: false, error: `unsupported edit_op: ${String((input as { edit_op?: unknown }).edit_op)}` };
  }
}

// ─── delete_feeds mutation (shared by active + draft) ─────────────────────────

/** Pure mutation for delete_feeds / draft_delete_feeds. Removes one or more
 *  feeds; refuses the 4 core feeds, refuses emptying the recipe, and refuses
 *  introducing a NEW missing-required gap. Identical logic for both paths. */
function mutateDeleteFeeds(
  pmsFamily: string,
  currentVersion: number,
  actions: Record<string, unknown>,
  rawKeys: unknown,
): MutationResult {
  // Normalize to a unique list of non-empty string keys (the payload is jsonb —
  // duplicates / non-strings must not flow into the delete/log/result paths).
  const targetKeys = [
    ...new Set(
      (Array.isArray(rawKeys) ? rawKeys : [])
        .filter((k): k is string => typeof k === 'string' && k.length > 0),
    ),
  ];
  if (targetKeys.length === 0) {
    return { ok: false, error: 'no feed keys given — nothing to delete' };
  }
  // Unconditional required-feed guard (defense-in-depth vs the app route).
  const requiredHit = targetKeys.filter((k) => REQUIRED_KEYS.has(k));
  if (requiredHit.length > 0) {
    return { ok: false, error: `refusing to delete core feed(s): ${requiredHit.join(', ')} — re-point with Edit instead` };
  }

  const presentKeys = Object.keys(actions);
  const removable = targetKeys.filter((k) => k in actions);
  if (removable.length === 0) {
    return { ok: false, error: `none of [${targetKeys.join(', ')}] are in the map for ${pmsFamily}` };
  }

  const newActions: Record<string, unknown> = { ...actions };
  for (const k of removable) delete newActions[k];
  if (Object.keys(newActions).length === 0) {
    return { ok: false, error: 'refusing to delete the last feed — the recipe would be empty' };
  }

  // Required-feed guard: deleting a feed must not introduce a NEW missing-
  // required gap vs the current map (the app depends on the 4 core feeds).
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

  return {
    ok: true,
    mutation: {
      newActions,
      notes: `coverage-editor: removed ${removable.join(', ')} (from v${currentVersion})`,
      successMessage: `Removed ${removable.join(', ')} and made the map live`,
      resultExtras: {
        edit_op: 'delete_feeds',
        deleted_targets: removable,
        requested_targets: targetKeys,
        present_before: presentKeys,
      },
    },
  };
}

async function runDeleteFeeds(
  input: Extract<RecipeEditJobInput, { edit_op: 'delete_feeds' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateDeleteFeeds(input.pms_family, active.version, actions, input.delete_target_keys);
  if (!m.ok) return m;
  return saveAndPromote({
    pmsFamily: input.pms_family, active,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: m.mutation.successMessage,
    resultExtras: m.mutation.resultExtras,
    logLabel: 'delete_feeds', jobId,
  });
}

async function runDraftDeleteFeeds(
  input: Extract<RecipeEditJobInput, { edit_op: 'draft_delete_feeds' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadDraftRow(input.pms_family, input.draft_id);
  if (!loaded.ok) return loaded;
  const { draft } = loaded;
  const actions = (draft.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateDeleteFeeds(input.pms_family, draft.version, actions, input.feed_keys);
  if (!m.ok) return m;
  return resignAndUpdateDraft({
    pmsFamily: input.pms_family, draft,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: `Removed the selected feed(s) from the draft`,
    resultExtras: { ...m.mutation.resultExtras, draft_id: draft.id },
    logLabel: 'draft_delete_feeds', jobId,
  });
}

// ─── delete_column mutation (shared by active + draft) ────────────────────────

/** A feed's contract columns the app depends on — ESSENTIAL (identity, e.g.
 *  guest_name) + CONTEXTUAL (page-context dates derived at poll time). Deleting
 *  one would cripple the feed for every hotel on the family, so it's refused.
 *  Empty for non-core feeds (no contract → every column is freely removable). */
function undeletableColumnsFor(actionKey: string): Set<string> {
  const key = actionKey as keyof Recipe['actions'];
  return new Set<string>([...requiredLearnedFor(key), ...contextualColumnsFor(key)]);
}

/** Deep-clone one action's jsonb (recipes are plain JSON — no functions/dates),
 *  so a column mutation never aliases the loaded row. */
function cloneAction(action: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(action ?? {})) as Record<string, unknown>;
}

/** Pure mutation for delete_column / draft_delete_column. Removes one column
 *  (known/custom/inline), refuses a contract column, refuses emptying the feed. */
function mutateDeleteColumn(
  pmsFamily: string,
  currentVersion: number,
  actions: Record<string, unknown>,
  feedKeyRaw: unknown,
  columnNameRaw: unknown,
): MutationResult {
  const feedKey = typeof feedKeyRaw === 'string' ? feedKeyRaw : '';
  const columnName = typeof columnNameRaw === 'string' ? columnNameRaw : '';
  if (!feedKey || !columnName) {
    return { ok: false, error: 'feed_key and column_name are required' };
  }
  if (!(feedKey in actions)) {
    return { ok: false, error: `"${feedKey}" isn't a feed in the map for ${pmsFamily}` };
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

  return {
    ok: true,
    mutation: {
      newActions,
      notes: `coverage-editor: removed column ${feedKey}.${columnName} (from v${currentVersion})`,
      successMessage: `Removed the "${columnName}" column and made the map live`,
      resultExtras: {
        edit_op: 'delete_column',
        feed_key: feedKey,
        column_name: columnName,
        was_custom: inCustom,
      },
    },
  };
}

async function runDeleteColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'delete_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateDeleteColumn(input.pms_family, active.version, actions, input.feed_key, input.column_name);
  if (!m.ok) return m;
  return saveAndPromote({
    pmsFamily: input.pms_family, active,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: m.mutation.successMessage,
    resultExtras: m.mutation.resultExtras,
    logLabel: 'delete_column', jobId,
  });
}

async function runDraftDeleteColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'draft_delete_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadDraftRow(input.pms_family, input.draft_id);
  if (!loaded.ok) return loaded;
  const { draft } = loaded;
  const actions = (draft.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateDeleteColumn(input.pms_family, draft.version, actions, input.feed_key, input.column_name);
  if (!m.ok) return m;
  return resignAndUpdateDraft({
    pmsFamily: input.pms_family, draft,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: `Removed the "${input.column_name}" column from the draft`,
    resultExtras: { ...m.mutation.resultExtras, draft_id: draft.id },
    logLabel: 'draft_delete_column', jobId,
  });
}

// ─── set_column mutation (shared by active + draft) ───────────────────────────

// fix/cua-repoint-column — a re-point selector is a simple positional/id chain
// (the same shapes the app authors from a page-column index or a drag). Bounds
// nth-child(N) to 3 digits so a junk index can't fan out.
const SET_SELECTOR_RE = /^(#[A-Za-z][\w-]*|[a-z]+(:nth-(child|of-type)\(\d{1,3}\))?)(\s*>\s*(#[A-Za-z][\w-]*|[a-z]+(:nth-(child|of-type)\(\d{1,3}\))?))*$/;

/** Pure mutation for set_column / draft_set_column. Re-points an existing column
 *  (contract/known/custom/inline) at a new selector. `isCustomHint` is advisory
 *  (the app's intent); the mutation self-detects the column's current bucket. */
function mutateSetColumn(
  pmsFamily: string,
  currentVersion: number,
  actions: Record<string, unknown>,
  feedKeyRaw: unknown,
  columnNameRaw: unknown,
  selectorRaw: unknown,
): MutationResult {
  const feedKey = typeof feedKeyRaw === 'string' ? feedKeyRaw : '';
  const columnName = typeof columnNameRaw === 'string' ? columnNameRaw : '';
  const selector = typeof selectorRaw === 'string' ? selectorRaw.trim() : '';
  if (!feedKey || !columnName || !selector) {
    return { ok: false, error: 'feed_key, column_name and selector are required' };
  }
  if (!SET_SELECTOR_RE.test(selector)) {
    return { ok: false, error: 'selector must be a simple positional/id chain' };
  }
  if (!(feedKey in actions)) {
    return { ok: false, error: `"${feedKey}" isn't a feed in the map for ${pmsFamily}` };
  }

  const action = cloneAction(actions[feedKey]);
  const parse = (action.parse ?? {}) as Record<string, unknown>;
  const hint = (parse.hint ?? {}) as Record<string, unknown>;
  const columns = (hint.columns ?? {}) as Record<string, unknown>;
  const customColumns = (hint.customColumns ?? {}) as Record<string, unknown>;
  const inlineFields = (parse.fields ?? {}) as Record<string, unknown>;
  const tiered = (hint.columnsTiered ?? {}) as Record<string, unknown>;

  const inCustom = columnName in customColumns;
  const inInline = columnName in inlineFields;
  const inKnown = columnName in columns;
  const isContract = contractColumnsFor(feedKey).has(columnName);
  // Re-point is allowed for a contract column (even if its selector is currently
  // empty/missing — the whole point of fixing a mis-mapped guest_name), an
  // already-known column, a custom column, or an inline_text field.
  if (!inCustom && !inInline && !inKnown && !isContract) {
    return { ok: false, error: `"${columnName}" isn't a column on "${feedKey}".` };
  }

  if (inCustom) {
    customColumns[columnName] = selector;
  } else if (inInline) {
    inlineFields[columnName] = selector;
  } else {
    // Core/known/contract column → set the positional selector AND clear any stale
    // header-anchor: the runtime PREFERS columnsTiered[field] over columns[field]
    // (dom-rows.ts), so a leftover anchor would silently override the founder's pick.
    columns[columnName] = selector;
    delete tiered[columnName];
  }

  if (Object.keys(columns).length > 0 || 'columns' in hint) hint.columns = columns;
  if (Object.keys(customColumns).length > 0) hint.customColumns = customColumns;
  else delete hint.customColumns;
  if (Object.keys(tiered).length > 0) hint.columnsTiered = tiered;
  else delete hint.columnsTiered;
  if ('hint' in parse || Object.keys(hint).length > 0) parse.hint = hint;
  if (Object.keys(inlineFields).length > 0 || 'fields' in parse) parse.fields = inlineFields;
  action.parse = parse;

  // The founder's explicit re-point IS the proof — drop this column from the
  // action's unproven list so the feed doesn't stay badged "parked/unproven"
  // after they fixed it (promote runs no value-cert re-check).
  const unproven = action.unprovenRequiredColumns;
  if (Array.isArray(unproven)) {
    const kept = unproven.filter((u) => u !== columnName);
    if (kept.length > 0) action.unprovenRequiredColumns = kept;
    else delete action.unprovenRequiredColumns;
  }

  const newActions: Record<string, unknown> = { ...actions, [feedKey]: action };

  return {
    ok: true,
    mutation: {
      newActions,
      notes: `coverage-editor: re-pointed column ${feedKey}.${columnName} (from v${currentVersion})`,
      successMessage: `Re-pointed the "${columnName}" column and made the map live`,
      resultExtras: {
        edit_op: 'set_column',
        feed_key: feedKey,
        column_name: columnName,
        selector,
        was_custom: inCustom,
      },
    },
  };
}

async function runSetColumnSelector(
  input: Extract<RecipeEditJobInput, { edit_op: 'set_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateSetColumn(input.pms_family, active.version, actions, input.feed_key, input.column_name, input.selector);
  if (!m.ok) return m;
  return saveAndPromote({
    pmsFamily: input.pms_family, active,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: m.mutation.successMessage,
    resultExtras: m.mutation.resultExtras,
    logLabel: 'set_column', jobId,
  });
}

async function runDraftSetColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'draft_set_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadDraftRow(input.pms_family, input.draft_id);
  if (!loaded.ok) return loaded;
  const { draft } = loaded;
  const actions = (draft.knowledge?.actions ?? {}) as Record<string, unknown>;
  // is_custom is advisory — mutateSetColumn self-detects the column's bucket, so
  // a mislabeled is_custom can never route a re-point to the wrong bucket.
  const m = mutateSetColumn(input.pms_family, draft.version, actions, input.feed_key, input.column_name, input.selector);
  if (!m.ok) return m;
  return resignAndUpdateDraft({
    pmsFamily: input.pms_family, draft,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: `Re-pointed the "${input.column_name}" column on the draft`,
    resultExtras: { ...m.mutation.resultExtras, draft_id: draft.id },
    logLabel: 'draft_set_column', jobId,
  });
}

// ─── add_custom_column mutation (shared by active + draft) ────────────────────

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

/** Pure mutation for add_custom_column / draft_add_custom_column. Adds a
 *  founder-chosen extra page column into `customColumns` (routed to `raw` at
 *  poll time). Table feeds only; refuses reserved/contract/duplicate keys. */
function mutateAddCustomColumn(
  pmsFamily: string,
  currentVersion: number,
  actions: Record<string, unknown>,
  feedKeyRaw: unknown,
  columnKeyRaw: unknown,
  selectorRaw: unknown,
  scope: 'row' | 'page' | undefined,
): MutationResult {
  const feedKey = typeof feedKeyRaw === 'string' ? feedKeyRaw : '';
  const columnKey = typeof columnKeyRaw === 'string' ? columnKeyRaw.trim() : '';
  const selector = typeof selectorRaw === 'string' ? selectorRaw.trim() : '';
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
  if (!(feedKey in actions)) {
    return { ok: false, error: `"${feedKey}" isn't a feed in the map for ${pmsFamily}` };
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

  // fix/cua-freeform-capture — a PAGE-scope value stores the object form
  // { selector, scope:'page' }; a per-row column stays a flat string (byte-
  // identical to the original shape).
  customColumns[columnKey] = scope === 'page' ? { selector, scope: 'page' } : selector;
  hint.customColumns = customColumns;
  parse.hint = hint;
  action.parse = parse;
  const newActions: Record<string, unknown> = { ...actions, [feedKey]: action };

  return {
    ok: true,
    mutation: {
      newActions,
      notes: `coverage-editor: added custom column ${feedKey}.${columnKey} (from v${currentVersion})`,
      successMessage: `Added the "${columnKey}" column and made the map live`,
      resultExtras: {
        edit_op: 'add_custom_column',
        feed_key: feedKey,
        column_key: columnKey,
      },
    },
  };
}

async function runAddCustomColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'add_custom_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadActiveMap(input.pms_family);
  if (!loaded.ok) return loaded;
  const { active } = loaded;
  const actions = (active.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateAddCustomColumn(
    input.pms_family, active.version, actions, input.feed_key, input.column_key, input.selector, input.scope,
  );
  if (!m.ok) return m;
  return saveAndPromote({
    pmsFamily: input.pms_family, active,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: m.mutation.successMessage,
    resultExtras: m.mutation.resultExtras,
    logLabel: 'add_custom_column', jobId,
  });
}

async function runDraftAddCustomColumn(
  input: Extract<RecipeEditJobInput, { edit_op: 'draft_add_custom_column' }>,
  jobId: string,
): Promise<RecipeEditHandlerResult> {
  const loaded = await loadDraftRow(input.pms_family, input.draft_id);
  if (!loaded.ok) return loaded;
  const { draft } = loaded;
  const actions = (draft.knowledge?.actions ?? {}) as Record<string, unknown>;
  const m = mutateAddCustomColumn(
    input.pms_family, draft.version, actions, input.feed_key, input.column_key, input.selector, input.scope,
  );
  if (!m.ok) return m;
  return resignAndUpdateDraft({
    pmsFamily: input.pms_family, draft,
    newActions: m.mutation.newActions,
    notes: m.mutation.notes,
    successMessage: `Added the "${input.column_key}" column to the draft`,
    resultExtras: { ...m.mutation.resultExtras, draft_id: draft.id },
    logLabel: 'draft_add_custom_column', jobId,
  });
}
