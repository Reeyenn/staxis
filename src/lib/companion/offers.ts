// ═══════════════════════════════════════════════════════════════════════════
// An offer is a TURN, not a notification.
//
// Everything the companion says first — the daily hello, a trace ask, a panel
// ask — is written into the same conversation the panel already shows, as a
// message with a state on it. Before this, those sentences lived for six
// seconds in a pill and then ceased to exist: a person who looked away lost the
// offer, a No was recorded in a ledger nobody could see, and a "not now" could
// never be taken back. A thing the app said out loud should be findable
// afterwards, the way everything else it said is.
//
// THIS MODULE IS PURE. No React, no fetch, no database, no clock of its own.
// The suite runs under --conditions=react-server and cannot mount a component,
// so every rule with a consequence lives here and is tested here. What is left
// in the hook and the bar is wiring.
//
// ─── WHERE THE ROW ACTUALLY LIVES ──────────────────────────────────────────
//
// `agent_messages`, in the conversation the panel is showing, with
// `role = 'system'`. Not a new table, and not a new role: 'system' has been in
// that column's CHECK constraint since migration 0079 and has never been
// written, and the payload rides in the `tool_args` jsonb which is unused on a
// row that is not a tool call. So an offer is a real message in the real
// thread, and NO MIGRATION WAS NEEDED to make it one.
//
// Why not `role = 'assistant'`, which is what an offer sounds like? Because the
// Anthropic Messages API requires the FIRST message in a conversation to be
// `user`, and an offer is by definition the companion speaking before anybody
// typed anything. An assistant row at the top of a thread would 400 the next
// real turn. `decodeStoredHistory` drops every role it does not know, so a
// system row is invisible to the model replay by construction — which is the
// behaviour we want, and it is enforced by that function's existing shape
// rather than by a rule someone has to remember.
//
// ─── ONE DECLINE LEDGER, AND IT IS NOT THIS ONE ────────────────────────────
//
// `state` on an offer is a RENDERING. The never-nag ledger — how many times a
// topic was turned down, and whether it is dropped for good — lives in
// `companion_memory.topics` and nowhere else (see manners.ts). Both are written
// by the same POST /api/companion call from the same event, so there is exactly
// one place a No is counted and the message state is what that No looked like.
// `offerCountsAsDecline` below is the whole of the relationship: it says which
// answers the manners ledger should hear about, and it is the only thing in
// this file that knows the manners ledger exists.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What kind of turn this is.
 *
 * `greeting` is the once-a-day hello, `offer` is an operational thing worth
 * raising, `panel_ask` is the narrow venue for anything about a named person
 * (see decidePanelAsk), and `receipt` is what landed after somebody said yes.
 * A receipt is a turn in the thread for the same reason the offer is: "I made
 * you a ticket" is a thing that was said, and it should still be there
 * tomorrow.
 */
export type CompanionOfferKind = 'greeting' | 'offer' | 'panel_ask' | 'receipt';

export const COMPANION_OFFER_KINDS: readonly CompanionOfferKind[] = [
  'greeting', 'offer', 'panel_ask', 'receipt',
];

/**
 * Where an offer got to.
 *
 *   pending    said, not answered. The mark keeps its cue and the pill stays.
 *   accepted   they said yes and the thing happened (or was drawn).
 *   declined   an explicit No.
 *   dismissed  waved away rather than answered. Counted the same by the
 *              manners ledger — see the header of manners.ts for why — but
 *              rendered honestly as "(dismissed)" rather than as a No they
 *              never actually said.
 *   expired    the app never got an answer and the thing stopped being true.
 *              Only ever set when we KNOW it stopped being true; it is not a
 *              timeout, because "you ignored me" is not a fact about the hotel.
 */
export type CompanionOfferState =
  | 'pending' | 'accepted' | 'declined' | 'dismissed' | 'expired';

export const COMPANION_OFFER_STATES: readonly CompanionOfferState[] = [
  'pending', 'accepted', 'declined', 'dismissed', 'expired',
];

/** One button on an offer. `kind` is what the browser does about it. */
export interface CompanionOfferAction {
  /** The label, already in the companion's voice. */
  readonly label: string;
  /**
   * `show` draws the pattern in the page, `walk` navigates first, `seed` hands
   * a sentence to the chat, `no` closes it. Nothing here is a server action:
   * an offer never writes anything, and the one thing that does (the trace's
   * own button) lives on the drawn card where its receipt can be read.
   */
  readonly kind: 'show' | 'walk' | 'seed' | 'no';
}

