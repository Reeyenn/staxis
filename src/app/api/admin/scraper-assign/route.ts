/**
 * POST /api/admin/scraper-assign
 *
 * Reassign a property to a different scraper_instance (i.e. tell the
 * fleet "Hotel X should now be polled by the Railway service tagged
 * SCRAPER_INSTANCE_ID=<new_instance>").
 *
 * Pairs with GET /api/admin/scraper-instances. Used to:
 *   - Move a hotel off an overloaded scraper onto a fresh Railway deploy.
 *   - Geo-distribute (us-east scraper handles east-coast hotels).
 *   - Stage rollouts (pin canary hotels to a "canary" instance).
 *
 * Body: { property_id: uuid, scraper_instance: string }
 *
 * The scraper_instance field is free-form text in the DB (migration 0018
 * defaults it to 'default'). We constrain it here to [A-Za-z0-9._-]{1,64}
 * so a typo doesn't end up persisted as a giant garbage string or one
 * that breaks log filters.
 *
 * Side effects:
 *   - Updates scraper_credentials.scraper_instance for the row keyed by
 *     property_id. updated_at auto-bumps via the existing trigger.
 *   - Writes an admin_audit_log entry (action='scraper.reassign') so we
 *     can replay who moved what when something breaks downstream.
 *
 * Effect propagation: the running Railway scrapers cache the instance
 * filter for 60 seconds (CACHE_TTL_MS in properties-loader.js). Within
 * one cache cycle the OLD instance stops seeing the property and the
 * NEW instance picks it up on its next tick. No restart required.
 *
 * Auth: admin role required.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// scraper_instance lives in env vars and log filters — keep it strict.
// Same alphabet as Railway service names + an explicit length cap.
const INSTANCE_RX = /^[A-Za-z0-9._-]{1,64}$/;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  // Dual auth (signed-in admin OR CRON_SECRET) — see requireAdminOrCron
  // in src/lib/admin-auth.ts. Earlier draft used requireSessionOrCron
  // which let any signed-in user reassign hotels; that was wrong — only
  // admins (or cron-secret-bearing scripts) should drive the fleet.
  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;
  const actor =
    auth.kind === 'session'
      ? { kind: 'session' as const, userId: auth.userId, email: auth.email }
      : { kind: 'cron' as const, userId: undefined, email: 'cron@staxis.internal' };

  let body: { property_id?: unknown; scraper_instance?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.property_id, 'property_id');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  if (typeof body.scraper_instance !== 'string' || !INSTANCE_RX.test(body.scraper_instance)) {
    return err(
      'scraper_instance must match /^[A-Za-z0-9._-]{1,64}$/',
      { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
    );
  }
  const newInstance = body.scraper_instance;

  try {
    // Read the existing row first so we can record the previous value
    // in the audit log. If the property has no scraper_credentials row
    // we refuse — creating credentials is a separate flow (the
    // onboarding wizard sets ca_username/ca_password), and reassignment
    // is strictly about already-existing rows.
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('scraper_credentials')
      .select('property_id, scraper_instance')
      .eq('property_id', propertyId)
      .maybeSingle();
    if (readErr) {
      log.error('scraper-assign: read failed', { requestId, propertyId, err: readErr });
      return err('failed to read scraper_credentials', { requestId, status: 500 });
    }
    if (!existing) {
      return err(
        'no scraper_credentials row exists for this property — set creds via the onboarding flow first',
        { requestId, status: 404, code: ApiErrorCode.NotFound },
      );
    }
    const previousInstance = (existing.scraper_instance as string) ?? 'default';

    if (previousInstance === newInstance) {
      // No-op. Return success rather than 4xx — idempotent reassignment
      // is a normal pattern (admin clicks "save" without changing the
      // value, or a workflow re-asserts the desired state).
      return ok(
        { property_id: propertyId, scraper_instance: newInstance, previous: previousInstance, unchanged: true },
        { requestId },
      );
    }

    const { error: upErr } = await supabaseAdmin
      .from('scraper_credentials')
      .update({ scraper_instance: newInstance })
      .eq('property_id', propertyId);
    if (upErr) {
      log.error('scraper-assign: update failed', { requestId, propertyId, err: upErr });
      return err('failed to reassign property', { requestId, status: 500 });
    }

    await writeAudit({
      action: 'scraper.reassign',
      actorUserId: actor.userId,
      actorEmail: actor.email ?? undefined,
      targetType: 'property',
      targetId: propertyId,
      hotelId: propertyId,
      metadata: {
        previous_instance: previousInstance,
        new_instance: newInstance,
        actor_kind: actor.kind,
      },
    });

    log.info('scraper-assign: ok', {
      requestId,
      propertyId,
      previousInstance,
      newInstance,
      actor: actor.email,
    });

    return ok(
      {
        property_id: propertyId,
        scraper_instance: newInstance,
        previous: previousInstance,
        unchanged: false,
      },
      { requestId },
    );
  } catch (e) {
    log.error('scraper-assign: handler crashed', { requestId, err: e as Error });
    return err('scraper-assign handler failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
