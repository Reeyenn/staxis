'use client';

// ─── useAgentChat — shared chat state hook ────────────────────────────────
// Pulls the streaming SSE logic out of the page/panel components so both
// surfaces (the /chat full page and the FloatingChatButton panel) share
// one well-tested implementation. Callers just render the messages array
// and call sendMessage().

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { DisplayMessage } from './MessageList';

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
}

export function useAgentChat({ propertyId, active = true }: UseAgentChatOpts): UseAgentChatReturn {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Index of the assistant bubble we're appending text deltas into. -1 means
  // start a new bubble on the next delta. Kept in a ref so the streaming
  // closure doesn't capture stale state.
  const assistantIndexRef = useRef<number>(-1);

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
      console.error('reloadConversations failed', e);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void reloadConversations();
  }, [active, reloadConversations]);

  const loadConversation = useCallback(async (id: string) => {
    setError(null);
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
      setConversationId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const startNew = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    assistantIndexRef.current = -1;
  }, []);

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
        body: JSON.stringify({
          conversationId,
          propertyId,
          message: text,
        }),
      });

      // The 429 cap-hit / rate-limit response is JSON, not SSE.
      const ct = res.headers.get('content-type') ?? '';
      if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
        const errBody = await res.json().catch(() => null);
        setError(errBody?.error ?? `Request failed: ${res.status}`);
        setStreaming(false);
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
          // Event names: 'text_delta' → 'agent:text-delta', etc. Detail is the
          // full SsePayload.
          if (typeof window !== 'undefined' && payload.type) {
            window.dispatchEvent(
              new CustomEvent(`agent:${payload.type.replace(/_/g, '-')}`, {
                detail: payload,
              }),
            );
          }

          if (payload.type === 'conversation_id' && typeof payload.id === 'string') {
            setConversationId(payload.id);
            void reloadConversations();
          } else if (payload.type === 'text_delta' && typeof payload.delta === 'string') {
            const delta = payload.delta;
            setMessages(prev => {
              const next = [...prev];
              if (assistantIndexRef.current >= 0 && next[assistantIndexRef.current]?.role === 'assistant') {
                next[assistantIndexRef.current] = {
                  ...next[assistantIndexRef.current],
                  text: next[assistantIndexRef.current].text + delta,
                };
              } else {
                assistantIndexRef.current = next.length;
                next.push({ role: 'assistant', text: delta });
              }
              return next;
            });
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
          } else if (payload.type === 'error' && typeof payload.message === 'string') {
            setError(payload.message);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  }, [conversationId, propertyId, streaming, reloadConversations]);

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
  };
}
