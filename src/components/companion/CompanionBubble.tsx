'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The companion bubble.
//
// A FACE ON THE CHAT THAT ALREADY EXISTS. Everything the assistant can do, it
// does through AskStaxisBar and /api/agent/command. This component starts no
// second conversation, holds no messages, and owns no prompt. When somebody
// opens it and wants to talk, it wakes the bar and gets out of the way.
//
// WHAT IT DOES OWN
//   • the four states: resting, has-something, speaking, open
//   • the decision to speak, which is delegated whole to decideCompanionSpeech
//   • walking somebody to a screen, from a constant allowlist
//   • the one-time teach line after a manual flow
//   • the standing-rules and tour entries in the panel
//
// WHY SO LITTLE LOGIC IS IN HERE
// The suite runs under --conditions=react-server, where react-dom/server will
// not load, so a component with hooks cannot be mounted in a test. The house
// answer is to keep the decisions in plain modules and exercise THOSE. So this
// file is a shell over src/lib/companion/*: every rule with a consequence lives
// there and is tested there, and what is left here is wiring.
//
// MOUNTING is gated by companionMounts() before anything else runs, so a
// housekeeper screen or a housekeeping hat gets nothing at all. See mount.ts.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import { dispatchAskCommand, dispatchAskOpen } from '@/components/agent/ask-command-bridge';
import type { AppRole } from '@/lib/roles';
import { companionMounts } from '@/lib/companion/mount';
import {
  decideCompanionSpeech,
  decideTeachMoment,
  EMPTY_COMPANION_MEMORY,
  parseCompanionMemory,
  type CompanionCandidate,
  type CompanionMemory,
  type CompanionSpeech,
  type TeachFlow,
} from '@/lib/companion/manners';
import {
  arrivalLine,
  companionLabels,
  offerQuestion,
  sleepLine,
  type SleepReason,
} from '@/lib/companion/copy';
import {
  pagesFor,
  resolveDestination,
  tourFor,
  pageForPath,
  type CompanionPage,
  type CompanionPageKey,
} from '@/lib/companion/pages';
import { COMPANION_CSS } from './companion-css';
import {
  focusIsTyping,
  subscribeToCompanionBusy,
  subscribeToCompanionFlow,
} from './companion-events';

interface Bootstrap {
  person: { firstName: string | null; role: AppRole; sharedLogin: boolean; isManager: boolean };
  hotel: { id: string; name: string | null; today: string };
  memory: CompanionMemory;
  wizardAlreadyRan: boolean;
  candidates: CompanionCandidate[];
  availability: { awake: boolean; reason: SleepReason | null };
}

type Panel = 'closed' | 'open';

/** What is currently on the card, if anything. */
type Showing =
  | { kind: 'none' }
  | { kind: 'speech'; speech: Extract<CompanionSpeech, { kind: 'welcome' | 'offer' }> }
  | { kind: 'teach'; flow: TeachFlow; text: string; example: string }
  | { kind: 'arrived'; line: string };

