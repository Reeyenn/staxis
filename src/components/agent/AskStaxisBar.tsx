'use client';

// ─── AskStaxisBar — global "Ask Staxis" command bar ───────────────────────
// Replaces the legacy bottom-right FloatingChatButton. A calm spark pill at
// rest (bottom-center) that wakes on hover/focus into a 540px "liquid glass"
// bar. Conversations grow UPWARD out of the bar in place — no separate panel
// or page. Type or use voice.
//
// Wiring (the prototype's mock data is replaced with the real brain):
//   • Text + streaming replies  → useAgentChat (/api/agent/command SSE)
//   • Past chats sheet           → useAgentChat.conversations + loadConversation
//   • Call Staxis (phone icon)   → existing VoiceModeOverlay via openVoiceMode()
//   • Talk-to-type (mic icon)    → browser SpeechRecognition (graceful stub if
//                                  unsupported — just shows the listening pulse)
//
// All styling is scoped under `.asx-*` classes injected once below, so it
// can use :hover / ::after / masks / keyframes / color-mix that inline styles
// can't express, without colliding with the app's global CSS.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useVoicePanel } from './VoicePanelContext';
import { useAgentChat } from './useAgentChat';
import { ApprovalOverlay } from './ApprovalOverlay';
import type { DisplayMessage } from './MessageList';

type ChatState = 'empty' | 'active' | 'collapsed';

