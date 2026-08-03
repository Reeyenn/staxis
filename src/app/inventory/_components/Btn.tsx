'use client';

import React from 'react';
import { T, fonts } from './tokens';
import { UiButton, type UiButtonTheme } from '@/app/_components/ui/Button';
import { UI_FOCUS, UI_RADII } from '@/app/_components/ui/tokens';

// Concourse button used across the inventory tab. Radius-999 pill. Variants:
// primary (sage), ghost (hairline), teal (AI/scan tone → sage wash), paper.

type Variant = 'primary' | 'ghost' | 'teal' | 'sage' | 'paper';
type Size = 'sm' | 'md' | 'lg';

interface BtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: Size;
  type?: 'button' | 'submit' | 'reset';
}

const INVENTORY_BUTTON_THEME: UiButtonTheme = {
  sizes: {
    sm: { height: 30, padding: '0 12px', fontSize: 11.5 },
    md: { height: 38, padding: '0 16px', fontSize: 12.5 },
    lg: { height: 42, padding: '0 22px', fontSize: 13.5 },
  },
  variants: {
    primary: { background: T.brand, color: '#fff', border: T.brand, fontWeight: 600 },
    // 'sage' is a legacy alias — repointed onto the teal (AI / scan) tone.
    teal: { background: T.tealDim, color: T.tealText, border: 'rgba(92,122,96,0.28)', fontWeight: 600 },
    sage: { background: T.tealDim, color: T.tealText, border: 'rgba(92,122,96,0.28)', fontWeight: 600 },
    paper: { background: T.paper, color: T.ink, border: 'rgba(31,35,28,0.14)', fontWeight: 500 },
    ghost: { background: 'transparent', color: T.ink2, border: 'rgba(31,35,28,0.14)', fontWeight: 500 },
  },
  fontFamily: fonts.sans,
  disabledOpacity: 0.45,
  gap: 8,
  borderRadius: UI_RADII.pill,
  focusRing: UI_FOCUS.ring,
};

export const Btn = React.forwardRef<HTMLButtonElement, BtnProps>(function Btn({
  variant = 'ghost',
  size = 'md',
  type = 'button',
  style,
  disabled,
  children,
  ...rest
}, ref) {
  return (
    <UiButton
      ref={ref}
      theme={INVENTORY_BUTTON_THEME}
      variant={variant}
      size={size}
      type={type}
      disabled={disabled}
      {...rest}
      style={{
        letterSpacing: '-0.01em',
        ...style,
      }}
    >
      {children}
    </UiButton>
  );
});
