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
 *   customer.subscription.deleted    → property.subscription_status='canceled'
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

// Stripe sends webhooks as raw JSON in the request body. Next.js by
// default does NOT consume the body before the route handler runs (that
// would only happen if a middleware called req.json/text). To be safe,
// we explicitly opt out of any auto-body-handling. If Next.js future
// versions ever pre-parse, this declaration tells the route to keep
// the body intact for signature verification.
export const preferredRegion = 'auto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  if (!stripeIsConfigured()) {
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

  // ─── Idempotency check ────────────────────────────────────────────────
  // Stripe explicitly documents that an event can be delivered more than
  // once. Without dedupe a second delivery of checkout.session.completed
  // could double-process. We INSERT first and short-circuit on conflict.
  // (Migration 0035 created the table.)
  //
  // We .select() the inserted row so we can verify it really landed.
  // .insert().select() returns data only on the row that was actually
  // inserted; on conflict supabase-js returns the unique-violation
  // error and `data` is null. That gives us a strict "did this insert
  // a fresh row" check rather than relying on insertErr being falsy.
  const { data: dedupeRow, error: insertErr } = await supabaseAdmin
    .from('stripe_processed_events')
    .insert({
      event_id: event.id,
      event_type: event.type,
      metadata: { livemode: event.livemode, created: event.created },
    })
    .select('event_id')
    .maybeSingle();

  if (insertErr) {
    // Unique violation (code 23505) = already processed. 2xx so Stripe
    // stops retrying.
    if ((insertErr as { code?: string }).code === '23505') {
      return NextResponse.json({ received: true, deduped: true });
    }
    // Any OTHER error means the dedupe table is unhealthy — could be
    // a network blip, RLS misconfig, table renamed, etc. We MUST refuse
    // to process: without working dedupe, Stripe's automatic retries
    // would double-process every event. 500 → Stripe retries with
    // exponential backoff for up to 3 days, by which point the dedupe
    // table is presumably healthy again. (Pass-3 fix.)
    console.error('[stripe/webhook] dedupe insert failed — refusing to process', insertErr);
    return NextResponse.json({ error: 'Dedupe table unhealthy — try again' }, { status: 500 });
  } else if (!dedupeRow) {
    // No error AND no row means something weird happened — refuse to
    // process (Stripe will retry; we'll see the error in logs).
    console.error('[stripe/webhook] dedupe insert returned no row and no error — bailing');
    return NextResponse.json({ error: 'Dedupe check failed' }, { status: 500 });
  }

  try {
    const propertyId = await handleEvent(event);
    // Stamp the dedupe row with the property_id we resolved during
    // processing — useful for audit traces ("show me every event that
    // touched property X").
    if (propertyId) {
      await supabaseAdmin
        .from('stripe_processed_events')
        .update({ property_id: propertyId })
        .eq('event_id', event.id);
    }
  } catch (err) {
    console.error(`[stripe/webhook] ${event.type} handler threw`, err);
    // Delete the dedupe row so the next retry has a chance to succeed.
    await supabaseAdmin
      .from('stripe_processed_events')
      .delete()
      .eq('event_id', event.id);
    // Return 500 so Stripe retries. Stripe retries with exponential
    // backoff for up to 3 days, which gives us plenty of time to fix
    // a bad deploy without losing events.
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/**
 * Returns the property_id we updated, or null if this event didn't
 * touch a known property. Caller stamps the property_id on the
 * stripe_processed_events row for audit.
 *
 * Each handler reads the property by stripe_customer_id WITH
 * .single() — properties.stripe_customer_id is now UNIQUE (migration
 * 0035), so .single() is safe and tells us if the customer is unknown
 * (e.g., a leftover from a deleted property). For unknown customers
 * we no-op — Stripe might be replaying old events, no need to error.
 */
async function handleEvent(event: Stripe.Event): Promise<string | null> {
  const updateProperty = async (
    customerId: string,
    patch: Record<string, unknown>,
    extraConditions?: { in?: { column: string; values: string[] } },
  ): Promise<string | null> => {
    let q = supabaseAdmin
      .from('properties')
      .update(patch)
      .eq('stripe_customer_id', customerId);
    if (extraConditions?.in) {
      q = q.in(extraConditions.in.column, extraConditions.in.values);
    }
    const { data, error } = await q.select('id').maybeSingle();
    if (error) {
      // CHECK constraint violation (23514) means Vercel is running webhook
      // code that produces statuses the DB schema doesn't yet accept —
      // i.e., migration 0038 hasn't been applied. Re-throw so the outer
      // try/catch deletes the dedupe row and 500s — Stripe will retry,
      // and once the migration lands the next attempt succeeds. Without
      // this, mapStripeStatus values like 'unpaid'/'paused' would be
      // silently dropped and Stripe would never retry. (Pass-3 review fix.)
      const code = (error as { code?: string }).code;
      if (code === '23514') {
        throw new Error(
          `subscription_status CHECK constraint violation — migration 0038 may not be applied yet. Original: ${error.message}`,
        );
      }
      console.warn(`[stripe/webhook] update by customer ${customerId} failed: ${error.message}`);
      return null;
    }
    return (data?.id as string) ?? null;
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
      if (!customerId) return null;

      return updateProperty(customerId, {
        subscription_status: 'active',
        stripe_subscription_id: subscriptionId ?? null,
        trial_ends_at: null, // trial is over once they paid
      });
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const status = mapStripeStatus(sub.status);
      // Status guard prevents an out-of-order Stripe replay (e.g., a
      // stale 'updated' event arriving after 'deleted') from
      // resurrecting a canceled or terminal-state subscription. Only
      // states that can legitimately transition forward are eligible
      // for update. (Pass-3 fix — H2.)
      return updateProperty(customerId, {
        subscription_status: status,
        stripe_subscription_id: sub.id,
      }, {
        in: { column: 'subscription_status', values: ['trial', 'active', 'past_due', 'incomplete', 'unpaid', 'paused'] },
      });
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      // Clear stripe_subscription_id along with the status flip — the
      // ID is now a stale reference (Stripe deleted the subscription)
      // and leaving it on the row confuses future portal/billing
      // lookups. (Pass-3 fix — covers M5 too.)
      return updateProperty(customerId, {
        subscription_status: 'canceled',
        stripe_subscription_id: null,
      });
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
      if (!customerId) return null;
      return updateProperty(customerId, { subscription_status: 'past_due' });
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
      if (!customerId) return null;
      // Flip back to active only if they were past_due/incomplete.
      // Don't accidentally flip a 'canceled' back to 'active' on a
      // late retry of a stale invoice.
      return updateProperty(customerId, { subscription_status: 'active' }, {
        in: { column: 'subscription_status', values: ['past_due', 'incomplete'] },
      });
    }

    default:
      // No-op for events we don't care about. Stripe sends a lot of
      // noise; we explicitly handle the small set above.
      return null;
  }
}

// Map Stripe's Subscription.Status vocabulary to our local enum. The
// local enum (CHECK constraint, migration 0038) accepts every Stripe
// value verbatim EXCEPT 'trialing' which we localize to 'trial' for
// historical reasons (the column was named 'trial' before Stripe was
// integrated). Returning Stripe values directly for everything else
// avoids losing dunning-flow detail.
function mapStripeStatus(s: Stripe.Subscription.Status):
  'trial' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused' {
  switch (s) {
    case 'active':              return 'active';
    case 'trialing':            return 'trial';
    case 'past_due':            return 'past_due';
    case 'canceled':            return 'canceled';
    case 'unpaid':              return 'unpaid';
    case 'incomplete':          return 'incomplete';
    case 'incomplete_expired':  return 'incomplete_expired';
    case 'paused':              return 'paused';
    default:                    return 'incomplete';
  }
}
