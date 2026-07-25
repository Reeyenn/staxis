'use client';

/**
 * FeedAsOfLabel — the "as of 6:40 AM" chip.
 *
 * Sibling of FeedLearningBanner and deliberately just as dumb: it owns the
 * look, nothing else. The decision about whether a label may exist at all
 * (never for a manual hotel, never over a never-synced feed) lives in
 * src/lib/pms/as-of-label.ts; the language and clock come from useAsOfLabel.
 * Pass `label` straight through — a null label renders nothing.
 *
 * Tone rules, load-bearing:
 *  - 'quiet' is grey and small. Current data must not look like a warning.
 *  - 'caution' is the same calm caramel the learning banner uses. NEVER red,
 *    never the word "error": the number on screen is real, it is just old,
 *    and a manager who learns to ignore this chip is the failure mode.
 */

import type { CSSProperties } from 'react';
import type { AsOfLabel } from '@/lib/pms/as-of-label';

const SANS = 'var(--font-geist-sans), system-ui, sans-serif';

export function FeedAsOfLabel({
  label,
  variant = 'inline',
  style,
}: {
  label: AsOfLabel | null;
  /** 'inline' — a bare line under a tile value. 'pill' — a bordered chip for
   *  a legend / header row where it needs its own edges. */
  variant?: 'inline' | 'pill';
  style?: CSSProperties;
}) {
  if (!label) return null;

  const caution = label.tone === 'caution';
  const color = caution ? 'var(--snow-caramel-deep, #8C6A33)' : 'var(--snow-ink-soft, #7A7F78)';

  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontFamily: SANS,
    fontSize: 11,
    fontWeight: caution ? 600 : 500,
    letterSpacing: 0.1,
    lineHeight: 1.3,
    color,
    whiteSpace: 'nowrap',
    ...(variant === 'pill'
      ? {
          padding: '3px 9px',
          borderRadius: 999,
          background: caution
            ? 'var(--snow-caramel-dim, rgba(201, 150, 68, 0.12))'
            : 'rgba(0, 0, 0, 0.035)',
          border: `1px solid ${caution ? 'rgba(201, 150, 68, 0.28)' : 'rgba(0, 0, 0, 0.07)'}`,
        }
      : null),
    ...style,
  };

  return (
    <span style={base} title={label.detail}>
      <ClockGlyph color={color} />
      {/* The short form is for eyes only. A screen reader gets the full
          sentence below instead — "as of 6:40 AM" on its own doesn't say the
          number is older than a report cycle, which is the whole point. */}
      <span aria-hidden>{label.text}</span>
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {label.detail}
      </span>
    </span>
  );
}

function ClockGlyph({ color }: { color: string }) {
  return (
    <svg
      aria-hidden
      width={10}
      height={10}
      viewBox="0 0 12 12"
      fill="none"
      stroke={color}
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, opacity: 0.85 }}
    >
      <circle cx="6" cy="6" r="4.6" />
      <path d="M6 3.4V6l1.8 1.1" />
    </svg>
  );
}
