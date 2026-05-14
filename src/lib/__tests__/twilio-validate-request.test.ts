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
 *   The 2026-05-13 three-reviewer pass flagged that the initial version
 *   of this test only guarded the trivial signature path — it skipped
 *   the SDK's array-param handling, URL port canonicalization, legacy
 *   querystring encoding, and the Buffer.from(..., 'utf-8') encoding
 *   used inside the HMAC update. Those are the exact shapes Twilio's
 *   webhook signer ACTUALLY produces in the wild. This expanded matrix
 *   re-implements every step of toFormUrlEncodedParam +
 *   getExpectedTwilioSignature from node_modules/twilio/lib/webhooks/
 *   webhooks.js byte-for-byte, then asserts the SDK accepts what we
 *   signed.
 *
 *   If the SDK ever drifts from this re-implementation, the test fails
 *   loudly. If the test ever drifts from the SDK, the SAME test fails
 *   loudly (because we generate via our helper but verify via the SDK).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import twilio from 'twilio';

const FIXED_AUTH_TOKEN = '12345';

/**
 * Byte-for-byte port of toFormUrlEncodedParam from
 * node_modules/twilio/lib/webhooks/webhooks.js (lines ~70-85 in v6).
 *
 * Important behaviors this preserves:
 *  - Arrays are de-duplicated, sorted, and EACH element is concatenated
 *    as `paramName + value` (NOT `paramName=value1&paramName=value2` —
 *    Twilio's algorithm has no separators at all).
 *  - Scalars are concatenated as `paramName + value` with no separator,
 *    no URL-encoding, no quoting.
 *
 * Note: a scalar value of type `number` or `boolean` gets toString()'d
 * implicitly via `+` concatenation, matching the SDK's untyped JS impl.
 */
type ParamValue = string | string[];
function toFormUrlEncodedParam(paramName: string, paramValue: ParamValue): string {
  if (Array.isArray(paramValue)) {
    return Array.from(new Set(paramValue))
      .sort()
      .map((val) => toFormUrlEncodedParam(paramName, val))
      .reduce((acc, val) => acc + val, '');
  }
  return paramName + paramValue;
}

/**
 * Byte-for-byte port of getExpectedTwilioSignature from
 * node_modules/twilio/lib/webhooks/webhooks.js (lines ~95-105 in v6).
 *
 * Critically uses Buffer.from(data, 'utf-8') for the .update() so
 * Unicode payloads hash identically to what Twilio's backend produces.
 */
function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, ParamValue>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + toFormUrlEncodedParam(key, params[key]), url);
  return createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
}

// ── Test matrix ────────────────────────────────────────────────────────
// Each row asserts that twilio.validateRequest accepts a signature we
// computed via the byte-for-byte SDK reimplementation above. The SDK's
// validateRequest internally tries 4 URL variants (with/without port,
// with/without legacy querystring), so any of our sign-URLs that match
// one of those variants is accepted.

test('validateRequest: simple ASCII scalar params on a plain HTTPS URL', () => {
  const url = 'https://example.com/api/sms-reply';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    From: '+14158675309',
    To: '+18005551212',
    Body: 'Yes',
  };
  const sig = computeTwilioSignature(FIXED_AUTH_TOKEN, url, params);
  assert.equal(twilio.validateRequest(FIXED_AUTH_TOKEN, sig, url, params), true);
});

test('validateRequest: garbage signature is rejected', () => {
  const url = 'https://example.com/api/sms-reply';
  const params = { Body: 'Yes' };
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, 'this-is-not-real-base64==', url, params),
    false,
    'validateRequest accepted a garbage signature — possible fail-open regression',
  );
});

test('validateRequest: tampered param after signing is rejected', () => {
  const url = 'https://example.com/api/sms-reply';
  const params = { Body: 'Yes', From: '+14158675309' };
  const sig = computeTwilioSignature(FIXED_AUTH_TOKEN, url, params);
  const tampered = { ...params, Body: 'No' };
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sig, url, tampered),
    false,
    'validateRequest accepted a signature against tampered params — canonicalization may have changed',
  );
});

