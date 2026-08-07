// ═══════════════════════════════════════════════════════════════════════════
// Who decides what the companion said.
//
// ─── THE GAP THIS CLOSES ───────────────────────────────────────────────────
//
// The reducers were moved to the server so a stale tab could not un-say
// somebody's No. The DECISION was left in the browser. `decideCompanionSpeech`
// and `decideDailyHello` run in the hook, the hook posts the sentence it chose,
// and POST /api/companion wrote that sentence down verbatim: into
// `agent_messages` as a turn in the thread, and into `activity_log` as a row
// with `source = 'staxis_agent'` and `actor_name = 'Staxis'`.
//
// `activity_log` is the hotel's audit record. It is exempt from every retention
// purge, it is rendered at /settings/activity-log, it is exported, and it is
// read back into the companion's own prompt. A request body could put any
// sentence in it wearing the companion's name, from any authenticated account
// at the hotel, including the housekeeping hat that must never have a companion
// at all. Six forged rows evict a whole day of real ones out of the event
// sweep's `<already-said-today>` block; forty make the companion tell a manager
// it spoke first forty times when it spoke none.
//
// ─── WHAT REPLACES IT ──────────────────────────────────────────────────────
//
// The browser reports an INTENT: "I showed them a hello", "I offered them this
// topic". The server re-derives WHAT the companion was entitled to say, from
// its own reads, through the same pure copy producers the browser used, and
// records only that. A sentence the server cannot derive is a sentence that was
// never said as far as the record is concerned.
//
// PURE, and that is deliberate: every rule with a consequence is testable by
// calling this function and reading the answer. The route supplies the reads.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import {
  dailyHelloLine,
  offerSentence,
  todayFact,
  tourQuestion,
  welcomeGreeting,
} from './copy';
import type { CompanionCandidate, CompanionMemory } from './manners';
import { offerIsJournalable, type CompanionOfferKind } from './offers';

/**
 * The four events on which the companion actually puts a sentence in front of
 * somebody. Everything else moves the ledger silently.
 */
export type CompanionSpeakingEvent = 'welcomed' | 'greeted' | 'spoke' | 'notices_announced';

export const COMPANION_SPEAKING_EVENTS: readonly CompanionSpeakingEvent[] = [
  'welcomed', 'greeted', 'spoke', 'notices_announced',
];

export function isSpeakingEvent(event: string): event is CompanionSpeakingEvent {
  return (COMPANION_SPEAKING_EVENTS as readonly string[]).includes(event);
}

/**
 * The free half of the `spoke` gate: may this topic be raised at all today?
 *
 * Exported so the route can answer it BEFORE it pays for the reads that build
 * the candidate list. `authorizeCompanionEvent` asks the same question again
 * from the same function, so the optimization cannot drift away from the rule.
 *
 * Twice turned down is forever, and once a day is once a day. Both were only
 * ever enforced by the browser that decided to ask, so a caller that skipped
 * that step got an unlimited number of thread messages and timeline rows out of
 * a topic somebody had already said no to.
 */
export function spokenTopicIsOfferable(
  before: CompanionMemory,
  topic: string,
  today: string,
): boolean {
  const seen = before.topics[topic];
  if (!seen) return true;
  return !seen.dropped && seen.lastOfferedDay !== today;
}

/** Why nothing at all is written for this request. */
export type CompanionRefusal =
  /** This hat or this hotel has no companion. The GET half already says so. */
  | 'asleep'
  /** A `spoke` about a topic the server cannot find a candidate for. */
  | 'no_such_candidate'
  /** Twice turned down means never again, and never again is enforced here
   *  too, not only in the browser that chose to ask. */
  | 'topic_dropped'
  /** One offer per topic per hotel-local day, counted on the server. */
  | 'topic_already_offered_today'
  /** A notices announcement with nothing left to announce. */
  | 'nothing_to_announce';

/** The sentence the companion is entitled to have said, as the server made it. */
export interface DerivedSpeech {
  kind: CompanionOfferKind;
  /** Produced HERE, from the server's own reads. Never the request body's. */
  text: string;
  topic: string | null;
  /** Whether this one belongs in the hotel's timeline as well as the thread. */
  journal: boolean;
}

export type CompanionVerdict =
  /** Write nothing. Not the memory, not the thread, not the timeline. */
  | { record: false; because: CompanionRefusal }
  /** Move the ledger. `speech` is null when nothing was said out loud. */
  | { record: true; speech: DerivedSpeech | null };

