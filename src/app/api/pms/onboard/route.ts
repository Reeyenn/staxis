/**
 * POST /api/pms/onboard
 *
 * Owner-facing "start the onboarding" trigger called from the wizard
 * (/onboard) and the settings page (/settings/pms) after credentials
 * are saved.
 *
 * Plan v4 behavior (2026-05-24): in v4 the credentials-save RPC
 * (`staxis_upsert_scraper_credentials`, extended in migration 0206)
 * already bootstraps the `property_sessions` row that drives the CUA
 * supervisor. This endpoint is now a thin **shim** kept for backward
 * compatibility with the owner UI:
 *
 *   - Verifies the caller owns the property
 *   - Verifies a property_sessions row exists (i.e. credentials were
 *     saved first)
 *   - Returns `{ jobId: propertyId }` so the UI keeps polling
 *     /api/pms/job-status (which now also reads property_sessions)
 *
 * In v4 there is one session-per-hotel, so jobId == propertyId. The
 * polling UI then watches property_sessions.status flow from
 * 'starting' → 'alive' (= "complete" in the legacy job shape).
 *
 * Pre-v4 this used to insert into `onboarding_jobs` for a worker that
 * polled the queue. That worker was deleted in the v4 cutover; this
 * shim replaces the now-orphaned write path.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  propertyId?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Ownership: caller must own the property.
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('id, owner_id')
    .eq('id', pidV.value!)
    .maybeSingle();
  if (!property) {
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (!property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // The credentials-save RPC should have bootstrapped property_sessions
  // already. Verify it. If not, that's a setup-flow bug — surface it.
  const { data: sessionRow } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id, status')
    .eq('property_id', pidV.value!)
    .maybeSingle();

  if (!sessionRow) {
    log.warn('[pms/onboard] no property_sessions row — credentials not saved yet?', {
      propertyId: pidV.value, requestId,
    });
    return err(
      'No CUA session for this property. Save credentials first, then try again.',
      { requestId, status: 409, code: ApiErrorCode.ValidationFailed },
    );
  }

  // jobId == propertyId in v4 (one session per hotel). UI polls
  // /api/pms/job-status?id=<jobId> to watch the session come alive.
  return ok({ jobId: pidV.value! }, { requestId });
}
