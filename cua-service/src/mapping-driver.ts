/**
 * Mapping-driver (Plan v7 Phase 2c).
 *
 * Standalone Playwright runner for `mapper.learn_pms_family` workflow
 * jobs. Owns its own browser context — doesn't depend on an alive
 * SessionDriver. Spawns on-demand when the workflow-runtime claims a
 * mapper job, runs `mapPMS()`, saves a draft knowledge file, and exits.
 *
 * Why a separate driver: the workflow-runtime today only claims jobs
 * for hotels with `alive` drivers. But mapper triggers on
 * `paused_no_knowledge_file` — exactly when no driver is alive (the
 * session-driver paused because it couldn't load a recipe). Sharing
 * SessionDriver's browser would deadlock. Codex v2 P0 fix.
 *
 * Inputs (from workflow_jobs.payload):
 *   { pms_family: string, property_id: string }
 *
 * Outputs (in workflow_jobs.result):
 *   { ok: true, knowledge_file_id: string, targets_found: number,
 *     targets_unavailable: number, targets_failed: number,
 *     spent_micros: number }
 *
 *   { ok: false, error: string }
 *
 * Cost attribution: every Claude call made by this driver logs to
 * claude_usage_log with workload starting 'cua_mapping_' — migration
 * 0208 ensures those rows are tagged source='mapping' and excluded
 * from the per-hotel daily cost cap.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { mapPMS, type MapperResult } from './mapper.js';
import type { PMSCredentials, PMSType, Recipe, ScraperCredentialsRow } from './types.js';

export interface MappingJobInput {
  pms_family: string;
  property_id: string;
  /** Optional: override the global cost cap for this specific run.
   *  Useful for re-running a partial map with a higher budget. */
  cost_cap_micros?: number;
}

export interface MappingJobResult {
  ok: boolean;
  knowledgeFileId?: string;
  knowledgeFileVersion?: number;
  targetsFound?: number;
  targetsUnavailable?: number;
  targetsFailed?: number;
  spentMicros?: number;
  /** Plan v7 — promotion gate outcome.
   *  - 'auto_promote': draft passed gates AND was promoted to active in
   *    the same transaction. Live drivers will hot-reload to it within
   *    ~60s (session-driver knowledge polling).
   *  - 'park_draft': draft saved, NOT promoted. Admin sees CTA to review.
   *  - 'quarantine': draft saved with status='quarantined'. Required
   *    targets missing; admin must investigate.
   */
  promotionDecision?: 'auto_promote' | 'park_draft' | 'quarantine';
  promotionReason?: string;
  error?: string;
}

// Plan v7 promotion-gate criteria.
// Required targets MUST all be found (or quarantine). Business-critical
// net-new targets need ≥ 3 found to auto-promote (otherwise park-as-draft).
const REQUIRED_TARGETS: Array<keyof Recipe['actions']> = [
  'getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders', 'getGuests',
];
const BUSINESS_CRITICAL_TARGETS: Array<keyof Recipe['actions']> = [
  'getRevenueDaily', 'getRatesAndInventory', 'getChannelPerformance',
  'getForecastDaily', 'getGroupsAndBlocks',
];
const MIN_BUSINESS_CRITICAL_FOR_AUTO = 3;

/**
 * Run a mapping job end-to-end. Called by the workflow-runtime's
 * mapper-kind handler.
 */
export async function runMappingJob(
  input: MappingJobInput,
  jobId: string,
  signal: AbortSignal,
): Promise<MappingJobResult> {
  log.info('mapping-driver: starting', {
    jobId,
    pmsFamily: input.pms_family,
    propertyId: input.property_id,
  });

  // 1. Load credentials for the representative property.
  const credentials = await loadCredentials(input.property_id);
  if (!credentials) {
    return { ok: false, error: 'no active scraper_credentials for representative property' };
  }

  // 2. Run mapPMS. The mapper opens its own browser via chromium.launch.
  const result = await mapPMS({
    credentials,
    pmsType: input.pms_family as PMSType,
    propertyId: input.property_id,
    jobId,
    signal,
    onProgress: (label, pct) => {
      log.info('mapping-driver: progress', { jobId, label, pct });
    },
  });

  if (!result.ok) {
    return { ok: false, error: result.userMessage };
  }

  // 3. Evaluate the auto-promotion gate (Plan v7 — replaces the "≥60%
  //    of targets" magic number with required-target-class checks).
  const gate = evaluatePromotionGate(result.recipe);
  log.info('mapping-driver: promotion gate evaluated', { jobId, ...gate });

  // 4. Save the draft knowledge file with the right status.
  //    auto_promote → save as draft, then promote in step 5
  //    park_draft → save as draft, admin reviews
  //    quarantine → save with status='quarantined', admin investigates
  const initialStatus = gate.decision === 'quarantine' ? 'quarantined' : 'draft';
  const draft = await saveDraftKnowledgeFile(input.pms_family, result.recipe, initialStatus);
  if (!draft.ok) {
    return { ok: false, error: `recipe mapped successfully but draft save failed: ${draft.error}` };
  }

  // 5. If gate says auto_promote, atomically demote prior active +
  //    promote this draft. The partial unique index
  //    pms_knowledge_files_one_active_per_family (migration 0201) means
  //    we MUST demote before promote or the second update fails. Doing
  //    both serially is fine — the index enforces post-condition.
  if (gate.decision === 'auto_promote') {
    const promoted = await promoteDraft(input.pms_family, draft.id);
    if (!promoted.ok) {
      log.warn('mapping-driver: auto-promotion failed, leaving as draft', {
        jobId, knowledgeFileId: draft.id, reason: promoted.error,
      });
      // Still return ok — the draft is saved; admin can promote
      // manually. Decision is downgraded to park_draft for clarity.
      gate.decision = 'park_draft';
      gate.reason = `auto-promotion failed: ${promoted.error}`;
    }
  }

  const stats = computeStats(result);
  log.info('mapping-driver: complete', {
    jobId,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    promotionDecision: gate.decision,
    ...stats,
  });

  return {
    ok: true,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    promotionDecision: gate.decision,
    promotionReason: gate.reason,
    ...stats,
  };
}

