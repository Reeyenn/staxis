/**
 * Knowledge file load / save / version.
 *
 * Plan v4 architecture decision #11 (and pms_knowledge_files migration
 * 0201): per-PMS-family knowledge ("here's where data lives in this
 * PMS") is stored versioned in Supabase, shared across all hotels on
 * that PMS family. Mapper writes new versions as drafts; explicit
 * promotion to 'active' makes one canonical for the family.
 *
 * This module is the typed access layer. The CUA worker calls
 * loadActive(pmsFamily) on session boot and after every status change.
 * The mapper (future, Phase 2+) calls saveDraft + promote.
 *
 * Knowledge schema (jsonb in pms_knowledge_files.knowledge):
 *   {
 *     "schema": 1,
 *     "login": { startUrl, steps[], successSelectors[], timeoutMs? },
 *     "feeds": {
 *        "arrivals_departures": FeedSpec,
 *        "room_status":         FeedSpec,
 *        "dashboard_counts":    FeedSpec,
 *        "housekeeping":        FeedSpec,
 *        "work_orders":         FeedSpec
 *     },
 *     "hints": { dismissDialogs[], pollingP95Ms? }
 *   }
 *
 * FeedSpec describes how to extract one feed: URL to navigate to,
 * extraction mode (csv-download / dom-table / fetch-api), selectors,
 * column mappings, parsing notes.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { env } from './env.js';
import { verifyRecipe, isRecipeSigningConfigured } from './recipe-signing.js';
import type { Recipe, LearnedValueTranslations, LearnedDateFormat } from './types.js';

// ─── Knowledge file schema ────────────────────────────────────────────────

export type ExtractionMode = 'csv_download' | 'dom_table' | 'fetch_api' | 'dom_inline';

/**
 * Per-feed specification. The CUA worker reads this to drive Playwright.
 * Fields are intentionally loose — different PMSes use different mechanics.
 */
export interface FeedSpec {
  /** Human-readable description (for ops debugging). */
  description?: string;
  /** Page URL where this feed lives. Relative or absolute. */
  url?: string;
  /** Extraction mode. Determines which extractor runs. */
  mode: ExtractionMode;
  /**
   * Selectors used during extraction. Free-form shape — each mode reads
   * the keys it cares about. For mode='dom_table': rowSelector +
   * columns. For mode='fetch_api': endpoint + body. For mode='csv_download':
   * triggerSelector + csvCheckbox + downloadButton.
   */
  selectors?: Record<string, string>;
  /** Column mapping from extracted text/cell to canonical field name. */
  columns?: Record<string, string>;
  /** Cadence override (ms) — defaults to the global polling cadence. */
  cadenceMs?: number;
  /** Whether to skip during night hours. */
  skipOutsideHours?: { startHour: number; endHour: number; timezone: string };
  /** Anything else the extractor needs; treat as opaque. */
  extra?: Record<string, unknown>;
}

export interface LoginSpec {
  startUrl: string;
  steps: Array<Record<string, unknown>>;
  successSelectors: string[];
  timeoutMs?: number;
  /** Selectors to click to dismiss "remember this device" / "trust this browser" prompts BEFORE submitting MFA. */
  trustDeviceSelectors?: string[];
}

