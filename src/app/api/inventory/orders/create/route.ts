// POST /api/inventory/orders/create — turn the reorder cart into real purchase
// orders, grouped by vendor. Management-only (requireOrderingAccess). Orders
// start as 'draft'; the client then sends each created PO to
// /api/inventory/orders/send (auto-sending where a vendor email is on file).

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { requireSectionEnabled } from '@/lib/sections/server';
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

  // Section gate (add-on, on top of the tenant guard above): if Inventory is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, gate.pid, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

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
    const { orders } = await createPurchaseOrders(pid, gate.accountId, lines);
    return ok({ orders }, { requestId, status: 201 });
  } catch {
    return err('failed to create purchase orders', { requestId, status: 500, code: 'create_failed' });
  }
}
