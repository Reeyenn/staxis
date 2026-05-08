/**
 * GET /api/pms/job-status?id=<jobId>
 *
 * Polled by the /settings/pms UI every couple of seconds while an
 * onboarding job is in flight. Returns the job's current status, step
 * label, progress percentage, and (on completion) the result summary.
 *
 * Auth: caller must own the property the job is for.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const idV = validateUuid(url.searchParams.get('id'), 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Note: error_detail is intentionally NOT in the SELECT. The worker
  // writes PMS-specific debug info there (URLs it tried, selectors that
  // failed) which would leak attack surface to a curious authenticated
  // user. Keep it to server-side logs only.
  const { data: job } = await supabaseAdmin
    .from('onboarding_jobs')
    .select(`
      id, property_id, pms_type, status, step, progress_pct,
      result, error, recipe_id, started_at, completed_at, created_at
    `)
    .eq('id', idV.value!)
    .maybeSingle();

  if (!job) {
    return err('Job not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Capability: caller owns the property tied to this job.
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('owner_id')
    .eq('id', job.property_id as string)
    .maybeSingle();

  if (!property || !property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  return ok({
    id: job.id,
    propertyId: job.property_id,
    pmsType: job.pms_type,
    status: job.status,
    step: job.step,
    progressPct: job.progress_pct,
    result: job.result,
    error: job.error,
    recipeId: job.recipe_id,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    createdAt: job.created_at,
  }, { requestId });
}
