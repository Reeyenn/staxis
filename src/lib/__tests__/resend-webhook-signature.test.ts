/**
 * Tests for src/lib/resend-webhook-signature.ts — Svix-style signature
 * verification for the /api/resend-webhook endpoint.
 *
 * Comms-voice audit follow-up (2026-05-22). The webhook accepts bounce
 * and complaint events from Resend; an unsigned POST could plant fake
 * "bounced" events in our audit feed and Sentry. These tests pin the
 * verification math + replay-window check so a refactor can't silently
 * downgrade either.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  verifySvixSignature,
  buildSvixSignature,
  SIGNATURE_TOLERANCE_SECONDS,
} from '@/lib/resend-webhook-signature';

// Build a valid base64-decodable secret. The bytes don't matter for the
// math; we use the same secret throughout so generated and verified
// signatures match.
const SECRET_BYTES = Buffer.from('this-is-32-bytes-of-secret-mat__', 'utf8');
const SECRET = 'whsec_' + SECRET_BYTES.toString('base64');

function makeSignedRequest(body: string, opts?: {
  id?: string;
  tsOffsetSec?: number;
  secret?: string;
}) {
  const id = opts?.id ?? 'msg_test_01';
  const tsOffset = opts?.tsOffsetSec ?? 0;
  const timestamp = String(Math.floor(Date.now() / 1000) + tsOffset);
  const sig = buildSvixSignature(body, id, timestamp, opts?.secret ?? SECRET);
  return { id, timestamp, sig };
}

describe('verifySvixSignature — happy path', () => {
  test('valid signature with matching body verifies', () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } });
    const { id, timestamp, sig } = makeSignedRequest(body);
    const result = verifySvixSignature(body, id, timestamp, sig, SECRET);
    assert.equal(result.ok, true);
  });

  test('signature header with multiple v1 tokens accepts any matching one', () => {
    const body = '{}';
    const { id, timestamp, sig } = makeSignedRequest(body);
    const header = `v1,abc${sig.slice(3)} ${sig} v1,xyz${sig.slice(3)}`;
    const result = verifySvixSignature(body, id, timestamp, header, SECRET);
    assert.equal(result.ok, true);
  });

  test('whsec_ prefix is stripped before base64 decode', () => {
    const body = '{}';
    const { id, timestamp, sig } = makeSignedRequest(body);
    const result = verifySvixSignature(body, id, timestamp, sig, SECRET);
    assert.equal(result.ok, true);
  });

  test('secret WITHOUT whsec_ prefix still works (pure base64)', () => {
    const body = '{}';
    const bareSecret = SECRET.slice(6);  // strip whsec_
    const { id, timestamp, sig } = makeSignedRequest(body, { secret: bareSecret });
    const result = verifySvixSignature(body, id, timestamp, sig, bareSecret);
    assert.equal(result.ok, true);
  });
});

describe('verifySvixSignature — rejections', () => {
  test('missing svix-id header rejects', () => {
    const result = verifySvixSignature('{}', null, '1700000000', 'v1,abc', SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_svix_headers');
  });

  test('missing svix-timestamp header rejects', () => {
    const result = verifySvixSignature('{}', 'msg_1', null, 'v1,abc', SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_svix_headers');
  });

  test('missing svix-signature header rejects', () => {
    const result = verifySvixSignature('{}', 'msg_1', '1700000000', null, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_svix_headers');
  });

  test('non-numeric timestamp rejects', () => {
    const result = verifySvixSignature('{}', 'msg_1', 'not-a-number', 'v1,abc', SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_timestamp');
  });

  test('signature mismatch rejects with explicit reason', () => {
    const body = '{}';
    const ts = String(Math.floor(Date.now() / 1000));
    // Forge a valid-length signature with wrong content.
    const sig = buildSvixSignature(body, 'msg_real', ts, SECRET);
    // Use a DIFFERENT body for verification.
    const result = verifySvixSignature('{"different":true}', 'msg_real', ts, sig, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_mismatch');
  });

  test('signature signed with a different secret rejects', () => {
    const body = '{}';
    const ts = String(Math.floor(Date.now() / 1000));
    const otherSecret = 'whsec_' + Buffer.from('other-32-bytes-of-secret-bytes__', 'utf8').toString('base64');
    const sig = buildSvixSignature(body, 'msg_1', ts, otherSecret);
    const result = verifySvixSignature(body, 'msg_1', ts, sig, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_mismatch');
  });

  test('unsupported version (v2,...) rejects', () => {
    const body = '{}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = buildSvixSignature(body, 'msg_1', ts, SECRET);
    const v2Header = 'v2,' + sig.slice(3);  // valid-looking but wrong version
    const result = verifySvixSignature(body, 'msg_1', ts, v2Header, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_mismatch');
  });
});

describe('verifySvixSignature — replay protection', () => {
  test(`timestamp ${SIGNATURE_TOLERANCE_SECONDS + 60}s in the past rejects`, () => {
    const body = '{}';
    const oldTs = String(Math.floor(Date.now() / 1000) - SIGNATURE_TOLERANCE_SECONDS - 60);
    const sig = buildSvixSignature(body, 'msg_1', oldTs, SECRET);
    const result = verifySvixSignature(body, 'msg_1', oldTs, sig, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timestamp_out_of_tolerance');
  });

  test(`timestamp ${SIGNATURE_TOLERANCE_SECONDS + 60}s in the future rejects`, () => {
    const body = '{}';
    const futureTs = String(Math.floor(Date.now() / 1000) + SIGNATURE_TOLERANCE_SECONDS + 60);
    const sig = buildSvixSignature(body, 'msg_1', futureTs, SECRET);
    const result = verifySvixSignature(body, 'msg_1', futureTs, sig, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timestamp_out_of_tolerance');
  });

  test('timestamp exactly at tolerance boundary still accepts', () => {
    const body = '{}';
    // Test against a fixed nowMs so the small skew between buildSvixSignature
    // (uses Date.now() implicitly via the test timestamp string) and verify
    // doesn't push us over the line.
    const nowMs = 1_700_000_000_000;
    const boundaryTs = String(nowMs / 1000 - SIGNATURE_TOLERANCE_SECONDS);
    const sig = buildSvixSignature(body, 'msg_1', boundaryTs, SECRET);
    const result = verifySvixSignature(body, 'msg_1', boundaryTs, sig, SECRET, nowMs);
    assert.equal(result.ok, true);
  });

  test('a captured signature from an hour ago cannot be replayed', () => {
    // Simulate: attacker captures a valid POST 1 hour ago and replays it now.
    const body = '{"type":"email.bounced","data":{"to":["victim@example.com"]}}';
    const oneHourAgoSec = Math.floor(Date.now() / 1000) - 3600;
    const capturedTs = String(oneHourAgoSec);
    const capturedSig = buildSvixSignature(body, 'msg_captured', capturedTs, SECRET);
    // Replay now (verify uses current Date.now()).
    const result = verifySvixSignature(body, 'msg_captured', capturedTs, capturedSig, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timestamp_out_of_tolerance');
  });
});

describe('verifySvixSignature — body sensitivity (catches tampering)', () => {
  test('flipping a single byte in the body invalidates the signature', () => {
    const body = '{"type":"email.delivered","data":{"email_id":"e1"}}';
    const tampered = '{"type":"email.delivered","data":{"email_id":"e2"}}';
    const { id, timestamp, sig } = makeSignedRequest(body);
    const result = verifySvixSignature(tampered, id, timestamp, sig, SECRET);
    assert.equal(result.ok, false);
  });

  test('changing the svix-id invalidates the signature', () => {
    const body = '{}';
    const { timestamp, sig } = makeSignedRequest(body);
    const result = verifySvixSignature(body, 'different_id', timestamp, sig, SECRET);
    assert.equal(result.ok, false);
  });
});
