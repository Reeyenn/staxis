'use client';

// ─── AskStaxisBar — the one AI object in the corner ────────────────────────
//
// OBSIDIAN. An 86px circle of polished dark stone at the bottom right of every
// authenticated page, lit only from underneath, with the Staxis chevron cut
// into its face. It is BOTH the companion at rest and the way into the
// conversation: there used to be a companion dot and an Ask capsule and two
// utility buttons all fighting over the same corner, and now there is one
// object. Everything else folded into it.
//
//   • resting state          the mark, in one of three colours (calm, working,
//                            wrong). Geometry never changes; only colour does.
//   • hover / focus          a peek pill slides in beside it carrying the one
//                            clause the companion has, if it has one
//   • click                  the ink panel rises above it: the conversation,
//                            at a FIXED height, scrolling internally
//   • drag                   the person may put the mark anywhere on screen and
//                            it stays there, per device. Double click sends it
//                            back to the corner.
//   • the top strip          past chats, an overflow menu that now holds
//                            feedback and AI activity, and close
//
// WHAT DID NOT CHANGE: useAgentChat, SSE streaming, ApprovalOverlay, the
// staxis:ask bridge, dictation, past-chat loading. This is a change to the
// resting object, the anchor geometry and the panel's presentation.
//
// The companion's manners (when it may speak first, what it may say, a No is a
// No) live in useCompanion and the pure modules under src/lib/companion. The
// geometry maths lives in src/lib/companion/dock.ts. Both are there rather than
// here because the suite runs under --conditions=react-server and cannot mount
// a component, so anything with a consequence has to be reachable without one.
//
// All styling is scoped under `.asx-*` classes injected once below, so it can
// use :hover / masks / keyframes that inline styles cannot express, without
// colliding with the app's global CSS.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useAgentChat } from './useAgentChat';
import { ApprovalOverlay } from './ApprovalOverlay';
import type { DisplayMessage } from './MessageList';
import { subscribeToAskCommands, subscribeToAskOpen, type AskOrigin } from './ask-command-bridge';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import type { AppRole } from '@/lib/roles';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AiActivityButton } from './AiActivityButton';
import { FeedbackButton } from '@/components/layout/FeedbackButton';
import { useCompanion } from '@/components/companion/useCompanion';
import { companionLabels, panelEyebrow, pastChatsHeading, sleepLine } from '@/lib/companion/copy';
import {
  clampDockPosition,
  defaultDockPosition,
  isDragGesture,
  peekFits,
  placePanel,
  placePeek,
  panelWidthFor,
  readStoredDock,
  writeStoredDock,
  MARK_SIZE,
  type Vec,
  type Viewport,
} from '@/lib/companion/dock';

const PLACEHOLDER = 'Ask Staxis anything about the property…';
const LISTENING_PLACEHOLDER = 'Listening… speak and it appears here';

const MOBILE_WELCOME = 'I’m here and thinking with you. What should we handle first?';
const MOBILE_PROMPTS = [
  { label: 'What needs attention?', prompt: 'What needs my attention this morning?' },
  { label: 'Show open shifts', prompt: 'Show me the open shifts.' },
];

const MOBILE_BY_ROLE: Record<string, {
  welcome: string;
  prompts: Array<{ label: string; prompt: string }>;
}> = {
  front_desk: {
    welcome: 'Got a guest asking something? I’ll tell you what this hotel has actually confirmed.',
    prompts: [
      { label: 'Wifi password', prompt: 'What’s the guest wifi password?' },
      { label: 'Breakfast hours', prompt: 'What time is breakfast served?' },
    ],
  },
  maintenance: {
    welcome: 'Standing in front of something? I’ll pull its history and what’s due.',
    prompts: [
      { label: 'What’s due', prompt: 'What preventive maintenance is due this week?' },
      { label: 'Room history', prompt: 'What’s the work order history on room 214?' },
    ],
  },
};
const INVENTORY_MOBILE_WELCOME =
  'I can review what’s under par and help draft the next reorder. Want me to start?';
const INVENTORY_MOBILE_PROMPTS = [
  {
    label: 'Draft reorder',
    prompt: 'Review the inventory items under par and draft a reorder for the items that need attention now.',
  },
  {
    label: 'Show low stock',
    prompt: 'Show me all inventory items that are currently under par, grouped by urgency.',
  },
];

/** How long the thread/history cross-slide runs. Matches C1 in the handoff. */
const SWAP_MS = 240;

// Minimal shape of the Web Speech API we touch — it isn't in the standard DOM
// lib types and is `webkit`-prefixed in Chrome/Safari.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

type MarkState = 'calm' | 'working' | 'wrong';
type PanelView = 'thread' | 'history';

function readViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function AskStaxisBar() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const pathname = usePathname();
  const onInventory = pathname === '/inventory' || pathname.startsWith('/inventory/');
  const roleMobile = user?.role ? MOBILE_BY_ROLE[user.role] : undefined;
  const labels = useMemo(() => companionLabels(), []);

  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>('thread');
  const [leaving, setLeaving] = useState<PanelView | null>(null);
  const [swapBack, setSwapBack] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [dictating, setDictating] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  // ── Where the object sits ────────────────────────────────────────────────
  // `dock === null` means "still in its corner", which is not the same as a
  // stored position that happens to equal the corner: the corner tracks the
  // viewport, a stored position does not.
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  const [dock, setDock] = useState<Vec | null>(null);
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const cornerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const mobileThreadRef = useRef<HTMLDivElement>(null);
  const mobileSheetRef = useRef<HTMLElement>(null);
  const mobileFabRef = useRef<HTMLButtonElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const swapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: Vec } | null>(null);
  const suppressClickRef = useRef(false);

  const {
    messages,
    conversations,
    conversationId,
    streaming,
    error,
    sendMessage,
    startNew,
    loadConversation,
    pendingActions,
    resultCard,
    resolveAction,
    dismissResultCard,
    actionErrors,
  } = useAgentChat({
    propertyId: activePropertyId,
    // Warm the conversation list once the person engages, so Past chats is
    // populated by the time they swap to it.
    active: open || mobileOpen,
    pathname,
  });

  const hasText = input.trim().length > 0;

  // ── The companion's turn, handed to the one chat brain ───────────────────
  // A ref so the hook can be created before `submit` exists without either one
  // reaching into the other's closure.
  const submitRef = useRef<(text: string, origin?: AskOrigin) => void>(() => {});
  const seed = useCallback((text?: string) => {
    setOpen(true);
    setView('thread');
    setLeaving(null);
    if (text) submitRef.current(text, 'companion');
  }, []);
  const companion = useCompanion(seed);

  const scrollBottomSoon = useCallback(() => {
    requestAnimationFrame(() => {
      for (const el of [threadRef.current, mobileThreadRef.current]) {
        if (el) el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    if (open || mobileOpen) scrollBottomSoon();
  }, [messages, streaming, open, mobileOpen, scrollBottomSoon]);

  const stopDictation = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    recognitionRef.current = null;
    setDictating(false);
  }, []);

  // `origin` is set only by the companion, which hands its turns to this one
  // brain rather than running a second chat. It selects the AI Control Center
  // slot for the turn and nothing else.
  const submit = useCallback((raw: string, origin?: AskOrigin) => {
    const text = raw.trim();
    if (!text || streaming) return;
    if (recognitionRef.current) stopDictation();
    setOpen(true);
    setView('thread');
    setLeaving(null);
    setMenuOpen(false);
    if (window.matchMedia('(max-width: 760px)').matches) setMobileOpen(true);
    setInput('');
    void sendMessage(text, origin ? { origin } : undefined);
  }, [streaming, sendMessage, stopDictation]);

  useEffect(() => { submitRef.current = submit; }, [submit]);

  const wake = useCallback(() => {
    setOpen(true);
    setView('thread');
    setLeaving(null);
    if (window.matchMedia('(max-width: 760px)').matches) setMobileOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    setMenuOpen(false);
  }, []);

  // C1 · the list replaces the thread inside the same slab. The outgoing view
  // stays mounted for the length of the slide so both halves move together.
  const swapView = useCallback((next: PanelView) => {
    setMenuOpen(false);
    if (view === next) return;
    setLeaving(view);
    setSwapBack(next === 'thread');
    setView(next);
    if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
    swapTimerRef.current = setTimeout(() => {
      setLeaving(null);
      swapTimerRef.current = null;
    }, SWAP_MS);
  }, [view]);

  useEffect(() => () => { if (swapTimerRef.current) clearTimeout(swapTimerRef.current); }, []);

  const openMobile = useCallback(() => {
    setMobileOpen(true);
    requestAnimationFrame(() => mobileInputRef.current?.focus({ preventScroll: true }));
  }, []);

  const closeMobile = useCallback(() => {
    setMobileOpen(false);
    mobileInputRef.current?.blur();
    requestAnimationFrame(() => mobileFabRef.current?.focus({ preventScroll: true }));
  }, []);

  // A rotation or responsive resize into the desktop shell must not leave a
  // hidden mobile sheet owning Escape/focus behavior.
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const sync = () => { if (!media.matches) setMobileOpen(false); };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (mobileOpen) scrollBottomSoon();
  }, [mobileOpen, scrollBottomSoon]);

  const openPastChat = useCallback(async (id: string) => {
    swapView('thread');
    await loadConversation(id);
    scrollBottomSoon();
  }, [loadConversation, swapView, scrollBottomSoon]);

  const toggleDictation = useCallback(() => {
    if (dictating) { stopDictation(); return; }
    setDictating(true);
    inputRef.current?.focus();

    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!Ctor) return;  // unsupported → visual-only listening state

    try {
      const rec = new Ctor();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      const base = input.trim() ? input.trim() + ' ' : '';
      rec.onresult = (e) => {
        let txt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          txt += e.results[i][0]?.transcript ?? '';
        }
        setInput((base + txt).replace(/\s+/g, ' ').trimStart());
      };
      rec.onend = () => { recognitionRef.current = null; setDictating(false); };
      rec.onerror = () => { recognitionRef.current = null; setDictating(false); };
      recognitionRef.current = rec;
      rec.start();
    } catch {
      recognitionRef.current = null;
      setDictating(false);
    }
  }, [dictating, input, stopDictation]);

  // Esc closes the menu, then the sheet, then the panel. Outside pointerdown
  // closes the panel. The conversation is retained either way, never reset.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) { setMenuOpen(false); return; }
      if (mobileOpen) { closeMobile(); return; }
      if (open) closePanel();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (mobileOpen && mobileSheetRef.current?.contains(target)) return;
      if (mobileOpen) return;
      if (cornerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      if (open) closePanel();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, menuOpen, mobileOpen, closeMobile, closePanel]);

  // A walkthrough (Clicky-style cursor demo) takes over the screen.
  useEffect(() => {
    const handler = () => { setOpen(false); setMenuOpen(false); };
    window.addEventListener('walkthrough:start', handler);
    return () => window.removeEventListener('walkthrough:start', handler);
  }, []);

  // Route change closes the panel. The conversation itself persists.
  useEffect(() => { setOpen(false); setMenuOpen(false); setPeeking(false); }, [pathname]);

  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch { /* noop */ } }, []);

  // The Concourse hub's hero Ask bar hands its input here through a durable
  // event bridge, so there is exactly ONE conversation brain no matter which
  // surface the person typed into.
  useEffect(() => subscribeToAskCommands(submit), [submit]);
  useEffect(() => subscribeToAskOpen(wake), [wake]);

  // ── Dock: read the stored position, keep it inside the window ────────────
  useEffect(() => {
    const stored = readStoredDock(typeof window === 'undefined' ? null : window.localStorage);
    if (stored) setDock(clampDockPosition(stored, readViewport()));
  }, []);

  useEffect(() => {
    const onResize = () => {
      const next = readViewport();
      setViewport(next);
      setDock((current) => (current === null ? null : clampDockPosition(current, next)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const markPos = dock ?? defaultDockPosition(viewport);
  // The live position during a drag, so the pointerup that persists it does not
  // have to read state that has not committed yet.
  const latestDockRef = useRef<Vec | null>(dock);
  useEffect(() => { latestDockRef.current = dock; }, [dock]);

  const onMarkPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Every gesture starts as a click and only becomes a drag by moving.
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: markPos,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }, [markPos]);

  const onMarkPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!suppressClickRef.current && !isDragGesture(dx, dy)) return;
    // Past the threshold this is a drag, and the click it would otherwise end
    // in must not open the panel.
    suppressClickRef.current = true;
    setDragging(true);
    setPeeking(false);
    const next = clampDockPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, viewport);
    latestDockRef.current = next;
    setDock(next);
  }, [viewport]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!suppressClickRef.current) return;
    setDragging(false);
    writeStoredDock(
      typeof window === 'undefined' ? null : window.localStorage,
      latestDockRef.current,
    );
  }, []);

  const onMarkClick = useCallback(() => {
    // A real drag never opens the panel; a clean click always does.
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    setMenuOpen(false);
    setOpen((wasOpen) => !wasOpen);
    setView('thread');
    setLeaving(null);
  }, []);

  // One way back, for somebody who dragged it somewhere they regret.
  const resetDock = useCallback(() => {
    suppressClickRef.current = false;
    latestDockRef.current = null;
    setDock(null);
    writeStoredDock(typeof window === 'undefined' ? null : window.localStorage, null);
    setOpen(false);
    setMenuOpen(false);
  }, []);

  const panel = useMemo(() => placePanel(markPos, viewport), [markPos, viewport]);
  const peekAt = useMemo(() => placePeek(markPos, viewport), [markPos, viewport]);
  const panelWidth = useMemo(() => panelWidthFor(viewport), [viewport]);

  if (!user || !activePropertyId) return null;
  // WHO LENSES: a hat with no chat does not get an object in the corner.
  // Housekeeping is the only one, and it is a product rule, not a capability
  // judgement: their surface is the room card on the phone they already carry,
  // and Staxis never adds a step to that job. Hiding the control here is
  // cosmetic; the decision is the route's (403 `chat_not_mounted`), which
  // resolves the hat AT THIS HOTEL. useCompanion refuses the same hat and the
  // same screens independently, so neither gate relies on the other.
  if (!chatIsMountedForRole(user.role as AppRole)) return null;

  // Typing dots show whenever we're streaming but the latest visible content
  // isn't the assistant's reply yet (initial latency or a tool call in flight).
  const last = messages[messages.length - 1];
  const lastIsAssistantText = !!last && last.role === 'assistant' && !!last.text && !last.toolName;
  const showTyping = streaming && !lastIsAssistantText;

  // Only colour ever changes on the mark. Working is the honest one (a request
  // is genuinely in flight); Wrong is the companion's own severity, because
  // that is the only real severity the browser holds.
  const markState: MarkState = streaming
    ? 'working'
    : companion.peek?.severity === 'urgent'
      ? 'wrong'
      : 'calm';

  const showing = companion.showing;
  const peek = companion.peek;
  const peekVisible = !open && !dragging && peeking && peek !== null && peekFits(peekAt);

  const filtered = query.trim()
    ? conversations.filter((c) => (c.title ?? '').toLowerCase().includes(query.trim().toLowerCase()))
    : conversations;
  const days = groupByDay(filtered);

  const composer = (placeholder: string, onSend: () => void, withMic: boolean) => (
    <div className="asx-comp">
      <span className="asx-comp-spark" aria-hidden>✦</span>
      <input
        ref={withMic ? inputRef : undefined}
        className="asx-comp-input"
        value={input}
        placeholder={placeholder}
        aria-label="Ask Staxis"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSend(); } }}
      />
      {withMic && (
        <button
          type="button"
          className={`asx-comp-ic${dictating ? ' asx-listening' : ''}`}
          onClick={toggleDictation}
          aria-label="Talk to type"
          aria-pressed={dictating}
        >
          <Mic />
        </button>
      )}
      <button
        type="button"
        className="asx-comp-send"
        onClick={onSend}
        aria-label="Send"
        disabled={!hasText || streaming}
      >
        <ArrowUp />
      </button>
    </div>
  );

  const threadView = (
    <div className={viewClass('thread', view, leaving, swapBack)}>
      <div className="asx-strip">
        <span className="asx-lab">{panelEyebrow({ page: companion.page, streaming })}</span>
        <button
          type="button"
          className="asx-lab asx-striplink"
          onClick={() => swapView('history')}
        >
          {labels.pastChats}
        </button>
        <button
          type="button"
          className="asx-icobtn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={labels.more}
          aria-expanded={menuOpen}
        >
          <Ellipsis />
        </button>
        <button type="button" className="asx-icobtn" onClick={closePanel} aria-label={labels.close}>
          <CloseX />
        </button>
      </div>

      {menuOpen && (
        <div className="asx-menu" role="menu">
          {companion.tour.length > 0 && (
            <button
              type="button"
              role="menuitem"
              className="asx-menurow"
              onClick={() => { setMenuOpen(false); closePanel(); companion.startTour(); }}
            >
              {labels.showMeAround}
            </button>
          )}
          <AiActivityButton
            variant="menu"
            menuClassName="asx-menurow"
            menuLabel={labels.aiActivity}
            open={activityOpen}
            onOpenChange={(next) => { setActivityOpen(next); if (next) setMenuOpen(false); }}
          />
          <FeedbackButton
            variant="menu"
            menuClassName="asx-menurow"
            menuLabel={labels.sendFeedback}
            open={feedbackOpen}
            onOpenChange={(next) => { setFeedbackOpen(next); if (next) setMenuOpen(false); }}
          />
          {dock !== null && (
            <button
              type="button"
              role="menuitem"
              className="asx-menurow"
              onClick={() => { setMenuOpen(false); resetDock(); }}
            >
              {labels.backToCorner}
            </button>
          )}
        </div>
      )}

      <div className="asx-thread" ref={threadRef} aria-live="polite">
        {companion.asleep ? (
          // The honest sleep state. Never a spinner: a spinner is a lie told
          // slowly, and the reason is knowable, so it gets said.
          <p className="asx-turn-s">{sleepLine(companion.sleepReason ?? 'unknown')}</p>
        ) : (
          <>
            {showing.kind === 'speech' && (
              <CompanionBlock
                lines={[
                  showing.speech.kind === 'welcome' ? showing.speech.greeting : showing.speech.sentence,
                  showing.question,
                ]}
                yesLabel={labels.yes}
                noLabel={labels.no}
                onYes={companion.answerYes}
                onNo={companion.answerNo}
                onQuiet={companion.quiet}
                quietLabel={labels.quietForNow}
              />
            )}
            {showing.kind === 'teach' && (
              <CompanionBlock
                lines={[showing.text]}
                example={showing.example}
                yesLabel={labels.yes}
                noLabel={labels.dismiss}
                onYes={companion.answerYes}
                onNo={companion.dismiss}
                onQuiet={companion.quiet}
                quietLabel={labels.quietForNow}
              />
            )}
            {showing.kind === 'arrived' && (
              <CompanionBlock
                lines={[showing.line]}
                yesLabel={
                  companion.tourStep !== null && companion.tourStep + 1 < companion.tour.length
                    ? `Next: ${companion.tour[companion.tourStep + 1].label}`
                    : null
                }
                noLabel={labels.close}
                onYes={companion.nextTourStep}
                onNo={companion.dismiss}
              />
            )}
            {messages.length === 0 && showing.kind === 'none' && (
              <p className="asx-turn-s">{labels.askPlaceholder}</p>
            )}
            {messages.map((m, i) => (
              <Turn key={i} message={m} reveal={i === messages.length - 1} />
            ))}
            {showTyping && (
              <div className="asx-thinking" aria-label="Staxis is thinking"><i /><i /><i /></div>
            )}
            {error && <div className="asx-err">{error}</div>}
          </>
        )}
      </div>

      {composer(dictating ? LISTENING_PLACEHOLDER : PLACEHOLDER, () => submit(input), true)}
    </div>
  );

  const historyView = (
    <div className={viewClass('history', view, leaving, swapBack)}>
      <div className="asx-hhead">
        <button
          type="button"
          className="asx-icobtn"
          onClick={() => swapView('thread')}
          aria-label={labels.back}
        >
          <BackArrow />
        </button>
        {searching ? (
          <input
            className="asx-hsearch"
            value={query}
            autoFocus
            placeholder={labels.search}
            aria-label={labels.search}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : (
          <span className="asx-lab">{pastChatsHeading(conversations.length)}</span>
        )}
        <button
          type="button"
          className="asx-lab asx-striplink"
          onClick={() => { setSearching((v) => !v); setQuery(''); }}
        >
          {searching ? labels.close : labels.search}
        </button>
      </div>

      <div className="asx-hlist">
        {days.length === 0 ? (
          <div className="asx-hempty">{labels.noPastChats}</div>
        ) : days.map((day) => (
          <div key={day.label}>
            <div className="asx-hday">{day.label}</div>
            {day.items.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`asx-hrow${c.id === conversationId ? ' asx-hrow-on' : ''}`}
                onClick={() => void openPastChat(c.id)}
              >
                <span className="asx-hdot" aria-hidden />
                <span className="asx-hbody">
                  <b>{c.title?.trim() || 'Untitled chat'}</b>
                </span>
                <span className="asx-htime">{timeOf(c.updatedAt)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {composer(labels.newChat, () => { if (!hasText) return; startNew(); submit(input); }, false)}
    </div>
  );

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ASX_CSS }} />
      {/* Approval + result cards render via a portal at z-index 10000 — above
          the panel AND the voice overlay (z 9999), so an action card stays
          clickable even while a voice call is up. */}
      <ApprovalOverlay
        pendingActions={pendingActions}
        resultCard={resultCard}
        resolveAction={resolveAction}
        dismissResultCard={dismissResultCard}
        actionErrors={actionErrors}
      />

      {/* Phone surface — one compact FAB and a bottom sheet. It shares every
          message and action with the desktop panel above; this is only a
          responsive presentation, not a second chat. */}
      {mobileOpen && (
        <section
          ref={mobileSheetRef}
          id="staxis-mobile-sheet"
          className={`asx-mobile-sheet${onInventory ? ' asx-mobile-sheet-inventory' : ''}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby="staxis-mobile-title"
        >
          <div className="asx-mobile-grab" aria-hidden><span /></div>
          <header className="asx-mobile-head">
            <div className="asx-mobile-id">
              <span className="asx-mobile-spark" aria-hidden>✦</span>
              <span>
                <strong id="staxis-mobile-title">Staxis</strong>
                <small><i aria-hidden />{streaming
                  ? 'thinking…'
                  : onInventory
                    ? 'on inventory'
                    : 'thinking with you'}</small>
              </span>
            </div>
            <button type="button" className="asx-mobile-close" onClick={closeMobile} aria-label="Close Staxis">
              <CloseX />
            </button>
          </header>

          <div ref={mobileThreadRef} className="asx-mobile-thread" aria-live="polite">
            {messages.length === 0 ? (
              <>
                <div className="asx-mobile-welcome">
                  {onInventory ? INVENTORY_MOBILE_WELCOME : roleMobile?.welcome ?? MOBILE_WELCOME}
                </div>
                <div className="asx-mobile-quick" aria-label="Suggestions">
                  {(onInventory ? INVENTORY_MOBILE_PROMPTS : roleMobile?.prompts ?? MOBILE_PROMPTS).map((item, index) => (
                    <button
                      key={item.label}
                      type="button"
                      className={index === 0 ? 'asx-mobile-quick-primary' : undefined}
                      onClick={() => submit(item.prompt)}
                    >
                      {item.label}
                    </button>
                  ))}
                  <button type="button" onClick={closeMobile}>Not now</button>
                </div>
              </>
            ) : (
              messages.map((message, index) => <Bubble key={index} message={message} />)
            )}
            {showTyping && (
              <div className="asx-typing" aria-label="Staxis is thinking"><i /><i /><i /></div>
            )}
            {error && <div className="asx-msg asx-err-mobile">{error}</div>}
          </div>

          <div className="asx-mobile-composer">
            <span aria-hidden>✦</span>
            <input
              ref={mobileInputRef}
              value={input}
              placeholder="Ask or command…"
              aria-label="Ask Staxis"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(input); }
              }}
            />
            <button
              type="button"
              onClick={() => submit(input)}
              aria-label="Send"
              disabled={!hasText || streaming}
            >
              <ArrowUp />
            </button>
          </div>
        </section>
      )}
      <button
        ref={mobileFabRef}
        type="button"
        className={`asx-mobile-fab${mobileOpen ? ' asx-mobile-fab-open' : ''}${onInventory ? ' asx-mobile-fab-inventory' : ''}`}
        onClick={mobileOpen ? closeMobile : openMobile}
        aria-label={mobileOpen ? 'Close Staxis' : 'Ask Staxis'}
        aria-expanded={mobileOpen}
        aria-controls="staxis-mobile-sheet"
      >
        {mobileOpen ? <CloseX /> : <span aria-hidden>✦</span>}
      </button>

      {/* ── The panel ── anchored to the mark wherever the mark ended up. */}
      {open && (
        <div
          ref={panelRef}
          id="staxis-panel"
          className="asx-panel"
          role="dialog"
          aria-label="Staxis"
          style={{
            left: `${panel.left}px`,
            width: `${panelWidth}px`,
            height: `${panel.maxHeight}px`,
            ...(panel.top !== null ? { top: `${panel.top}px` } : {}),
            ...(panel.bottom !== null ? { bottom: `${panel.bottom}px` } : {}),
          }}
        >
          {(view === 'thread' || leaving === 'thread') && threadView}
          {(view === 'history' || leaving === 'history') && historyView}
        </div>
      )}

      {/* ── The peek ── one clause, no click, aria-hidden: the same sentence
          is the panel's first line, so a screen reader meets it there. */}
      {peekVisible && peek && (
        <div
          className={`asx-peek asx-peek-${peekAt.side}`}
          aria-hidden
          style={{
            top: `${peekAt.centerY}px`,
            maxWidth: `${peekAt.maxWidth}px`,
            ...(peekAt.right !== null ? { right: `${peekAt.right}px` } : {}),
            ...(peekAt.left !== null ? { left: `${peekAt.left}px` } : {}),
          }}
        >
          <span className={`asx-peek-dot asx-sev-${peek.severity}`} />
          <span className="asx-peek-text">{peek.text}</span>
        </div>
      )}

      {/* ── The mark ── the one object. */}
      <div
        ref={cornerRef}
        className="asx-corner"
        style={{ left: `${markPos.x}px`, top: `${markPos.y}px` }}
      >
        <button
          type="button"
          className={`asx-mark asx-${markState}${dragging ? ' asx-dragging' : ''}`}
          aria-label="Ask Staxis"
          aria-expanded={open}
          aria-controls="staxis-panel"
          onPointerDown={onMarkPointerDown}
          onPointerMove={onMarkPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={onMarkClick}
          onDoubleClick={resetDock}
          onPointerEnter={() => setPeeking(true)}
          onPointerLeave={() => setPeeking(false)}
          onFocus={() => setPeeking(true)}
          onBlur={() => setPeeking(false)}
        >
          <span className="asx-sheen" aria-hidden />
          <span className="asx-catch" aria-hidden><Chevron /></span>
          <span className="asx-groove" aria-hidden><Chevron /></span>
        </button>
      </div>
    </>
  );
}

// ── The companion's one thing, inside the panel ───────────────────────────
function CompanionBlock({
  lines, example, yesLabel, noLabel, onYes, onNo, onQuiet, quietLabel,
}: {
  lines: string[];
  example?: string;
  yesLabel: string | null;
  noLabel: string;
  onYes: () => void;
  onNo: () => void;
  onQuiet?: () => void;
  quietLabel?: string;
}) {
  return (
    <div className="asx-offer">
      {lines.filter(Boolean).map((line, i) => (
        <p key={i} className="asx-turn-s">{line}</p>
      ))}
      {example && <p className="asx-eg">{example}</p>}
      <div className="asx-acts">
        {yesLabel && (
          <button type="button" className="asx-btn asx-btn-primary" onClick={onYes}>{yesLabel}</button>
        )}
        <button type="button" className="asx-btn" onClick={onNo}>{noLabel}</button>
        {onQuiet && quietLabel && (
          <button type="button" className="asx-quiet" onClick={onQuiet}>{quietLabel}</button>
        )}
      </div>
    </div>
  );
}

// ── One turn in the panel ─────────────────────────────────────────────────
// Staxis answers with NO bubble: its voice is the panel talking, not a second
// participant in it.
function Turn({ message: m, reveal }: { message: DisplayMessage; reveal: boolean }) {
  if (m.role === 'user') return <div className="asx-turn-u">{m.text}</div>;
  if (m.role === 'assistant' && m.text && !m.toolName) {
    // D2 rides only the answer that is landing. Reopening a long past chat
    // must not set twenty paragraphs wiping across the panel at once.
    return (
      <div className={reveal ? 'asx-turn-s asx-reveal' : 'asx-turn-s'}>
        <AssistantMarkdown text={m.text} />
      </div>
    );
  }
  return null;
}

// ── One message bubble (phone sheet) ──────────────────────────────────────
function Bubble({ message: m }: { message: DisplayMessage }) {
  if (m.role === 'user') return <div className="asx-msg asx-u">{m.text}</div>;
  if (m.role === 'assistant' && m.text && !m.toolName) {
    return (
      <div className="asx-msg asx-a">
        <AssistantMarkdown text={m.text} />
      </div>
    );
  }
  return null;
}

/** Which slide class an in-place view gets during the C1 swap. */
function viewClass(
  self: PanelView,
  view: PanelView,
  leaving: PanelView | null,
  back: boolean,
): string {
  if (leaving === null) return 'asx-view';
  if (self === leaving) return `asx-view asx-exit-${back ? 'back' : 'fwd'}`;
  if (self === view) return `asx-view asx-enter-${back ? 'back' : 'fwd'}`;
  return 'asx-view';
}

// ── Past chats, grouped the way formatWhen already groups ─────────────────
interface DayGroup { label: string; items: Array<{ id: string; title: string | null; updatedAt: string }> }

function groupByDay(
  list: ReadonlyArray<{ id: string; title: string | null; updatedAt: string }>,
): DayGroup[] {
  const out: DayGroup[] = [];
  for (const item of list) {
    const label = dayLabel(item.updatedAt);
    const tail = out[out.length - 1];
    if (tail && tail.label === label) tail.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── Inline icons ──────────────────────────────────────────────────────────
const ICO = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const Mic = () => (
  <svg viewBox="0 0 20 20" {...ICO}><rect x="7.5" y="2.5" width="5" height="9" rx="2.5" /><path d="M5 9a5 5 0 0 0 10 0M10 14v3.2M7.5 17.5h5" /></svg>
);
const ArrowUp = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10 16V4.5M5 9l5-5 5 5" /></svg>
);
const CloseX = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
);
const BackArrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
);
const Ellipsis = () => (
  <svg viewBox="0 0 20 20" fill="currentColor"><circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" /></svg>
);
/** CxLogo's path, verbatim. Engraved twice: a catch behind, a groove on top. */
const Chevron = () => (
  <svg viewBox="0 0 64 64" width="30" height="30" fill="none" strokeWidth={4.4} strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 28 L26 20 M18 38 L38 18 M28 38 L38 28 M28 48 L46 30" />
  </svg>
);

// ── Scoped styles (everything prefixed asx-) ──────────────────────────────
const ASX_CSS = `
.asx-corner,.asx-panel,.asx-peek,.asx-mobile-sheet,.asx-mobile-fab{
  --asx-ink:#1F231C;--asx-sage:#5C7A60;--asx-sage-l:#9EB7A6;--asx-brand:#3E5C48;
  --asx-amber:#C99644;--asx-amber-l:#FBE3B8;--asx-rust:#B85C3D;--asx-white:#FCFDFB;
  --asx-rule:rgba(158,183,166,.14);--asx-spring:cubic-bezier(.22,1,.36,1);
  --asx-accent:#3E5C48;--asx-ink2:var(--snow-ink2,#5C625C);--asx-ink3:var(--snow-ink3,#A6ABA6);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
}
.asx-corner *,.asx-panel *,.asx-peek *{box-sizing:border-box;}

/* ── The mark ────────────────────────────────────────────────────────────── */
.asx-corner{position:fixed;z-index:60;width:${MARK_SIZE}px;height:${MARK_SIZE}px;}
.asx-mark{
  position:relative;display:grid;place-items:center;padding:0;border:none;cursor:pointer;
  width:${MARK_SIZE}px;height:${MARK_SIZE}px;border-radius:50%;touch-action:none;
  -webkit-tap-highlight-color:transparent;
  background:radial-gradient(circle at 50% 118%,rgba(92,122,96,.42) 0%,rgba(92,122,96,0) 58%),var(--asx-ink);
  box-shadow:
    inset -1px -2px 3px rgba(158,183,166,.16),
    inset 1px 2px 3px rgba(0,0,0,.80),
    0 18px 38px -16px rgba(31,42,32,.78);
  transition:background .42s ease,box-shadow .42s ease;
}
.asx-mark.asx-dragging{cursor:grabbing;}
.asx-mark:focus-visible{outline:2px solid var(--asx-brand);outline-offset:3px;}
.asx-sheen{position:absolute;inset:0;border-radius:50%;pointer-events:none;
  background:radial-gradient(ellipse 70px 34px at 46% 96%,rgba(158,183,166,.16),rgba(158,183,166,0) 70%);
  animation:asxSheen 15s ease-in-out infinite;}
@keyframes asxSheen{0%,100%{transform:translate(0,0) scale(1);}50%{transform:translate(7px,5px) scale(1.1);}}
@keyframes asxPulse{0%,100%{opacity:.5;}50%{opacity:.95;}}
.asx-catch,.asx-groove{position:absolute;display:grid;place-items:center;pointer-events:none;}
.asx-catch{transform:translate(.9px,1px);}
.asx-catch svg{stroke:rgba(158,183,166,.34);transition:stroke .42s ease;}
.asx-groove svg{stroke:rgba(0,0,0,.72);}

.asx-mark.asx-working{
  background:radial-gradient(circle at 50% 118%,rgba(158,183,166,.72) 0%,rgba(92,122,96,0) 62%),var(--asx-ink);
  box-shadow:
    inset -1px -2px 3px rgba(158,183,166,.30),
    inset 1px 2px 3px rgba(0,0,0,.80),
    0 0 0 5px rgba(158,183,166,.16),
    0 18px 38px -16px rgba(31,42,32,.78);
}
.asx-mark.asx-working .asx-sheen{
  background:radial-gradient(ellipse 70px 34px at 46% 96%,rgba(158,183,166,.30),rgba(158,183,166,0) 70%);
  animation:asxPulse 2.2s ease-in-out infinite;}
.asx-mark.asx-working .asx-catch svg{stroke:rgba(158,183,166,.55);}

.asx-mark.asx-wrong{
  background:radial-gradient(circle at 50% 118%,rgba(201,150,68,.60) 0%,rgba(184,92,61,.12) 46%,rgba(184,92,61,0) 62%),var(--asx-ink);
  box-shadow:
    inset -1px -2px 3px rgba(201,150,68,.30),
    inset 1px 2px 3px rgba(0,0,0,.80),
    0 0 0 5px rgba(201,150,68,.13),
    0 18px 38px -16px rgba(31,42,32,.78);
}
.asx-mark.asx-wrong .asx-sheen{
  background:radial-gradient(ellipse 70px 34px at 46% 96%,rgba(201,150,68,.26),rgba(201,150,68,0) 70%);
  animation:none;}
.asx-mark.asx-wrong .asx-catch svg{stroke:rgba(251,227,184,.55);}

/* ── Peek ────────────────────────────────────────────────────────────────── */
.asx-peek{position:fixed;z-index:59;display:flex;align-items:center;gap:10px;
  transform:translateY(-50%);padding:11px 16px;border-radius:14px;background:var(--asx-ink);
  box-shadow:0 20px 44px -24px rgba(31,42,32,.75);pointer-events:none;}
.asx-peek-left{animation:asxPeekL .22s var(--asx-spring) both;}
.asx-peek-right{animation:asxPeekR .22s var(--asx-spring) both;}
@keyframes asxPeekL{from{opacity:0;transform:translate(8px,-50%);}to{opacity:1;transform:translate(0,-50%);}}
@keyframes asxPeekR{from{opacity:0;transform:translate(-8px,-50%);}to{opacity:1;transform:translate(0,-50%);}}
.asx-peek-dot{width:6px;height:6px;border-radius:50%;flex:none;}
.asx-sev-ok{background:var(--asx-sage);}
.asx-sev-watch{background:var(--asx-amber);}
.asx-sev-urgent{background:var(--asx-rust);}
.asx-peek-text{font-size:13px;line-height:1.45;color:#FFFFFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

/* ── The panel ───────────────────────────────────────────────────────────── */
.asx-panel{position:fixed;z-index:60;border-radius:24px;overflow:hidden;
  background:radial-gradient(ellipse 300px 180px at 50% 112%,rgba(92,122,96,.30) 0%,rgba(92,122,96,0) 60%),var(--asx-ink);
  box-shadow:inset 0 1px 0 rgba(158,183,166,.14),0 30px 64px -24px rgba(31,42,32,.72);
  animation:asxRise .28s var(--asx-spring) both;}
@keyframes asxRise{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:none;}}
.asx-view{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;}
@keyframes asxExitFwd{from{opacity:1;transform:none;}to{opacity:0;transform:translateX(-18px);}}
@keyframes asxEnterFwd{from{opacity:0;transform:translateX(18px);}to{opacity:1;transform:none;}}
@keyframes asxExitBack{from{opacity:1;transform:none;}to{opacity:0;transform:translateX(18px);}}
@keyframes asxEnterBack{from{opacity:0;transform:translateX(-18px);}to{opacity:1;transform:none;}}
.asx-exit-fwd{animation:asxExitFwd ${SWAP_MS}ms var(--asx-spring) both;pointer-events:none;}
.asx-enter-fwd{animation:asxEnterFwd ${SWAP_MS}ms var(--asx-spring) both;}
.asx-exit-back{animation:asxExitBack ${SWAP_MS}ms var(--asx-spring) both;pointer-events:none;}
.asx-enter-back{animation:asxEnterBack ${SWAP_MS}ms var(--asx-spring) both;}

.asx-strip{display:flex;align-items:center;gap:10px;padding:13px 16px 10px;flex:none;}
.asx-lab{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--asx-sage-l);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.asx-striplink{margin-left:auto;background:transparent;border:none;cursor:pointer;padding:6px 2px;
  font-family:var(--font-geist-mono),ui-monospace,monospace;}
.asx-striplink:hover{color:var(--asx-white);}
.asx-striplink:focus-visible{outline:2px solid var(--asx-brand);outline-offset:2px;border-radius:6px;}
.asx-icobtn{width:26px;height:26px;flex:none;border-radius:50%;border:none;padding:0;cursor:pointer;
  background:rgba(158,183,166,.12);color:var(--asx-sage-l);display:grid;place-items:center;
  transition:background .18s,color .18s;}
.asx-icobtn:hover{background:rgba(158,183,166,.22);color:var(--asx-white);}
.asx-icobtn:focus-visible{outline:2px solid var(--asx-brand);outline-offset:2px;}
.asx-icobtn svg{width:12px;height:12px;}

.asx-menu{margin:0 12px 4px;padding:4px;border-radius:12px;flex:none;
  background:rgba(158,183,166,.10);border:1px solid var(--asx-rule);}
.asx-menurow{display:flex;align-items:center;width:100%;min-height:44px;padding:0 12px;border-radius:9px;
  border:none;background:transparent;color:var(--asx-white);font:inherit;font-size:13px;text-align:left;cursor:pointer;
  transition:background .18s;}
.asx-menurow:hover{background:rgba(158,183,166,.14);}
.asx-menurow:focus-visible{outline:2px solid var(--asx-brand);outline-offset:-2px;}

.asx-thread{flex:1;min-height:0;overflow-y:auto;scrollbar-width:none;
  display:flex;flex-direction:column;gap:15px;padding:6px 16px 0;}
.asx-thread::-webkit-scrollbar{display:none;}
.asx-turn-u{align-self:flex-end;max-width:78%;padding:8px 13px;font-size:13px;line-height:1.4;
  border-radius:14px 14px 6px 14px;background:rgba(158,183,166,.16);border:1px solid rgba(158,183,166,.22);
  color:var(--asx-white);white-space:pre-wrap;word-break:break-word;}
.asx-turn-s{font-size:14px;line-height:1.6;color:var(--asx-white);margin:0;}
.asx-turn-s b,.asx-turn-s strong{color:var(--asx-amber);font-weight:600;}
.asx-turn-s p{margin:0 0 6px;}
.asx-turn-s p:last-child{margin:0;}
.asx-turn-s ul,.asx-turn-s ol{margin:4px 0;padding-left:18px;}
.asx-turn-s a{color:var(--asx-sage-l);text-decoration:underline;}
.asx-turn-s code{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:.9em;
  background:rgba(158,183,166,.12);padding:1px 5px;border-radius:4px;}
/* D2 · Stream — the answer reveals left to right behind a travelling mask.
   Held at its end position so later token batches never make it jump back. */
@keyframes asxReveal{from{-webkit-mask-position:118% 0;mask-position:118% 0;}
  to{-webkit-mask-position:0 0;mask-position:0 0;}}
.asx-reveal{-webkit-mask-image:linear-gradient(90deg,#000 42%,transparent 58%);
  mask-image:linear-gradient(90deg,#000 42%,transparent 58%);
  -webkit-mask-size:250% 100%;mask-size:250% 100%;
  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
  animation:asxReveal 1.1s linear both;}

.asx-offer{display:flex;flex-direction:column;gap:8px;}
.asx-eg{margin:0;padding:8px 10px;border-radius:10px;font-size:13px;line-height:1.5;
  color:var(--asx-white);background:rgba(158,183,166,.12);}
.asx-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:2px;}
.asx-btn{height:34px;min-height:34px;display:inline-flex;align-items:center;padding:0 14px;border-radius:999px;
  border:1px solid rgba(158,183,166,.28);background:transparent;color:var(--asx-white);
  font:inherit;font-size:12.5px;font-weight:400;cursor:pointer;white-space:nowrap;transition:background .18s;}
.asx-btn:hover{background:rgba(158,183,166,.12);}
.asx-btn:focus-visible{outline:2px solid var(--asx-brand);outline-offset:2px;}
.asx-btn-primary{padding:0 15px;background:var(--asx-sage-l);border-color:var(--asx-sage-l);
  color:var(--asx-ink);font-weight:600;}
.asx-btn-primary:hover{background:#B0C6B7;}
.asx-quiet{background:transparent;border:none;padding:0 4px;cursor:pointer;font:inherit;font-size:11.5px;
  color:var(--asx-sage-l);text-decoration:underline;text-underline-offset:2px;}
.asx-quiet:hover{color:var(--asx-white);}
.asx-quiet:focus-visible{outline:2px solid var(--asx-brand);outline-offset:2px;}

.asx-thinking{display:inline-flex;gap:5px;padding:4px 0 2px;}
.asx-thinking i{width:6px;height:6px;border-radius:50%;background:var(--asx-sage-l);
  animation:asxDots 1.2s ease-in-out infinite;}
.asx-thinking i:nth-child(2){animation-delay:.16s;}
.asx-thinking i:nth-child(3){animation-delay:.32s;}
@keyframes asxDots{0%,100%{opacity:.22;}28%{opacity:1;}}
.asx-err{padding:9px 13px;border-radius:12px;font-size:12.5px;line-height:1.5;
  background:rgba(184,92,61,.18);color:var(--asx-amber-l);}

.asx-comp{display:flex;align-items:center;gap:9px;padding:11px 14px;flex:none;
  border-top:1px solid var(--asx-rule);}
.asx-comp-spark{color:var(--asx-sage-l);font-size:14px;line-height:1;flex:none;}
.asx-comp-input{flex:1;min-width:0;border:none;outline:none;background:transparent;
  font:inherit;font-size:13px;color:var(--asx-white);}
.asx-comp-input::placeholder{color:rgba(158,183,166,.6);}
.asx-comp-ic{width:28px;height:28px;flex:none;border-radius:50%;border:none;padding:0;cursor:pointer;
  background:transparent;color:var(--asx-sage-l);display:grid;place-items:center;transition:background .18s;}
.asx-comp-ic:hover{background:rgba(158,183,166,.14);}
.asx-comp-ic.asx-listening{background:var(--asx-sage-l);color:var(--asx-ink);}
.asx-comp-ic:focus-visible,.asx-comp-send:focus-visible{outline:2px solid var(--asx-brand);outline-offset:2px;}
.asx-comp-ic svg,.asx-comp-send svg{width:14px;height:14px;}
.asx-comp-send{width:28px;height:28px;flex:none;border-radius:50%;border:none;padding:0;cursor:pointer;
  background:var(--asx-sage-l);color:var(--asx-ink);display:grid;place-items:center;transition:opacity .2s;}
.asx-comp-send:disabled{opacity:.38;cursor:not-allowed;}

/* ── Past chats ──────────────────────────────────────────────────────────── */
.asx-hhead{display:flex;align-items:center;gap:11px;padding:13px 16px 12px;flex:none;
  border-bottom:1px solid rgba(158,183,166,.12);}
.asx-hsearch{flex:1;min-width:0;border:none;outline:none;background:transparent;
  font:inherit;font-size:13px;color:var(--asx-white);}
.asx-hsearch::placeholder{color:rgba(158,183,166,.6);}
.asx-hlist{flex:1;min-height:0;overflow-y:auto;scrollbar-width:none;display:flex;flex-direction:column;padding:8px 8px 4px;}
.asx-hlist::-webkit-scrollbar{display:none;}
.asx-hday{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--asx-sage-l);padding:7px 10px 8px;}
.asx-hrow{display:flex;align-items:flex-start;gap:11px;padding:10px;border-radius:12px;min-height:44px;
  width:100%;border:none;background:transparent;cursor:pointer;text-align:left;font:inherit;
  transition:background .18s;}
.asx-hrow:hover{background:rgba(158,183,166,.08);}
.asx-hrow:focus-visible{outline:2px solid var(--asx-brand);outline-offset:-2px;}
.asx-hrow-on{background:rgba(158,183,166,.12);}
.asx-hdot{width:7px;height:7px;border-radius:50%;flex:none;margin-top:5px;background:rgba(158,183,166,.3);}
.asx-hbody{flex:1;min-width:0;}
.asx-hbody b{display:block;font-size:13.5px;font-weight:600;color:var(--asx-white);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.asx-htime{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;
  color:var(--asx-sage-l);margin-top:2px;flex:none;}
.asx-hempty{padding:20px 12px;text-align:center;color:var(--asx-sage-l);font-size:12.5px;}

/* ── Confirmed phone shell: compact magic button + flush bottom sheet ── */
@keyframes asx-mobile-sheet-in{from{transform:translateY(100%)}to{transform:translateY(0)}}
.asx-mobile-fab,.asx-mobile-sheet{display:none;}
.asx-msg{max-width:75%;padding:8px 13px;font-size:13px;line-height:1.4;border-radius:15px;
  animation:asx-msgin .44s cubic-bezier(.2,1.25,.4,1);}
@keyframes asx-msgin{from{transform:translateY(12px) scale(.985)}to{transform:none}}
.asx-typing{align-self:flex-start;display:inline-flex;gap:5px;padding:14px 17px;border-radius:18px;border-bottom-left-radius:7px;}
.asx-typing i{width:6px;height:6px;border-radius:50%;background:var(--asx-ink3);animation:asx-td 1.1s infinite;}
.asx-typing i:nth-child(2){animation-delay:.15s}
.asx-typing i:nth-child(3){animation-delay:.3s}
@keyframes asx-td{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}

@media (max-width:760px){
  .asx-corner,.asx-panel,.asx-peek{display:none!important;}

  .asx-mobile-fab{position:fixed;right:18px;bottom:max(30px,calc(env(safe-area-inset-bottom,0px) + 14px));z-index:72;display:grid;
    width:56px;height:56px;border-radius:18px;border:1px solid rgba(92,122,96,.4);
    background:linear-gradient(150deg,#5C7A60,#3E5C48);color:#fff;cursor:pointer;padding:0;
    place-items:center;box-shadow:0 14px 30px -8px rgba(62,92,72,.6);
    -webkit-tap-highlight-color:transparent;}
  .asx-mobile-fab>span{font-size:24px;line-height:1;}
  .asx-mobile-fab>svg{width:20px;height:20px;}
  .asx-mobile-fab:active{transform:scale(.96);}
  .asx-mobile-fab:focus-visible{outline:2px solid #1F231C;outline-offset:3px;}
  /* Inventory has full-width quick-count controls down the page. Dock the
     assistant trigger into the phone header instead of covering a row's +
     button. The sheet itself already has a close action, so the trigger can
     leave the focus order while that sheet is open. */
  .asx-mobile-fab.asx-mobile-fab-inventory{top:max(6px,env(safe-area-inset-top,0px));right:68px;bottom:auto;
    width:44px;height:44px;border-radius:14px;animation:none;box-shadow:0 7px 18px -10px rgba(62,92,72,.6);}
  .asx-mobile-fab.asx-mobile-fab-inventory.asx-mobile-fab-open{visibility:hidden;}

  .asx-mobile-sheet{position:fixed;left:0;right:0;bottom:0;z-index:71;height:46dvh;min-height:350px;max-height:520px;
    display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#1F231C;
    border:0;border-top:1px solid rgba(92,122,96,.22);border-radius:26px 26px 0 0;
    box-shadow:0 -18px 50px -18px rgba(31,42,32,.4);animation:asx-mobile-sheet-in .34s cubic-bezier(.22,1,.36,1);
    box-sizing:border-box;}
  .asx-mobile-sheet *{box-sizing:border-box;}
  .asx-mobile-grab{height:12px;display:flex;justify-content:center;padding-top:8px;flex:none;background:#fff;}
  .asx-mobile-grab span{width:38px;height:4px;border-radius:999px;background:rgba(31,35,28,.14);}
  .asx-mobile-head{min-height:61px;padding:9px 9px 9px 15px;display:flex;align-items:center;justify-content:space-between;flex:none;
    background:linear-gradient(135deg,rgba(158,183,166,.26),rgba(158,183,166,.05));
    border-bottom:1px solid rgba(92,122,96,.16);}
  .asx-mobile-id{display:flex;align-items:center;gap:9px;min-width:0;}
  .asx-mobile-spark{width:32px;height:32px;border-radius:11px;display:grid;place-items:center;flex:none;
    background:rgba(92,122,96,.18);color:#3E5C48;font-size:17px;line-height:1;}
  .asx-mobile-id>span:last-child{display:flex;flex-direction:column;min-width:0;}
  .asx-mobile-id strong{font-size:14px;line-height:18px;font-weight:600;color:#1F231C;}
  .asx-mobile-id small{display:flex;align-items:center;gap:5px;margin-top:2px;color:#356B4C;
    font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;line-height:12px;font-weight:400;letter-spacing:.06em;}
  .asx-mobile-id small i{width:6px;height:6px;border-radius:50%;background:#5C7A60;flex:none;}
  .asx-mobile-close{width:44px;height:44px;border-radius:50%;border:none;background:transparent;color:#5C625C;cursor:pointer;
    display:grid;place-items:center;padding:0;position:relative;isolation:isolate;}
  .asx-mobile-close::before{content:'';position:absolute;width:28px;height:28px;border-radius:50%;background:rgba(31,35,28,.05);z-index:-1;}
  .asx-mobile-close svg{width:13px;height:13px;}
  .asx-mobile-close:focus-visible{outline:2px solid #3E5C48;outline-offset:-4px;}

  .asx-mobile-thread{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px;
    background:#FCFDFB;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
  .asx-mobile-thread::-webkit-scrollbar{display:none;}
  .asx-mobile-thread .asx-msg{padding:10px 13px;font-size:13px;line-height:1.5;animation:asx-msgin .34s cubic-bezier(.22,1,.36,1);}
  .asx-mobile-thread .asx-msg.asx-u{align-self:flex-end;max-width:82%;background:#1F231C;color:#fff;border:1px solid #1F231C;
    border-radius:16px 16px 5px 16px;box-shadow:none;white-space:pre-wrap;word-break:break-word;}
  .asx-mobile-thread .asx-msg.asx-a{align-self:flex-start;max-width:90%;background:rgba(158,183,166,.16);color:#1F231C;
    border:1px solid rgba(92,122,96,.2);border-radius:16px 16px 16px 5px;box-shadow:none;}
  .asx-mobile-thread .asx-msg.asx-a b,.asx-mobile-thread .asx-msg.asx-a strong{color:#3E5C48;font-weight:600;}
  .asx-mobile-thread .asx-msg.asx-a p{margin:0 0 6px;}
  .asx-mobile-thread .asx-msg.asx-a p:last-child{margin:0;}
  .asx-mobile-thread .asx-msg.asx-err-mobile{align-self:flex-start;max-width:90%;padding:10px 13px;font-size:13px;
    line-height:1.5;border-radius:16px 16px 16px 5px;background:rgba(253,244,241,.97);
    border:1px solid rgba(184,92,61,.28);color:#B85C3D;}
  .asx-mobile-thread .asx-typing{background:rgba(158,183,166,.16);border:1px solid rgba(92,122,96,.2);box-shadow:none;}
  .asx-mobile-welcome{align-self:flex-start;max-width:90%;padding:11px 13px;border-radius:16px 16px 16px 5px;
    background:rgba(158,183,166,.16);border:1px solid rgba(92,122,96,.2);font-size:13px;line-height:1.5;color:#1F231C;}
  .asx-mobile-quick{display:flex;flex-wrap:wrap;gap:7px;}
  .asx-mobile-quick button{height:44px;padding:0 13px;border-radius:999px;border:1px solid rgba(31,35,28,.14);background:#fff;
    color:#5C625C;font:500 12px/1 var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;}
  .asx-mobile-quick button.asx-mobile-quick-primary{border-color:#3E5C48;background:#3E5C48;color:#fff;font-weight:600;}
  .asx-mobile-quick button:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
  .asx-mobile-quick button:active{transform:scale(.98);}

  .asx-mobile-composer{min-height:58px;padding:8px 78px max(8px,env(safe-area-inset-bottom,0px)) 12px;display:flex;align-items:center;gap:9px;flex:none;
    background:#fff;border-top:1px solid rgba(31,35,28,.08);}
  .asx-mobile-sheet-inventory .asx-mobile-composer{padding-right:12px;}
  .asx-mobile-composer>span{color:#5C7A60;font-size:15px;line-height:1;flex:none;}
  .asx-mobile-composer input{flex:1;min-width:0;height:40px;border:none;outline:none;background:transparent;color:#1F231C;
    font:400 16px/20px var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
  .asx-mobile-composer input::placeholder{color:#A6ABA6;}
  .asx-mobile-composer input:focus-visible{box-shadow:inset 0 -2px #5C7A60;}
  .asx-mobile-composer button{width:44px;height:44px;flex:none;border-radius:50%;border:none;background:#3E5C48;color:#fff;cursor:pointer;
    display:grid;place-items:center;padding:4px;}
  .asx-mobile-composer button svg{width:15px;height:15px;}
  .asx-mobile-composer button:focus-visible{outline:2px solid #1F231C;outline-offset:2px;}
  .asx-mobile-composer button:disabled{opacity:.38;cursor:not-allowed;}
}

/* Reduced motion: the state colour crossfade stays, because it carries meaning.
   Every loop and every travelling transform goes. */
@media (prefers-reduced-motion: reduce){
  .asx-sheen{animation:none!important;}
  .asx-thinking i,.asx-typing i{animation:none;}
  .asx-panel{animation:asxFade .12s linear both;}
  .asx-enter-fwd,.asx-enter-back{animation:asxFade .12s linear both;}
  .asx-exit-fwd,.asx-exit-back{animation:none;opacity:0;}
  .asx-peek-left,.asx-peek-right{animation:asxFade .12s linear both;}
  .asx-reveal{-webkit-mask-image:none;mask-image:none;animation:none;}
  .asx-mobile-sheet,.asx-mobile-thread .asx-msg{animation:none;}
}
@keyframes asxFade{from{opacity:0;}to{opacity:1;}}
`;
