// POST /api/inventory/orders/create — turn the reorder cart into real purchase
// orders, grouped by vendor. Management-only (requireOrderingAccess). Status
// follows the property ordering mode: simple → 'draft', pro → 'pending_approval'.
// The client sends each created PO to /api/inventory/orders/send afterward
// (simple mode auto-sends where a vendor email is on file).

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { createPurchaseOrders } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import type { CartLineInput } from '@/lib/ordering/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  lines?: Array<{
    itemId?: string | null;
    description?: string;
    qtyOrdered?: number;
    unitCostCents?: number;
    vendorName?: string | null;
    vendorId?: string | null;
  }>;
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

  const rl = await checkAndIncrementRateLimit('inventory-order-create', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return err('lines must be a non-empty array', { requestId, status: 400, code: 'validation_failed' });
  }
  if (body.lines.length > 200) {
    return err('too many lines (max 200)', { requestId, status: 400, code: 'validation_failed' });
  }

  const lines: CartLineInput[] = [];
  for (const raw of body.lines) {
    const qty = Number(raw.qtyOrdered);
    const cents = Number(raw.unitCostCents);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) continue; // skip junk lines
    const description = String(raw.description ?? '').trim().slice(0, 200) || 'Item';
    lines.push({
      itemId: typeof raw.itemId === 'string' && raw.itemId ? raw.itemId : null,
      description,
      qtyOrdered: qty,
      unitCostCents: Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : 0,
      vendorName: typeof raw.vendorName === 'string' ? raw.vendorName.trim().slice(0, 120) || null : null,
      vendorId: typeof raw.vendorId === 'string' && raw.vendorId ? raw.vendorId : null,
    });
  }
  if (lines.length === 0) {
    return err('no valid lines to order', { requestId, status: 400, code: 'validation_failed' });
  }

  try {
    const { orders, mode } = await createPurchaseOrders(pid, gate.accountId, lines);
    return ok({ orders, mode }, { requestId, status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('foreign_item_id')) {
      return err('a cart line references an item from another property', {
        requestId, status: 400, code: 'foreign_item_id',
      });
    }
    return err('failed to create purchase orders', { requestId, status: 500, code: 'create_failed' });
  }
}
