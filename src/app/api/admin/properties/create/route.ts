/**
 * POST /api/admin/properties/create
 *
 * Platform-admin hotel-shell creation. This route owns property creation;
 * onboarding and PMS setup only configure an existing hotel.
 *
 * What it does:
 *   1. Validates inputs (name, total_rooms, IANA timezone, optional
 *      pms_type / brand / property_kind / is_test / organization_id).
 *   2. Verifies an optional target organization before inserting anything.
 *   3. Inserts a hotel shell with zero customer accounts or invitations.
 *   4. Uses the authoritative organization-transfer RPC when a target was
 *      supplied, compensating the brand-new insert if assignment fails.
 *   5. Writes an audit row.
 *
 * Returns: { propertyId, name, organizationId, relationshipId }
 *
 * Discipline:
 *   - All validation runs server-side. Client-side checks are advisory only.
 *   - Timezone validated via Intl.DateTimeFormat (same mechanism as
 *     ml-service's require_property_timezone after Phase L). Phase K's
 *     CHECK (total_rooms > 0) catches a bypass at the DB layer too.
 *   - This endpoint never mints a join code or sends an invitation. People are
 *     invited separately from the exact hotel's People control.
 */

import { NextRequest, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { triggerMlTraining } from '@/lib/ml-invoke';
import {
  validateBody,
  usesAtomicTestRoster,
  type CreateBody,
} from '@/lib/admin-property-create-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function statusForOrganizationError(error: { code?: string }): number {
  if (error.code === '42501') return 403;
  if (error.code === 'P0002' || error.code === '23503') return 404;
  if (error.code === '23505' || error.code === '23514') return 409;
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01') return 503;
  return 500;
}

function apiCodeForStatus(status: number): string {
  if (status === 403) return ApiErrorCode.Forbidden;
  if (status === 404) return ApiErrorCode.NotFound;
  if (status === 409) return ApiErrorCode.IdempotencyConflict;
  if (status === 503) return ApiErrorCode.UpstreamFailure;
  return ApiErrorCode.InternalError;
}

function statusForRosterError(error: { code?: string }): number {
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01') return 503;
  if (error.code === '23514' || error.code === 'P0001') return 409;
  return 500;
}

type CreatedProperty = {
  id: string;
  name: string | null;
  created_at: string | null;
};

function parseCreatedProperty(data: unknown): CreatedProperty | null {
  if (data === null || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== 'string') return null;
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
  };
}

