// ═══════════════════════════════════════════════════════════════════════════
// The manners engine — when the companion is allowed to speak first.
//
// THIS MODULE IS PURE. No clock of its own, no fetch, no React, no database,
// and above all NO MODEL CALL. Deciding whether to interrupt somebody must cost
// nothing and must be reproducible: a companion that phoned a model to work out
// whether to open its mouth would be both expensive and unexplainable, and the
// question "why did it say that" would have no answer anybody could check.
//
// Every input arrives as an argument, including `now` and the hotel's own
// calendar day. That is what makes the whole social contract testable.
//
// ─── THE CONTRACT ──────────────────────────────────────────────────────────
//
//   Day one          One warm welcome, by name, sized to the hat, with a tour
//                    offer. Exactly once, ever.
//   After that       Quiet. It speaks only when it has ONE concrete, current,
//                    role-relevant thing, and only within a frequency cap.
//   One thing        Never two. Never a digest.
//   Never over you   Not while you are typing, not mid-form, not after you have
//                    asked for quiet this session.
//   One voice        Never announces something a card already on this screen is
//                    showing. Two true statements about one fact read as a bug.
//   A No is a No     The card closes, nothing is said back, nothing is lost.
//                    The same offer does not come back that day. Twice turned
//                    down or ignored on a topic and that topic is gone for good.
//   Shoulder-safe    Unprompted, it sticks to operations: counts, rooms, work.
//                    Wages, complaints and how one person is doing are things
//                    it will discuss, but only after YOU opened the
//                    conversation, and only behind the role gates that already
//                    exist. Screens get read over shoulders.
//   Never twice      It never re-welcomes and never repeats an intro.
//
// ─── WHY "IGNORED" AND "DECLINED" SHARE A COUNTER ──────────────────────────
// Because from the person's side they are the same act. Somebody who scrolls
// past an offer twice has told us the same thing as somebody who tapped No
// twice, and asking them to be explicit about it is the companion demanding a
// receipt for its own noise.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import {
  COMPANION_DECLINES_BEFORE_DROP,
  COMPANION_MAX_SPEECH_PER_DAY,
  COMPANION_MEMORY_TOPIC_CAP,
  COMPANION_MIN_GAP_MINUTES,
} from './charter';
import {
  dailyHelloLine, offerSentence, teachLine, todayFact, tourQuestion, welcomeGreeting,
  type TeachFlow,
} from './copy';
import type { CompanionPageKey } from './pages';
import { repliesFor, type CompanionReply, type CompanionReplyKind } from './replies';

export type { TeachFlow } from './copy';

/**
 * The Staxis list's own entry in this ledger.
 *
 * The `taught` map is a per-person "said once, ever" record and it is the right
 * home for the one line the to-do composer shows after somebody's first plain
 * sentence. It is NOT a `TeachFlow`: a teach flow is something the companion
 * says out loud, gated on whether the companion is awake and whether the person
 * is busy, and this line is neither of those things — it is one grey sentence
 * under a row that has just succeeded. Sharing the ledger and not the machinery
 * is the whole point: two "once ever" stores would be one too many.
 */
export const COMPOSER_TAUGHT_TODO_REPEAT = 'todo_repeat_hint';

/** Everything the taught ledger may be keyed by. */
export type TaughtKey = TeachFlow | typeof COMPOSER_TAUGHT_TODO_REPEAT;

// ─── Memory ─────────────────────────────────────────────────────────────────
//
// Persisted per person per hotel as one jsonb column on staxis_user_prefs (see
// migration 0416). One column rather than a new preferences system, and one
// blob rather than a row per topic, because the whole thing is read on every
// page load and written only when the companion acts.

export interface CompanionTopicMemory {
  /** Declined or ignored, counted together. See the header. */
  declines: number;
  /** True once it crossed the threshold. Never resets. */
  dropped: boolean;
  /** Hotel-local day this topic was last offered, so it cannot repeat today. */
  lastOfferedDay: string | null;
}

