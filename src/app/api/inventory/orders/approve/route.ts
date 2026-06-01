// POST /api/inventory/orders/approve — Pro mode only. Approve an order so it
// can be sent (pending_approval → approved). Management-only. Simple-mode
// orders never reach 'pending_approval', so this is a no-op there.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { approvePurchaseOrder } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  orderId?: string;
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

  const rl = await checkAndIncrementRateLimit('inventory-order-approve', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const result = await approvePurchaseOrder(pid, idV.value!, gate.accountId);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return err(result.reason, { requestId, status, code: status === 404 ? 'not_found' : 'bad_status' });
    }
    return ok({ order: result.order }, { requestId });
  } catch {
    return err('failed to approve order', { requestId, status: 500, code: 'approve_failed' });
  }
}
