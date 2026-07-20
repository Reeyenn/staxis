'use client';

import React from 'react';
import { T, fonts } from './tokens';

// Concourse button used across the inventory tab. Radius-999 pill. Variants:
// primary (sage), ghost (hairline), teal (AI/scan tone → sage wash), paper.

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
const FONT_SIZE: Record<Size, number> = { sm: 11.5, md: 12.5, lg: 13.5 };

export const Btn = React.forwardRef<HTMLButtonElement, BtnProps>(function Btn({
  variant = 'ghost',
  size = 'md',
  type = 'button',
  style,
  disabled,
  children,
  ...rest
}, ref) {
  const v = (() => {
    switch (variant) {
      case 'primary':
        return { bg: T.brand, fg: '#fff', border: T.brand, weight: 600 };
      // 'sage' is a legacy alias — repointed onto the teal (AI / scan) tone.
      case 'teal':
      case 'sage':
        return { bg: T.tealDim, fg: T.tealText, border: 'rgba(92,122,96,0.28)', weight: 600 };
      case 'paper':
        return { bg: T.paper, fg: T.ink, border: 'rgba(31,35,28,0.14)', weight: 500 };
      case 'ghost':
      default:
        return { bg: 'transparent', fg: T.ink2, border: 'rgba(31,35,28,0.14)', weight: 500 };
    }
  })();
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      {...rest}
      style={{
        height: HEIGHT[size],
        padding: PADDING[size],
        borderRadius: 999,
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
});
