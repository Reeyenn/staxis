// GET /api/company-access/access-editor
//
// Returns only the normalized memberships and exact scope catalog this caller
// may manage right now. Platform admins do not edit customer access through
// this surface; hats, legacy grants, and customer↔hotel relationships are not
// editable here.
//
// @tenant-scope session user -> accounts.id -> fresh normalized manage_access
// delegation; the SECURITY DEFINER projection emits no foreign organization.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import {
  CompanyAccessEditorStoreError,
  loadCompanyAccessEditorProjection,
} from '@/lib/company-access/access-editor-server';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
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
    return ok(await loadCompanyAccessEditorProjection(actor.accountId), { requestId });
  } catch (caught) {
    log.error('[company-access:access-editor:GET] failed', {
      requestId,
      code: caught instanceof CompanyAccessEditorStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (isCompanyAccessUnavailable(caught)
        || (caught instanceof CompanyAccessEditorStoreError
          && ['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(caught.code ?? ''))) {
      return err('Company access editing is temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not load company access editing', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
