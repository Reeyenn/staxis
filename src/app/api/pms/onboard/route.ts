/**
 * POST /api/pms/onboard
 *
 * Kicks off a full onboarding job for the property. Inserts a row in
 * onboarding_jobs which the Fly.io CUA worker (cua-service/) picks up
 * within POLL_INTERVAL_MS (~5s) and processes end-to-end:
 *   1. Logs into the PMS using credentials in scraper_credentials.
 *   2. If no active recipe exists for this PMS type, runs Claude vision
 *      to learn one and saves as a draft to pms_recipes.
 *   3. Replays the recipe to extract rooms, staff, and history.
 *   4. Persists the data to the property's tables.
 *   5. Promotes the recipe to active (if newly mapped).
 *
 * Body: { propertyId }    (credentials must already be saved via
 *                          /api/pms/save-credentials)
 *
 * Returns: { jobId } — the client polls /api/pms/job-status?id=<jobId>
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body { propertyId?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // ─── Auth ────────────────────────────────────────────────────────────────
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  // ─── Validate ───────────────────────────────────────────────────────────
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // ─── Capability: caller must own this property ──────────────────────────
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('id, owner_id')
    .eq('id', pidV.value!)
    .maybeSingle();

  if (!property) {
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  // Explicit null check — an orphaned property (owner_id=NULL) shouldn't
  // pass ownership. Without this the !== comparison still rejects NULL
  // but the intent is clearer this way.
  if (!property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // ─── Confirm credentials exist ──────────────────────────────────────────
  // Without scraper_credentials the worker has nothing to log into. Make
  // this a clear error rather than letting the worker mark the job
  // 'failed' a few seconds later.
  const { data: creds } = await supabaseAdmin
    .from('scraper_credentials')
    .select('property_id, pms_type, is_active')
    .eq('property_id', pidV.value!)
    .maybeSingle();

  if (!creds || !creds.is_active) {
    return err(
      'No active PMS credentials found for this property. Save your credentials first.',
      { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
    );
  }

  // ─── Rate limit ─────────────────────────────────────────────────────────
  // Cap onboardings at 5/hour per property. Each kicks off a Fly worker
  // run that may spend $1-3 in Claude tokens for a brand-new PMS;
  // throttling protects the daily budget against a runaway script or a
  // confused GM hitting Save in a loop. The throttle below already
  // prevents back-to-back queueing while a job is running, but the
  // hourly cap is the broader budget guardrail.
  const rl = await checkAndIncrementRateLimit('pms-onboard', pidV.value!);
  if (!rl.allowed) {
    return err(
      `Rate limited. ${rl.current}/${rl.cap} onboarding attempts this hour for this property. Try again in ${rl.retryAfterSec}s.`,
      { requestId, status: 429, code: ApiErrorCode.RateLimited,
        headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  // ─── Throttle: don't queue a second job while one is already running ────
  // Otherwise a double-click on Save would fire two CUA mappings for the
  // same property — wasteful and possibly causing race conditions in
  // saveExtractedData.
  const { data: pendingJob } = await supabaseAdmin
    .from('onboarding_jobs')
    .select('id, status')
    .eq('property_id', pidV.value!)
    .in('status', ['queued', 'running', 'mapping', 'extracting'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingJob) {
    // Idempotent: return the existing job so the UI can resume polling.
    return ok({ jobId: pendingJob.id, alreadyRunning: true }, { requestId });
  }

  // ─── Insert the job ──────────────────────────────────────────────────────
  const { data: job, error: insertErr } = await supabaseAdmin
    .from('onboarding_jobs')
    .insert({
      property_id: pidV.value!,
      pms_type: creds.pms_type,
      status: 'queued',
      step: 'Waiting for a worker…',
      progress_pct: 0,
    })
    .select('id')
    .single();

  if (insertErr || !job) {
    log.error('[pms/onboard] insert failed', { err: insertErr, requestId });
    return err('Could not queue the onboarding job', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  return ok({ jobId: job.id, alreadyRunning: false }, { requestId, status: 202 });
}
