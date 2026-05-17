/**
 * Tests for sendTransactionalEmail in src/lib/email/resend.ts.
 *
 * Today only the rate-limit-key helper is tested. The actual send path
 * (HTTP to Resend, per-recipient cap, audit log, soft-fail on missing
 * key) has no coverage — a regression in the soft-fail logic would
 * accidentally throw out of an admin route's request handler and surface
 * as a 500 to the user (instead of the documented best-effort behavior
 * of "log it, return ok=false, continue").
 *
 * Mock surfaces:
 *   - global fetch (the Resend POST)
 *   - supabaseAdmin.rpc (rate-limit gate)
 *   - supabaseAdmin.from('admin_audit_log').insert (audit log write)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendTransactionalEmail } from '@/lib/email/resend';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infra: fetch + supabaseAdmin ───────────────────────────────────

interface FetchCall { url: string; init?: RequestInit; }
const originalFetch = globalThis.fetch;
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

let fetchCalls: FetchCall[] = [];
let nextResendResponse: { status: number; body: unknown } | (() => Promise<Response>) = {
  status: 200,
  body: { id: 'email_resend_id_xyz' },
};

// Rate-limit gate state. Default: allow.
let rateLimitCount = 1;
let rateLimitCap = 5;

let auditWrites: Record<string, unknown>[] = [];

beforeEach(() => {
  fetchCalls = [];
  auditWrites = [];
  rateLimitCount = 1;
  rateLimitCap = 5;
  nextResendResponse = { status: 200, body: { id: 'email_resend_id_xyz' } };
  process.env.RESEND_API_KEY = 'resend_test_key_unit_only';

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    if (typeof nextResendResponse === 'function') return nextResendResponse();
    return new Response(JSON.stringify(nextResendResponse.body), {
      status: nextResendResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  // @ts-expect-error monkey-patching singleton
  supabaseAdmin.rpc = async (_fn: string, _args: Record<string, unknown>) => ({
    data: rateLimitCount,
    error: null,
  });

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

// ─── Happy path ──────────────────────────────────────────────────────────

describe('sendTransactionalEmail — happy path', () => {
  test('POSTs to Resend with the configured API key', async () => {
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.id, 'email_resend_id_xyz');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://api.resend.com/emails');
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer resend_test_key_unit_only');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  test('body includes from/to/subject/html with default from address', async () => {
    await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.from, 'Staxis <noreply@getstaxis.com>');
    assert.deepEqual(body.to, ['alice@hotel.com']);
    assert.equal(body.subject, 'Welcome');
    assert.equal(body.html, '<p>hi</p>');
  });

  test('custom from override is honored', async () => {
    await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Test',
      html: '<p>hi</p>',
      from: 'Support <support@getstaxis.com>',
    });
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.from, 'Support <support@getstaxis.com>');
  });

  test('writes admin_audit_log with action="email.sent" on success', async () => {
    await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(auditWrites.length, 1);
    assert.equal(auditWrites[0].action, 'email.sent');
    const metadata = auditWrites[0].metadata as Record<string, unknown>;
    assert.equal(metadata.recipient, 'alice@hotel.com');
    assert.equal(metadata.resendId, 'email_resend_id_xyz');
  });
});

// ─── Soft-fail paths ─────────────────────────────────────────────────────

describe('sendTransactionalEmail — soft-fail (returns ok:false, does not throw)', () => {
  test('missing RESEND_API_KEY returns ok:false without hitting fetch', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /RESEND_API_KEY/);
    assert.equal(fetchCalls.length, 0);
  });

  test('per-recipient rate limit (5/hour) blocks 6th send to same recipient', async () => {
    // Simulate: this recipient has already received 5 emails this hour.
    // The RPC returns the new count after increment; 6 > 5 → denied.
    rateLimitCount = 6;
    rateLimitCap = 5;
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /rate_limited/);
    // Critically: must NOT have POSTed to Resend.
    assert.equal(fetchCalls.length, 0);
  });

  test('rate-limit denial writes audit with action="email.failed"', async () => {
    rateLimitCount = 6;
    rateLimitCap = 5;
    await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(auditWrites.length, 1);
    assert.equal(auditWrites[0].action, 'email.failed');
  });

  test('Resend non-2xx surfaces ok:false with provider message', async () => {
    nextResendResponse = {
      status: 422,
      body: { message: 'domain getstaxis.com is not verified', name: 'validation_error' },
    };
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /domain getstaxis.com is not verified/);
      assert.equal(result.status, 422);
    }
  });

  test('Resend 2xx but missing id → ok:false (malformed response)', async () => {
    // Defensive: a 200 without an id is something we should treat as
    // failed (the caller relies on `id` to track delivery).
    nextResendResponse = { status: 200, body: { message: 'queued' } };
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(result.ok, false);
  });

  test('fetch throws (network failure) → ok:false with "network: …" error', async () => {
    nextResendResponse = async () => { throw new Error('socket hangup'); };
    const result = await sendTransactionalEmail({
      to: 'alice@hotel.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /network:.*socket hangup/);
  });

  test('all failure modes write audit with action="email.failed"', async () => {
    nextResendResponse = { status: 500, body: { message: 'internal' } };
    await sendTransactionalEmail({ to: 'a@b.com', subject: 's', html: '<p>x</p>' });
    assert.equal(auditWrites[0].action, 'email.failed');
  });
});

// ─── Plus-addressing rate-limit bypass guard ─────────────────────────────

describe('sendTransactionalEmail — recipient normalization for rate-limit', () => {
  test('plus-addressing variants share one rate-limit bucket', async () => {
    // The whole point of the normalization: an admin can't bypass the cap
    // by adding '+staxis1', '+staxis2', etc. Each call here uses a fresh
    // RPC mock that captures the rate-key, so we can verify they're
    // identical.
    const seenKeys: string[] = [];
    // @ts-expect-error capture the pid arg passed to rpc
    supabaseAdmin.rpc = async (_fn: string, args: Record<string, unknown>) => {
      seenKeys.push(args.p_property_id as string);
      return { data: 1, error: null };
    };

    await sendTransactionalEmail({ to: 'alice@hotel.com', subject: 's', html: '<p>x</p>' });
    await sendTransactionalEmail({ to: 'Alice@HOTEL.com', subject: 's', html: '<p>x</p>' });
    await sendTransactionalEmail({ to: 'alice+staxis1@hotel.com', subject: 's', html: '<p>x</p>' });
    await sendTransactionalEmail({ to: 'alice+staxis2@hotel.com', subject: 's', html: '<p>x</p>' });

    assert.equal(new Set(seenKeys).size, 1, `all variants must hit one bucket; got ${seenKeys.length} distinct`);
  });
});
