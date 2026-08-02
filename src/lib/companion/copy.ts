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
  };
}

// ─── The panel's eyebrow ────────────────────────────────────────────────────

/**
 * The one line of status at the top of the open panel.
 *
 * Says where the person is standing, because a companion that answers about
 * the screen in front of you should be able to name it. Falls back to what it
 * is doing rather than to nothing: an empty eyebrow reads as a broken header.
 */
export function panelEyebrow(input: {
  page: CompanionPage | null;
  streaming: boolean;
}): string {
  if (input.streaming) return 'Staxis · thinking…';
  if (input.page) return `Staxis · on ${input.page.label.toLowerCase()}`;
  return 'Staxis · thinking with you';
}

/** The counted heading over the past-chats list. */
export function pastChatsHeading(count: number): string {
  return count === 1 ? 'Past chats · 1' : `Past chats · ${count}`;
}
