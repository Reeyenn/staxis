/**
 * Regression guard for twilio-node's validateRequest signature-verification
 * algorithm. Runs entirely in-memory — NO Twilio API call, NO SMS sent.
 * The whole point of validateRequest is to verify a request that already
 * arrived, so it's pure HMAC-SHA1 over a constructed string.
 *
 * Why this exists:
 *   /api/sms-reply/route.ts calls twilio.validateRequest(authToken,
 *   signature, url, params) on every inbound SMS to confirm Twilio
 *   actually sent it (and not an attacker spoofing a webhook). If a
 *   future twilio-node release changes the algorithm — different hash
 *   function, different param-encoding rule, different URL canonical-
 *   ization — every legitimate SMS reply would silently fail signature
 *   verification and return 403. Our customers would stop getting shift
 *   confirmations and we wouldn't know until someone complained.
 *
 *   This test locks the algorithm by computing the expected signature
 *   independently (using Node's crypto module directly) and asserting
 *   that the SDK accepts it. If they ever diverge, this test fails at
 *   PR time and we catch it before deploy.
 *
 * Algorithm reference: Twilio's documented signing scheme is
 *   base64(HMAC-SHA1(authToken, url + sorted(params).join('')))
 * where each param is concatenated as `key + value` (no separators).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import twilio from 'twilio';

// Fixed, fake credentials — not connected to any real Twilio account.
// authToken is the example value from Twilio's own webhook-validation
// docs. Using a known-public-example value makes it obvious this is
// not a real secret.
const FIXED_AUTH_TOKEN = '12345';
const FIXED_URL = 'https://example.com/api/sms-reply';
const FIXED_PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  From: '+14158675309',
  To: '+18005551212',
  Body: 'Yes',
};

/**
 * Compute Twilio's expected signature for (url, params) using the
 * documented HMAC-SHA1 algorithm. Independent reimplementation so the
 * test catches drift if the SDK's internal algorithm changes.
 */
function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  // Sort params alphabetically by key, then concatenate as key+value
  // with no separators. This is the canonical form Twilio signs over.
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.reduce(
    (acc, k) => acc + k + params[k],
    url,
  );
  return createHmac('sha1', authToken).update(concatenated).digest('base64');
}

test('twilio.validateRequest accepts a correctly-signed request', () => {
  const signature = computeTwilioSignature(FIXED_AUTH_TOKEN, FIXED_URL, FIXED_PARAMS);
  const ok = twilio.validateRequest(FIXED_AUTH_TOKEN, signature, FIXED_URL, FIXED_PARAMS);
  assert.equal(
    ok,
    true,
    'validateRequest rejected a signature we computed ourselves with the documented ' +
    'HMAC-SHA1 algorithm. Either the SDK changed its algorithm or our reimplementation ' +
    'drifted. Reconcile before shipping any SMS-pipeline change.',
  );
});

test('twilio.validateRequest rejects a garbage signature', () => {
  const ok = twilio.validateRequest(
    FIXED_AUTH_TOKEN,
    'this-is-not-a-real-signature-base64==',
    FIXED_URL,
    FIXED_PARAMS,
  );
  assert.equal(
    ok,
    false,
    'validateRequest accepted a signature it should not have accepted — a future SDK ' +
    'release may have introduced a fail-open path. Investigate immediately.',
  );
});

test('twilio.validateRequest rejects a request with a tampered param', () => {
  // Sign the original params, then ask validateRequest to verify with a
  // single byte flipped. Must be rejected — otherwise an attacker could
  // intercept a webhook, alter `From` or `Body`, and we'd still trust it.
  const signature = computeTwilioSignature(FIXED_AUTH_TOKEN, FIXED_URL, FIXED_PARAMS);
  const tampered = { ...FIXED_PARAMS, Body: 'No' };
  const ok = twilio.validateRequest(FIXED_AUTH_TOKEN, signature, FIXED_URL, tampered);
  assert.equal(
    ok,
    false,
    'validateRequest accepted a signature against tampered params — the SDK may have ' +
    'started ignoring some params during canonicalization. Verify by inspecting the ' +
    'param-encoding logic in node_modules/twilio/lib/webhooks/webhooks.js.',
  );
});
