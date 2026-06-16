'use client';

// Upcoming Events card for the Dashboard. Shows the next few upcoming team
// calendar events (date + title) with a "Go to Calendar" deep-link into
// Communications. Visible to management + front_desk (same gate as
// LogBookCard). ADDITIVE-ONLY: renders nothing until loaded AND there is at
// least one upcoming event, so the dashboard is unchanged on a fresh hotel
// (same posture as LogBookCard / MemoryRecapCard). Reads go through
// /api/knowledge/events (service-role behind a session + property access).

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { fetchWithAuth } from '@/lib/api-fetch';

interface CalEvent {
  id: string;
  title: string;
  eventDate: string;      // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD or null (single-day)
}

const C = {
  ink: '#15191A',
  ink2: '#586056',
  ink3: '#9CA29C',
  rule: 'rgba(15,20,17,0.07)',
  green: '#2F7A51',
} as const;

const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: C.ink3,
  fontWeight: 600,
};

// Format a date range the same way the Calendar tab does (weekday · month · day).
function fmtRange(start: string, end: string | null, es: boolean): string {
  const loc = es ? 'es' : 'en';
  const fmt = (d: string) => {
    const dt = new Date(d + 'T00:00:00');
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString(loc, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  if (!end || end === start) return fmt(start);
  return `${fmt(start)} → ${fmt(end)}`;
}

export function CalendarCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const es = lang === 'es';
  // Management OR front desk — same gate as the Log Book card.
  const canSee = !!user && (canManageTeam(user.role) || user.role === 'front_desk');

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    setLoaded(false);
    fetchWithAuth(`/api/knowledge/events?pid=${encodeURIComponent(activePropertyId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const list = (j?.ok ? (j.data?.events as CalEvent[] | undefined) : undefined) ?? [];
        // The route returns events ascending by start date. Keep only those that
        // haven't finished yet (today inclusive) and take the soonest few.
        const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
        const upcoming = list
          .filter((e) => (e.endDate ?? e.eventDate) >= todayStr)
          .slice(0, 4);
        setEvents(upcoming);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [canSee, activePropertyId]);

  if (!canSee || !activePropertyId) return null;
  // Additive-only: nothing to show until there's at least one upcoming event.
  if (!loaded || events.length === 0) return null;

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 16,
        padding: '18px 20px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={LABEL}>{es ? 'Próximos eventos' : 'Upcoming events'}</div>
        <Link
          href="/communications?view=calendar"
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: C.green,
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          {es ? 'Ir al calendario →' : 'Go to Calendar →'}
        </Link>
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
        {events.map((e, i) => (
          <Link
            key={e.id}
            href="/communications?view=calendar"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              padding: '9px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${C.rule}`,
              textDecoration: 'none',
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, color: C.ink, lineHeight: 1.4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.title}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: C.ink3, marginTop: 2 }}>
                {fmtRange(e.eventDate, e.endDate, es)}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
