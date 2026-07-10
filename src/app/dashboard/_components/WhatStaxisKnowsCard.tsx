'use client';

// "What Staxis knows" — compact owner-Dashboard box. A small summary of the
// hotel-wide knowledge Staxis has built + an HONEST impact strip (real counts
// only; dollar ROI is a "turns on with live data" line, never fabricated).
// Manager-gated; reads via /api/memory/knows. Shows a one-line ready-state when
// empty so the box is visible from day one. The full fact lists live in the copilot
// ("what do you know about my hotel") + the "What Staxis noticed" card above.

import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { GlassCard } from './GlassCard';
import { CARD, CARD_SERIF, CARD_LABEL } from './palette';

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

// This compact box runs a smaller label than the other cards.
const LABEL: React.CSSProperties = { ...CARD_LABEL, fontSize: 9, letterSpacing: '0.16em' };

export function WhatStaxisKnowsCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();

  const es = lang === 'es';
  const canSee = !!user && canManageTeam(user.role);

  const { data, loading } = useApiResource<KnowsData>(
    `/api/memory/knows?propertyId=${activePropertyId}`,
    { enabled: canSee && !!activePropertyId },
  );

  if (!canSee || !activePropertyId || loading || !data) return null;

  const { stats } = data;
  const empty = stats.totalKnown === 0;

  const tiles: Array<[string, number]> = [
    [es ? 'Sabe' : 'Known', stats.totalKnown],
    [es ? 'Patrones 30d' : 'Patterns 30d', stats.patternsThisMonth],
    [es ? 'Detectados' : 'Flagged early', stats.issuesCaughtEarly],
  ];

  return (
    <GlassCard radius={14} padding="12px 14px" maxWidth={440}>
      <div style={LABEL}>{es ? 'Lo que Staxis sabe' : 'What Staxis knows'}</div>

      {/* compact inline impact stats — real counts only */}
      <div style={{ marginTop: 9, display: 'flex', gap: 20 }}>
        {tiles.map((t) => (
          <div key={t[0]}>
            <div style={{ fontFamily: CARD_SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 20, lineHeight: 1, color: CARD.ink, fontVariantNumeric: 'tabular-nums' }}>
              {t[1]}
            </div>
            <div style={{ ...LABEL, fontSize: 8.5, marginTop: 4 }}>{t[0]}</div>
          </div>
        ))}
      </div>

      {!empty && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: CARD.ink2 }}>
          {data.taught.length} {es ? 'enseñados' : 'taught'} · {data.noticed.length} {es ? 'notados' : 'noticed'} · {data.learned.length} {es ? 'aprendidos' : 'learned'}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 10.5, color: CARD.ink3, lineHeight: 1.45 }}>
        {empty
          ? es
            ? 'Listo — se llena a medida que tu equipo registra actividad.'
            : 'Ready — fills in as your team logs activity.'
          : es
            ? 'El impacto en dólares aparece cuando se conecten los datos de ingresos y nómina.'
            : 'Dollar impact appears once your live revenue & labor data is connected.'}
      </div>
    </GlassCard>
  );
}
