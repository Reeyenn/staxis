/**
 * Cost/identity boundary for nudge delivery: one hotel in, one service RPC out.
 * Any regression to accounts enumeration or per-account resolver calls hits the
 * throwing `from` mock and cannot produce the expected recipients.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { getNudgeRecipients } from '@/lib/agent/nudges';
import { supabaseAdmin } from '@/lib/supabase-admin';

const PROPERTY_ID = '10000000-0000-4000-8000-000000000001';
const RECIPIENT_ID = '20000000-0000-4000-8000-000000000001';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
let rpcData: unknown;
let rpcError: { code?: string; message: string } | null;

beforeEach(() => {
  rpcCalls = [];
  rpcData = {
    ok: true,
    propertyId: PROPERTY_ID,
    subscriptionMode: 'default',
    recipientAccountIds: [RECIPIENT_ID],
    candidateCount: 1,
    recipientLimit: 64,
  };
  rpcError = null;

  supabaseAdmin.from = (table: string) => {
    throw new Error(`global/table enumeration attempted: ${table}`);
  };
  // @ts-expect-error monkey-patching the singleton for an isolated unit test
  supabaseAdmin.rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { data: rpcData, error: rpcError };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

describe('nudge recipient query cost boundary', () => {
  test('uses exactly one property-keyed RPC and never enumerates accounts', async () => {
    assert.deepEqual(await getNudgeRecipients(PROPERTY_ID), [RECIPIENT_ID]);
    assert.deepEqual(rpcCalls, [{
      name: 'staxis_list_property_nudge_recipients',
      args: { p_property_id: PROPERTY_ID },
    }]);
  });

  test('fails closed on an unscoped or oversized projection', async () => {
    rpcData = {
      ok: true,
      propertyId: '30000000-0000-4000-8000-000000000001',
      recipientAccountIds: [RECIPIENT_ID],
    };
    assert.deepEqual(await getNudgeRecipients(PROPERTY_ID), []);
    assert.equal(rpcCalls.length, 1);

    rpcCalls = [];
    rpcData = {
      ok: true,
      propertyId: PROPERTY_ID,
      recipientAccountIds: Array.from({ length: 65 }, () => RECIPIENT_ID),
    };
    assert.deepEqual(await getNudgeRecipients(PROPERTY_ID), []);
    assert.equal(rpcCalls.length, 1);
  });

  test('fails closed when the service projection refuses or errors', async () => {
    rpcData = { ok: false, reason: 'candidate_limit_exceeded' };
    assert.deepEqual(await getNudgeRecipients(PROPERTY_ID), []);

    rpcCalls = [];
    rpcError = { code: '42501', message: 'permission denied' };
    assert.deepEqual(await getNudgeRecipients(PROPERTY_ID), []);
    assert.equal(rpcCalls.length, 1);
  });
});
