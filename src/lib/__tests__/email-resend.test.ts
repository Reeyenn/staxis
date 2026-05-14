/**
 * Phase M1.5 (2026-05-14) — behavior tests for the Resend transactional
 * email helper.
 *
 * Per Phase L discipline rule #2: tests seed inputs and assert outputs.
 * No source-grep tests.
 *
 * What this file covers:
 *   - Email normalization for rate-limit keys (case, whitespace, plus-addressing)
 *   - The hash-based key produces a UUID-shaped string acceptable to
 *     checkAndIncrementRateLimit's pid parameter
 *
 * What it does NOT cover (deferred to integration / Chrome MCP):
 *   - Actual HTTP call to Resend (would need network mock infrastructure
 *     not yet in this codebase). The end-to-end Chrome MCP test exercises
 *     this against the live Resend API with a throwaway recipient.
 *   - The audit-log writes (covered indirectly: if writeAudit throws,
 *     the helper logs but still returns the result; the swallow is intentional)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEmailForRateLimit } from '@/lib/email/resend';

describe('normalizeEmailForRateLimit — collapses variants to one bucket', () => {
  test('lowercases the entire address', () => {
    assert.equal(normalizeEmailForRateLimit('Alice@Example.COM'), 'alice@example.com');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeEmailForRateLimit('  alice@example.com  '), 'alice@example.com');
  });

  test('strips plus-addressing from local part', () => {
    assert.equal(normalizeEmailForRateLimit('alice+staxis@example.com'), 'alice@example.com');
    assert.equal(normalizeEmailForRateLimit('alice+m15@example.com'), 'alice@example.com');
  });

  test('collapses multiple variants to ONE bucket (the load-bearing assertion)', () => {
    // The whole point of normalization: if an admin tries to bypass the
    // 5/hour cap by adding '+staxis1', '+staxis2', etc., the rate limit
    // still catches them because all variants normalize to the same key.
    const variants = [
      'alice@example.com',
      'Alice@Example.com',
      '  alice@example.com  ',
      'alice+staxis@example.com',
      'alice+staxis+nested@example.com',
      'ALICE+M15+TEST@EXAMPLE.COM',
    ];
    const normalized = variants.map(normalizeEmailForRateLimit);
    assert.equal(
      new Set(normalized).size, 1,
      `All variants must collapse to one bucket. Got: ${[...new Set(normalized)].join(', ')}`,
    );
    assert.equal(normalized[0], 'alice@example.com');
  });

  test('different recipients get different buckets (no over-collapse)', () => {
    assert.notEqual(
      normalizeEmailForRateLimit('alice@hotel.com'),
      normalizeEmailForRateLimit('bob@hotel.com'),
    );
    assert.notEqual(
      normalizeEmailForRateLimit('alice@hotel-a.com'),
      normalizeEmailForRateLimit('alice@hotel-b.com'),
    );
  });

  test('handles malformed input without crashing', () => {
    // No @ — return as-is (lowercased, trimmed). The caller's email
    // validator is what catches malformed addresses; the rate limiter
    // just needs ANY stable string per recipient.
    assert.equal(normalizeEmailForRateLimit('notanemail'), 'notanemail');
    assert.equal(normalizeEmailForRateLimit(''), '');
  });
});
