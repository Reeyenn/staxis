'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Inventory Reports — single consolidated view replacing Analytics + Accounting
// + Owner Report.
//
// The ICP (small-hotel GM) found three separate buttons confusing — all of
// them said "show me numbers about inventory" but the UI fragmented the
// information. This page is the canonical place for any inventory number,
// scoped to a single month.
//
// Sections (top-down, single scroll, no tabs):
//   1. Month picker + "Send to Owner" button
//   2. 4 hero cards: Opening / Spent / Lost / Closing
//   3. Per-category table: Budget vs Actual + Δ vs prior month
//   4. Top 5 problem items (combined discards + unaccounted shrinkage $)
//   5. 12-month spending trend (stacked bar, by category)
//   6. Cost-per-occupied-room (this month vs last month)
//
// Data: /api/inventory/accounting-summary returns everything; this page just
// renders. The summary includes top problem items and cost-per-occupied-room
// (added to AccountingSummary on 2026-05-10 as part of the Reports merge).
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useState, useCallback } from 'react';
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
import {
  ArrowLeft, Calendar, DollarSign, TrendingDown, AlertTriangle, Wallet, Calculator,
  FileText, Bed, Printer,
} from 'lucide-react';
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
  topProblemItems: Array<{
    itemId: string;
    itemName: string;
    discardValue: number;
    discardQty: number;
    unaccountedValue: number;
  }>;
  costPerOccupiedRoom: {
    thisMonth: number | null;
    lastMonth: number | null;
    occupiedNightsThisMonth: number;
    occupiedNightsLastMonth: number;
  };
}

