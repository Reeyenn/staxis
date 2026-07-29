// GET /api/company-access/structure
//
// Fresh, customer-safe company -> portfolio/region -> hotel structure. The
// caller supplies no organization or hotel selector; the SECURITY DEFINER
// projection derives every row from the authenticated account's authoritative
// normalized scope.
//
// @tenant-scope session user -> accounts.id -> normalized organization access;
// no tenant identifiers are accepted by this route.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import {
  CompanyStructureStoreError,
  loadCompanyStructureProjection,
} from '@/lib/company-access/structure-server';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) {
      return err('Account not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    const projection = await loadCompanyStructureProjection(actor.accountId);
    return ok(projection, { requestId });
  } catch (caught) {
    log.error('[company-access:structure:GET] failed', {
      requestId,
      code: caught instanceof CompanyStructureStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (isCompanyAccessUnavailable(caught)
        || (caught instanceof CompanyStructureStoreError
          && ['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(caught.code ?? ''))) {
      return err('Company structure is temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not load company structure', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
