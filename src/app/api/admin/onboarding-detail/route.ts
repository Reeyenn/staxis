/**
 * GET /api/admin/onboarding-detail?propertyId=<uuid>
 *
 * Journey-only detail for one hotel on the Admin Onboarding surface. It
 * returns the six-stage markers, preserved hotel details, and the exact first
 * person. PMS, mapping, robot, and team data belong to their general admin
 * surfaces and are deliberately not dependencies of this flow.
 */

import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const propertyId = new URL(req.url).searchParams.get('propertyId') ?? '';
  if (!isUuid(propertyId)) {
    return err('propertyId must be a UUID', { requestId, status: 400 });
  }

  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, total_rooms, brand, timezone, created_at, onboarding_state, onboarding_completed_at, owner_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr) {
    return err(`Could not load property: ${propErr.message}`, { requestId, status: 500 });
  }
  if (!prop) return err('Property not found', { requestId, status: 404 });

  const onboardingState = prop.onboarding_state as Record<string, unknown> | null;
  const firstPersonAccountId = typeof onboardingState?.firstPersonAccountId === 'string'
    && isUuid(onboardingState.firstPersonAccountId)
    ? onboardingState.firstPersonAccountId
    : null;
  const invitedEmail = typeof onboardingState?.invitedEmail === 'string'
    ? onboardingState.invitedEmail
    : null;

  // 0411 backfills retained in-progress records. The owner_id fallback exists
  // only for a legacy row that has started but could not be deterministically
  // bound; it is never used for a pristine zero-user shell.
  const legacyOwnerAuthId = !firstPersonAccountId && onboardingState?.accountCreatedAt
    ? prop.owner_id
    : null;
  const ownerQuery = firstPersonAccountId
    ? supabaseAdmin
        .from('accounts')
        .select('display_name, username, phone')
        .eq('id', firstPersonAccountId)
        .maybeSingle()
    : legacyOwnerAuthId
      ? supabaseAdmin
          .from('accounts')
          .select('display_name, username, phone')
          .eq('data_user_id', legacyOwnerAuthId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });
  const ownerResult = await ownerQuery;
  if (ownerResult.error) {
    return err(`Could not load first person: ${ownerResult.error.message}`, {
      requestId,
      status: 500,
    });
  }
  const owner = ownerResult.data as {
    display_name: string | null;
    username: string | null;
    phone: string | null;
  } | null;

  return ok({
    property: {
      id: prop.id,
      name: prop.name,
      totalRooms: prop.total_rooms,
      brand: prop.brand,
      timezone: prop.timezone,
      createdAt: prop.created_at,
      onboardingState: prop.onboarding_state ?? null,
      onboardingCompletedAt: prop.onboarding_completed_at,
    },
    owner: owner
      ? {
          name: owner.display_name,
          email: invitedEmail ?? owner.username,
          phone: owner.phone,
        }
      : null,
  }, { requestId });
}
