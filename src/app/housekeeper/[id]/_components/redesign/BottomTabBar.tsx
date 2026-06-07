'use client';

import React from 'react';
import { BedDouble, MessageCircle } from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
import { t } from '@/lib/translations';
import { TOK } from './tokens';

export type HkTab = 'rooms' | 'messages';

/**
 * BottomTabBar — pinned bottom navigation (Rooms | Messages). Always visible
 * on both tabs. Active tab = teal, inactive = grey. Labels are spelled out
 * (the audience is non-technical — never bare icons).
 */
export function BottomTabBar({
  active,
  unread,
  onRooms,
  onMessages,
  lang,
}: {
  active: HkTab;
  unread: number;
  onRooms: () => void;
  onMessages: () => void;
  lang: HousekeeperLocale;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        background: '#fff',
        borderTop: '1px solid #E6E8EC',
        padding: '2px 8px calc(14px + env(safe-area-inset-bottom, 8px))',
      }}
    >
      <Tab
        active={active === 'rooms'}
        label={t('hkTabRooms', lang)}
        icon={<BedDouble size={23} color={active === 'rooms' ? TOK.teal : '#9AA0A8'} />}
        onClick={onRooms}
      />
      <Tab
        active={active === 'messages'}
        label={t('hkTabMessages', lang)}
        icon={<MessageCircle size={23} color={active === 'messages' ? TOK.teal : '#9AA0A8'} />}
        badge={unread}
        onClick={onMessages}
      />
    </div>
  );
}

function Tab({
  active,
  icon,
  label,
  badge = 0,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '8px 0',
        position: 'relative',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        {icon}
        {badge > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -8,
              minWidth: 16,
              height: 16,
              borderRadius: 99,
              background: '#D14343',
              color: '#fff',
              fontSize: 10,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
            }}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span style={{ fontSize: 11, fontWeight: 700, color: active ? TOK.teal : '#9AA0A8' }}>{label}</span>
    </button>
  );
}
