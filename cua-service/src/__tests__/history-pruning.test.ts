/**
 * Tests for the batched-pruning logic in mapper.ts.
 *
 * Anthropic best-practices for computer/browser use call for pruning
 * older heavy content in BATCHES (~25 turns) instead of every turn.
 * The point: between prune events, the byte-content of the older
 * messages stays identical — a prerequisite for prompt caching of
 * conversation history. This test pins the two invariants:
 *
 *   (1) No-op when called within PRUNE_BATCH_TURNS of last prune.
 *       The returned prefix is referentially equal to last call's
 *       output, so its serialized bytes are guaranteed identical.
 *   (2) Non-trivial when called past the threshold.
 *       After 25+ new turns of screenshots, the next call re-elides,
 *       collapsing the older screenshots that had accumulated.
 *
 * Pure-function tests — no Playwright, no Anthropic, no DB.
 */

// Defense-in-depth: history-pruning.ts has no module-level side effects
// today, so these env vars aren't actually read. Kept so that if a future
// import accidentally pulls a supabase-loading module into this test, we
// don't get a cryptic env-validation crash on first run.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
// Import from the dedicated history-pruning module (not mapper.ts) so the
// test doesn't trigger Supabase realtime init at import time (the
// realtime client requires `ws` on Node 20, blocking tests in dev).
import {
  createPruneState,
  maybePruneHistory,
  pruneOldHistory,
  trimBigTextInMessage,
} from '../history-pruning.js';

// Mirror of READ_PAGE_TRUNCATE_CHARS so the test doesn't depend on
// re-exporting it. If the constant changes, this number changes too.
const READ_PAGE_TRUNCATE_CHARS_FIXTURE = 20_000;

// ─── Test fixture builders ────────────────────────────────────────────────

type Msg = Anthropic.Messages.MessageParam;

function assistantToolUse(stepIdx: number): Msg {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `step ${stepIdx} thinking` },
      {
        type: 'tool_use',
        id: `toolu_${stepIdx}`,
        name: 'computer',
        input: { action: 'screenshot' },
      },
    ],
  };
}

function userToolResultWithScreenshot(stepIdx: number): Msg {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `toolu_${stepIdx}`,
        content: [
          { type: 'text', text: `Screenshot ${stepIdx} captured.` },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              // Synthetic image data — 100 bytes per screenshot so the
              // "elided" marker is meaningfully shorter than the original.
              data: 'A'.repeat(100),
            },
          },
        ],
      },
    ],
  };
}

/** Build messages for N turns: initial user goal + N (assistant, user) pairs. */
function buildMessages(turns: number): Msg[] {
  const msgs: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'goal' }] },
  ];
  for (let i = 0; i < turns; i++) {
    msgs.push(assistantToolUse(i));
    msgs.push(userToolResultWithScreenshot(i));
  }
  return msgs;
}

function countImageBlocks(messages: Msg[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const inner of b.content) {
          if (inner.type === 'image') n++;
        }
      }
    }
  }
  return n;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('maybePruneHistory — no-op between batched prunes (cache-friendly)', () => {
  test('returns referentially-equal prefix when called within PRUNE_BATCH_TURNS', () => {
    const state = createPruneState();
    const KEEP_LAST = 3;

    // Turn 0 — first call: prunes (sets the cache baseline).
    const messages = buildMessages(10);
    const turn0Result = maybePruneHistory(messages, state, 0, KEEP_LAST);
    assert.equal(state.lastPruneTurn, 0);
    assert.ok(state.cachedPrunedMessages !== null, 'cache should be set after first prune');

    // Add 5 more turns (still inside the 25-turn batch window).
    for (let i = 10; i < 15; i++) {
      messages.push(assistantToolUse(i));
      messages.push(userToolResultWithScreenshot(i));
    }

    // Turn 5 — should NOT re-prune (turnsSinceLastPrune = 5 < 25).
    const turn5Result = maybePruneHistory(messages, state, 5, KEEP_LAST);
    assert.equal(state.lastPruneTurn, 0, 'lastPruneTurn must NOT advance — no prune fired');

    // The prefix (everything that was in messages at turn 0) must be
    // referentially identical between turn0Result and turn5Result.
    // Reference equality is the strongest possible no-op guarantee — if
    // the same JS objects are sent, serialized bytes are identical.
    for (let i = 0; i < turn0Result.length; i++) {
      assert.strictEqual(
        turn5Result[i],
        turn0Result[i],
        `prefix element ${i} must be referentially identical between calls`,
      );
    }

    // The newer tail (turns 10-14 worth = 10 messages) should be appended.
    assert.equal(
      turn5Result.length,
      turn0Result.length + 10,
      'turn-5 result should have appended the 10 new tail messages',
    );
  });

  test('repeated no-op calls with no new messages are idempotent', () => {
    const state = createPruneState();
    const messages = buildMessages(5);

    const t0 = maybePruneHistory(messages, state, 0, 3);
    const t1 = maybePruneHistory(messages, state, 1, 3);
    const t2 = maybePruneHistory(messages, state, 2, 3);

    // No new messages → all three calls return the same cached array.
    assert.strictEqual(t1, t0, 'turn 1 returns cached array as-is');
    assert.strictEqual(t2, t0, 'turn 2 returns cached array as-is');
    assert.equal(state.lastPruneTurn, 0, 'no re-prune fired');
  });
});

