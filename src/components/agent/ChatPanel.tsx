'use client';

// ─── ChatPanel — slide-in panel triggered by FloatingChatButton ───────────
// Compact text-chat surface for quick asks from anywhere in the app. On
// desktop it slides in from the right as a 420px-wide panel; on mobile it
// covers the screen.
//
// Voice is intentionally NOT in this panel — the only voice affordance
// here is a Phone icon in the header that opens the dedicated voice mode
// (a Clicky-style bottom overlay) on the underlying page. Per-message
// 🔊 Play buttons live on each assistant reply via MessageList.

import { useEffect, useRef, useState } from 'react';
import { X, Send, Plus, ExternalLink, Phone } from 'lucide-react';
import Link from 'next/link';
import { MessageList } from './MessageList';
import { useAgentChat } from './useAgentChat';
import { useVoicePanel } from './VoicePanelContext';

const C = {
  bg:       'var(--snow-bg, #FFFFFF)',
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

export interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  propertyId: string | null;
}

export function ChatPanel({ open, onClose, propertyId }: ChatPanelProps) {
  const {
    messages,
    conversationId,
    streaming,
    error,
    sendMessage,
    startNew,
  } = useAgentChat({ propertyId, active: open });

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voicePanel = useVoicePanel();

  // ── Scroll to bottom on new messages ───────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // ── Auto-focus textarea on open ────────────────────────────────────────
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => textareaRef.current?.focus(), 220);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── Esc to close ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const text = input.trim();
    setInput('');
    await sendMessage(text);
  };

  const handleEnterVoiceMode = () => {
    voicePanel?.openVoiceMode();
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop — clicking it closes the panel on desktop. */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(31, 35, 28, 0.15)',
          zIndex: 80,
          animation: 'staxis-fade-in 0.18s ease-out',
        }}
      />

      <aside
        role="dialog"
        aria-label="Staxis chat"
        style={{
          position: 'fixed',
          top: 0, right: 0,
          height: '100vh',
          width: 'min(420px, 100vw)',
          background: C.bg,
          borderLeft: `1px solid ${C.rule}`,
          boxShadow: '-12px 0 32px rgba(31, 35, 28, 0.06)',
          zIndex: 81,
          display: 'flex',
          flexDirection: 'column',
          animation: 'staxis-slide-in 0.22s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 16px 12px 20px',
          borderBottom: `1px solid ${C.rule}`,
        }}>
          <div>
            <div style={{
              fontFamily: FONT_SERIF,
              fontSize: 24,
              lineHeight: 1,
              color: C.ink,
              letterSpacing: '-0.01em',
            }}>
              Staxis
            </div>
            <div style={{
              marginTop: 2,
              fontFamily: FONT_MONO,
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: C.ink3,
            }}>
              Quick chat
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={startNew}
              title="New conversation"
              aria-label="New conversation"
              style={iconBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Plus size={15} strokeWidth={2.2} color={C.ink2} />
            </button>
            <button
              onClick={handleEnterVoiceMode}
              title="Talk to Staxis"
              aria-label="Enter voice mode"
              style={iconBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Phone size={15} strokeWidth={2.2} color={C.sageDeep} />
            </button>
            <Link
              href="/chat"
              title="Open full chat"
              aria-label="Open full chat"
              style={{ ...iconBtnStyle, textDecoration: 'none' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <ExternalLink size={15} strokeWidth={2.2} color={C.ink2} />
            </Link>
            <button
              onClick={onClose}
              aria-label="Close"
              style={iconBtnStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.ruleSoft; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <X size={16} strokeWidth={2.2} color={C.ink2} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{ flex: 1, overflowY: 'auto', scrollBehavior: 'smooth', position: 'relative' }}
        >
          <MessageList
            messages={messages}
            streaming={streaming}
            propertyId={propertyId}
            conversationId={conversationId}
            emptyHint={
              <>
                Ask anything. Try{' '}
                <em style={{ color: C.ink2 }}>&ldquo;what&rsquo;s the occupancy&rdquo;</em>,{' '}
                <em style={{ color: C.ink2 }}>&ldquo;mark 302 clean&rdquo;</em>, or{' '}
                <em style={{ color: C.ink2 }}>&ldquo;show me how to add a housekeeper&rdquo;</em>.
              </>
            }
          />
          {error && (
            <div style={{
              margin: '8px 16px 16px',
              padding: '10px 12px',
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

        {/* Composer */}
        <div style={{
          padding: '12px 16px 16px',
          borderTop: `1px solid ${C.rule}`,
          background: C.bg,
        }}>
          <div style={{ position: 'relative' }}>
            <textarea
              ref={textareaRef}
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
                padding: '12px 44px 12px 14px',
                fontFamily: FONT_SANS,
                fontSize: 14,
                lineHeight: 1.5,
                color: C.ink,
                background: C.bg,
                border: `1px solid ${C.rule}`,
                borderRadius: 12,
                outline: 'none',
                minHeight: 44,
                maxHeight: 160,
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = C.sageDeep; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = C.rule; }}
            />
            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              aria-label="Send"
              style={{
                position: 'absolute',
                right: 8, bottom: 8,
                width: 28, height: 28,
                borderRadius: 7,
                border: 'none',
                cursor: streaming || !input.trim() ? 'default' : 'pointer',
                background: streaming || !input.trim() ? C.rule : C.ink,
                color: streaming || !input.trim() ? C.ink3 : 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Send size={13} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 30, height: 30,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
