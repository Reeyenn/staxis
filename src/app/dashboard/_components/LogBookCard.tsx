'use client';

// Shift Log Book card for the Dashboard. Shows the latest few recaps (title +
// when + reply count) with a "Go to Log Book" deep-link into Communications.
// Visible to management + front_desk. ADDITIVE-ONLY: renders nothing until
// loaded AND there is at least one recap, so the dashboard is unchanged on a
// fresh hotel (same posture as MemoryRecapCard). Reads go through
// /api/comms/logbook (service-role behind a session + property access).

import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { useSectionEnabled } from '@/lib/sections/useSectionEnabled';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fmtWhenDateTime } from '@/lib/format-date';
import { GlassCard } from './GlassCard';
import { CARD, CARD_MONO, CARD_LABEL } from './palette';

interface LogEntry {
  id: string;
  title: string;
  authorName: string | null;
  replyCount: number;
  createdAt: string;
}

export function LogBookCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  // The shift log book lives under Communications — hide this embed when that
  // section is off for the hotel (default-ON while loading).
  const commsEnabled = useSectionEnabled('communications');

  const es = lang === 'es';
  // Management OR front desk — the people doing shift handoffs.
  const canSee = !!user && (canManageTeam(user.role) || user.role === 'front_desk');

  // Communications-owned embed: `enabled` gates the FETCH, not just the
  // render — nothing hits the wire when the section is off. Polled so new
  // shift recaps appear on a long-lived (wall-TV) dashboard without a reload;
  // keepDataOnError holds last-good through a failed poll.
  const { data, loading } = useApiResource<{ entries: LogEntry[] }>(
    `/api/comms/logbook?pid=${encodeURIComponent(activePropertyId ?? '')}`,
    { enabled: canSee && !!activePropertyId && commsEnabled, pollMs: 60_000, keepDataOnError: true },
  );

  if (!canSee || !activePropertyId || !commsEnabled) return null;
  const entries = (data?.entries ?? []).slice(0, 4);
  // Additive-only: nothing to show until there's at least one recap.
  if (loading || entries.length === 0) return null;

  return (
    <GlassCard>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={CARD_LABEL}>{es ? 'Bitácora' : 'Log book'}</div>
        <Link
          href="/communications?view=logbook"
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
          {es ? 'Ir a la bitácora →' : 'Go to Log Book →'}
        </Link>
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
        {entries.map((e, i) => (
          <Link
            key={e.id}
            href="/communications?view=logbook"
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
                {[e.authorName, fmtWhenDateTime(e.createdAt, lang)].filter(Boolean).join(' · ')}
                {e.replyCount > 0 && ` · ${e.replyCount} ${e.replyCount === 1 ? (es ? 'respuesta' : 'reply') : (es ? 'respuestas' : 'replies')}`}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </GlassCard>
  );
}