describe('maybePruneHistory — re-prunes past PRUNE_BATCH_TURNS threshold', () => {
  test('a 30-turn gap triggers a real re-prune (non-trivial change)', () => {
    const state = createPruneState();
    const KEEP_LAST = 3;

    const messages = buildMessages(4);
    const turn0Result = maybePruneHistory(messages, state, 0, KEEP_LAST);
    const turn0ImageCount = countImageBlocks(turn0Result);
    // 4 turns × 1 screenshot = 4 images; pruning keeps last 3 →
    // 3 images, 1 elided.
    assert.equal(turn0ImageCount, 3, 'baseline keeps last 3 screenshots');

    // Accumulate 26 MORE turns without re-pruning. Between prunes the
    // pruner accepts a temporary overshoot (the trade-off for cache
    // stability). At turn 26, all 30 turns' screenshots are present
    // in the returned array.
    for (let i = 4; i < 30; i++) {
      messages.push(assistantToolUse(i));
      messages.push(userToolResultWithScreenshot(i));
    }

    // Turn 25 — at threshold (25 ≥ PRUNE_BATCH_TURNS = 25). Should re-prune.
    const turn25Result = maybePruneHistory(messages, state, 25, KEEP_LAST);
    assert.equal(state.lastPruneTurn, 25, 'lastPruneTurn must advance to 25');

    const turn25ImageCount = countImageBlocks(turn25Result);
    // After re-prune, the 30 accumulated screenshots collapse back to 3.
    assert.equal(turn25ImageCount, 3, 'after re-prune, only last 3 screenshots remain');

    // The cached array reference must have changed (it's a fresh snapshot).
    assert.notStrictEqual(
      state.cachedPrunedMessages,
      turn0Result,
      'cache reference must update on re-prune',
    );
  });
});

describe('maybePruneHistory — rewind detection forces re-prune', () => {
  test('pop+push (admin-guidance branch in mapAction) invalidates cache', () => {
    const state = createPruneState();
    const messages = buildMessages(8);

    const t0 = maybePruneHistory(messages, state, 0, 3);
    assert.equal(state.lastPruneTurn, 0);
    const lastPrunedRef = state.cachedPrunedMessages;

    // Simulate the admin-guidance rewind: drop the last assistant turn,
    // append a user-text hint. messages.length unchanged but content
    // shifted at the boundary.
    messages.pop();
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'Hint from your supervisor: try Reports submenu' }],
    });

    // Turn 1 — should detect rewind and re-prune even though we're well
    // inside the batch window.
    const t1 = maybePruneHistory(messages, state, 1, 3);
    assert.equal(state.lastPruneTurn, 1, 'rewind forces re-prune');
    assert.notStrictEqual(t1, t0, 'returned array is a fresh snapshot, not the cached one');
    assert.notStrictEqual(
      state.cachedPrunedMessages,
      lastPrunedRef,
      'cache reference updated after rewind-triggered prune',
    );
  });

  test('shrunk messages array also forces re-prune', () => {
    const state = createPruneState();
    const messages = buildMessages(8);

    maybePruneHistory(messages, state, 0, 3);
    const cachedRef = state.cachedPrunedMessages;

    messages.pop(); // length now < messagesLengthAtLastPrune

    maybePruneHistory(messages, state, 1, 3);
    assert.equal(state.lastPruneTurn, 1, 'shrunk length forces re-prune');
    assert.notStrictEqual(
      state.cachedPrunedMessages,
      cachedRef,
      'cache reference updated after shrink-triggered prune',
    );
  });
});

// Build a user message with a tool_result containing a huge text block
// (e.g. a 50K-char DOM tree from read_page).
function userToolResultWithBigText(stepIdx: number, charCount: number): Msg {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `toolu_${stepIdx}`,
        content: [
          { type: 'text', text: 'B'.repeat(charCount) },
        ],
      },
    ],
  };
}

