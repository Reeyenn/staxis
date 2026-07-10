'use client';

export const dynamic = 'force-dynamic';

// Financials — GM/owner finance suite (Checkbook · Budget · CapEx) with a live
// summary header (revenue from the PMS, profit = revenue − expenses). Gated to
// owner / general_manager / admin: the tab is hidden for everyone else, this
// page redirects non-managers, and every /api/financials/* route enforces the
// same gate server-side (defense in depth). Reads/writes go through /api with
// the service-role finance gate — no anon finance reads anywhere.
//
// Visual: the "Kanban" Snow redesign — serif headline, 4-up summary tiles,
// board-style tabs. The data layer is unchanged; this is a re-skin.

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCan } from '@/lib/capabilities/useCan';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { monthLabelFromYm } from '@/lib/format-date';
import { monthKey, priorMonthKey, type FinanceSummary } from '@/lib/financials/shared';
import { Notice, T, FONT_SANS, FONT_SERIF, FONT_MONO } from './_components/fin-ui';
import { SummaryTile, BigMoney } from './_components/fin-board';
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

export default function FinancialsPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const can = useCan();
  const { lang } = useLang();
  const router = useRouter();
  const S = ft(lang as Lang);

  const [tab, setTab] = useState<TabKey>('checkbook');
  const [month, setMonth] = useState(() => monthKey(new Date()));
  // Bumped by onChanged() after any tab mutation. It rides the URL as a
  // FRAGMENT (never sent over HTTP) so useApiResource treats the refetch as a
  // new resource — replaying the same "Loading…" flash the old load() showed.
  const [summaryNonce, setSummaryNonce] = useState(0);

  const currentMonth = monthKey(new Date());
  const allowed = !!user && can('view_financials');

  // Redirect a restricted role away (client guard; the API gate is the real
  // enforcement). `allowed` honors this hotel's Access-tab restrictions and
  // re-evaluates once the override map finishes loading.
  useEffect(() => {
    if (authLoading || propLoading) return;
    if (!user) {
      router.replace('/signin');
      return;
    }
    if (!allowed) {
      router.replace('/dashboard');
    }
  }, [user, authLoading, propLoading, allowed, router]);

  const summaryRes = useApiResource<{ summary: FinanceSummary }>(
    `/api/financials/summary?pid=${activePropertyId}&month=${month}#${summaryNonce}`,
    { enabled: !!activePropertyId },
  );
  const summary = summaryRes.data?.summary ?? null;
  // Not-yet-fetched reads as loading (loading starts false while the property
  // id is still resolving, and only flips true in a post-paint effect — the
  // old code showed "Loading…" from the first paint). On error it still
  // falls through to the tile fallbacks, exactly like the old code.
  const summaryLoading = summaryRes.loading || (summaryRes.data == null && summaryRes.error == null);

  // Tabs call this after any mutation so the header totals stay live.
  const onTabChanged = useCallback(() => setSummaryNonce((n) => n + 1), []);

  if (authLoading || propLoading || !allowed) {
    return (
      <AppLayout>
        <div style={{ background: T.bg, minHeight: 'calc(100dvh - 64px)', padding: 60, textAlign: 'center', fontFamily: FONT_SANS, color: T.ink2 }}>{S.loading}</div>
      </AppLayout>
    );
  }

  if (!activePropertyId) {
    return (
      <AppLayout>
        <div style={{ background: T.bg, minHeight: 'calc(100dvh - 64px)', padding: 60, textAlign: 'center', fontFamily: FONT_SANS, color: T.ink2 }}>{S.loading}</div>
      </AppLayout>
    );
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'checkbook', label: S.tabCheckbook },
    { key: 'budget', label: S.tabBudget },
    { key: 'capex', label: S.tabCapex },
  ];

  // Margin = profit / revenue (whole %), only when revenue is known.
  const marginPct =
    summary?.revenueCents != null && summary.revenueCents > 0 && summary.profitCents != null
      ? Math.round((summary.profitCents / summary.revenueCents) * 100)
      : null;

  return (
    <AppLayout>
      <div style={{ background: T.bg, minHeight: 'calc(100dvh - 64px)' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px clamp(16px,3vw,40px) 96px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontFamily: FONT_SERIF, fontSize: 44, fontWeight: 400, color: T.ink, margin: 0, letterSpacing: '-0.02em', lineHeight: 1 }}>
              {S.title}
            </h1>
            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, margin: '6px 0 0' }}>{S.tagline}</p>
          </div>
          {/* Month stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setMonth(priorMonthKey(month))} style={stepBtn} aria-label="Previous month">
              ‹
            </button>
            <span style={{ fontFamily: FONT_SERIF, fontSize: 17, fontWeight: 600, color: T.ink, minWidth: 116, textAlign: 'center', textTransform: 'capitalize' }}>
              {monthLabelFromYm(month, lang)}
            </span>
            <button
              onClick={() => setMonth(nextMonthKey(month))}
              style={{ ...stepBtn, opacity: month >= currentMonth ? 0.35 : 1, pointerEvents: month >= currentMonth ? 'none' : 'auto' }}
              aria-label="Next month"
            >
              ›
            </button>
          </div>
        </div>

        {/* Summary tiles */}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          {summaryLoading ? (
            <div style={{ flex: 1 }}>
              <Notice text={S.loading} />
            </div>
          ) : (
            <>
              <SummaryTile label={S.revenue} sub={S.fromPms}>
                {summary?.revenueCents != null ? (
                  <BigMoney cents={summary.revenueCents} />
                ) : (
                  <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3 }}>{S.noRevenueYet}</span>
                )}
              </SummaryTile>
              <SummaryTile label={S.expenses}>
                <BigMoney cents={summary?.expensesCents ?? 0} color={T.warm} />
              </SummaryTile>
              <SummaryTile label={S.profit}>
                {summary?.profitCents != null ? (
                  <BigMoney cents={summary.profitCents} color={summary.profitCents >= 0 ? T.sageDeep : T.warm} />
                ) : (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 18, color: T.ink3 }}>—</span>
                )}
              </SummaryTile>
              <SummaryTile label={S.margin}>
                {marginPct != null ? (
                  <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 27, fontWeight: 500, color: T.ink, letterSpacing: '-0.02em' }}>{marginPct}%</span>
                ) : (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 18, color: T.ink3 }}>—</span>
                )}
              </SummaryTile>
              {summary?.costPerOccupiedRoomCents != null && (
                <SummaryTile label={S.costPerRoom}>
                  <BigMoney cents={summary.costPerOccupiedRoomCents} size={24} showCents />
                </SummaryTile>
              )}
              {summary?.expensesPctOfRevenue != null && (
                <SummaryTile label={S.pctOfRevenue}>
                  <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 27, fontWeight: 500, color: T.ink, letterSpacing: '-0.02em' }}>{summary.expensesPctOfRevenue.toFixed(0)}%</span>
                </SummaryTile>
              )}
            </>
          )}
        </div>
        {!summaryLoading && summary?.revenueCents == null && (
          <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3, margin: '12px 0 0', fontStyle: 'italic' }}>{S.revenueComingSoon}</p>
        )}

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 26, borderBottom: `1px solid ${T.rule}`, margin: '24px 0 0' }}>
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
                  padding: '0 0 12px',
                  fontFamily: FONT_SANS,
                  fontSize: 16,
                  fontWeight: active ? 700 : 500,
                  color: active ? T.ink : T.ink3,
                  borderBottom: active ? `2px solid ${T.ink}` : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Active tab */}
        <div style={{ marginTop: 22 }}>
          {tab === 'checkbook' && <CheckbookTab pid={activePropertyId} lang={lang as Lang} month={month} onChanged={onTabChanged} />}
          {tab === 'budget' && <BudgetTab pid={activePropertyId} lang={lang as Lang} month={month} onChanged={onTabChanged} />}
          {tab === 'capex' && <CapexTab pid={activePropertyId} lang={lang as Lang} onChanged={onTabChanged} />}
        </div>
        </div>
      </div>
    </AppLayout>
  );
}

const stepBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 9,
  border: `1px solid ${T.rule}`,
  background: 'transparent',
  color: T.ink2,
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  display: 'grid',
  placeItems: 'center',
};