/** What was written, when an accepted offer led to a write. */
export interface CompanionOfferReceipt {
  readonly table: string;
  readonly id: string;
  readonly label: string;
  readonly where: string | null;
}

/** One companion turn, as it is stored and as it is rendered. */
export interface CompanionOffer {
  /** `agent_messages.id`. */
  readonly id: string;
  readonly kind: CompanionOfferKind;
  /** The sentence, exactly as it was said. Never re-worded later. */
  readonly text: string;
  /**
   * The manners topic this is about, or null.
   *
   * For a trace offer this IS the pattern key, which is content-derived and
   * survives recomputation (see trace/identity.ts). That is what makes an old
   * offer in the thread re-runnable: the key still names the same problem
   * tomorrow, so tapping it can ask for that pattern again by name.
   */
  readonly topic: string | null;
  /** The screen the pattern is drawn on, when there is one. */
  readonly page: string | null;
  readonly actions: readonly CompanionOfferAction[];
  readonly state: CompanionOfferState;
  /** ISO. When it was said. */
  readonly spokenAt: string;
  /** ISO. When it was answered, or null while pending. */
  readonly answeredAt: string | null;
  readonly receipt: CompanionOfferReceipt | null;
}

/** What the browser reports happened. */
export type CompanionOfferAnswer = 'accepted' | 'declined' | 'dismissed' | 'expired';

/**
 * Does the manners ledger need to hear about this answer?
 *
 * A No and a wave-away are the same act from the person's side, so both are
 * counted (see the "WHY IGNORED AND DECLINED SHARE A COUNTER" note in
 * manners.ts). A yes is reported too, because `rememberAccepted` forgives the
 * topic's earlier declines. An `expired` offer is NOT: nobody answered it, and
 * counting silence as a No would drop topics people never saw.
 *
 * This is the ONE function that knows both ledgers exist, and it is the reason
 * there is still only one: the message state is derived from the same answer
 * this returns a verdict on, in the same request.
 */
export function offerCountsAsDecline(answer: CompanionOfferAnswer): boolean {
  return answer === 'declined' || answer === 'dismissed';
}

/**
 * Apply an answer to an offer, or refuse to.
 *
 * ONCE ONLY. An offer that has already been answered never changes state
 * again, which is what stops a double-tap, a replayed request, or a second tab
 * from counting one No twice — the route asks this before it writes, and a
 * `null` means nothing is written and the manners ledger is not touched either.
 *
 * A `receipt` turn is never answerable: it is a statement of what happened, not
 * a question.
 */
export function answerOffer(
  offer: CompanionOffer,
  answer: CompanionOfferAnswer,
  at: string,
): CompanionOffer | null {
  if (offer.state !== 'pending') return null;
  if (offer.kind === 'receipt') return null;
  return { ...offer, state: answer, answeredAt: at };
}

/** Is this offer still waiting on a person? Drives the mark's has-something cue. */
export function offerIsUnresolved(offer: CompanionOffer): boolean {
  return offer.state === 'pending' && offer.kind !== 'receipt';
}

/**
 * Can tapping this old turn in the thread run it again?
 *
 * Only a trace offer, because only a trace has a pattern key to ask the server
 * for. A greeting has nothing to re-show and a receipt already happened. The
 * STATE deliberately does not matter: revisiting a declined offer is the whole
 * point of writing it down, and "I said no on Tuesday" is not "never show me
 * this". What a No costs is the companion's permission to bring it up
 * unprompted, which is the manners ledger's business and stays true.
 */
export function offerIsReplayable(offer: CompanionOffer): boolean {
  if (offer.kind === 'receipt' || offer.kind === 'greeting') return false;
  return typeof offer.topic === 'string' && offer.topic.length > 0;
}

/** The honest line when a replayed offer no longer computes. */
export const OFFER_STALE_LINE = 'This got handled already, so there is nothing to show you.';

/**
 * Words too common to identify anything.
 *
 * Deliberately tiny. This is not a search engine: it is deciding whether "that
 * AC thing" points at a pattern about air conditioning, and a long stopword
 * list would start throwing away the words people actually use to point.
 */
