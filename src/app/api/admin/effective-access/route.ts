import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { requireAdmin } from '@/lib/admin-auth';
import { writeAudit } from '@/lib/audit';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { loadAdminEffectiveAccess } from '@/lib/company-access/admin-effective-access-server';
import { saveCompanyAccessSettings } from '@/lib/company/rulebook-access';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' } as const;

function auditRequestUuid(requestId: string): string {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}`
    + `-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function targetFrom(req: NextRequest):
  | { propertyId: string }
  | { organizationId: string }
  | { error: string } {
  const params = new URL(req.url).searchParams;
  const propertyId = params.get('propertyId');
  const organizationId = params.get('organizationId');
  if (Boolean(propertyId) === Boolean(organizationId)) {
    return { error: 'Provide exactly one propertyId or organizationId' };
  }
  if (propertyId) {
    const validated = validateUuid(propertyId, 'propertyId');
    return validated.error ? { error: validated.error } : { propertyId: validated.value! };
  }
  const validated = validateUuid(organizationId, 'organizationId');
  return validated.error ? { error: validated.error } : { organizationId: validated.value! };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const target = targetFrom(req);
  if ('error' in target) {
    return err(target.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }

  try {
    // Retry one exact read when a hotel transfer or entitlement change races
    // the projection. The second failure remains explicit and fail-closed.
    let projection;
    try {
      projection = await loadAdminEffectiveAccess(target);
    } catch (caught) {
      if (!(caught instanceof Error) || caught.message !== 'access_changed') throw caught;
      projection = await loadAdminEffectiveAccess(target);
    }
    return ok(projection, { requestId, headers: NO_STORE_HEADERS });
  } catch (caught) {
    if (caught instanceof Error
        && (caught.message === 'hotel_not_found' || caught.message === 'organization_not_found')) {
      return err(caught.message === 'hotel_not_found' ? 'Hotel not found' : 'Organization not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound, headers: NO_STORE_HEADERS,
      });
    }
    log.error('[admin/effective-access:GET] projection failed', {
      requestId, actorAccountId: auth.accountId, error: errToString(caught),
    });
    return err('Authoritative access is temporarily unavailable', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { ...NO_STORE_HEADERS, 'Retry-After': '5' },
    });
  }
}

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { organizationId?: unknown; crossHotelAiChat?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err('A valid JSON body is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  const organizationId = validateUuid(body.organizationId, 'organizationId');
  if (organizationId.error || typeof body.crossHotelAiChat !== 'boolean') {
    return err(organizationId.error ?? 'crossHotelAiChat must be a boolean', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }

  try {
    const { data: organization, error: organizationError } = await supabaseAdmin.from('organizations')
      .select('id, organization_type')
      .eq('id', organizationId.value!)
      .maybeSingle();
    if (organizationError) throw organizationError;
    if (!organization || organization.organization_type === 'single_hotel') {
      return err('Organization not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound, headers: NO_STORE_HEADERS,
      });
    }

    const saved = await saveCompanyAccessSettings(
      organizationId.value!,
      { cross_hotel_ai_chat: body.crossHotelAiChat ? 'true' : 'false' },
      auth.accountId,
    );
    if (!saved.ok) throw new Error(saved.error ?? 'company_access_setting_failed');
    await writeAudit({
      action: 'organization.cross_hotel_ai_chat.update',
      actorUserId: auth.userId,
      actorEmail: auth.email ?? undefined,
      targetType: 'organization',
      targetId: organizationId.value!,
      metadata: { enabled: body.crossHotelAiChat },
    });

    const projection = await loadAdminEffectiveAccess({ organizationId: organizationId.value! });
    return ok(projection, { requestId, headers: NO_STORE_HEADERS });
  } catch (caught) {
    log.error('[admin/effective-access:PATCH] company AI permission failed', {
      requestId, actorAccountId: auth.accountId, error: errToString(caught),
    });
    return err('Could not save the company AI permission', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure, headers: NO_STORE_HEADERS,
    });
  }
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { membershipId?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err('A valid JSON body is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  const membershipId = validateUuid(body.membershipId, 'membershipId');
  if (membershipId.error) {
    return err(membershipId.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }

  try {
    const { data: membership, error: membershipError } = await supabaseAdmin
      .from('organization_memberships')
      .select('id, organization_id, membership_scope, staxis_role, ended_at')
      .eq('id', membershipId.value!)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || membership.ended_at !== null || membership.staxis_role === null) {
      return err('Membership job not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound, headers: NO_STORE_HEADERS,
      });
    }
    if (membership.membership_scope === 'company' && membership.staxis_role === 'owner') {
      return err('Transfer organization ownership before removing this job', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE_HEADERS,
      });
    }

    const auditId = auditRequestUuid(requestId);
    const { data, error: rpcError } = await supabaseAdmin.rpc('staxis_end_membership_hat_guarded', {
      p_actor_account_id: auth.accountId,
      p_actor_auth_user_id: auth.userId,
      p_membership_id: membershipId.value!,
      p_audit_request_id: auditId,
    });
    if (rpcError) throw rpcError;
    const receipt = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    if (!receipt || receipt.ok !== true
        || receipt.membershipId !== membershipId.value!
        || receipt.organizationId !== membership.organization_id
        || receipt.auditRequestId !== auditId) {
      throw new Error('guarded_membership_receipt_invalid');
    }
    return ok({ membershipId: membershipId.value! }, { requestId, headers: NO_STORE_HEADERS });
  } catch (caught) {
    log.error('[admin/effective-access:DELETE] guarded membership removal failed', {
      requestId, actorAccountId: auth.accountId, error: errToString(caught),
    });
    return err('Could not remove the organization job', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure, headers: NO_STORE_HEADERS,
    });
  }
}