export function CompanionBubble() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, properties } = useProperty();
  const pathname = usePathname();
  const router = useRouter();

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [panel, setPanel] = useState<Panel>('closed');
  const [showing, setShowing] = useState<Showing>({ kind: 'none' });
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
        // the companion simply does not appear this page load. It is a greeter,
        // not a dependency.
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
        const server = parseCompanionMemory(envelope.data.memory);
        setBoot((b) => (b ? { ...b, memory: server } : b));
      }
    } catch { /* optimistic state stands for this page load */ }
  }, [activePropertyId]);

  // ── Deciding to speak ────────────────────────────────────────────────────
  // Runs when the bootstrap lands and when the page changes. Every rule is in
  // decideCompanionSpeech; this only supplies the inputs and acts on the answer.
  const spokenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!boot || !gate.mounts) return;
    if (showing.kind !== 'none' || panel === 'open') return;

    const onScreen = pageForPath(pathname)?.key === 'staxis'
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

    setShowing({ kind: 'speech', speech });
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
    boot, gate.mounts, showing.kind, panel, pathname, busy, quietThisSession,
    properties.length, activeProperty?.name, remember,
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
          kind: 'teach', flow, text: decision.text, example: decision.example,
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
  const goTo = useCallback((page: CompanionPage) => {
    setPanel('closed');
    router.push(page.href);
    setShowing({ kind: 'arrived', line: arrivalLine(page.key) });
  }, [router]);

  const destinations = useMemo(
    () => pagesFor({ role, enabledSections: activeProperty?.enabledSections }),
    [role, activeProperty?.enabledSections],
  );
  const tour = useMemo(
    () => tourFor({ role, enabledSections: activeProperty?.enabledSections }),
    [role, activeProperty?.enabledSections],
  );

  const startTour = useCallback(() => {
    setShowing({ kind: 'none' });
    setPanel('closed');
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
      const page = resolveDestination(current.speech.destination, {
        role, enabledSections: activeProperty?.enabledSections,
      });
      setShowing({ kind: 'none' });
      void remember('accepted', { topic }, (m) => m);
      if (page) goTo(page);
      return;
    }
    setShowing({ kind: 'none' });
  }, [showing, startTour, role, activeProperty?.enabledSections, goTo, remember]);

  const openConversation = useCallback((seed?: string) => {
    setShowing({ kind: 'none' });
    setPanel('closed');
    if (seed) dispatchAskCommand(seed, window, 'companion');
    else dispatchAskOpen();
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  if (!gate.mounts || !user || !activePropertyId) return null;

  const asleep = boot !== null && !boot.availability.awake;
  const hasSomething = showing.kind !== 'none';

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: COMPANION_CSS }} />
      <div className="cmp-root">
        {panel === 'open' && (
          <div className="cmp-panel" role="dialog" aria-label={labels.panelTitle}>
            <div className="cmp-head">
              <span className="cmp-title">{labels.panelTitle}</span>
              <button type="button" className="cmp-quiet" onClick={() => setPanel('closed')}>
                {labels.close}
              </button>
            </div>

            {asleep ? (
              // The honest sleep state. Never a spinner: a spinner is a lie told
              // slowly, and the reason is knowable, so it gets said.
              <p className="cmp-say">{sleepLine(boot?.availability.reason ?? 'unknown')}</p>
            ) : (
              <>
                <button type="button" className="cmp-row" onClick={() => openConversation()}>
                  {labels.askPlaceholder}
                </button>
                <div className="cmp-sep" />
                <span className="cmp-title">{labels.whereTo}</span>
                <div className="cmp-rows">
                  {destinations.map((page) => (
                    <button
                      key={page.key}
                      type="button"
                      className="cmp-row"
                      onClick={() => goTo(page)}
                    >
                      {page.label}
                    </button>
                  ))}
                </div>
                <div className="cmp-sep" />
                {/* A No to the tour means never offered again UNPROMPTED. The
                    entry stays here forever, because "I said no on my first
                    day" and "I never want this" are different sentences. */}
                <button type="button" className="cmp-row" onClick={startTour}>
                  {labels.showMeAround}
                </button>
              </>
            )}
          </div>
        )}

        {panel === 'closed' && showing.kind === 'speech' && (
          <div className="cmp-card" role="status">
            <p className="cmp-say">
              {showing.speech.kind === 'welcome'
                ? showing.speech.greeting
                : showing.speech.sentence}
            </p>
            <p className="cmp-ask">
              {showing.speech.kind === 'welcome'
                ? showing.speech.question
                : offerQuestion(resolveDestination(showing.speech.destination, {
                  role, enabledSections: activeProperty?.enabledSections,
                }))}
            </p>
            <div className="cmp-acts">
              <button type="button" className="cmp-btn cmp-yes" onClick={answerYes}>
                {labels.yes}
              </button>
              <button type="button" className="cmp-btn" onClick={answerNo}>
                {labels.no}
              </button>
            </div>
          </div>
        )}

        {panel === 'closed' && showing.kind === 'teach' && (
          <div className="cmp-card" role="status">
            <p className="cmp-say">{showing.text}</p>
            <p className="cmp-eg">{showing.example}</p>
            <div className="cmp-acts">
              <button
                type="button"
                className="cmp-btn cmp-yes"
                onClick={() => openConversation(showing.example)}
              >
                {labels.yes}
              </button>
              <button type="button" className="cmp-btn" onClick={() => setShowing({ kind: 'none' })}>
                {labels.dismiss}
              </button>
            </div>
          </div>
        )}

        {panel === 'closed' && showing.kind === 'arrived' && (
          <div className="cmp-card" role="status">
            <p className="cmp-say">{showing.line}</p>
            <div className="cmp-acts">
              {tourStep !== null && tourStep + 1 < tour.length ? (
                <button type="button" className="cmp-btn cmp-yes" onClick={nextTourStep}>
                  {`Next: ${tour[tourStep + 1].label}`}
                </button>
              ) : null}
              <button
                type="button"
                className="cmp-btn"
                onClick={() => { setShowing({ kind: 'none' }); setTourStep(null); }}
              >
                {labels.close}
              </button>
            </div>
          </div>
        )}

        {hasSomething && panel === 'closed' && (
          <button type="button" className="cmp-quiet" onClick={() => { setShowing({ kind: 'none' }); setQuiet(true); }}>
            {labels.quietForNow}
          </button>
        )}

        <button
          type="button"
          className={['cmp-dot', hasSomething && 'cmp-nudge', asleep && 'cmp-asleep']
            .filter(Boolean).join(' ')}
          aria-label={panel === 'open' ? labels.close : labels.open}
          aria-expanded={panel === 'open'}
          onClick={() => {
            setShowing({ kind: 'none' });
            setPanel((p) => (p === 'open' ? 'closed' : 'open'));
          }}
        >
          <span className="cmp-mark" />
        </button>
      </div>
    </>
  );
}
