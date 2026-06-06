'use client';

import React from 'react';
import { Check } from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
import { t } from '@/lib/translations';
import { TOK } from './tokens';
import { confettiBurst } from './confetti';

/**
 * AllRoomsCleanCard — the end-of-shift celebration shown in place of the room
 * list once every room is done. Teal gradient, spring check-pop, confetti 3×
 * on entry (motion-reduced users get the static card, no particles).
 */
export function AllRoomsCleanCard({
  count,
  firstName,
  lang,
}: {
  count: number;
  firstName: string;
  lang: HousekeeperLocale;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const burstedRef = React.useRef(false);

  React.useEffect(() => {
    if (burstedRef.current) return;
    burstedRef.current = true;
    for (let d = 0; d < 3; d++) {
      window.setTimeout(() => ref.current && confettiBurst(ref.current, { count: 30 }), d * 220);
    }
  }, []);

  return (
    <div
      ref={ref}
      style={{
        borderRadius: 22,
        padding: '32px 22px',
        textAlign: 'center',
        background: `linear-gradient(160deg,${TOK.tealDeep},${TOK.tealDeep2})`,
        color: 'white',
        boxShadow: '0 14px 36px rgba(0,80,78,.32)',
        animation: 'fh-rise .5s cubic-bezier(.2,.8,.2,1)',
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: '50%',
          background: 'rgba(255,255,255,.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
          animation: 'fh-pop .6s cubic-bezier(.2,1.5,.4,1)',
        }}
      >
        <Check size={44} strokeWidth={3} color="white" />
      </div>
      <h2 style={{ fontSize: 23, fontWeight: 800, marginTop: 16, letterSpacing: '-.02em' }}>
        {t('hkAllRoomsClean', lang)}
      </h2>
      <p style={{ fontSize: 14, opacity: 0.85, marginTop: 6, lineHeight: 1.5 }}>
        {t('hkAllRoomsCleanSub', lang).replace('{name}', firstName)}
        <br />
        {t('hkAllRoomsCleanCount', lang).replace('{count}', String(count))} 🎉
      </p>
    </div>
  );
}
