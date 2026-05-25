/**
 * History pruning for the per-target / per-login agent loops in mapper.ts.
 *
 * Extracted from mapper.ts so the pure-function logic can be unit-tested
 * in isolation. mapper.ts pulls in supabase / Playwright at module load,
 * which fails in a bare `node:test` run on Node 20 (no native WebSocket).
 * This module is dependency-free apart from the Anthropic SDK TYPE import.
 *
 * --- Design ---
 *
 * Anthropic best-practices for computer/browser use
 * (https://claude.com/blog/best-practices-for-computer-and-browser-use-
 * with-claude) calls for pruning older heavy content in BATCHES (~25
 * turns), not every turn. Eliding on every turn shifts the elision
 * boundary by one each call — the BYTE content of "older" messages
 * changes turn-over-turn, which invalidates any prompt-cache breakpoint
 * we (or future code) place on conversation history.
 *
 * `maybePruneHistory` caches the most recent pruned output and how many
 * input messages it covered. Between prune events, it splices that
 * cached prefix in front of the new tail messages — the prefix bytes are
 * IDENTICAL to what we sent last turn, so cache hits. At threshold we
 * re-prune the whole array, accepting a one-turn cache miss amortized
 * over the next 25 turns.
 *
 * --- Pre-existing pruning shape (unchanged from mapper.ts) ---
 *
 * Two passes inside pruneOldHistory:
 *   1. ELIDE — older instances (past `keepLast`) of screenshots and
 *      large text blocks (read_page output, get_page_text) become a
 *      one-line marker.
 *   2. TRUNCATE — even kept text blocks are capped at
 *      READ_PAGE_TRUNCATE_CHARS, with a clear note so the agent knows
 *      output was clipped. CA's DOM trees are 100K+ chars — sending
 *      one whole one burns the budget on its own.
 *
 * Diagnosed 2026-05-09 from CA canary v4 — 3/4 actions all failed at
 * "token budget exceeded" despite reaching the right URL.
 */

import type Anthropic from '@anthropic-ai/sdk';

// Pruning batch cadence. Anthropic best-practices: prune older heavy
// content in BATCHES (not every turn) so the byte-content of older
// messages is stable between prunes. Stable bytes are a prerequisite
// for prompt caching of conversation history. Without batching, every
// turn re-elides the same boundary in a slightly different position →
// any future cache breakpoint on history would invalidate every turn.
// 25 turns matches Anthropic's documented pattern.
export const PRUNE_BATCH_TURNS = 25;

// Truncate any single read_page or get_page_text result over this size.
// 20K chars ≈ 5-6K tokens. Most pages have a few hundred interactive
// elements; this is more than enough for navigation, less than enough
// to drown the agent in noise.
export const READ_PAGE_TRUNCATE_CHARS = 20_000;

// Threshold above which a text block in a tool_result is considered "big"
// and eligible for elision. Below this we always keep verbatim (avoids
// eliding short "Clicked at (320, 480)." status strings).
const BIG_TEXT_THRESHOLD = 1500;

function trimText(text: string): string {
  if (text.length <= READ_PAGE_TRUNCATE_CHARS) return text;
  const head = text.slice(0, READ_PAGE_TRUNCATE_CHARS);
  return `${head}\n\n[…truncated ${text.length - READ_PAGE_TRUNCATE_CHARS} chars — page is large; use \`find\` for narrower searches]`;
}

/**
 * Per-message text-truncation pass. NO elision (that requires global
 * state — image/text counts across all messages). Pure function: maps
 * any `text` block in a `tool_result` to a length-capped version.
 *
 * Safe to call on the fresh tail every turn, in addition to the
 * batched whole-history prune. Catches the "100K-char DOM tree just
 * came back on read_page" case that would otherwise sit raw in the
 * tail for up to PRUNE_BATCH_TURNS turns. (Codex review finding 1.)
 *
 * Idempotent: trimText applied twice yields the same output.
 * Preserves byte-identical content across consecutive calls on
 * unchanged input — important for cache stability.
 */
export function trimBigTextInMessage(
  msg: Anthropic.Messages.MessageParam,
): Anthropic.Messages.MessageParam {
  if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
  let touched = false;
  const newContent = msg.content.map((block) => {
    if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
    let innerTouched = false;
    const inner = block.content.map((b) => {
      if (b.type === 'text' && b.text.length > READ_PAGE_TRUNCATE_CHARS) {
        innerTouched = true;
        return { ...b, text: trimText(b.text) };
      }
      return b;
    });
    if (!innerTouched) return block;
    touched = true;
    return { ...block, content: inner };
  });
  return touched ? { ...msg, content: newContent } : msg;
}

/**
 * Pure function — walks the message history and returns a new array with
 * older heavy content elided. Does NOT mutate the input.
 */
