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
  feeds: {
    arrivals_departures?: FeedSpec;
    room_status?: FeedSpec;
    dashboard_counts?: FeedSpec;
    housekeeping?: FeedSpec;
    work_orders?: FeedSpec;
    // Other feeds (rates, revenue, etc.) added in Phase 2+.
    [key: string]: FeedSpec | undefined;
  };
  hints?: {
    dismissDialogs?: string[];
    pollingP95Ms?: number;
    /** Anti-bot defense: max requests per minute we'll send. */
    maxRequestsPerMinute?: number;
  };
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
    .select('id, pms_family, version, status, knowledge, learned_at, created_by')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    log.error('knowledge-file: load failed', { pmsFamily, err: error });
    return null;
  }
  if (!data) return null;
  return unwrap(data as Record<string, unknown>);
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
    .select('id, pms_family, version, status, knowledge, learned_at, created_by')
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
    .select('id, pms_family, version, status, knowledge, learned_at, created_by')
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
  };
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
  if (!k.feeds || typeof k.feeds !== 'object') {
    throw new Error('knowledge-file: missing feeds');
  }
  // Per-feed validation: each present feed must have a mode.
  for (const [name, feed] of Object.entries(k.feeds)) {
    if (!feed) continue;
    if (!feed.mode) {
      throw new Error(`knowledge-file: feed ${name} missing mode`);
    }
    if (!['csv_download', 'dom_table', 'fetch_api', 'dom_inline'].includes(feed.mode)) {
      throw new Error(`knowledge-file: feed ${name} has invalid mode ${feed.mode}`);
    }
  }
}
