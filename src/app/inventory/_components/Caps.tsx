'use client';

import React from 'react';
import { fonts, T } from './tokens';

// Uppercase mono caps eyebrow used above every section title.
// Matches HK.Caps in hk-shared.jsx (Geist Mono 10px tracking 0.16em).

interface CapsProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
  tracking?: string;
  color?: string;
  weight?: number;
}

export function Caps({
  children,
  size = 10,
  tracking = '0.16em',
  color,
  weight = 500,
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
        color: color ?? T.ink3,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
