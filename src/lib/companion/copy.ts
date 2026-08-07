// ═══════════════════════════════════════════════════════════════════════════
// Everything the companion says out loud, produced by functions.
//
// WHY FUNCTIONS AND NOT A CONSTANTS FILE
// The no-em-dash guard and the English-only rule are enforced by a test that
// CALLS these producers across every role, every candidate shape and every
// failure reason, and reads what comes back (see companion-charter.test.ts,
// the same walk findings-copy-rules.test.ts does). A string assembled inside a
// component would be outside that walk, and the dash that actually shipped last
// time arrived exactly that way: a joiner in one file wrapping a fragment from
// another, with neither file wrong on its own.
//
// So: no user-facing companion sentence is built anywhere but here.
//
// ZERO MODEL CALLS. Every sentence below is deterministic. That is not a cost
// decision, it is an honesty one: the companion speaks unprompted, and a
// sentence a model wrote unprompted is a sentence nobody approved. It also
// means the companion still has a voice when the AI layer is asleep.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import { canManageTeam } from '@/lib/roles';
import type { CompanionAnchorKey } from './anchors';
import { introFor, type CompanionPage, type CompanionPageKey } from './pages';

// ─── Greeting ───────────────────────────────────────────────────────────────

export interface GreetingInput {
  /** Null for a shared or generic login. See sharedLogin below. */
  firstName: string | null;
  role: AppRole;
  /**
   * True when this account is a desk-shared or generic login (front@hotel,
   * "Front Desk"). Greeting a shift by somebody's first name is the single
   * fastest way to feel like a machine pretending, so we greet the room.
   */
  sharedLogin: boolean;
}

/** What the companion is FOR, in the words of the hat that is reading it. */
function roleBlurb(role: AppRole): string {
  switch (role) {
    case 'owner':
    case 'admin':
      return 'I watch the whole hotel and bring you the few things that need you.';
    case 'general_manager':
      return 'I watch the hotel through the day and bring you what needs a decision.';
    case 'front_desk':
      return 'I can look things up while you are at the desk, and put a note where it belongs.';
    case 'maintenance':
      return 'I keep your work orders and the jobs that come round again in one place.';
    case 'housekeeping':
      // Unreachable: mount.ts refuses this hat before a greeting is ever built.
      // Kept so the switch is exhaustive rather than defaulted, because a
      // silent default is how a role sneaks past a gate later.
      return 'I am here if you need me.';
    case 'staff':
      return 'I can look things up for you and put a note where it belongs.';
  }
}

/** The first line the companion ever says to somebody. */
export function welcomeGreeting(input: GreetingInput): string {
  const name = input.sharedLogin ? null : cleanName(input.firstName);
  const hello = name ? `Hello ${name}.` : 'Hello.';
  return `${hello} I am Staxis. ${roleBlurb(input.role)}`;
}

// ─── Saying hello ───────────────────────────────────────────────────────────
//
// TWO SENTENCES, BUILT THE SAME WAY, USED IN TWO PLACES:
//
//   greetingLine   the panel's first line when somebody opens it on an empty
//                  thread. Staxis speaks first, as prose with no bubble.
//   dailyHelloLine the one unprompted hello per hotel-local day.
//
// NOTHING HERE MAY INVENT A NUMBER. `fact` arrives already true or already
// null, counted from what the browser was actually given. When it is null the
// greeting simply has no second half; the daily hello says the hotel is quiet,
// which is the honest thing to say when nothing is pending and is itself a
// claim only made when the count really was zero.
//
// Zero model calls. This is a template over three values.

/** What the daily hello says when there is genuinely nothing to report. */
export const QUIET_TODAY = 'All quiet so far.';

export interface GreetingLineInput {
  firstName: string | null;
  sharedLogin: boolean;
  /** The hour on the wall AT THE HOTEL, 0 to 23, or null if unknown. */
  hour: number | null;
  /** One true sentence about today, or null when there is none to make. */
  fact: string | null;
}

/**
 * "Good morning" only when it IS morning where the hotel is.
 *
 * A null hour means the hotel has no timezone we trust, and the plain "Hello"
 * is correct rather than a coin flip between three greetings.
 */
