'use client';

// ─── Minimal /chat test surface ───────────────────────────────────────────
// Functional bare-bones UI for testing the agent layer end-to-end. This is
// the "developer harness" — Reeyen explicitly said don't worry about UI;
// Claude Design replaces this with the polished chat surface later.
//
// What it does:
//   - Text input + send to /api/agent/command
//   - Streams SSE response and renders deltas as they arrive
//   - Lists past conversations in a sidebar (click to load)
//   - "New chat" button starts a fresh conversation
//   - Shows tool calls inline so we can see what the agent is doing

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';

interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  isError?: boolean;
}

interface ConversationListItem {
  id: string;
  title: string | null;
  updated_at: string;
}

export default function ChatPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propertyLoading } = useProperty();

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever messages change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Load conversation list on mount.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/conversations');
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        const list = (body.data?.conversations ?? []).map((c: { id: string; title: string | null; updatedAt: string }) => ({
          id: c.id,
          title: c.title,
          updated_at: c.updatedAt,
        }));
        setConversations(list);
      } catch (e) {
        console.error('failed to load conversations', e);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Load a specific conversation when the user clicks one in the sidebar.
  const loadConversation = async (id: string) => {
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/agent/conversations/${id}`);
      if (!res.ok) {
        setError(`Failed to load conversation: ${res.status}`);
        return;
      }
      const body = await res.json();
      const convo = body.data?.conversation;
      if (!convo) return;
      const display: DisplayMessage[] = [];
      for (const m of convo.messages ?? []) {
        if (m.role === 'user') display.push({ role: 'user', text: m.content });
        else if (m.role === 'assistant') {
          if (m.content) display.push({ role: 'assistant', text: m.content });
          for (const tc of m.toolCalls ?? []) {
            display.push({
              role: 'assistant',
              text: '',
              toolName: tc.name,
              toolArgs: tc.args,
            });
          }
        } else if (m.role === 'tool') {
          display.push({
            role: 'tool',
            text: '',
            toolResult: m.result,
          });
        }
      }
      setMessages(display);
      setConversationId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startNewChat = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
  };

  const sendMessage = async () => {
    if (!input.trim() || streaming || !activePropertyId) return;
    const message = input.trim();
    setInput('');
    setError(null);
    setStreaming(true);

    setMessages(prev => [...prev, { role: 'user', text: message }]);

    try {
      const res = await fetchWithAuth('/api/agent/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          propertyId: activePropertyId,
          message,
        }),
      });
      if (!res.ok || !res.body) {
        setError(`Request failed: ${res.status}`);
        setStreaming(false);
        return;
      }

      // We add an empty assistant message to append text deltas into.
      let assistantIndex = -1;
      setMessages(prev => {
        assistantIndex = prev.length;
        return [...prev, { role: 'assistant', text: '' }];
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE format: events separated by blank line. Each event has data: <json>
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const ev of events) {
          const line = ev.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let payload: { type: string; [k: string]: unknown };
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          if (payload.type === 'conversation_id') {
            const id = payload.id as string;
            setConversationId(id);
            // Refresh sidebar to include the new convo.
            fetchWithAuth('/api/agent/conversations').then(async r => {
              if (!r.ok) return;
              const b = await r.json();
              const list = (b.data?.conversations ?? []).map((c: { id: string; title: string | null; updatedAt: string }) => ({
                id: c.id, title: c.title, updated_at: c.updatedAt,
              }));
              setConversations(list);
            }).catch(() => {});
          } else if (payload.type === 'text_delta') {
            const delta = payload.delta as string;
            setMessages(prev => {
              const next = [...prev];
              if (assistantIndex >= 0 && next[assistantIndex]?.role === 'assistant') {
                next[assistantIndex] = {
                  ...next[assistantIndex],
                  text: next[assistantIndex].text + delta,
                };
              }
              return next;
            });
          } else if (payload.type === 'tool_call_started') {
            const call = payload.call as { name: string; args: Record<string, unknown> };
            setMessages(prev => [
              ...prev,
              { role: 'assistant', text: '', toolName: call.name, toolArgs: call.args },
            ]);
            // Reset assistant index so subsequent text deltas append to a new bubble.
            setMessages(prev => {
              assistantIndex = -1;
              return prev;
            });
          } else if (payload.type === 'tool_call_finished') {
            setMessages(prev => [
              ...prev,
              { role: 'tool', text: '', toolResult: payload.result, isError: payload.isError as boolean },
            ]);
            // Start a new assistant bubble for the post-tool text.
            setMessages(prev => {
              assistantIndex = prev.length;
              return [...prev, { role: 'assistant', text: '' }];
            });
          } else if (payload.type === 'error') {
            setError(String(payload.message));
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  };

  if (authLoading || propertyLoading) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }
  if (!user) {
    return <div style={{ padding: 20 }}>Please sign in to use the chat.</div>;
  }
  if (!activePropertyId) {
    return <div style={{ padding: 20 }}>Select a property to start chatting.</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'monospace', fontSize: 14 }}>
      {/* Sidebar: conversation list */}
      <aside
        style={{
          width: 260,
          borderRight: '1px solid #ddd',
          padding: 12,
          overflowY: 'auto',
          background: '#fafafa',
        }}
      >
        <button
          onClick={startNewChat}
          style={{
            width: '100%',
            padding: 8,
            marginBottom: 12,
            cursor: 'pointer',
            background: '#000',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
          }}
        >
          + New chat
        </button>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Recent</div>
        {conversations.length === 0 && (
          <div style={{ color: '#999', fontSize: 12 }}>No conversations yet.</div>
        )}
        {conversations.map(c => (
          <div
            key={c.id}
            onClick={() => loadConversation(c.id)}
            style={{
              padding: 6,
              marginBottom: 4,
              cursor: 'pointer',
              background: c.id === conversationId ? '#e8e8ff' : 'transparent',
              borderRadius: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
            }}
            title={c.title ?? '(untitled)'}
          >
            {c.title ?? '(untitled)'}
          </div>
        ))}
      </aside>

      {/* Main chat area */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #ddd', fontSize: 12, color: '#666' }}>
          Staxis chat — role: {user.role} — property: {activePropertyId}
        </div>
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {messages.length === 0 && (
            <div style={{ color: '#999', fontStyle: 'italic' }}>
              Type something to start. Try &quot;what&apos;s today&apos;s status&quot; or &quot;mark room 102 clean&quot;.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              {m.role === 'user' && (
                <div>
                  <strong>You:</strong> {m.text}
                </div>
              )}
              {m.role === 'assistant' && m.text && (
                <div>
                  <strong>Staxis:</strong> {m.text}
                </div>
              )}
              {m.role === 'assistant' && m.toolName && (
                <div style={{ color: '#666', fontSize: 12 }}>
                  → calling tool <code>{m.toolName}</code>(
                  {Object.entries(m.toolArgs ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})
                </div>
              )}
              {m.role === 'tool' && (
                <div style={{ color: m.isError ? '#c00' : '#080', fontSize: 12 }}>
                  ← tool result: {JSON.stringify(m.toolResult)}
                </div>
              )}
            </div>
          ))}
          {streaming && <div style={{ color: '#999', fontSize: 12 }}>…</div>}
          {error && <div style={{ color: '#c00', marginTop: 8 }}>Error: {error}</div>}
        </div>
        <div style={{ borderTop: '1px solid #ddd', padding: 12, display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Type a message…"
            disabled={streaming}
            style={{
              flex: 1,
              padding: 8,
              border: '1px solid #ccc',
              borderRadius: 4,
              fontFamily: 'inherit',
              fontSize: 14,
            }}
          />
          <button
            onClick={sendMessage}
            disabled={streaming || !input.trim()}
            style={{
              padding: '8px 16px',
              cursor: streaming || !input.trim() ? 'default' : 'pointer',
              opacity: streaming || !input.trim() ? 0.5 : 1,
              background: '#000',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
            }}
          >
            Send
          </button>
        </div>
      </main>
    </div>
  );
}
