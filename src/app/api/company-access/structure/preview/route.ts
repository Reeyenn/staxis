// POST /api/company-access/structure/preview
//
// Read-only impact preview for one exact portfolio assignment set. The RPC
// validates the opaque ids, fresh capability, primary owner/operator
// relationship, and optimistic access epoch before it emits a fingerprint.
//
// @tenant-scope session user -> accounts.id -> fresh manage_portfolios scope;
// all submitted ids are untrusted and transactionally revalidated.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import {
  CompanyStructureStoreError,
  previewCompanyPortfolioAssignment,
} from '@/lib/company-access/structure-server';
import { validatePortfolioAssignmentInput } from '@/lib/company-access/structure';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mappedError(error: CompanyStructureStoreError) {
  if (error.code === '42501') {
    return { status: 403, code: ApiErrorCode.Forbidden, message: 'You cannot change this hotel structure' };
  }
  if (error.code === 'P0002' || error.code === '23503') {
    return { status: 404, code: ApiErrorCode.NotFound, message: 'Company structure target not found' };
  }
  if (error.code === '40001') {
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'Company access changed; reload before previewing again' };
  }
  if (error.code === '22023') {
    return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Structure change details are not valid' };
  }
  if (['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(error.code ?? '')) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company structure changes are temporarily unavailable' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not preview structure change' };
}
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const input = validatePortfolioAssignmentInput(body);
  if (!input.ok) {
    return err(input.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) {
      return err('Account not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    const preview = await previewCompanyPortfolioAssignment(actor.accountId, input.value);
    return ok(preview, { requestId });
  } catch (caught) {
    log.warn('[company-access:structure:preview] rejected', {
      requestId,
      code: caught instanceof CompanyStructureStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (caught instanceof CompanyStructureStoreError) {
      const mapped = mappedError(caught);
      return err(mapped.message, {
        requestId, status: mapped.status, code: mapped.code,
      });
    }
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company structure changes are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not preview structure change', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
