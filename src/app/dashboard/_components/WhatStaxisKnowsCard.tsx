'use client';

// "What Staxis knows about your hotel" + impact — owner Dashboard.
// The full picture of the hotel-wide knowledge Staxis has built (grouped by where
// it came from) plus an HONEST impact strip: real counts only. Dollar ROI is shown
// as a "turns on with live data" state — we never fabricate savings figures.
// Manager-gated (canManageTeam); reads via /api/memory/knows (service-role behind
// a session + management gate). Renders a friendly ready-state when empty so the
// panel is visible from day one.

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
  rule: 'rgba(15,20,17,0.07)',
  line: 'rgba(15,20,17,0.10)',
} as const;

const FONT_SERIF = 'var(--font-fraunces), Georgia, serif';
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: '0.18em',
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

  const statTiles: Array<[string, number]> = [
    [es ? 'Cosas que sabe' : 'Things it knows', stats.totalKnown],
    [es ? 'Patrones este mes' : 'Patterns caught (30d)', stats.patternsThisMonth],
    [es ? 'Problemas detectados' : 'Issues flagged early', stats.issuesCaughtEarly],
  ];

  const groups: Array<[string, KnowItem[]]> = [
    [es ? 'Le enseñaste' : 'You taught it', data.taught],
    [es ? 'Lo notó en las operaciones' : 'It noticed in operations', data.noticed],
    [es ? 'Lo aprendió de conversaciones' : 'It learned from conversations', data.learned],
  ];

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
      <div style={LABEL}>{es ? 'Lo que Staxis sabe de tu hotel' : 'What Staxis knows about your hotel'}</div>

      {/* Impact strip — real counts only */}
      <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 22 }}>
        {statTiles.map((t, i) => (
          <div key={t[0]} style={{ flex: 1, minWidth: 120, paddingLeft: i === 0 ? 0 : 22, borderLeft: i === 0 ? 'none' : `1px solid ${C.line}` }}>
            <div style={{ ...LABEL, marginBottom: 6 }}>{t[0]}</div>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 26, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
              {t[1]}
            </div>
          </div>
        ))}
      </div>

      {/* Honest ROI line — no fabricated dollars */}
      <div style={{ marginTop: 14, fontSize: 12.5, color: C.ink2, lineHeight: 1.5 }}>
        {es
          ? 'Cada problema recurrente que Staxis detecta temprano es una avería evitada. El impacto en dólares (ahorro de personal y tiempo de inactividad evitado) aparecerá aquí cuando se conecten los datos de ingresos y nómina de tu hotel.'
          : 'Every recurring issue Staxis flags early is a breakdown avoided. Dollar impact — labor saved and downtime prevented — will appear here once your hotel’s live revenue & labor data is connected.'}
      </div>

      {empty ? (
        <div style={{ marginTop: 14, fontSize: 13.5, color: C.ink2, lineHeight: 1.45, borderTop: `1px solid ${C.rule}`, paddingTop: 14 }}>
          {es
            ? 'Staxis está listo. Empieza a aprender sobre tu hotel en cuanto tu equipo registre actividad — quejas, reparaciones, inspecciones — y desde tus conversaciones con el copiloto.'
            : 'Staxis is ready. It starts learning your hotel the moment your team logs activity — complaints, repairs, inspections — and from your chats with the copilot.'}
        </div>
      ) : (
        groups
          .filter((g) => g[1].length > 0)
          .map((g) => (
            <div key={g[0]} style={{ marginTop: 16 }}>
              <div style={LABEL}>
                {g[0]} ({g[1].length})
              </div>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' }}>
                {g[1].slice(0, 12).map((it) => (
                  <div key={it.id} style={{ padding: '7px 0', borderTop: `1px solid ${C.rule}`, fontSize: 13.5, color: C.ink2, lineHeight: 1.4 }}>
                    {it.content}
                  </div>
                ))}
              </div>
            </div>
          ))
      )}
    </div>
  );
}
