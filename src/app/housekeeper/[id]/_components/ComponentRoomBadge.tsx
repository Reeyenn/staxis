'use client';

import React from 'react';
import { Home } from 'lucide-react';
import { t, type HousekeeperLocale } from '@/lib/translations';
import {
  formatComponentLabel,
  type ComponentRoomLink,
} from '@/lib/housekeeper-workflow/component-rooms';

/**
 * ComponentRoomBadge — renders inside a JobCard when the room is the
 * parent of a multi-room suite. Displays "Suite · Includes 305A · 305B"
 * so the housekeeper knows the single tap-Done covers all sub-rooms.
 */
interface Props {
  link: ComponentRoomLink;
  lang: HousekeeperLocale;
}

export function ComponentRoomBadge({ link, lang }: Props) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        background: '#F5F3FF',
        border: '1px solid #C4B5FD',
        borderRadius: 6,
        color: '#6D28D9',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
      }}
    >
      <Home size={11} />
      <span style={{ textTransform: 'uppercase' }}>{t('componentRoomLabel', lang)}</span>
      <span style={{ opacity: 0.7, textTransform: 'none', letterSpacing: 0 }}>
        · {t('componentRoomChildPrefix', lang)} {formatComponentLabel(link)}
      </span>
    </div>
  );
}
