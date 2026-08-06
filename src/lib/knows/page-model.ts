// ═══════════════════════════════════════════════════════════════════════════
// The Knows page, as decisions rather than JSX.
//
// The screen is ONE page: a "Teach it something" button on top, and under it a
// single list in two groups — what Staxis noticed by itself, and what people
// told it. Every row is ONE plain sentence, whichever drawer it came out of.
//
// WHY THIS MODULE HAS NO REACT IN IT
// The suite runs under `--conditions=react-server`, where react-dom/server
// refuses to load, so a hooks-using component cannot be mounted in a test. The
// house pattern (see told-knowledge.ts, concourse-queue-honesty.test.ts) is to
// keep the decisions in a plain module and drive THOSE. So the sentence a
// contact becomes, which group a fact lands in, which buttons a row gets and
// what the empty page says are all testable for real here, and KnowsView.tsx
// is the thin shell over it.
//
// FIVE DRAWERS, ONE LIST — AND THE DRAWERS DID NOT MOVE
// A row's `kind` says which store it came out of, because that is what decides
// where an Adjust or a Remove is written back to. Nothing here reads or writes
// anything; it only says what a row IS and what may be done to it. The stores
// are exactly where they were before this screen was rebuilt (see
// docs/knowledge-stores.md and src/lib/agent/knowledge-door.ts).
// ═══════════════════════════════════════════════════════════════════════════

/** Which store a row came out of. Decides where a correction is written. */
export type KnowsItemKind = 'fact' | 'rule' | 'contact' | 'document' | 'sop';

/**
 * The two groups on the page.
 *
 *   noticed  Staxis worked this out by itself. It may be wrong, so the row
 *            offers "That's wrong".
 *   taught   a person said it. Nobody tells a manager their own sentence is
 *            wrong, so the row offers "Remove" instead.
 */
export type KnowsGroup = 'noticed' | 'taught';

/** What each row can do. The whole button set of the page, stated once. */
export type KnowsAction = 'adjust' | 'wrong' | 'remove';

export interface KnowsItem {
  id: string;
  kind: KnowsItemKind;
  group: KnowsGroup;
  /** ONE plain sentence. Never a title plus a subtitle plus a badge. */
  sentence: string;
  /**
   * A dialable href when the sentence carries a phone number.
   *
   * Load-bearing rather than decorative: before this rebuild the emergency
   * numbers lived in a contact directory with a tap-to-call button on every
   * card, and somebody at the front desk with a guest emergency in front of
   * them reached them in one tap. Collapsing the directory into sentences must
   * not quietly take that away, so the number inside the sentence stays a link.
   */
  tel: string | null;
  /**
   * The number EXACTLY as it appears in the sentence, so the row can wrap that
   * substring in the link.
   *
   * Carried separately because `tel` is stripped of formatting ("(409)
   * 555-1234" dials as 4095551234) and searching the sentence for the stripped
   * form finds nothing. Without this the row fell back to appending the raw
   * digits after the sentence, printing the number twice.
   */
  telText: string | null;
  /** ISO timestamp, newest first. Not rendered; it is only the sort key. */
  at: string;
}

// ─── What a row can do ──────────────────────────────────────────────────────

/**
 * The buttons one row gets.
 *
 * Both groups can be corrected. Only the noticed group can be told it is
 * wrong, and only the taught group can be removed, because those two words
 * mean different things to the person reading them: "that's wrong" is a
 * verdict on a guess, and "remove" is taking back something you said.
 */
export function actionsFor(group: KnowsGroup): readonly KnowsAction[] {
  return group === 'noticed' ? ['adjust', 'wrong'] : ['adjust', 'remove'];
}

// ─── Sentences ──────────────────────────────────────────────────────────────

/** Collapse whitespace and cap. Every sentence builder ends here. */
function oneLine(raw: string, max = 400): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Make sure a sentence ends like one. Never adds a second full stop. */
function sentenceCase(raw: string): string {
  const text = oneLine(raw);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A phone number as something a thumb can hit.
 *
 * Formatting punctuation is stripped; a leading +, a short code like 911 and
 * an extension are all left verbatim. Same rule as the directory this replaces
 * (telHref in told-knowledge.ts) — a number saved as "(409) 555-1234" used to
 * produce a href with literal brackets in it.
 */
export function knowsTelHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const dial = String(phone).replace(/[\s().\-–—]/g, '');
  return dial ? `tel:${dial}` : null;
}

/** What kind of contact this is, in words a person uses out loud. */
const CONTACT_ROLE: Record<string, string> = {
  emergency: 'an emergency contact',
  vendor: 'one of your vendors',
  brand: 'a brand contact',
  local: 'a local contact',
};

export interface ContactLike {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  category: string | null;
  createdAt: string;
}

/**
 * A contact row as the sentence somebody would have typed to teach it.
 *
 * "Mike at Ace Plumbing is one of your vendors. 555-0142." The point is that a
 * manager can read the whole directory as a list of things they told Staxis,
 * instead of as a second kind of object with its own screen.
 */
