'use client';

// Upcoming Events card for the Dashboard. Shows the next few upcoming team
// calendar events (date + title) with a "Go to Calendar" deep-link into
// Communications. Visible to management + front_desk (same gate as
// LogBookCard). ADDITIVE-ONLY: renders nothing until loaded AND there is at
// least one upcoming event, so the dashboard is unchanged on a fresh hotel
// (same posture as LogBookCard / MemoryRecapCard). Reads go through
// /api/knowledge/events (service-role behind a session + property access).

import React, { useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { useSectionEnabled } from '@/lib/sections/useSectionEnabled';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { useTodayStr } from '@/lib/use-today-str';
import { GlassCard } from './GlassCard';
import { CARD, CARD_MONO, CARD_LABEL } from './palette';

interface CalEvent {
  id: string;
  title: string;
  eventDate: string;      // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD or null (single-day)
}

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
  // Upcoming events live under Communications — hide this embed when that
  // section is off for the hotel (default-ON while loading).
  const commsEnabled = useSectionEnabled('communications');

  const es = lang === 'es';
  // Management OR front desk — same gate as the Log Book card.
  const canSee = !!user && (canManageTeam(user.role) || user.role === 'front_desk');

  // Communications-owned embed: `enabled` gates the FETCH, not just the
  // render — nothing hits the wire when the section is off. The hook drops
  // the prior property's data on switch, so a slow OR failed reload can
  // never flash the wrong hotel's calendar. Polled so newly added events
  // appear on a long-lived (wall-TV) dashboard without a reload;
  // keepDataOnError holds last-good through a failed poll.
  const { data, loading } = useApiResource<{ events: CalEvent[] }>(
    `/api/knowledge/events?pid=${encodeURIComponent(activePropertyId ?? '')}`,
    { enabled: canSee && !!activePropertyId && commsEnabled, pollMs: 60_000, keepDataOnError: true },
  );

  // The route returns events ascending by start date. Keep only those that
  // haven't finished yet (today inclusive) and take the soonest few.
  // `today` is reactive (midnight rollover, same hook as the page hero) —
  // pinning it at fetch time left an ended event listed as "upcoming"
  // forever on an always-open dashboard.
  const today = useTodayStr();
  const events = useMemo(() => {
    const list = data?.events ?? [];
    return list.filter((e) => (e.endDate ?? e.eventDate) >= today).slice(0, 4);
  }, [data, today]);

  if (!canSee || !activePropertyId || !commsEnabled) return null;
  // Additive-only: nothing to show until there's at least one upcoming event.
  if (loading || events.length === 0) return null;

  return (
    <GlassCard>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={CARD_LABEL}>{es ? 'Próximos eventos' : 'Upcoming events'}</div>
        <Link
          href="/communications?view=calendar"
          style={{
            fontFamily: CARD_MONO,
            fontSize: 11,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: CARD.green,
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
              borderTop: i === 0 ? 'none' : `1px solid ${CARD.rule}`,
              textDecoration: 'none',
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, color: CARD.ink, lineHeight: 1.4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.title}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: CARD.ink3, marginTop: 2 }}>
                {fmtRange(e.eventDate, e.endDate, es)}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </GlassCard>
  );
}