const HINT_STOPWORDS = new Set([
  'the', 'that', 'this', 'thing', 'those', 'these', 'one', 'about', 'from', 'with',
  'show', 'again', 'and', 'for', 'you', 'your', 'was', 'were', 'said', 'earlier',
  'please', 'can', 'could', 'would', 'what', 'which', 'mentioned', 'me',
]);

function hintWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !HINT_STOPWORDS.has(w));
}

/**
 * Does this phrase point at that sentence?
 *
 * EVERY meaningful word has to land, not just one. "the AC thing" against a
 * haystack about air conditioning matches on "ac"; "the AC thing" against a
 * towel-stock pattern matches nothing. Requiring all of them is what stops a
 * one-word coincidence drawing the wrong diagram — and drawing the WRONG
 * pattern confidently is worse than saying you are not sure which they mean,
 * because the person has no way to tell it picked wrong.
 *
 * A hint with no meaningful words at all ("show me that one") matches nothing
 * here, and the caller falls back to the offer the thread is actually about.
 */
export function hintMatches(hint: string, haystack: string): boolean {
  const words = hintWords(hint);
  if (words.length === 0) return false;
  const hay = hintWords(haystack);
  // A prefix counts, so "cool" finds "cooling" and "rattle" finds "rattles".
  // A suffix does not: matching inside a word turns "ac" into a hit on
  // "backlog", which is exactly the confident-wrong-answer this guards against.
  return words.every((w) => hay.some((h) => h === w || h.startsWith(w)));
}

/** The marker rendered under a turn that was waved away rather than answered. */
export function offerStateNote(state: CompanionOfferState): string | null {
  if (state === 'dismissed') return '(dismissed)';
  if (state === 'declined') return '(no thanks)';
  if (state === 'expired') return '(handled elsewhere)';
  return null;
}

// ─── Storage codec ──────────────────────────────────────────────────────────
//
// The payload is jsonb written by a route and read back on every page load, so
// nothing in it is trusted on the way out. Anything unreadable makes the whole
// row invisible rather than half-rendered: a turn we cannot parse is a turn we
// cannot honestly attribute, and showing a mangled sentence in the companion's
// voice is worse than showing nothing.

/** The discriminator inside `tool_args`. Bumped only if the shape changes. */
export const OFFER_PAYLOAD_VERSION = 1;

/** Longest sentence an offer may carry into the thread. */
export const OFFER_TEXT_MAX = 400;

/** Most buttons one offer may carry. */
export const OFFER_ACTIONS_MAX = 3;

const ACTION_KINDS: readonly CompanionOfferAction['kind'][] = ['show', 'walk', 'seed', 'no'];

interface RawRecord { [key: string]: unknown }

function isRecord(v: unknown): v is RawRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 10 && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The jsonb written to `agent_messages.tool_args`.
 *
 * `tool_name` is deliberately left NULL on the row. The AI metrics route counts
 * every row with a non-null `tool_name` as a tool call (see
 * /api/agent/metrics), so naming this one would quietly inflate the tool-usage
 * numbers with sentences that never called a tool.
 */
export function encodeOfferPayload(offer: Omit<CompanionOffer, 'id' | 'text'>): RawRecord {
  return {
    staxisCompanionOffer: OFFER_PAYLOAD_VERSION,
    kind: offer.kind,
    topic: offer.topic,
    page: offer.page,
    actions: offer.actions.map((a) => ({ label: a.label, kind: a.kind })),
    state: offer.state,
    spokenAt: offer.spokenAt,
    answeredAt: offer.answeredAt,
    receipt: offer.receipt,
  };
}

/**
 * Read one stored row back, or null if it is not an offer we can render.
 *
 * `id` and `content` come from the row's own columns rather than the payload,
 * so a payload that disagrees with the row it is on cannot rename it.
 */
