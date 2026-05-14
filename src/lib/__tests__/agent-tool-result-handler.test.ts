/**
 * Tests for src/app/api/agent/command/_tool-result-handler.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/agent-tool-result-handler.test.ts
 *
 * Round 12 T12.16 regression guard: when recordToolResult fails (e.g.
 * a transient Supabase outage during tool result persistence), the
 * route must abort the stream + send an error event, NOT silently
 * continue with the next iteration. Continuing would produce a state
 * where THIS turn's view (success) diverges from the NEXT turn's
 * replay (synthetic abort from finally).
 *
 * If you change handleToolCallFinished, these tests must still pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleToolCallFinished,
  type ToolCallFinishedEvent,
  type AgentErrorEvent,
} from '../../app/api/agent/command/_tool-result-handler';

function makeEvent(callId: string): ToolCallFinishedEvent {
  return {
    type: 'tool_call_finished',
    call: { id: callId },
    result: { ok: true, roomNumber: '302' },
    isError: false,
  };
}

describe('handleToolCallFinished', () => {
  test('success path: clears pendingToolCallIds, forwards event, does not break', async () => {
    const pending = new Set(['c1']);
    const sentEvents: Array<ToolCallFinishedEvent | AgentErrorEvent> = [];
    const persistCalls: Array<unknown[]> = [];
    let persistenceFailureCalls = 0;

    const result = await handleToolCallFinished({
      conversationId: 'conv-1',
      event: makeEvent('c1'),
      pendingToolCallIds: pending,
      recordToolResult: async (...args) => {
        persistCalls.push(args);
      },
      send: (e) => sentEvents.push(e),
      onPersistenceFailure: () => { persistenceFailureCalls++; },
    });

    assert.equal(result.shouldBreak, false);
    assert.equal(pending.has('c1'), false, 'pendingToolCallIds should be cleared after successful persist');
    assert.equal(sentEvents.length, 1);
    assert.equal(sentEvents[0].type, 'tool_call_finished');
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0][0], 'conv-1');
    assert.equal(persistCalls[0][1], 'c1');
    assert.equal(persistenceFailureCalls, 0);
  });

  test('failure path: keeps pendingToolCallIds, sends error event, signals shouldBreak=true', async () => {
    const pending = new Set(['c1']);
    const sentEvents: Array<ToolCallFinishedEvent | AgentErrorEvent> = [];
    const failures: unknown[] = [];

    const result = await handleToolCallFinished({
      conversationId: 'conv-1',
      event: makeEvent('c1'),
      pendingToolCallIds: pending,
      recordToolResult: async () => {
        throw new Error('supabase transient outage');
      },
      send: (e) => sentEvents.push(e),
      onPersistenceFailure: (err) => failures.push(err),
    });

    assert.equal(result.shouldBreak, true, 'route must break the stream loop after a persistence failure');
    assert.equal(
      pending.has('c1'), true,
      "pendingToolCallIds must still contain the call id so the route's finally synthesizes the abort",
    );
    assert.equal(sentEvents.length, 1);
    assert.equal(sentEvents[0].type, 'error', 'client must receive an error event, not a tool_call_finished');
    assert.equal(failures.length, 1, 'onPersistenceFailure should fire exactly once');
    assert.match(
      (failures[0] as Error).message,
      /supabase transient outage/,
      'the original error should be passed through to onPersistenceFailure',
    );
  });

  test('failure path: error event does NOT leak the raw error string to the user', async () => {
    const pending = new Set(['c1']);
    const sentEvents: Array<ToolCallFinishedEvent | AgentErrorEvent> = [];

    await handleToolCallFinished({
      conversationId: 'conv-1',
      event: makeEvent('c1'),
      pendingToolCallIds: pending,
      recordToolResult: async () => {
        throw new Error('postgres connection refused at db.internal.staxis:5432');
      },
      send: (e) => sentEvents.push(e),
      onPersistenceFailure: () => { /* swallow for this test */ },
    });

    assert.equal(sentEvents.length, 1);
    const err = sentEvents[0] as AgentErrorEvent;
    assert.equal(err.type, 'error');
    // Should be a user-friendly message, not raw infra detail.
    assert.doesNotMatch(err.message, /postgres|db\.internal|:5432/i);
    assert.match(err.message, /could not be saved|please retry/i);
  });

  test('multiple calls in sequence: pending set is updated correctly per call', async () => {
    const pending = new Set(['c1', 'c2', 'c3']);
    const sentEvents: Array<ToolCallFinishedEvent | AgentErrorEvent> = [];

    // c1: succeeds.
    await handleToolCallFinished({
      conversationId: 'conv-1',
      event: makeEvent('c1'),
      pendingToolCallIds: pending,
      recordToolResult: async () => { /* ok */ },
      send: (e) => sentEvents.push(e),
      onPersistenceFailure: () => {},
    });
    assert.equal(pending.has('c1'), false);
    assert.equal(pending.has('c2'), true);
    assert.equal(pending.has('c3'), true);

    // c2: fails — pending still has c2 + c3.
    await handleToolCallFinished({
      conversationId: 'conv-1',
      event: makeEvent('c2'),
      pendingToolCallIds: pending,
      recordToolResult: async () => { throw new Error('boom'); },
      send: (e) => sentEvents.push(e),
      onPersistenceFailure: () => {},
    });
    assert.equal(pending.has('c2'), true, 'failed call id stays in pending for finally synthesis');
    assert.equal(pending.has('c3'), true);
  });

  test('handler never throws even when recordToolResult throws', async () => {
    const pending = new Set(['c1']);

    await assert.doesNotReject(
      handleToolCallFinished({
        conversationId: 'conv-1',
        event: makeEvent('c1'),
        pendingToolCallIds: pending,
        recordToolResult: async () => {
          throw new Error('boom');
        },
        send: () => {},
        onPersistenceFailure: () => {},
      }),
      'handler must not propagate the recordToolResult error — it converts to an error event',
    );
  });
});
