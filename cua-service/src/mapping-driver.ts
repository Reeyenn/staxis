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
  error?: string;
}

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

  // 3. Save the draft knowledge file. Don't auto-promote — that's the
  //    workflow-runtime caller's job (after applying the auto-promotion
  //    gates from plan v7).
  const draft = await saveDraftKnowledgeFile(input.pms_family, result.recipe);
  if (!draft.ok) {
    return { ok: false, error: `recipe mapped successfully but draft save failed: ${draft.error}` };
  }

  const stats = computeStats(result);
  log.info('mapping-driver: complete', {
    jobId,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    ...stats,
  });

  return {
    ok: true,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    ...stats,
  };
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
      status: 'draft',          // NOT 'active' — auto-promotion gates decide
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