export function contactSentence(contact: ContactLike): string {
  const who = contact.company ? `${oneLine(contact.name, 120)} at ${oneLine(contact.company, 120)}` : oneLine(contact.name, 120);
  if (!who) return '';
  const role = (contact.category && CONTACT_ROLE[contact.category]) || 'a contact';
  const parts = [`${who} is ${role}.`];
  if (contact.phone) parts.push(`${oneLine(contact.phone, 40)}.`);
  if (contact.email) parts.push(`${oneLine(contact.email, 254)}.`);
  if (contact.notes) parts.push(sentenceCase(oneLine(contact.notes, 160)));
  return oneLine(parts.join(' '));
}

/** An uploaded file, as one sentence. */
export function documentSentence(title: string): string {
  const clean = oneLine(title, 200);
  return clean ? `You added a file called ${clean}.` : '';
}

/** A written procedure, as one sentence. */
export function sopSentence(title: string): string {
  const clean = oneLine(title, 200);
  return clean ? `You wrote a procedure called ${clean}.` : '';
}

/** A remembered fact or a standing rule is already a sentence. */
export function plainSentence(text: string): string {
  return sentenceCase(text);
}

// ─── Which group a remembered fact belongs to ───────────────────────────────

/**
 * agent_memory.source, split into the two groups.
 *
 *   explicit_user / correction   a human authored or fixed it → taught
 *   operational / consolidation  the pattern work and the nightly learner
 *   inferred                     pulled out of something uploaded
 *
 * The last three are all "Staxis worked it out", which is exactly the promise
 * the noticed group makes. Anything unrecognised is treated as noticed rather
 * than taught, because claiming a person said something they did not is the
 * worse of the two mistakes.
 */
export function groupForMemorySource(source: string): KnowsGroup {
  return source === 'explicit_user' || source === 'correction' ? 'taught' : 'noticed';
}

// ─── Ordering ───────────────────────────────────────────────────────────────

/** Newest first, stable on ties so the list does not shuffle between reads. */
export function sortKnowsItems(items: readonly KnowsItem[]): KnowsItem[] {
  return [...items].sort((a, b) => {
    const at = Date.parse(b.at) - Date.parse(a.at);
    if (Number.isFinite(at) && at !== 0) return at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface KnowsGroupView {
  group: KnowsGroup;
  title: string;
  items: KnowsItem[];
}

export const GROUP_TITLE: Record<KnowsGroup, string> = {
  noticed: "What it's noticed",
  taught: "What you've taught it",
};

/**
 * The page's two groups, newest first, EMPTY GROUPS DROPPED.
 *
 * A heading over nothing is a claim ("there is a category here and it is
 * bare"); no heading asserts nothing. The whole-page empty state below is the
 * one place the screen is allowed to say there is nothing yet.
 */
export function groupKnowsItems(items: readonly KnowsItem[]): KnowsGroupView[] {
  const out: KnowsGroupView[] = [];
  for (const group of ['noticed', 'taught'] as const) {
    const inGroup = sortKnowsItems(items.filter((i) => i.group === group));
    if (inGroup.length === 0) continue;
    out.push({ group, title: GROUP_TITLE[group], items: inGroup });
  }
  return out;
}

// ─── Copy ───────────────────────────────────────────────────────────────────
//
// English only (founder ruling 2026-07-29) and no em dashes (2026-07-28). The
// word "AI" never appears: the person reading this screen may not know what
// that means, and "Staxis" or "it" says the same thing to everybody.

export const KNOWS_COPY = {
  teachButton: 'Teach it something',
  teachTitle: 'Teach it something',
  /** Ghost text INSIDE the empty box, written for somebody who has never used
   *  anything like this and needs to see the shape of an answer. */
  teachPlaceholder: 'Try: We buy towels from Riz Supply\nTry: Never book deliveries on Fridays\nTry: Our plumber is Mike, 555-0142',
  teachSave: 'Save',
  teachSaving: 'Saving',
  attach: 'Attach a file',
  attachRemove: 'Remove the attached file',
  cancel: 'Cancel',
  adjust: 'Adjust',
  wrong: "That's wrong",
  remove: 'Remove',
  adjustTitle: 'Fix the wording',
  wrongTitle: 'What should it say?',
  wrongOptional: 'You can leave this empty. Staxis will just stop believing it.',
  confirm: 'Confirm',
  emptyTitle: 'Nothing yet.',
  emptyBody: 'It learns as your hotel runs.',
  loadFailed: 'Could not load this right now. Do not read it as "it knows nothing".',
  taughtOk: 'Saved.',
  fileOk: 'Added.',
  removedOk: 'Gone.',
  adjustedOk: 'Updated.',
} as const;

/**
 * What the box's Save button may act on.
 *
 * Kept here rather than inline in the component so the "you cannot save
 * nothing" rule is one decision instead of a disabled attribute somebody can
 * quietly change.
 */
export function canSubmitTeach(text: string, hasFile: boolean): boolean {
  return text.trim().length > 0 || hasFile;
}

/** How long a taught sentence may be. Matches agent_memory.content's CHECK. */
export const TEACH_MAX_CHARS = 500;
