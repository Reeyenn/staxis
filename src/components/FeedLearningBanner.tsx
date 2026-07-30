'use client';

/**
 * FeedLearningBanner
 *
 * A data-availability notice for incomplete PMS reports. It keeps an
 * empty/zero view from reading as "nothing is happening today". Deliberately
 * dumb — pages pass
 * PRE-TRANSLATED strings (manager pages own EN/ES via useLang(); the
 * housekeeper page has its own per-staff language mechanism), this component
 * only owns the look.
 *
 * Variants:
 *  - 'strip' — board-level banner (Schedule, front-desk)
 *  - 'pill'  — compact inline label (dashboard tiles, mobile pages)
 *
 * Tone rules: calm caramel status, never red, never a fake count. Copy is
 * supplied by callers.
 */

const SANS = 'var(--font-geist-sans), system-ui, sans-serif';

export function FeedLearningBanner({
  text,
  variant = 'strip',
  title,
}: {
  /** Pre-translated data-availability message. */
  text: string;
  variant?: 'strip' | 'pill';
  /** Optional pre-translated bold lead-in (strip only). */
  title?: string;
}) {
  if (variant === 'pill') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 10px',
          borderRadius: 999,
          background: 'var(--snow-caramel-dim, rgba(201, 150, 68, 0.12))',
          color: 'var(--snow-caramel-deep, #8C6A33)',
          border: '1px solid var(--snow-caramel-dim, rgba(201, 150, 68, 0.25))',
          fontFamily: SANS,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.2,
          whiteSpace: 'nowrap',
        }}
      >
        <StatusDot />
        {text}
      </span>
    );
  }

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 16px',
        borderRadius: 12,
        background: 'var(--snow-caramel-dim, rgba(201, 150, 68, 0.10))',
        border: '1px solid rgba(201, 150, 68, 0.30)',
        color: 'var(--snow-ink-soft, #3A3F38)',
        fontFamily: SANS,
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <span style={{ marginTop: 2, flexShrink: 0 }}>
        <StatusDot size={8} />
      </span>
      <span>
        {title && (
          <strong style={{ color: 'var(--snow-caramel-deep, #8C6A33)', fontWeight: 600 }}>
            {title}{' '}
          </strong>
        )}
        {text}
      </span>
    </div>
  );
}

function StatusDot({ size = 6 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--snow-caramel, #C99644)',
      }}
    />
  );
}
