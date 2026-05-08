/**
 * POST /api/stripe/webhook
 *
 * Stripe's event firehose. Configure the webhook URL in Stripe Dashboard
 * → Developers → Webhooks pointing at this route. The signing secret
 * goes in STRIPE_WEBHOOK_SECRET env var.
 *
 * We handle the small set of events that affect subscription_status on
 * properties:
 *
 *   checkout.session.completed       → property.subscription_status='active'
 *   customer.subscription.updated    → mirror Stripe state to DB
 *   customer.subscription.deleted    → property.subscription_status='cancelled'
 *   invoice.payment_failed           → property.subscription_status='past_due'
 *   invoice.payment_succeeded        → property.subscription_status='active'
 *
 * The `subscription_data.metadata.property_id` set during checkout
 * makes this a single-table lookup — no need to walk Stripe customers
 * back to properties.
 *
 * Webhook signature verification is critical; without it anyone could
 * POST a fake "subscription cancelled" and we'd churn the customer.
 * verifyWebhookSignature is a strict pass-through to Stripe SDK.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { verifyWebhookSignature, stripeIsConfigured, type Stripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  if (!stripeIsConfigured) {
    return NextResponse.json({ error: 'Billing not configured' }, { status: 503 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  // Stripe requires the RAW body to verify the signature. NextRequest
  // gives us text(); JSON.parse it later if we need it.
  const rawBody = await req.text();

  const verified = verifyWebhookSignature(rawBody, sig);
  if (!verified.ok) {
    return NextResponse.json({ error: `Invalid signature: ${verified.error}` }, { status: 400 });
  }
  const event = verified.event;

  try {
    await handleEvent(event);
  } catch (err) {
    console.error(`[stripe/webhook] ${event.type} handler threw`, err);
    // Return 500 so Stripe retries. Stripe retries with exponential
    // backoff for up to 3 days, which gives us plenty of time to fix
    // a bad deploy without losing events.
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
      if (!customerId) return;

      // Find the property by stripe_customer_id and flip to 'active'.
      await supabaseAdmin
        .from('properties')
        .update({
          subscription_status: 'active',
          stripe_subscription_id: subscriptionId ?? null,
          trial_ends_at: null, // trial is over once they paid
        })
        .eq('stripe_customer_id', customerId);
      return;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

      // Map Stripe's status → ours.
      const status = mapStripeStatus(sub.status);
      await supabaseAdmin
        .from('properties')
        .update({
          subscription_status: status,
          stripe_subscription_id: sub.id,
        })
        .eq('stripe_customer_id', customerId);
      return;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      await supabaseAdmin
        .from('properties')
        .update({ subscription_status: 'cancelled' })
        .eq('stripe_customer_id', customerId);
      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
      if (!customerId) return;
      await supabaseAdmin
        .from('properties')
        .update({ subscription_status: 'past_due' })
        .eq('stripe_customer_id', customerId);
      return;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
      if (!customerId) return;
      // Flip back to active in case they were past_due and just caught up.
      await supabaseAdmin
        .from('properties')
        .update({ subscription_status: 'active' })
        .eq('stripe_customer_id', customerId)
        .in('subscription_status', ['past_due', 'incomplete']);
      return;
    }

    default:
      // No-op for events we don't care about. Stripe sends a lot of
      // noise; we explicitly handle the small set above.
      return;
  }
}

function mapStripeStatus(s: Stripe.Subscription.Status): 'trial' | 'active' | 'past_due' | 'cancelled' | 'incomplete' {
  switch (s) {
    case 'active':              return 'active';
    case 'trialing':            return 'trial';
    case 'past_due':            return 'past_due';
    case 'canceled':            return 'cancelled';
    case 'unpaid':              return 'past_due';
    case 'incomplete':          return 'incomplete';
    case 'incomplete_expired':  return 'cancelled';
    case 'paused':              return 'past_due';
    default:                    return 'incomplete';
  }
}