export default function InventoryReportsPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading, properties } = useProperty();
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

  const propertyName = useMemo(() => {
    return properties.find(p => p.id === activePropertyId)?.name ?? 'Property';
  }, [properties, activePropertyId]);

  // ─── Send to Owner: copy/print a plain-text summary of this month ──────
  const handleSendToOwner = useCallback(() => {
    if (!summary) return;
    const lines: string[] = [];
    lines.push(`${propertyName} — ${lang === 'es' ? 'Reporte de Inventario' : 'Inventory Report'}`);
    lines.push(monthLabel);
    lines.push('');
    lines.push(`${lang === 'es' ? 'Resumen' : 'Summary'}:`);
    lines.push(`  ${lang === 'es' ? 'Apertura' : 'Opening'}: ${formatCurrency(summary.totals.openingValue)}`);
    lines.push(`  ${lang === 'es' ? 'Compras' : 'Purchases'}: ${formatCurrency(summary.totals.receiptsValue)}`);
    lines.push(`  ${lang === 'es' ? 'Pérdidas' : 'Losses'}: ${formatCurrency(summary.totals.discardsValue)}`);
    lines.push(`  ${lang === 'es' ? 'Cierre' : 'Closing'}: ${formatCurrency(summary.totals.closingValue)}`);
    lines.push('');
    lines.push(`${lang === 'es' ? 'Por categoría' : 'By category'}:`);
    for (const row of summary.byCategory) {
      const label = CATEGORY_LABEL(row.category, lang);
      const budget = row.budgetCents != null ? `, ${lang === 'es' ? 'presup.' : 'budget'} $${(row.budgetCents / 100).toFixed(0)}` : '';
      lines.push(`  ${label}: ${formatCurrency(row.receiptsValue)} ${lang === 'es' ? 'gastado' : 'spent'}${budget}`);
    }
    if (summary.topProblemItems.length > 0) {
      lines.push('');
      lines.push(`${lang === 'es' ? 'Top pérdidas' : 'Top problem items'}:`);
      for (const p of summary.topProblemItems) {
        lines.push(`  ${p.itemName}: ${formatCurrency(p.discardValue + p.unaccountedValue)}`);
      }
    }
    if (summary.costPerOccupiedRoom.thisMonth != null) {
      lines.push('');
      lines.push(`${lang === 'es' ? 'Costo por habitación ocupada' : 'Cost per occupied room'}: ${formatCurrency(summary.costPerOccupiedRoom.thisMonth)}`);
    }
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(
      () => alert(lang === 'es' ? 'Reporte copiado al portapapeles ✓' : 'Report copied to clipboard ✓'),
      () => alert(lang === 'es' ? 'No se pudo copiar' : 'Copy failed'),
    );
  }, [summary, monthLabel, lang, propertyName]);

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
              <FileText size={22} color="#364262" />
              {lang === 'es' ? 'Reportes' : 'Reports'}
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
            <button
              onClick={handleSendToOwner}
              disabled={!summary}
              style={{
                padding: '8px 14px', borderRadius: '9999px',
                border: 'none', background: '#364262', color: '#fff',
                fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
                cursor: summary ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', gap: '6px',
                opacity: summary ? 1 : 0.5,
              }}
            >
              <Printer size={13} />
              {lang === 'es' ? 'Enviar al dueño' : 'Send to Owner'}
            </button>
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
            {/* 4-card hero summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '24px' }}>
              <SummaryCard
                icon={<Wallet size={18} color="#454652" />}
                label={lang === 'es' ? 'Apertura' : 'Opening Value'}
                value={formatCurrency(summary.totals.openingValue)}
                subtitle={lang === 'es' ? 'Inicio de mes (estimado)' : 'Start of month (est.)'}
              />
              <SummaryCard
                icon={<DollarSign size={18} color="#006565" />}
                label={lang === 'es' ? 'Comprado' : 'Spent'}
                value={formatCurrency(summary.totals.receiptsValue)}
                subtitle={lang === 'es' ? 'Compras este mes' : 'Purchases this month'}
              />
              <SummaryCard
                icon={<TrendingDown size={18} color="#ba1a1a" />}
                label={lang === 'es' ? 'Perdido' : 'Lost'}
                value={formatCurrency(summary.totals.discardsValue + summary.totals.unaccountedShrinkageValue)}
                subtitle={lang === 'es' ? 'Manchado / dañado / no contado' : 'Stained / damaged / unaccounted'}
              />
              <SummaryCard
                icon={<Calculator size={18} color="#364262" />}
                label={lang === 'es' ? 'Cierre' : 'Closing Value'}
                value={formatCurrency(summary.totals.closingValue)}
                subtitle={lang === 'es' ? 'Stock × costo unitario' : 'Stock × unit cost'}
              />
            </div>

            {/* Per-category budget vs actual */}
            <div style={{ background: '#fff', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)', marginBottom: '24px' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: '0 0 14px' }}>
                {lang === 'es' ? `Por categoría · ${monthLabel}` : `By category · ${monthLabel}`}
              </h2>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(197,197,212,0.4)' }}>
                      <Th>{lang === 'es' ? 'Categoría' : 'Category'}</Th>
                      <Th align="right">{lang === 'es' ? 'Comprado' : 'Spent'}</Th>
                      <Th align="right">{lang === 'es' ? 'Perdido' : 'Lost'}</Th>
                      <Th align="right">{lang === 'es' ? 'Cierre' : 'Closing'}</Th>
                      <Th align="right">{lang === 'es' ? 'Presupuesto' : 'Budget'}</Th>
                      <Th align="right">{lang === 'es' ? 'Restante' : 'Remaining'}</Th>
                      <Th align="right">{lang === 'es' ? 'Δ vs prev' : 'Δ vs prev'}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byCategory.map(row => {
                      const lostValue = row.discardsValue + row.unaccountedShrinkageValue;
                      return (
                        <tr key={row.category} style={{ borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
                          <Td>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: CATEGORY_COLORS[row.category] }} />
                              {CATEGORY_LABEL(row.category, lang)}
                            </span>
                          </Td>
                          <Td align="right">{formatCurrency(row.receiptsValue)}</Td>
                          <Td align="right" tone={lostValue > 0 ? 'warn' : 'neutral'}>{formatCurrency(lostValue)}</Td>
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Top 5 problem items */}
            {summary.topProblemItems.length > 0 && (
              <div style={{ background: '#fff', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)', marginBottom: '24px' }}>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertTriangle size={16} color="#ba1a1a" />
                  {lang === 'es' ? 'Top problemas este mes' : 'Top problem items this month'}
                </h2>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '0 0 14px' }}>
                  {lang === 'es'
                    ? 'Combinado: descartes ($) + pérdidas no contadas ($).'
                    : 'Combined: discards ($) + unaccounted shrinkage ($).'}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {summary.topProblemItems.map((p, i) => {
                    const total = p.discardValue + p.unaccountedValue;
                    const max = summary.topProblemItems[0]
                      ? summary.topProblemItems[0].discardValue + summary.topProblemItems[0].unaccountedValue
                      : 1;
                    const pct = max > 0 ? Math.round((total / max) * 100) : 0;
                    return (
                      <div key={p.itemId} style={{
                        display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: '12px', alignItems: 'center',
                      }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#757684' }}>
                          #{i + 1}
                        </span>
                        <div>
                          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#1b1c19', fontWeight: 600 }}>
                            {p.itemName}
                          </div>
                          <div style={{ background: '#f0eee9', borderRadius: '4px', height: '6px', marginTop: '4px', overflow: 'hidden' }}>
                            <div style={{ background: '#ba1a1a', width: `${pct}%`, height: '100%' }} />
                          </div>
                          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '4px' }}>
                            {p.discardValue > 0 && (lang === 'es' ? `${p.discardQty} descartados` : `${p.discardQty} discarded`)}
                            {p.discardValue > 0 && p.unaccountedValue > 0 && ' · '}
                            {p.unaccountedValue > 0 && (lang === 'es' ? `${formatCurrency(p.unaccountedValue)} no contado` : `${formatCurrency(p.unaccountedValue)} unaccounted`)}
                          </div>
                        </div>
                        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '14px', fontWeight: 700, color: '#ba1a1a' }}>
                          {formatCurrency(total)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 12-month spending trend */}
            <div style={{ background: '#fff', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)', marginBottom: '24px' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: '0 0 14px' }}>
                {lang === 'es' ? 'Gasto últimos 12 meses' : 'Spending — last 12 months'}
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

            {/* Cost per occupied room */}
            <div style={{ background: '#fff', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 8px rgba(27,28,25,0.04)' }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Bed size={16} color="#364262" />
                {lang === 'es' ? 'Costo por habitación ocupada' : 'Cost per occupied room'}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
                <CprStat
                  label={lang === 'es' ? 'Este mes' : 'This month'}
                  value={summary.costPerOccupiedRoom.thisMonth}
                  detail={
                    summary.costPerOccupiedRoom.occupiedNightsThisMonth > 0
                      ? `${summary.costPerOccupiedRoom.occupiedNightsThisMonth} ${lang === 'es' ? 'noches ocupadas' : 'occupied nights'}`
                      : (lang === 'es' ? 'Sin datos de ocupación' : 'No occupancy data')
                  }
                  emphasized
                />
                <CprStat
                  label={lang === 'es' ? 'Mes pasado' : 'Last month'}
                  value={summary.costPerOccupiedRoom.lastMonth}
                  detail={
                    summary.costPerOccupiedRoom.occupiedNightsLastMonth > 0
                      ? `${summary.costPerOccupiedRoom.occupiedNightsLastMonth} ${lang === 'es' ? 'noches ocupadas' : 'occupied nights'}`
                      : (lang === 'es' ? 'Sin datos' : 'No data')
                  }
                />
                {summary.costPerOccupiedRoom.thisMonth != null && summary.costPerOccupiedRoom.lastMonth != null && (
                  <CprDelta
                    thisMonth={summary.costPerOccupiedRoom.thisMonth}
                    lastMonth={summary.costPerOccupiedRoom.lastMonth}
                    lang={lang}
                  />
                )}
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

function CprStat({ label, value, detail, emphasized }: {
  label: string;
  value: number | null;
  detail: string;
  emphasized?: boolean;
}) {
  return (
    <div>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700, color: '#757684', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: emphasized ? '28px' : '20px',
        fontWeight: 700,
        color: '#1b1c19',
        marginTop: '4px',
      }}>
        {value != null ? formatCurrency(value) : '—'}
      </div>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '4px' }}>
        {detail}
      </div>
    </div>
  );
}

function CprDelta({ thisMonth, lastMonth, lang }: { thisMonth: number; lastMonth: number; lang: 'en' | 'es' }) {
  const diff = thisMonth - lastMonth;
  const pct = lastMonth > 0 ? Math.round((diff / lastMonth) * 100) : 0;
  const isUp = diff > 0;
  const tone = isUp ? '#ba1a1a' : '#006565'; // higher cost = bad, lower = good
  return (
    <div>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700, color: '#757684', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {lang === 'es' ? 'Cambio' : 'Change'}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '20px',
        fontWeight: 700,
        color: tone,
        marginTop: '4px',
      }}>
        {isUp ? '+' : ''}{formatCurrency(diff)}
      </div>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '4px' }}>
        {isUp ? '↑' : '↓'} {Math.abs(pct)}% {lang === 'es' ? 'vs mes pasado' : 'vs last month'}
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
