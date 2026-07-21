/**
 * Cursor-paged, non-destructive inventory history.
 *
 * Any MFA-verified member of the property may read the same operational
 * history exposed by the physical Inventory page. Cost/value details are
 * merged only when the existing view_financials capability resolves true.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { canViewFinancials, type AppRole } from '@/lib/roles';
import { requireSectionEnabled } from '@/lib/sections/server';
import { isSectionEnabled } from '@/lib/sections/registry';
import {
  listInventoryAuditHistory,
  parseInventoryAuditLimit,
} from '@/lib/inventory-audit-history';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const { data: account, error: accountError } = await supabaseAdmin
    .from('accounts')
    .select('role,property_access')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (accountError || !account) {
    return err('account not found for session', { requestId, status: 403, code: 'forbidden' });
  }
  const role = ((account.role as string | null) ?? 'staff') as AppRole;
  const access = (account.property_access ?? []) as string[];
  if (role !== 'admin' && !access.includes(propertyId) && !access.includes('*')) {
    return err('You do not have access to that property.', {
      requestId, status: 403, code: 'forbidden_property',
    });
  }
  const sectionGate = await requireSectionEnabled(req, propertyId, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

  const capabilityDecision = canViewFinancials(role)
    ? await capabilityDecisionForProperty({ role }, 'view_financials', propertyId)
    : 'denied';
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  const includeFinancials = capabilityDecision === 'allowed'
    && isSectionEnabled(sectionGate.enabledSections, 'financials');
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
