// ═══════════════════════════════════════════════════════════════════════════
// The controls the companion is allowed to point at.
//
// ONE LIST, TWO READERS, AND THAT IS THE WHOLE REASON IT EXISTS.
//
//   The DISCOVERY pointer reads it to know which button its sentence is about.
//   The CHAT pointer reads it to know which buttons the model may name when
//   somebody asks "how do I bring my spreadsheet in".
//
// Before this file the first of those was a string sitting next to some copy
// and the second did not exist. Adding the second by handing the model a free
// text selector would have been the obvious shortcut and the wrong one: a
// model that can pass any CSS selector can draw an arrow at a wage figure, at
// another hotel's row, or at nothing at all. So the model never sees a
// selector. It sees KEYS from this list, scoped to the page the person is
// actually standing on, and a key it invents resolves to nothing and is
// refused in words.
//
// ─── WHY THE DESCRIPTION IS HERE AND NOT IN THE PROMPT ─────────────────────
// `does` is one plain sentence about what the control does for a person. It is
// what the model is shown, and it is also what the chat pointer's popup says
// out loud. Both come from the same string on purpose: the sentence the
// companion used to decide to point at something is the sentence it says when
// it points. A prompt that described these controls separately would be a
// second description of the same button, free to drift.
//
// ─── POINTING AT NOTHING IS IMPOSSIBLE, IN THREE PLACES ────────────────────
//   1. an unknown key resolves to null here, and the tool refuses it
//   2. a key whose page is not the page the person is on is refused too, so
//      the companion cannot draw on a screen it cannot see
//   3. the browser refuses to draw at a node that is missing or measures as
//      zero, which is what every control inside a hidden branch measures as
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionPageKey } from './pages';

/**
 * The attribute a pointable control carries.
 *
 * Deliberately NOT `data-trace-anchor`. That one names a ROW the trace is
 * about (`wo:<id>`), is per-record, and comes and goes with the data. This one
 * names a CONTROL, is per-product, and is as stable as the button itself. One
 * attribute doing both jobs would mean a work order could be pointed at by
 * name from chat.
 */
export const COMPANION_ANCHOR_ATTR = 'data-staxis-anchor';

export type CompanionAnchorKey =
  | 'inventory-import'
  | 'add-delivery'
  | 'todo-composer';

/**
 * What somebody must be entitled to before a control is even ON their screen.
 *
 * NOT a second permission system: these mirror the gates the pages themselves
 * already apply (`canManage` and `canViewFinancials` on the stockroom screen).
 * They exist because the model is TOLD which controls it may point at, and
 * telling a maintenance tech about the importer produces the worst possible
 * answer: a confident "it is this one" with no arrow, because the button was
 * never rendered for them.
 */
export type CompanionAnchorNeed = 'manage' | 'money';

/** What the reader is entitled to, resolved by whoever is asking. */
export interface CompanionAnchorStanding {
  canManage: boolean;
  seesMoney: boolean;
}

/** Fail closed. An asker who did not say what they can do is told nothing that
 *  needs an entitlement. */
const NO_STANDING: CompanionAnchorStanding = { canManage: false, seesMoney: false };

export interface CompanionAnchor {
  key: CompanionAnchorKey;
  /** The screen this control lives on, in the companion's own page vocabulary. */
  page: CompanionPageKey;
  /** What a person calls it. Matches the label on the control itself. */
  label: string;
  /** One plain sentence: what it does FOR them. Shown to the model, and said
   *  out loud when the companion points at it from a conversation. */
  does: string;
  /** The entitlements the page itself requires before rendering this control. */
  needs: readonly CompanionAnchorNeed[];
}

export const COMPANION_ANCHORS: readonly CompanionAnchor[] = [
  {
    key: 'inventory-import',
    page: 'inventory',
    label: 'Import a file',
    does: 'Brings a whole inventory spreadsheet in at once, instead of typing items in one at a time.',
    // The toolbar renders this under `canManage && canViewFinancials`.
    needs: ['manage', 'money'],
  },
  {
    key: 'add-delivery',
    page: 'inventory',
    label: 'Add a delivery',
    does: 'Takes a photo of a delivery invoice and fills in the items and prices from it.',
    // The rail renders this under `canManage`: it can spend the hotel's money.
    needs: ['manage'],
  },
  {
    key: 'todo-composer',
    page: 'staxis',
    label: 'the box at the top of the list',
    does: 'Writes a to-do in plain words, picks who does it and when, and puts it on their list.',
    // Everybody who gets the one-list at all gets the composer.
    needs: [],
  },
];

/** Is this control on this person's screen at all? */
export function anchorIsReachable(
  anchor: CompanionAnchor,
  standing: CompanionAnchorStanding = NO_STANDING,
): boolean {
  for (const need of anchor.needs) {
    if (need === 'manage' && !standing.canManage) return false;
    if (need === 'money' && !standing.seesMoney) return false;
  }
  return true;
}

/** The one this key names, or null. Null is the whole unknown-key defence. */
export function anchorFor(key: string | null | undefined): CompanionAnchor | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > 60) return null;
  return COMPANION_ANCHORS.find((a) => a.key === key) ?? null;
}

/**
 * Everything pointable on one screen BY THIS PERSON. Empty for every screen
 * with nothing, and empty of anything their own hat would not have rendered.
 *
 * The standing argument is optional and defaults to none, which is fail-closed:
 * a caller that forgets it offers only the controls that need no entitlement,
 * rather than offering everything.
 */
export function anchorsOnPage(
  page: CompanionPageKey | null | undefined,
  standing: CompanionAnchorStanding = NO_STANDING,
): CompanionAnchor[] {
  if (!page) return [];
  return COMPANION_ANCHORS.filter((a) => a.page === page && anchorIsReachable(a, standing));
}

/**
 * The selector for a key, or null.
 *
 * Built from the KEY, which came from the list above, so there is no path by
 * which a string somebody sent us becomes a query. The escape is belt and
 * braces on top of that.
 */
export function anchorSelector(key: string | null | undefined): string | null {
  const anchor = anchorFor(key);
  if (!anchor) return null;
  return `[${COMPANION_ANCHOR_ATTR}="${anchor.key.replace(/["\\]/g, '\\$&')}"]`;
}
