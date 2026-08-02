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
import {
  decideCompanionSpeech,
  decideDailyHello,
  decideTeachMoment,
  parseCompanionMemory,
  DEFAULT_COMPANION_SEVERITY,
  type CompanionCandidate,
  type CompanionMemory,
  type CompanionSeverity,
  type CompanionSpeech,
  type TeachFlow,
} from '@/lib/companion/manners';
import { arrivalLine, greetingLine, offerQuestion, todayFact, type SleepReason } from '@/lib/companion/copy';
import {
  resolveDestination,
  tourFor,
  pageForPath,
  type CompanionPage,
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
  | { kind: 'arrived'; line: string; severity: CompanionSeverity };

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
  /** The screen the person is standing on, for the panel's eyebrow. */
  page: CompanionPage | null;
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
}

/**
 * @param onSeed  How to hand a turn to the one chat brain. The companion never
 *                sends a message itself; it asks the caller to.
 */
export function useCompanion(onSeed: (text?: string) => void): CompanionApi {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, properties } = useProperty();
  const pathname = usePathname();
  const router = useRouter();

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [showing, setShowing] = useState<CompanionShowing>({ kind: 'none' });
  const [quietThisSession, setQuiet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);

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
  const remember = useCallback(async (
    event: string,
    extra: Record<string, unknown>,
    optimistic: (m: CompanionMemory) => CompanionMemory,
  ) => {
    setBoot((b) => (b ? { ...b, memory: optimistic(b.memory) } : b));
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth('/api/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, event, ...extra }),
      });
      const envelope = await readEnvelope<{ memory: CompanionMemory }>(res);
      if (envelope.error === undefined && envelope.data) {
        setBoot((b) => (b ? { ...b, memory: parseCompanionMemory(envelope.data!.memory) } : b));
      }
    } catch { /* optimistic state stands for this page load */ }
  }, [activePropertyId]);

  const page = useMemo(() => pageForPath(pathname), [pathname]);

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

    const speech = decideCompanionSpeech({
      now: new Date(),
      today: boot.hotel.today,
      person: {
        firstName: boot.person.firstName,
        role: boot.person.role,
        sharedLogin: boot.person.sharedLogin,
      },
      memory: boot.memory,
      candidates: boot.candidates,
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
      void remember('welcomed', {}, (m) => ({ ...m, welcomedAt: new Date().toISOString() }));
    } else {
      const topic = speech.topic;
      void remember('spoke', { topic }, (m) => ({
        ...m,
        lastSpokeAt: new Date().toISOString(),
        spokenDay: boot.hotel.today,
        spokenCount: (m.spokenDay === boot.hotel.today ? m.spokenCount : 0) + 1,
      }));
    }
  }, [
    boot, gate.mounts, showing.kind, pathname, page, busy, quietThisSession,
    properties.length, activeProperty?.name, activeProperty?.enabledSections, role, remember,
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
    if (current.kind === 'speech' && current.speech.kind === 'offer') {
      const topic = current.speech.topic;
      void remember('declined', { topic }, (m) => {
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
      void remember('tour_declined', {}, (m) => ({ ...m, tourDeclined: true }));
    }
  }, [showing, remember]);

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
      void remember('accepted', { topic }, (m) => m);
      if (target) goTo(target);
      return;
    }
    if (current.kind === 'teach') {
      const example = current.example;
      setShowing({ kind: 'none' });
      onSeed(example);
      return;
    }
    setShowing({ kind: 'none' });
  }, [showing, startTour, role, activeProperty?.enabledSections, goTo, remember, onSeed]);

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
    void remember('greeted', {}, (m) => ({ ...m, greetedDay: boot.hotel.today }));
  }, [boot, gate.mounts, busy, quietThisSession, remember]);

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
    // The daily hello rides the same pill. It never outranks an offer: a
    // hotel with something wrong in it gets told about the thing, not greeted.
    if (hello) return { text: hello, severity: 'ok' };
    return null;
  }, [showing, hello]);

  return {
    mounts: gate.mounts,
    asleep: boot !== null && !boot.availability.awake,
    sleepReason: boot?.availability.reason ?? null,
    showing,
    peek,
    opening,
    hello,
    page,
    tour,
    tourStep,
    answerYes,
    answerNo,
    dismiss,
    quiet,
    startTour,
    nextTourStep,
    goTo,
  };
}
