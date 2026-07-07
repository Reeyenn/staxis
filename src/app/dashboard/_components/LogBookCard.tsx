'use client';

// Shift Log Book card for the Dashboard. Shows the latest few recaps (title +
// when + reply count) with a "Go to Log Book" deep-link into Communications.
// Visible to management + front_desk. ADDITIVE-ONLY: renders nothing until
// loaded AND there is at least one recap, so the dashboard is unchanged on a
// fresh hotel (same posture as MemoryRecapCard). Reads go through
// /api/comms/logbook (service-role behind a session + property access).

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useSectionEnabled } from '@/lib/sections/useSectionEnabled';

interface LogEntry {
  id: string;
  title: string;
  authorName: string | null;
  replyCount: number;
  createdAt: string;
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

function fmtWhen(iso: string, es: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(es ? 'es' : 'en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function LogBookCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  // The shift log book lives under Communications — hide this embed when that
  // section is off for the hotel (default-ON while loading).
  const commsEnabled = useSectionEnabled('communications');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const es = lang === 'es';
  // Management OR front desk — the people doing shift handoffs.
  const canSee = !!user && (canManageTeam(user.role) || user.role === 'front_desk');

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    setLoaded(false);
    fetchWithAuth(`/api/comms/logbook?pid=${encodeURIComponent(activePropertyId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const list = (j?.ok ? (j.data?.entries as LogEntry[] | undefined) : undefined) ?? [];
        setEntries(list.slice(0, 4));
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [canSee, activePropertyId]);

  if (!canSee || !activePropertyId || !commsEnabled) return null;
  // Additive-only: nothing to show until there's at least one recap.
  if (!loaded || entries.length === 0) return null;

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
        <div style={LABEL}>{es ? 'Bitácora' : 'Log book'}</div>
        <Link
          href="/communications?view=logbook"
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
              borderTop: i === 0 ? 'none' : `1px solid ${C.rule}`,
              textDecoration: 'none',
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, color: C.ink, lineHeight: 1.4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.title}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: C.ink3, marginTop: 2 }}>
                {[e.authorName, fmtWhen(e.createdAt, es)].filter(Boolean).join(' · ')}
                {e.replyCount > 0 && ` · ${e.replyCount} ${e.replyCount === 1 ? (es ? 'respuesta' : 'reply') : (es ? 'respuestas' : 'replies')}`}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
