/**
 * POST /api/stripe/create-checkout
 *
 * Initiates a Stripe Checkout session for a property's subscription.
 * Called from the dashboard's "Add card to continue" CTA when a trial
 * is about to expire (or has expired). The returned URL is a Stripe-
 * hosted page where the GM enters card info; on success Stripe sends
 * us a webhook (handled by /api/stripe/webhook) that flips the
 * property's subscription_status from 'trial' to 'active'.
 *
 * Body: { propertyId, returnUrl? }
 *
 * Returns: { url } — caller should redirect the browser to this URL.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import {
  createStripeCustomer,
  createCheckoutSession,
  stripeIsConfigured,
} from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  propertyId?: unknown;
  returnUrl?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  if (!stripeIsConfigured) {
    return err('Billing is not yet configured. Contact support.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Load property + verify ownership.
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('id, owner_id, name, stripe_customer_id')
    .eq('id', pidV.value!)
    .maybeSingle();
  if (!property) return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Ensure we have a Stripe customer. Created during /signup if Stripe
  // was configured at the time; if it wasn't, lazily create one now.
  let customerId = property.stripe_customer_id as string | null;
  if (!customerId) {
    const cust = await createStripeCustomer({
      email: session.email ?? '',
      propertyName: property.name as string,
      propertyId: pidV.value!,
    });
    if (!('ok' in cust) || !cust.ok) {
      return err(
        'disabled' in cust && cust.disabled
          ? 'Billing is not yet configured.'
          : `Could not initialize billing: ${(cust as { error: string }).error}`,
        { requestId, status: 500, code: ApiErrorCode.UpstreamFailure },
      );
    }
    customerId = cust.customerId;
    await supabaseAdmin
      .from('properties')
      .update({ stripe_customer_id: customerId })
      .eq('id', pidV.value!);
  }

  // 2026-05-12 (Codex audit): build URLs from a fixed canonical origin
  // instead of trusting request headers. The old code took whatever the
  // client sent in `Origin` (or could send via custom `returnUrl`), so
  // an authenticated owner could mint a Stripe Checkout session whose
  // post-payment redirect landed on an attacker-controlled host —
  // useful for phishing follow-on flows. Use NEXT_PUBLIC_APP_URL with
  // a hardcoded fallback; allow only relative paths in returnUrl.
  const CANONICAL_ORIGIN = process.env.NEXT_PUBLIC_APP_URL || 'https://getstaxis.com';
  const safeReturn = (() => {
    const v = typeof body.returnUrl === 'string' ? body.returnUrl : null;
    // Only accept paths like /dashboard or /settings/billing — never full URLs.
    if (v && /^\/[A-Za-z0-9._~!$&'()*+,;=:@/?-]*$/.test(v) && !v.startsWith('//')) {
      return v;
    }
    return null;
  })();
  const successUrl = `${CANONICAL_ORIGIN}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = safeReturn ? `${CANONICAL_ORIGIN}${safeReturn}` : `${CANONICAL_ORIGIN}/dashboard?billing=cancelled`;

  const checkout = await createCheckoutSession({
    customerId,
    propertyId: pidV.value!,
    successUrl,
    cancelUrl,
  });
  if (!('ok' in checkout) || !checkout.ok) {
    return err(
      'disabled' in checkout && checkout.disabled
        ? 'Billing is not yet configured.'
        : `Could not start checkout: ${(checkout as { error: string }).error}`,
      { requestId, status: 500, code: ApiErrorCode.UpstreamFailure },
    );
  }

  return ok({ url: checkout.url, sessionId: checkout.sessionId }, { requestId });
}
