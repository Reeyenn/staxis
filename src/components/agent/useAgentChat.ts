'use client';

// ─── useAgentChat — shared chat state hook ────────────────────────────────
// Pulls the streaming SSE logic out of the page/panel components so both
// surfaces (the /chat full page and the FloatingChatButton panel) share
// one well-tested implementation. Callers just render the messages array
// and call sendMessage().

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import type { DisplayMessage } from './MessageList';
import type { BiText, PendingAction, PendingAddon, ResultCard } from './approval-types';

export interface ConversationListItem {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface UseAgentChatOpts {
  /** The user's active property. Required — the agent is property-scoped. */
  propertyId: string | null;
  /** Whether the chat is currently focused / visible (for refetching nudges, etc.). */
  active?: boolean;
}

export interface UseAgentChatReturn {
  messages: DisplayMessage[];
  conversations: ConversationListItem[];
  conversationId: string | null;
  streaming: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  startNew: () => void;
  loadConversation: (id: string) => Promise<void>;
  reloadConversations: () => Promise<void>;
  /** Approval cards queued for the user's decision (one shown at a time). */
  pendingActions: PendingAction[];
  /** The result-confirmation card currently showing (auto-dismissed on success). */
  resultCard: ResultCard | null;
  /** Approve / deny a pending action. Consumes the resume SSE stream. */
  resolveAction: (
    pendingActionId: string,
    decision: 'approve' | 'deny',
    opts?: { adjustedArgs?: Record<string, unknown>; addons?: string[] },
  ) => Promise<void>;
  /** Dismiss the current result card (used by the failure card's close button). */
  dismissResultCard: () => void;
  /** Per-card inline validation errors (keyed by pendingActionId). Set when an
   *  Adjust edit fails server validation — the card stays up so the user can
   *  fix it. */
  actionErrors: Record<string, string>;
}

interface ServerMessage {
  role: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  result?: unknown;
}

interface ServerConversationDetail {
  id: string;
  title: string | null;
  messages?: ServerMessage[];
}

/** A rehydrated pending card from the conversation-detail load path. Same shape
 *  as the tool_call_pending_approval SSE event (bilingual summary + addons). */
interface ServerPendingAction {
  pendingActionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  tier: 'quick' | 'card';
  summary?: BiText;
  addons?: { en: PendingAddon[]; es: PendingAddon[] };
}

interface ServerConversationListItem {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface SsePayload {
  type: string;
  id?: string;
  delta?: string;
  call?: { id: string; name: string; args: Record<string, unknown> };
  result?: unknown;
  isError?: boolean;
  message?: string;
  // ── approval-flow fields ──
  pendingActionId?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  tier?: 'quick' | 'card';
  summary?: BiText;
  addons?: { en: { id: string; label: string }[]; es: { id: string; label: string }[] };
  // action_result
  ok?: boolean;
  denied?: boolean;
  resultSummary?: BiText;
  error?: { en: string | null; es: string | null };
  addonNotes?: string[];
  addonErrors?: string[];
  // pending_actions_superseded
  pendingActionIds?: string[];
}

export function useAgentChat({ propertyId, active = true }: UseAgentChatOpts): UseAgentChatReturn {
  const { lang } = useLang();
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [resultCard, setResultCard] = useState<ResultCard | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  // Language in a ref so the SSE closure resolves bilingual payloads with the
  // current language without re-creating sendMessage on every language change.
  const langRef = useRef(lang);
  langRef.current = lang;

  // Index of the assistant bubble we're appending text deltas into. -1 means
  // start a new bubble on the next delta. Kept in a ref so the streaming
  // closure doesn't capture stale state.
  const assistantIndexRef = useRef<number>(-1);

  // ── Streamed-text flush buffer (perf) ──────────────────────────────────
  // Naively calling setMessages per text_delta clones the whole messages array
  // on every token → O(n²) re-renders on a long reply. We buffer incoming
  // deltas in a ref and flush at most once per animation frame, so a burst of
  // tokens becomes ONE state update. flushDeltaBuffer must run before any other
  // event that reads/mutates messages, and once more at stream end.
  const deltaBufRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  const flushDeltaBuffer = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const chunk = deltaBufRef.current;
    if (!chunk) return;
    deltaBufRef.current = '';
    setMessages(prev => {
      const next = [...prev];
      if (assistantIndexRef.current >= 0 && next[assistantIndexRef.current]?.role === 'assistant') {
        next[assistantIndexRef.current] = {
          ...next[assistantIndexRef.current],
          text: next[assistantIndexRef.current].text + chunk,
        };
      } else {
        assistantIndexRef.current = next.length;
        next.push({ role: 'assistant', text: chunk });
      }
      return next;
    });
  }, []);

