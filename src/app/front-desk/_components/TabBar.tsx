'use client';

// Front-desk sub-tab bar. Mirrors MTSubTabBar (maintenance) — same snow styling
// and sticky behaviour. The Lost & Found and Complaints tabs only render for
// management roles (the page passes showLostFound / showComplaints); the Rooms
// tab is always present so existing front-desk access is unchanged.

import React from 'react';
import { T, FONT_SANS } from '@/app/maintenance/_components/_mt-snow';

export type FrontDeskTabKey = 'rooms' | 'lost-and-found' | 'complaints';

export function FrontDeskTabBar({
  tab,
  onTab,
  lang,
  showLostFound,
  showComplaints,
}: {
  tab: FrontDeskTabKey;
  onTab: (t: FrontDeskTabKey) => void;
  lang: 'en' | 'es';
  showLostFound: boolean;
  showComplaints?: boolean;
}) {
  const tabs: { key: FrontDeskTabKey; label: string }[] = [
    { key: 'rooms', label: lang === 'es' ? 'Habitaciones' : 'Rooms' },
    ...(showLostFound
      ? [
          {
            key: 'lost-and-found' as const,
            label: lang === 'es' ? 'Objetos perdidos' : 'Lost & Found',
          },
        ]
      : []),
    ...(showComplaints
      ? [
          {
            key: 'complaints' as const,
            label: lang === 'es' ? 'Quejas' : 'Complaints',
          },
        ]
      : []),
  ];
  return (
    <div
      style={{
        padding: '18px 48px 0',
        background: T.bg,
        borderBottom: `1px solid ${T.rule}`,
        position: 'sticky',
        top: 64,
        zIndex: 10,
      }}
    >
      <nav style={{ display: 'flex', gap: 28 }}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px 0 14px',
                position: 'relative',
                fontFamily: FONT_SANS,
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? T.ink : T.ink2,
                borderBottom: active ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
