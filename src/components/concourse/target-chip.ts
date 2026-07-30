// ═══════════════════════════════════════════════════════════════════════════
// "Staxis sees a pattern here →" — the rules, with no React and no network.
//
// THE PRODUCT DECISION THIS FILE ENCODES (founder, 2026-07-26)
// When a manager is looking at a specific THING that has an open pattern — room
// 214's work order, an inventory item — one line appears ON THAT THING and links
// to the SAME card in the Staxis queue.
//
//   ON THE THING, NOT THE TAB. No strip at the top of any section tab. No
//   second inbox. No duplicated card state anywhere.
//
// The chip is a signpost and nothing more: it carries no summary, no dollar
// figure, no buttons, no status. Everything a manager can READ or DECIDE about a
// finding lives in the queue, in one place, so there is exactly one card to keep
// in sync and exactly one place a decision can be made.
//
// That is why this module is this small, and why it must stay that way. The day
// this file starts formatting a price is the day the chip has become a second
// card.
// ═══════════════════════════════════════════════════════════════════════════

export type Lang = 'en' | 'es';

/**
 * Where the queue opens the card. The queue view owns `?focus=` — this module
 * only builds the link.
 */
export function queueFocusHref(findingId: string): string {
  return `/feed?focus=${encodeURIComponent(findingId)}`;
}

/**
 * The lookup this chip makes, or null when there is nothing to look up.
 *
 * THIS IS WHERE "ON THE THING, NOT THE TAB" IS ENFORCED ON THE CLIENT. No
 * property or no specific thing means no request — so a chip mounted anywhere
 * that is not about one room or one item does not merely render empty, it never
 * asks. The server half of the same rule is that /api/findings/for-target
 * refuses a request with no `value`: there is no shape of question that returns
 * a whole hotel's patterns to this surface.
 */
export function patternChipUrl(
  propertyId: string | null | undefined,
  kind: string,
  value: string | null | undefined,
): string | null {
  const pid = (propertyId ?? '').trim();
  const target = (value ?? '').trim();
  if (!pid || !target || !kind) return null;
  return (
    '/api/findings/for-target'
    + `?propertyId=${encodeURIComponent(pid)}`
    + `&kind=${encodeURIComponent(kind)}`
    + `&value=${encodeURIComponent(target)}`
  );
}

export interface PatternChip {
  /** The card this points at: the worst one, when a thing has more than one. */
  href: string;
  /** The whole chip. One line, both languages, arrow included. */
  text: string;
  /** How many open patterns this thing has. The rest are in the queue too. */
  count: number;
}

/**
 * The chip for a thing, or null when there is nothing to point at.
 *
 * Null is the overwhelmingly common case and it must render as NOTHING — not an
 * empty box, not "no patterns found". A room with nothing wrong should look
 * exactly like it did before this feature existed.
 */
export function chipFor(findingIds: readonly string[], lang: Lang): PatternChip | null {
  const ids = findingIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return null;

  // Plural is not decoration. "a pattern" printed over three of them is a small
  // lie, and this system's whole claim on a manager's attention is that it does
  // not tell small lies about its own numbers.
  const text =
    ids.length === 1
      ? 'Staxis sees a pattern here →'
      : `Staxis sees ${ids.length} patterns here →`;

  return { href: queueFocusHref(ids[0]), text, count: ids.length };
}

// ─── Reading a room number off a work order ─────────────────────────────────

/**
 * The room a work order is about, or null when it is not about a room.
 *
 * `work_orders.location` is free text a person typed — "214", "Room 214",
 * "Habitación 214", "Lobby", "Pool pump". Detectors key rooms on the number as
 * printed on the door, so a lookup needs the number back out.
 *
 * DELIBERATELY STRICT. Either the whole field is a number, or it starts with a
 * word that means "room". "Ice machine 3" is not room 3, and a chip on the wrong
 * thing costs more trust than a missing chip on the right one — a manager who
 * sees one wrong pattern stops believing the correct ones.
 */
export function roomNumberFromLocation(location: string | null | undefined): string | null {
  const text = (location ?? '').trim();
  if (text.length === 0) return null;

  // The whole field is the number: "214", "0214".
  if (/^\d{1,5}$/.test(text)) return text;

  // "Room 214", "Rm. 214", "room #214", "Habitación 214", "Hab 214".
  const named = /^(?:rooms?|rms?|habitaci[oó]n(?:es)?|habs?)\.?\s*#?\s*(\d{1,5})\b/i.exec(text);
  return named ? named[1] : null;
}