export interface KnowledgeFile {
  schema: 1;
  description?: string;
  login: LoginSpec;
  /**
   * Mapper output (Plan v7 sole shape post-2026-05-24). One ActionRecipe
   * per target table. session-driver iterates this via recipe-adapter →
   * TableTemplate → generic-table-writer. The legacy `feeds.{name}` shape
   * was retired when the hand-coded CA normalizers were deleted.
   *
   * Typed loosely (Record<string, unknown>) at this layer because the
   * source of truth for the Recipe.actions shape lives in
   * cua-service/src/types.ts and we don't want a circular dep.
   */
  actions?: Record<string, unknown>;
  hints?: {
    dismissDialogs?: string[];
    pollingP95Ms?: number;
    /** Anti-bot defense: max requests per minute we'll send. */
    maxRequestsPerMinute?: number;
  };
  /**
   * feat/pms-universal-translate — self-learned VALUE translation, saved per
   * PMS family alongside the WHERE-data-lives selectors and reused by every
   * hotel on that family:
   *   - valueTranslations: `${table}.${col}` → { rawValue → canonical } for
   *     enum columns whose vocabulary is PMS-specific (status/priority words).
   *   - dateFormat: the learned date ORDER so "6/10" is never guessed.
   * Both optional — a pre-existing recipe (the seeded Choice Advantage file)
   * loads fine without them and falls back to the ca_* parsers / heuristic.
   * Included in the signed `knowledge` envelope (mapping-driver), so signature
   * verification stays consistent.
   */
  valueTranslations?: LearnedValueTranslations;
  dateFormat?: LearnedDateFormat;
  /**
   * feat/cua-partial-promotion — which feeds this recipe is MISSING or has
   * structurally dead (required columns blank → writes 0 rows). Written by
   * mapping-driver's saveDraftKnowledgeFile on every draft whose gap set is
   * non-empty, regardless of gate decision — so an admin manually promoting a
   * parked draft still yields a gap-annotated active row. Absent = no gaps
   * (clean recipe) or a legacy file from before this feature.
   *
   * THE app-side honesty layer reads this verbatim (src/lib/pms/feed-status.ts
   * in the Next app — keep the shape in sync, per the CLAUDE.md type-sync
   * pitfall). A gap-listed target must classify as 'learning' even when its
   * key is present in `actions` (incomplete_columns feeds are present AND
   * dead). Lives inside the signed envelope; the app NEVER writes it.
   */
  feedGaps?: FeedGaps;
}

/** One untrustworthy required feed. `not_found` = key absent from actions;
 *  `incomplete_columns` = key present but required descriptor columns are
 *  blank/missing, so the writer rejects every row (operationally dead). */
export interface FeedGapEntry {
  target: string;
  reason: 'not_found' | 'incomplete_columns';
  missingColumns?: string[];
}

export interface FeedGaps {
  /** ISO timestamp of gate evaluation. Excluded from progress comparisons. */
  computedAt: string;
  missingRequired: FeedGapEntry[];
  missingBusinessCritical: string[];
}

export type KnowledgeFileStatus = 'draft' | 'active' | 'deprecated' | 'quarantined';

export interface LoadedKnowledgeFile {
  id: string;
  pmsFamily: string;
  version: number;
  status: KnowledgeFileStatus;
  knowledge: KnowledgeFile;
  learnedAt: Date;
  createdBy: string;
  /** Plan v8 P1-7 — HMAC signature columns from pms_knowledge_files.
   *  Verified before each polling cycle to catch tampered rows.
   *  NULL when the row pre-dates signing or signing was bypassed. */
  signature: Buffer | null;
  signedWithKeyId: string | null;
}

// ─── Load ────────────────────────────────────────────────────────────────

/**
 * Load the currently-active knowledge file for a PMS family. Returns
 * null when no active version exists (new PMS family that hasn't been
 * mapped yet, or the only mapping was quarantined).
 */
export async function loadActive(pmsFamily: string): Promise<LoadedKnowledgeFile | null> {
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, knowledge, learned_at, created_by, signature, signed_with_key_id')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    log.error('knowledge-file: load failed', { pmsFamily, err: error });
    return null;
  }
  if (!data) return null;
  const loaded = unwrap(data as Record<string, unknown>);
  if (!loaded) return null;

  // Plan v8 P1-7 + Codex final review A2 hardening — verify the recipe
  // signature before handing the knowledge file to a polling driver.
  // Without this, a tampered row would replay malicious selectors on
  // every poll.
  //
  // Three failure shapes:
  //   1. Signing IS configured but the row is unsigned (no signature col).
  //      In FY25, this can only happen if mapper signing threw + saved
  //      unsigned (only allowed in warn mode — see mapping-driver.ts).
  //      Refuse the load unconditionally — even in warn mode — because
  //      a configured environment seeing an unsigned active row is a
  //      red flag that needs operator attention. Falling through silently
  //      defeats the purpose of having signing on at all. (Codex A2 fix:
  //      previous version only refused in 'enforce' mode, leaving warn
  //      mode operationally identical to "no signing".)
  //   2. Signing configured + signature present + verification fails:
  //      enforce refuses; warn logs + proceeds (per the env contract).
  //   3. Signing NOT configured + signature present from a prior config:
  //      verifyRecipe returns 'no_key_configured'; treat as failure and
  //      apply the same enforce/warn split.
  if (isRecipeSigningConfigured() || loaded.signature) {
    const verify = verifyRecipe(
      loaded.knowledge as unknown as Recipe,
      loaded.signature,
      loaded.signedWithKeyId,
    );
    if (!verify.ok) {
      const detail = {
        pmsFamily,
        knowledgeFileId: loaded.id,
        version: loaded.version,
        reason: verify.reason,
        signedWithKeyId: loaded.signedWithKeyId,
      };
      // Special case for #1 above — unsigned row with signing configured
      // is a deployment hazard regardless of mode. Always refuse.
      if (isRecipeSigningConfigured() && verify.reason === 'no_signature') {
        log.error('knowledge-file: unsigned active row with signing configured — refusing load (deployment hazard)', detail);
        return null;
      }
      if (env.RECIPE_SIGNING_ENFORCE === 'enforce') {
        log.error('knowledge-file: signature verification FAILED — refusing load (enforce mode)', detail);
        return null;
      }
      log.warn('knowledge-file: signature verification failed (warn mode — proceeding)', detail);
    }
  }
  return loaded;
}

