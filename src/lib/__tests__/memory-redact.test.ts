/**
 * Memory PII redaction tests (pure). Memory content is untrusted user text;
 * before storage we mask contact PII so the long-term store never accumulates
 * guest phone numbers / emails / card or ID numbers. Imperfect by nature (one
 * defense layer of several) — these pin the obvious shapes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { redactMemoryContent } from '@/lib/agent/memory-redact';

describe('redactMemoryContent', () => {
  test('clean operational text is unchanged and not flagged', () => {
    const r = redactMemoryContent('room 305 AC fails often; deep-clean suites on Sundays');
    assert.equal(r.redacted, false);
    assert.equal(r.content, 'room 305 AC fails often; deep-clean suites on Sundays');
  });

  test('masks an email', () => {
    const r = redactMemoryContent('vendor is jane.doe@acme-plumbing.com');
    assert.ok(r.content.includes('[email]'));
    assert.equal(r.content.includes('@acme-plumbing.com'), false);
    assert.equal(r.redacted, true);
  });

  test('masks a phone number', () => {
    const r = redactMemoryContent('guest in 312 left a bag, call (555) 123-4567');
    assert.ok(r.content.includes('[phone]'));
    assert.equal(/\d{3}[\s.-]\d{4}/.test(r.content), false);
    assert.equal(r.redacted, true);
  });

  test('masks a card-like number', () => {
    const r = redactMemoryContent('card on file 4111 1111 1111 1111');
    assert.ok(r.content.includes('[number]'));
    assert.equal(r.content.includes('4111 1111 1111 1111'), false);
    assert.equal(r.redacted, true);
  });

  test('masks an SSN-shaped value', () => {
    const r = redactMemoryContent('SSN 123-45-6789 on the form');
    assert.ok(r.content.includes('[id]'));
    assert.equal(r.content.includes('123-45-6789'), false);
    assert.equal(r.redacted, true);
  });
});
