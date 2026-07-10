'use client';

import React from 'react';
import { fonts, T } from './tokens';

// Big display readout — Concourse type system: Geist 600, normal style,
// letter-spacing −0.02em, line-height 1. (Kept the legacy `Serif` name so all
// numbers / headlines / big values restyle without a call-site change.)
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
        fontFamily: fonts.sans,
        fontStyle: 'normal',
        fontWeight: 600,
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
