'use client';

import React from 'react';
import { T, fonts } from './tokens';

// Snow-styled button used across the inventory rebuild.
// Variants match the Claude Design prototype: primary, ghost, sage, paper.

type Variant = 'primary' | 'ghost' | 'sage' | 'paper';
type Size = 'sm' | 'md' | 'lg';

interface BtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: Size;
  type?: 'button' | 'submit' | 'reset';
}

const PADDING: Record<Size, string> = {
  sm: '0 12px',
  md: '0 18px',
  lg: '0 22px',
};
const HEIGHT: Record<Size, number> = { sm: 30, md: 36, lg: 42 };
const FONT_SIZE: Record<Size, number> = { sm: 12, md: 13, lg: 14 };

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
        return { bg: T.ink,  fg: T.bg, border: T.ink, weight: 600 };
      case 'sage':
        return { bg: T.sageDim, fg: '#3F5A43', border: 'rgba(63,90,67,0.28)', weight: 600 };
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
        borderRadius: 999,
        background: v.bg,
        color: v.fg,
        border: `1px solid ${v.border}`,
        fontFamily: fonts.sans,
        fontSize: FONT_SIZE[size],
        fontWeight: v.weight,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
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
