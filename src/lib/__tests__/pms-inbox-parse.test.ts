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
  extractLinks,
  parseAuthResults,
  selectTrustedAuthResults,
  authservIdOf,
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
  // The inbox moved to the apex (Choice's Okta form rejects subdomained emails).
  const D = 'getstaxis.com';
  test('lowercases and accepts the apex inbox domain', () => {
    assert.equal(normalizeRecipient('TXA32@GetStaxis.com', D), 'txa32@getstaxis.com');
  });
  test('strips plus-addressing', () => {
    assert.equal(normalizeRecipient('txa32+anything@getstaxis.com', D), 'txa32@getstaxis.com');
  });
  test('extracts from a Name <addr> form', () => {
    assert.equal(normalizeRecipient('Staxis AI <txa32@getstaxis.com>', D), 'txa32@getstaxis.com');
  });
  test('rejects the retired subdomain, other domains, and malformed input', () => {
    // The old pms.getstaxis.com scheme no longer resolves.
    assert.equal(normalizeRecipient('txa32@pms.getstaxis.com', D), null);
    assert.equal(normalizeRecipient('txa32@evil.com', D), null);
    assert.equal(normalizeRecipient('txa32@notgetstaxis.com', D), null);
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
  test('does NOT truncate a 7- or 8-digit code to its first 6', () => {
    assert.equal(extractOtpCode({ text: 'Your verification code is 1234567' }), '1234567');
    assert.equal(extractOtpCode({ text: 'Your verification code is 12345678.' }), '12345678');
  });
  test('does not mistake a phone-style 3-4 split for a code', () => {
    assert.equal(extractOtpCode({ text: 'Call us at your code line 555-1234 for help.' }), null);
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

describe('Authentication-Results selection + parsing (anti-forgery)', () => {
  const CF = 'mx2.cloudflare.net; dkim=pass header.d=okta.com header.s=s1; spf=pass smtp.mailfrom=okta.com; dmarc=pass header.from=okta.com';
  const ATTACKER = 'attacker-mx.evil.com; dkim=pass header.d=choicehotels.com; spf=pass; dmarc=pass header.from=choicehotels.com';
  const SPOOFED_CF = 'mx.cloudflare.net; dkim=pass header.d=evil.com; dmarc=pass header.from=okta.com';
  const TRUST = ['cloudflare.net'];

  test('authservIdOf extracts the id before the first ;', () => {
    assert.equal(authservIdOf(CF), 'mx2.cloudflare.net');
    assert.equal(authservIdOf(ATTACKER), 'attacker-mx.evil.com');
  });

  test('parseAuthResults reads the verdict + verified signing domain', () => {
    assert.deepEqual(parseAuthResults(CF), { dkim: 'pass', spf: 'pass', dmarc: 'pass', dkimDomain: 'okta.com' });
  });

  test('selects Cloudflare’s header and ignores an attacker’s (order-independent)', () => {
    // Attacker header placed FIRST (postal-mime reverses headers — must not matter).
    assert.equal(selectTrustedAuthResults([ATTACKER, CF], TRUST), CF);
    assert.equal(selectTrustedAuthResults([CF, ATTACKER], TRUST), CF);
  });

  test('REFUSES when a header spoofs the trusted authserv-id (two matches → null)', () => {
    // Real Cloudflare AR + an injected one claiming a *.cloudflare.net authserv-id.
    assert.equal(selectTrustedAuthResults([SPOOFED_CF, CF], TRUST), null);
    assert.equal(selectTrustedAuthResults([CF, SPOOFED_CF], TRUST), null);
  });

  test('returns null when no trusted header is present', () => {
    assert.equal(selectTrustedAuthResults([ATTACKER], TRUST), null);
    assert.equal(selectTrustedAuthResults([], TRUST), null);
  });

  test('end-to-end: a forged-verdict message yields NO authentic verdict', () => {
    // Simulates the Worker: only the trusted header is parsed; the attacker's
    // forged dkim=pass for choicehotels.com never reaches the verdict.
    const selected = selectTrustedAuthResults([ATTACKER], TRUST); // attacker only, no real CF header
    const verdict = parseAuthResults(selected); // all-null
    const result = verifyInboundAuthenticity(
      { from: 'noreply@choicehotels.com', ...verdict },
      ['okta.com'],
    );
    assert.equal(result.ok, false); // sender not allowlisted AND no verdict — rejected
  });
});

describe('extractLinks (admin viewer XSS gate)', () => {
  test('extracts an http(s) anchor with its label', () => {
    const links = extractLinks(
      '<p>Welcome — <a href="https://choicehotels.okta.com/activate?token=abc">Set your password</a> now.</p>',
      null,
    );
    assert.deepEqual(links, [
      { href: 'https://choicehotels.okta.com/activate?token=abc', label: 'Set your password' },
    ]);
  });

  test('extracts a bare URL from plain text (label falls back to href)', () => {
    const links = extractLinks(null, 'Activate here: https://okta.com/welcome/xyz');
    assert.deepEqual(links, [
      { href: 'https://okta.com/welcome/xyz', label: 'https://okta.com/welcome/xyz' },
    ]);
  });

  test('REJECTS javascript:/data:/vbscript:/file:/mailto:/tel:/relative/protocol-relative hrefs', () => {
    const html = [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="data:text/html,<script>alert(1)</script>">y</a>',
      '<a href="vbscript:msgbox(1)">z</a>',
      '<a href="file:///etc/passwd">f</a>',
      '<a href="mailto:a@b.com">m</a>',
      '<a href="tel:+15551234">t</a>',
      '<a href="/activate">rel</a>',
      '<a href="//evil.com/x">protocol-rel</a>',
    ].join('');
    assert.deepEqual(extractLinks(html, null), []);
  });

  test('decodes &amp; in an href query string', () => {
    const links = extractLinks('<a href="https://okta.com/a?x=1&amp;y=2">go</a>', null);
    assert.equal(links[0].href, 'https://okta.com/a?x=1&y=2');
  });

  test('dedups identical hrefs across html and text', () => {
    const links = extractLinks(
      '<a href="https://okta.com/setup">Set up</a>',
      'Or paste: https://okta.com/setup',
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://okta.com/setup');
  });

  test('strips nested tags from the anchor label', () => {
    const links = extractLinks('<a href="https://okta.com/go"><b>Click</b> here</a>', null);
    assert.deepEqual(links, [{ href: 'https://okta.com/go', label: 'Click here' }]);
  });

  test('trims trailing sentence punctuation off a bare URL', () => {
    const links = extractLinks(null, 'Visit https://okta.com/done. Thanks!');
    assert.equal(links[0].href, 'https://okta.com/done');
  });

  test('returns [] for empty / no-link input', () => {
    assert.deepEqual(extractLinks(null, null), []);
    assert.deepEqual(extractLinks('', ''), []);
    assert.deepEqual(extractLinks('<p>no links here</p>', 'just text'), []);
  });

  test('handles an over-long href safely (anchor dropped; bare-text URL truncated)', () => {
    const huge = 'https://okta.com/' + 'a'.repeat(5000); // > 2048 chars
    // HTML anchor: the bounded capture means an absurd href isn't extracted at
    // all (a truncated URL would be a broken link anyway). Real setup links are
    // a few hundred chars — far under the bound.
    assert.deepEqual(extractLinks(`<a href="${huge}">x</a>`, null), []);
    // Bare URL in text: matched then capped to MAX_HREF_LEN (still a valid URL).
    const fromText = extractLinks(null, `Visit ${huge}`);
    assert.equal(fromText.length, 1);
    assert.ok(fromText[0].href.length <= 2048);
  });

  test('strips control chars (CR/LF/tab) from an href', () => {
    // A split URL must not survive into the viewer as a clickable link.
    const links = extractLinks('<a href="https://okta.com/a\r\n\tb">x</a>', null);
    assert.deepEqual(links, [{ href: 'https://okta.com/ab', label: 'x' }]);
  });

  test('is not ReDoS-able on a hostile <a>-spam body (stays fast + bounded)', () => {
    // Pre-fix this regex was O(n^2): 120 KB took ~2 s. Bounded quantifiers +
    // MAX_SCAN_LEN keep it linear. Generous 1 s ceiling (real time ~ a few ms).
    const hostile = '<a '.repeat(50_000); // ~150 KB of unterminated anchors
    const start = Date.now();
    const links = extractLinks(hostile, null);
    const ms = Date.now() - start;
    assert.deepEqual(links, []); // no valid links
    assert.ok(ms < 1000, `extractLinks took ${ms}ms — possible ReDoS regression`);
  });
});
