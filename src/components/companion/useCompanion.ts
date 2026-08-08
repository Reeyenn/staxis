'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The companion's brain, with no face of its own.
//
// This was CompanionBubble.tsx until the Obsidian design landed. The design
// makes the mark in the corner BOTH the companion at rest and the way into the
// conversation, so there cannot be two objects down there any more. The chat
// surface (thread, composer, streaming, approvals) already lives in
// AskStaxisBar, so the face moved there and everything that decides WHAT the
// companion has to say moved here.
//
// WHAT THIS OWNS
//   • the once-per-(person, hotel) bootstrap read of /api/companion
//   • the decision to speak, delegated whole to decideCompanionSpeech
//   • the one-time teach line after a manual flow
//   • the tour, and walking somebody to a screen from a constant allowlist
//   • persisting what was said, declined, accepted and taught
//
// WHAT IT DOES NOT OWN
//   Any pixel, and any message. It starts no conversation and holds none: when
//   somebody says yes to something that needs talking about, it hands the turn
//   to the one chat brain through the ask bridge, exactly as the bubble did.
//
// WHY THE RULES ARE STILL NOT IN HERE
// The suite runs under --conditions=react-server, where a component or hook
// with React state cannot be mounted in a test. So every rule with a
// consequence stays in src/lib/companion/*, is tested there, and what is left
// here is wiring. Nothing below decides anything a test cannot already reach.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import { subscribeByPolling } from '@/lib/db/_common';
import type { AppRole } from '@/lib/roles';
import { companionMounts } from '@/lib/companion/mount';
import { COMPANION_DECLINES_BEFORE_DROP } from '@/lib/companion/charter';
import {
  decideCompanionSpeech,
  decideDailyHello,
  decidePanelAsk,
  decideTeachMoment,
  parseCompanionMemory,
  DEFAULT_COMPANION_SEVERITY,
  type CompanionCandidate,
  type CompanionMemory,
  type CompanionSeverity,
  type CompanionSpeech,
  type TeachFlow,
} from '@/lib/companion/manners';
import { deliverableFingerprint, mergeDeliverable } from '@/lib/companion/delivery';
import { isTraceTopic, traceCandidate } from '@/lib/companion/trace';
import {
  hintMatches,
  offerIsReplayable,
  parseOfferWire,
  OFFER_STALE_LINE,
  type CompanionOffer,
  type CompanionOfferAction,
  type CompanionOfferKind,
} from '@/lib/companion/offers';
import type { TracePage, TracePattern } from '@/lib/companion/trace/types';
import { useTrace } from './useTrace';
import { publishTraceLine } from './trace-events';
import {
  arrivalLine, companionQuestion, greetingLine, offerQuestionFor,
  replyCouldNotActLine, replyCouldNotSaveLine, replyOutcomeLine, todayFact,
  type SleepReason,
} from '@/lib/companion/copy';
import {
  repliesFor,
  repliesForRole,
  somethingElseReply,
  type CompanionReply,
} from '@/lib/companion/replies';
import {
  decideNoticeAnnouncement,
  newestNoticeAt,
  sortNotices,
  unreadNotices,
  type AssignmentNotice,
} from '@/lib/companion/notices';
import {
  resolveDestination,
  pageForPath,
  type CompanionPage,
  type CompanionPageKey,
} from '@/lib/companion/pages';
import {
  advanceTour,
  currentStop,
  endTourRun,
  startTourRun,
  tourDeedDone,
  tourDestination,
  tourStopsFor,
  type TourContext,
  type TourRun,
} from '@/lib/companion/tour';
import { decideWandering, recordVisit, WANDER_TOPIC, type WanderVisit } from '@/lib/companion/wandering';
import { decideWhatsNew, whatsNewHighWater, whatsNewTopic } from '@/lib/companion/whats-new';
import { whatsNewSentence } from '@/lib/companion/copy';
import { canManageTeam } from '@/lib/roles';
import { useActiveHotelStanding } from '@/lib/capabilities/useCan';
import {
  focusIsTyping,
  subscribeToCompanionBusy,
  subscribeToCompanionDeeds,
  subscribeToCompanionFlow,
} from './companion-events';

/** How long the once-a-day hello stays in the corner before retreating. */
const HELLO_VISIBLE_MS = 6000;

/**
 * The id the Something else escape answers to.
 *
 * A constant rather than a literal in two files, because it is the one reply id
 * that is NOT on the set the hook is holding and therefore the one that cannot
 * be checked against it.
 */
export const ESCAPE_REPLY_ID = 'else';

/** Shared empty, so a dependency array does not see a new array every render. */
const EMPTY_REPLIES: readonly CompanionReply[] = Object.freeze([]);

/**
 * How often an open screen re-asks what the companion has for it.
 *
 * A minute. Fast enough that a colleague handing you work reaches you while
 * you are still standing there, slow enough that a tab left open all shift
 * costs sixty reads against a cap of twelve hundred. The transport pauses
 * entirely while the tab is hidden, so a laptop lid closed at 3pm costs
 * nothing until it opens.
 */
const COMPANION_REFRESH_MS = 60_000;

interface Bootstrap {
  person: { firstName: string | null; role: AppRole; sharedLogin: boolean; isManager: boolean };
  hotel: { id: string; name: string | null; today: string; hour: number | null };
  memory: CompanionMemory;
  wizardAlreadyRan: boolean;
  candidates: CompanionCandidate[];
  /** Assignment notices for this person at this hotel. Empty for a hat with
   *  no chat, because the route ships none. See notices-server.ts. */
  notices?: AssignmentNotice[];
  availability: { awake: boolean; reason: SleepReason | null };
}

/**
 * What the companion currently has to say, if anything.
 *
 * EVERY VARIANT CARRIES ITS OWN REPLIES. There is no shape here with an implied
 * Yes and No: the two renderers walk `replies` and dispatch by intent, so a
 * button that appears is a button something in src/lib/companion/replies.ts
 * wrote, and a card with nothing to ask has an empty list rather than a
 * manufactured pair.
 *
 * `question` is nullable for the same reason. Several kinds ask nothing, and
 * the fix for the fire-panel card was to let them say so.
 */
export type CompanionShowing =
  | { kind: 'none' }
  | {
      kind: 'speech';
      speech: Extract<CompanionSpeech, { kind: 'welcome' | 'offer' }>;
      /** The question under the sentence, or null when it asks nothing. */
      question: string | null;
      replies: readonly CompanionReply[];
      severity: CompanionSeverity;
    }
  | {
      kind: 'teach';
      flow: TeachFlow;
      text: string;
      example: string;
      replies: readonly CompanionReply[];
      severity: CompanionSeverity;
    }
  | {
      kind: 'arrived';
      line: string;
      replies: readonly CompanionReply[];
      severity: CompanionSeverity;
    }
  /**
   * The batched notices line. One utterance about however many things landed,
   * with somewhere to go and a way to close it. See notices.ts for why this
   * class of speech is exempt from the daily caps and what it is still bound by.
   */
  | {
      kind: 'notices';
      line: string;
      through: string;
      replies: readonly CompanionReply[];
    };

/** The replies on whatever is showing. Empty for `none`. */
export function showingReplies(showing: CompanionShowing): readonly CompanionReply[] {
  return showing.kind === 'none' ? [] : showing.replies;
}

/**
 * The one clause the peek shows on hover.
 *
 * Null when there is nothing. That is not a failure state and must not be
 * papered over with a greeting or a tip: the peek is a promise that the
 * sentence in it is true and current, and hover doing nothing is the correct
 * behaviour when no such sentence exists. A wrong sentence is worse than none.
 */
export interface CompanionPeek {
  text: string;
  severity: CompanionSeverity;
}

/** What the trace has to say, and the four things a person can do about it. */
export interface CompanionTraceApi {
  /** The pattern currently drawn on the page, or null. One at a time, ever. */
  showing: TracePattern | null;
  /**
   * The honest line for a walk that arrived too late.
   *
   * Set when somebody said yes on the Staxis list, the router moved, and the
   * pattern was gone by the time the new screen finished loading. Nothing is
   * drawn; this sentence is shown instead.
   */
  stale: string | null;
  /**
   * A pattern that may only be said inside the panel somebody opened.
   *
   * Anything about a named person lives here and nowhere else. See
   * `decidePanelAsk` for why the venue is the whole rule.
   */
  panelAsk: {
    topic: string;
    sentence: string;
    pattern: TracePattern | null;
    /** The venue's own vocabulary. See decidePanelAsk. */
    replies: readonly CompanionReply[];
  } | null;
  /** Runs the one thing the card offered, on the server, from its own plan. */
  act: (index: number) => Promise<{ done: boolean; receipt?: TraceActReceipt; reason?: string }>;
  /** Not interested. Melts everything and counts as a decline. */
  decline: () => void;
  /** Finished with. Melts everything without counting as a decline. */
  close: () => void;
  /**
   * A button on the panel ask, by id.
   *
   * The same shape as the top-level `answer` and for the same reason: the panel
   * ask has THREE honest replies, not two, because "stop watching this" is a
   * thing people want to say about a pattern concerning a colleague. A pair of
   * accept/decline callbacks could not express the third.
   */
  answerPanelAsk: (replyId: string) => void;
}

export interface TraceActReceipt {
  table: string;
  id: string;
  kind: 'created';
  label: string;
  where: string | null;
}

