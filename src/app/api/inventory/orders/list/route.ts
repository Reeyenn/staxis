// GET /api/inventory/orders/list?pid=<uuid> — purchase orders for the property,
// newest first, with lines + vendor email. Management-only (requireOrderingAccess).

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { requireSectionEnabled } from '@/lib/sections/server';
import { listPurchaseOrders } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');

  const gate = await requireOrderingAccess(req, pid);
  if (!gate.ok) return gate.response;
  const { requestId } = gate;

  // Section gate (add-on, on top of the ordering tenant guard above): if
  // Inventory is turned off for this hotel, block the orders list entirely.
  const sectionGate = await requireSectionEnabled(req, gate.pid, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

  const rl = await checkAndIncrementRateLimit('inventory-orders-read', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const orders = await listPurchaseOrders(gate.pid, 200);
    return ok({ orders }, { requestId });
  } catch {
    return err('failed to list orders', { requestId, status: 500, code: 'list_failed' });
  }
}
