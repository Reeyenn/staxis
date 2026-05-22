/**
 * Tests for the per-request rate limit wired into /api/agent/speak.
 *
 * Comms-voice audit P4 (2026-05-22). The route used to be guarded only by
 * the daily $5 audio budget cap. A runaway client or compromised session
 * could fire ~50 1k-char ElevenLabs calls before the budget tripped — at
 * which point the user has already paid for those calls. Adding a per-
 * user-per-hour count cap catches that long before the budget burns.
 *
 * The contract this test pins:
 *
 *   1. `agent-tts-speak` is a registered endpoint in api-ratelimit (cap=30).
 *      A regression in the type union or HOURLY_CAPS would surface as a
 *      compile error AND a runtime "cap is undefined" — this test catches
 *      the runtime path.
 *
 *   2. `agent-tts-speak` is in BILLING_IMPACTING_ENDPOINTS — an RPC failure
 *      must fail CLOSED (deny the call), not fail open. The pre-P4 default
 *      was fail-open, which would let a Supabase blip bypass the cap.
 *
 *   3. The 31st call in an hour for the same user gets denied with
 *      retryAfterSec > 0.
 *
 * Direct exercise of the POST handler is out of scope (would require
 * mocking 6 modules: requireSession, userHasPropertyAccess, supabaseAdmin
 * .from('accounts'), assertAudioBudget, externalFetch, recordNonRequestCost).
 * The route's compile-time TypeScript binding plus this rate-limit unit
 * test gives us the regression coverage that matters.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { supabaseAdmin } from '@/lib/supabase-admin';

const FAKE_ACCOUNT_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type RpcFn = typeof supabaseAdmin.rpc;
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let mockedCount = 1;
let throwOnRpc: Error | null = null;
let returnRpcError: { message: string } | null = null;

beforeEach(() => {
  rpcCalls = [];
  mockedCount = 1;
  throwOnRpc = null;
  returnRpcError = null;
  // @ts-expect-error monkey-patching singleton
  supabaseAdmin.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (throwOnRpc) throw throwOnRpc;
    return { data: mockedCount, error: returnRpcError };
  };
});

afterEach(() => {
  supabaseAdmin.rpc = originalRpc;
});

describe('agent-tts-speak rate limit registration', () => {
  test('endpoint is registered (no "cap is undefined" runtime error)', async () => {
    mockedCount = 1;
    const result = await checkAndIncrementRateLimit('agent-tts-speak', FAKE_ACCOUNT_UUID);
    assert.equal(result.allowed, true);
    // The endpoint name is passed through to the RPC unchanged.
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].args.p_endpoint, 'agent-tts-speak');
  });

  test('cap is 30 — 30th call passes, 31st denies', async () => {
    mockedCount = 30;
    const at30 = await checkAndIncrementRateLimit('agent-tts-speak', FAKE_ACCOUNT_UUID);
    assert.equal(at30.allowed, true);

    mockedCount = 31;
    const at31 = await checkAndIncrementRateLimit('agent-tts-speak', FAKE_ACCOUNT_UUID);
    assert.equal(at31.allowed, false);
    if (!at31.allowed) {
      assert.equal(at31.cap, 30);
      assert.equal(at31.current, 31);
      assert.ok(at31.retryAfterSec > 0, 'retry-after must be a positive number of seconds');
      assert.ok(at31.retryAfterSec <= 3600, 'retry-after must not exceed one hour');
    }
  });
});

describe('agent-tts-speak fails CLOSED on RPC error (billing-impacting)', () => {
  test('RPC throws → denied (not allowed) so the ElevenLabs call is blocked', async () => {
    throwOnRpc = new Error('connection reset');
    const result = await checkAndIncrementRateLimit('agent-tts-speak', FAKE_ACCOUNT_UUID);
    assert.equal(
      result.allowed,
      false,
      'agent-tts-speak must fail closed; a Supabase hiccup must not bypass the cap',
    );
  });

  test('RPC returns DB error → denied', async () => {
    returnRpcError = { message: 'function staxis_api_limit_hit does not exist' };
    const result = await checkAndIncrementRateLimit('agent-tts-speak', FAKE_ACCOUNT_UUID);
    assert.equal(
      result.allowed,
      false,
      'a missing RPC must not silently let calls through for a billing endpoint',
    );
  });

  // Counter-test: a NON-billing endpoint fails OPEN on RPC error. This pins
  // the asymmetric behavior so a future "fix" that flips everything to
  // fail-open (which would silently disable the agent-tts-speak cap) lands
  // as a red diff.
  test('counter-test — non-billing endpoint fails OPEN on RPC error', async () => {
    throwOnRpc = new Error('connection reset');
    const result = await checkAndIncrementRateLimit('housekeeper-rooms', FAKE_ACCOUNT_UUID);
    assert.equal(
      result.allowed,
      true,
      'non-billing endpoints must fail open — this confirms the asymmetric design is intact',
    );
  });
});

describe('agent-tts-speak is keyed per-account (not per-property)', () => {
  test('two different account UUIDs share no rate-limit state', async () => {
    mockedCount = 1;
    const r1 = await checkAndIncrementRateLimit('agent-tts-speak', FAKE_ACCOUNT_UUID);
    const r2 = await checkAndIncrementRateLimit(
      'agent-tts-speak',
      '11111111-2222-3333-4444-555555555555',
    );
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    // Two RPCs, two distinct property_id args.
    assert.equal(rpcCalls.length, 2);
    assert.notEqual(rpcCalls[0].args.p_property_id, rpcCalls[1].args.p_property_id);
  });
});