function timeOfDay(hour: number | null): string {
  if (hour === null || !Number.isFinite(hour)) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The panel's opening line. No filler when there is no fact. */
export function greetingLine(input: GreetingLineInput): string {
  const name = input.sharedLogin ? null : cleanName(input.firstName);
  const opener = name ? `${timeOfDay(input.hour)}, ${name}.` : `${timeOfDay(input.hour)}.`;
  const fact = typeof input.fact === 'string' ? input.fact.trim() : '';
  return fact ? `${opener} ${fact}` : opener;
}

/** The once-a-day hello. Always has something to say, even on a quiet day. */
export function dailyHelloLine(input: GreetingLineInput): string {
  return greetingLine({ ...input, fact: input.fact?.trim() || QUIET_TODAY });
}

/**
 * The one true thing about today, from what the browser already holds.
 *
 * `waiting` is the number of things the companion found worth raising, which
 * arrived with the bootstrap and cost nothing extra to count. Zero is not a
 * fact worth stating on its own, so it returns null and the caller decides
 * whether to say the hotel is quiet or to say nothing at all.
 */
export function todayFact(input: { waiting: number }): string | null {
  const n = Number.isFinite(input.waiting) ? Math.max(0, Math.floor(input.waiting)) : 0;
  if (n === 0) return null;
  return n === 1 ? '1 thing is waiting on you.' : `${n} things are waiting on you.`;
}

/** The offer that rides with the greeting. Yes/No, and No means never again. */
export function tourQuestion(role: AppRole): string {
  return canManageTeam(role)
    ? 'Want me to show you around, one screen at a time?'
    : 'Want me to show you the screens you will use?';
}

/**
 * A first name we are willing to say out loud.
 *
 * Trimmed, first word only, and refused if it looks like a placeholder or an
 * address rather than a person. "Hello front@comfortsuites.com" is worse than
 * "Hello".
 */
export function cleanName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0 || first.length > 30) return null;
  if (first.includes('@')) return null;
  if (!/^[\p{L}][\p{L}'’.-]*$/u.test(first)) return null;
  return first;
}

/**
 * Is this a shared or generic login rather than a person?
 *
 * A desk account called "Front Desk", or one whose display name is an address,
 * is a shift and not somebody. Greeting a shift by name is the fastest way to
 * sound like a machine pretending to know you, and the person reading it is
 * usually the third person to sit at that terminal today.
 *
 * `cleanName` already refuses addresses and anything that is not a plain word.
 * This adds the handful of names that ARE plain words but are job titles.
 */
const GENERIC_NAMES = new Set([
  'front', 'frontdesk', 'desk', 'reception', 'staff', 'manager', 'admin',
  'hotel', 'office', 'team', 'user', 'guest', 'gm', 'owner', 'maintenance',
  'housekeeping', 'laundry', 'test', 'demo',
]);

export function looksSharedLogin(displayName: string | null | undefined): boolean {
  const first = cleanName(displayName ?? null);
  if (!first) return true;
  return GENERIC_NAMES.has(first.toLowerCase());
}

// ─── The one thing it may say ───────────────────────────────────────────────

export interface OfferCopyInput {
  /** Already-computed plain English from an existing surface. */
  text: string;
  /** Name the hotel when this person runs more than one. */
  hotelName: string | null;
  multiHotel: boolean;
}

/**
 * The sentence an unprompted offer shows.
 *
 * MULTI-HOTEL RULE: a VP looking at four hotels must never read a bare "3 rooms
 * are still dirty" and have to guess which building. When this person runs more
 * than one hotel, the statement is prefixed with the hotel it is about, and the
 * prefix comes from the hotel picker's own current context.
 */
export function offerSentence(input: OfferCopyInput): string {
  const body = input.text.trim().replace(/\s+/g, ' ');
  if (!input.multiHotel || !input.hotelName) return body;
  const hotel = input.hotelName.trim().replace(/\s+/g, ' ');
  if (!hotel) return body;
  // Lower-case the first letter only when the sentence starts with an ordinary
  // capitalised word, so "At Comfort Suites, 3 rooms are..." reads right but
  // "At Comfort Suites, PTAC units..." keeps its acronym.
  const joined = /^[A-Z][a-z]/.test(body)
    ? body.charAt(0).toLowerCase() + body.slice(1)
    : body;
  return `At ${hotel}, ${joined}`;
}

/** The question under an offer. Always answerable with a plain yes or no. */
export function offerQuestion(destination: CompanionPage | null): string {
  return destination ? `Want me to take you to ${destination.label}?` : 'Want to look at it?';
}

// ─── Unfinished business ────────────────────────────────────────────────────
//
// An approval card that nobody answered used to vanish at its ten-minute TTL
// and leave no trace: the row went terminal, the browser dropped it, and the
// fact that the companion had asked something and never heard back existed
// nowhere. A colleague would have remembered. This is that memory, and it is
// deliberately the SMALLEST possible version of it.
//
// ONE MENTION, EVER, PER SUBJECT. It goes through the ordinary candidate path,
// so it spends the daily speech budget, honours the minimum gap, cannot be
// raised twice in one day, and is gone for good after two Nos exactly like
// every other topic. Nothing about it is exempt. The manners engine did not
// need a new rule to make this polite; it needed a candidate.
//
// It also never appears the same day it was asked (see unfinishedCandidate),
// because "you did not answer me ten minutes ago" is nagging, not recall.

export interface UnfinishedRecallInput {
  /** The card's own summary of what was proposed, unchanged. */
  summary: string;
  /** Whole days between the hotel's today and the day it was asked. */
  daysAgo: number;
}

/**
 * "Yesterday I asked about this and never heard back: …"
 *
 * NEVER "you ignored me" and never "you did not reply". Silence is not a
 * verdict, and a sentence that treats it as one turns a forgotten card into an
 * accusation. The companion states what it did, states that no answer arrived,
 * and asks once.
 */
export function unfinishedRecallSentence(input: UnfinishedRecallInput): string {
  const summary = input.summary.trim().replace(/\s+/g, ' ');
  const when = input.daysAgo <= 1 ? 'Yesterday' : `${input.daysAgo} days ago`;
  return `${when} I asked about this and never heard back: ${summary}`;
}

/** The question under a recall. A plain yes reopens it; a no is a real no. */
export const UNFINISHED_RECALL_QUESTION = 'Still want that?';

// ─── Arrival ────────────────────────────────────────────────────────────────

/** What the companion says once the screen has actually changed. */
export function arrivalLine(key: CompanionPageKey): string {
  return introFor(key);
}

// ─── Teach at the moment ────────────────────────────────────────────────────
//
// Somebody just did by hand a thing the companion could have done for them.
// This is the one moment where saying "you could have asked me" is helpful
// rather than smug, because they have the whole task fresh in their head and a
// concrete example to hang it on.
//
// THE HARD RULE: every flow named here has a real tool behind it, today. The
// companion may only say "just tell me" about something it can actually do. A
// teach line for a capability that does not exist is the exact failure the
// charter's honesty clause is about, and it is the reason `add a person` is NOT
// on this list: there is no invite or add-staff tool in the agent catalog.
//
// The line is one sentence plus one example, and the example is written the way
// a person would actually say it out loud, not the way a form is laid out.

export type TeachFlow = 'create_task' | 'log_book_entry' | 'announcement';

export interface TeachLine {
  flow: TeachFlow;
  /** The nudge. Never scolding, never "did you know". */
  text: string;
  /** A sentence they could paste in and have work. */
  example: string;
}

export function teachLine(flow: TeachFlow): TeachLine {
  switch (flow) {
    case 'create_task':
      return {
        flow,
        text: 'Next time you can just tell me and I will write it up.',
        example: 'Ask maintenance to check the pool pump on Friday.',
      };
    case 'log_book_entry':
      return {
        flow,
        text: 'Next time you can just tell me and I will put it in the log book.',
        example: 'Log that the ice machine on 2 was leaking at 6pm.',
      };
    case 'announcement':
      return {
        flow,
        text: 'Next time you can just tell me and I will post it for you.',
        example: 'Tell everyone the north lot is closed Saturday morning.',
      };
  }
}

// ─── Pointing at something already on the screen ────────────────────────────
//
// A teach line comes AFTER somebody did a thing by hand. A pointer comes
// BEFORE they know a thing exists: the first time a manager opens a screen,
// the companion names one thing on it that would save them an afternoon.
//
// It is a separate producer from teachLine because the promise is different.
// A teach line says "you could have asked me" about a tool the companion owns.
// A pointer says "that button does this" about a thing the PERSON does. So the
// hard rule here is the mirror of the teach rule: every pointer names a control
// that is actually on the screen it fires on, and it says what the control does
// in the words of the job, not the words of the feature.
//
// ONE PER VISIT. The list is ordered, the caller shows the first one that has
// not been answered, and the second one waits for the next visit. Two pointers
// on one screen is a tour, and nobody asked for a tour.
//
// ─── THE POPUP IS THE POINTING (founder ruling, 2026-08-05) ────────────────
// The first build of this was an inline slab at the top of the page content
// with a "Show me" button that opened the thing being described. It was
// rejected for three separate reasons, and all three are encoded in the shape
// below rather than in a comment on the component:
//
//   • it pushed the whole page down, so a screen somebody came to read moved
//     under them. A pointer now floats and draws a line to the control.
//   • "Show me" was a second step for something that had already been said. The
//     sentence and the arrow arrive together; there is nothing left to reveal,
//     so there is no verb here that opens anything.
//   • the words were the companion describing a feature. They are now the
//     companion describing what a person would DO, which is why the import
//     pointer opens by asking about the spreadsheet they already keep.
//
// So a pointer line carries: the control it points at, its paragraphs, and the
// ways out. No `question`, because it does not ask for permission to show
// something it is already showing.

export type CompanionPointerKey =
  | 'inventory_import'
  | 'inventory_invoices'
  | 'todo_intro';

/**
 * What pressing a pointer's button means.
 *
 *   later  the pointer closes and comes back another day. Nothing is written:
 *          it was stamped with today when it was shown, which is exactly the
 *          promise "Not now" makes.
 *   never  the topic is dropped, permanently, first time asked.
 */
export type PointerAnswer = 'later' | 'never';

export interface PointerButton {
  label: string;
  answer: PointerAnswer;
}

export interface PointerLine {
  key: CompanionPointerKey;
  /**
   * The control this points at, by its `data-staxis-anchor` value.
   *
   * Named HERE, beside the words, because the sentence and the thing it is
   * about are one fact. A pointer whose copy moved to a different control
   * without its anchor moving would be the companion drawing a line at the
   * wrong button, which is worse than saying nothing.
   */
  anchor: CompanionAnchorKey;
  /** What it says. One entry per paragraph; the gap between them is a blank line. */
  paragraphs: readonly string[];
  /** The ways out, left to right. At least one, and at least one of them ends it forever. */
  buttons: readonly PointerButton[];
}

/** The two ways out of a pointer that is worth offering again another day. */
const LATER_OR_NEVER: readonly PointerButton[] = [
  { label: 'Not now', answer: 'later' },
  { label: 'Do not show this again', answer: 'never' },
];

/**
 * The one way out of a pointer somebody ASKED for.
 *
 * Used by the chat pointer, which draws because a person asked where a control
 * was. There is no "not now" on an answer to a question, and no decision to
 * make about ever seeing it again: they asked, they got shown, it is done.
 *
 * It is a producer here rather than a literal in the component for the reason
 * at the top of this file: every companion string a person can read is walked
 * by the copy-rule tests, and the one exception would be the one that shipped
 * a dash.
 */
export function pointerAcknowledgeButtons(): readonly PointerButton[] {
  return [{ label: 'Got it', answer: 'never' }];
}

/** Ordered. Earlier pointers are shown first and only one is shown per visit. */
export const INVENTORY_POINTER_ORDER: readonly CompanionPointerKey[] = [
  'inventory_import',
  'inventory_invoices',
];

/** The Staxis one-list's own pointer, shown on a first visit to that page. */
export const STAXIS_POINTER_ORDER: readonly CompanionPointerKey[] = [
  'todo_intro',
];

export function pointerLine(key: CompanionPointerKey): PointerLine {
  switch (key) {
    case 'inventory_import':
      return {
        key,
        anchor: 'inventory-import',
        paragraphs: [
          'Do you keep your inventory in an Excel spreadsheet?',
          'This button brings the whole file in at once. No typing items one at a time.',
        ],
        buttons: LATER_OR_NEVER,
      };
    case 'inventory_invoices':
      return {
        key,
        anchor: 'add-delivery',
        paragraphs: [
          'When a delivery arrives, snap a photo of the invoice here. I read it and fill in the items and prices for you.',
        ],
        buttons: LATER_OR_NEVER,
      };
    case 'todo_intro':
      return {
        key,
        anchor: 'todo-composer',
        paragraphs: [
          "This is your hotel's to-do list. Type anything here, like 'Fix the ice machine tomorrow,' pick who does it, and it shows up for them.",
        ],
        // ONE button, and it ends the pointer forever. There is nothing to come
        // back for: somebody who has been shown where their own to-do list is
        // does not need telling twice, and a second showing would read as the
        // app doubting they understood. Same button the chat pointer uses,
        // from the same producer, because it means the same thing.
        buttons: pointerAcknowledgeButtons(),
      };
  }
}

// ─── Sleep ──────────────────────────────────────────────────────────────────

export type SleepReason =
  | 'provider_down'
  | 'cost_cap'
  | 'section_off'
  | 'unknown';

/**
 * What the companion says when somebody opens it and the AI layer is down.
 *
 * Plain, short, and it never promises a time. A spinner would be a lie told
 * slowly; "try again later" with a made-up minute count would be a lie told
 * precisely. Each reason gets its own sentence because they need different
 * things from the reader: a cost cap resolves itself, an outage does not.
 */
export function sleepLine(reason: SleepReason): string {
  switch (reason) {
    case 'provider_down':
      return 'I cannot think right now. The service I run on is not answering. '
        + 'Everything else in Staxis still works.';
    case 'cost_cap':
      return 'I have used up what this hotel spends on me today. I will be back '
        + 'in the morning. Everything else in Staxis still works.';
    case 'section_off':
      return 'I am switched off for this hotel. Your Staxis admin can turn me '
        + 'back on.';
    case 'unknown':
      return 'I cannot reach my thinking right now. Everything else in Staxis '
        + 'still works.';
  }
}

// ─── Standing rules ─────────────────────────────────────────────────────────

/**
 * The read-back before a standing rule is saved.
 *
 * The rule is quoted back verbatim rather than paraphrased. A paraphrase is the
 * companion deciding what somebody meant, and the whole point of a standing
 * rule is that the person decided.
 */
export function ruleReadBack(ruleText: string): string {
  return `I will remember this, for this hotel: "${normalizeRule(ruleText)}". Is that right?`;
}

/** The receipt after a standing rule is saved. */
export function ruleSavedLine(ruleText: string): string {
  return `Saved. From now on, for this hotel: "${normalizeRule(ruleText)}".`;
}

/** The receipt after a standing rule is deleted. */
export function ruleRemovedLine(ruleText: string): string {
  return `Removed. I will stop following: "${normalizeRule(ruleText)}".`;
}

/** Who gave a rule and when, as one line under it. */
export function ruleAttribution(input: {
  authorName: string | null;
  authorRole: string | null;
  createdAt: string;
}): string {
  const who = input.authorName?.trim() || 'Someone on your team';
  const when = shortDate(input.createdAt);
  return when ? `${who}, ${when}` : who;
}

/** Whitespace-folded, quote-safe rule text for display. */
export function normalizeRule(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').replace(/"/g, '”');
}

function shortDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Fixed labels ───────────────────────────────────────────────────────────
//
// Small enough to be constants, still routed through a producer so the copy
// walk reaches them.

export function companionLabels(): Record<string, string> {
  return {
    open: 'Open Staxis',
    close: 'Close',
    yes: 'Yes',
    no: 'No thanks',
    dismiss: 'Not now',
    quietForNow: 'Quiet for now',
    takeMeThere: 'Take me there',
    showMeAround: 'Show me around',
    whereTo: 'Take me to',
    panelTitle: 'Staxis',
    askPlaceholder: 'Ask me anything about the hotel',
    rulesTitle: 'Standing rules',
    rulesSub: 'Things your team told Staxis to always do. Staxis follows these at this hotel.',
    rulesEmpty: 'No standing rules yet. Tell Staxis one in the chat, like "always tell me before any order over $200".',
    rulesDelete: 'Remove',
    quietedNote: 'I will stay out of the way until you open me.',
    pastChats: 'Past chats',
    newChat: 'Start a new chat…',
    search: 'Search',
    back: 'Back',
    more: 'More',
    sendFeedback: 'Send feedback',
    aiActivity: 'AI activity',
    backToCorner: 'Back to the corner',
    noPastChats: 'No past chats yet',
    undo: 'Undo',
    // ─── Notices ───────────────────────────────────────────────────────────
    // "Notices", everywhere, and never "notifications" or "alerts". A notice is
    // something a colleague put in front of you; a notification is something an
    // app decided you should look at, and the word carries every habit this
    // product is trying not to have.
    notices: 'Notices',
    showNotices: 'Show me',
    openNotices: 'Open notices',
    closeNotices: 'Close notices',
  };
}

/** The counted heading over the past-chats list. */
export function pastChatsHeading(count: number): string {
  return count === 1 ? 'Past chats · 1' : `Past chats · ${count}`;
}
