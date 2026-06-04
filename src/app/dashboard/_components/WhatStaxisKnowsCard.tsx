'use client';

// "What Staxis knows" — compact owner-Dashboard box. A small summary of the
// hotel-wide knowledge Staxis has built + an HONEST impact strip (real counts
// only; dollar ROI is a "turns on with live data" line, never fabricated).
// Manager-gated; reads via /api/memory/knows. Shows a one-line ready-state when
// empty so the box is visible from day one. The full fact lists live in the copilot
// ("what do you know about my hotel") + the "What Staxis noticed" card above.

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';

interface KnowItem {
  id: string;
  topic: string;
  content: string;
}
interface KnowsData {
  stats: { totalKnown: number; patternsThisMonth: number; issuesCaughtEarly: number };
  taught: KnowItem[];
  noticed: KnowItem[];
  learned: KnowItem[];
}

const C = {
  ink: '#15191A',
  ink2: '#586056',
  ink3: '#9CA29C',
} as const;

const FONT_SERIF = 'var(--font-fraunces), Georgia, serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 9,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: C.ink3,
  fontWeight: 600,
};

export function WhatStaxisKnowsCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const [data, setData] = useState<KnowsData | null>(null);
  const [loaded, setLoaded] = useState(false);

  const es = lang === 'es';
  const canSee = !!user && canManageTeam(user.role);

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    setLoaded(false);
    fetch(`/api/memory/knows?propertyId=${activePropertyId}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive) {
          setData(j?.ok ? (j.data as KnowsData) : null);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [canSee, activePropertyId]);

  if (!canSee || !activePropertyId || !loaded || !data) return null;

  const { stats } = data;
  const empty = stats.totalKnown === 0;

  const tiles: Array<[string, number]> = [
    [es ? 'Sabe' : 'Known', stats.totalKnown],
    [es ? 'Patrones 30d' : 'Patterns 30d', stats.patternsThisMonth],
    [es ? 'Detectados' : 'Flagged early', stats.issuesCaughtEarly],
  ];

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 14,
        padding: '12px 14px',
        maxWidth: 440,
      }}
    >
      <div style={LABEL}>{es ? 'Lo que Staxis sabe' : 'What Staxis knows'}</div>

      {/* compact inline impact stats — real counts only */}
      <div style={{ marginTop: 9, display: 'flex', gap: 20 }}>
        {tiles.map((t) => (
          <div key={t[0]}>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 20, lineHeight: 1, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
              {t[1]}
            </div>
            <div style={{ ...LABEL, fontSize: 8.5, marginTop: 4 }}>{t[0]}</div>
          </div>
        ))}
      </div>

      {!empty && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.ink2 }}>
          {data.taught.length} {es ? 'enseñados' : 'taught'} · {data.noticed.length} {es ? 'notados' : 'noticed'} · {data.learned.length} {es ? 'aprendidos' : 'learned'}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 10.5, color: C.ink3, lineHeight: 1.45 }}>
        {empty
          ? es
            ? 'Listo — se llena a medida que tu equipo registra actividad.'
            : 'Ready — fills in as your team logs activity.'
          : es
            ? 'El impacto en dólares aparece cuando se conecten los datos de ingresos y nómina.'
            : 'Dollar impact appears once your live revenue & labor data is connected.'}
      </div>
    </div>
  );
}
