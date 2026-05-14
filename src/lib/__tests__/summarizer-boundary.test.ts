/**
 * Tests for trimTrailingOrphanToolUses in src/lib/agent/summarizer.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/summarizer-boundary.test.ts
 *
 * Round 12 T12.1 regression guard: if the summarizer's 50-row batch
 * ends on an assistant tool_use whose tool_result is in row 51 (outside
 * the batch), summarizing the tool_use orphans the result on next
 * replay — the model loses the actual tool outcome. The fix trims
 * trailing tool_use rows that don't have a matching tool_result inside
 * the batch.
 *
 * If you change `trimTrailingOrphanToolUses`, these tests must still pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trimTrailingOrphanToolUses, type MessageRow } from '../agent/summarizer';

// Helpers to keep fixtures readable.
function userRow(id: string, content: string): MessageRow {
  return {
    id,
    role: 'user',
    content,
    tool_call_id: null,
    tool_name: null,
    tool_args: null,
    tool_result: null,
    created_at: `2026-05-13T00:00:00Z`,
  };
}

function asstTextRow(id: string, content: string): MessageRow {
  return {
    id,
    role: 'assistant',
    content,
    tool_call_id: null,
    tool_name: null,
    tool_args: null,
    tool_result: null,
    created_at: `2026-05-13T00:00:00Z`,
  };
}

function asstToolUseRow(id: string, toolName: string, callId: string): MessageRow {
  return {
    id,
    role: 'assistant',
    content: null,
    tool_call_id: callId,
    tool_name: toolName,
    tool_args: {},
    tool_result: null,
    created_at: `2026-05-13T00:00:00Z`,
  };
}

function toolResultRow(id: string, callId: string): MessageRow {
  return {
    id,
    role: 'tool',
    content: null,
    tool_call_id: callId,
    tool_name: null,
    tool_args: null,
    tool_result: { ok: true },
    created_at: `2026-05-13T00:00:00Z`,
  };
}

describe('trimTrailingOrphanToolUses', () => {
  test('returns batch unchanged when last row is a user message', () => {
    const rows = [
      asstTextRow('1', 'hi'),
      userRow('2', 'hello'),
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 2);
  });

  test('returns batch unchanged when last row is a normal assistant text turn', () => {
    const rows = [
      userRow('1', 'hi'),
      asstTextRow('2', 'reply'),
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 2);
  });

  test('returns batch unchanged when last row is a tool_result with its pair earlier', () => {
    const rows = [
      userRow('1', 'mark 302 clean'),
      asstToolUseRow('2', 'mark_room_clean', 'c1'),
      toolResultRow('3', 'c1'),
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 3);
  });

  test('trims a single trailing tool_use whose tool_result is outside the batch', () => {
    const rows = [
      userRow('1', 'a'),
      asstTextRow('2', 'b'),
      asstToolUseRow('3', 'do_thing', 'c1'),
      // tool_result for c1 would be at row 4 but isn't fetched.
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 2);
    assert.equal(trimmed[trimmed.length - 1].id, '2');
  });

  test('trims multiple trailing tool_use rows whose results are all outside', () => {
    // Edge case: the model called 2 tools in one turn; both their
    // results landed in rows 51+, outside our 50-row fetch.
    const rows = [
      userRow('1', 'do two things'),
      asstToolUseRow('2', 'tool_a', 'c1'),
      asstToolUseRow('3', 'tool_b', 'c2'),
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 1);
    assert.equal(trimmed[0].id, '1');
  });

  test('keeps trailing tool_use when its tool_result is inside the batch', () => {
    // The tool_result is at the END of the batch (a tool_use earlier
    // than the result). The function trims from the END — so it
    // shouldn't trim, because the LAST row is a tool_result with its
    // tool_use earlier in the batch.
    const rows = [
      userRow('1', 'do thing'),
      asstToolUseRow('2', 'tool_a', 'c1'),
      toolResultRow('3', 'c1'),
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 3);
  });

  test('handles empty input', () => {
    assert.deepEqual(trimTrailingOrphanToolUses([]), []);
  });

  test('trims an entire batch if every row is an orphan tool_use (degenerate)', () => {
    const rows = [
      asstToolUseRow('1', 'tool_a', 'c1'),
      asstToolUseRow('2', 'tool_b', 'c2'),
    ];
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 0);
  });

  test('realistic 50-row scenario: 49 mixed turns + final orphan tool_use', () => {
    const rows: MessageRow[] = [];
    for (let i = 0; i < 49; i++) {
      // i=0 user, i=1 assistant, ..., i=48 user
      rows.push(i % 2 === 0 ? userRow(`u${i}`, 'q') : asstTextRow(`a${i}`, 'r'));
    }
    rows.push(asstToolUseRow('orphan', 'mark_room_clean', 'orphan-call'));
    const trimmed = trimTrailingOrphanToolUses(rows);
    assert.equal(trimmed.length, 49);
    assert.equal(trimmed[48].id, 'u48');
  });
});
