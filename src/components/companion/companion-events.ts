// ═══════════════════════════════════════════════════════════════════════════
// Two signals the rest of the app sends the companion.
//
// A window event rather than a context or a prop, for the same reason
// ask-command-bridge.ts is one: the companion is mounted once at the app shell
// and the things that need to talk to it are ordinary screens deep inside their
// own trees. Threading a callback down to them would have put the companion
// into the props of components that have nothing to do with it.
//
//   FLOW COMPLETED   somebody just finished, by hand, a job the companion could
//                    have done. Fired AFTER the flow closes, never during.
//   BUSY             somebody is typing or has a form open. The companion goes
//                    quiet while this is true.
//
// Both are advisory. The companion works correctly if a screen never fires
// either one; it is simply less well-mannered.
// ═══════════════════════════════════════════════════════════════════════════

import type { TeachFlow } from '@/lib/companion/manners';
import type { TourDeed } from '@/lib/companion/tour';

export const COMPANION_FLOW_EVENT = 'staxis:companion-flow';
export const COMPANION_BUSY_EVENT = 'staxis:companion-busy';

/**
 * A real write really landed. See DEED below.
 *
 * A THIRD signal rather than a third meaning for FLOW, because the two are
 * about different moments and want opposite things. FLOW says "a job just
 * closed, there may be a tip worth showing", and it is advisory: a screen that
 * never fires it is simply less well-mannered. DEED says "the thing the tour is
 * standing there waiting for has happened", and it is LOad-bearing: a tour stop
 * that never hears it waits forever. Folding them together would have put the
 * tour's only exit condition behind a signal whose whole design note is that
 * it is safe to drop.
 */
export const COMPANION_DEED_EVENT = 'staxis:companion-deed';

/**
 * Tell the companion that a flow just completed by hand.
 *
 * Call it on SUCCESS only. A tip after a failed save would be the app answering
 * "that did not work" with "you know, there is an easier way".
 */
export function reportCompanionFlow(flow: TeachFlow, target: Window = window): void {
  target.dispatchEvent(new CustomEvent(COMPANION_FLOW_EVENT, { detail: { flow } }));
}

export function subscribeToCompanionFlow(
  onFlow: (flow: TeachFlow) => void,
  target: Window = window,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ flow?: unknown }>).detail;
    if (typeof detail?.flow === 'string') onFlow(detail.flow as TeachFlow);
  };
  target.addEventListener(COMPANION_FLOW_EVENT, handler);
  return () => target.removeEventListener(COMPANION_FLOW_EVENT, handler);
}

// ─── DEED ───────────────────────────────────────────────────────────────────
//
// THE ONLY THING THAT MOVES A "YOU TRY" STOP FORWARD.
//
// Call it AFTER the server has confirmed the write, never on the click and
// never optimistically. The whole promise of a `try` stop is that the person
// really did the thing: a tour that advanced on a click would advance on a
// click that failed, and would then tell somebody their to-do is on the list
// when it is not. That is the one sentence this feature must never say.
//
// It is safe to fire when no tour is running. Nothing listens, and nothing
// happens. Screens that own a write do not need to know whether a tour exists.

/** One real write, confirmed. */
export function reportCompanionDeed(deed: TourDeed, target: Window = window): void {
  target.dispatchEvent(new CustomEvent(COMPANION_DEED_EVENT, { detail: { deed } }));
}

export function subscribeToCompanionDeeds(
  onDeed: (deed: TourDeed) => void,
  target: Window = window,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ deed?: unknown }>).detail;
    // A closed list, checked here rather than trusted from the event: this is
    // a window event any script on the page can dispatch, and the tour must
    // not be walkable by a string somebody made up.
    if (detail?.deed === 'todo_created' || detail?.deed === 'fact_taught') {
      onDeed(detail.deed);
    }
  };
  target.addEventListener(COMPANION_DEED_EVENT, handler);
  return () => target.removeEventListener(COMPANION_DEED_EVENT, handler);
}

/** Tell the companion somebody is mid-something. */
export function reportCompanionBusy(busy: boolean, target: Window = window): void {
  target.dispatchEvent(new CustomEvent(COMPANION_BUSY_EVENT, { detail: { busy } }));
}

export function subscribeToCompanionBusy(
  onBusy: (busy: boolean) => void,
  target: Window = window,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ busy?: unknown }>).detail;
    onBusy(detail?.busy === true);
  };
  target.addEventListener(COMPANION_BUSY_EVENT, handler);
  return () => target.removeEventListener(COMPANION_BUSY_EVENT, handler);
}

/**
 * Is the person typing right now?
 *
 * A floor under the explicit BUSY signal, so a screen that never learned to
 * send one still cannot be interrupted mid-sentence. Reads the live focus: an
 * input, a textarea or anything contenteditable means hands on keys.
 *
 * Pure enough to test: the element is passed in rather than read off document.
 */
export function focusIsTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}
