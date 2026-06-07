'use client';

import React from 'react';
import { T, fonts } from './tokens';

// Triage button used across the inventory tab. Rounded-rect (radius 10), not a
// pill — matches the handoff. Variants: primary (ink), ghost (hairline),
// teal (AI/scan tone), paper.

type Variant = 'primary' | 'ghost' | 'teal' | 'sage' | 'paper';
type Size = 'sm' | 'md' | 'lg';

interface BtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: Size;
  type?: 'button' | 'submit' | 'reset';
}

const PADDING: Record<Size, string> = {
  sm: '0 12px',
  md: '0 16px',
  lg: '0 22px',
};
const HEIGHT: Record<Size, number> = { sm: 30, md: 38, lg: 42 };
const FONT_SIZE: Record<Size, number> = { sm: 11.5, md: 13, lg: 14 };

export function Btn({
  variant = 'ghost',
  size = 'md',
  type = 'button',
  style,
  disabled,
  children,
  ...rest
}: BtnProps) {
  const v = (() => {
    switch (variant) {
      case 'primary':
        return { bg: T.ink, fg: T.bg, border: T.ink, weight: 600 };
      // 'sage' is a legacy alias — repointed onto the teal (AI / scan) tone.
      case 'teal':
      case 'sage':
        return { bg: T.tealDim, fg: T.tealText, border: `${T.teal}33`, weight: 600 };
      case 'paper':
        return { bg: T.paper, fg: T.ink, border: T.rule, weight: 500 };
      case 'ghost':
      default:
        return { bg: 'transparent', fg: T.ink, border: T.rule, weight: 500 };
    }
  })();
  return (
    <button
      type={type}
      disabled={disabled}
      {...rest}
      style={{
        height: HEIGHT[size],
        padding: PADDING[size],
        borderRadius: 10,
        background: v.bg,
        color: v.fg,
        border: `1px solid ${v.border}`,
        fontFamily: fonts.sans,
        fontSize: FONT_SIZE[size],
        fontWeight: v.weight,
        letterSpacing: '-0.01em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
