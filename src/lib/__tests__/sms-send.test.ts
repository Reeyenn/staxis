/**
 * Tests for sendSms in src/lib/sms.ts.
 *
 * Every shift confirmation, every help-request acknowledgment, every backup
 * notification goes through this one function. A regression — Twilio URL
 * shape changes, env-var fallback breaks, control-char sanitization gets
 * removed — silently breaks every SMS in the product. These tests pin the
 * outbound contract.
 *
 * The control-char sanitization line in particular looks "defensive" but
 * has saved real money: some PMS data has stray nulls / form-feed chars
 * (vestigial mainframe formatting) that Twilio rejects as malformed,
 * leading to a 30-cent failed-message charge AND no SMS delivered.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendSms } from '@/lib/sms';

// ─── Mock global fetch ───────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init?: RequestInit;
}
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } | (() => Promise<Response>) = {
  status: 201,
  body: { sid: 'SM_test_message_id', status: 'queued' },
};

const ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'TWILIO_PHONE_NUMBER',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  fetchCalls = [];
  nextResponse = { status: 201, body: { sid: 'SM_test_message_id', status: 'queued' } };
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Default to a fully-configured env; individual tests can unset.
  process.env.TWILIO_ACCOUNT_SID = 'AC_test_account_sid';
  process.env.TWILIO_AUTH_TOKEN = 'auth_token_xyz';
  process.env.TWILIO_FROM_NUMBER = '+18445971608';
  delete process.env.TWILIO_PHONE_NUMBER;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    if (typeof nextResponse === 'function') return nextResponse();
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

// ─── Happy path ──────────────────────────────────────────────────────────

describe('sendSms — happy path', () => {
  test('POSTs to the correct Twilio Messages endpoint for the account SID', async () => {
    await sendSms('+15125550100', 'Your shift is confirmed for tomorrow 8am.');
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      'https://api.twilio.com/2010-04-01/Accounts/AC_test_account_sid/Messages.json',
    );
    assert.equal(fetchCalls[0].init?.method, 'POST');
  });

  test('attaches Basic auth header (Base64 of "sid:token")', async () => {
    await sendSms('+15125550100', 'hi');
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('AC_test_account_sid:auth_token_xyz').toString('base64')}`;
    assert.equal(headers['Authorization'], expected);
  });

  test('Content-Type is x-www-form-urlencoded (Twilio rejects JSON)', async () => {
    await sendSms('+15125550100', 'hi');
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
  });

  test('body includes To, From, and Body fields URL-encoded', async () => {
    await sendSms('+15125550100', 'hello & world');
    const body = String(fetchCalls[0].init?.body);
    const parsed = new URLSearchParams(body);
    assert.equal(parsed.get('To'), '+15125550100');
    assert.equal(parsed.get('From'), '+18445971608');
    assert.equal(parsed.get('Body'), 'hello & world');
  });

  test('From-number falls back to legacy TWILIO_PHONE_NUMBER when TWILIO_FROM_NUMBER absent', async () => {
    delete process.env.TWILIO_FROM_NUMBER;
    process.env.TWILIO_PHONE_NUMBER = '+12816669887';
    await sendSms('+15125550100', 'hi');
    const body = String(fetchCalls[0].init?.body);
    assert.equal(new URLSearchParams(body).get('From'), '+12816669887');
  });
});

// ─── Sanitization (control char stripping) ───────────────────────────────

describe('sendSms — body sanitization', () => {
  test('strips ASCII control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F)', async () => {
    // PMS data sometimes has stray null bytes / form-feeds. Twilio rejects
    // them as malformed and charges for the failed send.
    const dirty = 'Hello\x00 wo\x07rld\x08\x0B\x0C\x1F!';
    await sendSms('+15125550100', dirty);
    const body = String(fetchCalls[0].init?.body);
    const parsed = new URLSearchParams(body);
    assert.equal(parsed.get('Body'), 'Hello world!');
  });

  test('preserves tabs (0x09), line feeds (0x0A), and carriage returns (0x0D)', async () => {
    // SMS supports newlines — must NOT strip those, only the truly unprintable.
    const msg = 'Line1\nLine2\tindented\rEOL';
    await sendSms('+15125550100', msg);
    const body = String(fetchCalls[0].init?.body);
    const parsed = new URLSearchParams(body);
    assert.equal(parsed.get('Body'), msg);
  });

  test('trims surrounding whitespace', async () => {
    await sendSms('+15125550100', '   confirmed   ');
    const body = String(fetchCalls[0].init?.body);
    assert.equal(new URLSearchParams(body).get('Body'), 'confirmed');
  });
});

// ─── Failure modes ───────────────────────────────────────────────────────

describe('sendSms — missing config', () => {
  test('throws when TWILIO_ACCOUNT_SID is missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    await assert.rejects(
      () => sendSms('+15125550100', 'hi'),
      /TWILIO_ACCOUNT_SID/,
    );
  });

  test('throws when TWILIO_AUTH_TOKEN is missing', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    await assert.rejects(
      () => sendSms('+15125550100', 'hi'),
      /TWILIO_AUTH_TOKEN/,
    );
  });

  test('throws when both TWILIO_FROM_NUMBER and TWILIO_PHONE_NUMBER are missing', async () => {
    delete process.env.TWILIO_FROM_NUMBER;
    delete process.env.TWILIO_PHONE_NUMBER;
    await assert.rejects(
      () => sendSms('+15125550100', 'hi'),
      /TWILIO_FROM_NUMBER/,
    );
  });

  test('does NOT hit fetch when config is missing (early throw)', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    await assert.rejects(() => sendSms('+15125550100', 'hi'));
    assert.equal(fetchCalls.length, 0);
  });
});

describe('sendSms — Twilio errors', () => {
  test('Twilio 4xx with message field → throws with that message', async () => {
    nextResponse = { status: 400, body: { message: 'Invalid To number', code: 21211 } };
    await assert.rejects(
      () => sendSms('+invalid', 'hi'),
      /Invalid To number/,
    );
  });

  test('Twilio 5xx without parsable body → throws with generic "Twilio error N"', async () => {
    nextResponse = async () => new Response('not-json-body', { status: 500 });
    await assert.rejects(
      () => sendSms('+15125550100', 'hi'),
      /Twilio error 500/,
    );
  });

  test('Twilio 401 (bad auth) surfaces as an error', async () => {
    nextResponse = { status: 401, body: { message: 'Authenticate' } };
    await assert.rejects(
      () => sendSms('+15125550100', 'hi'),
      /Authenticate/,
    );
  });
});
