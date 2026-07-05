'use client';

import React, { useState } from 'react';
import { withStaffLinkTokenBody } from '@/lib/staff-link-client';
import { Coffee, PlayCircle } from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
// Locally aliased so piece-A code keeps reading `lang: Language` everywhere.
type Language = HousekeeperLocale;
import { t } from '@/lib/translations';

/**
 * LunchBreakButton — toggles a lunch-break clock in/out. Single source of
 * truth is /api/housekeeper/lunch-break (one open break per day enforced
 * by a unique index). The button shows the current state and the elapsed
 * minutes when on break.
 *
 * When on break, all other workflow actions stay enabled — the
 * housekeeper might end lunch by tapping a room's Start. The break
 * audit row tracks the time independently.
 */

interface Props {
  pid: string;
  staffId: string;
  businessDate: string; // YYYY-MM-DD
  lang: Language;
  openBreakStartedAt: string | null;
  onChange: (next: { onBreak: boolean; startedAt: string | null }) => void;
}

export function LunchBreakButton({
  pid,
  staffId,
  businessDate,
  lang,
  openBreakStartedAt,
  onChange,
}: Props) {
  const [submitting, setSubmitting] = useState(false);

  const onBreak = !!openBreakStartedAt;
  const elapsedMin = onBreak && openBreakStartedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(openBreakStartedAt)) / 60000))
    : 0;

  const handleClick = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/housekeeper/lunch-break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withStaffLinkTokenBody({
          pid,
          staffId,
          businessDate,
          breakType: 'lunch',
        })),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { action?: string; startedAt?: string } }
        | null;
      if (res.ok && json?.ok && json.data) {
        if (json.data.action === 'started') {
          onChange({ onBreak: true, startedAt: json.data.startedAt ?? new Date().toISOString() });
        } else if (json.data.action === 'ended') {
          onChange({ onBreak: false, startedAt: null });
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={submitting}
      style={{
        width: '100%',
        padding: '12px 14px',
        background: onBreak ? '#FEF3C7' : 'white',
        border: onBreak ? '1.5px solid #FDE68A' : '1.5px solid var(--border-light, #E5E7EB)',
        borderRadius: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        cursor: submitting ? 'not-allowed' : 'pointer',
        opacity: submitting ? 0.6 : 1,
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        transition: 'background 150ms ease',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {onBreak ? (
          <PlayCircle size={18} color="#92400E" />
        ) : (
          <Coffee size={18} color="#374151" />
        )}
        <span style={{ fontSize: '14px', fontWeight: 700, color: onBreak ? '#92400E' : '#111827' }}>
          {onBreak ? t('hkLunchEnd', lang) : t('hkLunchStart', lang)}
        </span>
      </span>
      {onBreak && (
        <span style={{ fontSize: '13px', color: '#92400E', fontWeight: 600 }}>
          {elapsedMin} {t('hkLunchMinutesSuffix', lang)}
        </span>
      )}
    </button>
  );
}