/**
 * Load a specific version (regardless of status). Used by the admin UI
 * to inspect / roll back to a previous version.
 */
export async function loadByVersion(
  pmsFamily: string,
  version: number,
): Promise<LoadedKnowledgeFile | null> {
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, knowledge, learned_at, created_by, signature, signed_with_key_id')
    .eq('pms_family', pmsFamily)
    .eq('version', version)
    .maybeSingle();

  if (error || !data) return null;
  return unwrap(data as Record<string, unknown>);
}

/**
 * Load all versions for a PMS family (newest first). Used by admin UI.
 */
export async function listVersions(pmsFamily: string): Promise<LoadedKnowledgeFile[]> {
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status, knowledge, learned_at, created_by, signature, signed_with_key_id')
    .eq('pms_family', pmsFamily)
    .order('version', { ascending: false });

  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>)
    .map(unwrap)
    .filter((x): x is LoadedKnowledgeFile => x !== null);
}

// ─── Save ────────────────────────────────────────────────────────────────

/**
 * Save a new draft knowledge file. Auto-increments version (max existing
 * + 1). Returns the new id. Throws on validation failure or write error.
 *
 * Drafts do not affect runtime — only 'active' versions are loaded by
 * the session-driver. Promote with promoteToActive() once verified.
 */
export async function saveDraft(args: {
  pmsFamily: string;
  knowledge: KnowledgeFile;
  createdBy: string;
  notes?: string;
}): Promise<{ id: string; version: number }> {
  validate(args.knowledge);

  // Find current max version for atomic +1.
  const { data: existing } = await supabase
    .from('pms_knowledge_files')
    .select('version')
    .eq('pms_family', args.pmsFamily)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (existing?.version as number | undefined ?? 0) + 1;

  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .insert({
      pms_family: args.pmsFamily,
      version: nextVersion,
      status: 'draft',
      knowledge: args.knowledge,
      created_by: args.createdBy,
      notes: args.notes ?? null,
    })
    .select('id, version')
    .single();

  if (error || !data) {
    throw new Error(`knowledge-file: saveDraft failed: ${error?.message ?? 'no data'}`);
  }

  log.info('knowledge-file: draft saved', {
    pmsFamily: args.pmsFamily,
    version: nextVersion,
    createdBy: args.createdBy,
  });

  return { id: data.id as string, version: data.version as number };
}

/**
 * Promote a draft (or deprecated/quarantined version) to active.
 * Demotes the existing active version to 'deprecated' first so the
 * partial unique index (pms_knowledge_files_one_active_per_family) is
 * satisfied at all times.
 *
 * NOT atomic across the two updates — there's a millisecond window where
 * no version is active. Acceptable because session-drivers cache the
 * active version on boot, so a transient gap doesn't affect them.
 */
export async function promoteToActive(args: {
  pmsFamily: string;
  version: number;
  promotedBy: string;
}): Promise<void> {
  // Demote current active (if any).
  const { error: demoteErr } = await supabase
    .from('pms_knowledge_files')
    .update({
      status: 'deprecated',
      deprecated_at: new Date().toISOString(),
    })
    .eq('pms_family', args.pmsFamily)
    .eq('status', 'active');

  if (demoteErr) {
    throw new Error(`knowledge-file: failed to demote current active: ${demoteErr.message}`);
  }

  // Promote target.
  const { error: promoteErr } = await supabase
    .from('pms_knowledge_files')
    .update({
      status: 'active',
      promoted_to_active_at: new Date().toISOString(),
    })
    .eq('pms_family', args.pmsFamily)
    .eq('version', args.version)
    .in('status', ['draft', 'deprecated']);

  if (promoteErr) {
    throw new Error(`knowledge-file: failed to promote v${args.version}: ${promoteErr.message}`);
  }

  log.info('knowledge-file: promoted to active', {
    pmsFamily: args.pmsFamily,
    version: args.version,
    promotedBy: args.promotedBy,
  });
}