export interface CompanionMemory {
  /** Set once, ever. Its presence is the whole "never re-welcome" rule. */
  welcomedAt: string | null;
  /**
   * Flows this person has already been taught, permanently.
   *
   * Once per person per flow, for good. A tip is only ever useful the first
   * time; the second time it is the app telling somebody it thinks they are
   * slow. Dismissing the line counts as taught, because it is set the moment
   * the line is shown rather than when it is acknowledged.
   */
  taught: Record<string, true>;
  /** True after a No to the tour. The tour is never offered again. */
  tourDeclined: boolean;
  /** Set when the tour was actually taken, so it is not re-offered either. */
  tourTakenAt: string | null;
  /** ISO of the last unprompted message, for the minimum-gap rule. */
  lastSpokeAt: string | null;
  /** Hotel-local day `spokenCount` belongs to. A new day resets the count. */
  spokenDay: string | null;
  spokenCount: number;
  /**
   * Hotel-local day the once-a-day hello was said, or null.
   *
   * The whole of the "exactly once a day" guarantee. Stored rather than kept in
   * the tab because somebody who opens four screens before lunch is one person
   * having one day, not four page loads each owed a greeting.
   */
  greetedDay: string | null;
  /**
   * The newest notice this person has already been TOLD about out loud, ISO.
   *
   * The whole of "never twice for the same batch". See notices.ts: the
   * announcement is a fourth mouth, exempt from the caps above by founder
   * ruling, so this stamp is the only thing that stops it repeating on every
   * page load. Null means nothing has ever been announced.
   */
  noticesAnnouncedThrough: string | null;
  /**
   * When this person last OPENED the notices list, ISO.
   *
   * Separate from the stamp above because being told and having looked are
   * separate acts. This one drives the unread count and the unread row; that
   * one drives whether the companion opens its mouth.
   */
  noticesSeenAt: string | null;
  topics: Record<string, CompanionTopicMemory>;
}

export const EMPTY_COMPANION_MEMORY: CompanionMemory = {
  welcomedAt: null,
  taught: {},
  tourDeclined: false,
  tourTakenAt: null,
  lastSpokeAt: null,
  spokenDay: null,
  spokenCount: 0,
  greetedDay: null,
  noticesAnnouncedThrough: null,
  noticesSeenAt: null,
  topics: {},
};

/**
 * Normalize whatever came back from the database or a browser.
 *
 * The column is jsonb and one of its writers is a request body, so nothing in
 * it is trusted. Anything unreadable degrades to the empty memory, which is the
 * safe direction only for the counters: a lost decline count means one more
 * offer, while a lost `welcomedAt` would mean a second welcome. That is why the
 * bootstrap route ALSO refuses to welcome when the setup wizard has run (see
 * `wizardAlreadyRan` below) — two independent reasons never to greet twice.
 */
