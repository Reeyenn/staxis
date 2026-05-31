// POST /api/inventory/orders/send — email a purchase order to its vendor and
// mark it 'sent'. Management-only. Billing-impacting (Resend) → rate limit
// fails CLOSED. Resolves the recipient from an explicit toEmail override, else
// the linked vendor's email. The status flip only happens AFTER the email
// succeeds, so a failed send never lies about an order being sent.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { getPurchaseOrder, getPropertyName, markPurchaseOrderSent } from '@/lib/ordering/db';
import { sendPurchaseOrderEmail } from '@/lib/ordering/email';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { isValidEmail, validateUuid } from '@/lib/api-validate';
import type { Language } from '@/lib/translations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  orderId?: string;
  toEmail?: string;
  lang?: string;
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

  const rl = await checkAndIncrementRateLimit('inventory-order-send', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const po = await getPurchaseOrder(pid, orderId);
  if (!po) return err('order not found', { requestId, status: 404, code: 'not_found' });
  if (!['draft', 'approved', 'sent'].includes(po.status)) {
    return err(`cannot send an order in status "${po.status}"`, { requestId, status: 409, code: 'bad_status' });
  }

  // Recipient: explicit override wins, else the linked vendor's email.
  const toEmail = (typeof body.toEmail === 'string' && body.toEmail.trim()) || po.vendorEmail || '';
  if (!isValidEmail(toEmail)) {
    return err('no valid vendor email — add one on the vendor or pass toEmail', {
      requestId,
      status: 400,
      code: 'no_vendor_email',
    });
  }

  // Property name for the email body (best-effort).
  const propertyName = await getPropertyName(pid);
  const lang: Language = body.lang === 'es' ? 'es' : 'en';

  const sent = await sendPurchaseOrderEmail({
    po,
    toEmail,
    propertyName,
    lang,
    actorUserId: gate.userId,
    actorEmail: gate.email,
  });
  if (!sent.ok) {
    return err(`email failed: ${sent.error}`, { requestId, status: 502, code: 'email_failed' });
  }

  const result = await markPurchaseOrderSent(pid, orderId, toEmail);
  if (!result.ok) {
    return err(result.reason, { requestId, status: 409, code: 'bad_status' });
  }
  return ok({ order: result.order, emailId: sent.id }, { requestId });
}
