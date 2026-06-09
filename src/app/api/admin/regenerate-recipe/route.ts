/**
 * POST /api/admin/regenerate-recipe
 *
 * Triggered by Reeyen from /admin/properties/[id] when a PMS UI change
 * has broken the existing playbook. Queues a fresh full learning run.
 *
 * Body: { propertyId, reason? }
 *
 * Effects:
 *   - Inserts a `workflow_jobs` row (kind mapper.learn_pms_family) —
 *     the queue the Plan-v8 CUA worker actually polls. (2026-06-09 fix:
 *     this route previously inserted into the legacy `onboarding_jobs`
 *     table, which nothing consumes since the v8 rebuild — the button
 *     was a no-op.)
 *
 *   - We do NOT eager-demote the existing active knowledge file.
 *     Knowledge files are scoped per-pms_family (not per-property), so
 *     demoting would break every hotel on that family until the new run
 *     lands. mapping-driver's promotion gate atomically swaps
 *     (demote old active → promote new draft) at success time, so the
 *     fleet is never playbook-less mid-regeneration.
 *
 *   - Idempotency key is time-salted: workflow_jobs has a GLOBAL
 *     (property_id, idempotency_key) unique constraint, so reusing the
 *     auto-enqueue key (`mapper.learn_pms_family:<family>`) would 23505
 *     against a completed historical row and silently never re-learn.
 *     The 10/hr rate limit bounds repeat-clicking.
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
import { writeAudit } from '@/lib/audit';

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

  // Queue a fresh FULL learning run on the v8 workflow queue. The
  // promotion gate in mapping-driver atomically swaps the new knowledge
  // file in at success time; the current one stays active until then.
  const { data: job, error: insertErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: pidV.value!,
      kind: 'mapper.learn_pms_family',
      // Time-salted — see header. The global unique (property_id, key)
      // would otherwise collide with completed historical runs.
      idempotency_key: `mapper.learn_pms_family:${creds.pms_type}:regen:${Date.now()}`,
      // Plan v8 final review B1 — a failed re-learn needs an explicit
      // admin re-trigger, never a silent money-burning auto-retry.
      max_attempts: 1,
      triggered_by: `admin:${auth.accountId}:regenerate-recipe`,
      payload: {
        pms_family: creds.pms_type as string,
        property_id: pidV.value!,
        // Full-learn budget — matches CUA_FULL_LEARN_COST_CAP_MICROS
        // ($40, ~2x a clean Opus 4.8 full learn). Explicit here so the
        // admin path is self-documenting; the worker would apply the
        // same default if omitted.
        cost_cap_micros: 40_000_000,
        regen_reason: reasonV.value ?? null,
      },
    })
    .select('id')
    .single();

  if (insertErr || !job) {
    return err(
      `Could not queue regeneration job: ${insertErr?.message ?? 'unknown'}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }

  // Admin audit trail. writeAudit is best-effort (try/catch + console.warn
  // on failure inside the helper) so a Supabase blip never breaks the
  // admin's regenerate request. Action name matches the example given in
  // admin_audit_log.sql ('recipe.regenerate' → namespaced 'cua.recipe.regenerate'
  // because we want CUA-specific events to be filterable as one bucket).
  await writeAudit({
    action: 'cua.recipe.regenerate',
    actorUserId: auth.userId,
    actorEmail: auth.email ?? undefined,
    targetType: 'workflow_job',
    targetId: job.id as string,
    hotelId: pidV.value!,
    metadata: {
      pms_type: creds.pms_type,
      reason: reasonV.value ?? null,
      request_id: requestId,
    },
  });

  return ok({ jobId: job.id, pmsType: creds.pms_type }, { requestId, status: 202 });
}
