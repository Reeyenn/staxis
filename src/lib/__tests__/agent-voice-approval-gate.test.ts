/**
 * Voice approval gate — the held-set decision (feature/voice-approval).
 *
 * The gate inside streamAgent decides which of a turn's proposed tool calls are
 * HELD for approval vs executed inline. That decision is extracted into the pure
 * helpers approvalGateMode() + partitionGatedCalls() so it's testable without
 * mocking the whole Anthropic stream. This file pins:
 *
 *   (a) VOICE mode holds ONLY card-tier mutations; quick-tier mutations run
 *       inline; read-only calls run inline.
 *   (b) CHAT mode is UNCHANGED — it holds EVERY mutation (quick + card),
 *       read-only inline. (Proof that chat behaviour didn't regress.)
 *   (+) OFF mode holds nothing.
 *
 * The calls reference REAL registered tool names so isMutationTool +
 * approvalTierFor read the live registry (the same source the gate uses).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { approvalGateMode, partitionGatedCalls, type AgentToolCall } from '@/lib/agent/llm';
import '@/lib/agent/tools/index'; // register the real registry

// Real registered tools of each kind (verified against the live registry):
//   card-tier mutation, voice-exposed:  log_complaint, createMaintenanceWorkOrder
//   quick-tier mutation, voice-exposed:  log_found_item, remember, log_reading
//   read-only, voice-exposed:            get_time_off_requests, get_compliance_status
function call(name: string, id = `tc_${name}`): AgentToolCall {
  return { id, name, args: {} };
}

const CARD_MUT = 'log_complaint';
const CARD_MUT_2 = 'createMaintenanceWorkOrder';
const QUICK_MUT = 'log_found_item';
const QUICK_MUT_2 = 'remember';
const READ_ONLY = 'get_time_off_requests';

describe('approvalGateMode()', () => {
  test('approvalMode → chat (chat wins even if voiceApprovalMode also set)', () => {
    assert.equal(approvalGateMode({ approvalMode: true }), 'chat');
    assert.equal(approvalGateMode({ approvalMode: true, voiceApprovalMode: true }), 'chat');
  });
  test('voiceApprovalMode only → voice', () => {
    assert.equal(approvalGateMode({ voiceApprovalMode: true }), 'voice');
  });
  test('neither → off', () => {
    assert.equal(approvalGateMode({}), 'off');
  });
});

describe('partitionGatedCalls() — VOICE mode holds only card-tier mutations', () => {
  test('card-tier mutation is HELD', () => {
    const { held, inline } = partitionGatedCalls([call(CARD_MUT)], 'voice');
    assert.deepEqual(held.map((c) => c.name), [CARD_MUT]);
    assert.deepEqual(inline.map((c) => c.name), []);
  });

  test('quick-tier mutation runs INLINE (not held)', () => {
    const { held, inline } = partitionGatedCalls([call(QUICK_MUT)], 'voice');
    assert.deepEqual(held.map((c) => c.name), []);
    assert.deepEqual(inline.map((c) => c.name), [QUICK_MUT]);
  });

  test('read-only call runs INLINE', () => {
    const { held, inline } = partitionGatedCalls([call(READ_ONLY)], 'voice');
    assert.deepEqual(held.map((c) => c.name), []);
    assert.deepEqual(inline.map((c) => c.name), [READ_ONLY]);
  });

  test('mixed turn: card held; quick + read-only inline', () => {
    const calls = [call(CARD_MUT), call(QUICK_MUT), call(READ_ONLY)];
    const { held, inline } = partitionGatedCalls(calls, 'voice');
    assert.deepEqual(held.map((c) => c.name), [CARD_MUT]);
    assert.deepEqual(inline.map((c) => c.name).sort(), [QUICK_MUT, READ_ONLY].sort());
  });

  test('two card mutations are both held (route stages only the first)', () => {
    const { held } = partitionGatedCalls([call(CARD_MUT), call(CARD_MUT_2)], 'voice');
    assert.deepEqual(held.map((c) => c.name).sort(), [CARD_MUT, CARD_MUT_2].sort());
  });
});

describe('partitionGatedCalls() — CHAT mode holds EVERY mutation (regression: unchanged)', () => {
  test('card-tier mutation is held', () => {
    const { held, inline } = partitionGatedCalls([call(CARD_MUT)], 'chat');
    assert.deepEqual(held.map((c) => c.name), [CARD_MUT]);
    assert.deepEqual(inline.map((c) => c.name), []);
  });

  test('QUICK-tier mutation is ALSO held on chat (the key difference from voice)', () => {
    const { held, inline } = partitionGatedCalls([call(QUICK_MUT)], 'chat');
    assert.deepEqual(held.map((c) => c.name), [QUICK_MUT]);
    assert.deepEqual(inline.map((c) => c.name), []);
  });

  test('read-only runs inline on chat', () => {
    const { held, inline } = partitionGatedCalls([call(READ_ONLY)], 'chat');
    assert.deepEqual(held.map((c) => c.name), []);
    assert.deepEqual(inline.map((c) => c.name), [READ_ONLY]);
  });

  test('mixed turn: BOTH mutations held; read-only inline', () => {
    const calls = [call(CARD_MUT), call(QUICK_MUT), call(QUICK_MUT_2), call(READ_ONLY)];
    const { held, inline } = partitionGatedCalls(calls, 'chat');
    assert.deepEqual(held.map((c) => c.name).sort(), [CARD_MUT, QUICK_MUT, QUICK_MUT_2].sort());
    assert.deepEqual(inline.map((c) => c.name), [READ_ONLY]);
  });
});

describe('partitionGatedCalls() — OFF mode holds nothing', () => {
  test('every call runs inline, nothing held', () => {
    const calls = [call(CARD_MUT), call(QUICK_MUT), call(READ_ONLY)];
    const { held, inline } = partitionGatedCalls(calls, 'off');
    assert.deepEqual(held, []);
    assert.deepEqual(inline.map((c) => c.name).sort(), calls.map((c) => c.name).sort());
  });
});
