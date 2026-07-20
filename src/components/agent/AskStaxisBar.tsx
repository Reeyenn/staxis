'use client';

// ─── AskStaxisBar — global "Ask Staxis" command bar ───────────────────────
// Replaces the legacy bottom-right FloatingChatButton. A calm spark pill at
// rest (bottom-center) that wakes on hover/focus into a 540px "liquid glass"
// bar. Conversations grow UPWARD out of the bar in place — no separate panel
// or page. Type, or use the mic to dictate.
//
// Wiring (the prototype's mock data is replaced with the real brain):
//   • Text + streaming replies  → useAgentChat (/api/agent/command SSE)
//   • Past chats sheet           → useAgentChat.conversations + loadConversation
//   • Talk-to-type (mic icon)    → browser SpeechRecognition (graceful stub if
//                                  unsupported — just shows the listening pulse)
//
// All styling is scoped under `.asx-*` classes injected once below, so it
// can use :hover / ::after / masks / keyframes / color-mix that inline styles
// can't express, without colliding with the app's global CSS.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useAgentChat } from './useAgentChat';
import { ApprovalOverlay } from './ApprovalOverlay';
import type { DisplayMessage } from './MessageList';

type ChatState = 'empty' | 'active' | 'collapsed';

const PLACEHOLDER = {
  en: 'Ask Staxis anything about the property…',
  es: 'Pregúntale a Staxis lo que sea del hotel…',
};
const LISTENING_PLACEHOLDER = {
  en: 'Listening… speak and it appears here',
  es: 'Escuchando… habla y aparece aquí',
};
const SUGGESTIONS = {
  en: ['What needs my attention?', "Who's behind on rooms?", 'Should I raise rates?'],
  es: ['¿Qué necesita mi atención?', '¿Quién va atrasado con las habitaciones?', '¿Debería subir tarifas?'],
};
const MOBILE_WELCOME = {
  en: 'I’m here and thinking with you. What should we handle first?',
  es: 'Estoy aquí para ayudarte. ¿Qué resolvemos primero?',
};
const MOBILE_PROMPTS = {
  en: [
    { label: 'What needs attention?', prompt: 'What needs my attention this morning?' },
    { label: 'Show open shifts', prompt: 'Show me the open shifts.' },
  ],
  es: [
    { label: '¿Qué necesita atención?', prompt: '¿Qué necesita mi atención esta mañana?' },
    { label: 'Ver turnos abiertos', prompt: 'Muéstrame los turnos abiertos.' },
  ],
};
const INVENTORY_MOBILE_WELCOME = {
  en: 'I can review what’s under par and help draft the next reorder. Want me to start?',
  es: 'Puedo revisar lo que está bajo el nivel ideal y preparar el próximo pedido. ¿Empiezo?',
};
const INVENTORY_MOBILE_PROMPTS = {
  en: [
    {
      label: 'Draft reorder',
      prompt: 'Review the inventory items under par and draft a reorder for the items that need attention now.',
    },
    {
      label: 'Show low stock',
      prompt: 'Show me all inventory items that are currently under par, grouped by urgency.',
    },
  ],
  es: [
    {
      label: 'Preparar pedido',
      prompt: 'Revisa los artículos bajo el nivel ideal y prepara un pedido para los que necesitan atención ahora.',
    },
    {
      label: 'Ver existencias bajas',
      prompt: 'Muéstrame los artículos que están bajo el nivel ideal, agrupados por urgencia.',
    },
  ],
};

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

