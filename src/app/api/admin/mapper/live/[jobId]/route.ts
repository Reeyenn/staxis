/**
 * GET /api/admin/mapper/live/[jobId]
 *
 * Plan v8 Phase B chunk 2. Initial-paint state for the Live Mapping
 * console. After fetching this, the front-end subscribes to two
 * Supabase realtime channels for ongoing updates:
 *   - postgres_changes on mapping_help_requests filtered by job_id
 *   - the broadcast channel `mapping:{jobId}` for action/screenshot events
 *
 * Response:
 *   {
 *     job: { id, kind, status, attempts, max_attempts, payload, created_at,
 *            started_at, completed_at, error, result, claude_cost_micros },
 *     pendingHelpRequest: <mapping_help_requests row | null>,
 *     recentHelpRequests: <last 5 mapping_help_requests rows>,
 *   }
 *
 * Auth: requireAdmin.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });
  }
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return err('jobId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  const [jobRes, pendingRes, recentRes] = await Promise.all([
    supabaseAdmin
      .from('workflow_jobs')
      .select('id, property_id, kind, status, attempts, max_attempts, payload, created_at, started_at, completed_at, error, result, claude_cost_micros')
      .eq('id', jobId)
      .maybeSingle(),
    supabaseAdmin
      .from('mapping_help_requests')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'pending')
      .maybeSingle(),
    supabaseAdmin
      .from('mapping_help_requests')
      .select('id, target_key, question, status, action_type, response_text, answered_at, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  if (jobRes.error) {
    return err(`workflow_jobs lookup failed: ${jobRes.error.message}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  if (!jobRes.data) {
    return err('job not found', { requestId, status: 404, code: 'not_found' });
  }

  return ok({
    job: jobRes.data,
    pendingHelpRequest: pendingRes.data ?? null,
    recentHelpRequests: recentRes.data ?? [],
  }, { requestId });
}