export function parseCompanionMemory(raw: unknown): CompanionMemory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_COMPANION_MEMORY, taught: {}, topics: {} };
  }
  const o = raw as Record<string, unknown>;
  const taught: Record<string, true> = {};
  const rawTaught = o.taught;
  if (rawTaught && typeof rawTaught === 'object' && !Array.isArray(rawTaught)) {
    for (const [key, value] of Object.entries(rawTaught as Record<string, unknown>)) {
      // Only ever true. A `false` in this map would be a way to un-teach
      // somebody by editing a request body, and there is no product reason to
      // allow it: the whole point is that the tip is spent.
      if (typeof key === 'string' && key.length > 0 && key.length <= 60 && value === true) {
        taught[key] = true;
      }
    }
  }
  const topics: Record<string, CompanionTopicMemory> = {};
  const rawTopics = o.topics;
  if (rawTopics && typeof rawTopics === 'object' && !Array.isArray(rawTopics)) {
    for (const [key, value] of Object.entries(rawTopics as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const t = value as Record<string, unknown>;
      const declines = Number(t.declines);
      topics[key] = {
        declines: Number.isFinite(declines) && declines > 0 ? Math.min(Math.floor(declines), 99) : 0,
        dropped: t.dropped === true,
        lastOfferedDay: isDayString(t.lastOfferedDay) ? t.lastOfferedDay : null,
      };
    }
  }
  const spokenCount = Number(o.spokenCount);
  return {
    welcomedAt: isIsoString(o.welcomedAt) ? o.welcomedAt : null,
    taught,
    tourDeclined: o.tourDeclined === true,
    tourTakenAt: isIsoString(o.tourTakenAt) ? o.tourTakenAt : null,
    lastSpokeAt: isIsoString(o.lastSpokeAt) ? o.lastSpokeAt : null,
    spokenDay: isDayString(o.spokenDay) ? o.spokenDay : null,
    spokenCount: Number.isFinite(spokenCount) && spokenCount > 0 ? Math.min(Math.floor(spokenCount), 99) : 0,
    greetedDay: isDayString(o.greetedDay) ? o.greetedDay : null,
    // Both degrade to null, which means "tell them again" rather than "assume
    // they were told". For a stamp whose only job is suppressing speech, the
    // safe direction on unreadable input is to speak: one repeated line costs a
    // person nothing, and a forged stamp that silenced the list would cost them
    // the message a colleague sent.
    noticesAnnouncedThrough: isIsoString(o.noticesAnnouncedThrough) ? o.noticesAnnouncedThrough : null,
    noticesSeenAt: isIsoString(o.noticesSeenAt) ? o.noticesSeenAt : null,
    topics: capTopics(topics),
  };
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 10 && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

function isDayString(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Keep the blob bounded. Live topics fall off before dropped ones, because
 * forgetting that somebody said No is the failure that actually annoys people,
 * while forgetting that we offered something today costs at most one repeat.
 */
function capTopics(topics: Record<string, CompanionTopicMemory>): Record<string, CompanionTopicMemory> {
  const entries = Object.entries(topics);
  if (entries.length <= COMPANION_MEMORY_TOPIC_CAP) return topics;
  const ranked = entries.sort((a, b) => {
    if (a[1].dropped !== b[1].dropped) return a[1].dropped ? -1 : 1;
    if (a[1].declines !== b[1].declines) return b[1].declines - a[1].declines;
    return a[0].localeCompare(b[0]);
  });
  return Object.fromEntries(ranked.slice(0, COMPANION_MEMORY_TOPIC_CAP));
}

// ─── Candidates ─────────────────────────────────────────────────────────────

export type CompanionSensitivity = 'operational' | 'people';

/**
 * How loud the thing is, for the severity dot on the peek and the mark's Wrong
 * state. Mirrors the three levels findings already carry (critical, attention,
 * info) rather than inventing a fourth scale.
 *
 * Optional because it is presentation, not a decision input: nothing in
 * decideCompanionSpeech branches on it, and a candidate built before this field
 * existed must still be offerable. Missing reads as `watch`, the middle.
 */
export type CompanionSeverity = 'ok' | 'watch' | 'urgent';

export const DEFAULT_COMPANION_SEVERITY: CompanionSeverity = 'watch';

export interface CompanionCandidate {
  /**
   * Stable across days and across wordings. This is the handle a No attaches
   * to, so it must NOT be the finding's row id: the same problem re-detected
   * tomorrow gets a new row, and a No that expired overnight is not a No.
   */
  topic: string;
  /** One already-computed sentence. Nothing here was written by a model now. */
  text: string;
  /**
   * `people` covers wages, complaints and how an individual is performing.
   * These never speak first. They are answerable, in the conversation, after
   * the person opened it, behind the role gates that already exist.
   */
  sensitivity: CompanionSensitivity;
  /**
   * Ids of the things this sentence is about, in the one-list's own namespace
   * (`finding:<id>`, `item:<sourceType>:<id>`, `log:<id>`). Used for the
   * one-voice rule against what is on screen.
   */
  covers: readonly string[];
  /** Where "yes" would take them, if anywhere. */
  destination: CompanionPageKey | null;
  /** Presentation only. See CompanionSeverity. */
  severity?: CompanionSeverity;
  /**
   * A sentence to hand the chat brain when they say yes, instead of walking
   * them to a screen.
   *
   * The unfinished-business recall is the case this exists for: "still want
   * that?" has no destination, because what the person wants is the thing they
   * were offered, not a page about it. Without this the Yes button would
   * resolve to no destination and silently do nothing, which is the one
   * outcome this whole layer refuses to ship.
   *
   * It carries NO new capability. The seeded sentence goes through the same
   * chat turn a person could have typed, and any mutation it proposes gets the
   * same approval card it would have got the first time. Charter clause 1 is
   * untouched: this reopens a question, it does not answer one.
   */
  seed?: string;
  /**
   * Which reply vocabulary this candidate speaks.
   *
   * Carried rather than re-derived, because the thing that knows a card is a
   * preventive follow-up is the code that read the card. It picks the question
   * producer and nothing else; the replies below are already built.
   */
  replyKind: CompanionReplyKind;
  /**
   * WHAT A PERSON MAY SAY BACK, BUILT BY WHATEVER BUILT THE SENTENCE.
   *
   * This field is the whole point of the reply work. A candidate used to carry
   * a `destination` and nothing else, and the question under it was then
   * invented to fit that routing hint: a fire-panel statement got "Want me to
   * take you to Staxis?" over [Yes] [No thanks], which answers nothing anybody
   * asked. The source surfaces already knew the honest answers. Now they say
   * them.
   *
   * Capped at three by construction in replies.ts, never by a slice here.
   */
  replies: readonly CompanionReply[];
  /**
   * The model-written question for this card, already guarded, or null.
   *
   * Null is the ordinary case and means "use the per-kind template". Nothing
   * phrases anything at the moment this candidate is built; a question here was
   * written by a pass that already ran a model, hours ago, and stored.
   */
  judgedQuestion?: string | null;
}

// ─── Decision ───────────────────────────────────────────────────────────────

export type SilenceReason =
  | 'ai_asleep'
  | 'quiet_this_session'
  | 'user_is_busy'
  | 'welcome_already_given_by_setup'
  | 'daily_cap_reached'
  | 'too_soon_after_last'
  | 'tour_still_pending'
  | 'nothing_to_say';

export type CompanionSpeech =
  | {
      kind: 'silent';
      reason: SilenceReason;
      /**
       * Set when the companion is deliberately skipping the welcome because
       * the setup wizard already gave one. The caller persists `welcomedAt`
       * anyway so this branch is taken once, not on every page load.
       */
      markWelcomed?: true;
    }
  | { kind: 'welcome'; greeting: string; question: string }
  | {
      kind: 'offer';
      topic: string;
      sentence: string;
      destination: CompanionPageKey | null;
      severity: CompanionSeverity;
      /** See CompanionCandidate.seed. Present only for a candidate that
       *  carried one; a yes then reopens the conversation instead of walking. */
      seed?: string;
      /** The candidate's own replies, unchanged. Never re-derived from the
       *  destination: re-deriving them is the bug this all exists to end. */
      replies: readonly CompanionReply[];
      /** Picks the question producer. See CompanionCandidate.replyKind. */
      replyKind: CompanionReplyKind;
      /** The judged question, or null for the template. */
      judgedQuestion: string | null;
    };

export interface MannersInput {
  now: Date;
  /** The hotel's own calendar day, YYYY-MM-DD. Never the browser's. */
  today: string;
  person: {
    firstName: string | null;
    role: AppRole;
    /** Desk-shared or generic account. Greeted without a personal name. */
    sharedLogin: boolean;
  };
  memory: CompanionMemory;
  /** Already-computed, already role-filtered, ranked best first. */
  candidates: readonly CompanionCandidate[];
  /** Ids visible on this screen right now, same namespace as `covers`. */
  onScreen: readonly string[];
  /** Typing, or a form with unsaved input open. */
  userIsBusy: boolean;
  /** They asked for quiet. Lasts until the tab is reloaded. */
  quietThisSession: boolean;
  /** False when the AI layer is unavailable for any reason. */
  aiAwake: boolean;
  /**
   * True when the one-time setup wizard has already run for this hotel (the
   * `properties.onboarding_prompt_shown_at` guard). A person who just walked
   * through setup has been welcomed; a second welcome on top of it is the
   * companion talking about itself.
   */
  wizardAlreadyRan: boolean;
  /** This person runs more than one hotel, so statements must name one. */
  multiHotel: boolean;
  /** The hotel the picker is currently on. */
  hotelName: string | null;
}

/**
 * Should the companion say something unprompted right now, and what?
 *
 * The order of these checks is load-bearing and is asserted in the tests. A
 * cheaper check must never be moved below an expensive one for tidiness: the
 * asleep check is first so a broken provider cannot produce a greeting, and
 * `quietThisSession` is above the welcome so that dismissing the companion
 * dismisses it even on day one.
 */
export function decideCompanionSpeech(input: MannersInput): CompanionSpeech {
  if (!input.aiAwake) return { kind: 'silent', reason: 'ai_asleep' };
  if (input.quietThisSession) return { kind: 'silent', reason: 'quiet_this_session' };
  if (input.userIsBusy) return { kind: 'silent', reason: 'user_is_busy' };

  // ── Day one ───────────────────────────────────────────────────────────────
  if (!input.memory.welcomedAt) {
    if (input.wizardAlreadyRan) {
      return { kind: 'silent', reason: 'welcome_already_given_by_setup', markWelcomed: true };
    }
    return {
      kind: 'welcome',
      greeting: welcomeGreeting({
        firstName: input.person.firstName,
        role: input.person.role,
        sharedLogin: input.person.sharedLogin,
      }),
      question: tourQuestion(input.person.role),
    };
  }

  // A welcome that has been shown but not answered owns the floor. Stacking an
  // operational offer on an unanswered greeting is two things at once, which
  // is the one thing this engine exists to prevent.
  if (!input.memory.tourDeclined && !input.memory.tourTakenAt && sameDay(input.memory.welcomedAt, input.today)) {
    return { kind: 'silent', reason: 'tour_still_pending' };
  }

  // ── Frequency ─────────────────────────────────────────────────────────────
  const spokenToday = input.memory.spokenDay === input.today ? input.memory.spokenCount : 0;
  if (spokenToday >= COMPANION_MAX_SPEECH_PER_DAY) {
    return { kind: 'silent', reason: 'daily_cap_reached' };
  }
  if (input.memory.lastSpokeAt) {
    const gapMs = input.now.getTime() - Date.parse(input.memory.lastSpokeAt);
    if (Number.isFinite(gapMs) && gapMs >= 0 && gapMs < COMPANION_MIN_GAP_MINUTES * 60_000) {
      return { kind: 'silent', reason: 'too_soon_after_last' };
    }
  }

  // ── The one thing ─────────────────────────────────────────────────────────
  const onScreen = new Set(input.onScreen);
  for (const candidate of input.candidates) {
    if (candidate.sensitivity !== 'operational') continue;
    if (!candidate.text.trim()) continue;
    const seen = input.memory.topics[candidate.topic];
    if (seen?.dropped) continue;
    if (seen && seen.lastOfferedDay === input.today) continue;
    if (candidate.covers.some((id) => onScreen.has(id))) continue;
    return {
      kind: 'offer',
      topic: candidate.topic,
      sentence: offerSentence({
        text: candidate.text,
        hotelName: input.hotelName,
        multiHotel: input.multiHotel,
      }),
      destination: candidate.destination,
      severity: candidate.severity ?? DEFAULT_COMPANION_SEVERITY,
      ...(candidate.seed ? { seed: candidate.seed } : {}),
      replies: candidate.replies ?? [],
      replyKind: candidate.replyKind,
      judgedQuestion: candidate.judgedQuestion ?? null,
    };
  }

  return { kind: 'silent', reason: 'nothing_to_say' };
}

function sameDay(iso: string, day: string): boolean {
  return iso.slice(0, 10) === day;
}

// ─── Teach at the moment ────────────────────────────────────────────────────
//
// A SECOND, NARROWER MOUTH. This is not an interruption and does not draw on
// the daily speech budget, because the person just finished doing the exact
// thing the line is about: the moment is theirs, not ours, and the line rides
// on the back of an action they chose. It has a much harder cap instead. Once
// per person per flow, permanently.
//
// It runs AFTER the flow completes. That ordering is the whole safety of it:
// a tip that appears while somebody is still filling in a form is a tip that
// arrives as an obstacle.

// ═══════════════════════════════════════════════════════════════════════════
// One hello a day
// ═══════════════════════════════════════════════════════════════════════════
//
// Once per hotel-local day per person, on the first screen they land on that
// has a companion, whether or not anything is wrong. It is the one thing the
// companion is allowed to say for no reason other than that a new day started.
//
// WHY THE DAY IS THE HOTEL'S. `today` is `propertyLocalToday(now, timezone)`,
// resolved on the server from `properties.timezone`, never from the browser
// clock. A night auditor at 1am and a GM at 9am are on different days by the
// hotel's calendar, and the hotel's calendar is the one the whole product
// already counts by (see src/lib/schedule/local-date.ts).
//
// It does NOT spend the daily speech budget. The budget exists to stop the
// companion volunteering findings all day; a hello is not a finding, it is the
// thing saying good morning once. It is still subject to every floor that
// matters: asleep, quiet-for-now, and never while somebody is typing.
//
// And it never stacks on the welcome. On day one the welcome IS the hello.

export type HelloRefusal =
  | 'ai_asleep'
  | 'quiet_this_session'
  | 'user_is_busy'
  | 'welcome_owns_today'
  | 'already_said_today';

export type HelloDecision =
  | { hello: false; refusal: HelloRefusal }
  | { hello: true; line: string };

export interface HelloInput {
  /** The hotel's own calendar day, YYYY-MM-DD. Never the browser's. */
  today: string;
  person: { firstName: string | null; sharedLogin: boolean };
  memory: CompanionMemory;
  /** The hour on the wall at the hotel, or null when we do not know it. */
  hour: number | null;
  /**
   * How many things the companion has found worth raising.
   *
   * Counted from the candidates the bootstrap already returned, so the hello
   * costs no read of its own. Zero produces "All quiet so far", which is a
   * claim this only makes because the count really was zero.
   */
  waiting: number;
  userIsBusy: boolean;
  quietThisSession: boolean;
  aiAwake: boolean;
}

export function decideDailyHello(input: HelloInput): HelloDecision {
  if (!input.aiAwake) return { hello: false, refusal: 'ai_asleep' };
  if (input.quietThisSession) return { hello: false, refusal: 'quiet_this_session' };
  if (input.userIsBusy) return { hello: false, refusal: 'user_is_busy' };
  // Day one belongs to the welcome. Two greetings in one morning is the thing
  // the whole of this file exists to stop.
  if (!input.memory.welcomedAt) return { hello: false, refusal: 'welcome_owns_today' };
  if (input.memory.greetedDay === input.today) return { hello: false, refusal: 'already_said_today' };
  return {
    hello: true,
    line: dailyHelloLine({
      firstName: input.person.firstName,
      sharedLogin: input.person.sharedLogin,
      hour: input.hour,
      fact: todayFact({ waiting: input.waiting }),
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The panel ask — the one thing that may only be said to somebody who opened
// the panel themselves.
// ═══════════════════════════════════════════════════════════════════════════
//
// A THIRD, NARROWER MOUTH, and the narrowest of the three. Like the teach line
// it does not spend the daily speech budget, for the same reason: the moment
// belongs to the person, who reached for the companion rather than being
// reached for. Unlike the teach line it carries real content, so every topic
// rule still applies in full — a No is still a No, twice is still forever, and
// a topic offered today is not offered again today.
//
// ─── WHY IT EXISTS: THE SHOULDER-SAFE RULE, MADE STRUCTURAL ────────────────
//
// `decideCompanionSpeech` skips every candidate whose sensitivity is not
// `operational`, which is what stops the companion volunteering something about
// a named person on a screen somebody else can see. That rule is right and is
// not being loosened here.
//
// But the class of thing it excludes is not the class of thing that should
// never be said. A repeated absence on one weekday is a real pattern, found in
// the hotel's own records, and a manager is entitled to know about it. What is
// wrong is the VENUE: a pill in the corner of a screen, or a line drawn on a
// board, in a back office where anybody walks past.
//
// So the venue is the whole rule. This decision cannot produce a peek, cannot
// produce anything drawn on a page, and cannot fire at all unless the panel is
// already open and empty of conversation. The sensitive sentence exists in
// exactly one place: inside a surface the person deliberately opened.
//
// It is a separate function rather than a flag on decideCompanionSpeech
// because the two answer different questions ("may I interrupt" versus "they
// are here, what is worth saying"), and folding them together would put the
// sensitive branch one boolean away from the unprompted path.

export type PanelAskRefusal =
  | 'ai_asleep'
  | 'quiet_this_session'
  | 'user_is_busy'
  | 'panel_not_open'
  | 'conversation_in_progress'
  | 'nothing_to_say';

export type PanelAskDecision =
  | { ask: false; refusal: PanelAskRefusal }
  | {
      ask: true;
      topic: string;
      sentence: string;
      destination: CompanionPageKey | null;
      severity: CompanionSeverity;
      /** The candidate's own replies. A panel ask about a named person gets
       *  its own "stop watching this", which is why it is not the trace set. */
      replies: readonly CompanionReply[];
      replyKind: CompanionReplyKind;
      judgedQuestion: string | null;
    };

export interface PanelAskInput {
  /** The hotel's own calendar day, YYYY-MM-DD. Never the browser's. */
  today: string;
  memory: CompanionMemory;
  /** Already role-filtered, ranked best first. Any sensitivity. */
  candidates: readonly CompanionCandidate[];
  /** True only while the panel is actually open. The whole venue rule. */
  panelOpen: boolean;
  /**
   * True when the thread has no messages yet.
   *
   * An ask that appeared above somebody's fourth question would be the
   * companion changing the subject in the middle of a conversation it is
   * having. It gets one moment, at the top, or it waits.
   */
  threadEmpty: boolean;
  /** Something else is already being said. One thing, never two. */
  otherSpeechShowing: boolean;
  userIsBusy: boolean;
  quietThisSession: boolean;
  aiAwake: boolean;
}

export function decidePanelAsk(input: PanelAskInput): PanelAskDecision {
  if (!input.aiAwake) return { ask: false, refusal: 'ai_asleep' };
  if (input.quietThisSession) return { ask: false, refusal: 'quiet_this_session' };
  if (input.userIsBusy) return { ask: false, refusal: 'user_is_busy' };
  if (!input.panelOpen) return { ask: false, refusal: 'panel_not_open' };
  if (!input.threadEmpty || input.otherSpeechShowing) {
    return { ask: false, refusal: 'conversation_in_progress' };
  }

  for (const candidate of input.candidates) {
    if (!candidate.text.trim()) continue;
    const seen = input.memory.topics[candidate.topic];
    if (seen?.dropped) continue;
    if (seen && seen.lastOfferedDay === input.today) continue;
    return {
      ask: true,
      topic: candidate.topic,
      // No hotel prefix. The person is looking at a panel whose own header says
      // which hotel they are on, and `offerSentence`'s "At the Comfort Suites,"
      // is there for a sentence that arrives out of nowhere in a corner.
      sentence: candidate.text.trim(),
      destination: candidate.destination,
      severity: candidate.severity ?? DEFAULT_COMPANION_SEVERITY,
      // The panel ask has its own vocabulary, not the candidate's: the venue
      // changes the honest answers. "Show me what you found" reads right inside
      // a panel somebody opened and would read as a boast in a corner pill, and
      // "stop watching this" is a thing people want to say about a pattern
      // concerning a colleague and rarely about a stock count.
      replies: repliesFor({ kind: 'panel_ask' }),
      replyKind: 'panel_ask',
      judgedQuestion: candidate.judgedQuestion ?? null,
    };
  }
  return { ask: false, refusal: 'nothing_to_say' };
}

export type TeachRefusal =
  | 'ai_asleep'
  | 'quiet_this_session'
  | 'user_is_busy'
  | 'already_taught'
  | 'flow_not_available_to_role';

export type TeachDecision =
  | { teach: false; refusal: TeachRefusal }
  | { teach: true; flow: TeachFlow; text: string; example: string };

export interface TeachInput {
  flow: TeachFlow;
  memory: CompanionMemory;
  role: AppRole;
  /** Typing, or a form still open. Checked even though the flow just closed. */
  userIsBusy: boolean;
  quietThisSession: boolean;
  aiAwake: boolean;
}

/**
 * Which hats can actually reach the tool behind each teach line.
 *
 * Mirrors the `allowedRoles` on the real tools rather than guessing. Teaching
 * somebody a sentence that their own role would be refused for is worse than
 * teaching them nothing: they try it once, get turned down, and learn that the
 * companion does not know what it can do.
 */
const TEACH_FLOW_ROLES: Readonly<Record<TeachFlow, readonly AppRole[]>> = {
  // create_todo / add_logbook_entry are the comms tools every operational hat
  // can post with. Housekeeping is excluded everywhere by the mount gate, so
  // it never reaches this function, but it is left off the lists as well so the
  // two gates agree rather than one relying on the other.
  create_task: ['admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff'],
  log_book_entry: ['admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff'],
  // post_announcement is a manager act.
  announcement: ['admin', 'owner', 'general_manager'],
};

export function decideTeachMoment(input: TeachInput): TeachDecision {
  if (!input.aiAwake) return { teach: false, refusal: 'ai_asleep' };
  if (input.quietThisSession) return { teach: false, refusal: 'quiet_this_session' };
  if (input.userIsBusy) return { teach: false, refusal: 'user_is_busy' };
  if (input.memory.taught[input.flow] === true) return { teach: false, refusal: 'already_taught' };
  if (!TEACH_FLOW_ROLES[input.flow].includes(input.role)) {
    return { teach: false, refusal: 'flow_not_available_to_role' };
  }
  const line = teachLine(input.flow);
  return { teach: true, flow: input.flow, text: line.text, example: line.example };
}

/** Spent the moment it is shown, so a dismissal counts the same as a read. */
export function rememberTaught(memory: CompanionMemory, flow: TaughtKey): CompanionMemory {
  if (memory.taught[flow] === true) return memory;
  return { ...memory, taught: { ...memory.taught, [flow]: true } };
}

// ─── Reducers ───────────────────────────────────────────────────────────────
//
// Pure. Each returns a NEW memory. The caller persists it; nothing here writes.

export function rememberWelcomed(memory: CompanionMemory, now: Date): CompanionMemory {
  if (memory.welcomedAt) return memory;
  return { ...memory, welcomedAt: now.toISOString() };
}

/** Stamp the hello. Idempotent within a day, and a day is the hotel's own. */
export function rememberGreeted(memory: CompanionMemory, today: string): CompanionMemory {
  if (memory.greetedDay === today) return memory;
  return { ...memory, greetedDay: today };
}

/**
 * A batch of notices was said out loud. See notices.ts.
 *
 * MONOTONIC. A stamp only ever moves forward, so a stale tab replaying an older
 * batch cannot un-announce the newer one and make the companion repeat itself.
 * An unparseable `through` is ignored rather than written.
 */
export function rememberNoticesAnnounced(
  memory: CompanionMemory,
  through: string,
): CompanionMemory {
  const next = Date.parse(through);
  if (!Number.isFinite(next)) return memory;
  const prior = memory.noticesAnnouncedThrough ? Date.parse(memory.noticesAnnouncedThrough) : NaN;
  if (Number.isFinite(prior) && prior >= next) return memory;
  return { ...memory, noticesAnnouncedThrough: through };
}

/**
 * They opened the list. Monotonic for the same reason as above: a second tab
 * opened an hour ago must not drag the read cursor backwards and make yesterday
 * unread again.
 */
export function rememberNoticesSeen(memory: CompanionMemory, at: string): CompanionMemory {
  const next = Date.parse(at);
  if (!Number.isFinite(next)) return memory;
  const prior = memory.noticesSeenAt ? Date.parse(memory.noticesSeenAt) : NaN;
  if (Number.isFinite(prior) && prior >= next) return memory;
  return { ...memory, noticesSeenAt: at };
}

export function rememberTourDeclined(memory: CompanionMemory): CompanionMemory {
  return { ...memory, tourDeclined: true };
}

export function rememberTourTaken(memory: CompanionMemory, now: Date): CompanionMemory {
  return { ...memory, tourTakenAt: now.toISOString() };
}

/** Called the moment an offer is shown, not when it is answered. */
export function rememberSpoke(
  memory: CompanionMemory,
  topic: string,
  now: Date,
  today: string,
): CompanionMemory {
  const prior = memory.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
  return {
    ...memory,
    lastSpokeAt: now.toISOString(),
    spokenDay: today,
    spokenCount: (memory.spokenDay === today ? memory.spokenCount : 0) + 1,
    topics: capTopics({
      ...memory.topics,
      [topic]: { ...prior, lastOfferedDay: today },
    }),
  };
}

/**
 * A No, or a walk away. Same counter, same consequence.
 *
 * Nothing is lost when this runs: the thing the offer was about is still on its
 * own screen, in its own list, exactly where it was. All that is dropped is the
 * companion's permission to bring it up.
 */
export function rememberDeclined(memory: CompanionMemory, topic: string, today: string): CompanionMemory {
  const prior = memory.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
  const declines = prior.declines + 1;
  return {
    ...memory,
    topics: capTopics({
      ...memory.topics,
      [topic]: {
        declines,
        dropped: prior.dropped || declines >= COMPANION_DECLINES_BEFORE_DROP,
        lastOfferedDay: today,
      },
    }),
  };
}

/** A Yes. The topic stays live and its decline count is forgiven. */
export function rememberAccepted(memory: CompanionMemory, topic: string, today: string): CompanionMemory {
  const prior = memory.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
  if (prior.dropped) return memory;
  return {
    ...memory,
    topics: capTopics({
      ...memory.topics,
      [topic]: { declines: 0, dropped: false, lastOfferedDay: today },
    }),
  };
}

/**
 * Is the "show me around" entry still worth offering inside the companion?
 *
 * A No to the tour means never offered again UNPROMPTED. It does not mean the
 * tour is deleted: the entry stays reachable in the panel forever, because
 * "I said no on my first day" and "I never want to see this" are different
 * sentences and only the person gets to say the second one.
 */
export function tourIsReachable(): boolean {
  return true;
}