export function AskStaxisBar() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const pathname = usePathname();
  const onInventory = pathname === '/inventory' || pathname.startsWith('/inventory/');

  const [input, setInput] = useState('');
  const [chatState, setChatState] = useState<ChatState>('empty');
  const [closing, setClosing] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const mobileThreadRef = useRef<HTMLDivElement>(null);
  const mobileSheetRef = useRef<HTMLElement>(null);
  const mobileFabRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const {
    messages,
    conversations,
    streaming,
    error,
    sendMessage,
    loadConversation,
    pendingActions,
    resultCard,
    resolveAction,
    dismissResultCard,
    actionErrors,
  } = useAgentChat({
    propertyId: activePropertyId,
    // Lazily warm the conversation list once the user engages the bar, so the
    // Past-chats sheet is populated by the time they open it.
    active: focused || historyOpen || mobileOpen || chatState !== 'empty',
  });

  const hasText = input.trim().length > 0;
  const idle =
    !hovering && !focused && chatState !== 'active' && !historyOpen && !hasText && !dictating;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scrollBottomSoon = useCallback(() => {
    requestAnimationFrame(() => {
      for (const el of [threadRef.current, mobileThreadRef.current]) {
        if (el) el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

  // Auto-scroll the thread on new content while a conversation is open.
  useEffect(() => {
    if (chatState === 'active') scrollBottomSoon();
  }, [messages, streaming, chatState, scrollBottomSoon]);

  const stopDictation = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    recognitionRef.current = null;
    setDictating(false);
  }, []);

  const submit = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || streaming) return;
    clearCloseTimer();
    setClosing(false);
    setHistoryOpen(false);
    if (recognitionRef.current) stopDictation();
    setChatState('active');
    if (window.matchMedia('(max-width: 760px)').matches) setMobileOpen(true);
    setInput('');
    void sendMessage(text);
  }, [streaming, sendMessage, clearCloseTimer, stopDictation]);

  const openMobile = useCallback(() => {
    setMobileOpen(true);
    setHistoryOpen(false);
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

  // The phone thread is conditionally mounted. Scroll after that mount so
  // reopening a long conversation lands on its newest message, not the top.
  useEffect(() => {
    if (mobileOpen) scrollBottomSoon();
  }, [mobileOpen, scrollBottomSoon]);

  const closeChat = useCallback(() => {
    if (chatState !== 'active' || messages.length === 0) return;
    clearCloseTimer();
    inputRef.current?.blur();
    setChatState('collapsed');   // label swaps to "Continue" instantly
    setClosing(true);            // keep thread mounted so it can slide down
    closeTimerRef.current = setTimeout(() => {
      setClosing(false);
      closeTimerRef.current = null;
    }, 440);
  }, [chatState, messages.length, clearCloseTimer]);

  const reopen = useCallback(() => {
    clearCloseTimer();
    setClosing(false);
    setHistoryOpen(false);
    setChatState('active');
    scrollBottomSoon();
  }, [clearCloseTimer, scrollBottomSoon]);

  const toggleHistory = useCallback(() => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    // Opening Past chats closes the current open conversation by default.
    if (opening && chatState === 'active') closeChat();
  }, [historyOpen, chatState, closeChat]);

  const openPastChat = useCallback(async (id: string) => {
    setHistoryOpen(false);
    clearCloseTimer();
    setClosing(false);
    await loadConversation(id);
    setChatState('active');
    scrollBottomSoon();
  }, [loadConversation, clearCloseTimer, scrollBottomSoon]);

  const toggleDictation = useCallback(() => {
    if (dictating) { stopDictation(); return; }
    setHistoryOpen(false);
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

  // Esc closes the sheet, then the conversation. Outside-click closes both.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mobileOpen) { closeMobile(); return; }
      if (historyOpen) { setHistoryOpen(false); return; }
      if (chatState === 'active') closeChat();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (mobileOpen && mobileSheetRef.current?.contains(e.target as Node)) return;
      if (mobileOpen) return;
      if (dockRef.current && !dockRef.current.contains(e.target as Node)) {
        if (historyOpen) setHistoryOpen(false);
        if (chatState === 'active') closeChat();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [historyOpen, chatState, closeChat, mobileOpen, closeMobile]);

  // A walkthrough (Clicky-style cursor demo) takes over the screen — collapse.
  useEffect(() => {
    const handler = () => { setHistoryOpen(false); closeChat(); };
    window.addEventListener('walkthrough:start', handler);
    return () => window.removeEventListener('walkthrough:start', handler);
  }, [closeChat]);

  // Stop any live dictation if the bar unmounts.
  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch { /* noop */ } }, []);

  // The Concourse hub's hero Ask bar hands its input here over a window
  // event, so there is exactly ONE conversation brain (history, approvals,
  // streaming) no matter which surface the user typed into.
  useEffect(() => {
    const onAsk = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (typeof text === 'string' && text.trim()) submit(text);
    };
    window.addEventListener('staxis:ask', onAsk);
    return () => window.removeEventListener('staxis:ask', onAsk);
  }, [submit]);

  const dockClass = useMemo(() => [
    'asx-dock',
    idle && 'asx-idle',
    chatState === 'active' && 'asx-active',
    chatState === 'collapsed' && 'asx-collapsed',
    hasText && 'asx-has-text',
    historyOpen && 'asx-hist',
  ].filter(Boolean).join(' '), [idle, chatState, hasText, historyOpen]);

  if (!user || !activePropertyId) return null;

  // Keep mounted (chat state persists). On the Concourse hub the hero Ask bar
  // IS the idle surface — the docked capsule only appears there once a
  // conversation is actually going.
  const hidden = pathname === '/home' && idle && messages.length === 0;

  // Typing dots show whenever we're streaming but the latest visible content
  // isn't the assistant's reply yet (initial latency or a tool call in flight).
  const last = messages[messages.length - 1];
  const lastIsAssistantText = !!last && last.role === 'assistant' && !!last.text && !last.toolName;
  const showTyping = streaming && !lastIsAssistantText;

  // Rising dim — a gentle wash the moment the bar wakes (hover/open), deepening
  // and climbing once a conversation is actually going. Chat sits above it (lit).
  const dimOn = !idle && !hidden;
  const chatting = chatState === 'active' && !hidden;
  const dimRise = chatting ? Math.min(100, 55 + messages.length * 16) : 34;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ASX_CSS }} />
      {/* Approval + result cards render via a portal at z-index 10000 — above
          the dock AND the voice overlay (z 9999), so an action card stays
          clickable even while a voice call is up. */}
      <ApprovalOverlay
        pendingActions={pendingActions}
        resultCard={resultCard}
        resolveAction={resolveAction}
        dismissResultCard={dismissResultCard}
        actionErrors={actionErrors}
      />

      {/* Phone surface — the confirmed Concourse design uses one compact FAB
          and a bottom sheet. It shares every message/action with the desktop
          dock above; this is only a responsive presentation, not a second chat. */}
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
                  ? (lang === 'es' ? 'pensando…' : 'thinking…')
                  : onInventory
                    ? (lang === 'es' ? 'en inventario' : 'on inventory')
                    : (lang === 'es' ? 'pensando contigo' : 'thinking with you')}</small>
              </span>
            </div>
            <button type="button" className="asx-mobile-close" onClick={closeMobile} aria-label={lang === 'es' ? 'Cerrar Staxis' : 'Close Staxis'}>
              <CloseX />
            </button>
          </header>

          <div ref={mobileThreadRef} className="asx-mobile-thread" aria-live="polite">
            {messages.length === 0 ? (
              <>
                <div className="asx-mobile-welcome">
                  {(onInventory ? INVENTORY_MOBILE_WELCOME : MOBILE_WELCOME)[lang]}
                </div>
                <div className="asx-mobile-quick" aria-label={lang === 'es' ? 'Sugerencias' : 'Suggestions'}>
                  {(onInventory ? INVENTORY_MOBILE_PROMPTS : MOBILE_PROMPTS)[lang].map((item, index) => (
                    <button
                      key={item.label}
                      type="button"
                      className={index === 0 ? 'asx-mobile-quick-primary' : undefined}
                      onClick={() => submit(item.prompt)}
                    >
                      {item.label}
                    </button>
                  ))}
                  <button type="button" onClick={closeMobile}>{lang === 'es' ? 'Ahora no' : 'Not now'}</button>
                </div>
              </>
            ) : (
              messages.map((message, index) => <Bubble key={index} message={message} />)
            )}
            {showTyping && (
              <div className="asx-typing" aria-label={lang === 'es' ? 'Staxis está pensando' : 'Staxis is thinking'}>
                <i /><i /><i />
              </div>
            )}
            {error && <div className="asx-msg asx-err">{error}</div>}
          </div>

          <div className="asx-mobile-composer">
            <span aria-hidden>✦</span>
            <input
              ref={mobileInputRef}
              value={input}
              placeholder={lang === 'es' ? 'Pregunta o da una orden…' : 'Ask or command…'}
              aria-label={lang === 'es' ? 'Preguntar a Staxis' : 'Ask Staxis'}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(input); }
              }}
            />
            <button
              type="button"
              onClick={() => submit(input)}
              aria-label={lang === 'es' ? 'Enviar' : 'Send'}
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
        aria-label={mobileOpen
          ? (lang === 'es' ? 'Cerrar Staxis' : 'Close Staxis')
          : (lang === 'es' ? 'Preguntar a Staxis' : 'Ask Staxis')}
        aria-expanded={mobileOpen}
        aria-controls="staxis-mobile-sheet"
      >
        {mobileOpen ? <CloseX /> : <span aria-hidden>✦</span>}
      </button>

      <div
        className={`asx-scrim${dimOn ? ' asx-scrim-on' : ''}${chatting ? ' asx-scrim-chat' : ''}`}
        style={{ ['--asx-dimrise']: `${dimRise}%` } as React.CSSProperties}
        aria-hidden
      />
      <div
        ref={dockRef}
        className={dockClass}
        style={hidden ? { display: 'none' } : undefined}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        aria-hidden={hidden}
      >
        {/* Conversation thread — grows upward out of the bar */}
        {(chatState === 'active' || closing) && (
          <div
            ref={threadRef}
            className={`asx-thread ${closing ? 'asx-thread-out' : 'asx-thread-in'}`}
          >
            {messages.map((m, i) => (
              <Bubble key={i} message={m} />
            ))}
            {showTyping && (
              <div className="asx-typing" aria-label="Staxis is thinking">
                <i /><i /><i />
              </div>
            )}
            {error && <div className="asx-msg asx-err">{error}</div>}
          </div>
        )}

        {/* Close conversation (active) */}
        <div className="asx-closerow">
          <button type="button" className="asx-close" onClick={closeChat} title="Close conversation">
            <ChevronDown />
            Close conversation
          </button>
        </div>

        {/* Suggestion chips (before the first message) */}
        {chatState === 'empty' && (
          <div className="asx-chips">
            {SUGGESTIONS[lang].map((s) => (
              <button key={s} type="button" className="asx-chip" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Continue conversation (collapsed) */}
        <div className="asx-resume">
          <button type="button" onClick={reopen} title="Reopen this conversation">
            <ChevronUp />
            Continue conversation{' '}
            <span className="asx-cnt">· {messages.length} message{messages.length === 1 ? '' : 's'}</span>
          </button>
        </div>

        {/* Past chats — pull-up sheet directly above the bar */}
        {historyOpen && (
          <div className="asx-popover asx-history">
            <div className="asx-grab" />
            <div className="asx-pophead">Past chats</div>
            <div className="asx-plist">
              {conversations.length === 0 ? (
                <div className="asx-pempty">No past chats yet</div>
              ) : (
                conversations.map((c) => (
                  <button key={c.id} type="button" className="asx-pchat" onClick={() => openPastChat(c.id)}>
                    <span className="asx-pdot" />
                    <span>
                      <b>{c.title?.trim() || 'Untitled chat'}</b>
                      <small>{formatWhen(c.updatedAt)}</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* The bar */}
        <div
          className="asx-glass"
          onClick={() => { if (idle) inputRef.current?.focus(); }}
        >
          <div className="asx-barrow">
            <span className="asx-sp" aria-hidden>✦</span>
            <input
              ref={inputRef}
              className="asx-input"
              value={input}
              placeholder={dictating ? LISTENING_PLACEHOLDER[lang] : PLACEHOLDER[lang]}
              aria-label="Ask Staxis"
              onChange={(e) => { setInput(e.target.value); setHistoryOpen(false); }}
              onFocus={() => { setFocused(true); setHistoryOpen(false); if (chatState === 'collapsed') reopen(); }}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(input); }
              }}
            />

            <button type="button" className="asx-ico" onClick={toggleHistory} aria-label="See your old chats">
              <span className="asx-tip">See your old chats</span>
              <ClockRewind />
            </button>
            <button
              type="button"
              className={`asx-ico asx-dict${dictating ? ' asx-listening' : ''}`}
              onClick={toggleDictation}
              aria-label="Talk to type"
              aria-pressed={dictating}
            >
              <span className="asx-tip">Speak and it types for you</span>
              <Mic />
            </button>
            <button type="button" className="asx-send" onClick={() => submit(input)} aria-label="Send" title="Send">
              <ArrowUp />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── One message bubble ────────────────────────────────────────────────────
function Bubble({ message: m }: { message: DisplayMessage }) {
  if (m.role === 'user') {
    return <div className="asx-msg asx-u">{m.text}</div>;
  }
  // Render only assistant prose; tool-call / tool-result rows are surfaced as
  // the "thinking" dots, keeping the compact bar clean.
  if (m.role === 'assistant' && m.text && !m.toolName) {
    return (
      <div className="asx-msg asx-a">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p>{children}</p>,
            strong: ({ children }) => <strong>{children}</strong>,
            ul: ({ children }) => <ul>{children}</ul>,
            ol: ({ children }) => <ol>{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            code: ({ children }) => <code>{children}</code>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            ),
          }}
        >
          {m.text}
        </ReactMarkdown>
      </div>
    );
  }
  return null;
}

// ── Relative timestamp for the Past-chats sublines ────────────────────────
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} · ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Inline icons (20×20 viewBox, currentColor) ────────────────────────────
const ICO = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ClockRewind = () => (
  <svg viewBox="0 0 20 20" {...ICO}><path d="M3.2 10a6.8 6.8 0 1 0 2-4.8M3 4.2v3h3" /><path d="M10 6.5V10l2.2 1.6" /></svg>
);
const Mic = () => (
  <svg viewBox="0 0 20 20" {...ICO}><rect x="7.5" y="2.5" width="5" height="9" rx="2.5" /><path d="M5 9a5 5 0 0 0 10 0M10 14v3.2M7.5 17.5h5" /></svg>
);
const ArrowUp = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M10 16V4.5M5 9l5-5 5 5" /></svg>
);
const CloseX = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
);
const ChevronDown = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M2 4l4 4 4-4" /></svg>
);
const ChevronUp = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M2 8l4-4 4 4" /></svg>
);

