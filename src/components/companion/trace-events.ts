'use client';

// ═══════════════════════════════════════════════════════════════════════════
// One line on the Staxis list, published by the companion.
//
// ─── WHY A LATCHED STORE AND NOT A WINDOW EVENT ────────────────────────────
// The other companion bridges (companion-events.ts) are fire-and-forget: a
// screen reports that somebody finished a flow, and if nothing is listening the
// moment is simply gone. This is the opposite shape. The companion decides it
// has something to say BEFORE the list finishes mounting, and a plain event
// would be dispatched into an empty room and lost. So the value is held, and a
// subscriber that arrives late is told at once.
//
// ─── WHY THE LIST DOES NOT DECIDE ANYTHING ─────────────────────────────────
// The list renders what it is given and calls back. It does not fetch, does not
// know what a pattern is, and cannot make the line appear. Every rule about
// whether this should be said at all — the frequency cap, a No from last week,
// the one-voice rule, whether the AI layer is even awake — was already applied
// by the manners engine before the line got here. One decision-maker.
//
// The founder's rule this exists for: on the Staxis list, a pattern found on
// another page is ONE PLAIN LINE and the same ask. Not a card, not a second
// design, and never a place where the reveal itself is drawn.
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionReply } from '@/lib/companion/replies';

export interface TraceLine {
  /** The pattern's own key, so a callback cannot be aimed at anything else. */
  topic: string;
  /** The companion's sentence. Already written, by code, from real rows. */
  text: string;
  /** "Found on Maintenance" — the screen a yes walks to. */
  whereFound: string;
  /**
   * The buttons, from the same code-owned table every other companion surface
   * reads. This row used to hardcode "Show me" and "No", which made it a THIRD
   * place a companion button label was written and a third place that could
   * disagree with the other two.
   */
  replies: readonly CompanionReply[];
  /** A button was pressed, by id. The hook resolves the intent. */
  onReply: (replyId: string) => void;
}

type Listener = (line: TraceLine | null) => void;

let current: TraceLine | null = null;
const listeners = new Set<Listener>();

/** The companion says what it has, or that it has nothing. */
export function publishTraceLine(line: TraceLine | null): void {
  // Same object, same sentence: nothing to tell anybody. Without this the
  // publish that runs on every render of the companion would re-render the
  // whole list on every render of the companion.
  if (current === null && line === null) return;
  if (current && line && current.topic === line.topic && current.text === line.text) {
    // Keep the newest callbacks, which close over the newest state, but do not
    // wake the list for a change it cannot see.
    current = line;
    return;
  }
  current = line;
  for (const listener of listeners) listener(current);
}

/** The list asks to be told. It is told immediately, then on every change. */
export function subscribeToTraceLine(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => { listeners.delete(listener); };
}

/** Test seam. Nothing in the product calls this. */
export function resetTraceLineForTest(): void {
  current = null;
  listeners.clear();
}
