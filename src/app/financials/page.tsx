'use client';

export const dynamic = 'force-dynamic';

// Financials — GM/owner finance suite (Checkbook · Budget · CapEx) with a live
// summary header (revenue from the PMS, profit = revenue − expenses). Gated to
// owner / general_manager / admin: the tab is hidden for everyone else, this
// page redirects non-managers, and every /api/financials/* route enforces the
// same gate server-side (defense in depth). Reads/writes go through /api with
// the service-role finance gate — no anon finance reads anywhere.

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { canViewFinancials } from '@/lib/roles';
import { monthKey, priorMonthKey, type FinanceSummary } from '@/lib/financials/shared';
import { apiGet, Money, Card, Notice, T, FONT_SANS, FONT_SERIF, FONT_MONO } from './_components/fin-ui';
import { ft } from './_components/fin-i18n';
import { CheckbookTab } from './_components/CheckbookTab';
import { BudgetTab } from './_components/BudgetTab';
import { CapexTab } from './_components/CapexTab';

type Lang = 'en' | 'es';
type TabKey = 'checkbook' | 'budget' | 'capex';

function nextMonthKey(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  const ny = mm === 12 ? y + 1 : y;
  const nm = mm === 12 ? 1 : mm + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
function monthDisplay(m: string, lang: Lang): string {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function FinancialsPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const S = ft(lang as Lang);

  const [tab, setTab] = useState<TabKey>('checkbook');
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const currentMonth = monthKey(new Date());
  const allowed = !!user && canViewFinancials(user.role);

  // Redirect non-managers away (client guard; API gate is the real enforcement).
  useEffect(() => {
    if (authLoading || propLoading) return;
    if (!user) {
      router.replace('/signin');
      return;
    }
    if (!canViewFinancials(user.role)) {
      router.replace('/dashboard');
    }
  }, [user, authLoading, propLoading, router]);

  const loadSummary = useCallback(async () => {
    if (!activePropertyId) return;
    setSummaryLoading(true);
    const res = await apiGet<{ summary: FinanceSummary }>(`/api/financials/summary?pid=${activePropertyId}&month=${month}`);
    setSummary(res.ok && res.data ? res.data.summary : null);
    setSummaryLoading(false);
  }, [activePropertyId, month]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  if (authLoading || propLoading || !allowed) {
    return (
      <AppLayout>
        <div style={{ padding: 60, textAlign: 'center', fontFamily: FONT_SANS, color: T.ink2 }}>{S.loading}</div>
      </AppLayout>
    );
  }

  if (!activePropertyId) {
    return (
      <AppLayout>
        <div style={{ padding: 60, textAlign: 'center', fontFamily: FONT_SANS, color: T.ink2 }}>{S.loading}</div>
      </AppLayout>
    );
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'checkbook', label: S.tabCheckbook },
    { key: 'budget', label: S.tabBudget },
    { key: 'capex', label: S.tabCapex },
  ];

  return (
    <AppLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px clamp(16px,3vw,48px) 96px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontFamily: FONT_SERIF, fontSize: 40, fontWeight: 400, color: T.ink, margin: 0, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              {S.title}
            </h1>
            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, margin: '4px 0 0' }}>{S.tagline}</p>
          </div>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => setMonth(priorMonthKey(month))} style={navBtn} aria-label="Previous month">
              ‹
            </button>
            <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink, minWidth: 130, textAlign: 'center', textTransform: 'capitalize' }}>
              {monthDisplay(month, lang as Lang)}
            </span>
            <button
              onClick={() => setMonth(nextMonthKey(month))}
              style={{ ...navBtn, opacity: month >= currentMonth ? 0.35 : 1, pointerEvents: month >= currentMonth ? 'none' : 'auto' }}
              aria-label="Next month"
            >
              ›
            </button>
          </div>
        </div>

        {/* Summary */}
        <Card style={{ marginBottom: 24, padding: 20 }}>
          {summaryLoading ? (
            <Notice text={S.loading} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 20 }}>
              <Stat label={S.revenue} sub={S.fromPms}>
                {summary?.revenueCents != null ? (
                  <Money cents={summary.revenueCents} size={24} />
                ) : (
                  <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3 }}>{S.noRevenueYet}</span>
                )}
              </Stat>
              <Stat label={S.expenses}>
                <Money cents={summary?.expensesCents ?? 0} size={24} />
              </Stat>
              <Stat label={S.profit}>
                {summary?.profitCents != null ? (
                  <Money cents={summary.profitCents} size={24} color={summary.profitCents >= 0 ? T.sageDeep : T.warm} />
                ) : (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 18, color: T.ink3 }}>—</span>
                )}
              </Stat>
              {summary?.costPerOccupiedRoomCents != null && (
                <Stat label={S.costPerRoom}>
                  <Money cents={summary.costPerOccupiedRoomCents} size={20} />
                </Stat>
              )}
              {summary?.expensesPctOfRevenue != null && (
                <Stat label={S.pctOfRevenue}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 22, fontWeight: 600, color: T.ink }}>{summary.expensesPctOfRevenue.toFixed(0)}%</span>
                </Stat>
              )}
            </div>
          )}
          {!summaryLoading && summary?.revenueCents == null && (
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3, margin: '14px 0 0', fontStyle: 'italic' }}>{S.revenueComingSoon}</p>
          )}
        </Card>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 28, borderBottom: `1px solid ${T.rule}`, marginBottom: 24 }}>
          {tabs.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 0 12px',
                  fontFamily: FONT_SANS,
                  fontSize: 14,
                  fontWeight: active ? 600 : 500,
                  color: active ? T.ink : T.ink2,
                  borderBottom: active ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                  marginBottom: -1,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Active tab */}
        {tab === 'checkbook' && <CheckbookTab pid={activePropertyId} lang={lang as Lang} month={month} onChanged={loadSummary} />}
        {tab === 'budget' && <BudgetTab pid={activePropertyId} lang={lang as Lang} month={month} onChanged={loadSummary} />}
        {tab === 'capex' && <CapexTab pid={activePropertyId} lang={lang as Lang} onChanged={loadSummary} />}
      </div>
    </AppLayout>
  );
}

function Stat({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 6 }}>
        {label}
        {sub && <span style={{ color: T.ink3, marginLeft: 5, textTransform: 'none', letterSpacing: 0 }}>· {sub}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const navBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: `1px solid ${T.rule}`,
  background: 'transparent',
  color: T.ink,
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
};
