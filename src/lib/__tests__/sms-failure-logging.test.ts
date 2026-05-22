/**
 * Twilio failure observability — Phase E2E (2026-05-22).
 *
 * sendSms now reports `twilio_send_failed` to Sentry with a deduping
 * fingerprint that groups by Twilio error code. The throw behavior is
 * intentionally unchanged — these tests verify that the throw still
 * fires for every failure mode the wrapper has to handle. The Sentry
 * capture itself is verified by reading src/lib/sms.ts (the SDK is a
 * no-op in tests without DSN).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
] as const;

let fetchCalls: Array<{ url: string }> = [];
let nextResponse: { status: number; body: unknown } | (() => Promise<never>) = { status: 200, body: { sid: 'SM-abc' } };
const originalFetch = globalThis.fetch;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function installFakeFetch() {
  // @ts-expect-error overriding global fetch for the test
  globalThis.fetch = async (url: string) => {
    fetchCalls.push({ url: String(url) });
    if (typeof nextResponse === 'function') return nextResponse();
    const { status, body } = nextResponse;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

beforeEach(() => {
  fetchCalls = [];
  nextResponse = { status: 200, body: { sid: 'SM-abc' } };
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'x'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN = 'a'.repeat(32);
  process.env.TWILIO_FROM_NUMBER = '+15555550100';
  installFakeFetch();
});

afterEach(() => {
  restoreFetch();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

async function loadSms() {
  return await import('../sms');
}

describe('sendSms — failure throw behavior is preserved', () => {
  it('happy path: 2xx response does not throw', async () => {
    nextResponse = { status: 201, body: { sid: 'SM-abc' } };
    const { sendSms } = await loadSms();
    await sendSms('+15555551234', 'hello');
    assert.equal(fetchCalls.length, 1);
  });

  it('throws Twilio error message when Twilio returns 4xx with code', async () => {
    nextResponse = {
      status: 400,
      body: { message: 'Permission to send to this number not enabled', code: 30034 },
    };
    const { sendSms } = await loadSms();

    await assert.rejects(() => sendSms('+15555551234', 'hello'), /not enabled/);
  });

  it('throws generic message when Twilio returns non-2xx without an error code', async () => {
    nextResponse = { status: 500, body: {} };
    const { sendSms } = await loadSms();

    await assert.rejects(() => sendSms('+15555551234', 'hello'), /Twilio error 500/);
  });

  it('rethrows the original fetch error when externalFetch throws (timeout / network)', async () => {
    nextResponse = async () => { throw new Error('socket hangup'); };
    const { sendSms } = await loadSms();

    await assert.rejects(() => sendSms('+15555551234', 'hello'), /socket hangup/);
  });

  it('throws when Twilio env vars are missing (config gate)', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const { sendSms } = await loadSms();

    await assert.rejects(() => sendSms('+15555551234', 'hello'), /Twilio env vars missing/);
    assert.equal(fetchCalls.length, 0, 'no fetch when config is incomplete');
  });
});
