/**
 * POST /api/admin/mapper/save-map
 *   body: { jobId }
 *
 * feature/cua-live-assist — the Learning Board's "Save & Finish": make the map
 * this run learned the family's LIVE (active) recipe in one click, so it shows
 * in the PMS coverage tab and the robot starts polling.
 *
 * Resolves the draft from workflow_jobs.result.knowledge_file_id (fallback: the
 * newest version for the family) and reads it FRESH server-side, then delegates
 * to the shared promoteMap helper (same never-zero-active rollback + session
 * revive as Manage maps). allowQuarantined: true honors "just do what they
 * click" — the board shows the founder exactly what was found beside the
 * button, so activating a sparse map is their informed choice (no nag gate).
 *
 * Auth: requireAdmin. supabaseAdmin (service-role).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { promoteMap } from '@/lib/pms/promote-map';
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
  if (draft.row.status === 'active') {
    return ok({ alreadyLive: true, map: draft.row }, { requestId });
  }

  const result = await promoteMap({
    id: draft.row.id,
    expectedVersion: draft.row.version,
    expectedStatus: draft.row.status,
    allowQuarantined: true,
    promotedBy: admin.email ?? admin.userId,
  });
  if (!result.ok) {
    return err(result.message, { requestId, status: result.status, code: result.code });
  }
  return ok({ saved: true, map: result.map, revivedSessions: result.revivedSessions }, { requestId });
}
