/**
 * Tests for the PMS auth-code inbox pure helpers (migration 0274).
 *
 * Covers the security-load-bearing behavior: authenticity rests on aligned
 * DKIM/DMARC (never the From string), code extraction is anchored + refuses
 * ambiguity + only matches ASCII digits, recipients are normalized, and the
 * Bearer compare is rotation-aware.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  constantTimeBearerMatch,
  verifyInboundAuthenticity,
  normalizeRecipient,
  parseEmailDomain,
  domainAllowed,
  extractOtpCode,
  maskCode,
} from '@/lib/pms-inbox/parse';

const ALLOW = ['okta.com', 'choicehotels.com'];

describe('constantTimeBearerMatch', () => {
  test('matches the current secret', () => {
    assert.equal(constantTimeBearerMatch('Bearer s3cret-value-very-long-1234567890', ['s3cret-value-very-long-1234567890']), true);
  });
  test('matches the rotation (next) secret too', () => {
    assert.equal(
      constantTimeBearerMatch('Bearer new-secret-1234567890123456789012', ['old-secret-1234567890123456789012', 'new-secret-1234567890123456789012']),
      true,
    );
  });
  test('rejects a wrong secret, empty header, and empty secret set', () => {
    assert.equal(constantTimeBearerMatch('Bearer nope', ['the-real-secret-1234567890123456']), false);
    assert.equal(constantTimeBearerMatch('', ['the-real-secret-1234567890123456']), false);
    assert.equal(constantTimeBearerMatch(null, ['the-real-secret-1234567890123456']), false);
    assert.equal(constantTimeBearerMatch('Bearer x', [undefined, null, '']), false);
  });
});

describe('parseEmailDomain / domainAllowed', () => {
  test('parses bare and angle-bracket forms', () => {
    assert.equal(parseEmailDomain('noreply@okta.com'), 'okta.com');
    assert.equal(parseEmailDomain('Okta <noreply@choicehotels.okta.com>'), 'choicehotels.okta.com');
    assert.equal(parseEmailDomain('garbage'), null);
  });
  test('subdomain of an allowlisted domain is allowed; lookalikes are not', () => {
    assert.equal(domainAllowed('okta.com', ALLOW), true);
    assert.equal(domainAllowed('choicehotels.okta.com', ALLOW), true);
    assert.equal(domainAllowed('okta.com.evil.com', ALLOW), false);
    assert.equal(domainAllowed('notokta.com', ALLOW), false);
    assert.equal(domainAllowed('evil.com', ALLOW), false);
  });
});

describe('verifyInboundAuthenticity', () => {
  test('DMARC=pass from an allowlisted domain passes', () => {
    const r = verifyInboundAuthenticity({ from: 'noreply@okta.com', dmarc: 'pass' }, ALLOW);
    assert.deepEqual(r, { ok: true, fromDomain: 'okta.com' });
  });
  test('DMARC=pass from an allowlisted SUBdomain passes', () => {
    const r = verifyInboundAuthenticity({ from: 'Okta <noreply@choicehotels.okta.com>', dmarc: 'pass' }, ALLOW);
    assert.equal(r.ok, true);
  });
  test('aligned DKIM pass (no DMARC) passes', () => {
    const r = verifyInboundAuthenticity({ from: 'a@okta.com', dkim: 'pass', dkimDomain: 'okta.com' }, ALLOW);
    assert.equal(r.ok, true);
  });
  test('SPOOFED From: okta.com with DKIM pass for attacker.com is REJECTED', () => {
    const r = verifyInboundAuthenticity({ from: 'noreply@okta.com', dkim: 'pass', dkimDomain: 'attacker.com', dmarc: 'fail' }, ALLOW);
    assert.deepEqual(r, { ok: false, reason: 'unauthenticated' });
  });
  test('From not on the allowlist is rejected even with DMARC pass', () => {
    const r = verifyInboundAuthenticity({ from: 'noreply@evil.com', dmarc: 'pass' }, ALLOW);
    assert.deepEqual(r, { ok: false, reason: 'sender_not_allowlisted' });
  });
  test('all-fail / no-verdict is rejected', () => {
    assert.equal(verifyInboundAuthenticity({ from: 'a@okta.com', dmarc: 'fail', dkim: 'fail' }, ALLOW).ok, false);
    assert.equal(verifyInboundAuthenticity({ from: 'a@okta.com' }, ALLOW).ok, false);
  });
  test('unparseable From is rejected', () => {
    assert.deepEqual(verifyInboundAuthenticity({ from: 'not-an-email' }, ALLOW), { ok: false, reason: 'unparseable_from' });
  });
});

describe('normalizeRecipient', () => {
  const D = 'pms.getstaxis.com';
  test('lowercases and accepts the inbox domain', () => {
    assert.equal(normalizeRecipient('TXA32@PMS.getstaxis.com', D), 'txa32@pms.getstaxis.com');
  });
  test('strips plus-addressing', () => {
    assert.equal(normalizeRecipient('txa32+anything@pms.getstaxis.com', D), 'txa32@pms.getstaxis.com');
  });
  test('extracts from a Name <addr> form', () => {
    assert.equal(normalizeRecipient('Staxis AI <txa32@pms.getstaxis.com>', D), 'txa32@pms.getstaxis.com');
  });
  test('rejects other domains and malformed input', () => {
    assert.equal(normalizeRecipient('txa32@getstaxis.com', D), null);
    assert.equal(normalizeRecipient('txa32@evil.com', D), null);
    assert.equal(normalizeRecipient('garbage', D), null);
    assert.equal(normalizeRecipient('', D), null);
  });
});

describe('extractOtpCode', () => {
  test('keyword-then-code (realistic Okta body)', () => {
    assert.equal(
      extractOtpCode({ text: 'Your ChoiceConnect verification code is: 928104. It expires in 5 minutes.' }),
      '928104',
    );
  });
  test('code-then-keyword (subject line)', () => {
    assert.equal(extractOtpCode({ subject: '928104 is your ChoiceConnect verification code' }), '928104');
  });
  test('3+3 split is joined', () => {
    assert.equal(extractOtpCode({ text: 'Enter the one-time passcode 482 913 to continue.' }), '482913');
  });
  test('ignores a year and a phone number near the code', () => {
    assert.equal(
      extractOtpCode({ text: 'Call 1-800-555-1234 or visit us. (c) 2026. Your security code is 736215.' }),
      '736215',
    );
  });
  test('pulls a standalone 6-digit code with no keyword (fallback)', () => {
    assert.equal(extractOtpCode({ subject: 'Staxis', text: '482913' }), '482913');
  });
  test('extracts from HTML when text is absent', () => {
    assert.equal(
      extractOtpCode({ html: '<html><body><p>Your verification code is <b>551984</b></p></body></html>' }),
      '551984',
    );
  });
  test('folds fullwidth digits to ASCII (NFKC)', () => {
    assert.equal(extractOtpCode({ text: 'Your verification code is １２３４５６.' }), '123456');
  });
  test('REFUSES when two different anchored codes appear (ambiguous)', () => {
    assert.equal(
      extractOtpCode({ text: 'Your verification code is 111111. Your security code is 222222.' }),
      null,
    );
  });
  test('REFUSES when two distinct standalone 6-digit runs appear (ambiguous fallback)', () => {
    assert.equal(extractOtpCode({ text: '111111 222222' }), null);
  });
  test('returns null when there is no code', () => {
    assert.equal(extractOtpCode({ subject: 'Welcome to ChoiceConnect', text: 'No code here, just a greeting.' }), null);
  });
  test('non-ASCII (Arabic-Indic) digits do not yield a wrong code', () => {
    // Arabic-Indic digits don't NFKC-fold to ASCII; better to return null than guess.
    assert.equal(extractOtpCode({ text: 'Your code is ١٢٣٤٥٦' }), null);
  });
});

describe('maskCode', () => {
  test('reveals only the last 2 digits', () => {
    assert.equal(maskCode('928104'), '••••04');
    assert.equal(maskCode('12'), '••');
  });
});
