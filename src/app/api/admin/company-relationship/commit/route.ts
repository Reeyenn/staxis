// POST /api/admin/company-relationship/commit
// Preview-bound, explicitly confirmed, idempotent platform-admin lifecycle
// mutation. Authorization is rechecked by both this route and the transaction.

import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import {
  AdminHotelRelationshipStoreError,
  commitAdminHotelRelationshipChange,
} from '@/lib/company-access/admin-hotel-relationship-server';
import {
  validateAdminHotelRelationshipCommit,
  validateAdminHotelRelationshipIdempotencyKey,
} from '@/lib/company-access/admin-hotel-relationship';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mapStoreError(error: AdminHotelRelationshipStoreError) {
  if (error.code === '42501') return { status: 403, code: ApiErrorCode.Forbidden, message: 'Staxis administrator access is required' };
  if (error.code === 'P0002' || error.code === '23503') return { status: 404, code: ApiErrorCode.NotFound, message: 'Hotel or target company not found' };
  if (error.code === '40001') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'The preview is stale; reload and confirm the current impact' };
  if (error.code === '23505') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'That idempotency key belongs to a different relationship change' };
  if (error.code === '23514') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'This hotel has conflicting active company relationships and requires repair' };
  if (error.code === '22023') return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Relationship confirmation details are not valid' };
  if (['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(error.code ?? '')) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Hotel relationship management is temporarily unavailable' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not save the hotel relationship change' };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const idempotencyKey = validateAdminHotelRelationshipIdempotencyKey(
    req.headers.get('idempotency-key'),
  );
  if (!idempotencyKey.ok) return err(idempotencyKey.error, {
    requestId, status: 400, code: ApiErrorCode.ValidationFailed,
  });

  let body: unknown;
  try { body = await req.json(); } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const input = validateAdminHotelRelationshipCommit(body);
  if (!input.ok) return err(input.error, {
    requestId, status: 400, code: ApiErrorCode.ValidationFailed,
  });

  try {
    const result = await commitAdminHotelRelationshipChange(
      auth.accountId,
      input.value,
      idempotencyKey.value,
    );
    return ok(result, {
      requestId,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Idempotency-Key': idempotencyKey.value,
      },
    });
  } catch (caught) {
    log.warn('[admin:company-relationship:commit] rejected', {
      requestId,
      code: caught instanceof AdminHotelRelationshipStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (caught instanceof AdminHotelRelationshipStoreError) {
      const mapped = mapStoreError(caught);
      return err(mapped.message, {
        requestId,
        status: mapped.status,
        code: mapped.code,
        headers: { 'Idempotency-Key': idempotencyKey.value },
      });
    }
    return err('Could not save the hotel relationship change', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