export function parseOfferRow(row: {
  id?: unknown;
  content?: unknown;
  tool_args?: unknown;
  created_at?: unknown;
}): CompanionOffer | null {
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return null;
  const raw = row.tool_args;
  if (!isRecord(raw)) return null;
  if (raw.staxisCompanionOffer !== OFFER_PAYLOAD_VERSION) return null;

  const kind = COMPANION_OFFER_KINDS.includes(raw.kind as CompanionOfferKind)
    ? (raw.kind as CompanionOfferKind)
    : null;
  if (!kind) return null;

  const text = cleanText(row.content, OFFER_TEXT_MAX);
  if (!text) return null;

  const state = COMPANION_OFFER_STATES.includes(raw.state as CompanionOfferState)
    ? (raw.state as CompanionOfferState)
    : 'pending';

  const actions: CompanionOfferAction[] = [];
  if (Array.isArray(raw.actions)) {
    for (const entry of raw.actions.slice(0, OFFER_ACTIONS_MAX)) {
      if (!isRecord(entry)) continue;
      const label = cleanText(entry.label, 40);
      const actionKind = ACTION_KINDS.includes(entry.kind as CompanionOfferAction['kind'])
        ? (entry.kind as CompanionOfferAction['kind'])
        : null;
      if (!label || !actionKind) continue;
      actions.push({ label, kind: actionKind });
    }
  }

  const topic = typeof raw.topic === 'string' && raw.topic.length > 0 && raw.topic.length <= 200
    ? raw.topic
    : null;
  const page = typeof raw.page === 'string' && raw.page.length > 0 && raw.page.length <= 40
    ? raw.page
    : null;

  let receipt: CompanionOfferReceipt | null = null;
  if (isRecord(raw.receipt)) {
    const table = cleanText(raw.receipt.table, 60);
    const receiptId = cleanText(raw.receipt.id, 60);
    if (table && receiptId) {
      receipt = {
        table,
        id: receiptId,
        label: cleanText(raw.receipt.label, 200),
        where: typeof raw.receipt.where === 'string' ? cleanText(raw.receipt.where, 60) || null : null,
      };
    }
  }

  const spokenAt = isIso(raw.spokenAt)
    ? raw.spokenAt
    : isIso(row.created_at) ? (row.created_at as string) : new Date(0).toISOString();

  return {
    id,
    kind,
    text,
    topic,
    page,
    actions,
    state,
    spokenAt,
    answeredAt: isIso(raw.answeredAt) ? raw.answeredAt : null,
    receipt,
  };
}

/**
 * Read one offer back off the wire, or null.
 *
 * The routes hand the browser an already-parsed `CompanionOffer` rather than a
 * raw row, so this re-checks the same fields on the way in. It is expressed as
 * a shim over `parseOfferRow` on purpose: two validators for one shape is how
 * the strict one and the lenient one drift apart, and the strict one is the one
 * that matters.
 */
export function parseOfferWire(value: unknown): CompanionOffer | null {
  if (!isRecord(value)) return null;
  return parseOfferRow({
    id: value.id,
    content: value.text,
    created_at: value.spokenAt,
    tool_args: {
      staxisCompanionOffer: OFFER_PAYLOAD_VERSION,
      kind: value.kind,
      topic: value.topic,
      page: value.page,
      actions: value.actions,
      state: value.state,
      spokenAt: value.spokenAt,
      answeredAt: value.answeredAt,
      receipt: value.receipt,
    },
  });
}

/**
 * Offers oldest first, which is the order a conversation is read in.
 *
 * Ties break on id so two turns written in the same millisecond do not swap
 * places between renders — a thread that reorders itself while somebody is
 * reading it looks like a bug even when both orders are equally true.
 */
export function sortOffers(offers: readonly CompanionOffer[]): CompanionOffer[] {
  return [...offers].sort((a, b) => {
    const byTime = Date.parse(a.spokenAt) - Date.parse(b.spokenAt);
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The newest turn still waiting on somebody, or null.
 *
 * This is what the pill shows and what the mark's cue is about. One at a time,
 * always: the manners engine only ever produces one unresolved offer, and if a
 * second somehow exists (two tabs, a replayed request) the newest wins rather
 * than both being stacked.
 */
export function newestUnresolved(offers: readonly CompanionOffer[]): CompanionOffer | null {
  const live = sortOffers(offers).filter(offerIsUnresolved);
  return live.length === 0 ? null : live[live.length - 1];
}

/**
 * Merge a fresh offer into a list, replacing any earlier version of the same row.
 *
 * The browser holds offers optimistically before the server answers, so the
 * same id arrives twice and the second one is the truth.
 */
export function upsertOffer(
  offers: readonly CompanionOffer[],
  next: CompanionOffer,
): CompanionOffer[] {
  const without = offers.filter((o) => o.id !== next.id);
  return sortOffers([...without, next]);
}
