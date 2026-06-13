/**
 * resolveDraftForJob — map a mapper workflow_job to the pms_knowledge_files
 * draft it produced, for the Learning Board's Save & Finish / Discard.
 *
 * Prefers workflow_jobs.result.knowledge_file_id (written by
 * mappingJobResultToWorkflowResult); falls back to the newest version for the
 * job's pms_family if the run didn't stamp an id. Server-only (supabaseAdmin).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export interface DraftRow {
  id: string;
  version: number;
  status: string;
  pms_family: string;
}

export type ResolveDraftResult =
  | { ok: true; row: DraftRow }
  | { ok: false; status: number; message: string };

export async function resolveDraftForJob(jobId: string): Promise<ResolveDraftResult> {
  const { data: job, error: jobErr } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, result, payload')
    .eq('id', jobId)
    .maybeSingle();
  if (jobErr) return { ok: false, status: 500, message: `job lookup failed: ${jobErr.message}` };
  if (!job) return { ok: false, status: 404, message: 'job not found' };

  const result = (job.result ?? {}) as Record<string, unknown>;
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const knowledgeFileId = typeof result.knowledge_file_id === 'string' ? result.knowledge_file_id : null;
  const family = typeof payload.pms_family === 'string' ? payload.pms_family : null;

  let row: DraftRow | null = null;
  if (knowledgeFileId) {
    const { data } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, version, status, pms_family')
      .eq('id', knowledgeFileId)
      .maybeSingle();
    row = (data as DraftRow | null) ?? null;
  }
  if (!row && family) {
    const { data } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, version, status, pms_family')
      .eq('pms_family', family)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    row = (data as DraftRow | null) ?? null;
  }
  if (!row) return { ok: false, status: 400, message: "Nothing to save — this run didn't produce a map yet." };
  return { ok: true, row };
}
