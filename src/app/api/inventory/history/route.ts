/**
 * Cursor-paged, non-destructive inventory history.
 *
 * Any MFA-verified member of the property may read the same operational
 * history exposed by the physical Inventory page. Cost/value details are
 * merged only when the existing view_financials capability resolves true.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { canViewFinancials } from '@/lib/roles';
import { isSectionEnabled } from '@/lib/sections/registry';
import {
  createRequestAuthorization,
  type HotelAuthorizationRefusal,
} from '@/lib/authorization/request';
import {
  listInventoryAuditHistory,
  parseInventoryAuditLimit,
} from '@/lib/inventory-audit-history';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorizationRefusalResponse(
  refusal: HotelAuthorizationRefusal,
  requestId: string,
): NextResponse {
  if (refusal.reason === 'section_denied') return refusal.response;
  if (refusal.reason === 'capability_unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (refusal.reason === 'authority_unavailable') {
    return err('authorization is temporarily unavailable', {
      requestId,
      status: 503,
      code: 'authorization_unavailable',
      headers: { 'Retry-After': '5' },
    });
  }
  if (refusal.reason === 'account_denied' || refusal.reason === 'account_unavailable') {
    // This pilot intentionally preserves the route's existing response for an
    // absent, inactive, or unreadable account row.
    return err('account not found for session', {
      requestId, status: 403, code: 'forbidden',
    });
  }
  if (refusal.reason === 'property_denied') {
    return err('You do not have access to that property.', {
      requestId, status: 403, code: 'forbidden_property',
    });
  }
  // Mutation/capability denials are not requested by this read-only pilot,
  // but any future accidental use still fails closed.
  return err('You do not have access to that property.', {
    requestId, status: 403, code: 'forbidden_property',
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const propertyId = req.nextUrl.searchParams.get('propertyId') ?? req.nextUrl.searchParams.get('pid');
  if (!isUuid(propertyId)) {
    return err('propertyId must be a valid UUID', {
      requestId, status: 400, code: 'validation_failed',
    });
  }

  let limit: number;
  try {
    limit = parseInventoryAuditLimit(req.nextUrl.searchParams.get('limit'));
  } catch (error) {
    return err(error instanceof Error ? error.message : 'limit is invalid', {
      requestId, status: 400, code: 'validation_failed',
    });
  }

  const authorization = createRequestAuthorization(req, { requestId });
  const session = await authorization.requireSession();
  if (!session.ok) return session.response;
  const hotel = await session.authorizeHotel({
    propertyId,
    intent: 'read',
    checks: [{ kind: 'section', section: 'inventory' }],
  });
  if (!hotel.ok) return authorizationRefusalResponse(hotel, requestId);
  const { standing } = hotel;
  const role = standing.operationalRole;

  // Finance hats carry explicit read capacity separately from their deliberately
  // narrow front_desk operational lens. Owner/GM/admin continue to honor the
  // per-hotel view_financials override.
  const capabilityDecision = !standing.seesFinancials
    ? 'denied'
    : canViewFinancials(role)
      ? await capabilityDecisionForProperty({ role }, 'view_financials', propertyId)
      : 'allowed';
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  const includeFinancials = capabilityDecision === 'allowed'
    && isSectionEnabled(hotel.enabledSections ?? null, 'financials');
  try {
    const page = await listInventoryAuditHistory(supabaseAdmin, {
      propertyId,
      cursor: req.nextUrl.searchParams.get('cursor'),
      limit,
      includeFinancials,
    });
    return ok(page, { requestId });
  } catch (error) {
    const invalidCursor = error instanceof Error && /cursor is invalid/i.test(error.message);
    if (invalidCursor) {
      return err('cursor is invalid', { requestId, status: 400, code: 'validation_failed' });
    }
    log.error('[inventory/history] load failed', {
      propertyId, requestId, err: errToString(error),
    });
    return err('Inventory history could not be loaded.', {
      requestId, status: 500, code: 'internal_error',
    });
  }
}
