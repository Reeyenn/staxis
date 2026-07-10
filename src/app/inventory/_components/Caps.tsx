'use client';

import React from 'react';
import { fonts, T } from './tokens';

// Uppercase mono caps eyebrow used above every section title.
// Concourse eyebrow spec: Geist Mono 9.5px, tracking 0.14em, faint ink.

interface CapsProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
  tracking?: string;
  color?: string;
  weight?: number;
}

export function Caps({
  children,
  size = 9.5,
  tracking = '0.14em',
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
        color: color ?? T.faint,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
