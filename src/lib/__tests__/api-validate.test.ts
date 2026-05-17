/**
 * Tests for src/lib/api-validate.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/api-validate.test.ts
 *
 * api-validate is the gate at the top of every SMS-firing endpoint and
 * other public API routes. A regression here can let through a malformed
 * payload that bricks downstream Twilio calls or breaks a Postgres write.
 *
 * Each test case is a real-world failure mode we want to keep catching:
 *   - Newline in a staff name (SMS injection)
 *   - Phishing baseUrl (SMS containing attacker-controlled link)
 *   - Future-dated shift outside the policy window
 *   - Empty array bodies
 *   - Non-string / non-object payloads where strings/objects are expected
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  validateUuid,
  validateString,
  validateInt,
  validateEnum,
  validateDateStr,
  validateArray,
  validatePhone,
  sanitizeForSms,
  safeBaseUrl,
  redactPhone,
  redactEmail,
  redactStripeId,
} from '../api-validate';

// ─── validateUuid ───────────────────────────────────────────────────────────

describe('validateUuid', () => {
  test('accepts a canonical lowercase UUID', () => {
    const r = validateUuid('00000000-0000-0000-0000-000000000000');
    assert.equal(r.error, undefined);
    assert.equal(r.value, '00000000-0000-0000-0000-000000000000');
  });

  test('accepts uppercase / mixed-case UUIDs', () => {
    const r = validateUuid('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
    assert.equal(r.error, undefined);
  });

  test('rejects non-string inputs', () => {
    assert.match(validateUuid(123).error!, /must be a string/);
    assert.match(validateUuid(null).error!, /must be a string/);
    assert.match(validateUuid(undefined).error!, /must be a string/);
    assert.match(validateUuid({ id: 'x' }).error!, /must be a string/);
  });

  test('rejects malformed UUIDs', () => {
    assert.match(validateUuid('not-a-uuid').error!, /not a valid UUID/);
    assert.match(validateUuid('00000000-0000-0000-0000-00000000000').error!, /not a valid UUID/); // 1 short
    assert.match(validateUuid('00000000000000000000000000000000').error!, /not a valid UUID/); // no dashes
  });

  test('uses custom label in error message', () => {
    assert.match(validateUuid(null, 'staff_id').error!, /staff_id must be a string/);
  });
});

// ─── validateString ────────────────────────────────────────────────────────

describe('validateString', () => {
  test('accepts a string within bounds', () => {
    const r = validateString('alice', { max: 10, label: 'name' });
    assert.equal(r.error, undefined);
    assert.equal(r.value, 'alice');
  });

  test('rejects empty by default', () => {
    assert.match(validateString('', { max: 10, label: 'name' }).error!, /cannot be empty/);
  });

  test('allowEmpty lets through empty', () => {
    const r = validateString('', { max: 10, label: 'note', allowEmpty: true });
    assert.equal(r.error, undefined);
    assert.equal(r.value, '');
  });

  test('rejects strings shorter than min', () => {
    assert.match(
      validateString('a', { max: 10, min: 3, label: 'name' }).error!,
      /at least 3 chars/,
    );
  });

  test('rejects strings longer than max', () => {
    assert.match(
      validateString('a'.repeat(11), { max: 10, label: 'name' }).error!,
      /too long.*max 10/,
    );
  });

  test('rejects non-strings', () => {
    assert.match(validateString(42, { max: 10, label: 'name' }).error!, /must be a string/);
  });
});

// ─── validateInt ───────────────────────────────────────────────────────────

describe('validateInt', () => {
  test('accepts numeric integers', () => {
    assert.equal(validateInt(7, { label: 'count' }).value, 7);
    assert.equal(validateInt(0, { label: 'count' }).value, 0);
    assert.equal(validateInt(-5, { label: 'count' }).value, -5);
  });

  test('parses numeric strings', () => {
    assert.equal(validateInt('42', { label: 'count' }).value, 42);
    assert.equal(validateInt('-7', { label: 'count' }).value, -7);
  });

  test('rejects non-integer numbers', () => {
    assert.match(validateInt(3.14, { label: 'count' }).error!, /not an integer/);
  });

  test('rejects malformed strings', () => {
    assert.match(validateInt('1.5', { label: 'count' }).error!, /must be an integer/);
    assert.match(validateInt('abc', { label: 'count' }).error!, /must be an integer/);
  });

  test('rejects out-of-range values', () => {
    assert.match(validateInt(-1, { min: 0, label: 'count' }).error!, /must be ≥ 0/);
    assert.match(validateInt(101, { max: 100, label: 'count' }).error!, /must be ≤ 100/);
  });
});

// ─── validateEnum ──────────────────────────────────────────────────────────

describe('validateEnum', () => {
  test('accepts allowed values', () => {
    const r = validateEnum('en', ['en', 'es'] as const, 'lang');
    assert.equal(r.error, undefined);
    assert.equal(r.value, 'en');
  });

  test('rejects values not in the set', () => {
    const r = validateEnum('fr', ['en', 'es'] as const, 'lang');
    assert.match(r.error!, /must be one of: en, es/);
  });

  test('rejects non-strings', () => {
    assert.match(validateEnum(7, ['a', 'b'] as const, 'x').error!, /must be a string/);
  });
});

// ─── validateDateStr ───────────────────────────────────────────────────────

describe('validateDateStr', () => {
  test('accepts YYYY-MM-DD form', () => {
    const r = validateDateStr('2026-04-29', { label: 'date' });
    assert.equal(r.error, undefined);
    assert.equal(r.value, '2026-04-29');
  });

  test('rejects wrong format', () => {
    assert.match(validateDateStr('04/29/2026', { label: 'date' }).error!, /must be YYYY-MM-DD/);
    assert.match(validateDateStr('2026-4-29', { label: 'date' }).error!, /must be YYYY-MM-DD/);
  });

  test('rejects non-string inputs', () => {
    assert.match(validateDateStr(20260429, { label: 'date' }).error!, /must be a string/);
  });

  test('honors allowFutureDays', () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tISO = tomorrow.toISOString().slice(0, 10);

    // With future window of 0 days, tomorrow is rejected
    assert.match(
      validateDateStr(tISO, { label: 'd', allowFutureDays: 0 }).error!,
      /too far in the future/,
    );
    // With ample window, accepted
    assert.equal(
      validateDateStr(tISO, { label: 'd', allowFutureDays: 7 }).error,
      undefined,
    );
  });

  test('honors allowPastDays', () => {
    const longAgo = new Date();
    longAgo.setUTCDate(longAgo.getUTCDate() - 30);
    const lISO = longAgo.toISOString().slice(0, 10);

    assert.match(
      validateDateStr(lISO, { label: 'd', allowPastDays: 7 }).error!,
      /too far in the past/,
    );
    assert.equal(
      validateDateStr(lISO, { label: 'd', allowPastDays: 60 }).error,
      undefined,
    );
  });
});

// ─── validateArray ─────────────────────────────────────────────────────────

describe('validateArray', () => {
  test('accepts arrays under the cap', () => {
    const r = validateArray<number>([1, 2, 3], { max: 10, label: 'rooms' });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.value, [1, 2, 3]);
  });

  test('rejects non-arrays', () => {
    assert.match(validateArray('hi', { max: 10, label: 'rooms' }).error!, /must be an array/);
    assert.match(validateArray({}, { max: 10, label: 'rooms' }).error!, /must be an array/);
  });

  test('rejects arrays over the cap', () => {
    const big = new Array(LIMITS.STAFF_ARRAY_MAX + 1).fill(0);
    assert.match(
      validateArray(big, { max: LIMITS.STAFF_ARRAY_MAX, label: 'staff' }).error!,
      /too large/,
    );
  });

  test('honors min', () => {
    assert.match(validateArray([], { max: 10, min: 1, label: 'r' }).error!, /at least 1 items/);
  });
});

// ─── validatePhone ─────────────────────────────────────────────────────────

describe('validatePhone', () => {
  test('accepts an empty string as "no phone"', () => {
    const r = validatePhone('');
    assert.equal(r.error, undefined);
    assert.equal(r.value, '');
  });

  test('accepts E.164 with plus', () => {
    const r = validatePhone('+15551234567');
    assert.equal(r.error, undefined);
    assert.equal(r.value, '+15551234567');
  });

  test('accepts US 10-digit hyphenated', () => {
    const r = validatePhone('555-123-4567');
    assert.equal(r.error, undefined);
  });

  test('trims whitespace', () => {
    const r = validatePhone('  +15551234567  ');
    assert.equal(r.value, '+15551234567');
  });

  test('rejects invalid chars', () => {
    assert.match(validatePhone("+1; DROP TABLE").error!, /invalid characters/);
    assert.match(validatePhone('hello').error!, /invalid characters/);
  });

  test('rejects non-strings', () => {
    assert.match(validatePhone(15551234567).error!, /must be a string/);
  });
});

// ─── sanitizeForSms ────────────────────────────────────────────────────────

describe('sanitizeForSms', () => {
  test('strips newlines and replaces with single space', () => {
    assert.equal(sanitizeForSms('hello\nworld'), 'hello world');
  });

  test('strips carriage returns', () => {
    assert.equal(sanitizeForSms('a\rb'), 'a b');
  });

  test('strips tabs and form feeds', () => {
    assert.equal(sanitizeForSms('a\tb\fc'), 'a b c');
  });

  test('strips ASCII control characters (SMS injection vector)', () => {
    //   (NUL),  (BEL),  (ESC),  (DEL)
    assert.equal(sanitizeForSms('hi there'), 'hi there');
    assert.equal(sanitizeForSms('hithere'), 'hi there');
    assert.equal(sanitizeForSms('hithere'), 'hi there');
  });

  test('collapses runs of whitespace', () => {
    assert.equal(sanitizeForSms('  hello   world  '), 'hello world');
  });

  test('leaves a clean string unchanged', () => {
    assert.equal(sanitizeForSms('Alice Smith'), 'Alice Smith');
  });

  test('preserves emoji and unicode letters', () => {
    assert.equal(sanitizeForSms('María 🎉'), 'María 🎉');
  });
});

// ─── safeBaseUrl ───────────────────────────────────────────────────────────

describe('safeBaseUrl', () => {
  test('accepts canonical prod URL', () => {
    assert.equal(safeBaseUrl('https://getstaxis.com'), 'https://getstaxis.com');
  });

  test('still accepts the legacy Vercel alias', () => {
    // Kept allow-listed so any old SMS link in flight still validates;
    // next.config.ts 301s the user to getstaxis.com on click.
    assert.equal(safeBaseUrl('https://hotelops-ai.vercel.app'), 'https://hotelops-ai.vercel.app');
  });

  test('accepts localhost dev URLs', () => {
    assert.equal(safeBaseUrl('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(safeBaseUrl('http://localhost:3001'), 'http://localhost:3001');
  });

  test('strips path/query and returns origin only', () => {
    assert.equal(
      safeBaseUrl('https://getstaxis.com/dashboard?from=email'),
      'https://getstaxis.com',
    );
  });

  test('falls back when input is a non-allow-listed origin', () => {
    // Phishing protection — attacker-controlled domain is dropped.
    assert.equal(safeBaseUrl('https://evil.example.com'), 'https://getstaxis.com');
  });

  test('falls back on garbage input', () => {
    assert.equal(safeBaseUrl('not a url'), 'https://getstaxis.com');
    assert.equal(safeBaseUrl(undefined), 'https://getstaxis.com');
    assert.equal(safeBaseUrl(123), 'https://getstaxis.com');
  });

  test('honors a custom fallback', () => {
    assert.equal(
      safeBaseUrl('not a url', 'http://localhost:3000'),
      'http://localhost:3000',
    );
  });
});

// ─── redactPhone ───────────────────────────────────────────────────────────

describe('redactPhone', () => {
  test('keeps country code + last 4 for E.164', () => {
    assert.equal(redactPhone('+15551234567'), '+1***4567');
  });

  test('drops country code when input lacks +', () => {
    assert.equal(redactPhone('5551234567'), '***4567');
  });

  test('handles null/undefined/empty', () => {
    assert.equal(redactPhone(null), '<no-phone>');
    assert.equal(redactPhone(undefined), '<no-phone>');
    assert.equal(redactPhone(''), '<no-phone>');
  });

  test('handles too-short numbers', () => {
    assert.equal(redactPhone('123'), '<short>');
  });
});

// ─── LIMITS ─────────────────────────────────────────────────────────────────

describe('LIMITS', () => {
  test('Twilio segment cap is 1600 chars (10-segment hard cap)', () => {
    // Document this as a test so a future "let's allow longer SMS" change
    // surfaces the trade-off explicitly.
    assert.equal(LIMITS.SMS_BODY_MAX, 1600);
  });

  test('staff array max is reasonable for a single property', () => {
    // 200 housekeepers per property is well above any realistic case but
    // protects us from unbounded array submissions.
    assert.equal(LIMITS.STAFF_ARRAY_MAX, 200);
  });
});

// ─── redactPhone / redactEmail / redactStripeId ─────────────────────────────
//
// The three redactors sit next to each other in api-validate.ts so they
// share a section here. They exist because logging audits keep finding
// PII interpolated into console.* calls; the redactors give authors a
// safer default (May 2026 audit findings H1, H2, M1).

describe('redactPhone', () => {
  test('keeps country code and last 4 digits', () => {
    assert.equal(redactPhone('+15551234567'), '+1***4567');
  });

  test('handles unformatted 10-digit numbers (no country code)', () => {
    assert.equal(redactPhone('5551234567'), '***4567');
  });

  test('returns a marker for nullish input', () => {
    assert.equal(redactPhone(null), '<no-phone>');
    assert.equal(redactPhone(undefined), '<no-phone>');
    assert.equal(redactPhone(''), '<no-phone>');
  });

  test('returns <short> for too-few digits', () => {
    assert.equal(redactPhone('+12'), '<short>');
  });
});

describe('redactEmail', () => {
  test('keeps first char of local-part plus full domain', () => {
    assert.equal(redactEmail('mario@hilton.com'), 'm***@hilton.com');
  });

  test('works on synthetic .staxis.local addresses', () => {
    assert.equal(redactEmail('mario@hilton.staxis.local'), 'm***@hilton.staxis.local');
  });

  test('returns a marker for nullish input', () => {
    assert.equal(redactEmail(null), '<no-email>');
    assert.equal(redactEmail(undefined), '<no-email>');
    assert.equal(redactEmail(''), '<no-email>');
  });

  test('returns <bad-email> when @ is missing or leading', () => {
    assert.equal(redactEmail('no-at-sign'), '<bad-email>');
    assert.equal(redactEmail('@nolocalpart.com'), '<bad-email>');
  });
});

describe('redactStripeId', () => {
  test('keeps prefix and last 4 chars of a customer id', () => {
    assert.equal(redactStripeId('cus_NeoSb1xLpfP7gQ'), 'cus_***P7gQ');
  });

  test('works on payment-intent ids', () => {
    assert.equal(redactStripeId('pi_3OqEzaXcRtAbCdEfGhIj'), 'pi_***GhIj');
  });

  test('returns a marker for nullish input', () => {
    assert.equal(redactStripeId(null), '<no-id>');
    assert.equal(redactStripeId(undefined), '<no-id>');
    assert.equal(redactStripeId(''), '<no-id>');
  });

  test('returns <short> when the id is missing an underscore or too short to tail', () => {
    assert.equal(redactStripeId('cus'), '<short>');
    assert.equal(redactStripeId('cus_ab'), '<short>');
  });
});