// ── Scoped styles (everything prefixed asx-) ──────────────────────────────
const ASX_CSS = `
.asx-dock{position:fixed;left:50%;bottom:max(22px,env(safe-area-inset-bottom,22px));transform:translateX(-50%);
  z-index:60;width:min(540px,calc(100vw - 24px));display:flex;flex-direction:column;
  transition:width .28s cubic-bezier(.33,1,.68,1);
  --asx-accent:#3E5C48;--asx-frost:12px;
  --asx-ink:var(--snow-ink,#1F231C);--asx-ink2:var(--snow-ink2,#5C625C);--asx-ink3:var(--snow-ink3,#A6ABA6);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.asx-dock,.asx-dock *{box-sizing:border-box;}
.asx-mobile-fab,.asx-mobile-sheet{display:none;}

/* Rising dim — scrim that fades the page from the bottom up while a chat is open
   and climbs with the conversation. Below the dock (z 60), above the page; never
   blocks clicks; the chat sits above it so it stays lit. NB: keep gradient stops
   plain/single-var — calc(var()*n) inside a stop voids the whole background. */
@property --asx-dimrise{syntax:'<length-percentage>';inherits:false;initial-value:30%;}
.asx-scrim{position:fixed;inset:0;z-index:50;pointer-events:none;opacity:0;transition:opacity .45s ease,--asx-dimrise .45s ease;
  background:linear-gradient(to top, rgba(12,16,14,.82) 0%, transparent var(--asx-dimrise,30%));}
.asx-scrim.asx-scrim-on{opacity:.38;}     /* gentle wash the moment the bar wakes */
.asx-scrim.asx-scrim-chat{opacity:1;}     /* much deeper once a conversation is going */

/* idle: the docked capsule stays visible and breathes — the Concourse glow
   (soft sage halo swelling and warming slightly gold). 520px like the hub's
   hero bar at smaller scale, per the handoff. */
@keyframes asx-breathe{
  0%,100%{box-shadow:0 0 0 0 rgba(158,183,166,.55),0 0 28px rgba(158,183,166,.5);}
  50%{box-shadow:0 0 0 14px rgba(158,183,166,0),0 0 46px rgba(201,150,68,.45);}
}
@keyframes asx-sparkspin{0%,100%{transform:rotate(0) scale(1);}50%{transform:rotate(12deg) scale(1.12);}}
.asx-dock.asx-idle{width:min(520px,calc(100vw - 24px));}
.asx-dock.asx-idle .asx-glass{cursor:text;animation:asx-breathe 4.2s ease-in-out infinite;}
.asx-dock.asx-idle .asx-closerow,.asx-dock.asx-idle .asx-resume{display:none;}
.asx-dock.asx-idle .asx-chips{display:none;}
.asx-dock.asx-hist .asx-chips,.asx-dock.asx-hist .asx-closerow,.asx-dock.asx-hist .asx-resume{display:none;}

.asx-thread{display:flex;flex-direction:column;gap:5px;justify-content:flex-end;padding:0 6px 8px;
  max-height:min(64vh,560px);overflow-y:auto;scrollbar-width:none;}
.asx-thread::-webkit-scrollbar{display:none;}
@keyframes asx-thread-in{from{transform:translateY(18px)}to{transform:none}}
@keyframes asx-thread-out{from{transform:translateY(0);opacity:1}to{transform:translateY(18px);opacity:0}}
.asx-thread-in{animation:asx-thread-in .44s cubic-bezier(.16,1,.3,1);}
.asx-thread-out{animation:asx-thread-out .44s cubic-bezier(.16,1,.3,1) forwards;}

.asx-closerow{display:none;align-items:center;justify-content:center;padding:0 6px 3px;}
.asx-dock.asx-active .asx-closerow{display:flex;}
.asx-close{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--asx-accent);
  cursor:pointer;background:transparent;border:none;padding:6px 8px;transition:opacity .18s;white-space:nowrap;font-family:inherit;}
.asx-close:hover{opacity:.65;}
.asx-close svg{width:12px;height:12px;}

.asx-msg{max-width:75%;padding:8px 13px;font-size:13px;line-height:1.4;border-radius:15px;
  animation:asx-msgin .44s cubic-bezier(.2,1.25,.4,1);}
@keyframes asx-msgin{from{transform:translateY(12px) scale(.985)}to{transform:none}}
.asx-msg.asx-a{align-self:flex-start;color:var(--asx-ink);border-bottom-left-radius:7px;
  background:rgba(255,255,255,.97);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  border:1px solid rgba(20,24,20,.07);
  box-shadow:0 6px 20px -8px rgba(20,30,20,.28);}
.asx-msg.asx-a b,.asx-msg.asx-a strong{color:var(--asx-accent);font-weight:600;}
.asx-msg.asx-a p{margin:0 0 6px;}
.asx-msg.asx-a p:last-child{margin:0;}
.asx-msg.asx-a ul,.asx-msg.asx-a ol{margin:4px 0;padding-left:18px;}
.asx-msg.asx-a li{margin:2px 0;}
.asx-msg.asx-a a{color:var(--asx-accent);text-decoration:underline;}
.asx-msg.asx-a code{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:.9em;
  background:rgba(20,24,20,.05);padding:1px 5px;border-radius:4px;}
.asx-msg.asx-err{align-self:flex-start;color:var(--snow-warm,#B85C3D);border-bottom-left-radius:7px;
  background:rgba(253,244,241,.97);border:1px solid rgba(184,92,61,.28);box-shadow:0 6px 20px -8px rgba(20,30,20,.2);}
.asx-msg.asx-u{align-self:flex-end;color:var(--asx-ink);border-bottom-right-radius:7px;white-space:pre-wrap;word-break:break-word;
  background:color-mix(in srgb,var(--asx-accent) 16%,#fff);
  border:1px solid color-mix(in srgb,var(--asx-accent) 32%,#fff);
  box-shadow:0 6px 20px -8px rgba(20,30,20,.2);}

.asx-typing{align-self:flex-start;display:inline-flex;gap:5px;padding:14px 17px;border-radius:18px;border-bottom-left-radius:7px;
  background:rgba(255,255,255,.95);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(20,24,20,.07);box-shadow:0 6px 20px -8px rgba(20,30,20,.2);}
.asx-typing i{width:6px;height:6px;border-radius:50%;background:var(--asx-ink3);animation:asx-td 1.1s infinite;}
.asx-typing i:nth-child(2){animation-delay:.15s}
.asx-typing i:nth-child(3){animation-delay:.3s}
@keyframes asx-td{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}

.asx-chips{display:flex;gap:8px;padding:0 6px 11px;flex-wrap:nowrap;justify-content:center;
  width:min(540px,calc(100vw - 24px));margin:0 auto;overflow-x:auto;scrollbar-width:none;}
.asx-chips::-webkit-scrollbar{display:none;}
.asx-chip{flex-shrink:0;white-space:nowrap;font-size:12.5px;color:var(--asx-ink2);cursor:pointer;padding:7px 13px;border-radius:999px;font-family:inherit;
  background:rgba(255,255,255,.85);border:1px solid rgba(20,24,20,.07);
  box-shadow:0 4px 14px -8px rgba(20,30,20,.25);transition:color .15s,border-color .15s,transform .15s;}
.asx-chip:hover{color:var(--asx-accent);border-color:color-mix(in srgb,var(--asx-accent) 40%,transparent);transform:translateY(-1px);}

.asx-resume{display:none;justify-content:center;padding:0 6px 3px;}
.asx-dock.asx-collapsed:not(.asx-idle) .asx-resume{display:flex;}
.asx-resume button{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--asx-accent);
  cursor:pointer;background:transparent;border:none;padding:6px 8px;transition:opacity .18s;white-space:nowrap;font-family:inherit;}
.asx-resume button:hover{opacity:.65;}
.asx-resume svg{width:12px;height:12px;}
.asx-resume .asx-cnt{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:11px;color:var(--asx-accent);opacity:.6;}

@keyframes asx-barin{from{transform:translateY(16px)}to{transform:none}}
.asx-glass{position:relative;border-radius:999px;overflow:visible;width:100%;
  animation:asx-barin .42s cubic-bezier(.33,1,.68,1);transition:opacity .28s ease;
  background:rgba(255,255,255,.9);
  backdrop-filter:blur(var(--asx-frost,12px));-webkit-backdrop-filter:blur(var(--asx-frost,12px));
  border:1px solid rgba(92,122,96,.25);
  box-shadow:0 1px 0 rgba(255,255,255,.8) inset,0 8px 26px -16px rgba(20,30,20,.3);}
.asx-barrow{position:relative;z-index:2;display:flex;align-items:center;gap:9px;padding:7px 7px 7px 16px;}
.asx-sp{color:#5C7A60;font-size:14px;flex-shrink:0;filter:drop-shadow(0 1px 1px rgba(255,255,255,.7));line-height:1;
  animation:asx-sparkspin 3.5s ease-in-out infinite;}
.asx-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font-size:13.5px;color:var(--asx-ink);font-family:inherit;}
.asx-input::placeholder{color:var(--asx-ink3);}

.asx-ico{position:relative;width:30px;height:30px;border-radius:50%;border:none;background:transparent;color:var(--asx-ink3);
  cursor:pointer;flex-shrink:0;display:grid;place-items:center;transition:background .18s,color .18s,box-shadow .2s;padding:0;}
.asx-ico:hover{background:color-mix(in srgb,var(--asx-accent) 12%,transparent);color:var(--asx-accent);}
.asx-ico svg{width:15px;height:15px;}
.asx-tip{position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%);white-space:nowrap;
  background:#1A1F1B;color:#fff;font-size:11.5px;font-weight:500;letter-spacing:.01em;padding:6px 10px;border-radius:8px;
  pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 8px 20px -8px rgba(0,0,0,.4);z-index:6;font-family:inherit;}
.asx-tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#1A1F1B;}
.asx-ico:hover .asx-tip{opacity:1;}
.asx-ico.asx-dict.asx-listening{background:var(--asx-accent);color:#fff;animation:asx-micpulse 1.4s ease-in-out infinite;}
@keyframes asx-micpulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--asx-accent) 45%,transparent)}60%{box-shadow:0 0 0 8px transparent}}
.asx-dock.asx-has-text .asx-ico{display:none;}
.asx-send{width:0;height:30px;border-radius:50%;border:none;background:var(--asx-accent);color:#fff;cursor:pointer;flex-shrink:0;
  display:grid;place-items:center;opacity:0;padding:0;overflow:hidden;transition:opacity .2s,width .2s;}
.asx-send svg{width:15px;height:15px;}
.asx-dock.asx-has-text .asx-send{opacity:1;width:30px;}

.asx-popover{display:flex;flex-direction:column;gap:4px;margin:0 auto 9px;width:100%;
  background:rgba(255,255,255,.93);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);
  border:1px solid rgba(20,24,20,.08);border-radius:20px;padding:9px;box-shadow:0 22px 54px -24px rgba(20,30,20,.42);
  animation:asx-popin .3s cubic-bezier(.16,1,.3,1);}
@keyframes asx-popin{from{transform:translateY(8px)}to{transform:none}}
.asx-grab{width:34px;height:4px;border-radius:2px;background:rgba(20,24,20,.18);margin:4px auto 8px;}
.asx-pophead{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--asx-ink3);padding:5px 8px 4px;text-align:center;}
.asx-plist{max-height:236px;overflow-y:auto;scrollbar-width:none;display:flex;flex-direction:column;gap:2px;}
.asx-plist::-webkit-scrollbar{display:none;}
.asx-pchat{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;border:none;background:transparent;cursor:pointer;text-align:left;width:100%;font-family:inherit;}
.asx-pchat:hover{background:color-mix(in srgb,var(--asx-accent) 9%,transparent);}
.asx-pdot{width:7px;height:7px;border-radius:50%;background:var(--asx-accent);flex-shrink:0;}
.asx-pchat b{font-size:13.5px;color:var(--asx-ink);font-weight:600;display:block;}
.asx-pchat small{display:block;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:var(--asx-ink3);margin-top:2px;letter-spacing:.02em;}
.asx-pempty{padding:14px 12px;text-align:center;color:var(--asx-ink3);font-size:12.5px;}

/* ── Confirmed phone shell: compact magic button + flush bottom sheet ── */
@keyframes asx-mobile-sheet-in{from{transform:translateY(100%)}to{transform:translateY(0)}}
@media (max-width:760px){
  .asx-dock,.asx-scrim{display:none!important;}

  .asx-mobile-fab{position:fixed;right:18px;bottom:max(30px,calc(env(safe-area-inset-bottom,0px) + 14px));z-index:72;display:grid;
    width:56px;height:56px;border-radius:18px;border:1px solid rgba(92,122,96,.4);
    background:linear-gradient(150deg,#5C7A60,#3E5C48);color:#fff;cursor:pointer;padding:0;
    place-items:center;box-shadow:0 14px 30px -8px rgba(62,92,72,.6);
    animation:asx-breathe 4.2s ease-in-out infinite;-webkit-tap-highlight-color:transparent;}
  .asx-mobile-fab>span{font-size:24px;line-height:1;animation:asx-sparkspin 3.5s ease-in-out infinite;}
  .asx-mobile-fab>svg{width:20px;height:20px;}
  .asx-mobile-fab:active{transform:scale(.96);}
  .asx-mobile-fab:focus-visible{outline:2px solid #1F231C;outline-offset:3px;}
  .asx-mobile-fab-open{animation:none;}
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
    font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;box-sizing:border-box;}
  .asx-mobile-sheet *{box-sizing:border-box;}
  .asx-mobile-grab{height:12px;display:flex;justify-content:center;padding-top:8px;flex:none;background:#fff;}
  .asx-mobile-grab span{width:38px;height:4px;border-radius:999px;background:rgba(31,35,28,.14);}
  .asx-mobile-head{min-height:61px;padding:9px 9px 9px 15px;display:flex;align-items:center;justify-content:space-between;flex:none;
    background:linear-gradient(135deg,rgba(158,183,166,.26),rgba(158,183,166,.05));
    border-bottom:1px solid rgba(92,122,96,.16);}
  .asx-mobile-id{display:flex;align-items:center;gap:9px;min-width:0;}
  .asx-mobile-spark{width:32px;height:32px;border-radius:11px;display:grid;place-items:center;flex:none;
    background:rgba(92,122,96,.18);color:#3E5C48;font-size:17px;line-height:1;animation:asx-sparkspin 3.5s ease-in-out infinite;}
  .asx-mobile-id>span:last-child{display:flex;flex-direction:column;min-width:0;}
  .asx-mobile-id strong{font-size:14px;line-height:18px;font-weight:600;color:#1F231C;}
  .asx-mobile-id small{display:flex;align-items:center;gap:5px;margin-top:2px;color:#356B4C;
    font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;line-height:12px;font-weight:400;letter-spacing:.06em;}
  .asx-mobile-id small i{width:6px;height:6px;border-radius:50%;background:#5C7A60;flex:none;}
  .asx-mobile-close{width:44px;height:44px;border-radius:50%;border:none;background:transparent;color:#5C625C;cursor:pointer;
    display:grid;place-items:center;padding:0;}
  .asx-mobile-close::before{content:'';position:absolute;width:28px;height:28px;border-radius:50%;background:rgba(31,35,28,.05);z-index:-1;}
  .asx-mobile-close{position:relative;isolation:isolate;}
  .asx-mobile-close svg{width:13px;height:13px;}
  .asx-mobile-close:focus-visible{outline:2px solid #3E5C48;outline-offset:-4px;}

  .asx-mobile-thread{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px;
    background:#FCFDFB;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
  .asx-mobile-thread::-webkit-scrollbar{display:none;}
  .asx-mobile-thread .asx-msg{padding:10px 13px;font-size:13px;line-height:1.5;animation:asx-msgin .34s cubic-bezier(.22,1,.36,1);}
  .asx-mobile-thread .asx-msg.asx-u{align-self:flex-end;max-width:82%;background:#1F231C;color:#fff;border:1px solid #1F231C;
    border-radius:16px 16px 5px 16px;box-shadow:none;}
  .asx-mobile-thread .asx-msg.asx-a{align-self:flex-start;max-width:90%;background:rgba(158,183,166,.16);color:#1F231C;
    border:1px solid rgba(92,122,96,.2);border-radius:16px 16px 16px 5px;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;}
  .asx-mobile-thread .asx-msg.asx-err{align-self:flex-start;max-width:90%;}
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

/* Reduced-motion: keep the essential one-shot motion the design intends (the
   pill expanding into the bar, the slide-up entrance, message reveal) — only
   drop the LOOPING/decorative animations, per the Ask Staxis handoff. */
@media (prefers-reduced-motion: reduce){
  .asx-typing i,.asx-ico.asx-dict.asx-listening{animation:none;}
  .asx-dock.asx-idle .asx-glass,.asx-sp{animation:none;}
  .asx-mobile-sheet,.asx-mobile-fab,.asx-mobile-fab>span,.asx-mobile-spark,.asx-mobile-thread .asx-msg{animation:none;}
}
`;
