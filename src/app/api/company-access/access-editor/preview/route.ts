// POST /api/company-access/access-editor/preview
//
// Read-only impact preview for one exact normalized membership grant-set edit.
// Every opaque id, current epoch/revision, target membership, existing grant,
// profile and scope is revalidated in the database.
//
// @tenant-scope session user -> accounts.id -> fresh normalized manage_access;
// submitted organization/membership/portfolio/hotel ids are untrusted.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import {
  CompanyAccessEditorStoreError,
  previewCompanyAccessEdit,
} from '@/lib/company-access/access-editor-server';
import { validateCompanyAccessEditInput } from '@/lib/company-access/access-editor';
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
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'Company access changed; reload before previewing again' };
  }
  if (error.code === '23514') {
    return { status: 409, code: ApiErrorCode.ValidationFailed, message: 'This access cannot be replaced while it protects required ownership' };
  }
  if (error.code === '22023') {
    return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Access change details are not valid' };
  }
  if (['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(error.code ?? '')) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company access editing is temporarily unavailable' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not preview access change' };
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
  const input = validateCompanyAccessEditInput(body);
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
    return ok(await previewCompanyAccessEdit(actor.accountId, input.value), { requestId });
  } catch (caught) {
    log.warn('[company-access:access-editor:preview] rejected', {
      requestId,
      code: caught instanceof CompanyAccessEditorStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (caught instanceof CompanyAccessEditorStoreError) {
      const mapped = mappedError(caught);
      return err(mapped.message, {
        requestId, status: mapped.status, code: mapped.code,
      });
    }
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company access editing is temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not preview access change', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
