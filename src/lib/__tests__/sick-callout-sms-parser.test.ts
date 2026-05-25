/**
 * Tests for the pure SMS classifier that decides whether an inbound
 * Twilio message should fire a sick callout.
 *
 * Run via: npx tsx --test src/lib/__tests__/sick-callout-sms-parser.test.ts
 *
 * These cases come straight off the spec's "3 ways to report sick"
 * surface plus the real-world misses the shift-confirmation reply
 * inspector saw on the Comfort Suites pilot (mixed-case, punctuation,
 * Spanish triggers, accidental keyword matches inside longer words).
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyCalloutSms,
  normaliseCalloutText,
} from '../sick-callout/sms-parser';

describe('normaliseCalloutText', () => {
  test('uppercases and trims', () => {
    assert.equal(normaliseCalloutText(' sick '), 'SICK');
  });
  test('strips trailing punctuation', () => {
    assert.equal(normaliseCalloutText('Sick!!'), 'SICK');
    assert.equal(normaliseCalloutText('SICK.'), 'SICK');
    assert.equal(normaliseCalloutText('¿sick?'), 'SICK');
  });
  test('preserves internal whitespace for multi-token detection', () => {
    assert.equal(normaliseCalloutText('sick family'), 'SICK FAMILY');
  });
});

describe('classifyCalloutSms — positive triggers', () => {
  test('"SICK" alone → callout, reason=sick', () => {
    assert.deepEqual(classifyCalloutSms('SICK'), {
      kind: 'callout', reason: 'sick', note: null,
    });
  });
  test('"sick" lowercase → callout', () => {
    const r = classifyCalloutSms('sick');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, 'sick');
  });
  test('"OUT" → callout, no auto reason', () => {
    const r = classifyCalloutSms('OUT');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, null);
  });
  test('"ENFERMO" (Spanish, m) → callout, sick', () => {
    const r = classifyCalloutSms('ENFERMO');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, 'sick');
  });
  test('"ENFERMA" (Spanish, f) → callout, sick', () => {
    const r = classifyCalloutSms('ENFERMA');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, 'sick');
  });
  test('"FUERA" → callout', () => {
    const r = classifyCalloutSms('FUERA');
    assert.equal(r.kind, 'callout');
  });
});

describe('classifyCalloutSms — reason hints', () => {
  test('"SICK FAMILY" → reason=family overrides default', () => {
    const r = classifyCalloutSms('SICK FAMILY');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, 'family');
  });
  test('"OUT PERSONAL" → reason=personal', () => {
    const r = classifyCalloutSms('OUT PERSONAL');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, 'personal');
  });
  test('"FUERA EMERGENCIA" → reason=family', () => {
    const r = classifyCalloutSms('FUERA EMERGENCIA');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') assert.equal(r.reason, 'family');
  });
});

describe('classifyCalloutSms — note capture', () => {
  test('extra text becomes a note', () => {
    const r = classifyCalloutSms('SICK fever 102');
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') {
      assert.match(r.note ?? '', /FEVER 102/);
    }
  });
  test('note is bounded at 200 chars', () => {
    const long = 'SICK ' + 'x'.repeat(500);
    const r = classifyCalloutSms(long);
    assert.equal(r.kind, 'callout');
    if (r.kind === 'callout') {
      assert.ok((r.note?.length ?? 0) <= 200);
    }
  });
});

describe('classifyCalloutSms — negatives (these MUST NOT trigger)', () => {
  test('empty string', () => {
    assert.deepEqual(classifyCalloutSms(''), { kind: 'not_callout' });
  });
  test('null', () => {
    assert.deepEqual(classifyCalloutSms(null), { kind: 'not_callout' });
  });
  test('undefined', () => {
    assert.deepEqual(classifyCalloutSms(undefined), { kind: 'not_callout' });
  });
  test('YES (shift-confirmation, not a callout)', () => {
    assert.deepEqual(classifyCalloutSms('YES'), { kind: 'not_callout' });
  });
  test('ENGLISH / ESPAÑOL language toggles', () => {
    assert.deepEqual(classifyCalloutSms('ENGLISH'), { kind: 'not_callout' });
    assert.deepEqual(classifyCalloutSms('ESPAÑOL'), { kind: 'not_callout' });
  });
  test('trigger inside a longer word does not fire', () => {
    // "PICKING" contains S-I-C-K-style letters but is a different token.
    assert.deepEqual(classifyCalloutSms('PICKING UP'), { kind: 'not_callout' });
  });
  test('YES SICK does NOT trigger (trigger must lead)', () => {
    // The housekeeper would have led with SICK if they meant to call out.
    // YES SICK is more plausibly a confirmation reply.
    assert.deepEqual(classifyCalloutSms('YES SICK'), { kind: 'not_callout' });
  });
});

describe('classifyCalloutSms — idempotency guard for SMS retries', () => {
  test('same text classifies identically across calls', () => {
    const a = classifyCalloutSms('SICK');
    const b = classifyCalloutSms('SICK');
    assert.deepEqual(a, b);
  });
});
