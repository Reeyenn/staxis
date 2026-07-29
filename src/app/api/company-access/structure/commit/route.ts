// POST /api/company-access/structure/commit
//
// Commits a previously previewed exact portfolio assignment. The database
// re-runs fresh authorization and impact resolution under the organization
// lock, compares the preview fingerprint and access epoch, writes an immutable
// audit event, and binds the response to the Idempotency-Key.
//
// @tenant-scope session user -> accounts.id -> fresh manage_portfolios scope;
// all submitted ids, confirmation state, epoch, and fingerprint are untrusted.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import {
  CompanyStructureStoreError,
  commitCompanyPortfolioAssignment,
} from '@/lib/company-access/structure-server';
import {
  validatePortfolioAssignmentCommitInput,
  validateStructureIdempotencyKey,
} from '@/lib/company-access/structure';
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
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'The preview is stale; reload and confirm the current impact' };
  }
  if (error.code === '23505') {
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'That idempotency key belongs to a different structure change' };
  }
  if (error.code === '22023') {
    return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Structure confirmation details are not valid' };
  }
  if (['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(error.code ?? '')) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company structure changes are temporarily unavailable' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not save structure change' };
}
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const idempotencyKey = validateStructureIdempotencyKey(req.headers.get('idempotency-key'));
  if (!idempotencyKey.ok) {
    return err(idempotencyKey.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const input = validatePortfolioAssignmentCommitInput(body);
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
    const result = await commitCompanyPortfolioAssignment(
      actor.accountId,
      input.value,
      idempotencyKey.value,
    );
    return ok(result, {
      requestId,
      headers: { 'Idempotency-Key': idempotencyKey.value },
    });
  } catch (caught) {
    log.warn('[company-access:structure:commit] rejected', {
      requestId,
      code: caught instanceof CompanyStructureStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (caught instanceof CompanyStructureStoreError) {
      const mapped = mappedError(caught);
      return err(mapped.message, {
        requestId,
        status: mapped.status,
        code: mapped.code,
        headers: { 'Idempotency-Key': idempotencyKey.value },
      });
    }
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company structure changes are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not save structure change', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
