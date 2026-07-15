import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeVerifiedJwtSessionId,
  derivePhonePairingChallengeToken,
  derivePhonePairingCompletionToken,
  derivePhonePairingDeviceToken,
  digestPhonePairingOtp,
  generatePhonePairingToken,
  hashPhonePairingToken,
  isPhonePairingCode,
  isPhonePairingToken,
  resolvePhonePairingStatus,
} from '@/lib/phone-pairing';
import { renderPhonePairingCodeEmail } from '@/lib/email/phone-pairing-code';

describe('phone pairing capabilities', () => {
  test('generates independent 256-bit hex tokens and persists only a digest', () => {
    const first = generatePhonePairingToken();
    const second = generatePhonePairingToken();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notEqual(first, second);
    assert.equal(isPhonePairingToken(first), true);
    assert.match(hashPhonePairingToken(first), /^[0-9a-f]{64}$/);
    assert.notEqual(hashPhonePairingToken(first), first);
  });

  test('OTP digest is bound to both code and raw challenge capability', () => {
    const challenge = 'a'.repeat(64);
    const otherChallenge = 'b'.repeat(64);
    const digest = digestPhonePairingOtp(challenge, '123456');
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, digestPhonePairingOtp(challenge, '123456'));
    assert.notEqual(digest, digestPhonePairingOtp(otherChallenge, '123456'));
    assert.notEqual(digest, digestPhonePairingOtp(challenge, '123457'));
  });

  test('derives stable, domain-separated retry and device capabilities', () => {
    const pairing = '0'.repeat(64);
    const challenge = 'a'.repeat(64);
    const derivedChallenge = derivePhonePairingChallengeToken(
      pairing,
      'server-secret-one',
    );
    const completion = derivePhonePairingCompletionToken(challenge, '123456');
    const repeated = derivePhonePairingCompletionToken(challenge, '123456');
    const device = derivePhonePairingDeviceToken(completion, 'server-secret-one');

    assert.match(derivedChallenge, /^[0-9a-f]{64}$/);
    assert.equal(
      derivePhonePairingChallengeToken(pairing, 'server-secret-one'),
      derivedChallenge,
    );
    assert.notEqual(
      derivePhonePairingChallengeToken(pairing, 'server-secret-two'),
      derivedChallenge,
    );
    assert.match(completion, /^[0-9a-f]{64}$/);
    assert.equal(repeated, completion);
    assert.notEqual(
      derivePhonePairingCompletionToken(challenge, '123457'),
      completion,
    );
    assert.notEqual(completion, digestPhonePairingOtp(challenge, '123456'));
    assert.match(device, /^[0-9a-f]{64}$/);
    assert.equal(
      derivePhonePairingDeviceToken(completion, 'server-secret-one'),
      device,
    );
    assert.notEqual(
      derivePhonePairingDeviceToken(completion, 'server-secret-two'),
      device,
      'browser-visible completion material is insufficient without server key',
    );
    assert.notEqual(device, completion);
  });

  test('accepts only exact 6-digit codes and 32-byte tokens', () => {
    assert.equal(isPhonePairingCode('000001'), true);
    assert.equal(isPhonePairingCode('12345'), false);
    assert.equal(isPhonePairingCode('1234567'), false);
    assert.equal(isPhonePairingCode('12345a'), false);
    assert.equal(isPhonePairingToken('a'.repeat(64)), true);
    assert.equal(isPhonePairingToken('a'.repeat(63)), false);
  });
});

describe('phone pairing status contract', () => {
  const future = '2030-01-01T00:01:00.000Z';
  const base = {
    pair_expires_at: future,
    challenge_expires_at: null,
    completion_expires_at: null,
    claimed_at: null,
    otp_verified_at: null,
    completed_at: null,
    revoked_at: null,
  };

  test('maps internal state to the shared desktop status values', () => {
    const now = new Date('2030-01-01T00:00:00.000Z').getTime();
    assert.equal(resolvePhonePairingStatus(base, now).status, 'pending');
    assert.equal(resolvePhonePairingStatus({
      ...base,
      claimed_at: '2030-01-01T00:00:01.000Z',
      challenge_expires_at: future,
    }, now).status, 'code_sent');
    assert.equal(resolvePhonePairingStatus({
      ...base,
      claimed_at: '2030-01-01T00:00:01.000Z',
      challenge_expires_at: future,
      otp_verified_at: '2030-01-01T00:00:02.000Z',
      completion_expires_at: future,
    }, now).status, 'verified');
    assert.equal(resolvePhonePairingStatus({
      ...base,
      completed_at: '2030-01-01T00:00:03.000Z',
    }, now).status, 'completed');
  });

  test('expired/revoked state wins before incomplete status', () => {
    const after = new Date('2030-01-01T00:02:00.000Z').getTime();
    assert.equal(resolvePhonePairingStatus(base, after).status, 'expired');
    assert.equal(resolvePhonePairingStatus({ ...base, revoked_at: '2029-12-31T23:59:00.000Z' }, 0).status, 'expired');
  });
});

describe('verified JWT session binding', () => {
  test('reads a UUID session_id and rejects malformed/missing claims', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ session_id: sessionId })}.signature`;
    assert.equal(decodeVerifiedJwtSessionId(token), sessionId);
    assert.equal(decodeVerifiedJwtSessionId('not-a-jwt'), null);
    assert.equal(
      decodeVerifiedJwtSessionId(`${encode({ alg: 'none' })}.${encode({})}.signature`),
      null,
    );
  });
});

describe('phone pairing email', () => {
  test('renders the one-time code and 60-second warning', () => {
    const rendered = renderPhonePairingCodeEmail('123456');
    assert.match(rendered.subject, /Staxis phone sign-in code/);
    assert.match(rendered.text, /123456/);
    assert.match(rendered.text, /60 seconds/);
    assert.match(rendered.html, /123456/);
  });

  test('escapes unexpected HTML in the template input', () => {
    const rendered = renderPhonePairingCodeEmail('<script>');
    assert.doesNotMatch(rendered.html, /<script>/);
    assert.match(rendered.html, /&lt;script&gt;/);
  });
});