/**
 * Mark a version as quarantined. Used when a self-heal repair produces
 * a known-bad knowledge file and we want to ensure it's not loaded.
 * Promotes the previous good version back to active (if asked).
 */
export async function quarantine(args: {
  pmsFamily: string;
  version: number;
  reason: string;
  promotePreviousActive?: boolean;
}): Promise<void> {
  const { error } = await supabase
    .from('pms_knowledge_files')
    .update({
      status: 'quarantined',
      notes: `QUARANTINED: ${args.reason}`,
    })
    .eq('pms_family', args.pmsFamily)
    .eq('version', args.version);

  if (error) {
    throw new Error(`knowledge-file: quarantine failed: ${error.message}`);
  }

  log.warn('knowledge-file: quarantined', {
    pmsFamily: args.pmsFamily,
    version: args.version,
    reason: args.reason,
  });

  if (args.promotePreviousActive) {
    const { data } = await supabase
      .from('pms_knowledge_files')
      .select('version')
      .eq('pms_family', args.pmsFamily)
      .eq('status', 'deprecated')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      await promoteToActive({
        pmsFamily: args.pmsFamily,
        version: data.version as number,
        promotedBy: 'quarantine-rollback',
      });
    } else {
      log.warn('knowledge-file: no previous version to promote after quarantine', {
        pmsFamily: args.pmsFamily,
      });
    }
  }
}

/**
 * feature/cua-coverage-editor — NEVER-ZERO-ACTIVE, BASE-GUARDED promote of a
 * freshly-saved edit draft (used by the delete-feed worker job).
 *
 * Mirrors the app-side promoteMap (src/lib/pms/promote-map.ts) rollback
 * semantics, but runs INSIDE the worker so the whole "load active → build draft
 * → promote" sequence is one continuous execution with no UI round-trip — which
 * closes the stale-base race the two-hop design had (Codex review E-P0): we
 * demote ONLY the exact active row the draft was derived from (`expectedActiveId`
 * + status='active'). If the family's active moved underneath us (a concurrent
 * promote / backfill), the demote matches 0 rows and we ABORT without ever
 * stranding the family at zero — the new draft simply stays a draft for the
 * founder to review in Manage maps.
 *
 * Why not reuse promote-map.ts: that module imports the Next app's
 * supabase-admin client and can't run on the worker; the never-zero invariant
 * is identical, the client differs.
 */
export async function promoteEditedDraft(args: {
  pmsFamily: string;
  /** The new draft to make live. */
  draftId: string;
  /** The active row this draft was derived from — demote ONLY this row. */
  expectedActiveId: string;
}): Promise<{ ok: true } | { ok: false; reason: 'base_changed' | 'promote_failed'; detail?: string }> {
  const nowIso = new Date().toISOString();

  // 1. Demote the EXACT active the draft was built from. Guarding on
  //    id=expectedActiveId (not just status='active') is the race-safety: if
  //    the family's active changed, this matches 0 rows and we abort.
  const { data: demoted, error: demoteErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: nowIso })
    .eq('id', args.expectedActiveId)
    .eq('pms_family', args.pmsFamily)
    .eq('status', 'active')
    .select('id, promoted_to_active_at')
    .maybeSingle();
  if (demoteErr) {
    return { ok: false, reason: 'promote_failed', detail: `demote failed: ${demoteErr.message}` };
  }
  if (!demoted) {
    // Active moved (or already gone) — do NOT activate a stale draft over a
    // newer recipe. Leave the draft parked for manual review.
    log.warn('knowledge-file: promoteEditedDraft aborted — active base changed', {
      pmsFamily: args.pmsFamily, expectedActiveId: args.expectedActiveId, draftId: args.draftId,
    });
    return { ok: false, reason: 'base_changed' };
  }

  // 2. Activate the new draft.
  const { data: promoted, error: promoteErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: nowIso })
    .eq('id', args.draftId)
    .in('status', ['draft', 'deprecated', 'quarantined'])
    .select('id')
    .maybeSingle();

  if (promoteErr || !promoted) {
    // 3. Roll the demoted base back to active so the family is never stranded.
    const { error: rollbackErr } = await supabase
      .from('pms_knowledge_files')
      .update({
        status: 'active',
        promoted_to_active_at: (demoted.promoted_to_active_at as string | null) ?? nowIso,
        deprecated_at: null,
      })
      .eq('id', args.expectedActiveId);
    if (rollbackErr) {
      log.error('knowledge-file: promoteEditedDraft promote AND rollback failed — family has NO live map', {
        pmsFamily: args.pmsFamily, draftId: args.draftId,
        promoteErr: promoteErr?.message ?? 'no row matched', rollbackErr: rollbackErr.message,
      });
    } else {
      log.warn('knowledge-file: promoteEditedDraft promote failed — restored previous active', {
        pmsFamily: args.pmsFamily, draftId: args.draftId,
        reason: promoteErr?.message ?? 'draft no longer promotable',
      });
    }
    return { ok: false, reason: 'promote_failed', detail: promoteErr?.message ?? 'draft no longer promotable' };
  }

  log.info('knowledge-file: promoteEditedDraft activated edit draft', {
    pmsFamily: args.pmsFamily, draftId: args.draftId, demotedBase: args.expectedActiveId,
  });
  return { ok: true };
}