export interface CompanionApi {
  /** False on a housekeeper screen, a public screen, or for a hat with no chat. */
  mounts: boolean;
  /** The AI layer is unavailable, and says so rather than spinning. */
  asleep: boolean;
  sleepReason: SleepReason | null;
  showing: CompanionShowing;
  peek: CompanionPeek | null;
  /**
   * The line the panel opens with when there is no conversation yet.
   *
   * Null until the bootstrap has landed. NEVER a guess: it is a template over
   * the hotel's own clock, this person's name and a count the browser was
   * already given, so an empty bootstrap produces no greeting rather than a
   * cheerful sentence about a hotel nothing has been read from.
   */
  opening: string | null;
  /** The once-a-day hello, while it is being said. Null the rest of the time. */
  hello: string | null;
  /** The screen the person is standing on. */
  page: CompanionPage | null;
  /**
   * The HOTEL's own calendar day, YYYY-MM-DD, or null before the bootstrap.
   *
   * Exposed so a surface that groups by day (the notices list) uses the same
   * day boundary the manners engine does. A night auditor at 1am and a GM at
   * 9am are on the same day by the browser's clock and different ones by the
   * hotel's, and the hotel's is the one the whole product counts by.
   */
  today: string | null;
  /**
   * The tour.
   *
   * `available` is what the "Show me around" entry gates on, and it is never
   * spent: a No on day one stops the OFFER, never the entry. See
   * `tourIsReachable` in manners.ts for why those are different sentences.
   *
   * `run` is null when nothing is running. While it is not null the guide is on
   * the screen, and everything about what happens next is decided by the pure
   * reducers in tour.ts.
   */
  tour: {
    available: boolean;
    run: TourRun | null;
    start: () => void;
    next: () => void;
    skip: () => void;
  };
  /**
   * A person pressed one of the buttons on whatever is showing.
   *
   * ─── WHY THIS REPLACED answerYes / answerNo ────────────────────────────
   *
   * Those two were the whole bug, expressed as an API. A hook that can only be
   * told "yes" or "no" forces every surface above it to render exactly two
   * buttons, which forces every sentence below it to be phrased as a yes/no
   * question, which is how a statement about a fire panel ended up under "Want
   * me to take you to Staxis?". The peek made it literal: it funnelled every
   * non-`no` tap to `answerYes`, so three buttons would have done one thing.
   *
   * A REPLY ID, and nothing else. Never an intent: the id names a button on the
   * set this hook is already holding, and the intent is looked up here. A caller
   * that passed an intent would be a caller choosing one.
   *
   * An id that is not on the current set does nothing at all. That is the right
   * answer to a stale tab: the card moved on, and running yesterday's button
   * against today's card is the class of thing the whole verify-at-tap path
   * exists to refuse.
   */
  answer: (replyId: string) => void;
  /**
   * The way out of a question, or null when nothing is asking one.
   *
   * Rendered after the replies and NOT one of them: it is not a fourth answer,
   * it is the admission that the three were the wrong three. Pressing it opens
   * the conversation with the statement as context, through the ordinary seed
   * machinery, which is the same turn the person could have typed.
   */
  escape: CompanionReply | null;
  dismiss: () => void;
  quiet: () => void;
  goTo: (page: CompanionPage) => void;
  /**
   * Run a turn from the thread again. True when something was drawn or walked
   * to, false when it said the honest stale line instead.
   */
  replayOffer: (offer: CompanionOffer) => boolean;
  /**
   * Resolve a phrase from the conversation to a pattern and draw it. The
   * landing point for the staxis_show_pattern chat tool.
   */
  showPatternByHint: (hint: string) => boolean;
  /** Waved away. Counted by the manners ledger exactly as a No is. */
  dismissOffer: (offer: CompanionOffer) => void;
  /**
   * The turn the companion is waiting on an answer for RIGHT NOW, or null.
   *
   * Deliberately this session's, not "the newest unresolved row in the thread".
   * A pending offer from yesterday is still in the conversation to be read and
   * re-run, but it must never come back as a pill on tomorrow's first page
   * load — that is the nagging the manners engine exists to prevent, and it
   * would arrive through the back door of persistence.
   */
  liveOffer: CompanionOffer | null;
  /** Every assignment notice in the window, newest first. See notices.ts. */
  notices: readonly AssignmentNotice[];
  /** How many of them this person has not opened the list on. */
  unreadNoticeCount: number;
  /** When they last opened the list, ISO, or null for never. */
  noticesSeenAt: string | null;
  /**
   * They opened the list. Advances the read cursor on the server and locally,
   * so the count clears without a second read. Safe to call repeatedly: the
   * reducer is monotonic and the effect is idempotent within a moment.
   */
  markNoticesRead: () => void;
  /** The Trace. See CompanionTraceApi. */
  trace: CompanionTraceApi;
}

/**
 * What the companion needs from the panel to speak into its thread.
 *
 * `open` and `threadEmpty` were always here (the panel ask's venue rule). The
 * other three are the offers-as-chat seam: where to write, what to do with the
 * turn that came back, and how to hand over a conversation the companion had
 * to open because there wasn't one.
 */
export interface CompanionPanelLink {
  open: boolean;
  threadEmpty: boolean;
  /** The conversation on screen, or null when the person has no chat open. */
  conversationId: string | null;
  /** Every companion turn in that conversation, oldest first. */
  offers: readonly CompanionOffer[];
  /** A turn the companion just said, or a state it just changed. */
  onOffer: (offer: CompanionOffer) => void;
  /** The companion opened a thread by speaking; the panel should adopt it. */
  onConversation: (conversationId: string) => void;
  /**
   * Somebody said yes to the notices line. The panel owns the list surface, so
   * the hook asks for it rather than rendering one: the same seam as `onSeed`,
   * and for the same reason. A companion with no panel attached simply has
   * nowhere to show it, which is the honest degradation.
   */
  onShowNotices: () => void;
}

/**
 * The companion with no panel attached.
 *
 * Every callback is a no-op and the thread is empty, which is the honest
 * degradation: a companion that cannot reach a conversation still decides and
 * still speaks, its sentences just are not written down. That is exactly what
 * this feature replaced, so it is a safe place to land rather than a broken one.
 */
const DETACHED_PANEL: CompanionPanelLink = {
  open: false,
  threadEmpty: true,
  conversationId: null,
  offers: [],
  onOffer: () => {},
  onConversation: () => {},
  onShowNotices: () => {},
};

/** Screens a trace can be about. Anything else asks for nothing. */
function tracePageFor(page: CompanionPage | null): TracePage | null {
  if (!page) return null;
  if (page.key === 'maintenance' || page.key === 'inventory' || page.key === 'staxis') return page.key;
  return null;
}

/**
 * @param onSeed  How to hand a turn to the one chat brain. The companion never
 *                sends a message itself; it asks the caller to.
 * @param panel   What the panel is doing, for the one decision that depends on
 *                it. A pattern about a person may only be said to somebody who
 *                opened the panel themselves, so the venue has to be an input.
 */
