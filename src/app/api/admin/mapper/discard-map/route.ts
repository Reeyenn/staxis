/**
 * POST /api/admin/mapper/discard-map
 *   body: { jobId }
 *
 * feature/cua-live-assist — the Learning Board's "Discard & Cancel": throw away
 * the map this run learned. Deletes the draft pms_knowledge_files row.
 *
 * Refuses to delete an ACTIVE map (you can't discard the live recipe — retire
 * it from Manage maps instead). The delete is a SINGLE guarded statement
 * (... where id=$ and status<>'active') so a concurrent promote between read
 * and delete can never delete the live map. Deleting a draft correctly
 * un-latches the backfill cron's draft-awaiting-review gate.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { resolveDraftForJob } from '@/lib/pms/job-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: { jobId?: unknown };
  try { body = await req.json(); } catch { return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' }); }
  if (typeof body.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.jobId)) {
    return err('jobId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  const draft = await resolveDraftForJob(body.jobId);
  if (!draft.ok) return err(draft.message, { requestId, status: draft.status, code: 'bad_request' });
  // Only an un-promoted draft (draft/quarantined) is discardable. An active map
  // is live; a deprecated one is a rollback target — both are managed from
  // Manage maps, not thrown away here.
  if (draft.row.status !== 'draft' && draft.row.status !== 'quarantined') {
    return err(`This map is ${draft.row.status === 'active' ? 'live' : draft.row.status} — manage it from Manage maps instead.`, {
      requestId, status: 409, code: 'conflict',
    });
  }

  // Single guarded delete — the status guard is part of the WHERE so a
  // concurrent promote (draft→active) between read and delete can't be deleted.
  const { data: deleted, error: delErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .delete()
    .eq('id', draft.row.id)
    .in('status', ['draft', 'quarantined'])
    .select('id')
    .maybeSingle();
  if (delErr) return err(`could not discard: ${delErr.message}`, { requestId, status: 500, code: 'db_error' });
  if (!deleted) {
    // Became active (just promoted) or already gone.
    return ok({ discarded: false, reason: 'not_discardable' }, { requestId });
  }
  return ok({ discarded: true }, { requestId });
}
