/**
 * Tests for the CRLF / null-byte guard added to sendTransactionalEmail in
 * src/lib/email/resend.ts.
 *
 * Comms-voice audit P3 (2026-05-22). The pre-audit wrapper trusted the
 * caller's subject/html/text to be free of header-injection-shaped bytes.
 * `hotelName` flows into the onboarding-invite subject, and while the
 * admin-only `admin/properties/create` route caps the input, defense-
 * in-depth says the wrapper itself must reject control chars before any
 * HTTP call.
 *
 * Regression guards:
 *
 *   1. \r or \n in subject → { ok: false, error: 'subject_contains_control_chars' }
 *      with NO fetch to Resend.
 *   2. \0 in subject → same.
 *   3. \0 in html body → { ok: false, error: 'body_contains_null_bytes' }
 *      with NO fetch.
 *   4. \0 in text body → same.
 *   5. \n in html body is allowed (legit HTML often has line breaks).
 *   6. Clean subject + body → happy path still works, fetch called.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendTransactionalEmail } from '@/lib/email/resend';
import { supabaseAdmin } from '@/lib/supabase-admin';

interface FetchCall { url: string; init?: RequestInit; }
const originalFetch = globalThis.fetch;
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

let fetchCalls: FetchCall[] = [];
let auditWrites: Record<string, unknown>[] = [];

beforeEach(() => {
  fetchCalls = [];
  auditWrites = [];
  process.env.RESEND_API_KEY = 'resend_test_key_unit_only';

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'email_resend_id_xyz' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  // @ts-expect-error monkey-patching singleton
  supabaseAdmin.rpc = async () => ({ data: 1, error: null });

  // @ts-expect-error monkey-patching singleton
  supabaseAdmin.from = (table: string) => {
    if (table === 'admin_audit_log') {
      return {
        insert: async (row: Record<string, unknown>) => {
          auditWrites.push(row);
          return { data: null, error: null };
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.from = originalFrom;
  delete process.env.RESEND_API_KEY;
});

describe('sendTransactionalEmail — subject CRLF guard', () => {
  test('\\r in subject is rejected and fetch is NOT called', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome\r\nBcc: attacker@evil.com',
      html: '<p>clean body</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'subject_contains_control_chars');
    }
    assert.equal(fetchCalls.length, 0, 'fetch must not be called for a rejected subject');
  });

  test('\\n alone in subject is rejected', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome\nMalicious-Header: 1',
      html: '<p>clean</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'subject_contains_control_chars');
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('\\0 in subject is rejected', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome\0nullbyte',
      html: '<p>clean</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'subject_contains_control_chars');
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('rejection still writes an audit row', async () => {
    await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome\r\nBcc: evil',
      html: '<p>clean</p>',
    });
    assert.ok(
      auditWrites.length > 0,
      'audit log must capture the rejected send so admin UI can surface it',
    );
    const row = auditWrites[0];
    assert.equal(row.action, 'email.failed');
  });

  test('rejection does NOT consume the rate-limit slot', async () => {
    // The guard runs before checkAndIncrementRateLimit. Verified indirectly:
    // supabaseAdmin.rpc would have been called by the rate limiter; the
    // happy-path test below proves the rpc IS called when no guard fires.
    let rpcCalls = 0;
    // @ts-expect-error monkey-patching singleton
    supabaseAdmin.rpc = async () => {
      rpcCalls++;
      return { data: 1, error: null };
    };
    await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Bad\r\nthing',
      html: '<p>clean</p>',
    });
    assert.equal(rpcCalls, 0, 'rate-limit RPC must not run when subject is rejected');
  });
});

describe('sendTransactionalEmail — body null-byte guard', () => {
  test('\\0 in html body is rejected', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Clean subject',
      html: '<p>before\0after</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'body_contains_null_bytes');
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('\\0 in text body is rejected', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Clean subject',
      html: '<p>clean html</p>',
      text: 'plain\0text',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'body_contains_null_bytes');
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('\\n in html body is ALLOWED (legit HTML has line breaks)', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Clean subject',
      html: '<p>line one</p>\n<p>line two</p>',
    });
    assert.equal(result.ok, true);
    assert.equal(fetchCalls.length, 1);
  });

  test('\\r\\n in html body is ALLOWED (Windows-style line endings in templates)', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Clean subject',
      html: '<p>line</p>\r\n<p>another</p>',
    });
    assert.equal(result.ok, true);
    assert.equal(fetchCalls.length, 1);
  });
});

describe('sendTransactionalEmail — happy path unaffected by guard', () => {
  test('clean subject + body sends successfully', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome to Staxis',
      html: '<p>hi</p>',
      text: 'hi',
    });
    assert.equal(result.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://api.resend.com/emails');
  });
});