const COPY = {
  en: {
    askStaxis: 'Ask Staxis',
    placeholder: 'Ask Staxis anything about the property…',
    listeningPlaceholder: 'Listening… speak and it appears here',
    suggestions: [
      'What needs my attention?',
      "Who's behind on rooms?",
      'Should I raise rates?',
    ],
    thinking: 'Staxis is thinking',
    closeConversation: 'Close conversation',
    closeConversationTitle: 'Close conversation',
    continueConversation: 'Continue conversation',
    reopenConversationTitle: 'Reopen this conversation',
    message: 'message',
    messages: 'messages',
    pastChats: 'Past chats',
    noPastChats: 'No past chats yet',
    untitledChat: 'Untitled chat',
    historyLabel: 'See your old chats',
    historyTip: 'See your old chats',
    dictationLabel: 'Talk to type',
    dictationTip: 'Speak and it types for you',
    callLabel: 'Call Staxis',
    callTip: 'Talk to Staxis like a phone call',
    send: 'Send',
    speechUnavailable: 'Voice typing is not available in this browser',
  },
  es: {
    askStaxis: 'Pregúntale a Staxis',
    placeholder: 'Pregúntale a Staxis sobre la propiedad…',
    listeningPlaceholder: 'Escuchando… habla y aparecerá aquí',
    suggestions: [
      '¿Qué necesita mi atención?',
      '¿Quién lleva retraso con las habitaciones?',
      '¿Debería subir las tarifas?',
    ],
    thinking: 'Staxis está pensando',
    closeConversation: 'Cerrar conversación',
    closeConversationTitle: 'Cerrar conversación',
    continueConversation: 'Continuar conversación',
    reopenConversationTitle: 'Volver a abrir esta conversación',
    message: 'mensaje',
    messages: 'mensajes',
    pastChats: 'Chats anteriores',
    noPastChats: 'Aún no hay chats anteriores',
    untitledChat: 'Chat sin título',
    historyLabel: 'Ver tus chats anteriores',
    historyTip: 'Ver tus chats anteriores',
    dictationLabel: 'Dictar mensaje',
    dictationTip: 'Habla y Staxis lo escribe',
    callLabel: 'Llamar a Staxis',
    callTip: 'Habla con Staxis como en una llamada',
    send: 'Enviar',
    speechUnavailable: 'El dictado no está disponible en este navegador',
  },
} as const;

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
  const { lang, locale } = useLang();
  const { activePropertyId } = useProperty();
  const voicePanel = useVoicePanel();
  const copy = COPY[lang];

  const [input, setInput] = useState('');
  const [chatState, setChatState] = useState<ChatState>('empty');
  const [closing, setClosing] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setSpeechSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);

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
    active: focused || historyOpen || chatState !== 'empty',
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

  const wakeInput = useCallback(() => {
    setFocused(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const openCommand = () => wakeInput();
    window.addEventListener('staxis:open-command', openCommand);
    return () => window.removeEventListener('staxis:open-command', openCommand);
  }, [wakeInput]);

  const scrollBottomSoon = useCallback(() => {
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
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
    setInput('');
    void sendMessage(text);
  }, [streaming, sendMessage, clearCloseTimer, stopDictation]);

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

  const startCall = useCallback(() => {
    setHistoryOpen(false);
    if (recognitionRef.current) stopDictation();
    inputRef.current?.blur();
    voicePanel?.openVoiceMode();   // reuse the real ElevenLabs voice surface
  }, [voicePanel, stopDictation]);

  const toggleDictation = useCallback(() => {
    if (dictating) { stopDictation(); return; }
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!Ctor) {
      setSpeechSupported(false);
      setDictating(false);
      inputRef.current?.focus();
      return;
    }

    setHistoryOpen(false);
    setDictating(true);
    inputRef.current?.focus();

    try {
      const rec = new Ctor();
      rec.lang = ({ en: 'en-US', es: 'es-US', ht: 'ht-HT', tl: 'fil-PH', vi: 'vi-VN' } as const)[locale];
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
  }, [dictating, input, stopDictation, locale]);

  // Esc closes the sheet, then the conversation. Outside-click closes both.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (historyOpen) { setHistoryOpen(false); return; }
      if (chatState === 'active') closeChat();
    };
    const onPointerDown = (e: PointerEvent) => {
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
  }, [historyOpen, chatState, closeChat]);

  // A walkthrough (Clicky-style cursor demo) takes over the screen — collapse.
  useEffect(() => {
    const handler = () => { setHistoryOpen(false); closeChat(); };
    window.addEventListener('walkthrough:start', handler);
    return () => window.removeEventListener('walkthrough:start', handler);
  }, [closeChat]);

  // Stop any live dictation if the bar unmounts.
  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch { /* noop */ } }, []);

  const dockClass = useMemo(() => [
    'asx-dock',
    idle && 'asx-idle',
    chatState === 'active' && 'asx-active',
    chatState === 'collapsed' && 'asx-collapsed',
    hasText && 'asx-has-text',
    historyOpen && 'asx-hist',
  ].filter(Boolean).join(' '), [idle, chatState, hasText, historyOpen]);

  if (!user || !activePropertyId || !voicePanel) return null;

  // Keep mounted (chat state persists) but hide while the voice overlay is up,
  // so the two bottom-center surfaces never stack.
  const hidden = voicePanel.voiceModeOpen;

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
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={streaming}
          >
            {messages.map((m, i) => (
              <Bubble key={i} message={m} />
            ))}
            {showTyping && (
              <div className="asx-typing" aria-label={copy.thinking}>
                <i /><i /><i />
              </div>
            )}
            {error && <div className="asx-msg asx-err" role="alert">{error}</div>}
          </div>
        )}

        {/* Close conversation (active) */}
        <div className="asx-closerow">
          <button type="button" className="asx-close" onClick={closeChat} title={copy.closeConversationTitle}>
            <ChevronDown />
            {copy.closeConversation}
          </button>
        </div>

        {/* Suggestion chips (before the first message) */}
        {chatState === 'empty' && (
          <div className="asx-chips">
            {copy.suggestions.map((s) => (
              <button key={s} type="button" className="asx-chip" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Continue conversation (collapsed) */}
        <div className="asx-resume">
          <button type="button" onClick={reopen} title={copy.reopenConversationTitle}>
            <ChevronUp />
            {copy.continueConversation}{' '}
            <span className="asx-cnt">· {messages.length} {messages.length === 1 ? copy.message : copy.messages}</span>
          </button>
        </div>

        {/* Past chats — pull-up sheet directly above the bar */}
        {historyOpen && (
          <div className="asx-popover asx-history">
            <div className="asx-grab" />
            <div className="asx-pophead">{copy.pastChats}</div>
            <div className="asx-plist">
              {conversations.length === 0 ? (
                <div className="asx-pempty">{copy.noPastChats}</div>
              ) : (
                conversations.map((c) => (
                  <button key={c.id} type="button" className="asx-pchat" onClick={() => openPastChat(c.id)}>
                    <span className="asx-pdot" />
                    <span>
                      <b>{c.title?.trim() || copy.untitledChat}</b>
                      <small>{formatWhen(c.updatedAt, lang)}</small>
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
          onClick={() => { if (idle) wakeInput(); }}
          onKeyDown={(e) => {
            if (!idle || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            wakeInput();
          }}
          role={idle ? 'button' : undefined}
          tabIndex={idle ? 0 : -1}
          aria-label={idle ? copy.askStaxis : undefined}
        >
          <div className="asx-barrow">
            <span className="asx-sp" aria-hidden>✦</span>
            <span className="asx-idle-label">{copy.askStaxis}</span>
            <input
              ref={inputRef}
              className="asx-input"
              value={input}
              placeholder={dictating ? copy.listeningPlaceholder : copy.placeholder}
              aria-label={copy.askStaxis}
              onChange={(e) => { setInput(e.target.value); setHistoryOpen(false); }}
              onFocus={() => { setFocused(true); setHistoryOpen(false); if (chatState === 'collapsed') reopen(); }}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(input); }
              }}
            />

            <button type="button" className="asx-ico" onClick={toggleHistory} aria-label={copy.historyLabel}>
              <span className="asx-tip">{copy.historyTip}</span>
              <ClockRewind />
            </button>
            <button
              type="button"
              className={`asx-ico asx-dict${dictating ? ' asx-listening' : ''}`}
              onClick={toggleDictation}
              aria-label={speechSupported ? copy.dictationLabel : copy.speechUnavailable}
              aria-pressed={dictating}
              disabled={!speechSupported}
              title={speechSupported ? copy.dictationLabel : copy.speechUnavailable}
            >
              <span className="asx-tip">{speechSupported ? copy.dictationTip : copy.speechUnavailable}</span>
              <Mic />
            </button>
            <button type="button" className="asx-ico asx-call" onClick={startCall} aria-label={copy.callLabel}>
              <span className="asx-tip">{copy.callTip}</span>
              <Phone />
            </button>

            <button
              type="button"
              className="asx-send"
              onClick={() => submit(input)}
              aria-label={copy.send}
              title={copy.send}
              disabled={!hasText || streaming}
              aria-disabled={!hasText || streaming}
              tabIndex={hasText && !streaming ? 0 : -1}
            >
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
function formatWhen(iso: string, lang: 'en' | 'es'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `${lang === 'es' ? 'Hoy' : 'Today'} · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `${lang === 'es' ? 'Ayer' : 'Yesterday'} · ${time}`;
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return `${d.toLocaleDateString(locale, { weekday: 'short' })} · ${time}`;
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

// ── Inline icons (20×20 viewBox, currentColor) ────────────────────────────
const ICO = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ClockRewind = () => (
  <svg viewBox="0 0 20 20" {...ICO}><path d="M3.2 10a6.8 6.8 0 1 0 2-4.8M3 4.2v3h3" /><path d="M10 6.5V10l2.2 1.6" /></svg>
);
const Mic = () => (
  <svg viewBox="0 0 20 20" {...ICO}><rect x="7.5" y="2.5" width="5" height="9" rx="2.5" /><path d="M5 9a5 5 0 0 0 10 0M10 14v3.2M7.5 17.5h5" /></svg>
);
const Phone = () => (
  <svg viewBox="0 0 20 20" {...ICO}><path d="M6.3 3.4 7.8 6 6.3 7.6a8 8 0 0 0 4.1 4.1L12 10.2l2.6 1.5c.5.3.7.9.5 1.4A3 3 0 0 1 12.2 15 9.2 9.2 0 0 1 3 5.8 3 3 0 0 1 4.9 3c.5-.2 1.1 0 1.4.4Z" /></svg>
);
const ArrowUp = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M10 16V4.5M5 9l5-5 5 5" /></svg>
);
const ChevronDown = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M2 4l4 4 4-4" /></svg>
);
const ChevronUp = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M2 8l4-4 4 4" /></svg>
);

// ── Scoped styles (everything prefixed asx-) ──────────────────────────────
const ASX_CSS = `
.asx-dock{position:fixed;left:50%;bottom:calc(var(--staff-bottom-nav-height,0px) + max(22px,env(safe-area-inset-bottom,22px)));transform:translateX(-50%);
  z-index:60;width:min(540px,calc(100vw - 24px));display:flex;flex-direction:column;
  transition:width .28s cubic-bezier(.33,1,.68,1);
  --asx-accent:#2563EB;--asx-on-accent:#FFFFFF;--asx-frost:12px;
  --asx-ink:var(--snow-ink,#1F231C);--asx-ink2:var(--snow-ink2,#5C625C);--asx-ink3:var(--snow-ink3,#A6ABA6);
  --asx-surface:rgba(255,255,255,.78);--asx-surface-strong:rgba(255,255,255,.97);
  --asx-surface-popover:rgba(255,255,255,.93);--asx-rule:rgba(20,24,20,.08);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.dark .asx-dock{--asx-accent:#91AAFF;--asx-on-accent:#101B3F;--asx-surface:rgba(28,28,30,.84);--asx-surface-strong:rgba(44,44,46,.98);
  --asx-surface-popover:rgba(36,35,40,.96);--asx-rule:rgba(230,224,233,.15);}
.asx-dock,.asx-dock *{box-sizing:border-box;}

/* Rising dim — scrim that fades the page from the bottom up while a chat is open
   and climbs with the conversation. Below the dock (z 60), above the page; never
   blocks clicks; the chat sits above it so it stays lit. NB: keep gradient stops
   plain/single-var — calc(var()*n) inside a stop voids the whole background. */
@property --asx-dimrise{syntax:'<length-percentage>';inherits:false;initial-value:30%;}
.asx-scrim{position:fixed;inset:0;z-index:50;pointer-events:none;opacity:0;transition:opacity .45s ease,--asx-dimrise .45s ease;
  background:linear-gradient(to top, rgba(12,16,14,.82) 0%, transparent var(--asx-dimrise,30%));}
.asx-scrim.asx-scrim-on{opacity:.38;}     /* gentle wash the moment the bar wakes */
.asx-scrim.asx-scrim-chat{opacity:1;}     /* much deeper once a conversation is going */

/* idle: the dock becomes a compact, labeled 44px pill so Staxis stays easy to
   discover while preserving the same hover/focus wake-up behavior. */
.asx-dock.asx-idle{width:max-content;max-width:calc(100vw - 24px);}
.asx-dock.asx-idle .asx-glass{height:44px;overflow:hidden;opacity:.82;cursor:pointer;}
.asx-dock.asx-idle .asx-barrow{padding:0 16px;gap:8px;justify-content:center;align-items:center;height:44px;}
.asx-dock.asx-idle .asx-barrow > :not(.asx-sp):not(.asx-idle-label){display:none;}
.asx-dock.asx-idle .asx-sp{font-size:16px;margin:0;}
.asx-dock.asx-idle .asx-idle-label{display:inline;}
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
.asx-close{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:13.5px;font-weight:600;color:var(--asx-accent);
  cursor:pointer;background:transparent;border:none;padding:8px 12px;transition:opacity .18s;white-space:nowrap;font-family:inherit;}
.asx-close:hover{opacity:.65;}
.asx-close svg{width:12px;height:12px;}

.asx-msg{max-width:75%;padding:8px 13px;font-size:13px;line-height:1.4;border-radius:15px;
  animation:asx-msgin .44s cubic-bezier(.2,1.25,.4,1);}
@keyframes asx-msgin{from{transform:translateY(12px) scale(.985)}to{transform:none}}
.asx-msg.asx-a{align-self:flex-start;color:var(--asx-ink);border-bottom-left-radius:7px;
  background:var(--asx-surface-strong);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  border:1px solid var(--asx-rule);
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
  background:var(--asx-surface-strong);border:1px solid color-mix(in srgb,var(--snow-warm,#B85C3D) 38%,transparent);box-shadow:0 6px 20px -8px rgba(20,30,20,.2);}
.asx-msg.asx-u{align-self:flex-end;color:var(--asx-ink);border-bottom-right-radius:7px;white-space:pre-wrap;word-break:break-word;
  background:color-mix(in srgb,var(--asx-accent) 16%,var(--asx-surface-strong));
  border:1px solid color-mix(in srgb,var(--asx-accent) 32%,var(--asx-surface-strong));
  box-shadow:0 6px 20px -8px rgba(20,30,20,.2);}

.asx-typing{align-self:flex-start;display:inline-flex;gap:5px;padding:14px 17px;border-radius:18px;border-bottom-left-radius:7px;
  background:var(--asx-surface-strong);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid var(--asx-rule);box-shadow:0 6px 20px -8px rgba(20,30,20,.2);}
.asx-typing i{width:6px;height:6px;border-radius:50%;background:var(--asx-ink3);animation:asx-td 1.1s infinite;}
.asx-typing i:nth-child(2){animation-delay:.15s}
.asx-typing i:nth-child(3){animation-delay:.3s}
@keyframes asx-td{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}

.asx-chips{display:flex;gap:8px;padding:0 6px 11px;flex-wrap:nowrap;justify-content:center;
  width:min(540px,calc(100vw - 24px));margin:0 auto;overflow-x:auto;scrollbar-width:none;}
.asx-chips::-webkit-scrollbar{display:none;}
.asx-chip{flex-shrink:0;min-height:44px;white-space:nowrap;font-size:12.5px;color:var(--asx-ink2);cursor:pointer;padding:8px 13px;border-radius:999px;font-family:inherit;
  background:var(--asx-surface);border:1px solid var(--asx-rule);
  box-shadow:0 4px 14px -8px rgba(20,30,20,.25);transition:color .15s,border-color .15s,transform .15s;}
.asx-chip:hover{color:var(--asx-accent);border-color:color-mix(in srgb,var(--asx-accent) 40%,transparent);transform:translateY(-1px);}

.asx-resume{display:none;justify-content:center;padding:0 6px 3px;}
.asx-dock.asx-collapsed:not(.asx-idle) .asx-resume{display:flex;}
.asx-resume button{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:13.5px;font-weight:600;color:var(--asx-accent);
  cursor:pointer;background:transparent;border:none;padding:8px 12px;transition:opacity .18s;white-space:nowrap;font-family:inherit;}
.asx-resume button:hover{opacity:.65;}
.asx-resume svg{width:12px;height:12px;}
.asx-resume .asx-cnt{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:11px;color:var(--asx-accent);opacity:.6;}

@keyframes asx-barin{from{transform:translateY(16px)}to{transform:none}}
.asx-glass{position:relative;border-radius:999px;overflow:visible;width:100%;
  animation:asx-barin .42s cubic-bezier(.33,1,.68,1);transition:opacity .28s ease;
  background:var(--asx-surface);
  backdrop-filter:blur(var(--asx-frost,12px));-webkit-backdrop-filter:blur(var(--asx-frost,12px));
  border:1px solid var(--asx-rule);
  box-shadow:0 1px 0 rgba(255,255,255,.8) inset,0 8px 26px -16px rgba(20,30,20,.3);}
.asx-glass:focus-visible{outline:2px solid var(--asx-accent);outline-offset:3px;}
.asx-glass:focus-within{outline:2px solid var(--asx-accent);outline-offset:3px;}
.asx-barrow{position:relative;z-index:2;display:flex;align-items:center;gap:9px;padding:7px 7px 7px 16px;}
.asx-sp{color:var(--asx-accent);font-size:14px;flex-shrink:0;filter:drop-shadow(0 1px 1px rgba(255,255,255,.7));line-height:1;}
.asx-idle-label{display:none;color:var(--asx-ink);font-size:13.5px;font-weight:600;line-height:20px;white-space:nowrap;}
.asx-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font-size:13.5px;color:var(--asx-ink);font-family:inherit;}
.asx-input::placeholder{color:var(--asx-ink3);}

.asx-ico{position:relative;width:44px;height:44px;border-radius:50%;border:none;background:transparent;color:var(--asx-ink3);
  cursor:pointer;flex-shrink:0;display:grid;place-items:center;transition:background .18s,color .18s,box-shadow .2s;padding:0;}
.asx-ico:hover{background:color-mix(in srgb,var(--asx-accent) 12%,transparent);color:var(--asx-accent);}
.asx-ico:disabled{opacity:.38;cursor:not-allowed;}
.asx-ico svg{width:15px;height:15px;}
.asx-tip{position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%);white-space:nowrap;
  background:#1A1F1B;color:#fff;font-size:11.5px;font-weight:500;letter-spacing:.01em;padding:6px 10px;border-radius:8px;
  pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 8px 20px -8px rgba(0,0,0,.4);z-index:6;font-family:inherit;}
.asx-tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#1A1F1B;}
.asx-ico:hover .asx-tip{opacity:1;}
.asx-ico.asx-call{background:var(--asx-accent);color:var(--asx-on-accent);}
.asx-ico.asx-call:hover{background:var(--asx-accent);color:var(--asx-on-accent);filter:brightness(1.08);}
.asx-ico.asx-dict.asx-listening{background:var(--asx-accent);color:var(--asx-on-accent);animation:asx-micpulse 1.4s ease-in-out infinite;}
@keyframes asx-micpulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--asx-accent) 45%,transparent)}60%{box-shadow:0 0 0 8px transparent}}
.asx-dock.asx-has-text .asx-ico{display:none;}
.asx-send{width:0;height:44px;border-radius:50%;border:none;background:var(--asx-accent);color:var(--asx-on-accent);cursor:pointer;flex-shrink:0;
  display:grid;place-items:center;opacity:0;visibility:hidden;pointer-events:none;padding:0;overflow:hidden;transition:opacity .2s,width .2s;}
.asx-send svg{width:15px;height:15px;}
.asx-dock.asx-has-text .asx-send{opacity:1;visibility:visible;pointer-events:auto;width:44px;}
.asx-send:disabled{opacity:.45;cursor:not-allowed;}

.asx-popover{display:flex;flex-direction:column;gap:4px;margin:0 auto 9px;width:100%;
  background:var(--asx-surface-popover);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);
  border:1px solid var(--asx-rule);border-radius:20px;padding:9px;box-shadow:0 22px 54px -24px rgba(20,30,20,.42);
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

@media (prefers-reduced-motion: reduce){
  .asx-dock,.asx-scrim,.asx-thread,.asx-msg,.asx-glass,.asx-chip,.asx-popover,
  .asx-typing i,.asx-ico,.asx-send,.asx-ico.asx-dict.asx-listening{animation:none!important;transition:none!important;transform:none!important;}
}
`;
