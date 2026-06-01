/**
 * /api/front-desk/packages/[id]
 *
 * PATCH  — mark a held package picked up (status → picked_up, stamps
 *          picked_up_at + picked_up_by). pid in the JSON body.
 * DELETE — remove a package logged by mistake. pid in the query string.
 *
 * Same access level as the list/create route: any signed-in user with access to
 * the property. Service-role via the store; deny-all-browser table.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { gatePackagesRead, gatePackagesWrite } from '@/lib/packages/api-gate';
import { markPickedUp, deletePackage } from '@/lib/packages/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// ─── PATCH — mark picked up ───────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await gatePackagesWrite<{ pid?: string }>(req, 'packages-write');
  if (!gate.ok) return gate.response;
  const { pid, requestId, accountId } = gate;

  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const res = await markPickedUp(pid, idV.value!, accountId);
    if (!res.ok) {
      if (res.error === 'not_found') {
        // Either a forged/cross-tenant id or already picked up (the status
        // guard matched 0 rows). 404 covers both honestly.
        return err('Package not found or already picked up', {
          requestId,
          status: 404,
          code: ApiErrorCode.NotFound,
        });
      }
      return err('Could not update package', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    return ok({ pickedUp: true }, { requestId });
  } catch (e) {
    log.error('packages PATCH failed', { requestId, pid, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

// ─── DELETE — remove a mistaken log ───────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // pid comes from the query string for DELETE (no body).
  const gate = await gatePackagesRead(req, 'packages-write');
  if (!gate.ok) return gate.response;
  const { pid, requestId } = gate;

  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const res = await deletePackage(pid, idV.value!);
    if (!res.ok) {
      if (res.error === 'not_found') {
        return err('Package not found', {
          requestId,
          status: 404,
          code: ApiErrorCode.NotFound,
        });
      }
      return err('Could not delete package', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    return ok({ deleted: true }, { requestId });
  } catch (e) {
    log.error('packages DELETE failed', { requestId, pid, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
