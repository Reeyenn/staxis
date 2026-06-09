/**
 * Unit tests for the auth-code inbox helpers (migration 0274).
 *
 * No live DB: the helpers take an injectable `db` param, so we pass a minimal
 * fake exposing only the methods they call (.from().insert() and .rpc()).
 * Mirrors the isolated style of the other cua-service tests under tsx --test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordAuthCode, fetchLatestAuthCode } from '../auth-code-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function insertFake(onInsert: (row: any) => { error: unknown }): SupabaseClient {
  return {
    from(_table: string) {
      return {
        insert(row: any) {
          return Promise.resolve(onInsert(row));
        },
      };
    },
  } as unknown as SupabaseClient;
}

function rpcFake(
  onRpc: (name: string, args: any) => { data: unknown; error: unknown },
): SupabaseClient {
  return {
    rpc(name: string, args: any) {
      return Promise.resolve(onRpc(name, args));
    },
  } as unknown as SupabaseClient;
}

test('recordAuthCode inserts the mapped row', async () => {
  const rows: any[] = [];
  const db = insertFake((row) => {
    rows.push(row);
    return { error: null };
  });
  const res = await recordAuthCode(
    {
      propertyId: 'p1',
      code: '123456',
      emailTo: 'txa32@getstaxis.com',
      source: 'email',
      sender: 'noreply@okta.com',
      subject: 'Your verification code',
      rawRef: 'msg-1',
    },
    db,
  );
  assert.deepEqual(res, { ok: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].property_id, 'p1');
  assert.equal(rows[0].code, '123456');
  assert.equal(rows[0].source, 'email');
  assert.equal(rows[0].email_to, 'txa32@getstaxis.com');
  assert.equal(rows[0].raw_ref, 'msg-1');
});

test('recordAuthCode defaults source to email', async () => {
  let captured: any = null;
  const db = insertFake((row) => {
    captured = row;
    return { error: null };
  });
  await recordAuthCode({ propertyId: 'p1', code: '123456', emailTo: 'x@getstaxis.com' }, db);
  assert.equal(captured.source, 'email');
});

test('recordAuthCode treats a duplicate (23505) as success', async () => {
  const db = insertFake(() => ({ error: { code: '23505', message: 'duplicate key value' } }));
  const res = await recordAuthCode(
    { propertyId: 'p1', code: '123456', emailTo: 'x@getstaxis.com', rawRef: 'dup' },
    db,
  );
  assert.deepEqual(res, { ok: true });
});

test('recordAuthCode surfaces a real insert error', async () => {
  const db = insertFake(() => ({ error: { code: 'XX000', message: 'boom' } }));
  const res = await recordAuthCode({ propertyId: 'p1', code: '123456', emailTo: 'x@getstaxis.com' }, db);
  assert.deepEqual(res, { ok: false, error: 'boom' });
});

test('fetchLatestAuthCode returns the claimed code, then null (single-use)', async () => {
  let calls = 0;
  const db = rpcFake((name) => {
    assert.equal(name, 'claim_pms_auth_code');
    calls += 1;
    // First claim consumes the code server-side; the next claim is empty.
    return calls === 1
      ? { data: [{ id: 'i1', code: '654321' }], error: null }
      : { data: [], error: null };
  });
  const first = await fetchLatestAuthCode('p1', { timeoutMs: 500, pollMs: 10 }, db);
  assert.equal(first, '654321');
  const second = await fetchLatestAuthCode('p1', { timeoutMs: 120, pollMs: 10 }, db);
  assert.equal(second, null);
});

test('fetchLatestAuthCode returns null on timeout when no code arrives', async () => {
  const db = rpcFake(() => ({ data: [], error: null }));
  const started = Date.now();
  const code = await fetchLatestAuthCode('p1', { timeoutMs: 120, pollMs: 20 }, db);
  assert.equal(code, null);
  assert.ok(Date.now() - started >= 80, 'should poll until near the deadline');
});

test('fetchLatestAuthCode forwards the notBefore watermark + defaults to the RPC', async () => {
  let seen: any = null;
  const db = rpcFake((_name, args) => {
    seen = args;
    return { data: [{ code: '111111' }], error: null };
  });
  const watermark = '2026-06-08T00:00:00.000Z';
  const code = await fetchLatestAuthCode('p1', { notBefore: watermark, timeoutMs: 200, pollMs: 10 }, db);
  assert.equal(code, '111111');
  assert.equal(seen.p_property_id, 'p1');
  assert.equal(seen.p_not_before, watermark);
  assert.equal(seen.p_max_age_seconds, 180);
});

test('fetchLatestAuthCode keeps polling through a transient rpc error', async () => {
  let calls = 0;
  const db = rpcFake(() => {
    calls += 1;
    if (calls === 1) return { data: null, error: { message: 'transient' } };
    return { data: [{ code: '222333' }], error: null };
  });
  const code = await fetchLatestAuthCode('p1', { timeoutMs: 500, pollMs: 10 }, db);
  assert.equal(code, '222333');
  assert.ok(calls >= 2);
});
