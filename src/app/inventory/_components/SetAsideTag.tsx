'use client';

import React from 'react';
import { T, fonts } from './tokens';
import { setAsideTagLabel, setAsideTip, type Lang } from './inv-i18n';

// The "set aside" marker (0321) — shown anywhere a set-aside quantity
// appears. Hovering the ⓘ explains the concept in one plain sentence
// (native tooltip via title, so it works on every surface for free).
export function SetAsideTag({ count, lang }: { count: number; lang: Lang }) {
  if (count <= 0) return null;
  const tip = setAsideTip(lang);
  return (
    <span
      title={tip}
      aria-label={tip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 999,
        background: T.goldDim,
        color: T.goldText,
        border: `1px solid ${T.gold}33`,
        fontFamily: fonts.sans,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {setAsideTagLabel(lang, count)}
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 11,
          height: 11,
          borderRadius: '50%',
          border: `1px solid ${T.goldText}55`,
          fontFamily: fonts.serif,
          fontSize: 8,
          fontStyle: 'italic',
          lineHeight: 1,
        }}
      >
        i
      </span>
    </span>
  );
}
