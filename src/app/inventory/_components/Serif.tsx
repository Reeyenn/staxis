'use client';

import React from 'react';
import { fonts, T } from './tokens';

// Big italic serif readout (Newsreader). All numbers / headlines / big values
// in the Triage design use this — weight 400, italic, letter-spacing −0.02em,
// line-height 1.
export function Serif({
  children,
  size = 32,
  color = T.ink,
  style,
}: {
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: fonts.serif,
        fontStyle: 'italic',
        fontWeight: 400,
        fontSize: size,
        color,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
