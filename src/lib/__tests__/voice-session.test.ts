/**
 * Tests for src/lib/agent/voice-session.ts.
 *
 * Plan v2 M-1 (voice replay close): these tests pin the contract that
 * makes the voice nonce non-replayable.
 *
 * The session id flows through ElevenLabs as a dynamic_variable. Anyone who
 * captures it + holds the (org-wide) webhook secret could resurrect a
 * victim's identity for the full TTL. The four invariants under test —
 * connection binding, idle expiry, race-loss on rebind, and last_turn_at
 * advance — together turn the nonce from "long-lived bearer" into
 * "single-connection capability."
 *
 * Strategy mirrors api-auth-property-access.test.ts: monkey-patch
 * `supabaseAdmin.from` to return a chainable stub for each table the
 * function under test visits. We never hit a real DB.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveVoiceSession,
  bindVoiceSessionToConnection,
  markVoiceSessionTurn,
} from '@/lib/agent/voice-session';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Fixtures ────────────────────────────────────────────────────────────

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const PROPERTY_ID = '00000000-0000-0000-0000-000000000004';
const CONVERSATION_ID = '00000000-0000-0000-0000-000000000005';
const ELEVEN_A = 'eleven_conv_A';
const ELEVEN_B = 'eleven_conv_B';

interface VoiceRow {
  id: string;
  account_id: string;
  data_user_id: string;
  property_id: string;
  conversation_id: string;
  expires_at: string;
  elevenlabs_conversation_id: string | null;
  last_turn_at: string | null;
}
interface AccountRow {
  id: string;
  role: string;
  data_user_id: string;
  property_access: string[];
}

let voiceRow: VoiceRow | null = null;
let accountRow: AccountRow | null = null;
let bindAffectedRows: VoiceRow | null = null; // returned by the bind UPDATE
let markTurnError: { message: string } | null = null;
let updateCalls: Array<{ table: string; patch: Record<string, unknown>; predicates: Record<string, unknown> }> = [];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  voiceRow = freshVoiceRow();
  accountRow = {
    id: ACCOUNT_ID,
    role: 'general_manager',
    data_user_id: USER_ID,
    property_access: [PROPERTY_ID],
  };
  bindAffectedRows = null;
  markTurnError = null;
  updateCalls = [];

  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => buildTableStub(table);
});

afterEach(() => {
  // @ts-expect-error restore
  supabaseAdmin.from = originalFrom;
});

function freshVoiceRow(): VoiceRow {
  return {
    id: SESSION_ID,
    account_id: ACCOUNT_ID,
    data_user_id: USER_ID,
    property_id: PROPERTY_ID,
    conversation_id: CONVERSATION_ID,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    elevenlabs_conversation_id: null,
    last_turn_at: null,
  };
}

// Minimal chainable stub for the small set of supabase-js calls voice-session.ts uses.
function buildTableStub(table: string) {
  if (table === 'agent_voice_sessions') {
    return {
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: voiceRow, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col1: string, _v1: string) => ({
          // Branch 1: bind path uses .is('elevenlabs_conversation_id', null).select('id').maybeSingle()
          is: (_col2: string, _v2: unknown) => ({
            select: (_cols: string) => ({
              maybeSingle: async () => {
                updateCalls.push({ table, patch, predicates: { id: SESSION_ID, isNull: true } });
                return { data: bindAffectedRows, error: null };
              },
            }),
          }),
          // Branch 2: markTurn path is a plain UPDATE … WHERE id=$1 with no .select() chain.
          // supabase-js returns a thenable directly; we model that by being the
          // resolved value of an awaited call.
          then: (onFulfilled: (v: { data: null; error: { message: string } | null }) => unknown) => {
            updateCalls.push({ table, patch, predicates: { id: SESSION_ID } });
            return Promise.resolve({ data: null, error: markTurnError }).then(onFulfilled);
          },
        }),
      }),
    };
  }
  if (table === 'accounts') {
    return {
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: accountRow, error: null }),
        }),
      }),
    };
  }
  if (table === 'staff') {
    return {
      select: (_cols: string) => ({
        eq: (_col1: string, _v1: string) => ({
          eq: (_col2: string, _v2: string) => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    };
  }
  throw new Error(`unexpected table in stub: ${table}`);
}

// ─── resolveVoiceSession ─────────────────────────────────────────────────

describe('resolveVoiceSession — happy path', () => {
  test('unbound session + no conv_id supplied → resolves with needsConnectionBinding=true', async () => {
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.needsConnectionBinding, true);
      assert.equal(result.ctx.accountId, ACCOUNT_ID);
      assert.equal(result.ctx.propertyId, PROPERTY_ID);
      assert.equal(result.ctx.role, 'general_manager');
    }
  });

  test('unbound session + conv_id supplied → resolves; binding still flagged', async () => {
    const result = await resolveVoiceSession(SESSION_ID, ELEVEN_A);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.needsConnectionBinding, true);
  });

  test('bound session + matching conv_id → resolves; no binding needed', async () => {
    voiceRow!.elevenlabs_conversation_id = ELEVEN_A;
    const result = await resolveVoiceSession(SESSION_ID, ELEVEN_A);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.needsConnectionBinding, false);
  });
});

describe('resolveVoiceSession — M-1 rejections', () => {
  test('row not found → not_found', async () => {
    voiceRow = null;
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_found');
  });

  test('expired row → expired', async () => {
    voiceRow!.expires_at = new Date(Date.now() - 1_000).toISOString();
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'expired');
  });

  test('idle gap > 5 min → idle_expired', async () => {
    voiceRow!.last_turn_at = new Date(Date.now() - 10 * 60_000).toISOString();
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'idle_expired');
  });

  test('idle gap < 5 min → resolves', async () => {
    voiceRow!.last_turn_at = new Date(Date.now() - 60_000).toISOString();
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, true);
  });

  test('bound row + mismatched conv_id → binding_mismatch', async () => {
    voiceRow!.elevenlabs_conversation_id = ELEVEN_A;
    const result = await resolveVoiceSession(SESSION_ID, ELEVEN_B);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'binding_mismatch');
  });

  test('account missing → account_missing', async () => {
    accountRow = null;
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'account_missing');
  });

  test('property access revoked → access_revoked', async () => {
    // userHasPropertyAccess re-reads accounts.property_access — empty list
    // means the property was removed from the user's access set since the
    // session was minted. Mid-session revocation flows through here.
    accountRow!.property_access = [];
    const result = await resolveVoiceSession(SESSION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'access_revoked');
  });
});

// ─── bindVoiceSessionToConnection ────────────────────────────────────────

describe('bindVoiceSessionToConnection', () => {
  test('claims the row when unbound → returns true', async () => {
    bindAffectedRows = { ...freshVoiceRow(), elevenlabs_conversation_id: ELEVEN_A };
    const claimed = await bindVoiceSessionToConnection(SESSION_ID, ELEVEN_A);
    assert.equal(claimed, true);
    assert.equal(updateCalls[0].patch.elevenlabs_conversation_id, ELEVEN_A);
  });

  test('returns false when the row was already bound (race lost)', async () => {
    bindAffectedRows = null; // zero rows match the IS NULL predicate
    const claimed = await bindVoiceSessionToConnection(SESSION_ID, ELEVEN_A);
    assert.equal(claimed, false);
  });
});

// ─── markVoiceSessionTurn ────────────────────────────────────────────────

describe('markVoiceSessionTurn', () => {
  test('stamps last_turn_at on success', async () => {
    await markVoiceSessionTurn(SESSION_ID);
    assert.equal(updateCalls.length, 1);
    assert.ok(typeof updateCalls[0].patch.last_turn_at === 'string');
  });

  test('throws when the update returns an error', async () => {
    markTurnError = { message: 'connection reset' };
    await assert.rejects(markVoiceSessionTurn(SESSION_ID), /markVoiceSessionTurn failed/);
  });
});
