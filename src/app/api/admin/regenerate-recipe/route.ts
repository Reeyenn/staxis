/**
 * POST /api/admin/regenerate-recipe
 *
 * Triggered by Reeyen from /admin/properties/[id] when a PMS UI change
 * has broken the existing recipe. Queues a fresh CUA mapping job with
 * force_remap=true.
 *
 * Body: { propertyId, reason? }
 *
 * Effects:
 *   - Inserts an onboarding_jobs row with force_remap=true. The
 *     cua-service worker will run the mapper even though an active
 *     recipe exists, then atomically swap the new recipe in via
 *     staxis_swap_active_recipe() AT SUCCESS TIME.
 *
 *     Critically: we do NOT eager-demote the existing active recipe.
 *     Recipes are scoped per-pms_type (not per-property), so demoting
 *     the cloudbeds recipe for one property would break cloudbeds for
 *     every other cloudbeds property until the new mapping run lands.
 *     The atomic swap at success time means the fleet is never
 *     recipe-less, even mid-regeneration. (Pass-3 fix — H7.)
 *
 * Returns: { jobId }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  propertyId?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const reasonV = body.reason
    ? validateString(body.reason, { max: 500, label: 'reason' })
    : { value: null as string | null };
  if ('error' in reasonV && reasonV.error) {
    return err(reasonV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Cost guard: each regeneration costs $1-3 in Claude tokens. Cap
  // at 10/hour/property to stop a runaway script (or compromised
  // admin) from carpet-bombing the API.
  const rl = await checkAndIncrementRateLimit('admin-regenerate-recipe', pidV.value!);
  if (!rl.allowed) {
    return err(
      `Rate limited. ${rl.current}/${rl.cap} regenerations this hour for this property. Try again in ${rl.retryAfterSec}s.`,
      { requestId, status: 429, code: ApiErrorCode.RateLimited,
        headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  // Look up the property's PMS type via scraper_credentials.
  const { data: creds } = await supabaseAdmin
    .from('scraper_credentials')
    .select('pms_type, is_active')
    .eq('property_id', pidV.value!)
    .maybeSingle();

  if (!creds || !creds.is_active) {
    return err(
      'Property has no active credentials — cannot regenerate without something to log into.',
      { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
    );
  }

  // Queue a fresh onboarding job with force_remap=true. The worker will
  // run the mapper regardless of existing recipe, then atomically swap
  // (demote old + promote new) inside staxis_swap_active_recipe at
  // success time. The current recipe stays active and the fleet keeps
  // working until the new one is ready.
  const { data: job, error: insertErr } = await supabaseAdmin
    .from('onboarding_jobs')
    .insert({
      property_id: pidV.value!,
      pms_type: creds.pms_type as string,
      status: 'queued',
      step: `Admin re-mapping requested${reasonV.value ? `: ${reasonV.value}` : ''}`,
      progress_pct: 0,
      force_remap: true,
    })
    .select('id')
    .single();

  if (insertErr || !job) {
    return err(
      `Could not queue regeneration job: ${insertErr?.message ?? 'unknown'}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }

  return ok({ jobId: job.id, pmsType: creds.pms_type }, { requestId, status: 202 });
}
