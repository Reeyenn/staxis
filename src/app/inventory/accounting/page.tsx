'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Inventory Accounting — first slice of an in-app accounting module.
//
// Strategic positioning: Tara, the regional director, and every other GM we
// surveyed currently emails a spreadsheet to accounting at month-end. We're
// replacing that workflow with an in-app financial view that's the source
// of truth for inventory financials. Hotels still required to feed M3
// (Hilton-mandated) copy from this page rather than from their own
// spreadsheets.
//
// Structure:
//   • Month picker (defaults to current UTC month)
//   • 4-card summary: opening, this-month spend (receipts), discards,
//     closing
//   • Per-category table with budget vs actual + prior-month delta
//   • Reconciliation summary (this-month $-impact of unaccounted shrinkage)
//   • YTD bar chart (12 months of receipts by category)
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { InventoryCategory } from '@/types';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { ArrowLeft, Calendar, DollarSign, TrendingDown, AlertTriangle, Wallet, Calculator } from 'lucide-react';
import { formatCurrency as formatCurrencyBase } from '@/lib/utils';

const formatCurrency = (n: number | null | undefined) => formatCurrencyBase(n, true);

const CATEGORY_LABEL = (cat: InventoryCategory, lang: 'en' | 'es') =>
  cat === 'housekeeping' ? (lang === 'es' ? 'Limpieza' : 'Housekeeping')
  : cat === 'maintenance' ? (lang === 'es' ? 'Mantenimiento' : 'Maintenance')
  : (lang === 'es' ? 'Desayuno' : 'Breakfast');

const CATEGORY_COLORS: Record<InventoryCategory, string> = {
  housekeeping: '#006565',
  maintenance:  '#364262',
  breakfast:    '#c98a14',
};

interface CategoryRow {
  category: InventoryCategory;
  openingValue: number;
  receiptsValue: number;
  discardsValue: number;
  closingValue: number;
  unaccountedShrinkageValue: number;
  reconciliationsThisMonth: number;
  budgetCents: number | null;
  spendCents: number;
  remainingCents: number | null;
  vsPriorMonthDelta: number;
}

interface SummaryResponse {
  monthStart: string;
  monthEndExclusive: string;
  totals: {
    openingValue: number;
    receiptsValue: number;
    discardsValue: number;
    closingValue: number;
    unaccountedShrinkageValue: number;
    budgetCents: number | null;
    spendCents: number;
    remainingCents: number | null;
  };
  byCategory: CategoryRow[];
  ytd: Array<{
    monthStart: string;
    receiptsValue: number;
    discardsValue: number;
    byCategory: Record<InventoryCategory, number>;
  }>;
}

