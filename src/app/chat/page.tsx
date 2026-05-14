'use client';

// ─── /chat — polished full-page chat surface ──────────────────────────────
// Snow design system: paper-white canvas, sage/caramel accents, Geist +
// Instrument Serif fonts. Conversation history sidebar on the left,
// messages in the center, input pinned to bottom.
//
// Built as the "deep session" surface. The FloatingChatButton handles
// quick asks from any other page; this is for sustained sessions where
// the user wants room for charts/tables/history.
//
// Claude Design will refine the visual treatment later — the structure
// is the lasting part.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { Plus, Send, Trash2 } from 'lucide-react';
import { MessageList } from '@/components/agent/MessageList';
import { useAgentChat } from '@/components/agent/useAgentChat';
import { VoiceButton } from '@/components/agent/VoiceButton';
import { fetchWithAuth } from '@/lib/api-fetch';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sage:     'var(--snow-sage, #9EB7A6)',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

export default function ChatPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propertyLoading } = useProperty();
  const {
    messages,
    conversations,
    conversationId,
    streaming,
    error,
    sendMessage,
    startNew,
    loadConversation,
    reloadConversations,
  } = useAgentChat({ propertyId: activePropertyId, active: true });

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const text = input.trim();
    setInput('');
    await sendMessage(text);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    const res = await fetchWithAuth(`/api/agent/conversations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (id === conversationId) startNew();
      void reloadConversations();
    }
  };

  if (authLoading || propertyLoading) {
    return (
      <div style={{
        minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.bg, color: C.ink3, fontFamily: FONT_SANS, fontSize: 14,
      }}>
        Loading…
      </div>
    );
  }
  if (!user) {
    return (
      <div style={{
        minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.bg, color: C.ink, fontFamily: FONT_SANS, fontSize: 14,
      }}>
        Please sign in to use the chat.
      </div>
    );
  }
  if (!activePropertyId) {
    return (
      <div style={{
        minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.bg, color: C.ink, fontFamily: FONT_SANS, fontSize: 14,
      }}>
        Select a property to start chatting.
      </div>
    );
  }

  return (
    <div style={{
      height: 'calc(100vh - 64px)',
      display: 'flex',
      background: C.bg,
      borderTop: `1px solid ${C.rule}`,
    }}>
      {/* ── Sidebar ── */}
      <aside style={{
        width: 280,
        borderRight: `1px solid ${C.rule}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{ padding: '20px 20px 12px' }}>
          <div style={{
            fontFamily: FONT_SERIF,
            fontSize: 28,
            lineHeight: 1,
            color: C.ink,
            letterSpacing: '-0.01em',
          }}>
            Staxis
          </div>
          <div style={{
            marginTop: 4,
            fontFamily: FONT_MONO,
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: C.ink3,
          }}>
            Chat
          </div>
        </div>

        <div style={{ padding: '0 12px 12px' }}>
          <button
            onClick={startNew}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontFamily: FONT_SANS,
              fontSize: 13,
              fontWeight: 500,
              color: 'white',
              background: C.ink,
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Plus size={14} strokeWidth={2.5} /> New conversation
          </button>
        </div>

        <div style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: C.ink3,
          padding: '4px 20px 8px',
        }}>
          Recent
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 16px' }}>
          {conversations.length === 0 && (
            <div style={{
              padding: '8px 12px',
              color: C.ink3,
              fontFamily: FONT_SANS,
              fontSize: 13,
            }}>
              No conversations yet.
            </div>
          )}
          {conversations.map(c => (
            <div
              key={c.id}
              onClick={() => loadConversation(c.id)}
              onMouseEnter={(e) => {
                if (c.id !== conversationId) e.currentTarget.style.background = C.ruleSoft;
              }}
              onMouseLeave={(e) => {
                if (c.id !== conversationId) e.currentTarget.style.background = 'transparent';
              }}
              style={{
                position: 'relative',
                padding: '8px 32px 8px 12px',
                marginBottom: 2,
                cursor: 'pointer',
                borderRadius: 6,
                fontFamily: FONT_SANS,
                fontSize: 13,
                color: c.id === conversationId ? C.ink : C.ink2,
                background: c.id === conversationId ? C.ruleSoft : 'transparent',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
              }}
              title={c.title ?? '(untitled)'}
            >
              {c.title ?? '(untitled)'}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(c.id);
                }}
                aria-label="Delete"
                style={{
                  position: 'absolute',
                  right: 6,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.ink3,
                  padding: 4,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  opacity: 0.7,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--snow-warm, #B85C3D)'; e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = C.ink3; e.currentTarget.style.opacity = '0.7'; }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        <div style={{
          borderTop: `1px solid ${C.rule}`,
          padding: '10px 20px',
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: C.ink3,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          Role: {user.role}
        </div>
      </aside>

      {/* ── Main chat area ── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          ref={scrollRef}
          style={{ flex: 1, overflowY: 'auto', scrollBehavior: 'smooth' }}
        >
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px' }}>
            <MessageList messages={messages} streaming={streaming} />
            {error && (
              <div style={{
                margin: '8px 0 16px',
                padding: '10px 14px',
                background: 'rgba(184, 92, 61, 0.08)',
                border: '1px solid rgba(184, 92, 61, 0.20)',
                borderRadius: 8,
                color: 'var(--snow-warm, #B85C3D)',
                fontFamily: FONT_SANS,
                fontSize: 13,
              }}>
                {error}
              </div>
            )}
          </div>
        </div>

        {/* ── Composer ── */}
        <div style={{
          borderTop: `1px solid ${C.rule}`,
          padding: '14px 24px 20px',
          background: C.bg,
        }}>
          <div style={{ maxWidth: 760, margin: '0 auto', position: 'relative' }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Ask Staxis…"
              disabled={streaming}
              rows={1}
              style={{
                width: '100%',
                resize: 'none',
                padding: '14px 50px 14px 16px',
                fontFamily: FONT_SANS,
                fontSize: 14,
                lineHeight: 1.5,
                color: C.ink,
                background: C.bg,
                border: `1px solid ${C.rule}`,
                borderRadius: 12,
                outline: 'none',
                minHeight: 48,
                maxHeight: 200,
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.sageDeep; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.rule; }}
            />
            <div style={{
              position: 'absolute',
              right: 10,
              bottom: 10,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            }}>
              <VoiceButton
                propertyId={activePropertyId}
                conversationId={conversationId}
                size="small"
                disabled={streaming}
                onTranscript={async (text) => { await sendMessage(text); }}
              />
              <button
                onClick={handleSend}
                disabled={streaming || !input.trim()}
                aria-label="Send"
                style={{
                  width: 30, height: 30,
                  borderRadius: 8,
                  border: 'none',
                  cursor: streaming || !input.trim() ? 'default' : 'pointer',
                  background: streaming || !input.trim() ? C.rule : C.ink,
                  color: streaming || !input.trim() ? C.ink3 : 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.12s ease',
                }}
              >
                <Send size={14} strokeWidth={2.5} />
              </button>
            </div>
          </div>
          <div style={{
            maxWidth: 760,
            margin: '8px auto 0',
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: C.ink3,
            textAlign: 'center',
            letterSpacing: '0.04em',
          }}>
            Press Enter to send · Shift+Enter for new line
          </div>
        </div>
      </main>
    </div>
  );
}
