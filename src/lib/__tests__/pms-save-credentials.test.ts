/**
 * Tests for POST /api/pms/save-credentials.
 *
 * This route was silently broken from migration 0069 (2026-05-11) onwards
 * because it wrote to `ca_username` / `ca_password` columns that 0069
 * dropped. Every Test Connection click in the UI failed at the Postgres
 * layer ("column does not exist") and `scraper_credentials` stayed at zero
 * rows in prod for ~6 days before the audit caught it.
 *
 * The fix routes the write through `staxis_upsert_scraper_credentials`
 * (migration 0132), which encrypts username + password via Vault-backed
 * pgcrypto and stamps `properties.pms_type` + `pms_url` in the same
 * transaction.
 *
 * These tests pin three regression-critical contracts:
 *   1. The route MUST call the RPC, NOT a direct .from('scraper_credentials')
 *      write — otherwise we'd silently regress to writing to dropped columns
 *      OR (if columns were re-added) to writing plaintext.
 *   2. The RPC parameter names MUST match the function's signature exactly
 *      (p_property_id, p_pms_type, p_login_url, p_username, p_password).
 *      A drift here = 500 in prod with "function not found in schema cache".
 *   3. On RPC error, the response is 500 — not a silent "ok" that masks a
 *      DB failure.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infrastructure ─────────────────────────────────────────────────

type RpcFn = typeof supabaseAdmin.rpc;
type FromFn = typeof supabaseAdmin.from;
type GetUserFn = typeof supabaseAdmin.auth.getUser;

const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

interface RpcCall { fn: string; args: Record<string, unknown> }
interface FromCall { table: string; chain: string[] }

let rpcCalls: RpcCall[] = [];
let fromCalls: FromCall[] = [];

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const PROPERTY_ID = '22222222-2222-2222-2222-222222222222';

// Default mock outcomes — tests override before calling the route.
let nextRpcResult: { data: unknown; error: { message: string; code?: string } | null } = {
  data: null, error: null,
};

beforeEach(() => {
  rpcCalls = [];
  fromCalls = [];
  nextRpcResult = { data: null, error: null };

  // ── getUser: requireSession path ──
  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: OWNER_ID, email: 'owner@hotel.test' } },
    error: null,
  })) as unknown as GetUserFn;

  // ── rpc: records every call; returns the configured outcome. The
  //        rate-limit RPC (staxis_api_limit_hit) gets a default "allow"
  //        response; the upsert RPC gets `nextRpcResult`.
  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === 'staxis_api_limit_hit') {
      return { data: 1, error: null };
    }
    if (fn === 'staxis_upsert_scraper_credentials') {
      return nextRpcResult;
    }
    return { data: null, error: null };
  };

  // ── from: records the table accessed; returns a chainable stub. The
  //        ownership check chains .select('id, owner_id').eq('id', pid)
  //        .maybeSingle() and expects { data: { owner_id }, error: null }.
  supabaseAdmin.from = ((table: string) => {
    const chain: string[] = [];
    fromCalls.push({ table, chain });
    const builder: any = {
      select(...args: unknown[]) { chain.push(`select(${args.join(',')})`); return builder; },
      eq(...args: unknown[]) { chain.push(`eq(${args.join(',')})`); return builder; },
      maybeSingle: async () => {
        chain.push('maybeSingle()');
        if (table === 'properties') {
          return { data: { id: PROPERTY_ID, owner_id: OWNER_ID }, error: null };
        }
        return { data: null, error: null };
      },
      upsert(...args: unknown[]) { chain.push(`upsert(${JSON.stringify(args)})`); return builder; },
      update(...args: unknown[]) { chain.push(`update(${JSON.stringify(args)})`); return builder; },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
    };
    return builder;
  }) as unknown as FromFn;
});

afterEach(() => {
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.auth.getUser = originalGetUser;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('https://staxis.test/api/pms/save-credentials', {
    method: 'POST',
    headers: {
      authorization: 'Bearer fake-jwt-the-mock-accepts-anything',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const VALID_BODY = {
  propertyId: PROPERTY_ID,
  pmsType: 'choice_advantage',
  loginUrl: 'https://login.choiceadvantage.com',
  username: 'maria@hotel.test',
  password: 'sup3r-s3cret-password',
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('POST /api/pms/save-credentials — RPC contract', () => {
  test('happy path → calls staxis_upsert_scraper_credentials with exact param shape', async () => {
    const { POST } = await import('@/app/api/pms/save-credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    assert.equal(res.status, 200);

    // The upsert RPC must have been called exactly once.
    const upsertCalls = rpcCalls.filter(c => c.fn === 'staxis_upsert_scraper_credentials');
    assert.equal(upsertCalls.length, 1, 'expected exactly one upsert RPC call');

    // Param names MUST match the function signature in migration 0132.
    // If anyone renames them (e.g. drops the `p_` prefix or changes case),
    // this assertion fails before it can land in prod.
    assert.deepEqual(upsertCalls[0].args, {
      p_property_id: PROPERTY_ID,
      p_pms_type: 'choice_advantage',
      p_login_url: 'https://login.choiceadvantage.com',
      p_username: 'maria@hotel.test',
      p_password: 'sup3r-s3cret-password',
    });
  });

  test('does NOT use the legacy direct-write path (.from("scraper_credentials").upsert)', async () => {
    const { POST } = await import('@/app/api/pms/save-credentials/route');
    await POST(makeRequest(VALID_BODY));

    // Pre-fix code did `.from('scraper_credentials').upsert(...)` AND
    // `.from('properties').update(...)`. The RPC replaces BOTH. If a
    // future change reintroduces either, this test screams.
    const scraperCredTouched = fromCalls.some(c => c.table === 'scraper_credentials');
    assert.equal(scraperCredTouched, false,
      'must not access scraper_credentials directly — use the RPC');

    // `.from('properties').update(...)` is also gone — the RPC stamps both.
    // (The ownership check does .from('properties').select(...), which is
    // a read and is fine.)
    const propUpdateUsed = fromCalls.some(c =>
      c.table === 'properties' && c.chain.some(s => s.startsWith('update(')),
    );
    assert.equal(propUpdateUsed, false,
      'must not update properties directly — the RPC stamps pms_type + pms_url');
  });

  test('RPC error → 500 response (not silent ok)', async () => {
    nextRpcResult = {
      data: null,
      error: { message: 'simulated postgres connection reset', code: '08006' },
    };
    const { POST } = await import('@/app/api/pms/save-credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /could not save/i);
  });

  test('SSRF blocklist still rejects internal hostnames before reaching the RPC', async () => {
    // The SSRF guard runs BEFORE the RPC call. Confirms the fix didn't
    // accidentally regress the existing protection.
    const { POST } = await import('@/app/api/pms/save-credentials/route');
    const res = await POST(makeRequest({ ...VALID_BODY, loginUrl: 'http://169.254.169.254/' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /internal address/i);

    // No upsert RPC was called.
    const upsertCalls = rpcCalls.filter(c => c.fn === 'staxis_upsert_scraper_credentials');
    assert.equal(upsertCalls.length, 0);
  });

  test('passwords are passed through unmodified — the encryption is the RPC\'s job', async () => {
    // Defense against a future "let's encrypt client-side" change that
    // would double-encrypt or otherwise break decrypt_pms_credential.
    const distinctivePassword = 'plaintext-marker-do-not-encrypt-here';
    const { POST } = await import('@/app/api/pms/save-credentials/route');
    await POST(makeRequest({ ...VALID_BODY, password: distinctivePassword }));

    const upsertCalls = rpcCalls.filter(c => c.fn === 'staxis_upsert_scraper_credentials');
    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].args.p_password, distinctivePassword,
      'password must reach the RPC unmodified — encryption happens in plpgsql');
  });
});
