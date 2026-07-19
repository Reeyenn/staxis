'use client';

import React from 'react';
import { fonts, T } from './tokens';

// Uppercase mono caps eyebrow used above every section title.
// Inventory crews scan these labels at a distance, so the default uses the
// AA-safe secondary ink rather than the decorative faint token. Individual
// tertiary metadata can still opt into T.faint explicitly.

interface CapsProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
  tracking?: string;
  color?: string;
  weight?: number;
}

export function Caps({
  children,
  size = 10,
  tracking = '0.14em',
  color,
  weight = 600,
  style,
  ...rest
}: CapsProps) {
  return (
    <span
      {...rest}
      style={{
        fontFamily: fonts.mono,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: tracking,
        textTransform: 'uppercase',
        color: color ?? T.ink2,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
