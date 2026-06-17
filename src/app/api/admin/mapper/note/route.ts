/**
 * POST /api/admin/mapper/note  { jobId, note }
 *
 * feature/cua-operator-notes — the founder leaves the RUNNING mapper a nudge
 * ("try the Reports menu", "wrong page, go back"). Inserts into mapping_notes
 * (service-role, 0285); the cua-service worker drains unconsumed notes for the
 * job at the top of each agent step and folds them into the model's next turn,
 * so the robot reads it within seconds. Job-scoped; delivered exactly once.
 *
 * Auth: requireAdmin (admin-only page, admin-only action).
 */
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const MAX_NOTE = 500;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  let body: { jobId?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: 'bad_request' });
  }
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!UUID.test(jobId)) {
    return err('jobId (uuid) is required', { requestId, status: 400, code: 'bad_request' });
  }
  if (!note) {
    return err('note is required', { requestId, status: 400, code: 'bad_request' });
  }

  // Context only: which hotel this job maps (notes are scoped by job_id).
  // Best-effort — a missing/failed lookup must not block leaving a note.
  let propertyId: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('workflow_jobs')
      .select('property_id')
      .eq('id', jobId)
      .maybeSingle();
    if (data && typeof data.property_id === 'string') propertyId = data.property_id;
  } catch {
    propertyId = null;
  }

  const { error } = await supabaseAdmin.from('mapping_notes').insert({
    job_id: jobId,
    ...(propertyId ? { property_id: propertyId } : {}),
    note: note.slice(0, MAX_NOTE),
  });
  if (error) {
    return err(`could not save the note: ${error.message}`, {
      requestId, status: 500, code: 'internal_error',
    });
  }

  return ok({ saved: true }, { requestId });
}
