import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { isUuid } from '@/lib/api-validate';
import { loadSessionAccount, type ManagerCaller } from '@/lib/team-auth';
import {
  loadPortfolioUiBootstrap,
  type PortfolioUiAuthoritativeCompany,
} from '@/lib/portfolio-ui/server';
import { listPortfolioCompaniesUncached } from '@/lib/company/portfolio';
import {
  presentationCapabilitiesFromAuthorizationReceipt,
  propertyStandingsFromAuthorizationReceipt,
} from '@/lib/company/authoritative-scope';
import { assertAuthorizationScopeReceipt } from '@/lib/authorization/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Authorization, Cookie',
};

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((propertyId, index) => propertyId === right[index]);
}

/**
 * GET /api/portfolio/v1/bootstrap?organizationId=<optional narrowing>
 *
 * Multi-company callers receive every authorized context and no implicit
 * selection. `organizationId` is only matched against the current account's
 * freshly loaded hats; it is never used as an unrestricted database lookup.
 */
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let account: ManagerCaller | null;
  try {
    account = await loadSessionAccount(session.userId);
  } catch (e) {
    log.error('[portfolio-ui] bootstrap access read failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Portfolio access is temporarily unavailable', {
      requestId,
      status: 503,
      code: 'access_unavailable',
      headers: { 'Retry-After': '5' },
    });
  }
  if (!account) {
    return err('Account is not available', {
      requestId,
      status: 403,
      code: 'account_not_available',
    });
  }
  // A platform-wide/wildcard identity is not an acting customer context.
  // Passing it to the bootstrap reader would turn `all properties` into one
  // synthetic hotel-only portfolio and silently merge tenants. Administrators
  // must first assume an explicit, separately authorized customer context;
  // this route does not infer one from an organizationId in the URL.
  if (account.role === 'admin' || account.reachesAllProperties) {
    return err('Choose an authorized customer context before opening a portfolio', {
      requestId,
      status: 403,
      code: 'customer_context_required',
    });
  }

  const organizationValues = req.nextUrl.searchParams.getAll('organizationId');
  if (organizationValues.length > 1) {
    return err('organizationId may be supplied once', {
      requestId,
      status: 400,
      code: 'invalid_request',
      headers: PRIVATE_HEADERS,
    });
  }
  const requestedOrganizationId = organizationValues[0] ?? null;
  if (requestedOrganizationId !== null && !isUuid(requestedOrganizationId)) {
    return err('organizationId must be a valid UUID', {
      requestId,
      status: 400,
      code: 'invalid_request',
    });
  }

  const catalog = await listPortfolioCompaniesUncached(account.accountId);
  if (!catalog.ok) {
    return err('Portfolio access is temporarily unavailable', {
      requestId,
      status: 503,
      code: 'access_unavailable',
      headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
    });
  }
  if (requestedOrganizationId
      && !catalog.companies.some((company) => (
        company.organizationId === requestedOrganizationId.toLowerCase()
      ))) {
    return err('Company access was not found', {
      requestId,
      status: 404,
      code: 'not_found',
      headers: PRIVATE_HEADERS,
    });
  }
  const authoritativeCompanies: PortfolioUiAuthoritativeCompany[] = catalog.companies.map(
    (company) => ({
      organizationId: company.organizationId,
      organizationName: company.organizationName,
      companyRole: company.companyRole,
      propertyIds: company.propertyIds,
      queueAvailable: company.queueAvailable,
      propertyStandings: propertyStandingsFromAuthorizationReceipt(
        company.authorizationReceipt,
      ),
      presentationCapabilities: presentationCapabilitiesFromAuthorizationReceipt(
        company.authorizationReceipt,
      ),
    }),
  );
  const result = await loadPortfolioUiBootstrap({
    account,
    authoritativeCompanies,
    requestedOrganizationId: requestedOrganizationId?.toLowerCase() ?? null,
  });
  if (!result.ok) {
    return err(result.message, {
      requestId,
      status: result.status,
      code: result.code,
      ...(result.status === 503 ? { headers: { 'Retry-After': '5' } } : {}),
    });
  }
  // Every company label and hotel count in the response came from one of
  // these receipts. Reassert all of them after the data read so revocation
  // between catalog construction and egress cannot leak a stale tenant.
  for (const company of catalog.companies) {
    const initial = company.authorizationReceipt;
    const asserted = await assertAuthorizationScopeReceipt({
      receiptId: initial.id,
      accountId: account.accountId,
    });
    if (!asserted.ok) {
      return asserted.reason === 'scope_changed'
        || asserted.reason === 'revoked_or_changed'
        || asserted.reason === 'expired'
        ? err('Portfolio access changed while the page was loading', {
            requestId,
            status: 409,
            code: 'scope_changed',
            headers: PRIVATE_HEADERS,
          })
        : err('Portfolio access is temporarily unavailable', {
            requestId,
            status: 503,
            code: 'access_unavailable',
            headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
          });
    }
    if (asserted.receipt.organizationId !== initial.organizationId
        || asserted.receipt.authorizationHash !== initial.authorizationHash
        || asserted.receipt.scopeHash !== initial.scopeHash
        || !sameIds(asserted.receipt.propertyIds, initial.propertyIds)
        || !sameIds(
          asserted.receipt.authorizedPropertyIds,
          initial.authorizedPropertyIds,
        )) {
      return err('Portfolio access is temporarily unavailable', {
        requestId,
        status: 503,
        code: 'access_unavailable',
        headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
      });
    }
  }
  return ok(result.data, { requestId, headers: PRIVATE_HEADERS });
}
