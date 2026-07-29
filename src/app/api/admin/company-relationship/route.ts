// GET /api/admin/company-relationship?pid=<hotel>&q=<company search>
//
// Platform-admin-only projection for the existing /company Hotels tab. The
// database independently verifies the active global-admin account and returns
// one exact hotel's current primary company lifecycle plus a bounded directory.

import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import {
  AdminHotelRelationshipStoreError,
  loadAdminHotelRelationshipProjection,
} from '@/lib/company-access/admin-hotel-relationship-server';
import { validateAdminHotelRelationshipQuery } from '@/lib/company-access/admin-hotel-relationship';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mapStoreError(error: AdminHotelRelationshipStoreError) {
  if (error.code === '42501') return { status: 403, code: ApiErrorCode.Forbidden, message: 'Staxis administrator access is required' };
  if (error.code === 'P0002') return { status: 404, code: ApiErrorCode.NotFound, message: 'Hotel not found' };
  if (error.code === '23514') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'This hotel has conflicting active company relationships and requires repair' };
  if (['PGRST202', 'PGRST205', '42P01', '42883', 'PGRST_CONTRACT'].includes(error.code ?? '')) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Hotel relationship management is temporarily unavailable' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not load the hotel relationship' };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const input = validateAdminHotelRelationshipQuery(
    req.nextUrl.searchParams.get('pid'),
    req.nextUrl.searchParams.get('q'),
  );
  if (!input.ok) return err(input.error, {
    requestId, status: 400, code: ApiErrorCode.ValidationFailed,
  });

  try {
    const projection = await loadAdminHotelRelationshipProjection(
      auth.accountId,
      input.value.propertyId,
      input.value.organizationQuery,
    );
    return ok(projection, {
      requestId,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (caught) {
    log.warn('[admin:company-relationship:GET] rejected', {
      requestId,
      code: caught instanceof AdminHotelRelationshipStoreError ? caught.code ?? null : null,
      error: errToString(caught),
    });
    if (caught instanceof AdminHotelRelationshipStoreError) {
      const mapped = mapStoreError(caught);
      return err(mapped.message, { requestId, status: mapped.status, code: mapped.code });
    }
    return err('Could not load the hotel relationship', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
