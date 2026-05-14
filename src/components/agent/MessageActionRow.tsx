'use client';

// ─── MessageActionRow — small action icons under each AI reply ──────────
//
// Renders 🔊 Play, 📋 Copy, 👍 (stub), 👎 (stub) under a completed assistant
// message. Hidden during streaming. Hidden on tool-call / tool-result rows
// (those aren't user-readable replies).
//
// Playback is mediated by `useMessagePlayback` at the MessageList level —
// this row receives `currentlyPlayingId`, `onPlay(text, id)`, `onStop()`
// from the parent. Only one message plays at a time across the whole list.

import { useState } from 'react';
import { Volume2, Pause, Copy, ThumbsUp, ThumbsDown, Check } from 'lucide-react';

const C = {
  ink:  'var(--snow-ink, #1F231C)',
  ink2: 'var(--snow-ink2, #5C625C)',
  ink3: 'var(--snow-ink3, #A6ABA6)',
  sageDeep: 'var(--snow-sage-deep, #5C7A60)',
};

export interface MessageActionRowProps {
  messageId: string;
  text: string;
  isCurrentlyPlaying: boolean;
  onPlay(text: string, id: string): void;
  onStopPlay(): void;
}

export function MessageActionRow({
  messageId,
  text,
  isCurrentlyPlaying,
  onPlay,
  onStopPlay,
}: MessageActionRowProps) {
  const [copied, setCopied] = useState(false);
  const [thumbsUp, setThumbsUp] = useState(false);
  const [thumbsDown, setThumbsDown] = useState(false);

  if (!text.trim()) return null;

  const handlePlay = () => {
    if (isCurrentlyPlaying) onStopPlay();
    else onPlay(text, messageId);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.warn('[MessageActionRow] clipboard write failed', e);
    }
  };

  const handleThumbsUp = () => {
    setThumbsUp(true);
    setThumbsDown(false);
    // TODO(feedback): persist to a feedback table; out of scope this round.
  };

  const handleThumbsDown = () => {
    setThumbsDown(true);
    setThumbsUp(false);
    // TODO(feedback): persist to a feedback table; out of scope this round.
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        marginTop: 8,
        marginBottom: 4,
        alignItems: 'center',
      }}
    >
      <ActionBtn
        title={isCurrentlyPlaying ? 'Stop' : 'Play aloud'}
        onClick={handlePlay}
        active={isCurrentlyPlaying}
      >
        {isCurrentlyPlaying
          ? <Pause size={14} strokeWidth={2} color={C.sageDeep} />
          : <Volume2 size={14} strokeWidth={2} color={C.ink2} />}
      </ActionBtn>

      <ActionBtn
        title={copied ? 'Copied' : 'Copy'}
        onClick={handleCopy}
        active={copied}
      >
        {copied
          ? <Check size={14} strokeWidth={2} color={C.sageDeep} />
          : <Copy size={14} strokeWidth={2} color={C.ink2} />}
      </ActionBtn>

      <ActionBtn
        title="Good response"
        onClick={handleThumbsUp}
        active={thumbsUp}
      >
        <ThumbsUp size={14} strokeWidth={2} color={thumbsUp ? C.sageDeep : C.ink2} />
      </ActionBtn>

      <ActionBtn
        title="Bad response"
        onClick={handleThumbsDown}
        active={thumbsDown}
      >
        <ThumbsDown size={14} strokeWidth={2} color={thumbsDown ? C.sageDeep : C.ink2} />
      </ActionBtn>
    </div>
  );
}

interface ActionBtnProps {
  title: string;
  onClick(): void;
  active?: boolean;
  children: React.ReactNode;
}

function ActionBtn({ title, onClick, active, children }: ActionBtnProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        border: 'none',
        background: active ? 'rgba(94, 122, 96, 0.10)' : 'transparent',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.14s ease',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--snow-rule-soft, rgba(31, 35, 28, 0.04))';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
