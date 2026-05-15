/**
 * Regression guard for the agent_costs conversation FK retry path.
 *
 * Round 16 added: on 23503 FK violation against
 * agent_costs_conversation_id_fkey, retry the insert with
 * conversation_id=NULL. The FK is intentionally nullable (ON DELETE
 * SET NULL) for long-lived ElevenLabs voice sessions whose
 * conversation gets deleted mid-session.
 *
 * Round 18 hardening: lifted the discriminator into a pure
 * isConversationFkViolation() helper keyed off a named constant
 * AGENT_COSTS_CONVERSATION_FK so a constraint rename breaks the test
 * loudly instead of silently disabling retry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_COSTS_CONVERSATION_FK,
  isConversationFkViolation,
} from '@/lib/agent/cost-controls';

describe('AGENT_COSTS_CONVERSATION_FK constant', () => {
  it('is the literal constraint name that PostgREST returns', () => {
    // If you renamed the constraint in a migration, update the constant.
    // If you only changed the constant (typo, etc.) without a migration,
    // recordNonRequestCost retry will silently stop firing — voice-brain
    // Sentry noise resumes. This assertion catches the latter.
    assert.equal(AGENT_COSTS_CONVERSATION_FK, 'agent_costs_conversation_id_fkey');
  });
});

describe('isConversationFkViolation', () => {
  it('returns true for the canonical 23503 + conversation FK message', () => {
    assert.equal(
      isConversationFkViolation({
        code: '23503',
        message:
          'insert or update on table "agent_costs" violates foreign key constraint "agent_costs_conversation_id_fkey"',
      }),
      true,
    );
  });

  it('returns false for the same FK violation under a different constraint name', () => {
    // E.g., user_id_fkey or property_id_fkey on agent_costs. We must NOT
    // retry by zeroing conversation_id — user_id/property_id are
    // non-nullable and the retry would still fail.
    assert.equal(
      isConversationFkViolation({
        code: '23503',
        message:
          'insert or update on table "agent_costs" violates foreign key constraint "agent_costs_user_id_fkey"',
      }),
      false,
    );
  });

  it('returns false for non-23503 errors', () => {
    assert.equal(
      isConversationFkViolation({ code: '23505', message: 'duplicate key' }),
      false,
    );
    assert.equal(
      isConversationFkViolation({ code: '42P01', message: 'no such table' }),
      false,
    );
  });

  it('returns false for null/undefined/empty errors', () => {
    assert.equal(isConversationFkViolation(null), false);
    assert.equal(isConversationFkViolation(undefined), false);
    assert.equal(isConversationFkViolation({}), false);
    assert.equal(isConversationFkViolation({ code: '23503' }), false);
    assert.equal(isConversationFkViolation({ code: '23503', message: '' }), false);
  });

  it('matches the constraint name regardless of surrounding text wording', () => {
    // PostgREST's error message format changed historically; we only key
    // off the constraint name appearing somewhere in the message.
    assert.equal(
      isConversationFkViolation({
        code: '23503',
        message: 'agent_costs_conversation_id_fkey was violated',
      }),
      true,
    );
  });
});
