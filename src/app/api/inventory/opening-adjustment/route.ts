/** Manager-only audited correction for pre-existing stock missed at baseline. */

import { NextRequest } from 'next/server';
import { requireFinanceAccess, isUuid } from '@/lib/financials/api-gate';
import { canForProperty } from '@/lib/capabilities/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { recordInventoryOpeningAdjustment } from '@/lib/db/inventory-month-closes';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!record(parsed)) throw new Error('body must be an object');
    body = parsed;
  } catch {
    return err('A valid JSON body is required.', {
      requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const propertyId = typeof body.propertyId === 'string' ? body.propertyId : null;
  const gate = await requireFinanceAccess(req, propertyId);
  if (!gate.ok) return gate.response;
  if (!(await canForProperty({ role: gate.role }, 'manage_inventory_orders', gate.pid))) {
    return err('You do not have permission to correct opening inventory.', {
      requestId: gate.requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }

  const itemId = typeof body.itemId === 'string' ? body.itemId : '';
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  const effectiveAt = typeof body.effectiveAt === 'string' ? body.effectiveAt : '';
  const at = new Date(effectiveAt);
  if (!isUuid(itemId) || !isUuid(requestId) || !effectiveAt || Number.isNaN(at.getTime())
      || !finiteNonnegative(body.expectedStock)
      || !finiteNonnegative(body.resultingStock)
      || !finiteNonnegative(body.adjustmentQuantity)
      || body.adjustmentQuantity <= 0
      || body.adjustmentQuantity > body.resultingStock
      || !finiteNonnegative(body.unitCost)) {
    return err('Item, stock quantities, unit cost, timestamp, and request id are invalid.', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const result = await recordInventoryOpeningAdjustment(supabaseAdmin, {
      propertyId: gate.pid,
      itemId,
      requestId,
      effectiveAt: at.toISOString(),
      expectedStock: body.expectedStock,
      resultingStock: body.resultingStock,
      adjustmentQuantity: body.adjustmentQuantity,
      unitCost: body.unitCost,
      actorId: gate.userId,
      actorName: gate.name,
    });
    return ok(result, { requestId: gate.requestId });
  } catch (error) {
    const dbCode = record(error) && typeof error.code === 'string' ? error.code : '';
    const conflict = ['22023', '23514', '40001'].includes(dbCode);
    log.error('[inventory/opening-adjustment] failed', {
      propertyId: gate.pid,
      itemId,
      dbCode: dbCode || null,
      err: errToString(error),
    });
    return err(
      conflict
        ? 'Opening inventory could not be corrected. Refresh the item and verify that monthly tracking is open.'
        : 'Opening inventory could not be corrected.',
      {
        requestId: gate.requestId,
        status: conflict ? 409 : 500,
        code: conflict ? 'opening_adjustment_conflict' : ApiErrorCode.InternalError,
      },
    );
  }
}
