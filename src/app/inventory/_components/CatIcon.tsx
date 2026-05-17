'use client';

import React from 'react';
import { fonts, catColor, catGlyph, T, type InvCat } from './tokens';

interface CatIconProps {
  cat: InvCat;
  size?: number;
  style?: React.CSSProperties;
}

// Tinted rounded square with the two-letter category glyph (HK / MX / FB).
export function CatIcon({ cat, size = 28, style }: CatIconProps) {
  const c = catColor[cat] ?? T.ink3;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 7,
        flexShrink: 0,
        background: c + '14',
        border: `1px solid ${c}33`,
        color: c,
        fontFamily: fonts.mono,
        fontSize: size * 0.36,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        letterSpacing: 0,
        ...style,
      }}
    >
      {catGlyph[cat]}
    </span>
  );
}
