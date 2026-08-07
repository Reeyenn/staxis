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

import type { AppSection, EnabledSections } from '@/lib/sections/registry';
import { isSectionEnabled } from '@/lib/sections/registry';
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

/**
 * The attribute a surface the COMPANION AUTHORED carries.
 *
 * Not a third permission idea and not a styling hook: it is the answer to one
 * question the pointer has to be able to ask before it picks a side, which is
 * "is the space I am about to take already something I said?".
 *
 * The founder's rule, from a screenshot of the intro pointer sitting on top of
 * a Staxis-found card: the companion may land on a plain to-do row if there is
 * nowhere else, and may never land on another companion surface while any
 * alternative exists. A to-do row is the hotel's own work with a title you can
 * still read past a card; two dark cards on top of each other is the product
 * arguing with itself in front of the person it is talking to.
 *
 * It goes on the OUTER box of anything Staxis speaks through: the found and
 * decision cards on the one list, the morning brief, the offer peek beside the
 * mark, the notices list. Adding it to a new one is one attribute; forgetting
 * is the pointer treating that surface as empty page.
 */
export const COMPANION_SURFACE_ATTR = 'data-staxis-surface';

/** Every companion surface currently on the screen, for the pointer to avoid. */
export const COMPANION_SURFACE_SELECTOR = `[${COMPANION_SURFACE_ATTR}]`;

export type CompanionAnchorKey =
  | 'inventory-import'
  | 'add-delivery'
  | 'todo-composer'
  | 'knows-teach'
  | 'staxis-mark'
  | 'nav-staxis'
  | 'nav-dashboard'
  | 'nav-inventory'
  | 'nav-maintenance'
  | 'nav-communications';

/**
 * Where a control lives, in the companion's own page vocabulary.
 *
 * `any` is the APP CHROME: the pill bar and the mark in the corner are on every
 * screen the companion is allowed to exist on, so scoping them to one page
 * would be a lie in seven places out of eight. It is NOT a wildcard that
 * loosens the page wall: `staxis_point_at` still refuses a turn with no screen
 * behind it at all, so the companion can no more point at the nav from an
 * eval harness than it can point at the importer from Maintenance.
 */
export type CompanionAnchorPage = CompanionPageKey | 'any';

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
  /**
   * The hotel's own section switches, or undefined when the asker did not say.
   *
   * A pill for a section this hotel switched off is not on the bar at all, so
   * pointing at it would be the companion drawing an arrow at empty chrome.
   * Undefined reads as "all on", which is the same default-ON contract
   * `isSectionEnabled` has everywhere else: a hotel with no stored map has
   * every section, and treating a missing map as "everything is off" would
   * silently unaim every nav pointer at every hotel.
   */
  enabledSections?: EnabledSections;
}

/** Fail closed on ENTITLEMENTS. An asker who did not say what they can do is
 *  told nothing that needs one. Sections are the other way round on purpose;
 *  see `enabledSections` above. */
const NO_STANDING: CompanionAnchorStanding = { canManage: false, seesMoney: false };

export interface CompanionAnchor {
  key: CompanionAnchorKey;
  /** The screen this control lives on, or `any` for the app chrome. */
  page: CompanionAnchorPage;
  /** What a person calls it. Matches the label on the control itself. */
  label: string;
  /** One plain sentence: what it does FOR them. Shown to the model, and said
   *  out loud when the companion points at it from a conversation. */
  does: string;
  /** The entitlements the page itself requires before rendering this control. */
  needs: readonly CompanionAnchorNeed[];
  /** The hotel switch that has to be on before this control is rendered at
   *  all. Null for chrome that no section owns. */
  section?: AppSection;
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
    section: 'staxis',
  },
  {
    key: 'knows-teach',
    // The Knows view is a dialog over /feed, and `pageForPath` resolves that
    // path to `staxis`. Declaring it as `knows` would have produced an anchor
    // no page proof could ever match, which is a control the companion can
    // name and never point at.
    page: 'staxis',
    label: 'Teach it something',
    does: 'Tells me one fact about your hotel, in your own words, so I use it from then on.',
    // /api/memory/knows returns canTeach only for a manager with mutation
    // standing. A front desk hire never has this button.
    needs: ['manage'],
    section: 'staxis',
  },
  {
    key: 'staxis-mark',
    page: 'any',
    label: 'the Staxis mark in the corner',
    does: 'Opens me. Ask me anything about the hotel, or ask where something is and I will point at it.',
    needs: [],
  },
  // ─── The pill bar ─────────────────────────────────────────────────────────
  //
  // One per section the companion has a page for. `people` and `settings` have
  // no pill of their own, so they have no anchor either: an anchor for a
  // control that is not on the bar would be a promise the browser has to break.
  {
    key: 'nav-staxis',
    page: 'any',
    label: 'Staxis',
    does: 'Opens the one list where everything that needs a decision turns up.',
    needs: [],
    section: 'staxis',
  },
  {
    key: 'nav-dashboard',
    page: 'any',
    label: 'Dashboard',
    does: 'Opens the hotel at a glance: who is in house, what is arriving, what is not ready.',
    needs: [],
    section: 'dashboard',
  },
  {
    key: 'nav-inventory',
    page: 'any',
    label: 'Inventory',
    does: 'Opens what you have on hand and what is running low.',
    needs: [],
    section: 'inventory',
  },
  {
    key: 'nav-maintenance',
    page: 'any',
    label: 'Maintenance',
    does: 'Opens your work orders and the jobs that come round again.',
    needs: [],
    section: 'maintenance',
  },
  {
    key: 'nav-communications',
    page: 'any',
    label: 'Messages',
    does: 'Opens where your team talks and where notices are posted.',
    needs: [],
    section: 'communications',
  },
];

/**
 * Would this control be on the screen the person is standing on?
 *
 * `any` matches every real page and NO page at all: a caller with no page
 * proof passes null and is refused, which keeps the fail-closed rule the page
 * wall has always had.
 */
export function anchorMatchesPage(
  anchor: CompanionAnchor,
  page: CompanionPageKey | null | undefined,
): boolean {
  if (!page) return false;
  return anchor.page === 'any' || anchor.page === page;
}

/** Is this control on this person's screen at all? */
export function anchorIsReachable(
  anchor: CompanionAnchor,
  standing: CompanionAnchorStanding = NO_STANDING,
): boolean {
  for (const need of anchor.needs) {
    if (need === 'manage' && !standing.canManage) return false;
    if (need === 'money' && !standing.seesMoney) return false;
  }
  if (anchor.section && !isSectionEnabled(standing.enabledSections, anchor.section)) return false;
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
  return COMPANION_ANCHORS.filter((a) => anchorMatchesPage(a, page) && anchorIsReachable(a, standing));
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