function findFirstToolResultText(msg: Msg): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;
  for (const block of msg.content) {
    if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
    for (const inner of block.content) {
      if (inner.type === 'text') return inner.text;
    }
  }
  return undefined;
}

describe('maybePruneHistory — tail truncation between batched prunes (Codex finding 1)', () => {
  test('huge text block in the no-prune tail is truncated, not sent raw', () => {
    const state = createPruneState();
    const messages = buildMessages(2);

    // Establish the cache baseline.
    maybePruneHistory(messages, state, 0, 3);

    // Turn 1: a read_page lands with 50K chars of DOM tree in the
    // user's tool_result. This is well under PRUNE_BATCH_TURNS so the
    // batched prune does NOT fire — but we still must NOT ship the
    // 50K block raw to Anthropic.
    const hugeCharCount = 50_000;
    messages.push(assistantToolUse(2));
    messages.push(userToolResultWithBigText(2, hugeCharCount));

    const turn1 = maybePruneHistory(messages, state, 1, 3);
    assert.equal(state.lastPruneTurn, 0, 'batched prune did NOT fire — correct, we are within the window');

    // The big text block in the tail must be capped at
    // READ_PAGE_TRUNCATE_CHARS plus a "[…truncated N chars…]" suffix.
    const sentBigText = findFirstToolResultText(turn1[turn1.length - 1]);
    assert.ok(sentBigText !== undefined, 'tail tool_result text must be present');
    assert.ok(
      sentBigText!.length < hugeCharCount,
      `tail text must be shorter than input (got ${sentBigText!.length}, raw was ${hugeCharCount})`,
    );
    assert.match(sentBigText!, /…truncated \d+ chars/, 'must contain truncation marker');
    assert.ok(
      sentBigText!.startsWith('B'.repeat(READ_PAGE_TRUNCATE_CHARS_FIXTURE)),
      'kept-prefix length must match READ_PAGE_TRUNCATE_CHARS',
    );
  });

  test('idempotent: trimming twice produces the same output (cache stability)', () => {
    const state = createPruneState();
    const messages = buildMessages(2);
    maybePruneHistory(messages, state, 0, 3);

    // Add two new turns, the second with a huge text block.
    messages.push(assistantToolUse(2));
    messages.push(userToolResultWithBigText(2, 50_000));

    // Two consecutive no-prune calls must produce identical tail bytes
    // (cached prefix is the same array; tail is freshly trimmed each
    // time but trim() is pure on identical input).
    const turnA = maybePruneHistory(messages, state, 1, 3);
    const turnB = maybePruneHistory(messages, state, 2, 3);

    assert.equal(
      JSON.stringify(turnA),
      JSON.stringify(turnB),
      'consecutive no-prune calls on identical messages must produce identical wire bytes',
    );
  });
});

describe('trimBigTextInMessage — per-message pure truncation', () => {
  test('truncates text block over the cap', () => {
    const msg = userToolResultWithBigText(0, 50_000);
    const trimmed = trimBigTextInMessage(msg);
    const text = findFirstToolResultText(trimmed);
    assert.ok(text!.length < 50_000);
    assert.match(text!, /…truncated/);
  });

  test('returns the SAME reference when nothing changes (cache-friendly)', () => {
    // A small text block that doesn't trip the cap should pass through
    // untouched — and the function must return the SAME object so callers
    // that rely on referential equality (for cache stability) work.
    const small: Msg = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't',
          content: [{ type: 'text', text: 'short status' }],
        },
      ],
    };
    const result = trimBigTextInMessage(small);
    assert.strictEqual(result, small, 'no-op must return the exact same reference');
  });

  test('non-user message passes through unchanged', () => {
    const assistant: Msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'thinking output' }],
    };
    const result = trimBigTextInMessage(assistant);
    assert.strictEqual(result, assistant);
  });
});

describe('pruneOldHistory — pure-function behavior preserved', () => {
  test('elides older screenshots past keepLast', () => {
    const messages = buildMessages(5); // 5 screenshots
    const pruned = pruneOldHistory(messages, 2);
    assert.equal(countImageBlocks(pruned), 2, 'keeps last 2 screenshots');
  });

  test('keepLast=0 elides every screenshot', () => {
    const messages = buildMessages(3);
    const pruned = pruneOldHistory(messages, 0);
    assert.equal(countImageBlocks(pruned), 0);
  });

  test('does not mutate the input array', () => {
    const messages = buildMessages(3);
    const before = JSON.stringify(messages);
    pruneOldHistory(messages, 1);
    assert.equal(JSON.stringify(messages), before, 'input untouched');
  });
});
