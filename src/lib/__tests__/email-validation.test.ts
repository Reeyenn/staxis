/**
 * Tests for isValidEmail in src/lib/api-validate.ts.
 *
 * Comms-voice audit follow-up (2026-05-22). Replaces the original
 * `.includes('@')` gate with a pragmatic regex that catches the realistic
 * failure modes (typo'd `@`, missing TLD, embedded whitespace, header-
 * injection bytes) without rejecting legitimate plus-addressing or
 * hyphenated domains.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isValidEmail } from '@/lib/api-validate';

describe('isValidEmail — accepts realistic addresses', () => {
  test('plain address', () => {
    assert.equal(isValidEmail('alice@hotel.com'), true);
  });

  test('subdomain', () => {
    assert.equal(isValidEmail('alice@mail.hotel.com'), true);
  });

  test('plus-addressing', () => {
    assert.equal(isValidEmail('alice+staxis@hotel.com'), true);
  });

  test('hyphenated domain', () => {
    assert.equal(isValidEmail('alice@my-hotel.com'), true);
  });

  test('numeric local part', () => {
    assert.equal(isValidEmail('123@hotel.com'), true);
  });

  test('mixed case (case-insensitive)', () => {
    assert.equal(isValidEmail('Alice.Smith@Hotel.COM'), true);
  });

  test('long TLD', () => {
    assert.equal(isValidEmail('user@hotel.business'), true);
  });

  test('two-char TLD (country codes)', () => {
    assert.equal(isValidEmail('user@hotel.co'), true);
  });

  test('underscore in local part', () => {
    assert.equal(isValidEmail('first_last@hotel.com'), true);
  });
});

describe('isValidEmail — rejects obvious junk', () => {
  test('empty string', () => {
    assert.equal(isValidEmail(''), false);
  });

  test('missing @', () => {
    assert.equal(isValidEmail('alice.hotel.com'), false);
  });

  test('missing local part', () => {
    assert.equal(isValidEmail('@hotel.com'), false);
  });

  test('missing domain', () => {
    assert.equal(isValidEmail('alice@'), false);
  });

  test('missing TLD', () => {
    assert.equal(isValidEmail('alice@hotel'), false);
  });

  test('TLD too short', () => {
    assert.equal(isValidEmail('alice@hotel.c'), false);
  });

  test('double @', () => {
    assert.equal(isValidEmail('alice@@hotel.com'), false);
  });

  test('domain starts with hyphen', () => {
    assert.equal(isValidEmail('alice@-hotel.com'), false);
  });

  test('domain ends with hyphen', () => {
    assert.equal(isValidEmail('alice@hotel-.com'), false);
  });

  test('consecutive dots in domain', () => {
    assert.equal(isValidEmail('alice@hotel..com'), false);
  });
});

describe('isValidEmail — rejects header-injection bytes', () => {
  test('embedded \\r rejected', () => {
    assert.equal(isValidEmail('alice@hotel.com\rBcc: evil@x.com'), false);
  });

  test('embedded \\n rejected', () => {
    assert.equal(isValidEmail('alice@hotel.com\nBcc: evil@x.com'), false);
  });

  test('embedded \\0 rejected', () => {
    assert.equal(isValidEmail('alice@hotel.com\0null'), false);
  });

  test('leading whitespace rejected', () => {
    assert.equal(isValidEmail(' alice@hotel.com'), false);
  });

  test('trailing whitespace rejected', () => {
    assert.equal(isValidEmail('alice@hotel.com '), false);
  });

  test('whitespace inside local part rejected', () => {
    assert.equal(isValidEmail('alice smith@hotel.com'), false);
  });
});

describe('isValidEmail — type safety', () => {
  test('non-string rejected (null)', () => {
    assert.equal(isValidEmail(null), false);
  });

  test('non-string rejected (undefined)', () => {
    assert.equal(isValidEmail(undefined), false);
  });

  test('non-string rejected (number)', () => {
    assert.equal(isValidEmail(12345), false);
  });

  test('non-string rejected (object)', () => {
    assert.equal(isValidEmail({ email: 'alice@hotel.com' }), false);
  });
});

describe('isValidEmail — length cap', () => {
  test('ordinary realistic address accepted', () => {
    // DNS limits each label to 63 chars; build a multi-label domain that
    // fits comfortably under the 254-char total cap and exercises the
    // accepted path without poking the exact boundary.
    const local = 'a'.repeat(50);
    const domain = `${'b'.repeat(60)}.${'c'.repeat(60)}.com`;
    const email = `${local}@${domain}`;
    assert.ok(email.length < 254);
    assert.equal(isValidEmail(email), true);
  });

  test('absurdly long address (>254 chars) is rejected', () => {
    // 64 + @ + 4 labels of 63 + 3 dots + .com = way over 254.
    const local = 'a'.repeat(64);
    const labels = Array(5).fill('b'.repeat(63)).join('.');
    const email = `${local}@${labels}.com`;
    assert.ok(email.length > 254, `expected >254 chars, got ${email.length}`);
    assert.equal(isValidEmail(email), false);
  });
});
