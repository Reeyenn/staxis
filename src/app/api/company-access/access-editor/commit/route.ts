// POST /api/company-access/access-editor/commit
//
// Commits one explicitly confirmed preview. The database repeats fresh actor,
// target, existing-grant and topology authorization under the organization
// lock, then atomically replaces/adds grants with an immutable audit summary.
//
// @tenant-scope session user -> accounts.id -> fresh normalized manage_access;
// every submitted id, revision, epoch, fingerprint and confirmation is untrusted.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import {
  CompanyAccessEditorStoreError,
  commitCompanyAccessEdit,
} from '@/lib/company-access/access-editor-server';
import {
  validateCompanyAccessEditCommitInput,
  validateCompanyAccessEditorIdempotencyKey,
} from '@/lib/company-access/access-editor';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mappedError(error: CompanyAccessEditorStoreError) {
  if (error.code === '42501') {
    return { status: 403, code: ApiErrorCode.Forbidden, message: 'You cannot edit this company access' };
  }
  if (error.code === 'P0002' || error.code === '23503') {
    return { status: 404, code: ApiErrorCode.NotFound, message: 'Company access target not found' };
  }
  if (error.code === '40001') {
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'The preview is stale; reload and confirm the current access impact' };
  }
  if (error.code === '23505') {
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'That idempotency key belongs to a different access change' };
  }
  if (error.code === '23514') {
    return { status: 409, code: ApiErrorCode.ValidationFailed, message: 'This access cannot be replaced while it protects required ownership' };
  }
  if (error.code === '22023') {
    return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Access confirmation details are not valid' };
  }
  if (['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(error.code ?? '')) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company access editing is temporarily unavailable' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not save access change' };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const idempotencyKey = validateCompanyAccessEditorIdempotencyKey(
    req.headers.get('idempotency-key'),
  );
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
  const input = validateCompanyAccessEditCommitInput(body);
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
    const result = await commitCompanyAccessEdit(
      actor.accountId,
      input.value,
      idempotencyKey.value,
    );
    return ok(result, {
      requestId,
      headers: { 'Idempotency-Key': idempotencyKey.value },
    });
  } catch (caught) {
    log.warn('[company-access:access-editor:commit] rejected', {
      requestId,
      code: caught instanceof CompanyAccessEditorStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (caught instanceof CompanyAccessEditorStoreError) {
      const mapped = mappedError(caught);
      return err(mapped.message, {
        requestId,
        status: mapped.status,
        code: mapped.code,
        headers: { 'Idempotency-Key': idempotencyKey.value },
      });
    }
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company access editing is temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not save access change', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