export interface CompanionAuthorityInput {
  /** The event, already validated against the closed list in the route. */
  event: string;
  /**
   * The GET half's own answer to "does this person, at this hotel, have a
   * companion". Housekeeping never does; a hotel with the Staxis list switched
   * off never does. Both were checked on the read and neither on the write.
   */
  awake: boolean;
  /** The memory as it was read, and as the reducer left it. */
  before: CompanionMemory;
  after: CompanionMemory;
  /** The validated topic, or '' for an event that carries none. */
  topic: string;
  /**
   * Did the browser claim a sentence was shown?
   *
   * This much IS the browser's to say, and it has to be: the same `welcomed`
   * event is posted both by a welcome somebody read and by the silent stamp the
   * setup wizard's guard produces, and only the browser knows which happened.
   * What the browser does NOT get to say is what the sentence was.
   */
  claimedSpeech: boolean;
  /** `panel_ask` narrows what gets journaled. It can never widen it. */
  claimedKind: unknown;
  person: { firstName: string | null; role: AppRole; sharedLogin: boolean };
  /** The hotel's own calendar day. Never the browser's. */
  today: string;
  /** The hour on the wall at the hotel, or null. */
  hour: number | null;
  hotelName: string | null;
  multiHotel: boolean;
  /** Built by the server, from the server's reads. The only source of a topic. */
  candidates: readonly CompanionCandidate[];
  /** The announcement the SERVER computed from this person's own notices. */
  announcement: { line: string; through: string } | null;
}

/**
 * May this event be recorded, and if a sentence went with it, what was it?
 *
 * The order of the checks is load-bearing. `awake` is first because a hat with
 * no companion has no business moving any part of the ledger. The
 * did-anything-move check is second because it is free and because it is the
 * whole of the idempotency story: five identical `greeted` posts used to write
 * five timeline rows and five thread messages while the ledger sat unchanged,
 * and none of those events spend the speech budget, so the only thing bounding
 * them was a rate limit that fails OPEN on a database error.
 */
export function authorizeCompanionEvent(input: CompanionAuthorityInput): CompanionVerdict {
  if (!input.awake) return { record: false, because: 'asleep' };

  if (!isSpeakingEvent(input.event)) return { record: true, speech: null };

  // Every reducer that can decline to move returns the SAME object, so identity
  // is the test. `rememberSpoke` always moves, which is why `spoke` has its own
  // gates below rather than relying on this one.
  if (input.before === input.after) return { record: true, speech: null };

  if (!input.claimedSpeech) return { record: true, speech: null };

  switch (input.event) {
    case 'welcomed': {
      const greeting = welcomeGreeting({
        firstName: input.person.firstName,
        role: input.person.role,
        sharedLogin: input.person.sharedLogin,
      });
      return {
        record: true,
        speech: {
          kind: 'greeting',
          text: `${greeting} ${tourQuestion(input.person.role)}`.trim(),
          topic: null,
          journal: offerIsJournalable('greeting'),
        },
      };
    }

    case 'greeted': {
      // `waiting` is counted from the SERVER's candidate list, so "3 things are
      // waiting on you" is a number the server can vouch for. The browser used
      // to supply the whole sentence, number and all.
      return {
        record: true,
        speech: {
          kind: 'greeting',
          text: dailyHelloLine({
            firstName: input.person.firstName,
            sharedLogin: input.person.sharedLogin,
            hour: input.hour,
            fact: todayFact({ waiting: input.candidates.length }),
          }),
          topic: null,
          journal: offerIsJournalable('greeting'),
        },
      };
    }

    case 'notices_announced': {
      if (!input.announcement) return { record: false, because: 'nothing_to_announce' };
      return {
        record: true,
        speech: {
          kind: 'offer',
          text: input.announcement.line,
          // Deliberately none. The never-nag ledger counts declines per topic
          // and drops one for good after two, and waving away "Sarah gave you 3
          // things" twice must not switch off assignment notices forever.
          topic: null,
          journal: offerIsJournalable('offer'),
        },
      };
    }

    case 'spoke': {
      const seen = input.before.topics[input.topic];
      if (seen?.dropped) return { record: false, because: 'topic_dropped' };
      if (seen?.lastOfferedDay === input.today) {
        return { record: false, because: 'topic_already_offered_today' };
      }
      const candidate = input.candidates.find((c) => c.topic === input.topic);
      if (!candidate || !candidate.text.trim()) {
        return { record: false, because: 'no_such_candidate' };
      }
      // ── THE VENUE RULE, MADE STRUCTURAL ──────────────────────────────────
      //
      // Anything about a named person is a `panel_ask` no matter what the
      // request body called it, and a panel ask is never journaled. That was a
      // browser-side decision before: a caller who labelled an attendance
      // pattern `offer` got the sentence written into the hotel's own timeline,
      // where anybody with the Activity Log page open reads it. The claim can
      // still make a thing QUIETER (an operational topic sent as `panel_ask`
      // stays out of the timeline) because narrowing is never a leak.
      const kind: CompanionOfferKind = candidate.sensitivity !== 'operational'
        ? 'panel_ask'
        : input.claimedKind === 'panel_ask' ? 'panel_ask' : 'offer';
      const text = kind === 'panel_ask'
        // No hotel prefix. The panel's own header says which hotel this is.
        ? candidate.text.trim().replace(/\s+/g, ' ')
        : offerSentence({
          text: candidate.text,
          hotelName: input.hotelName,
          multiHotel: input.multiHotel,
        });
      return {
        record: true,
        speech: { kind, text, topic: input.topic, journal: offerIsJournalable(kind) },
      };
    }
  }
}