  const enqueueDelta = useCallback((delta: string) => {
    deltaBufRef.current += delta;
    if (rafRef.current === null && typeof requestAnimationFrame !== 'undefined') {
      rafRef.current = requestAnimationFrame(() => { rafRef.current = null; flushDeltaBuffer(); });
    } else if (typeof requestAnimationFrame === 'undefined') {
      // Non-browser (SSR / test) — flush synchronously.
      flushDeltaBuffer();
    }
  }, [flushDeltaBuffer]);

  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  // Auto-dismiss timer for the success result card.
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearResultTimer = useCallback(() => {
    if (resultTimerRef.current) { clearTimeout(resultTimerRef.current); resultTimerRef.current = null; }
  }, []);
  const dismissResultCard = useCallback(() => {
    clearResultTimer();
    setResultCard(null);
  }, [clearResultTimer]);
  useEffect(() => () => clearResultTimer(), [clearResultTimer]);

  const pick = useCallback((b: BiText | undefined): string => {
    if (!b) return '';
    return langRef.current === 'es' ? (b.es || b.en) : (b.en || b.es);
  }, []);

  const reloadConversations = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/agent/conversations');
      if (!res.ok) return;
      const body = await res.json();
      const list: ConversationListItem[] = (body.data?.conversations ?? []).map((c: ServerConversationListItem) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
      }));
      setConversations(list);
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
      console.error('reloadConversations failed', e);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void reloadConversations();
  }, [active, reloadConversations]);

  const loadConversation = useCallback(async (id: string) => {
    setError(null);
    setPendingActions([]);
    setActionErrors({});
    dismissResultCard();
    try {
      const res = await fetchWithAuth(`/api/agent/conversations/${id}`);
      if (!res.ok) {
        setError(`Failed to load conversation: ${res.status}`);
        return;
      }
      const body = await res.json();
      const convo: ServerConversationDetail | undefined = body.data?.conversation;
      if (!convo) return;

      const display: DisplayMessage[] = [];
      for (const m of convo.messages ?? []) {
        if (m.role === 'user') {
          display.push({ role: 'user', text: m.content ?? '' });
        } else if (m.role === 'assistant') {
          if (m.content) display.push({ role: 'assistant', text: m.content });
        } else if (m.role === 'tool') {
          display.push({ role: 'tool', text: '', toolResult: m.result });
        }
      }
      setMessages(display);

      // Rehydrate approval cards still awaiting a decision. The DB pending rows
      // outlive React state — without this a reload / conversation switch loses
      // the card while the turn hangs until the 10-min TTL. Language-resolve the
      // addon list here (same as the SSE path) so the card renders identically.
      const rawPending: ServerPendingAction[] = body.data?.pendingActions ?? [];
      const rehydrated: PendingAction[] = rawPending.map((p) => ({
        pendingActionId: p.pendingActionId,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args ?? {},
        tier: p.tier === 'quick' ? 'quick' : 'card',
        summary: p.summary ?? { en: '', es: '' },
        addons: (p.addons ? (langRef.current === 'es' ? p.addons.es : p.addons.en) : []) ?? [],
      }));
      setPendingActions(rehydrated);
      setConversationId(id);
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dismissResultCard]);

  const startNew = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setPendingActions([]);
    setActionErrors({});
    dismissResultCard();
    assistantIndexRef.current = -1;
  }, [dismissResultCard]);

  // ── Shared SSE consumer ────────────────────────────────────────────────
  // Reads an SSE Response from either /api/agent/command (a fresh turn) or
  // .../resolve-action (an approval resume). Handles every event type the two
  // routes emit, including the approval-flow additions.
  const consumeStream = useCallback(async (res: Response): Promise<void> => {
    // The 429 cap-hit / rate-limit / validation responses are JSON, not SSE.
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
      const errBody = await res.json().catch(() => null);
      const friendly = errBody?.code === 'auth_unavailable'
        ? 'Sign-in service is temporarily unavailable. Try again in a moment.'
        : (errBody?.error ?? `Request failed: ${res.status}`);
      setError(friendly);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const ev of events) {
        const line = ev.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let payload: SsePayload;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        // Side channel for non-chat observers (walkthrough overlay, voice TTS).
        // Each SSE event is mirrored as a window CustomEvent so components
        // mounted outside the hook can listen without forking the stream.
        // NOTE: mutation tools no longer emit tool_call_started inline (they go
        // through the approval flow), so the walkthrough overlay's
        // agent:tool-call-started listener only ever fires for read-only tools
        // like walk_user_through — exactly what it wants.
        if (typeof window !== 'undefined' && payload.type) {
          window.dispatchEvent(
            new CustomEvent(`agent:${payload.type.replace(/_/g, '-')}`, {
              detail: payload,
            }),
          );
        }

        // Any event OTHER than a text delta reads or resets the message list /
        // assistant-bubble index, so flush buffered deltas first — otherwise
        // tokens could land in the wrong bubble (or after an index reset).
        if (payload.type !== 'text_delta') flushDeltaBuffer();

        if (payload.type === 'conversation_id' && typeof payload.id === 'string') {
          setConversationId(payload.id);
          void reloadConversations();
        } else if (payload.type === 'text_delta' && typeof payload.delta === 'string') {
          // Buffered — coalesced into ~one setMessages per animation frame.
          enqueueDelta(payload.delta);
        } else if (payload.type === 'tool_call_started' && payload.call) {
          const call = payload.call;
          setMessages(prev => [
            ...prev,
            { role: 'assistant', text: '', toolName: call.name, toolArgs: call.args },
          ]);
          assistantIndexRef.current = -1;
        } else if (payload.type === 'tool_call_finished') {
          setMessages(prev => [
            ...prev,
            { role: 'tool', text: '', toolResult: payload.result, isError: Boolean(payload.isError) },
          ]);
          assistantIndexRef.current = -1;
        } else if (payload.type === 'tool_call_pending_approval' && payload.pendingActionId) {
          // A proposed mutation — queue an approval card.
          const addonList = payload.addons ? (langRef.current === 'es' ? payload.addons.es : payload.addons.en) : [];
          const card: PendingAction = {
            pendingActionId: payload.pendingActionId,
            toolCallId: payload.toolCallId ?? '',
            toolName: payload.toolName ?? '',
            args: payload.args ?? {},
            tier: payload.tier === 'quick' ? 'quick' : 'card',
            summary: payload.summary ?? { en: '', es: '' },
            addons: addonList ?? [],
          };
          setPendingActions(prev => (prev.some(p => p.pendingActionId === card.pendingActionId) ? prev : [...prev, card]));
          assistantIndexRef.current = -1;
        } else if (payload.type === 'pending_actions_superseded') {
          // A new user message abandoned earlier proposals — the server expired
          // them. Drop any still-displayed cards for them so the user can't
          // approve a stale action.
          const dropped = new Set(payload.pendingActionIds ?? []);
          if (dropped.size > 0) {
            setPendingActions(prev => prev.filter(p => !dropped.has(p.pendingActionId)));
          }
        } else if (payload.type === 'action_result' && payload.pendingActionId) {
          // A decision resolved — show the result confirmation card.
          const denied = payload.denied === true;
          const okResult = payload.ok === true;
          const card: ResultCard = {
            pendingActionId: payload.pendingActionId,
            toolName: payload.toolName ?? '',
            ok: okResult,
            denied,
            summary: pick(payload.resultSummary),
            error: payload.error ? pick({ en: payload.error.en ?? '', es: payload.error.es ?? '' }) : null,
            addonNotes: payload.addonNotes ?? [],
          };
          clearResultTimer();
          setResultCard(card);
          // Success (and denials) auto-dismiss; failures stay until dismissed.
          if (okResult) {
            resultTimerRef.current = setTimeout(() => setResultCard(null), 2500);
          }
          assistantIndexRef.current = -1;
        } else if (payload.type === 'error' && typeof payload.message === 'string') {
          setError(payload.message);
        }
      }
    }
    // Flush any tokens still buffered when the stream ends.
    flushDeltaBuffer();
  }, [reloadConversations, pick, clearResultTimer, enqueueDelta, flushDeltaBuffer]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming || !propertyId) return;
    setError(null);
    setStreaming(true);
    assistantIndexRef.current = -1;

    setMessages(prev => [...prev, { role: 'user', text }]);

    try {
      const res = await fetchWithAuth('/api/agent/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, propertyId, message: text }),
      });
      await consumeStream(res);
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error pill
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  }, [conversationId, propertyId, streaming, consumeStream]);

  // ── Approve / deny a pending action ────────────────────────────────────
  const resolveAction = useCallback(async (
    pendingActionId: string,
    decision: 'approve' | 'deny',
    opts?: { adjustedArgs?: Record<string, unknown>; addons?: string[] },
  ) => {
    if (!propertyId) return;
    setError(null);
    setStreaming(true);
    assistantIndexRef.current = -1;
    try {
      const res = await fetchWithAuth('/api/agent/command/resolve-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: propertyId,
          pendingActionId,
          decision,
          adjustedArgs: opts?.adjustedArgs,
          addons: opts?.addons,
        }),
      });

      // An invalid Adjust edit comes back as a 400 JSON (code 'invalid_edit')
      // WITHOUT consuming the pending row — the card stays up. Surface the field
      // error inline on that card and keep it displayed so the user can fix it.
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 400 && ct.includes('application/json')) {
        const errBody = await res.json().catch(() => null);
        if (errBody?.code === 'invalid_edit') {
          setActionErrors(prev => ({ ...prev, [pendingActionId]: errBody.error ?? 'That edit isn\'t valid.' }));
          return;
        }
        // Any other 400 — fall through to the shared error handling.
        setError(errBody?.error ?? `Request failed: ${res.status}`);
        setPendingActions(prev => prev.filter(p => p.pendingActionId !== pendingActionId));
        return;
      }

      // Valid decision — the row is committed server-side. Remove the card (and
      // clear any stale inline error) so the user can't double-tap, then consume
      // the resume stream.
      setPendingActions(prev => prev.filter(p => p.pendingActionId !== pendingActionId));
      setActionErrors(prev => {
        if (!(pendingActionId in prev)) return prev;
        const next = { ...prev }; delete next[pendingActionId]; return next;
      });
      await consumeStream(res);
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  }, [propertyId, consumeStream]);

  return {
    messages,
    conversations,
    conversationId,
    streaming,
    error,
    sendMessage,
    startNew,
    loadConversation,
    reloadConversations,
    pendingActions,
    resultCard,
    resolveAction,
    dismissResultCard,
    actionErrors,
  };
}