test('validateRequest: URL with explicit standard port :443 (SDK strips it via removePort)', () => {
  // We sign against the URL WITHOUT the port (which is what removePort
  // produces). validateRequest tries both with-port and without-port,
  // so it should accept this.
  const urlWithoutPort = 'https://example.com/api/sms-reply';
  const urlWithPort = 'https://example.com:443/api/sms-reply';
  const params = { Body: 'Yes', From: '+14158675309' };
  const sigForNoPort = computeTwilioSignature(FIXED_AUTH_TOKEN, urlWithoutPort, params);
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sigForNoPort, urlWithPort, params),
    true,
    'validateRequest rejected a no-port signature when the URL had :443 — removePort logic may have regressed',
  );
});

test('validateRequest: URL with explicit :443 port (sign WITH port, SDK should still accept)', () => {
  const urlWithPort = 'https://example.com:443/api/sms-reply';
  const params = { Body: 'Yes' };
  // computeTwilioSignature uses the URL string as-is, so signing the
  // with-port URL produces what addPort would produce in the SDK.
  const sigWithPort = computeTwilioSignature(FIXED_AUTH_TOKEN, urlWithPort, params);
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sigWithPort, urlWithPort, params),
    true,
    'validateRequest rejected an addPort-shaped signature — SDK fallback chain may have regressed',
  );
});

test('validateRequest: Unicode in param values (Buffer.from utf-8 path)', () => {
  // 🏠 is U+1F3E0 — a 4-byte UTF-8 sequence. If the SDK ever stops
  // using Buffer.from(..., 'utf-8') for the HMAC update, this test
  // will diverge because the byte-length will differ.
  const url = 'https://example.com/api/sms-reply';
  const params = {
    Body: 'Tomorrow checkout 🏠',
    From: '+14158675309',
  };
  const sig = computeTwilioSignature(FIXED_AUTH_TOKEN, url, params);
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sig, url, params),
    true,
    'validateRequest rejected a Unicode-containing signature — UTF-8 encoding pathway broke',
  );
});

test('validateRequest: param value containing special chars after form decode', () => {
  // After Twilio form-decodes the inbound POST body, a Body field like
  // "Yes & no = maybe" arrives as a raw string with literal & and =.
  // The SDK's toFormUrlEncodedParam does NO encoding — it concatenates
  // verbatim. If that ever changed, this test catches it.
  const url = 'https://example.com/api/sms-reply';
  const params = {
    Body: 'Yes & no = maybe',
    From: '+14158675309',
  };
  const sig = computeTwilioSignature(FIXED_AUTH_TOKEN, url, params);
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sig, url, params),
    true,
    'validateRequest rejected a signature with literal &= in a param value — encoding regression',
  );
});

test('validateRequest: array-valued param is deduplicated and sorted', () => {
  // Twilio webhooks can send the same field multiple times in the
  // form body (e.g., MediaUrl0=foo&MediaUrl0=bar shows up as
  // params.MediaUrl0 = ['foo', 'bar']). toFormUrlEncodedParam does
  // Array.from(new Set(value)).sort() and concatenates each element.
  // If that algorithm changes, this test catches it.
  const url = 'https://example.com/api/sms-reply';
  const params: Record<string, ParamValue> = {
    Body: 'Yes',
    MediaUrl: ['https://example.com/b.jpg', 'https://example.com/a.jpg', 'https://example.com/a.jpg'],
  };
  const sig = computeTwilioSignature(FIXED_AUTH_TOKEN, url, params);
  // SDK accepts plain string OR string[]. We pass through.
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sig, url, params as Record<string, string>),
    true,
    'validateRequest rejected an array-param signature — Set/sort dedup logic may have regressed',
  );
});

test('validateRequest: URL with query string (legacy querystring path)', () => {
  // The SDK's validateRequest also tries the URL with the query string
  // re-encoded through Node's legacy querystring module. Sign the URL
  // verbatim and the SDK should accept it via one of its 4 variants.
  const url = 'https://example.com/api/sms-reply?source=twilio&v=1';
  const params = { Body: 'Yes', From: '+14158675309' };
  const sig = computeTwilioSignature(FIXED_AUTH_TOKEN, url, params);
  assert.equal(
    twilio.validateRequest(FIXED_AUTH_TOKEN, sig, url, params),
    true,
    'validateRequest rejected a signature against a query-string URL — querystring canonicalization regression',
  );
});
