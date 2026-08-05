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
  arrivalLine, companionLabels, greetingLine, offerQuestion, todayFact,
  type SleepReason,
} from '@/lib/companion/copy';
import {
  decideNoticeAnnouncement,
  newestNoticeAt,
  sortNotices,
  unreadNotices,
  type AssignmentNotice,
} from '@/lib/companion/notices';
import {
  resolveDestination,
  tourFor,
  pageForPath,
  type CompanionPage,
  type CompanionPageKey,
} from '@/lib/companion/pages';
import {
  focusIsTyping,
  subscribeToCompanionBusy,
  subscribeToCompanionFlow,
} from './companion-events';

/** How long the once-a-day hello stays in the corner before retreating. */
const HELLO_VISIBLE_MS = 6000;

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

/** What the companion currently has to say, if anything. */
export type CompanionShowing =
  | { kind: 'none' }
  | {
      kind: 'speech';
      speech: Extract<CompanionSpeech, { kind: 'welcome' | 'offer' }>;
      /** The question under the sentence, already resolved for the panel. */
      question: string;
      severity: CompanionSeverity;
    }
  | { kind: 'teach'; flow: TeachFlow; text: string; example: string; severity: CompanionSeverity }
  | { kind: 'arrived'; line: string; severity: CompanionSeverity }
  /**
   * The batched notices line. One utterance about however many things landed,
   * with two answers: show me the list, or close it. See notices.ts for why
   * this class of speech is exempt from the daily caps and what it is still
   * bound by.
   */
  | { kind: 'notices'; line: string; through: string };

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
  panelAsk: { topic: string; sentence: string; pattern: TracePattern | null } | null;
  /** Runs the one thing the card offered, on the server, from its own plan. */
  act: (index: number) => Promise<{ done: boolean; receipt?: TraceActReceipt; reason?: string }>;
  /** Not interested. Melts everything and counts as a decline. */
  decline: () => void;
  /** Finished with. Melts everything without counting as a decline. */
  close: () => void;
  /** Yes, from the panel ask. */
  acceptPanelAsk: () => void;
  /** No, from the panel ask. */
  declinePanelAsk: () => void;
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
  /** The role-sized tour, or empty when there is nothing worth touring. */
  tour: readonly CompanionPage[];
  tourStep: number | null;
  answerYes: () => void;
  answerNo: () => void;
  dismiss: () => void;
  quiet: () => void;
  startTour: () => void;
  nextTourStep: () => void;
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
  const [quietThisSession, setQuiet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const labels = useMemo(() => companionLabels(), []);

  const role = (user?.role ?? null) as AppRole | null;
  const gate = companionMounts({ pathname, role });

  // ── Bootstrap ────────────────────────────────────────────────────────────
  // Once per (person, hotel). Keyed the same way every other panel in this app
  // is keyed, so a hotel switch cannot leave one hotel's state under another's
  // name. Deliberately not a poll: nothing here is live.
  const scopeKey = `${user?.uid ?? 'none'}:${activePropertyId ?? 'none'}`;
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!gate.mounts || !activePropertyId || !user) return;
    if (loadedKey.current === scopeKey) return;
    loadedKey.current = scopeKey;
    setBoot(null);
    setShowing({ kind: 'none' });
    setTourStep(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/companion?pid=${encodeURIComponent(activePropertyId)}`);
        const envelope = await readEnvelope<Bootstrap>(res);
        if (cancelled || envelope.error !== undefined || !envelope.data) return;
        setBoot({
          ...envelope.data,
          memory: parseCompanionMemory(envelope.data.memory),
        });
      } catch (e) {
        // A signed-out mid-request is already redirecting; anything else means
        // the companion simply has nothing to offer this page load. It is a
        // greeter, not a dependency.
        if (e instanceof SessionEndedError) return;
      }
    })();
    return () => { cancelled = true; };
  }, [gate.mounts, activePropertyId, user, scopeKey]);

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

  const candidates = useMemo<CompanionCandidate[]>(() => {
    const fromFindings = boot?.candidates ?? [];
    if (traces.patterns.length === 0) return [...fromFindings];
    // Traces lead. A pattern about the screen somebody is looking at is more
    // use than a card about somewhere else, and the manners engine takes the
    // first candidate that survives its rules.
    return [...traces.patterns.map(traceCandidate), ...fromFindings];
  }, [boot, traces.patterns]);

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
          setShowing({ kind: 'notices', line: decision.line, through: decision.through });
          void say('notices_announced', {
            kind: 'offer',
            // No topic. The never-nag ledger counts declines per TOPIC and
            // drops one for good after two, which is right for something the
            // companion noticed and catastrophic for a message a colleague
            // sent: waving away "Sarah gave you 3 things" twice must not
            // switch off assignment notices forever. What stops this line
            // repeating is the batch stamp, not a decline count.
            text: decision.line,
            actions: [
              { label: labels.showNotices, kind: 'show' },
              { label: labels.dismiss, kind: 'no' },
            ],
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
      question: speech.kind === 'welcome'
        ? speech.question
        : offerQuestion(resolveDestination(speech.destination, {
          role, enabledSections: activeProperty?.enabledSections,
        })),
      severity: speech.kind === 'offer' ? speech.severity : DEFAULT_COMPANION_SEVERITY,
    });
    if (speech.kind === 'welcome') {
      void say('welcomed', {
        kind: 'greeting',
        text: `${speech.greeting} ${speech.question}`.trim(),
        actions: [
          { label: labels.yes, kind: 'seed' },
          { label: labels.no, kind: 'no' },
        ],
      }, (m) => ({ ...m, welcomedAt: new Date().toISOString() }));
    } else {
      const topic = speech.topic;
      void say('spoke', {
        kind: 'offer',
        text: speech.sentence,
        topic,
        page: speech.destination,
        actions: [
          // A trace draws in place; anything else walks somebody to a screen.
          { label: labels.yes, kind: isTraceTopic(topic) ? 'show' : 'walk' },
          { label: labels.no, kind: 'no' },
        ],
      }, (m) => ({
        ...m,
        lastSpokeAt: new Date().toISOString(),
        spokenDay: boot.hotel.today,
        spokenCount: (m.spokenDay === boot.hotel.today ? m.spokenCount : 0) + 1,
      }));
    }
  }, [
    boot, gate.mounts, showing.kind, pathname, page, busy, quietThisSession,
    properties.length, activeProperty?.name, activeProperty?.enabledSections, role, remember,
    candidates, traceShowing, say, labels,
  ]);

  // ── Teach at the moment ──────────────────────────────────────────────────
  useEffect(() => {
    if (!gate.mounts) return;
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
          severity: 'ok',
        });
        void remember('taught', { flow }, (m) => ({
          ...m, taught: { ...m.taught, [flow]: true },
        }));
        return b;
      });
    });
  }, [gate.mounts, busy, quietThisSession, remember]);

  // ── Walking somebody somewhere ───────────────────────────────────────────
  // Client-side navigation to a CONSTANT from the allowlist. `page.href` is a
  // literal declared in pages.ts; nothing typed, stored or returned by a model
  // ever reaches router.push.
  const goTo = useCallback((target: CompanionPage) => {
    router.push(target.href);
    setShowing({ kind: 'arrived', line: arrivalLine(target.key), severity: 'ok' });
  }, [router]);

  const tour = useMemo(
    () => tourFor({ role, enabledSections: activeProperty?.enabledSections }),
    [role, activeProperty?.enabledSections],
  );

  const startTour = useCallback(() => {
    setShowing({ kind: 'none' });
    if (tour.length === 0) return;
    setTourStep(0);
    goTo(tour[0]);
    void remember('tour_taken', {}, (m) => ({ ...m, tourTakenAt: new Date().toISOString() }));
  }, [tour, goTo, remember]);

  const nextTourStep = useCallback(() => {
    setTourStep((step) => {
      if (step === null) return null;
      const next = step + 1;
      if (next >= tour.length) {
        setShowing({ kind: 'none' });
        return null;
      }
      goTo(tour[next]);
      return next;
    });
  }, [tour, goTo]);

  // ── Answers ──────────────────────────────────────────────────────────────
  //
  // A NO CLOSES THE CARD AND SAYS NOTHING BACK. No "no problem", no "I will
  // remember that". A reply to a No is the app making somebody's dismissal into
  // a conversation, and nothing is lost by staying quiet: the thing the offer
  // was about is still on its own screen.
  const answerNo = useCallback(() => {
    const current = showing;
    setShowing({ kind: 'none' });
    setTourStep(null);
    // A No to the notices line is "not now", and it is recorded nowhere. The
    // batch stamp already stopped it repeating, and counting it as a decline
    // would put it two dismissals away from switching off the only way this
    // person hears that a colleague handed them work.
    if (current.kind === 'notices') {
      retireLiveOffer();
      return;
    }
    if (current.kind === 'speech' && current.speech.kind === 'offer') {
      const topic = current.speech.topic;
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
    }
    if (current.kind === 'speech' && current.speech.kind === 'welcome') {
      void remember('tour_declined', { ...stampLive(null, 'declined') },
        (m) => ({ ...m, tourDeclined: true }));
    }
  }, [showing, remember, stampLive, retireLiveOffer]);

  const answerYes = useCallback(() => {
    const current = showing;
    if (current.kind === 'speech' && current.speech.kind === 'welcome') {
      startTour();
      return;
    }
    if (current.kind === 'speech' && current.speech.kind === 'offer') {
      const topic = current.speech.topic;
      const target = resolveDestination(current.speech.destination, {
        role, enabledSections: activeProperty?.enabledSections,
      });
      setShowing({ kind: 'none' });
      void remember('accepted', { topic, ...stampLive(topic, 'accepted') }, (m) => m);

      // A yes to a trace draws it rather than walking anywhere, when the thing
      // it is about is on the screen already. Walking somebody to the page they
      // are standing on is the one-voice rule broken in the other direction.
      if (isTraceTopic(topic)) {
        const here = traces.patterns.find((p) => p.key === topic);
        if (here && here.page === tracePage) {
          setTraceStale(null);
          setTraceShowing(here);
          return;
        }
        // Found somewhere else. Walk over, and remember what we came for so the
        // reveal is already drawn on arrival. `goTo` only ever takes a constant
        // from the allowlist in pages.ts.
        if (target) {
          walkingToRef.current = topic;
          goTo(target);
          return;
        }
        return;
      }

      if (target) goTo(target);
      return;
    }
    if (current.kind === 'teach') {
      const example = current.example;
      setShowing({ kind: 'none' });
      onSeed(example);
      return;
    }
    // "Show me" on the notices line. Opening the list IS reading it, so the
    // cursor moves here rather than waiting for somebody to scroll: the count
    // is a promise that there is something in there they have not seen, and it
    // stops being true the moment the list is in front of them.
    if (current.kind === 'notices') {
      setShowing({ kind: 'none' });
      retireLiveOffer();
      panelRef.current.onShowNotices();
      markNoticesRead();
      return;
    }
    setShowing({ kind: 'none' });
  }, [
    showing, startTour, role, activeProperty?.enabledSections, goTo, remember, onSeed,
    traces.patterns, tracePage, stampLive, markNoticesRead, retireLiveOffer,
  ]);

  const dismiss = useCallback(() => {
    setShowing({ kind: 'none' });
    setTourStep(null);
  }, []);

  const quiet = useCallback(() => {
    setShowing({ kind: 'none' });
    setTourStep(null);
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
    // The honest end of a walk that arrived too late. It rides the same pill
    // because it is the same kind of thing: one clause, true and current. A
    // trace that cannot be drawn says so in the corner rather than drawing an
    // empty diagram in the middle of the board.
    if (traceStale) return { text: traceStale, severity: 'ok' };
    // The daily hello rides the same pill. It never outranks an offer: a
    // hotel with something wrong in it gets told about the thing, not greeted.
    if (hello) return { text: hello, severity: 'ok' };
    return null;
  }, [showing, hello, traceStale]);

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
    };
  }, [
    boot, candidates, panel.open, panel.threadEmpty, showing.kind, busy, quietThisSession,
    traces.patterns, panelAskDone,
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
      actions: [
        { label: labels.yes, kind: 'show' },
        { label: labels.no, kind: 'no' },
      ],
    }, (m) => {
      const prior = m.topics[panelAskTopic] ?? { declines: 0, dropped: false, lastOfferedDay: null };
      return {
        ...m,
        topics: { ...m.topics, [panelAskTopic]: { ...prior, lastOfferedDay: boot.hotel.today } },
      };
    });
  }, [panelAskTopic, panelAskSentence, boot, say, labels]);

  const spendPanelAsk = useCallback((topic: string) => {
    setPanelAskDone((prior) => {
      const next = new Set(prior);
      next.add(topic);
      return next;
    });
  }, []);

  const acceptPanelAsk = useCallback(() => {
    if (!panelAsk) return;
    const { topic, pattern } = panelAsk;
    spendPanelAsk(topic);
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
    stampLive,
  ]);

  const declinePanelAsk = useCallback(() => {
    if (!panelAsk) return;
    const { topic } = panelAsk;
    spendPanelAsk(topic);
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
  }, [panelAsk, spendPanelAsk, remember, stampLive]);

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
      onYes: answerYes,
      onNo: answerNo,
    });
    // No cleanup. This effect re-runs whenever the callbacks are rebuilt, and a
    // cleanup that published null would blank the line and re-add it on every
    // one of those, which the list would render as a flicker. Every branch that
    // should retire the line publishes null above, and the unmount case is the
    // effect below.
  }, [
    page, offerTopic, offerSentenceText, traces.patterns, role,
    activeProperty?.enabledSections, answerYes, answerNo,
  ]);

  return {
    mounts: gate.mounts,
    asleep: boot !== null && !boot.availability.awake,
    sleepReason: boot?.availability.reason ?? null,
    showing,
    peek,
    opening,
    hello,
    page,
    today: boot?.hotel.today ?? null,
    tour,
    tourStep,
    answerYes,
    answerNo,
    dismiss,
    quiet,
    startTour,
    nextTourStep,
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
      acceptPanelAsk,
      declinePanelAsk,
    },
  };
}
