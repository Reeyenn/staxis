'use client';

// Small Financials card for the owner Dashboard — connects the two surfaces and
// proves single-source revenue: it reads the SAME /api/financials/summary the
// Financials page header uses, so the two can never disagree. Manager-gated
// (returns null for non-owner/GM/admin and when no property is active), styled
// to match the Dashboard's existing glass cards (Compliance, Lost & Found).

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useCan } from '@/lib/capabilities/useCan';
import { monthKey, formatCentsCompact, type FinanceSummary } from '@/lib/financials/shared';
import { apiGet } from './fin-ui';

const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";
const FONT_MONO = 'var(--font-geist-mono), ui-monospace, monospace';

export function FinancialsDashboardCard() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const can = useCan();
  const { lang } = useLang();
  const router = useRouter();
  const [summary, setSummary] = useState<FinanceSummary | null>(null);

  const canSee = !!user && can('view_financials');

  useEffect(() => {
    if (!canSee || !activePropertyId) return;
    let alive = true;
    const month = monthKey(new Date());
    void apiGet<{ summary: FinanceSummary }>(`/api/financials/summary?pid=${activePropertyId}&month=${month}`).then((res) => {
      if (alive && res.ok && res.data) setSummary(res.data.summary);
    });
    return () => {
      alive = false;
    };
  }, [canSee, activePropertyId]);

  if (!canSee || !activePropertyId) return null;

  const ink = 'var(--snow-ink)';
  const ink2 = 'var(--snow-ink2)';
  const ink3 = 'var(--snow-ink3)';
  const rule = 'var(--snow-rule)';
  const sage = 'var(--snow-sage-deep)';
  const warm = 'var(--snow-warm)';

  const rows: Array<[string, string, string]> = [
    [
      lang === 'es' ? 'Ingresos' : 'Revenue',
      summary?.revenueCents != null ? formatCentsCompact(summary.revenueCents) : '—',
      ink,
    ],
    [lang === 'es' ? 'Gastos' : 'Expenses', formatCentsCompact(summary?.expensesCents ?? 0), ink],
    [
      lang === 'es' ? 'Ganancia' : 'Profit',
      summary?.profitCents != null ? formatCentsCompact(summary.profitCents) : '—',
      summary?.profitCents != null ? (summary.profitCents >= 0 ? sage : warm) : ink3,
    ],
  ];

  return (
    <div
      onClick={() => router.push('/financials')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') router.push('/financials');
      }}
      style={{
        background: 'rgba(255,255,255,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.75)',
        borderRadius: 16,
        padding: '16px 18px',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: ink2 }}>
        {lang === 'es' ? 'Finanzas' : 'Financials'}
      </div>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(([k, v, color]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderBottom: `1px dotted ${rule}`, paddingBottom: 6 }}>
            <span style={{ fontSize: 13.5, color: ink2 }}>{k}</span>
            <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 22, fontWeight: 500, color, letterSpacing: '-0.025em', lineHeight: 1 }}>{v}</span>
          </div>
        ))}
        <div style={{ fontSize: 11.5, color: ink3 }}>{lang === 'es' ? 'Ver Finanzas →' : 'View Financials →'}</div>
      </div>
    </div>
  );
}