async function rollbackNewHotel(
  propertyId: string,
  actorAccountId: string,
  requestId: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc('staxis_delete_property_and_legacy_accounts', {
    p_actor_account_id: actorAccountId,
    p_property_id: propertyId,
    p_confirmed_name: null,
  });
  if (!error) return true;
  log.error('[admin/properties/create] failed to roll back unassigned hotel shell', {
    requestId,
    propertyId,
    msg: error.message,
  });
  return false;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return err(validation.reason, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const v = validation.values;

  let targetOrganizationName: string | null = null;
  if (v.organizationId) {
    const { data: target, error: targetError } = await supabaseAdmin
      .from('organizations')
      .select('id, name, organization_type, status')
      .eq('id', v.organizationId)
      .maybeSingle();
    if (targetError) {
      const status = statusForOrganizationError(targetError);
      return err(status === 503 ? 'Organization access is not ready yet' : 'Could not verify organization', {
        requestId,
        status,
        code: status === 503 ? ApiErrorCode.UpstreamFailure : ApiErrorCode.InternalError,
      });
    }
    if (!target || target.status !== 'active') {
      return err('Active organization not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
      });
    }
    if (target.organization_type === 'single_hotel') {
      return err('Legacy single-hotel anchors cannot contain other hotels', {
        requestId,
        status: 409,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    targetOrganizationName = target.name;
  }

  let created: CreatedProperty | null = null;
  if (usesAtomicTestRoster(v)) {
    // The shell and its canonical roster are one database transaction. The
    // service-only function either returns a fully consistent test property
    // or raises before any shell can remain.
    const { data: atomicData, error: atomicError } = await supabaseAdmin.rpc(
      'staxis_create_test_property_with_roster',
      {
        p_owner_id: auth.userId,
        p_name: v.name,
        p_total_rooms: v.totalRooms,
        p_timezone: v.timezone,
        p_pms_type: v.pmsType,
        p_brand: v.brand,
        p_property_kind: v.propertyKind,
        p_room_numbers: v.roomNumbers,
      },
    );
    created = parseCreatedProperty(atomicData);
    if (atomicError || !created) {
      const status = atomicError ? statusForRosterError(atomicError) : 500;
      log.error('[admin/properties/create] atomic test property creation failed', {
        requestId,
        msg: atomicError?.message ?? 'atomic function returned no property',
      });
      return err(
        status === 503
          ? 'Test hotel creation is not ready yet'
          : 'Could not create the test hotel and its roster atomically.',
        {
          requestId,
          status,
          code: apiCodeForStatus(status),
        },
      );
    }
  } else {
    // owner_id remains a NOT NULL legacy storage column. The platform admin's
    // auth id is a compatibility placeholder, not a customer owner membership.
    // This route deliberately creates no account, membership, invite, or code.
    // Real properties and test shells without an explicit roster retain the
    // existing empty-canonical-roster behavior.
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('properties')
      .insert({
        owner_id: auth.userId,
        name: v.name,
        total_rooms: v.totalRooms,
        timezone: v.timezone,
        pms_type: v.pmsType,
        brand: v.brand,
        property_kind: v.propertyKind,
        is_test: v.isTest,
        onboarding_source: 'admin',
        onboarding_state: { step: 1 },
        // Empty array means "capture later" (e.g., via PMS sync). An explicit
        // room list on a real property remains operator-supplied mirror data;
        // generated canonical rows are reserved for the test branch above.
        ...(v.roomNumbers.length > 0 ? { room_inventory: v.roomNumbers } : {}),
      })
      .select('id, name, created_at')
      .single();

    if (insErr || !inserted) {
      log.error('[admin/properties/create] insert failed', { requestId, msg: insErr?.message ?? String(insErr) });
      return err(
        `Failed to create property: ${insErr?.message ?? 'unknown error'}`,
        { requestId, status: 500, code: ApiErrorCode.InternalError },
      );
    }
    created = inserted;
  }

  let relationshipId: string | null = null;
  if (v.organizationId) {
    const { data, error: assignmentError } = await supabaseAdmin.rpc(
      'staxis_set_primary_property_organization',
      {
        p_actor_account_id: auth.accountId,
        p_property_id: created.id,
        p_organization_id: v.organizationId,
        p_relationship_type: 'operator',
      },
    );
    if (assignmentError) {
      const status = statusForOrganizationError(assignmentError);
      const rolledBack = await rollbackNewHotel(created.id, auth.accountId, requestId);
      log.error('[admin/properties/create] organization assignment failed', {
        requestId,
        propertyId: created.id,
        organizationId: v.organizationId,
        rolledBack,
        msg: assignmentError.message,
      });
      return err(
        rolledBack
          ? 'Could not create the hotel in that organization. No hotel was kept.'
          : 'The hotel shell was created but could not be assigned. Open the hotel directory before retrying.',
        {
          requestId,
          status: rolledBack ? status : 500,
          code: rolledBack ? apiCodeForStatus(status) : ApiErrorCode.InternalError,
          ...(!rolledBack ? { details: { propertyId: created.id } } : {}),
        },
      );
    }
    relationshipId = data as string | null;
  }

  // Deliberately NO preset inventory (2026-07-09, Reeyen): new hotels start
  // with an empty inventory list — owners add their own items. The old Phase
  // M1.5 seed of 16 default items lived here; removing it means inventory ML
  // cold-start simply waits for the first real items/counts, which is fine.

  // Phase M3.1 (2026-05-14): trigger demand+supply cold-start ML training
  // for the new property AFTER response is sent. Matches the wizard finalize
  // hook so admin-created hotels also get instant Day-1 predictions instead
  // of waiting for the next weekly training cron (Sunday 03:00 CT).
  //
  // Fire-and-forget via next/server's after() — Next.js holds the function
  // alive past the response so this completes (vs raw fire-and-forget where
  // Vercel may freeze before the fetch resolves). Failures are non-fatal:
  // the daily aggregator + weekly cron remain the safety nets.
  after(async () => {
    const propertyId = created.id;
    try {
      const results = await Promise.allSettled([
        triggerMlTraining(propertyId, 'demand', { requestId }),
        triggerMlTraining(propertyId, 'supply', { requestId }),
      ]);
      log.info('admin_create_ml_kick', {
        requestId,
        pid: propertyId,
        demandStatus: results[0].status === 'fulfilled' ? results[0].value.status : 'rejected',
        supplyStatus: results[1].status === 'fulfilled' ? results[1].value.status : 'rejected',
      });
    } catch (e) {
      // Should be unreachable — triggerMlTraining never throws — but
      // belt-and-suspenders for after() context.
      log.error('[admin/properties/create] ML kick threw (non-fatal)', {
        requestId, propertyId, msg: e instanceof Error ? e.message : String(e),
      });
    }
  });

  await writeAudit({
    action: 'property.create',
    actorUserId: auth.userId,
    actorEmail: auth.email ?? undefined,
    targetType: 'property',
    targetId: created.id,
    hotelId: created.id,
    metadata: {
      name: v.name,
      total_rooms: v.totalRooms,
      timezone: v.timezone,
      pms_type: v.pmsType,
      is_test: v.isTest,
      organization_id: v.organizationId,
      organization_name: targetOrganizationName,
      relationship_id: relationshipId,
      customer_accounts_created: 0,
      room_inventory_count: v.roomNumbers.length,
    },
  });

  return ok(
    {
      propertyId: created.id,
      name: created.name ?? v.name,
      organizationId: v.organizationId,
      relationshipId,
    },
    { requestId, status: 201 },
  );
}