// ─── Internals ────────────────────────────────────────────────────────────

function unwrap(row: Record<string, unknown>): LoadedKnowledgeFile | null {
  const knowledge = row.knowledge as KnowledgeFile | null;
  if (!knowledge || typeof knowledge !== 'object' || knowledge.schema !== 1) {
    log.error('knowledge-file: row failed shape validation', {
      id: row.id as string,
      pmsFamily: row.pms_family as string,
    });
    return null;
  }
  return {
    id: row.id as string,
    pmsFamily: row.pms_family as string,
    version: row.version as number,
    status: row.status as KnowledgeFileStatus,
    knowledge,
    learnedAt: new Date(row.learned_at as string),
    createdBy: row.created_by as string,
    signature: decodeBytea(row.signature),
    signedWithKeyId: typeof row.signed_with_key_id === 'string' ? row.signed_with_key_id : null,
  };
}

/**
 * Plan v8 P1-7 hardening — PostgREST serializes bytea as either a
 * `\xHEX` string (default) or base64 (if Content-Type negotiation pushes
 * it). Buffer-ify both. Returns null when the column was NULL (legacy
 * row pre-dating signing, or signing bypass under warn mode).
 */
export function decodeBytea(raw: unknown): Buffer | null {
  if (raw == null) return null;
  if (raw instanceof Buffer) return raw;  // defensive, future-proof
  if (typeof raw !== 'string') return null;
  if (raw.startsWith('\\x')) {
    // hex form: '\xDEADBEEF…'
    try { return Buffer.from(raw.slice(2), 'hex'); } catch { return null; }
  }
  // assume base64
  try { return Buffer.from(raw, 'base64'); } catch { return null; }
}

/**
 * Validate the shape of a knowledge file before saving. Catches the
 * obvious "Claude returned garbage" case. Doesn't validate selector
 * syntax (Playwright will throw at runtime).
 */
function validate(k: KnowledgeFile): void {
  if (!k || typeof k !== 'object') {
    throw new Error('knowledge-file: not an object');
  }
  if (k.schema !== 1) {
    throw new Error(`knowledge-file: unsupported schema ${k.schema}`);
  }
  if (!k.login || typeof k.login !== 'object') {
    throw new Error('knowledge-file: missing login');
  }
  if (typeof k.login.startUrl !== 'string' || !k.login.startUrl.startsWith('http')) {
    throw new Error('knowledge-file: login.startUrl must be a http(s) URL');
  }
  if (!Array.isArray(k.login.steps)) {
    throw new Error('knowledge-file: login.steps must be an array');
  }
  if (!Array.isArray(k.login.successSelectors) || k.login.successSelectors.length === 0) {
    throw new Error('knowledge-file: login.successSelectors must be non-empty array');
  }
  // Plan v7 — knowledge files now use Recipe.actions shape (one per
  // target table). Detailed validation lives in the recipe-adapter when
  // it translates to TableTemplate; here we just check the envelope.
  if (!k.actions || typeof k.actions !== 'object' || Object.keys(k.actions).length === 0) {
    throw new Error('knowledge-file: missing actions (mapper output expected)');
  }
}
