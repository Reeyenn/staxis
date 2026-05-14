'use client';

// ─── MessageList — reusable polished message renderer ─────────────────────
// Shared between the floating chat panel and the full /chat page. Renders
// user / assistant / tool messages with Snow design system tokens and
// markdown support (tables, lists, bold) via react-markdown.
//
// Designed as a "good enough" baseline that Claude Design can refine on
// top of later — the structure is clean; the styling is opinionated but
// minimal.

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Wrench } from 'lucide-react';
import { MessageActionRow } from './MessageActionRow';
import { useMessagePlayback } from './useMessagePlayback';

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  isError?: boolean;
}

const C = {
  ink:      'var(--snow-ink, #1F231C)',
  ink2:     'var(--snow-ink2, #5C625C)',
  ink3:     'var(--snow-ink3, #A6ABA6)',
  rule:     'var(--snow-rule, rgba(31, 35, 28, 0.08))',
  ruleSoft: 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))',
  sage:     'var(--snow-sage, #9EB7A6)',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
  caramel:  'var(--snow-caramel, #C99644)',
  warm:     'var(--snow-warm, #B85C3D)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";

export interface MessageListProps {
  messages: DisplayMessage[];
  streaming?: boolean;
  /** Optional empty-state hint. */
  emptyHint?: React.ReactNode;
  /** Required for per-message TTS playback. When null, action row hides
   *  the Play button (Copy / thumbs still show). */
  propertyId?: string | null;
  /** Optional — attaches cost-ledger rows to the conversation. */
  conversationId?: string | null;
}

export function MessageList({
  messages,
  streaming,
  emptyHint,
  propertyId = null,
  conversationId = null,
}: MessageListProps) {
  // ONE useMessagePlayback instance for the whole list — its single <audio>
  // element + module-level activeTtsStop singleton ensure two messages
  // can't play at once across the entire chat.
  const playback = useMessagePlayback({ propertyId, conversationId });

  // The LAST assistant text message (no toolName) is the one being filled
  // during streaming. Hide the action row on it until streaming finishes.
  const streamingAssistantIndex = streaming
    ? findLastAssistantTextIndex(messages)
    : -1;
  if (messages.length === 0) {
    return (
      <div style={{
        padding: '48px 24px',
        textAlign: 'center',
        color: C.ink3,
        fontFamily: FONT_SANS,
        fontSize: 14,
        lineHeight: 1.6,
      }}>
        {emptyHint ?? (
          <>
            Ask Staxis anything. Try <em style={{ color: C.ink2 }}>&ldquo;what&rsquo;s today&rsquo;s status&rdquo;</em>,{' '}
            <em style={{ color: C.ink2 }}>&ldquo;mark room 102 clean&rdquo;</em>, or{' '}
            <em style={{ color: C.ink2 }}>&ldquo;how is everyone doing today&rdquo;</em>.
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 20px 80px', fontFamily: FONT_SANS, fontSize: 14, color: C.ink, lineHeight: 1.55 }}>
      {messages.map((m, i) => {
        const isPlainAssistantText =
          m.role === 'assistant' && !m.toolName && m.text.trim().length > 0;
        const showActions = isPlainAssistantText && i !== streamingAssistantIndex;
        const messageId = `msg-${i}`;
        return (
          <React.Fragment key={i}>
            <MessageRow message={m} />
            {showActions && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginLeft: 0 }}>
                <MessageActionRow
                  messageId={messageId}
                  text={m.text}
                  isCurrentlyPlaying={playback.currentlyPlayingId === messageId}
                  onPlay={(t, id) => void playback.play(t, id)}
                  onStopPlay={playback.stop}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}
      {streaming && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 0 0', color: C.ink3 }}>
          <Dot delay={0} />
          <Dot delay={150} />
          <Dot delay={300} />
        </div>
      )}
    </div>
  );
}

function findLastAssistantTextIndex(messages: DisplayMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.toolName) return i;
  }
  return -1;
}

function MessageRow({ message: m }: { message: DisplayMessage }) {
  if (m.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{
          maxWidth: '78%',
          padding: '10px 14px',
          background: C.ink,
          color: 'white',
          borderRadius: 14,
          borderBottomRightRadius: 4,
          fontFamily: FONT_SANS,
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {m.text}
        </div>
      </div>
    );
  }

  if (m.role === 'assistant' && m.toolName) {
    return (
      <div style={{
        margin: '4px 0 8px',
        padding: '6px 10px',
        background: C.ruleSoft,
        border: `1px solid ${C.rule}`,
        borderRadius: 8,
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: C.ink2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '78%',
      }}>
        <Wrench size={11} strokeWidth={2} />
        <span style={{ color: C.ink3 }}>calling</span>
        <span style={{ color: C.ink }}>{m.toolName}</span>
        {m.toolArgs && Object.keys(m.toolArgs).length > 0 && (
          <span style={{ color: C.ink3 }}>
            ({Object.entries(m.toolArgs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})
          </span>
        )}
      </div>
    );
  }

  if (m.role === 'tool') {
    const text = typeof m.toolResult === 'string'
      ? m.toolResult
      : JSON.stringify(m.toolResult);
    const summary = summarizeToolResult(text, m.isError);
    return (
      <div style={{
        margin: '0 0 10px',
        padding: '6px 10px',
        background: m.isError ? 'rgba(184, 92, 61, 0.06)' : C.ruleSoft,
        border: `1px solid ${m.isError ? 'rgba(184, 92, 61, 0.20)' : C.rule}`,
        borderRadius: 8,
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: m.isError ? C.warm : C.sageDeep,
        maxWidth: '78%',
      }}>
        {summary}
      </div>
    );
  }

  if (m.role === 'assistant' && m.text) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 18 }}>
        <div style={{
          maxWidth: '88%',
          fontFamily: FONT_SANS,
          fontSize: 14,
          color: C.ink,
          lineHeight: 1.6,
        }}>
          <MarkdownBody text={m.text} />
        </div>
      </div>
    );
  }

  return null;
}

