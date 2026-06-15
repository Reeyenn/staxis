'use client';

// Labor Cost tile for the owner Dashboard's "Right now" strip. Shows today's
// whole-hotel labor cost as a % of revenue, costed from the PUBLISHED schedule
// × resolved wages (see /api/dashboard/labor-cost). Manager-gated: returns null
// for non-owner/GM/admin and when no property is active — labor dollars +
// wages are sensitive pay data. Styled to match the sibling glass cards
// (Compliance, Lost & Found, Financials). Honest empty states, never fake
// numbers.

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { formatCentsCompact } from '@/lib/financials/shared';
import { fetchLaborCost, type LaborCostSummary } from '@/lib/db';

const C = {
  ink: '#15191A',
  ink2: '#586056',
  ink3: '#9CA29C',
  rule: 'rgba(15,20,17,0.07)',
  sage: '#3F7950',
  caramel: '#B8853A',
  warm: '#B85C3D',
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

const bandColor = (status: LaborCostSummary['status']): string =>
  status === 'over' ? C.warm : status === 'warn' ? C.caramel : C.sage;

export function LaborCostCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const [summary, setSummary] = useState<LaborCostSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const can = useCan();

  const canSee = !!user && can('view_wages');

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    setLoaded(false);
    void fetchLaborCost(activePropertyId).then((s) => {
      if (alive) { setSummary(s); setLoaded(true); }
    });
    return () => { alive = false; };
  }, [canSee, activePropertyId]);

  if (!canSee || !activePropertyId) return null;

  const es = lang === 'es';

  // ── Decide what the hero number + sub-lines say (honest empty states) ──
  let hero: React.ReactNode = '—';
  let heroColor: string = C.ink3;
  let sub: React.ReactNode = es ? 'Cargando…' : 'Loading…';

  if (loaded) {
    if (!summary) {
      hero = '—';
      sub = es ? 'No disponible' : 'Unavailable';
    } else if (!summary.schedulePublished) {
      hero = '—';
      heroColor = C.ink3;
      sub = es ? 'Publica el horario de esta semana para ver el % laboral' : "Publish this week's schedule to see labor %";
    } else if (summary.pct == null) {
      // Revenue unknown/0 → show cost only, hide the %.
      hero = formatCentsCompact(summary.laborCostCents);
      heroColor = C.ink;
      sub = es ? 'costo laboral de hoy · sin datos de ingresos aún' : "today's labor cost · no revenue data yet";
    } else {
      hero = `${summary.pct}%`;
      heroColor = bandColor(summary.status);
      sub = es
        ? `${formatCentsCompact(summary.laborCostCents)} de ${formatCentsCompact(summary.revenueCents)} en ingresos`
        : `${formatCentsCompact(summary.laborCostCents)} of ${formatCentsCompact(summary.revenueCents)} revenue`;
    }
  }

  const showSetWages = !!summary && summary.schedulePublished && summary.missingWages;
  const showTarget = !!summary && summary.pct != null;

  return (
    <div
      onClick={() => router.push('/settings/wages')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') router.push('/settings/wages'); }}
      style={{
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 16,
        padding: '16px 18px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={LABEL}>{es ? 'Costo laboral' : 'Labor cost'}</div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontFamily: FONT_SERIF, fontStyle: 'italic',
          fontSize: 40, fontWeight: 500, color: heroColor,
          letterSpacing: '-0.03em', lineHeight: 1,
        }}>
          {hero}
        </span>
        {showTarget && (
          <span style={{ fontSize: 11.5, color: C.ink3, fontFamily: FONT_MONO }}>
            {es ? `meta ${summary!.targetPct}%` : `target ${summary!.targetPct}%`}
          </span>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: C.ink2, lineHeight: 1.4 }}>{sub}</div>

      {showSetWages && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: C.caramel, fontWeight: 600 }}>
          {es ? 'Faltan salarios — Configurar →' : 'Some wages unset — Set wages →'}
        </div>
      )}
    </div>
  );
}