export function pruneOldHistory(
  messages: Anthropic.Messages.MessageParam[],
  keepLast: number,
): Anthropic.Messages.MessageParam[] {
  let imagesSeen = 0;
  let bigTextSeen = 0;

  const reversed = [...messages].reverse().map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map((block) => {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = block.content.map((b) => {
          if (b.type === 'image') {
            imagesSeen++;
            if (imagesSeen > keepLast) {
              return { type: 'text' as const, text: '[older screenshot elided]' };
            }
            return b;
          }
          if (b.type === 'text' && b.text.length > BIG_TEXT_THRESHOLD) {
            bigTextSeen++;
            if (bigTextSeen > keepLast) {
              return { type: 'text' as const, text: `[older read_page output elided — was ${b.text.length} chars]` };
            }
            // Kept — but still truncate if very large.
            return { ...b, text: trimText(b.text) };
          }
          return b;
        });
        return { ...block, content: inner };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
  return reversed.reverse();
}

/**
 * Batched-pruning state for one per-target / per-login agent loop.
 *
 * One state per agent loop; not safe to reuse across loops.
 */
export interface PruneState {
  /** Turn index at which we last fully pruned. Init -∞ so the FIRST call
   *  always prunes (establishing the baseline cache). */
  lastPruneTurn: number;
  /** Pruned snapshot of `messages` at the last prune. Reused as the
   *  byte-stable prefix between prunes. `null` until first prune. */
  cachedPrunedMessages: Anthropic.Messages.MessageParam[] | null;
  /** `messages.length` when we last pruned — used to splice new tail
   *  messages onto the cached prefix between prune events. */
  messagesLengthAtLastPrune: number;
  /** Reference to `messages[messagesLengthAtLastPrune - 1]` at last
   *  prune. If a caller does `messages.pop(); messages.push(...)` (the
   *  admin-guidance rewind in mapAction), length is unchanged but this
   *  reference shifts — we use that to force a re-prune. `null` before
   *  the first prune or when messagesLengthAtLastPrune is 0. */
  lastMessageRefAtPrune: Anthropic.Messages.MessageParam | null;
}

export function createPruneState(): PruneState {
  return {
    lastPruneTurn: Number.NEGATIVE_INFINITY,
    cachedPrunedMessages: null,
    messagesLengthAtLastPrune: 0,
    lastMessageRefAtPrune: null,
  };
}

/**
 * Return the message history to send to Anthropic THIS turn, applying
 * batched pruning per Anthropic best-practices.
 *
 * Contract:
 *  - First call with fresh state: prunes (sets baseline), returns pruned snapshot.
 *  - Subsequent calls within PRUNE_BATCH_TURNS of last prune: returns
 *    `cachedPrunedMessages + messages.slice(messagesLengthAtLastPrune)` —
 *    the prefix is byte-identical to last turn, the tail is fresh.
 *  - Once `turn - lastPruneTurn >= PRUNE_BATCH_TURNS`: re-prunes the full
 *    current `messages`, refreshes the cache, returns the new snapshot.
 *
 * Invariants:
 *  - `messages` itself is never mutated.
 *  - Between prunes, `result.slice(0, cachedPrunedMessages.length)` is
 *    referentially equal to the previous turn's return value's prefix.
 *  - When the caller rewinds (`messages.pop(); messages.push(...)` or
 *    just `messages.pop()`), we re-prune unconditionally to avoid
 *    splicing a stale cached prefix onto a now-different array.
 */
export function maybePruneHistory(
  messages: Anthropic.Messages.MessageParam[],
  state: PruneState,
  turn: number,
  keepLast: number,
): Anthropic.Messages.MessageParam[] {
  const turnsSinceLastPrune = turn - state.lastPruneTurn;
  // Rewind detection: either the length shrank, OR the message at the
  // last-prune boundary was replaced in-place (the mapAction admin-
  // guidance branch does `messages.pop(); messages.push(hint)`, leaving
  // length unchanged but content shifted). Either case invalidates the
  // cached prefix → force a re-prune.
  const messagesRewound =
    messages.length < state.messagesLengthAtLastPrune ||
    (state.messagesLengthAtLastPrune > 0 &&
      messages[state.messagesLengthAtLastPrune - 1] !== state.lastMessageRefAtPrune);
  const shouldPrune =
    state.cachedPrunedMessages === null ||
    messagesRewound ||
    turnsSinceLastPrune >= PRUNE_BATCH_TURNS;

  if (!shouldPrune) {
    // No-op for the cached prefix; append any new tail messages with
    // per-block big-text truncation applied (the elision pass needs
    // global counts so it stays in pruneOldHistory, but per-block
    // truncation is pure-per-message and is safe to run every turn).
    //
    // Without this, a single 100K-char read_page result in the tail
    // would sit raw in the message history for up to PRUNE_BATCH_TURNS
    // turns — burning the input-token budget. (Codex review finding 1.)
    //
    // The prefix bytes are unchanged from the prior turn (still the
    // cached array) → safe to cache. trimBigTextInMessage is
    // idempotent, so the trimmed tail bytes are also identical to
    // last turn (assuming the same messages were in the tail then).
    const cached = state.cachedPrunedMessages!;
    const rawTail = messages.slice(state.messagesLengthAtLastPrune);
    if (rawTail.length === 0) return cached;
    const trimmedTail = rawTail.map(trimBigTextInMessage);
    return [...cached, ...trimmedTail];
  }

  const pruned = pruneOldHistory(messages, keepLast);
  state.cachedPrunedMessages = pruned;
  state.lastPruneTurn = turn;
  state.messagesLengthAtLastPrune = messages.length;
  state.lastMessageRefAtPrune =
    messages.length > 0 ? messages[messages.length - 1] : null;
  return pruned;
}
