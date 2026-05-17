/**
 * Behavior tests for verifyWebhookSignature in src/lib/stripe.ts.
 *
 * Why this exists:
 *   Every Stripe webhook delivery — checkout.session.completed,
 *   customer.subscription.updated/deleted, invoice.payment_* — passes
 *   through this single function. If it silently fails-open, an attacker
 *   who guesses an event_id can post forged subscription events at our
 *   /api/stripe/webhook endpoint and manipulate property subscription
 *   state (cancel paying customers, grant free indefinite access, etc.).
 *
 *   The function is a thin wrapper around stripe.webhooks.constructEvent,
 *   so the load-bearing assertions are:
 *     1. Valid HMAC-SHA256 signature with the configured secret → ok:true
 *     2. Tampered body / signature / wrong secret → ok:false
 *     3. Missing webhook secret → ok:false (NOT thrown — must keep route alive)
 *
 * These tests use dynamic import so we can set STRIPE_* env vars BEFORE
 * the module reads them at import time. (The module captures the env into
 * a module-level constant; without dynamic import we'd be stuck with
 * whatever CI sets, which is nothing.)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PUBLIC_TEST_KEY = `sk${'_'}test${'_'}4eC39HqLyjWDarjtT1zdp7dc`;
const TEST_WEBHOOK_SECRET = 'whsec_test_unit_only_not_a_real_secret';

/**
 * Build a Stripe-formatted signature header for a given body + secret.
 * Mirrors Stripe's documented algorithm:
 *   signed_payload = `${timestamp}.${rawBody}`
 *   v1 = hex(hmacSHA256(secret, signed_payload))
 *   header = `t=${timestamp},v1=${v1}`
 *
 * Reproducing the algorithm in the test (rather than calling
 * stripe.webhooks.generateTestHeaderString) keeps the assertion
 * independent of the SDK helper — if the SDK ever changes either side,
 * a real-world signature mismatch shows up here.
 */
function signStripePayload(rawBody: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${rawBody}`;
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${ts},v1=${v1}`;
}

const SAMPLE_EVENT = JSON.stringify({
  id: 'evt_test_unit_only',
  object: 'event',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_test', status: 'active' } },
  livemode: false,
  pending_webhooks: 0,
  request: { id: null, idempotency_key: null },
  api_version: '2025-04-30.basil',
  created: Math.floor(Date.now() / 1000),
});

describe('verifyWebhookSignature — happy path + tamper detection', () => {
  test('valid signature with configured secret → ok:true with parsed event', async () => {
    process.env.STRIPE_SECRET_KEY = PUBLIC_TEST_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    // Dynamic import AFTER env is set; module captures env into module-level
    // constants at first import.
    const { verifyWebhookSignature } = await import('@/lib/stripe');

    const sig = signStripePayload(SAMPLE_EVENT, TEST_WEBHOOK_SECRET);
    const result = verifyWebhookSignature(SAMPLE_EVENT, sig);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.event.id, 'evt_test_unit_only');
      assert.equal(result.event.type, 'customer.subscription.updated');
    }
  });

  test('tampered body → ok:false (attacker swaps event payload)', async () => {
    const { verifyWebhookSignature } = await import('@/lib/stripe');

    // Sign one body, send a different body. Classic webhook-forgery attempt.
    const realSig = signStripePayload(SAMPLE_EVENT, TEST_WEBHOOK_SECRET);
    const tamperedBody = SAMPLE_EVENT.replace('"active"', '"canceled"');
    const result = verifyWebhookSignature(tamperedBody, realSig);

    assert.equal(result.ok, false);
    if (!result.ok && 'error' in result) {
      assert.match(result.error, /signature/i);
    }
  });

  test('signature signed with wrong secret → ok:false', async () => {
    const { verifyWebhookSignature } = await import('@/lib/stripe');

    const attackerSig = signStripePayload(SAMPLE_EVENT, 'whsec_wrong_secret');
    const result = verifyWebhookSignature(SAMPLE_EVENT, attackerSig);

    assert.equal(result.ok, false);
  });

  test('malformed signature header → ok:false (does not throw)', async () => {
    const { verifyWebhookSignature } = await import('@/lib/stripe');

    const result = verifyWebhookSignature(SAMPLE_EVENT, 'not-a-real-stripe-sig-header');

    // Must return a result, never throw — the route's outer catch is the
    // safety net but we want the function itself to handle it cleanly.
    assert.equal(result.ok, false);
  });

  test('empty signature header → ok:false', async () => {
    const { verifyWebhookSignature } = await import('@/lib/stripe');

    const result = verifyWebhookSignature(SAMPLE_EVENT, '');
    assert.equal(result.ok, false);
  });

  test('timestamp tolerance is enforced (very-old signature → ok:false)', async () => {
    const { verifyWebhookSignature } = await import('@/lib/stripe');

    // Stripe SDK rejects signatures older than its tolerance window
    // (default 5 minutes). 1 hour ago must be rejected. Replay-attack
    // protection.
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const staleSig = signStripePayload(SAMPLE_EVENT, TEST_WEBHOOK_SECRET, oneHourAgo);
    const result = verifyWebhookSignature(SAMPLE_EVENT, staleSig);

    assert.equal(result.ok, false);
    if (!result.ok && 'error' in result) {
      assert.match(result.error, /timestamp|tolerance/i);
    }
  });
});
