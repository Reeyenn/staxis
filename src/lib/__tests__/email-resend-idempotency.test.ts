/**
 * Tests for the Idempotency-Key derivation added in audit/concurrency #6.
 *
 * The deriveIdempotencyKey helper must:
 *   - Produce the same key for the same (to, subject, minute) triple — so
 *     a network-retried send within the same minute dedupes at Resend.
 *   - Produce a DIFFERENT key when minute, subject, or recipient changes
 *     — a legitimate "send the same email tomorrow" must NOT be swallowed
 *     by the dedup window.
 *   - Return a string of bounded length (32 chars) regardless of input
 *     length — Resend's header has a practical size limit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { __test_deriveIdempotencyKey } from '@/lib/email/resend';

describe('deriveIdempotencyKey — minute-bucketed Resend idempotency', () => {
  test('two calls within the same minute → same key', () => {
    const a = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Your invite',
      html: '<p>x</p>',
    });
    const b = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Your invite',
      html: '<p>x</p>',
    });
    assert.equal(a, b);
  });

  test('different recipient → different key', () => {
    const a = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Your invite',
      html: '<p>x</p>',
    });
    const b = __test_deriveIdempotencyKey({
      to: 'reeyen@example.com',
      subject: 'Your invite',
      html: '<p>x</p>',
    });
    assert.notEqual(a, b);
  });

  test('different subject → different key', () => {
    const a = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Welcome',
      html: '<p>x</p>',
    });
    const b = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Welcome to your hotel',
      html: '<p>x</p>',
    });
    assert.notEqual(a, b);
  });

  test('html body is NOT part of the key (only to + subject + minute)', () => {
    // We don't want a different image url / dynamic timestamp inside the
    // body to defeat dedup. Two sends of "the same email" with slightly
    // different HTML should dedupe.
    const a = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Your invite',
      html: '<p>Visit https://example.com/x</p>',
    });
    const b = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Your invite',
      html: '<p>Visit https://example.com/y</p>',
    });
    assert.equal(a, b);
  });

  test('plus-addressing collapses to the same key (matches rate-limit semantics)', () => {
    const a = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'Your invite',
      html: '',
    });
    const b = __test_deriveIdempotencyKey({
      to: 'maria+staxis@example.com',
      subject: 'Your invite',
      html: '',
    });
    assert.equal(a, b);
  });

  test('result is exactly 32 chars', () => {
    const k = __test_deriveIdempotencyKey({
      to: 'maria@example.com',
      subject: 'A'.repeat(500),
      html: '',
    });
    assert.equal(typeof k, 'string');
    assert.equal(k.length, 32);
    assert.match(k, /^[0-9a-f]+$/);
  });
});