/** A short, friendly summary of a tool result for display. */
function summarizeToolResult(raw: string, isError?: boolean): string {
  if (isError) return `× ${raw.length > 140 ? raw.slice(0, 140) + '…' : raw}`;
  if (raw.length < 80) return `✓ ${raw}`;
  // Try to extract a one-liner from JSON
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed) {
      const summary = (parsed as Record<string, unknown>).summary
        ?? (parsed as Record<string, unknown>).message
        ?? (parsed as Record<string, unknown>).note;
      if (typeof summary === 'string') return `✓ ${summary}`;
      const keys = Object.keys(parsed).slice(0, 3).join(', ');
      return `✓ ${keys}…`;
    }
  } catch {
    // not JSON, fall through
  }
  return `✓ ${raw.slice(0, 80)}…`;
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p style={{ margin: '0 0 8px' }}>{children}</p>,
        strong: ({ children }) => <strong style={{ color: C.ink, fontWeight: 600 }}>{children}</strong>,
        em: ({ children }) => <em style={{ color: C.ink2 }}>{children}</em>,
        code: ({ children }) => (
          <code style={{
            fontFamily: FONT_MONO,
            fontSize: '0.92em',
            background: C.ruleSoft,
            padding: '1px 5px',
            borderRadius: 3,
            color: C.ink,
          }}>
            {children}
          </code>
        ),
        ul: ({ children }) => <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ margin: '4px 0 8px', paddingLeft: 20 }}>{children}</ol>,
        li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
        h1: ({ children }) => <h3 style={{ fontFamily: FONT_SANS, fontSize: 16, margin: '12px 0 8px', color: C.ink }}>{children}</h3>,
        h2: ({ children }) => <h4 style={{ fontFamily: FONT_SANS, fontSize: 15, margin: '12px 0 6px', color: C.ink }}>{children}</h4>,
        h3: ({ children }) => <h5 style={{ fontFamily: FONT_SANS, fontSize: 14, margin: '10px 0 6px', color: C.ink2 }}>{children}</h5>,
        table: ({ children }) => (
          <div style={{ overflow: 'auto', margin: '8px 0' }}>
            <table style={{
              borderCollapse: 'collapse',
              fontSize: 13,
              fontFamily: FONT_SANS,
              width: '100%',
            }}>
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th style={{
            padding: '6px 10px',
            textAlign: 'left',
            borderBottom: `1px solid ${C.rule}`,
            fontFamily: FONT_MONO,
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: C.ink3,
            fontWeight: 500,
          }}>
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td style={{
            padding: '6px 10px',
            borderBottom: `1px solid ${C.ruleSoft}`,
            color: C.ink,
          }}>
            {children}
          </td>
        ),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: C.sageDeep, textDecoration: 'underline' }}>
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span style={{
      width: 5, height: 5, borderRadius: '50%', background: C.ink3,
      animation: 'staxis-pulse 1.2s ease-in-out infinite',
      animationDelay: `${delay}ms`,
    }} />
  );
}
