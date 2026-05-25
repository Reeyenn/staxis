'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle, Clock, Coffee, Timer } from 'lucide-react';
import type { HousekeeperLocale } from '@/lib/translations';
// Locally aliased so piece-A code keeps reading `lang: Language` everywhere.
type Language = HousekeeperLocale;
import { t } from '@/lib/translations';

/**
 * DailySummary — end-of-shift recap. Rendered at the bottom of the page
 * when the housekeeper has finished every assigned room (or taps the
 * "View summary" affordance manually).
 *
 * Pulls data from /api/housekeeper/daily-summary.
 */

interface Summary {
  staffName: string | null;
  date: string;
  totalAssigned: number;
  roomsCleaned: number;
  roomsRemaining: number;
  activeCleaningMinutes: number;
  averageMinutesPerRoom: number;
  lunchMinutes: number;
  shortBreakMinutes: number;
  shiftStartedAt: string | null;
  shiftEndedAt: string | null;
}

interface Props {
  pid: string;
  staffId: string;
  date: string;
  lang: Language;
  visible: boolean;
}

export function DailySummary({ pid, staffId, date, lang, visible }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/housekeeper/daily-summary?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(staffId)}&date=${encodeURIComponent(date)}`,
        );
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: Summary } | null;
        if (!cancelled && res.ok && json?.ok && json.data) {
          setData(json.data);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid, staffId, date, visible]);

  if (!visible) return null;
  if (loading && !data) {
    return (
      <div
        style={{
          padding: '24px',
          textAlign: 'center',
          background: 'white',
          borderRadius: '16px',
          boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
          color: '#6B7280',
        }}
      >
        ...
      </div>
    );
  }
  if (!data) return null;

  const shiftHours = data.shiftStartedAt && data.shiftEndedAt
    ? Math.max(
        0,
        (Date.parse(data.shiftEndedAt) - Date.parse(data.shiftStartedAt)) / 3_600_000,
      )
    : 0;

  return (
    <div
      style={{
        background: 'white',
        border: '1.5px solid var(--green-light, #86EFAC)',
        borderRadius: '20px',
        padding: '20px',
        boxShadow: '0 2px 12px rgba(22,101,52,0.10)',
      }}
    >
      <h2 style={{ fontSize: '18px', fontWeight: 800, color: '#0F172A', margin: '0 0 14px 0' }}>
        {t('hkSummaryTitle', lang)}
      </h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '10px',
        }}
      >
        <StatTile
          icon={<CheckCircle size={18} color="#15803D" />}
          label={t('hkSummaryRoomsCleaned', lang)}
          value={`${data.roomsCleaned} / ${data.totalAssigned}`}
        />
        <StatTile
          icon={<Timer size={18} color="#2563EB" />}
          label={t('hkSummaryActiveMinutes', lang)}
          value={`${Math.round(data.activeCleaningMinutes)} ${t('hkLunchMinutesSuffix', lang)}`}
        />
        <StatTile
          icon={<Clock size={18} color="#7C3AED" />}
          label={t('hkSummaryAveragePerRoom', lang)}
          value={
            data.averageMinutesPerRoom > 0
              ? `${data.averageMinutesPerRoom} ${t('hkLunchMinutesSuffix', lang)}`
              : '—'
          }
        />
        <StatTile
          icon={<Coffee size={18} color="#B45309" />}
          label={t('hkSummaryLunchMinutes', lang)}
          value={
            data.lunchMinutes > 0
              ? `${Math.round(data.lunchMinutes)} ${t('hkLunchMinutesSuffix', lang)}`
              : '—'
          }
        />
      </div>

      <div
        style={{
          marginTop: '14px',
          fontSize: '13px',
          color: '#6B7280',
          textAlign: 'center',
        }}
      >
        {t('hkSummaryShiftHours', lang)}: {shiftHours.toFixed(1)} h
        {data.roomsRemaining > 0 && (
          <>
            {' · '}
            {data.roomsRemaining} {t('hkSummaryStillToGo', lang).toLowerCase()}
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div
      style={{
        padding: '12px 14px',
        background: '#F9FAFB',
        border: '1px solid #E5E7EB',
        borderRadius: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        {icon}
        <span style={{ fontSize: '11px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: '20px', fontWeight: 800, color: '#0F172A', lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}
