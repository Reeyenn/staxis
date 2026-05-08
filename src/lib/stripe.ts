/**
 * Stripe server-side wrapper.
 *
 * Why this exists:
 *   Centralize the Stripe SDK init and the per-property/customer/
 *   subscription helpers so the API routes call a typed, narrow
 *   interface instead of poking the SDK directly. Also lets us
 *   gracefully degrade when STRIPE_SECRET_KEY isn't configured —
 *   important during development and during the early days where
 *   Reeyen hasn't created a Stripe account yet.
 *
 * "Trial mode" fallback:
 *   When STRIPE_SECRET_KEY is missing, every call here returns
 *   a `{ disabled: true }` shape instead of throwing. Callers
 *   handle this by giving the property an indefinite free trial
 *   (subscription_status='trial' with trial_ends_at=null). This way
 *   the signup flow works end-to-end before billing exists; we just
 *   flip a switch when Stripe goes live.
 */

import Stripe from 'stripe';

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const DEFAULT_PRICE_ID = process.env.STRIPE_PRICE_ID;

export const stripeIsConfigured = Boolean(SECRET_KEY);

// Stripe SDK is null when not configured. Every helper checks first.
const stripe: Stripe | null = SECRET_KEY
  ? new Stripe(SECRET_KEY, {
      apiVersion: '2025-04-30.basil' as Stripe.LatestApiVersion,
      typescript: true,
      // Build a meaningful application name in the Stripe dashboard
      // request log so we can grep easily.
      appInfo: {
        name: 'Staxis (HotelOps AI)',
        url: 'https://staxis.com',
      },
    })
  : null;

/** Trial length for new self-signup properties. */
export const TRIAL_DAYS = 14;

/** Get the timestamp when a fresh trial ends (now + 14 days). */
export function trialEndsAt(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + TRIAL_DAYS);
  return d;
}

// ─── Customer ────────────────────────────────────────────────────────────

export interface CreateCustomerArgs {
  email: string;
  /** Owner's display name. Goes onto the Stripe receipt as "Bill To". */
  name?: string;
  /** Hotel name. Appended to the customer description for ops. */
  propertyName: string;
  /** Property UUID. Stored in Stripe metadata so the webhook can
   *  resolve which property a payment is for without extra lookups. */
  propertyId: string;
}

export async function createStripeCustomer(args: CreateCustomerArgs): Promise<
  | { ok: true; customerId: string }
  | { ok: false; error: string }
  | { ok: false; disabled: true }
> {
  if (!stripe) return { ok: false, disabled: true };
  try {
    const customer = await stripe.customers.create({
      email: args.email,
      name: args.name,
      description: `Property: ${args.propertyName}`,
      metadata: {
        property_id: args.propertyId,
        source: 'staxis-self-signup',
      },
    });
    return { ok: true, customerId: customer.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Checkout ────────────────────────────────────────────────────────────

export interface CreateCheckoutArgs {
  customerId: string;
  propertyId: string;
  /** Override default price (e.g., for a discounted plan). */
  priceId?: string;
  /** Where Stripe redirects after success. Should be a complete URL. */
  successUrl: string;
  /** Where Stripe redirects on cancel. Should be a complete URL. */
  cancelUrl: string;
}

export async function createCheckoutSession(args: CreateCheckoutArgs): Promise<
  | { ok: true; url: string; sessionId: string }
  | { ok: false; error: string }
  | { ok: false; disabled: true }
> {
  if (!stripe) return { ok: false, disabled: true };
  const priceId = args.priceId ?? DEFAULT_PRICE_ID;
  if (!priceId) {
    return { ok: false, error: 'STRIPE_PRICE_ID env var is required for checkout' };
  }
  try {
    const session = await stripe.checkout.sessions.create({
      customer: args.customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      // Surface property_id on the resulting subscription so the webhook
      // can correlate payments to properties without extra DB lookups.
      subscription_data: {
        metadata: { property_id: args.propertyId },
      },
      allow_promotion_codes: true,
      billing_address_collection: 'required',
    });
    if (!session.url) {
      return { ok: false, error: 'Stripe returned no checkout URL' };
    }
    return { ok: true, url: session.url, sessionId: session.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Customer portal ─────────────────────────────────────────────────────
// Used for "Manage subscription" — Stripe-hosted page where the GM can
// update card, change plan, cancel, see invoices.

export async function createPortalSession(args: {
  customerId: string;
  returnUrl: string;
}): Promise<
  | { ok: true; url: string }
  | { ok: false; error: string }
  | { ok: false; disabled: true }
> {
  if (!stripe) return { ok: false, disabled: true };
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: args.customerId,
      return_url: args.returnUrl,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Webhook signature verification ─────────────────────────────────────

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
): { ok: true; event: Stripe.Event } | { ok: false; error: string } {
  if (!stripe || !WEBHOOK_SECRET) {
    return { ok: false, error: 'Stripe webhook secret not configured' };
  }
  try {
    const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
    return { ok: true, event };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type { Stripe };
