import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { isUuid } from '@/lib/api-validate';
import { loadSessionAccount, type ManagerCaller } from '@/lib/team-auth';
import { isPortfolioUiSection } from '@/lib/portfolio-ui/contracts';
import {
  loadPortfolioUiSection,
  type PortfolioUiAuthoritativeCompany,
} from '@/lib/portfolio-ui/server';
import {
  resolveManagementCompanyScopeUncached,
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
 * GET /api/portfolio/v1/section?organizationId=<uuid>&section=<section>
 *
 * The organization is mandatory even for a one-company caller. Each request
 * reloads the account and re-matches that id to a current company-scope hat,
 * so a removed hat or ended relationship closes the next read.
 */
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let account: ManagerCaller | null;
  try {
    account = await loadSessionAccount(session.userId);
  } catch (e) {
    log.error('[portfolio-ui] section access read failed', {
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

  const params = req.nextUrl.searchParams;
  const organizationValues = params.getAll('organizationId');
  const sectionValues = params.getAll('section');
  if (organizationValues.length !== 1 || sectionValues.length !== 1) {
    return err('organizationId and section must each be supplied once', {
      requestId,
      status: 400,
      code: 'invalid_request',
      headers: PRIVATE_HEADERS,
    });
  }
  const organizationId = organizationValues[0];
  const section = sectionValues[0];
  if (!isUuid(organizationId)) {
    return err('organizationId must be a valid UUID', {
      requestId,
      status: 400,
      code: 'invalid_request',
    });
  }
  if (!isPortfolioUiSection(section)) {
    return err('section is not supported', {
      requestId,
      status: 400,
      code: 'invalid_request',
    });
  }

  if (account.role === 'admin' || account.reachesAllProperties) {
    return err('Choose an authorized customer context before opening a portfolio', {
      requestId,
      status: 403,
      code: 'customer_context_required',
      headers: PRIVATE_HEADERS,
    });
  }
  const resolved = await resolveManagementCompanyScopeUncached(
    account.accountId,
    organizationId.toLowerCase(),
  );
  if (!resolved.ok) {
    return resolved.reason === 'authorization_unavailable'
      ? err('Portfolio access is temporarily unavailable', {
          requestId,
          status: 503,
          code: 'access_unavailable',
          headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
        })
      : err('Company access was not found', {
          requestId,
          status: 404,
          code: 'not_found',
          headers: PRIVATE_HEADERS,
        });
  }
  const authoritativeCompany: PortfolioUiAuthoritativeCompany = {
    organizationId: resolved.access.organizationId,
    organizationName: resolved.access.organizationName,
    companyRole: resolved.access.companyRole,
    propertyIds: resolved.access.propertyIds,
    queueAvailable: resolved.access.queueAvailable,
    propertyStandings: resolved.access.propertyStandings,
    presentationCapabilities: resolved.access.presentationCapabilities,
  };
  const result = await loadPortfolioUiSection({
    account,
    authoritativeCompany,
    organizationId: organizationId.toLowerCase(),
    section,
  });
  if (!result.ok) {
    return err(result.message, {
      requestId,
      status: result.status,
      code: result.code,
      ...(result.status === 503 ? { headers: { 'Retry-After': '5' } } : {}),
    });
  }
  const initial = resolved.access.authorizationReceipt;
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
  return ok(result.data, { requestId, headers: PRIVATE_HEADERS });
}
