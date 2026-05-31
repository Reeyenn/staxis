// POST /api/inventory/orders/receive — record a delivery against a PO.
// Management-only. Per-line qtyReceived is a CUMULATIVE TARGET (idempotent —
// re-submitting can't double-count stock). Updates inventory.current_stock,
// writes the dollars-based inventory_orders restock log so spend metrics keep
// working, and flips the PO to received / partially_received. Short deliveries
// (received < ordered) are flagged back to the client.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { receivePurchaseOrder } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { validateUuid } from '@/lib/api-validate';
import type { ReceiveLineInput } from '@/lib/ordering/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  orderId?: string;
  lines?: Array<{ lineId?: string; qtyReceived?: number }>;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid json', { requestId: 'pre-auth', status: 400, code: 'validation_failed' });
  }

  const gate = await requireOrderingAccess(req, body.pid);
  if (!gate.ok) return gate.response;
  const { pid, requestId } = gate;

  const idV = validateUuid(body.orderId, 'orderId');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: 'validation_failed' });
  const orderId = idV.value!;

  const rl = await checkAndIncrementRateLimit('inventory-order-receive', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return err('lines must be a non-empty array', { requestId, status: 400, code: 'validation_failed' });
  }
  const lines: ReceiveLineInput[] = [];
  for (const raw of body.lines) {
    const lid = validateUuid(raw.lineId, 'lineId');
    if (lid.error) continue;
    const q = Number(raw.qtyReceived);
    if (!Number.isFinite(q) || q < 0 || q > 10_000_000) continue;
    lines.push({ lineId: lid.value!, qtyReceived: q });
  }
  if (lines.length === 0) {
    return err('no valid receive lines', { requestId, status: 400, code: 'validation_failed' });
  }

  try {
    const result = await receivePurchaseOrder(pid, orderId, lines);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return err(result.reason, { requestId, status, code: status === 404 ? 'not_found' : 'bad_status' });
    }
    return ok({ order: result.order, shortLines: result.shortLines }, { requestId });
  } catch {
    return err('failed to receive order', { requestId, status: 500, code: 'receive_failed' });
  }
}