export function useCompanion(
  onSeed: (text?: string) => void,
  panel: CompanionPanelLink = DETACHED_PANEL,
): CompanionApi {
  // The panel's props behind a ref. `remember` is memoized on the hotel alone
  // and fires from timers and callbacks armed long before the render that
  // supplies these, so closing over them directly would post an offer into
  // whichever conversation was open when the bar first mounted — which on this
  // app is very often none at all.
  const panelRef = useRef<CompanionPanelLink>(panel);
  panelRef.current = panel;
  const { user } = useAuth();
  const { activeProperty, activePropertyId, properties } = useProperty();
  const pathname = usePathname();
  const router = useRouter();

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [showing, setShowing] = useState<CompanionShowing>({ kind: 'none' });
  /**
   * The showing AS RENDERED, for the answer dispatcher.
   *
   * Written by the effect at the bottom of this hook from `showingOut`, whose
   * replies are the ones a person can actually see. Everything else in here
   * reads `showing` directly; only the dispatcher needs the rendered version,
   * and only because one card's buttons are completed at render time.
   */
  const showingRef = useRef<CompanionShowing>({ kind: 'none' });
  const [quietThisSession, setQuiet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tourRun, setTourRun] = useState<TourRun | null>(null);

  /**
   * Is a tour on the screen right now?
   *
   * Declared up here with the state it derives from, because two mouths lower
   * down read it before the tour's own block is reached and a `const` cannot
   * be read before it exists. Both of them must stay shut while it is true:
   * one thing at a time applies to the tour most of all, since the tour is
   * already standing beside a control asking for something.
   */
  const tourRunning = tourRun !== null && tourRun.ended === null;
  const tourRunningRef = useRef(tourRunning);
  tourRunningRef.current = tourRunning;

  const role = (user?.role ?? null) as AppRole | null;
  const gate = companionMounts({ pathname, role });

  // ── What this person's own screen would have rendered ────────────────────
  //
  // The same two facts `staxis_point_at` resolves on the server, resolved here
  // from the same authorization domain: a manager with mutation standing, and
  // the money capability. Deliberately not "is this hat usually a manager" —
  // that answers true for a GM whose hotel never granted them the capability,
  // and the tour would then stop on a control that was never on their screen.
  const hotelStanding = useActiveHotelStanding();
  const tourCtx = useMemo<TourContext>(() => ({
    role,
    enabledSections: activeProperty?.enabledSections,
    standing: {
      canManage: role !== null && canManageTeam(role) && hotelStanding.hotelMutationAllowed,
      seesMoney: hotelStanding.seesFinancials,
      enabledSections: activeProperty?.enabledSections,
    },
  }), [role, activeProperty?.enabledSections, hotelStanding.hotelMutationAllowed, hotelStanding.seesFinancials]);

  // ── Bootstrap, and then delivery ─────────────────────────────────────────
  //
  // This used to be a single fetch per (person, hotel), with a comment saying
  // "deliberately not a poll: nothing here is live". That was true of the
  // greeting and false of the thing people actually notice: work a colleague
  // hands you while your screen is open never arrived until you reloaded, and
  // nobody reloads a page they are already looking at.
  //
  // ─── WHY THIS IS NOT subscribeTable ────────────────────────────────────
  //
  // Because it cannot be, and the reason is worth writing down so nobody
  // "upgrades" it. A notice is derived from `comms_tasks`, which migration 0396
  // revoked from anon AND authenticated and gave a `using (false)` select
  // policy: the browser cannot read a row of it, and Realtime authorizes
  // postgres_changes against exactly those grants. The table is not in the
  // `supabase_realtime` publication either. A channel on it would deliver
  // nothing, silently, forever, which is the worst of all shapes.
  //
  // So this uses the OTHER transport in the same module, which exists for
  // precisely this case (see its header in src/lib/db/_common.ts): the read
  // stays on the server behind /api/companion where the service role can see
  // the rows, requests never overlap, the loop pauses while the tab is hidden
  // and catches up on foreground and on reconnect. What is preserved from the
  // subscribeTable contract is the part that matters: the payload is never
  // diff-merged, every refresh is a whole fresh snapshot.
  //
  // ─── WHAT A REFRESH IS ALLOWED TO REPLACE ──────────────────────────────
  //
  // Notices and candidates, and nothing else. Not the memory: the browser
  // holds an optimistic copy between "the companion spoke" and the server
  // agreeing, and a poll landing in that window would roll `welcomedAt` back
  // and greet somebody a second time. Not the person or the hotel either,
  // which do not change under a person who is standing still.
  //
  // The two halves of the scope, as plain dependencies. A change to either
  // tears the loop down and starts a new one, which is what stops one hotel's
  // notices ever landing under another hotel's name.
  const personId = user?.uid ?? null;

  useEffect(() => {
    if (!gate.mounts || !activePropertyId || !personId) return;
    setBoot(null);
    setShowing({ kind: 'none' });
    setTourRun(null);
    let first = true;

    const subscription = subscribeByPolling<Bootstrap>(
      async () => {
        try {
          const res = await fetchWithAuth(`/api/companion?pid=${encodeURIComponent(activePropertyId)}`);
          const envelope = await readEnvelope<Bootstrap>(res);
          if (envelope.error !== undefined || !envelope.data) return [];
          return [envelope.data];
        } catch (e) {
          // A signed-out mid-request is already redirecting; anything else
          // means the companion simply has nothing to offer this moment. It is
          // a greeter, not a dependency, so an empty snapshot is published
          // rather than an error raised.
          if (e instanceof SessionEndedError) return [];
          return [];
        }
      },
      (rows) => {
        const next = rows[0];
        if (!next) return;
        if (first) {
          first = false;
          setBoot({ ...next, memory: parseCompanionMemory(next.memory) });
          return;
        }
        setBoot((b) => (b
          ? mergeDeliverable(b, next)
          : { ...next, memory: parseCompanionMemory(next.memory) }));
      },
      undefined,
      {
        pollIntervalMs: COMPANION_REFRESH_MS,
        // A snapshot that says the same thing publishes nothing, so an idle
        // screen re-renders zero times an hour.
        isEqual: (previous, nextRows) =>
          deliverableFingerprint(previous[0]) === deliverableFingerprint(nextRows[0]),
      },
    );
    return () => subscription.unsubscribe();
  }, [gate.mounts, activePropertyId, personId]);

  // ── Busy ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!gate.mounts) return;
    const off = subscribeToCompanionBusy(setBusy);
    const onKey = () => {
      if (focusIsTyping(document.activeElement)) setBusy(true);
    };
    const onBlur = () => setBusy(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('focusout', onBlur);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focusout', onBlur);
    };
  }, [gate.mounts]);

  // ── Remembering ──────────────────────────────────────────────────────────
  // The server owns the reducers, so this posts an EVENT and takes back the new
  // memory. On a failure it still advances local state: inside one page load,
  // being greeted twice is worse than losing a decline.
  //
  // ─── ONE CALL, TWO CONSEQUENCES ────────────────────────────────────────
  // The response may carry an OFFER as well as the new memory: the same event
  // that counted a No is the one that stamped the message in the thread. That
  // is deliberate and is the whole reason there is still only one decline
  // ledger — the message state is not something a caller can set on its own,
  // it arrives as a side effect of telling the manners engine what happened.
  const remember = useCallback(async (
    event: string,
    extra: Record<string, unknown>,
    optimistic: (m: CompanionMemory) => CompanionMemory,
  ): Promise<CompanionOffer | null> => {
    setBoot((b) => (b ? { ...b, memory: optimistic(b.memory) } : b));
    if (!activePropertyId) return null;
    try {
      const res = await fetchWithAuth('/api/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, event, ...extra }),
      });
      const envelope = await readEnvelope<{
        memory: CompanionMemory; offer?: unknown; conversationId?: unknown;
      }>(res);
      if (envelope.error === undefined && envelope.data) {
        setBoot((b) => (b ? { ...b, memory: parseCompanionMemory(envelope.data!.memory) } : b));
        const offer = parseOfferWire(envelope.data.offer);
        if (offer) {
          if (typeof envelope.data.conversationId === 'string') {
            // The companion had to open a thread to speak into. The panel takes
            // it over so the person's next message continues the same one
            // rather than starting a second beside it.
            panelRef.current.onConversation(envelope.data.conversationId);
          }
          panelRef.current.onOffer(offer);
          return offer;
        }
      }
    } catch { /* optimistic state stands for this page load */ }
    return null;
  }, [activePropertyId]);

  const page = useMemo(() => pageForPath(pathname), [pathname]);

  // ── Saying it out loud, and writing it down ──────────────────────────────
  //
  // One place, so every sentence the companion speaks first takes the same
  // route into the thread and nothing can be said without being recorded. The
  // conversation id travels from the panel; when there wasn't one, the server
  // opens a thread and hands the id back for the panel to adopt.
  const liveOfferRef = useRef<{ topic: string | null; id: string } | null>(null);
  // The same turn as state, for the pill. A ref alone cannot re-render the
  // buttons into existence, and state alone is stale inside the callbacks the
  // answers fire from — so both, written together and cleared together.
  const [liveOffer, setLiveOffer] = useState<CompanionOffer | null>(null);

  const say = useCallback(async (
    event: 'spoke' | 'greeted' | 'welcomed' | 'notices_announced',
    speech: {
      text: string;
      kind: CompanionOfferKind;
      topic?: string | null;
      page?: string | null;
      actions?: readonly CompanionOfferAction[];
    },
    optimistic: (m: CompanionMemory) => CompanionMemory,
    /** Fields the event itself needs, beyond the sentence. */
    extra: Record<string, unknown> = {},
  ) => {
    const offer = await remember(event, {
      ...(speech.topic ? { topic: speech.topic } : {}),
      ...extra,
      text: speech.text,
      kind: speech.kind,
      page: speech.page ?? null,
      actions: speech.actions ?? [],
      conversationId: panelRef.current.conversationId,
    }, optimistic);
    if (!offer) return;
    // Only a turn that can still be answered is worth remembering the id of.
    if (offer.state === 'pending') {
      liveOfferRef.current = { topic: offer.topic, id: offer.id };
      setLiveOffer(offer);
    }
  }, [remember]);

  /**
   * Stamp the answer onto the sentence it was about.
   *
   * Fires alongside the manners event rather than instead of it: the ledger
   * call is the one that counts the No, and this is the one that makes it
   * legible. A missing id (the write failed, or a second tab already answered)
   * costs nothing — the ledger still heard it.
   */
  const stampLive = useCallback((
    topic: string | null,
    state: 'accepted' | 'declined' | 'dismissed',
  ): Record<string, unknown> => {
    const live = liveOfferRef.current;
    if (!live) return {};
    if (topic !== null && live.topic !== null && live.topic !== topic) return {};
    liveOfferRef.current = null;
    setLiveOffer(null);
    return { offerId: live.id, offerState: state };
  }, []);

  /**
   * Take the pill and the mark's ring down without recording an answer.
   *
   * For the notices line, which is a MESSAGE rather than a question: it carries
   * a button because there is somewhere useful to go, not because the companion
   * is asking permission for anything. It stays in the thread exactly as it was
   * said, in the same unanswered state the once-a-day hello sits in, and no
   * ledger hears about it either way. See the no-topic note where it is spoken.
   */
  const retireLiveOffer = useCallback(() => {
    liveOfferRef.current = null;
    setLiveOffer(null);
  }, []);

  // ── Notices ──────────────────────────────────────────────────────────────
  //
  // Derived on the server and shipped with the bootstrap, so the list costs no
  // read of its own and the count on the strip is true the moment the panel
  // mounts. Everything below is presentation over that one array.
  const notices = useMemo(
    () => sortNotices(boot?.notices ?? []),
    [boot],
  );
  const unreadNoticeCount = useMemo(
    () => unreadNotices(notices, boot?.memory.noticesSeenAt ?? null).length,
    [notices, boot],
  );

  /**
   * They opened the list.
   *
   * Optimistic locally and monotonic on the server, so the count clears at once
   * and a second call (a re-open, a second tab) changes nothing. The cursor is
   * the SERVER's clock; the optimistic value here is only so the badge does not
   * hang around for the length of a round trip.
   */
  const markNoticesRead = useCallback(() => {
    const newest = newestNoticeAt(notices);
    if (!newest) return;
    if (boot?.memory.noticesSeenAt && Date.parse(boot.memory.noticesSeenAt) >= Date.parse(newest)) {
      return;
    }
    void remember('notices_seen', {}, (m) => ({ ...m, noticesSeenAt: new Date().toISOString() }));
  }, [notices, boot, remember]);

  // ── The Trace ────────────────────────────────────────────────────────────
  //
  // Patterns for the screen underneath, folded into the same candidate list
  // everything else the companion says goes through. From here down there is
  // no such thing as a "trace decision": the manners engine sees candidates,
  // and a trace is a candidate.
  const tracePage = useMemo(() => tracePageFor(page), [page]);
  const traces = useTrace(
    activePropertyId,
    tracePage,
    gate.mounts && boot !== null && boot.availability.awake,
  );

  // ── Wandering ────────────────────────────────────────────────────────────
  //
  // A trail of arrivals, bounded twice (see wandering.ts), kept in a ref
  // because it is evidence rather than state: nothing renders differently
  // because somebody visited a fourth screen, and putting it in state would
  // re-render the whole companion on every navigation.
  const trailRef = useRef<readonly WanderVisit[]>([]);
  const lastActionAtRef = useRef<number | null>(null);
  const [wanderTick, setWanderTick] = useState(0);
  useEffect(() => {
    if (!gate.mounts || !page) return;
    trailRef.current = recordVisit(trailRef.current, { page: page.key, at: Date.now() });
    // One number, bumped on arrival, so the candidate list below recomputes
    // exactly when the evidence changed and never on a timer.
    setWanderTick((t) => t + 1);
  }, [gate.mounts, page]);

  // Any real write clears the hunt. Deeds are the honest signal for this: they
  // are fired by the screens that own a write, after the server said yes, so
  // "they did something" here means the same thing it means to the tour.
  useEffect(() => {
    if (!gate.mounts) return;
    return subscribeToCompanionDeeds(() => { lastActionAtRef.current = Date.now(); });
  }, [gate.mounts]);

  const candidates = useMemo<CompanionCandidate[]>(() => {
    const fromFindings = boot?.candidates ?? [];
    const extra: CompanionCandidate[] = [];

    // ── Something changed since they last looked ──────────────────────────
    //
    // Ahead of the wandering offer because it is a fact about the product and
    // the other is an inference about a person; when both are somehow true,
    // the fact wins. Behind traces and findings because a hotel with a real
    // problem in it should hear about the problem.
    if (boot) {
      const news = decideWhatsNew(tourCtx, boot.memory);
      if (news.show) {
        extra.push({
          topic: news.topic,
          text: whatsNewSentence(news.entry.headline),
          sensitivity: 'operational',
          covers: [],
          // No destination. The mini tour draws on the screen they are already
          // standing on and takes itself wherever it needs to go, so walking
          // somebody first would be navigating them in order to navigate them.
          destination: null,
          severity: 'ok',
          replyKind: 'whats_new',
          replies: repliesFor({ kind: 'whats_new' }),
        });
      }
      // ── Looking for something ───────────────────────────────────────────
      const lost = decideWandering({
        visits: trailRef.current,
        lastActionAt: lastActionAtRef.current,
        now: Date.now(),
        memory: boot.memory,
      });
      if (lost.wandering) extra.push(lost.candidate);
    }

    if (traces.patterns.length === 0) return [...fromFindings, ...extra];
    // Traces lead. A pattern about the screen somebody is looking at is more
    // use than a card about somewhere else, and the manners engine takes the
    // first candidate that survives its rules.
    return [...traces.patterns.map(traceCandidate), ...fromFindings, ...extra];
    // `wanderTick` is the dependency that makes the trail visible to this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, traces.patterns, tourCtx, wanderTick]);

  const [traceShowing, setTraceShowing] = useState<TracePattern | null>(null);
  const [traceStale, setTraceStale] = useState<string | null>(null);
  // A yes given on one screen, waiting for another screen to finish loading.
  const walkingToRef = useRef<string | null>(null);

  // Nothing survives a change of screen. A trace is drawn against rows that no
  // longer exist the moment the router moves.
  useEffect(() => {
    setTraceShowing(null);
    setTraceStale(null);
  }, [pathname]);

  // The landing half of a walk. The patterns for the NEW screen have come back;
  // either the one somebody said yes to is still there, or it is not and that
  // gets said in one sentence rather than drawn as an empty diagram.
  useEffect(() => {
    const wanted = walkingToRef.current;
    if (!wanted || !traces.settled) return;
    walkingToRef.current = null;
    const landed = traces.patterns.find((p) => p.key === wanted);
    if (landed) setTraceShowing(landed);
    else setTraceStale('This got handled already, so there is nothing to show you.');
  }, [traces.settled, traces.patterns]);

  // ── Deciding to speak ────────────────────────────────────────────────────
  // Runs when the bootstrap lands and when the page changes. Every rule is in
  // decideCompanionSpeech; this only supplies the inputs and acts on the answer.
  const spokenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!boot || !gate.mounts) return;
    if (showing.kind !== 'none') return;
    // A tour owns the screen while it is running. An offer stacked on a stop
    // would be two companion cards at once, and the second one would be
    // interrupting a walk the person asked for.
    if (tourRunning) return;

    const onScreen = page?.key === 'staxis'
      // The Staxis list shows the findings themselves. Announcing one while it
      // is on the screen is the app saying the same true thing twice, which
      // reads as a bug. Suppress the whole class rather than diffing ids: the
      // card list is live and paginated, and a stale id set would be a
      // suppression that silently stopped working.
      ? boot.candidates.flatMap((c) => c.covers)
      : [];

    // A trace already drawn on this screen is the loudest thing in the room.
    // Offering a second one over the top of it would be two things at once,
    // which is the rule the whole engine exists to keep.
    if (traceShowing !== null) return;

    const speech = decideCompanionSpeech({
      now: new Date(),
      today: boot.hotel.today,
      person: {
        firstName: boot.person.firstName,
        role: boot.person.role,
        sharedLogin: boot.person.sharedLogin,
      },
      memory: boot.memory,
      candidates,
      onScreen,
      userIsBusy: busy,
      quietThisSession,
      aiAwake: boot.availability.awake,
      wizardAlreadyRan: boot.wizardAlreadyRan,
      multiHotel: properties.length > 1,
      hotelName: activeProperty?.name ?? boot.hotel.name,
    });

    if (speech.kind === 'silent') {
      if (speech.markWelcomed && boot.memory.welcomedAt === null) {
        void remember('welcomed', {}, (m) => ({ ...m, welcomedAt: new Date().toISOString() }));
      }
      // ── The fourth mouth ────────────────────────────────────────────────
      //
      // Reached only when the engine above had nothing operational to raise,
      // which is what keeps "one thing, never two" true: a hotel with a real
      // problem in it gets told about the problem, and the notices line waits
      // for the next screen. What it does NOT wait for is a cap — every
      // silence reason above, including `daily_cap_reached` and the hello
      // having already gone out, lands here and the announcement still fires.
      // That is the founder's exemption, made structural by position.
      //
      // Nothing is announced on day one either: a welcome is not a silence, so
      // this branch is not reached until somebody has actually been welcomed.
      if (boot.memory.welcomedAt) {
        const decision = decideNoticeAnnouncement({
          notices: boot.notices ?? [],
          announcedThrough: boot.memory.noticesAnnouncedThrough,
          today: boot.hotel.today,
          userIsBusy: busy,
          quietThisSession,
          aiAwake: boot.availability.awake,
        });
        if (decision.announce) {
          const key = `notices:${decision.through}`;
          if (spokenFor.current === key) return;
          spokenFor.current = key;
          // The reply set the SERVER will store is derived there, from the same
          // producer, over the same batch. This local copy is what the pill
          // renders in the meantime; when the offer comes back the two agree
          // because there is one table and both read it.
          const noticeReplies = repliesFor({
            kind: 'notices',
            hasRefusal: (boot.notices ?? []).some((n) => n.kind === 'refused'),
          });
          setShowing({
            kind: 'notices',
            line: decision.line,
            through: decision.through,
            replies: noticeReplies,
          });
          void say('notices_announced', {
            kind: 'offer',
            // No topic. The never-nag ledger counts declines per TOPIC and
            // drops one for good after two, which is right for something the
            // companion noticed and catastrophic for a message a colleague
            // sent: waving away "Sarah gave you 3 things" twice must not
            // switch off assignment notices forever. What stops this line
            // repeating is the batch stamp, not a decline count.
            text: decision.line,
          }, (m) => ({ ...m, noticesAnnouncedThrough: decision.through }), {
            through: decision.through,
          });
        }
      }
      return;
    }
    // One utterance per page view. Without this the effect re-fires on every
    // busy/quiet flip and the same offer reappears the moment somebody stops
    // typing, which is the opposite of the manners this is all for.
    const key = `${speech.kind}:${speech.kind === 'offer' ? speech.topic : 'welcome'}:${pathname}`;
    if (spokenFor.current === key) return;
    spokenFor.current = key;

    setShowing({
      kind: 'speech',
      speech,
      // THE QUESTION COMES FROM THE KIND, NOT FROM THE DESTINATION.
      //
      // This line is the fix. It used to be `offerQuestion(resolveDestination(
      // speech.destination, …))`, which is to say: work out where a yes would
      // navigate to, and write a question about that. Under a statement about a
      // fire panel that produced "Want me to take you to Staxis?" over a Yes and
      // a No thanks, which answers nothing anybody asked. The candidate now
      // carries which vocabulary it speaks, and several of those vocabularies
      // ask NOTHING, which is why this may be null.
      question: speech.kind === 'welcome'
        ? speech.question
        : companionQuestion(offerQuestionFor(speech.replyKind), speech.judgedQuestion),
      replies: speech.kind === 'welcome'
        // `tourStopsFor` rather than the memoized `tourStops` below: this
        // effect is declared above that declaration, and naming it in a
        // dependency array would read it before it exists. It is a pure
        // function over one value this scope already holds.
        //
        // The page is the FIRST STOP's, and the reply's `walk` intent is
        // honest about it: the tour really does open on that screen. What the
        // walk does not say is that a run starts as well, which is why the
        // welcome branch in `answer` calls `startTour` rather than navigating.
        ? repliesFor({ kind: 'welcome', page: tourStopsFor(tourCtx)[0]?.page ?? null })
        // The candidate's OWN replies, built beside the sentence, passed
        // through untouched. Re-deriving them here is the bug.
        : repliesForRole(speech.replies, role),
      severity: speech.kind === 'offer' ? speech.severity : DEFAULT_COMPANION_SEVERITY,
    });
    if (speech.kind === 'welcome') {
      void say('welcomed', {
        kind: 'greeting',
        text: `${speech.greeting} ${speech.question}`.trim(),
      }, (m) => ({ ...m, welcomedAt: new Date().toISOString() }));
    } else {
      const topic = speech.topic;
      void say('spoke', {
        kind: 'offer',
        text: speech.sentence,
        topic,
        page: speech.destination,
      }, (m) => ({
        ...m,
        lastSpokeAt: new Date().toISOString(),
        spokenDay: boot.hotel.today,
        spokenCount: (m.spokenDay === boot.hotel.today ? m.spokenCount : 0) + 1,
      }));

      // ── The two topics that get exactly one airing, ever ────────────────
      //
      // The ordinary ledger says "not again today" and drops a topic after two
      // Nos, which is right for something the companion noticed and wrong for
      // both of these. The wandering offer teaches ONE ability; asking a
      // second time is the app repeating itself at somebody it already
      // implied was lost. A shipped change is news, and news is only new once.
      //
      // Dropped on SHOWING rather than on an answer, so walking away counts
      // the same as a No. That is the same rule the discovery pointer's "do
      // not show this again" uses, through the same reducer.
      if (topic === WANDER_TOPIC || topic.startsWith('whatsnew:')) {
        void remember('dropped', { topic }, (m) => ({
          ...m,
          topics: {
            ...m.topics,
            [topic]: { declines: COMPANION_DECLINES_BEFORE_DROP, dropped: true, lastOfferedDay: boot.hotel.today },
          },
        }));
      }
      // Caught up, whatever they answer. A person who was shown the newest
      // change is caught up on everything older than it too, so the cursor
      // moves to the high-water mark rather than to this entry.
      if (topic.startsWith('whatsnew:')) {
        const through = whatsNewHighWater();
        if (through) {
          void remember('whats_new_seen', { through }, (m) => ({ ...m, whatsNewThrough: through }));
        }
      }
    }
  }, [
    boot, gate.mounts, showing.kind, pathname, page, busy, quietThisSession,
    properties.length, activeProperty?.name, activeProperty?.enabledSections, role, remember,
    candidates, traceShowing, say, tourRunning, tourCtx,
  ]);

  // ── Teach at the moment ──────────────────────────────────────────────────
  //
  // Silent while a tour is running. The tour's own `try` stop is standing on
  // this exact moment with an arrow on the control, and following the person's
  // first to-do with "next time you can just tell me" would be the companion
  // congratulating somebody on a step it had just asked them to take, in a
  // second card, over the first. The tip is not spent: `taught` is only
  // stamped when the line is actually shown, so it is still owed afterwards.
  useEffect(() => {
    if (!gate.mounts || tourRunningRef.current) return;
    return subscribeToCompanionFlow((flow) => {
      setBoot((b) => {
        if (!b) return b;
        const decision = decideTeachMoment({
          flow,
          memory: b.memory,
          role: b.person.role,
          userIsBusy: busy,
          quietThisSession,
          aiAwake: b.availability.awake,
        });
        if (!decision.teach) return b;
        setShowing({
          kind: 'teach',
          flow,
          text: decision.text,
          example: decision.example,
          replies: repliesFor({ kind: 'teach', seed: decision.example }),
          severity: 'ok',
        });
        void remember('taught', { flow }, (m) => ({
          ...m, taught: { ...m.taught, [flow]: true },
        }));
        return b;
      });
    });
    // `tourRunning` re-arms the listener the moment a tour ends, so the tip is
    // available again on the next flow the person completes on their own.
  }, [gate.mounts, busy, quietThisSession, remember, tourRunning]);

  // ── Walking somebody somewhere ───────────────────────────────────────────
  // Client-side navigation to a CONSTANT from the allowlist. `page.href` is a
  // literal declared in pages.ts; nothing typed, stored or returned by a model
  // ever reaches router.push.
  const goTo = useCallback((target: CompanionPage) => {
    router.push(target.href);
    // The Next button is filled in at RENDER time, not here (see `showingOut`).
    // `startTour` sets the step and calls this in the same tick, so the step
    // this callback could read is always the one before the move.
    setShowing({
      kind: 'arrived',
      line: arrivalLine(target.key),
      replies: repliesFor({ kind: 'arrival', page: null, pageLabel: null }),
      severity: 'ok',
    });
  }, [router]);

  // ── The tour ─────────────────────────────────────────────────────────────
  //
  // Every decision below is `tour.ts`. What is here is three things only: put
  // the run in state, move the router when the stop's screen is not the screen
  // underneath, and tell the server how it ended.

  const tourStops = useMemo(() => tourStopsFor(tourCtx), [tourCtx]);

  const startTour = useCallback(() => {
    setShowing({ kind: 'none' });
    if (tourStops.length === 0) return;
    setTourRun(startTourRun(tourStops));
    // Stamped at the START, not at the end. Somebody who begins a tour and
    // closes the tab has had the offer, and re-offering it on their next visit
    // would be the companion asking a question it already asked.
    void remember('tour_taken', {}, (m) => ({ ...m, tourTakenAt: new Date().toISOString() }));
  }, [tourStops, remember]);

  const nextTourStep = useCallback(() => {
    setTourRun((run) => (run ? advanceTour(run) : run));
  }, []);

  const skipTour = useCallback(() => {
    setTourRun((run) => (run ? endTourRun(run, 'skipped') : run));
  }, []);

  // The real thing landed. Only the deed this stop asked for moves it on; the
  // reducer owns that rule so a second listener cannot get it wrong.
  useEffect(() => {
    if (tourRun === null || tourRun.ended !== null) return;
    return subscribeToCompanionDeeds((deed) => {
      setTourRun((run) => (run ? tourDeedDone(run, deed) : run));
    });
  }, [tourRun]);

  // ── Walking between stops ────────────────────────────────────────────────
  //
  // `goTo` takes a CONSTANT from the allowlist in pages.ts, exactly as the
  // "take me there" button does. A stop names a page KEY; `tourDestination`
  // turns it into the one href that key is allowed to have, or into null,
  // which cannot happen for a stop that survived `tourStopsFor` and is handled
  // anyway rather than asserted away.
  //
  // Deliberately NOT `goTo`: that also sets the `arrived` speech, and a tour
  // that narrated its own arrival would say two things about one screen.
  const tourStopKey = tourRun && tourRun.ended === null ? currentStop(tourRun)?.key ?? null : null;
  useEffect(() => {
    if (!tourRun || tourRun.ended !== null) return;
    const stop = currentStop(tourRun);
    if (!stop) return;
    const target = tourDestination(stop, tourCtx);
    if (!target) return;
    if (pathname === target.href) return;
    router.push(target.href);
    // Keyed on the STOP, not the run: a run object changes identity when a
    // wait clears, and re-pushing the same href on that change would reload
    // the screen out from under somebody who had just typed on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourStopKey]);

  // ── How it ended ─────────────────────────────────────────────────────────
  //
  // One post, once, when the run reaches a terminal state. Journaled on the
  // server so the hotel's own record holds the fact that somebody walked out
  // half way, and read by nothing that speaks: the companion never mentions a
  // skipped tour, to anybody, ever.
  const endedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tourRun || tourRun.ended === null) return;
    const ending = tourRun.ended;
    if (endedRef.current === ending) return;
    endedRef.current = ending;
    void remember('tour_ended', { ending }, (m) => ({
      ...m,
      tourTakenAt: m.tourTakenAt ?? new Date().toISOString(),
      tourEndedAs: m.tourEndedAs ?? ending,
    }));
    // The card goes as soon as the last stop is answered. A closing sentence
    // in the corner would be the companion taking one more turn after being
    // told it was done.
    setTourRun(null);
  }, [tourRun, remember]);

  // A new run is a new ending to record.
  useEffect(() => { if (tourRun && tourRun.ended === null) endedRef.current = null; }, [tourRun]);

  const tour = useMemo(() => ({
    available: tourStops.length > 0,
    run: tourRun,
    start: startTour,
    next: nextTourStep,
    skip: skipTour,
  }), [tourStops.length, tourRun, startTour, nextTourStep, skipTour]);

  // ── Answers ──────────────────────────────────────────────────────────────
  //
  // ONE ENTRY POINT, DISPATCHING BY INTENT. Every button on every companion
  // surface arrives here as an id, is resolved against the reply set this hook
  // is already holding, and is then acted on by what its intent SAYS, not by
  // which side of the card it happened to be on.
  //
  // A CLOSE SAYS NOTHING BACK. No "no problem", no "I will remember that". A
  // reply to a No is the app making somebody's dismissal into a conversation,
  // and nothing is lost by staying quiet: the thing the offer was about is
  // still on its own screen.

  /** The corner's one transient line: an outcome, said once, then gone. */
  const [saidBack, setSaidBack] = useState<string | null>(null);
  useEffect(() => {
    if (saidBack === null) return;
    const timer = setTimeout(() => setSaidBack(null), HELLO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [saidBack]);

  /**
   * Record a verdict against a finding, through the route the card already uses.
   *
   * Same body, same gate, same rate limiter. The companion adds no path around
   * POST /api/findings: this is the card's own button, reachable from the
   * corner. Success says nothing, exactly as the card says nothing: the thing
   * has been filed and the card is gone, which is the whole message.
   */
  const recordVerdict = useCallback(async (findingId: string, verdict: string) => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth('/api/findings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, findingId, action: verdict }),
      });
      const envelope = await readEnvelope<{ status: string }>(res);
      if (envelope.error !== undefined) setSaidBack(replyCouldNotSaveLine());
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      setSaidBack(replyCouldNotSaveLine());
    }
  }, [activePropertyId]);

  /**
   * Run the finding's FROZEN plan, through the verify-at-tap path.
   *
   * The browser sends an id and the word `execute`. It does not send the plan,
   * the location or the severity: the server loads the action it froze, checks
   * the company's signature, and re-derives the facts inside the transaction
   * that would do the work. A stale tab cannot write a ticket about a problem
   * somebody already fixed, and a refusal comes back as a sentence rather than
   * as silence.
   */
  const runFrozenPlan = useCallback(async (actionId: string) => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth('/api/findings/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, actionId, intent: 'execute' }),
      });
      const envelope = await readEnvelope<{
        code?: string; receipt?: { label?: string | null } | null;
      }>(res);
      if (envelope.error !== undefined) {
        // The route's own sentence when it has one: a company sign-off refusal
        // says WHY, and replacing that with a generic line would hide the rule
        // the person actually needs to know about.
        setSaidBack(envelope.error || replyCouldNotActLine());
        return;
      }
      setSaidBack(replyOutcomeLine({
        code: envelope.data?.code ?? null,
        receiptLabel: envelope.data?.receipt?.label ?? null,
      }));
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      setSaidBack(replyCouldNotActLine());
    }
  }, [activePropertyId]);

  /** Drop a topic for good, first time asked. The pointer's own precedent. */
  const quietTopic = useCallback((topic: string) => {
    void remember('dropped', { topic, ...stampLive(topic, 'declined') }, (m) => {
      const prior = m.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
      return { ...m, topics: { ...m.topics, [topic]: { ...prior, dropped: true } } };
    });
  }, [remember, stampLive]);

  const answer = useCallback((replyId: string) => {
    // `showingRef`, not `showing`. The arrival card's Next button is filled in
    // at RENDER time (see `showingOut`), because `goTo` cannot know which tour
    // step it is on. A lookup against the raw state would search a set that has
    // never contained the button somebody just pressed, and the tour's Next
    // would silently do nothing from the second screen onwards.
    const current = showingRef.current;
    if (current.kind === 'none') return;
    // The escape is not on the reply set (it is not one of the three), so it is
    // resolved separately and only where a question is actually being asked.
    const reply = replyId === ESCAPE_REPLY_ID
      ? somethingElseReply()
      : current.replies.find((r) => r.id === replyId);
    // An id that is not on this set does nothing, deliberately. A stale tab
    // pressing yesterday's button against today's card is exactly what the
    // verify-at-tap path exists to refuse, and the cheapest refusal is here.
    if (!reply) return;
    const intent = reply.intent;

    // ── Day one ────────────────────────────────────────────────────────────
    if (current.kind === 'speech' && current.speech.kind === 'welcome') {
      setShowing({ kind: 'none' });
      if (intent.kind === 'close') {
        void remember('tour_declined', { ...stampLive(null, 'declined') },
          (m) => ({ ...m, tourDeclined: true }));
        return;
      }
      // Something else, on day one. It is neither a yes nor a no to the tour,
      // so nothing is recorded about the tour: it stays offerable from the
      // panel, and the person gets the conversation they reached for.
      //
      // Checked BEFORE the tour branch. Without it the escape falls through to
      // `startTour()` and walks somebody who asked to talk instead.
      if (intent.kind === 'seed') {
        onSeed(intent.text || current.speech.greeting);
        return;
      }
      // A yes to the welcome IS the tour, and the tour owns the walking: it
      // stamps `tourTakenAt` and holds the step counter, neither of which a
      // bare navigation would do.
      startTour();
      return;
    }

    // ── The teach line ─────────────────────────────────────────────────────
    if (current.kind === 'teach') {
      setShowing({ kind: 'none' });
      if (intent.kind === 'seed') onSeed(intent.text || current.example);
      return;
    }

    // ── Arriving somewhere ─────────────────────────────────────────────────
    //
    // ONE reply, and it closes. This card used to carry the tour's "Next:
    // Dashboard", because the tour WAS a sequence of page walks and the
    // arrival line was the only place a next step could live. It is not any
    // more: a tour stop is a card beside a real control with its own Next, so
    // an arrival is back to being one sentence about one screen with nothing
    // to answer. `repliesFor({ kind: 'arrival', page: null })` is what makes
    // that true rather than this branch, and it is asserted in the tests.
    if (current.kind === 'arrived') {
      setShowing({ kind: 'none' });
      return;
    }

    // ── The notices line ───────────────────────────────────────────────────
    if (current.kind === 'notices') {
      setShowing({ kind: 'none' });
      // A no to the notices line is "not now", and it is recorded nowhere. The
      // batch stamp already stopped it repeating, and counting it as a decline
      // would put it two dismissals away from switching off the only way this
      // person hears that a colleague handed them work.
      retireLiveOffer();
      if (intent.kind === 'show') {
        // Opening the list IS reading it, so the cursor moves here rather than
        // waiting for somebody to scroll: the count is a promise that there is
        // something in there they have not seen, and it stops being true the
        // moment the list is in front of them.
        panelRef.current.onShowNotices();
        markNoticesRead();
        return;
      }
      if (intent.kind === 'seed') onSeed(intent.text || current.line);
      return;
    }

    // ── An offer ───────────────────────────────────────────────────────────
    // Every other shape returned above, so this is the offer. The guard is
    // still written out rather than cast: a new `showing` kind added later
    // should fall out here silently, not be treated as an offer with no topic.
    if (current.kind !== 'speech' || current.speech.kind !== 'offer') return;
    const speech = current.speech;
    const topic = speech.topic;

    if (intent.kind === 'close') {
      setShowing({ kind: 'none' });
      // ONE call. `declined` is what counts the No in companion_memory; the
      // offer fields on the same request are what stamp the sentence it was
      // about. There is no way to do the second without the first.
      void remember('declined', { topic, ...stampLive(topic, 'declined') }, (m) => {
        const prior = m.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
        return {
          ...m,
          topics: {
            ...m.topics,
            [topic]: { ...prior, declines: prior.declines + 1, dropped: prior.declines + 1 >= 2 },
          },
        };
      });
      return;
    }

    if (intent.kind === 'quiet') {
      setShowing({ kind: 'none' });
      quietTopic(topic);
      return;
    }

    // Everything below is a yes of some shape, so the topic is forgiven its
    // earlier declines before anything else happens.
    setShowing({ kind: 'none' });
    void remember('accepted', { topic, ...stampLive(topic, 'accepted') }, (m) => m);

    if (intent.kind === 'record') {
      void recordVerdict(intent.findingId, intent.verdict);
      return;
    }
    if (intent.kind === 'act') {
      void runFrozenPlan(intent.actionId);
      return;
    }
    if (intent.kind === 'seed') {
      // A yes to a recall hands the sentence back to the one chat brain, which
      // proposes the action and puts the SAME approval card up again. The
      // companion still never acts without a yes: this reopens the question it
      // asked before, it does not answer it. An empty text is the Something
      // else escape, whose subject is the statement on the screen.
      onSeed(intent.text || speech.sentence);
      return;
    }
    if (intent.kind === 'show') {
      // ── "Want to see what is new?" ──────────────────────────────────────
      //
      // A yes runs the SAME player over the SAME anchors as the first-run
      // tour, one to three stops long. It is a `show` and not a `walk` for the
      // reason the reply set says: the mini tour draws on the screen they are
      // standing on and takes itself wherever it needs to go.
      //
      // Recomputed here rather than carried on the candidate because a stop is
      // a live thing: between the offer and the yes, a hotel can switch a
      // section off, and running a stop that would no longer pass the gates is
      // exactly the walking-into-a-locked-door failure the gates exist to
      // prevent. Checked before the trace lookup, because a whats-new topic is
      // never a trace and must not be searched for as one.
      if (boot && topic.startsWith('whatsnew:')) {
        const news = decideWhatsNew(tourCtx, boot.memory);
        if (news.show && news.topic === topic) setTourRun(startTourRun(news.stops));
        return;
      }
      // Drawn in place when the thing it is about is on this screen already.
      // Walking somebody to the page they are standing on is the one-voice rule
      // broken in the other direction.
      const here = traces.patterns.find((p) => p.key === topic);
      if (here && here.page === tracePage) {
        setTraceStale(null);
        setTraceShowing(here);
        return;
      }
      // Found somewhere else. Walk over, and remember what we came for so the
      // reveal is already drawn on arrival. `goTo` only ever takes a constant
      // from the allowlist in pages.ts.
      const found = resolveDestination(here?.page ?? speech.destination, {
        role, enabledSections: activeProperty?.enabledSections,
      });
      if (found) {
        walkingToRef.current = topic;
        goTo(found);
      }
      return;
    }
    // `walk`. The destination is a CONSTANT from the pages allowlist, resolved
    // through the same role and section gates every other navigation uses. A
    // key that resolves to nothing walks nowhere rather than into a locked door.
    const target = resolveDestination(intent.page, {
      role, enabledSections: activeProperty?.enabledSections,
    });
    if (target) goTo(target);
  }, [
    startTour, role, activeProperty?.enabledSections, goTo, remember,
    onSeed, traces.patterns, tracePage, stampLive, markNoticesRead, retireLiveOffer,
    recordVerdict, runFrozenPlan, quietTopic, boot, tourCtx,
  ]);

  const dismiss = useCallback(() => {
    setShowing({ kind: 'none' });
  }, []);

  // "Quiet for now" ends a tour too. Somebody who asks the companion to stop
  // talking has not asked it to stop talking except for the nine cards it is
  // in the middle of. It counts as leaving, which is the honest ending: they
  // did not see the rest.
  const quiet = useCallback(() => {
    setShowing({ kind: 'none' });
    setTourRun((run) => (run ? endTourRun(run, 'skipped') : run));
    setQuiet(true);
  }, []);

  // ── One hello a day ──────────────────────────────────────────────────────
  //
  // Fired on the first companion-bearing screen of the hotel's day, whether or
  // not anything is wrong. The manners engine owns the guard; this only asks
  // and then stamps. `helloFired` stops the effect asking twice within a page
  // load while the optimistic write is still in flight.
  const [hello, setHello] = useState<string | null>(null);
  const helloFired = useRef(false);

  useEffect(() => {
    if (!boot || !gate.mounts || helloFired.current) return;
    const decision = decideDailyHello({
      today: boot.hotel.today,
      person: { firstName: boot.person.firstName, sharedLogin: boot.person.sharedLogin },
      memory: boot.memory,
      hour: boot.hotel.hour,
      waiting: boot.candidates.length,
      userIsBusy: busy,
      quietThisSession,
      aiAwake: boot.availability.awake,
    });
    if (!decision.hello) return;
    helloFired.current = true;
    setHello(decision.line);
    // The hello is a statement, not a question, so it carries no buttons and
    // its pill still retreats on its own. It is written down anyway: "what did
    // it say to me this morning" is a fair question with no answer before this.
    void say('greeted', {
      kind: 'greeting',
      text: decision.line,
      actions: [],
    }, (m) => ({ ...m, greetedDay: boot.hotel.today }));
  }, [boot, gate.mounts, busy, quietThisSession, say]);

  // It retreats on its own. The corner is not a place to leave a sentence.
  useEffect(() => {
    if (hello === null) return;
    const timer = setTimeout(() => setHello(null), HELLO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [hello]);

  // ── The panel's opening line ─────────────────────────────────────────────
  //
  // What Staxis says first when somebody opens an empty thread. Same three
  // values as the hello, minus the "All quiet so far" floor: a greeting with
  // nothing true to add is just a greeting, and padding it would be the one
  // thing this whole layer exists to avoid.
  const opening = useMemo<string | null>(() => {
    if (!boot || !boot.availability.awake) return null;
    return greetingLine({
      firstName: boot.person.firstName,
      sharedLogin: boot.person.sharedLogin,
      hour: boot.hotel.hour,
      fact: todayFact({ waiting: boot.candidates.length }),
    });
  }, [boot]);

  // ── The peek ─────────────────────────────────────────────────────────────
  //
  // Only an OFFER becomes a peek. A welcome is a conversation to have with the
  // panel open, not a clause to flash under a cursor, and an arrival line is
  // about a screen the person is already looking at. When there is no offer the
  // peek is null and hover does nothing, which is the whole point.
  const peek = useMemo<CompanionPeek | null>(() => {
    if (showing.kind === 'speech' && showing.speech.kind === 'offer') {
      const text = showing.speech.sentence.trim();
      if (text) return { text, severity: showing.severity };
    }
    // Work that landed on this person, or came back to them. It rides the same
    // pill as everything else the companion says first, and it outranks the
    // hello for the obvious reason: a colleague addressed this to them, and a
    // good morning did not.
    if (showing.kind === 'notices') {
      const text = showing.line.trim();
      if (text) return { text, severity: 'ok' };
    }
    // What came of the last thing somebody pressed. It outranks the stale note
    // and the hello for the obvious reason: they asked for something to happen
    // and this is whether it did.
    if (saidBack) return { text: saidBack, severity: 'ok' };
    // The honest end of a walk that arrived too late. It rides the same pill
    // because it is the same kind of thing: one clause, true and current. A
    // trace that cannot be drawn says so in the corner rather than drawing an
    // empty diagram in the middle of the board.
    if (traceStale) return { text: traceStale, severity: 'ok' };
    // The daily hello rides the same pill. It never outranks an offer: a
    // hotel with something wrong in it gets told about the thing, not greeted.
    if (hello) return { text: hello, severity: 'ok' };
    return null;
  }, [showing, hello, traceStale, saidBack]);

  // The stale note retreats on its own, exactly as the hello does. The corner
  // is not a place to leave a sentence.
  useEffect(() => {
    if (traceStale === null) return;
    const timer = setTimeout(() => setTraceStale(null), HELLO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [traceStale]);

  // The companion going away takes its line with it.
  useEffect(() => () => publishTraceLine(null), []);

  // ── The panel ask ────────────────────────────────────────────────────────
  //
  // The one venue where a pattern about a named person may be said, and the
  // only surface in this feature that is not drawn on a page. Every rule about
  // topics still applies; what does not apply is the daily speech budget,
  // because the person opened the panel themselves.
  const [panelAskDone, setPanelAskDone] = useState<Set<string>>(() => new Set());
  const panelAsk = useMemo(() => {
    if (!boot) return null;
    const decision = decidePanelAsk({
      today: boot.hotel.today,
      memory: boot.memory,
      // Traces only. A finding candidate belongs to the peek and the offer
      // path, which knows how to walk somebody to it; accepted here it would
      // have no pattern to show and would silently do nothing.
      candidates: candidates.filter((c) => isTraceTopic(c.topic) && !panelAskDone.has(c.topic)),
      panelOpen: panel.open,
      threadEmpty: panel.threadEmpty,
      otherSpeechShowing: showing.kind !== 'none',
      userIsBusy: busy,
      quietThisSession,
      aiAwake: boot.availability.awake,
    });
    if (!decision.ask) return null;
    return {
      topic: decision.topic,
      sentence: decision.sentence,
      pattern: traces.patterns.find((p) => p.key === decision.topic) ?? null,
      // The engine's own set, role-filtered. Not the trace vocabulary: the
      // venue changes the honest answers, which is why decidePanelAsk builds
      // its own rather than passing the candidate's through.
      replies: repliesForRole(decision.replies, role),
    };
  }, [
    boot, candidates, panel.open, panel.threadEmpty, showing.kind, busy, quietThisSession,
    traces.patterns, panelAskDone, role,
  ]);

  // Shown is spent, exactly as `rememberSpoke` treats an offer. Without this
  // the same sentence would be back the moment the panel is reopened.
  const panelAskTopic = panelAsk?.topic ?? null;
  const panelAskSentence = panelAsk?.sentence ?? null;
  useEffect(() => {
    if (!panelAskTopic || !panelAskSentence || !boot) return;
    void say('spoke', {
      kind: 'panel_ask',
      text: panelAskSentence,
      topic: panelAskTopic,
    }, (m) => {
      const prior = m.topics[panelAskTopic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
      return {
        ...m,
        topics: { ...m.topics, [panelAskTopic]: { ...prior, lastOfferedDay: boot.hotel.today } },
      };
    });
  }, [panelAskTopic, panelAskSentence, boot, say]);

  const spendPanelAsk = useCallback((topic: string) => {
    setPanelAskDone((prior) => {
      const next = new Set(prior);
      next.add(topic);
      return next;
    });
  }, []);

  /**
   * A button on the panel ask, dispatched by intent.
   *
   * THREE OUTCOMES, not two. `show` draws the pattern (in place when it belongs
   * to this screen, after a walk when it does not), `close` counts an ordinary
   * decline, and `quiet` drops the topic for good the first time it is asked.
   * The third is why this is not a pair of accept/decline callbacks: a pattern
   * about a named colleague is the case where somebody most wants to say "never
   * again" rather than "not today", and there was no way to say it.
   */
  const answerPanelAsk = useCallback((replyId: string) => {
    if (!panelAsk) return;
    const { topic, pattern } = panelAsk;
    const reply = panelAsk.replies.find((r) => r.id === replyId);
    if (!reply) return;
    // Spent either way. Shown is spent, exactly as `rememberSpoke` treats an
    // offer, so the same sentence is not back the moment the panel reopens.
    spendPanelAsk(topic);

    if (reply.intent.kind === 'quiet') {
      quietTopic(topic);
      return;
    }
    if (reply.intent.kind === 'close') {
      void remember('declined', { topic, ...stampLive(topic, 'declined') }, (m) => {
        const prior = m.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
        const declines = prior.declines + 1;
        return {
          ...m,
          topics: {
            ...m.topics,
            [topic]: {
              ...prior,
              declines,
              dropped: prior.dropped || declines >= COMPANION_DECLINES_BEFORE_DROP,
            },
          },
        };
      });
      return;
    }

    void remember('accepted', { topic, ...stampLive(topic, 'accepted') }, (m) => m);
    if (!pattern) return;
    // A pattern with no page has nothing to draw and nowhere to draw it, which
    // is exactly the case this venue exists for. It shows in place, in the
    // panel, as the companion's own answer.
    if (!pattern.page || pattern.page === tracePage) {
      setTraceStale(null);
      setTraceShowing(pattern);
      return;
    }
    // Anything else lives on another screen, and a yes walks there for the same
    // reason a yes to the peek does.
    const target = resolveDestination(pattern.page, {
      role, enabledSections: activeProperty?.enabledSections,
    });
    if (target) {
      walkingToRef.current = topic;
      goTo(target);
    }
  }, [
    panelAsk, spendPanelAsk, remember, tracePage, role, activeProperty?.enabledSections, goTo,
    stampLive, quietTopic,
  ]);

  // ── Acting on a trace ────────────────────────────────────────────────────
  //
  // The browser sends the pattern's KEY and which button. It does not send the
  // description, the room or the severity: the server finds the pattern again
  // and runs its own plan, so a stale tab cannot write a ticket about a run
  // somebody already fixed. See the route header.
  const actOnTrace = useCallback(async (index: number) => {
    const pattern = traceShowing;
    if (!pattern || !activePropertyId) return { done: false as const };
    try {
      const res = await fetchWithAuth('/api/companion/trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          key: pattern.key,
          page: pattern.page,
          action: index,
        }),
      });
      const envelope = await readEnvelope<{
        done: boolean; receipt?: TraceActReceipt; reason?: string;
      }>(res);
      if (envelope.error !== undefined || !envelope.data) {
        return { done: false as const, reason: 'I could not do that just now, so I left it alone.' };
      }
      return envelope.data;
    } catch (e) {
      if (e instanceof SessionEndedError) return { done: false as const };
      return { done: false as const, reason: 'I could not do that just now, so I left it alone.' };
    }
  }, [traceShowing, activePropertyId]);

  const declineTrace = useCallback(() => {
    const pattern = traceShowing;
    setTraceShowing(null);
    setTraceStale(null);
    if (!pattern) return;
    const topic = pattern.key;
    // "Not interested" is a No, counted the same way a No to the peek is, on
    // the same topic key. Twice and this pattern never comes back.
    void remember('declined', { topic, ...stampLive(topic, 'declined') }, (m) => {
      const prior = m.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
      const declines = prior.declines + 1;
      return {
        ...m,
        topics: {
          ...m.topics,
          [topic]: {
            ...prior,
            declines,
            dropped: prior.dropped || declines >= COMPANION_DECLINES_BEFORE_DROP,
          },
        },
      };
    });
  }, [traceShowing, remember, stampLive]);

  const closeTrace = useCallback(() => {
    setTraceShowing(null);
    setTraceStale(null);
  }, []);

  // ── Going back to something already offered ──────────────────────────────
  //
  // Tapping an old turn in the thread, or saying "show me that AC thing" and
  // letting the model call staxis_show_pattern. Both land here, and both get
  // the same two honest outcomes: the pattern is drawn, or it is not and the
  // reason is said out loud. There is no third outcome where a tap does
  // nothing, because a control that silently does nothing is the bug this
  // whole feature exists to stop shipping.
  //
  // A DECLINED OFFER IS STILL REPLAYABLE. What a No costs is the companion's
  // permission to raise the topic unprompted — that is the manners ledger's
  // business and it stays true. Being asked directly is not unprompted.
  const drawPattern = useCallback((topic: string, fallbackPage: string | null): boolean => {
    const here = traces.patterns.find((p) => p.key === topic);
    if (here && here.page === tracePage) {
      setTraceStale(null);
      setTraceShowing(here);
      return true;
    }
    // Somewhere else. Walk over and draw on arrival, exactly as a yes to the
    // peek does. `goTo` only ever takes a constant from the pages allowlist.
    const wanted = (here?.page ?? fallbackPage) as CompanionPageKey | null;
    const target = wanted
      ? resolveDestination(wanted, { role, enabledSections: activeProperty?.enabledSections })
      : null;
    if (target) {
      walkingToRef.current = topic;
      goTo(target);
      return true;
    }
    setTraceShowing(null);
    setTraceStale(OFFER_STALE_LINE);
    return false;
  }, [traces.patterns, tracePage, role, activeProperty?.enabledSections, goTo]);

  const replayOffer = useCallback((offer: CompanionOffer): boolean => {
    if (!offerIsReplayable(offer) || !offer.topic) return false;
    return drawPattern(offer.topic, offer.page);
  }, [drawPattern]);

  /**
   * Resolve a phrase from the conversation to a pattern, and draw it.
   *
   * The patterns on THIS screen are tried first, because that is what the
   * person is looking at and what the reveal can actually be drawn against.
   * Then the offers in the thread, so "that thing from this morning" reaches a
   * pattern that lives on another screen and walks them there.
   *
   * Returns false when nothing matches, and the caller says so. It never
   * guesses: a hint that lands on nothing gets the honest line, not the
   * nearest pattern.
   */
  const showPatternByHint = useCallback((hint: string): boolean => {
    const onScreen = traces.patterns.find(
      (p) => hintMatches(hint, `${p.ask} ${p.kicker} ${p.body}`),
    );
    if (onScreen) return drawPattern(onScreen.key, onScreen.page);

    const spoken = [...panelRef.current.offers]
      .reverse()
      .find((o) => offerIsReplayable(o) && hintMatches(hint, o.text));
    if (spoken) return replayOffer(spoken);

    setTraceShowing(null);
    setTraceStale(OFFER_STALE_LINE);
    return false;
  }, [traces.patterns, drawPattern, replayOffer]);

  /**
   * Waved away rather than answered.
   *
   * Counted by the manners ledger exactly as a No is — from the person's side
   * they are the same act, which is the rule the ledger was built on — and
   * rendered honestly in the thread as "(dismissed)" rather than as a No they
   * did not actually say.
   */
  const dismissOffer = useCallback((offer: CompanionOffer) => {
    setShowing({ kind: 'none' });
    const topic = offer.topic;
    // A greeting asked nothing, so there is nothing to answer and nothing to
    // count. Its pill closes and the sentence stays in the thread exactly as it
    // was said — recording a "decline" against a good morning would be the app
    // inventing an opinion the person never expressed.
    if (!topic) return;
    liveOfferRef.current = null;
    setLiveOffer(null);
    void remember('declined', { topic, offerId: offer.id, offerState: 'dismissed' }, (m) => {
      const prior = m.topics[topic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
      const declines = prior.declines + 1;
      return {
        ...m,
        topics: {
          ...m.topics,
          [topic]: {
            ...prior,
            declines,
            dropped: prior.dropped || declines >= COMPANION_DECLINES_BEFORE_DROP,
          },
        },
      };
    });
  }, [remember]);

  // ── Found elsewhere ──────────────────────────────────────────────────────
  //
  // On the Staxis list, and only there, a pattern that lives on another screen
  // is published as one plain line with the same two buttons. The list renders
  // it and calls back; every rule about whether it should be said at all was
  // already applied above, by the same manners engine that decided the peek.
  //
  // Nothing is ever DRAWN on the list. It is the one screen in the product
  // whose whole job is to be a list of everything, and a diagram over the top
  // of that would be the second design this feature exists to avoid.
  const offerTopic = showing.kind === 'speech' && showing.speech.kind === 'offer'
    ? showing.speech.topic
    : null;
  const offerSentenceText = showing.kind === 'speech' && showing.speech.kind === 'offer'
    ? showing.speech.sentence
    : null;
  const offerReplies = showing.kind === 'speech' ? showing.replies : EMPTY_REPLIES;
  useEffect(() => {
    if (page?.key !== 'staxis' || !offerTopic || !offerSentenceText || !isTraceTopic(offerTopic)) {
      publishTraceLine(null);
      return;
    }
    const pattern = traces.patterns.find((p) => p.key === offerTopic);
    // No page, this page, or anything about a person: not a line. The
    // sensitivity check is belt and braces (the manners engine already refuses
    // to make such a candidate an offer), and it is here because this is the
    // one surface in the feature that renders into a screen full of other
    // people's work.
    if (!pattern || !pattern.page || pattern.page === 'staxis') {
      publishTraceLine(null);
      return;
    }
    if (pattern.sensitivity !== 'operational') {
      publishTraceLine(null);
      return;
    }
    const target = resolveDestination(pattern.page, {
      role, enabledSections: activeProperty?.enabledSections,
    });
    if (!target) {
      publishTraceLine(null);
      return;
    }
    publishTraceLine({
      topic: offerTopic,
      text: offerSentenceText,
      whereFound: `Found on ${target.label}`,
      replies: offerReplies,
      onReply: answer,
    });
    // No cleanup. This effect re-runs whenever the callbacks are rebuilt, and a
    // cleanup that published null would blank the line and re-add it on every
    // one of those, which the list would render as a flicker. Every branch that
    // should retire the line publishes null above, and the unmount case is the
    // effect below.
  }, [
    page, offerTopic, offerSentenceText, offerReplies, traces.patterns, role,
    activeProperty?.enabledSections, answer,
  ]);

  // ── The arrival line, and why it has no Next any more ────────────────────
  //
  // This used to fill in "Next: Dashboard" at render, because `goTo` could not
  // know which tour step it was on and the tour WAS a sequence of page walks:
  // the arrival line was the only surface a next step could live on.
  //
  // The tour is stops now, and a stop is a card beside a real control that
  // carries its own Next. So an arrival is what it always should have been:
  // one sentence about one screen somebody was walked to from an offer, with
  // nothing to answer. `page: null` is what makes the reply set a lone Close,
  // and `answer`'s arrival branch has nothing but a close to handle.
  const showingOut = useMemo<CompanionShowing>(() => {
    if (showing.kind !== 'arrived') return showing;
    return {
      ...showing,
      replies: repliesFor({ kind: 'arrival', page: null, pageLabel: null }),
    };
  }, [showing]);

  // Kept in step with what is on the screen, for `answer`. An assignment during
  // render rather than an effect: the dispatcher can fire from a click in the
  // very same commit that first drew the button, and an effect would leave the
  // ref one render behind for exactly that tap.
  showingRef.current = showingOut;

  /**
   * The way out, offered only where something is actually being asked.
   *
   * A statement with no question has nothing to be "something else" than, and a
   * card whose three replies are the only three honest answers does not need a
   * fourth. So this is null unless a question is on the screen.
   */
  const escape = useMemo<CompanionReply | null>(() => {
    if (showingOut.kind !== 'speech') return null;
    if (!showingOut.question) return null;
    return somethingElseReply();
  }, [showingOut]);

  return {
    mounts: gate.mounts,
    asleep: boot !== null && !boot.availability.awake,
    sleepReason: boot?.availability.reason ?? null,
    showing: showingOut,
    peek,
    opening,
    hello,
    page,
    today: boot?.hotel.today ?? null,
    tour,
    answer,
    escape,
    dismiss,
    quiet,
    goTo,
    replayOffer,
    showPatternByHint,
    dismissOffer,
    liveOffer,
    notices,
    unreadNoticeCount,
    noticesSeenAt: boot?.memory.noticesSeenAt ?? null,
    markNoticesRead,
    trace: {
      showing: traceShowing,
      stale: traceStale,
      panelAsk,
      act: actOnTrace,
      decline: declineTrace,
      close: closeTrace,
      answerPanelAsk,
    },
  };
}