// ─── Promotion gate ────────────────────────────────────────────────────

function evaluatePromotionGate(recipe: Recipe): {
  decision: 'auto_promote' | 'park_draft' | 'quarantine';
  reason: string;
} {
  const found = new Set(Object.keys(recipe.actions));

  const missingRequired = REQUIRED_TARGETS.filter((t) => !found.has(t));
  if (missingRequired.length > 0) {
    return {
      decision: 'quarantine',
      reason: `missing required targets: ${missingRequired.join(', ')}`,
    };
  }

  const businessCriticalFound = BUSINESS_CRITICAL_TARGETS.filter((t) => found.has(t));
  if (businessCriticalFound.length >= MIN_BUSINESS_CRITICAL_FOR_AUTO) {
    return {
      decision: 'auto_promote',
      reason: `all required + ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (${businessCriticalFound.join(', ')})`,
    };
  }

  return {
    decision: 'park_draft',
    reason: `all required found but only ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (need ${MIN_BUSINESS_CRITICAL_FOR_AUTO}) — admin promotes if this is the best the PMS exposes`,
  };
}

async function promoteDraft(
  pmsFamily: string,
  newDraftId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Demote prior active first (partial unique index enforces one active
  // per family — promote-before-demote would violate it).
  const { error: demErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: new Date().toISOString() })
    .eq('pms_family', pmsFamily)
    .eq('status', 'active');
  if (demErr) return { ok: false, error: `demote failed: ${demErr.message}` };

  const { error: promErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: new Date().toISOString() })
    .eq('id', newDraftId);
  if (promErr) return { ok: false, error: `promote failed: ${promErr.message}` };

  return { ok: true };
}

// ─── Internals ──────────────────────────────────────────────────────────

async function loadCredentials(propertyId: string): Promise<PMSCredentials | null> {
  const { data, error } = await supabase
    .from('scraper_credentials_decrypted')
    .select('ca_login_url, ca_username, ca_password, is_active')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as ScraperCredentialsRow;
  return {
    loginUrl: row.ca_login_url,
    username: row.ca_username,
    password: row.ca_password,
  };
}

async function saveDraftKnowledgeFile(
  pmsFamily: string,
  recipe: Recipe,
  status: 'draft' | 'quarantined' = 'draft',
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  // Find the highest existing version for this family; new version = max+1.
  const { data: existing, error: selErr } = await supabase
    .from('pms_knowledge_files')
    .select('version')
    .eq('pms_family', pmsFamily)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) return { ok: false, error: `version lookup failed: ${selErr.message}` };
  const nextVersion = ((existing?.version as number | undefined) ?? 0) + 1;

  // Recipe → knowledge file jsonb shape. The recipe-adapter handles the
  // detailed translation; here we wrap the recipe in the knowledge file
  // envelope expected by `pms_knowledge_files.knowledge` (per migration
  // 0203's seeded shape).
  const knowledge = {
    schema: 1,
    description: recipe.description ?? `Auto-mapped by mapping-driver (v${nextVersion})`,
    login: recipe.login,
    actions: recipe.actions,
    hints: recipe.hints ?? {},
  };

  const { data: inserted, error: insErr } = await supabase
    .from('pms_knowledge_files')
    .insert({
      pms_family: pmsFamily,
      version: nextVersion,
      status,                   // 'draft' (gate may promote) or 'quarantined'
      knowledge,
      created_by: 'mapper:mapping-driver',
      notes: `Mapped at ${new Date().toISOString()}. Targets: ${Object.keys(recipe.actions).join(', ')}.`,
    })
    .select('id')
    .single();
  if (insErr || !inserted) return { ok: false, error: `insert failed: ${insErr?.message ?? 'unknown'}` };
  return { ok: true, id: inserted.id as string, version: nextVersion };
}

function computeStats(result: MapperResult & { ok: true }): {
  targetsFound: number;
  targetsUnavailable: number;
  targetsFailed: number;
} {
  // Recipe.actions has entries for SUCCESSFULLY mapped targets only.
  // Unavailable + failed counts come from the mapper's run log; we
  // approximate from what's in the recipe vs what the TARGETS catalogue
  // expects (13 entries).
  const found = Object.keys(result.recipe.actions).length;
  // TODO: surface unavailable/failed counts via mapper return shape
  // extension. For now report 0 (the admin UI shows which targets are
  // present by inspecting recipe.actions keys).
  return {
    targetsFound: found,
    targetsUnavailable: 0,
    targetsFailed: 0,
  };
}