export default function InventoryAccountingPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const today = useMemo(() => new Date(), []);
  const defaultMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
  const [month, setMonth] = useState<string>(defaultMonth);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/inventory/accounting-summary?propertyId=${activePropertyId}&month=${month}`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || json.detail || 'fetch_failed');
        if (cancelled) return;
        setSummary(json.data as SummaryResponse);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, activePropertyId, month]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split('-');
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1))
      .toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'long', year: 'numeric' });
  }, [month, lang]);

  const monthOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    for (let i = 0; i < 24; i++) {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
      const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', year: 'numeric' });
      options.push({ value, label });
    }
    return options;
  }, [today, lang]);

  const ytdChartData = useMemo(() => {
    if (!summary) return [];
    return summary.ytd.map(b => {
      const d = new Date(`${b.monthStart}T00:00:00Z`);
      return {
        month: d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short' }),
        Housekeeping: Math.round(b.byCategory.housekeeping),
        Maintenance: Math.round(b.byCategory.maintenance),
        Breakfast: Math.round(b.byCategory.breakfast),
      };
    });
  }, [summary, lang]);

  if (!user || !activePropertyId) {
    return (
      <AppLayout>
        <div style={{ padding: '40px 24px', fontFamily: "'Inter', sans-serif", color: '#757684' }}>
          {lang === 'es' ? 'Cargando…' : 'Loading…'}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Link href="/inventory" style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 12px', borderRadius: '9999px',
              border: '1px solid #c5c5d4', background: '#fff', color: '#454652',
              fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
              textDecoration: 'none',
            }}>
              <ArrowLeft size={14} />
              {lang === 'es' ? 'Inventario' : 'Inventory'}
            </Link>
            <h1 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '24px', color: '#1b1c19', margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Calculator size={22} color="#364262" />
              {lang === 'es' ? 'Contabilidad' : 'Accounting'}
            </h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Calendar size={14} color="#757684" />
            <select
              value={month}
              onChange={e => setMonth(e.target.value)}
              style={{
                padding: '8px 14px', borderRadius: '9999px',
                border: '1px solid #c5c5d4', background: '#fff',
                fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#1b1c19',
                cursor: 'pointer',
              }}
            >
              {monthOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div style={{
            padding: '14px 18px', borderRadius: '14px',
            background: 'rgba(186,26,26,0.08)', color: '#ba1a1a',
            fontFamily: "'Inter', sans-serif", fontSize: '13px', marginBottom: '20px',
          }}>
            {lang === 'es' ? 'Error al cargar:' : 'Error loading:'} {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#757684', fontFamily: "'Inter', sans-serif" }}>
            {lang === 'es' ? 'Cargando…' : 'Loading…'}
          </div>
        ) : summary ? (
          <>
            {/* 4-card summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '24px' }}>
              <SummaryCard
                icon={<Wallet size={18} color="#454652" />}
                label={lang === 'es' ? 'Apertura' : 'Opening Value'}
                value={formatCurrency(summary.totals.openingValue)}
                subtitle={lang === 'es' ? 'Inicio de mes (estimado)' : 'Start of month (est.)'}
              />
              <SummaryCard
                icon={<DollarSign size={18} color="#006565" />}
                label={lang === 'es' ? 'Recibido' : 'Received'}
                value={formatCurrency(summary.totals.receiptsValue)}
                subtitle={lang === 'es' ? 'Compras este mes' : 'Purchases this month'}
              />
              <SummaryCard
                icon={<TrendingDown size={18} color="#ba1a1a" />}
                label={lang === 'es' ? 'Descartes' : 'Discards'}
                value={formatCurrency(summary.totals.discardsValue)}
                subtitle={lang === 'es' ? 'Stained / dañado / robo' : 'Stained / damaged / theft'}
              />
              <SummaryCard
                icon={<Calculator size={18} color="#364262" />}
                label={lang === 'es' ? 'Cierre' : 'Closing Value'}
                value={formatCurrency(summary.totals.closingValue)}
                subtitle={lang === 'es' ? 'Stock × costo unitario' : 'Stock × unit cost'}
              />
            </div>

            {/* Per-category table */}
            <div style={{ background: '#fff', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)', marginBottom: '24px' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: '0 0 14px' }}>
                {lang === 'es' ? `Por categoría · ${monthLabel}` : `By category · ${monthLabel}`}
              </h2>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(197,197,212,0.4)' }}>
                      <Th>{lang === 'es' ? 'Categoría' : 'Category'}</Th>
                      <Th align="right">{lang === 'es' ? 'Apertura' : 'Opening'}</Th>
                      <Th align="right">{lang === 'es' ? 'Recibido' : 'Receipts'}</Th>
                      <Th align="right">{lang === 'es' ? 'Descartes' : 'Discards'}</Th>
                      <Th align="right">{lang === 'es' ? 'Cierre' : 'Closing'}</Th>
                      <Th align="right">{lang === 'es' ? 'Presupuesto' : 'Budget'}</Th>
                      <Th align="right">{lang === 'es' ? 'Restante' : 'Remaining'}</Th>
                      <Th align="right">{lang === 'es' ? 'Δ vs prev' : 'Δ vs prev'}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byCategory.map(row => (
                      <tr key={row.category} style={{ borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
                        <Td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: CATEGORY_COLORS[row.category] }} />
                            {CATEGORY_LABEL(row.category, lang)}
                          </span>
                        </Td>
                        <Td align="right">{formatCurrency(row.openingValue)}</Td>
                        <Td align="right">{formatCurrency(row.receiptsValue)}</Td>
                        <Td align="right" tone={row.discardsValue > 0 ? 'warn' : 'neutral'}>{formatCurrency(row.discardsValue)}</Td>
                        <Td align="right">{formatCurrency(row.closingValue)}</Td>
                        <Td align="right">
                          {row.budgetCents != null
                            ? `$${(row.budgetCents / 100).toFixed(0)}`
                            : <span style={{ color: '#757684' }}>—</span>}
                        </Td>
                        <Td align="right" tone={row.remainingCents != null && row.remainingCents < 0 ? 'bad' : 'neutral'}>
                          {row.remainingCents != null
                            ? `$${(row.remainingCents / 100).toFixed(0)}`
                            : <span style={{ color: '#757684' }}>—</span>}
                        </Td>
                        <Td align="right" tone={row.vsPriorMonthDelta < 0 ? 'bad' : row.vsPriorMonthDelta > 0 ? 'good' : 'neutral'}>
                          {row.vsPriorMonthDelta === 0 ? '—' : `${row.vsPriorMonthDelta > 0 ? '+' : ''}${formatCurrency(Math.abs(row.vsPriorMonthDelta))}`}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Reconciliation summary */}
            {(summary.totals.unaccountedShrinkageValue > 0 || summary.byCategory.some(r => r.reconciliationsThisMonth > 0)) && (
              <div style={{
                background: summary.totals.unaccountedShrinkageValue > 0 ? 'rgba(186,26,26,0.06)' : 'rgba(0,101,101,0.06)',
                borderRadius: '20px', padding: '18px 20px', marginBottom: '24px',
                display: 'flex', alignItems: 'center', gap: '14px',
              }}>
                <AlertTriangle size={22} color={summary.totals.unaccountedShrinkageValue > 0 ? '#ba1a1a' : '#006565'} />
                <div>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 700, color: summary.totals.unaccountedShrinkageValue > 0 ? '#ba1a1a' : '#006565' }}>
                    {lang === 'es' ? 'Reconciliación' : 'Reconciliation'}
                  </div>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#454652', marginTop: '2px' }}>
                    {summary.totals.unaccountedShrinkageValue > 0
                      ? (lang === 'es'
                        ? `Pérdida no contabilizada este mes: ${formatCurrency(summary.totals.unaccountedShrinkageValue)}.`
                        : `Unaccounted shrinkage this month: ${formatCurrency(summary.totals.unaccountedShrinkageValue)}.`)
                      : (lang === 'es' ? 'Reconciliación al día.' : 'Reconciliation looks clean.')}
                  </div>
                </div>
              </div>
            )}

            {/* YTD chart */}
            <div style={{ background: '#fff', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: '0 0 14px' }}>
                {lang === 'es' ? 'Gasto últimos 12 meses' : 'Spend — last 12 months'}
              </h2>
              <div style={{ width: '100%', height: '300px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ytdChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(197,197,212,0.4)" />
                    <XAxis dataKey="month" stroke="#757684" style={{ fontFamily: "'Inter', sans-serif", fontSize: 11 }} />
                    <YAxis stroke="#757684" style={{ fontFamily: "'Inter', sans-serif", fontSize: 11 }} tickFormatter={v => `$${v}`} />
                    <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                    <Legend />
                    <Bar dataKey="Housekeeping" stackId="a" fill={CATEGORY_COLORS.housekeeping} />
                    <Bar dataKey="Maintenance"  stackId="a" fill={CATEGORY_COLORS.maintenance} />
                    <Bar dataKey="Breakfast"    stackId="a" fill={CATEGORY_COLORS.breakfast} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </AppLayout>
  );
}

function SummaryCard({ icon, label, value, subtitle }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle: string;
}) {
  return (
    <div style={{ background: '#fff', borderRadius: '20px', padding: '18px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        {icon}
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 700, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </span>
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '24px', fontWeight: 700, color: '#1b1c19' }}>
        {value}
      </div>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '4px' }}>
        {subtitle}
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      textAlign: align, padding: '8px 10px',
      fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700,
      color: '#757684', textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', tone = 'neutral' }: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const color = tone === 'good' ? '#006565' : tone === 'warn' ? '#7a5400' : tone === 'bad' ? '#ba1a1a' : '#1b1c19';
  return (
    <td style={{
      textAlign: align, padding: '10px',
      fontFamily: "'Inter', sans-serif", fontSize: '13px', color,
    }}>
      {children}
    </td>
  );
}
