/**
 * GET /api/auth/session-authorization
 *
 * A deliberately small, uncached read of the CURRENT account authorization
 * behind the browser session. AuthContext uses it to retire stale client role
 * state after an administrator is demoted while their tab remains open.
 *
 * This is not an authorization boundary for /admin itself — every admin page
 * and API keeps its own fresh requireAdmin gate. It only prevents the shared
 * shell from advertising a destination the current account can no longer use.
 */

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { isValidRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { listAuthoritativePropertyAccess } from '@/lib/authorization/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie, Authorization',
} as const;

function addNoStoreHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return addNoStoreHeaders(session.response);

  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active')
    .eq('data_user_id', session.userId)
    .maybeSingle();

  if (error) {
    log.error('session-authorization: account lookup failed', {
      requestId,
      userId: session.userId,
      err: error.message,
    });
    return err('Authorization could not be verified', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: NO_STORE_HEADERS,
    });
  }

  const verifiedAt = new Date().toISOString();
  if (!account) {
    // A successful lookup with no row is definitive. It is intentionally a
    // 200-shaped authorization snapshot rather than an ambiguous 404 so the
    // client can fail closed without treating a transient fetch error as a
    // confirmed revocation.
    return ok({
      active: false,
      role: null,
      propertyAccess: [] as string[],
      propertyStandings: [],
      platformAdmin: false,
      authorizationFingerprint: null,
      verifiedAt,
    }, { requestId, headers: NO_STORE_HEADERS });
  }

  if (!isValidRole(account.role)) {
    log.error('session-authorization: account has an invalid role', {
      requestId,
      userId: session.userId,
      role: account.role,
    });
    return err('Authorization could not be verified', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: NO_STORE_HEADERS,
    });
  }

  const active = account.active === true;
  const platformAdmin = active && account.role === 'admin';
  let propertyAccess: string[] = [];
  let propertyStandings: Array<{
    propertyId: string;
    operationalRole: string;
    seesFinancials: boolean;
    hotelMutationAllowed: boolean;
    portfolioIntelligenceRead: boolean;
  }> = [];
  let authorizationFingerprint: string | null = null;
  if (platformAdmin) {
    // Platform admin is an independent realm. Do not make shell revocation
    // state depend on a customer-organization resolver.
    propertyAccess = ['*'];
    authorizationFingerprint = `platform-admin:${account.id as string}`;
  } else if (active) {
    const authority = await listAuthoritativePropertyAccess(account.id as string);
    if (!authority || authority.all) {
      log.error('session-authorization: authoritative access lookup failed', {
        requestId,
        userId: session.userId,
        accountId: account.id,
      });
      return err('Authorization could not be verified', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: NO_STORE_HEADERS,
      });
    }
    propertyAccess = authority.propertyIds;
    // Opaque change detector only. It is content-bound to the full validated
    // entitlement provenance, so an owner→VP/finance or scope-source change
    // invalidates client projections even when the visible hotel IDs happen to
    // remain identical. No receipt or entitlement details cross this route.
    authorizationFingerprint = authority.effectiveAccessHash;
    propertyStandings = authority.propertyStandings.map((standing) => ({
      propertyId: standing.propertyId,
      operationalRole: standing.operationalRole,
      seesFinancials: standing.seesFinancials,
      hotelMutationAllowed: standing.hotelMutationAllowed,
      portfolioIntelligenceRead: standing.portfolioIntelligenceRead,
    }));
  }

  return ok({
    active,
    role: account.role,
    propertyAccess,
    propertyStandings,
    platformAdmin,
    authorizationFingerprint,
    verifiedAt,
  }, { requestId, headers: NO_STORE_HEADERS });
}
