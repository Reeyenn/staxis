/**
 * GET /api/settings/reports/catalog?propertyId=UUID
 *
 * Returns the report catalog (titles/descriptions/categories), the caller's
 * favorites for the property, and the property's saved schedules.
 *
 * Auth: manager/owner/admin + property access.
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { listCatalog } from '@/lib/reports/catalog';
import { gateReportsAccess, visibleReportCatalog } from '@/lib/reports/catalog/gate';
import { listFavorites } from '@/lib/reports/catalog/store';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error ?? 'invalid propertyId', { requestId, status: 400, code: 'validation_failed' });
    const propertyId = pidV.value!;

    const gate = await gateReportsAccess(req, propertyId);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    // Don't offer a money report to a manager whose Financials switch is off at
    // this hotel; /run and /export would 403 it anyway.
    const financials = await capabilityDecisionForProperty(
      { role: gate.caller.role },
      'view_financials',
      propertyId,
    );
    if (financials === 'unavailable') return capabilityUnavailableResponse(requestId);

    const favorites = await listFavorites(gate.caller.accountId, propertyId);

    return ok({
      catalog: visibleReportCatalog(listCatalog(), { canViewFinancials: financials === 'allowed' }),
      favorites,
    }, { requestId });
  } catch (e) {
    log.error('reports catalog failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to load reports.', { requestId, status: 500, code: 'internal_error' });
  }
}
