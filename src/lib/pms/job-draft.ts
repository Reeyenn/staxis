/**
 * resolveDraftForJob — map a mapper workflow_job to the pms_knowledge_files
 * draft it produced, for the Learning Board's Save & Finish / Discard.
 *
 * Resolves STRICTLY via workflow_jobs.result.knowledge_file_id (written by
 * mappingJobResultToWorkflowResult whenever a draft was saved). No
 * newest-by-family fallback — that could promote/delete a DIFFERENT run's draft
 * for the same PMS family. If the run never stamped an id, it produced no map,
 * so there is nothing to save/discard. Server-only (supabaseAdmin).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export interface DraftRow {
  id: string;
  version: number;
  status: string;
  pms_family: string;
}

export type ResolveDraftResult =
  | {
      ok: true;
      row: DraftRow;
      /**
       * The property this mapper run learned against (workflow_jobs.property_id),
       * or null if the job never recorded one. Save & Finish passes it to
       * promoteMap's per-feed gate so a partial map saved from the Learning Board
       * only lights up feeds that produced a preview for this property.
       */
      propertyId: string | null;
    }
  | { ok: false; status: number; message: string };

export async function resolveDraftForJob(jobId: string): Promise<ResolveDraftResult> {
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, result, payload, property_id')
    .eq('id', jobId)
    .maybeSingle();
  if (jobErr) return { ok: false, status: 500, message: `job lookup failed: ${jobErr.message}` };
  if (!job) return { ok: false, status: 404, message: 'job not found' };

  const result = (job.result ?? {}) as Record<string, unknown>;
  const knowledgeFileId = typeof result.knowledge_file_id === 'string' ? result.knowledge_file_id : null;
  if (!knowledgeFileId) {
    return { ok: false, status: 400, message: "Nothing to save — this run didn't produce a map yet." };
  }

  const { data } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, status, pms_family')
    .eq('id', knowledgeFileId)
    .maybeSingle();
  const row = (data as DraftRow | null) ?? null;
  if (!row) return { ok: false, status: 404, message: 'The map this run produced no longer exists.' };

  const propertyId = typeof (job as { property_id?: unknown }).property_id === 'string'
    ? (job as { property_id: string }).property_id
    : null;
  return { ok: true, row, propertyId };
}
