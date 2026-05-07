'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Cross-Property Inventory Comparison
//
// For multi-property operators (Robert with 10+ hotels). Sits OUTSIDE the
// usual property-scoped pattern: instead of using activePropertyId, this
// page queries every property in PropertyContext.properties in parallel.
//
// 5 sections:
//   1. Summary table — best (green) / worst (red) highlighting per column,
//      sortable
//   2. Cost-per-occupied-room line chart — one line per property, monthly
//   3. Shrinkage bar chart — one bar per property, sorted worst→best
//   4. Category-spend stacked bar — one bar per property, stacked by cat
//   5. Outlier alerts — flag any property >1.5 σ from mean on any metric
//
// Date range selector (30/90/All). Property pills (toggle on/off).
// Bilingual.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { listInventoryOrders, listInventoryCounts } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import type { InventoryItem, InventoryCategory, InventoryOrder, InventoryCount, Property } from '@/types';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { ArrowLeft, AlertTriangle, ChevronUp, ChevronDown } from 'lucide-react';

// ─── Helpers ────────────────────────────────────────────────────────────────
import { formatCurrency as formatCurrencyBase } from '@/lib/utils';
const formatCurrency = (n: number | null | undefined): string => formatCurrencyBase(n, true);

const CATEGORY_COLORS: Record<InventoryCategory, string> = {
  housekeeping: '#006565',
  maintenance:  '#364262',
  breakfast:    '#c98a14',
};
const CATEGORY_LABEL = (cat: InventoryCategory, lang: 'en' | 'es') =>
  cat === 'housekeeping' ? (lang === 'es' ? 'Limpieza' : 'Housekeeping')
  : cat === 'maintenance' ? (lang === 'es' ? 'Mantenimiento' : 'Maintenance')
  : (lang === 'es' ? 'Desayuno' : 'Breakfast');

const PROPERTY_COLORS = ['#006565', '#364262', '#c98a14', '#ba1a1a', '#7c3aed', '#0066cc', '#dc2c8a', '#454652'];

// ─── Types ──────────────────────────────────────────────────────────────────
interface PropertyMetrics {
  propertyId: string;
  propertyName: string;
  inventoryValue: number;
  monthlySpend: number;       // average over period, normalized to /month
  shrinkage: number;          // negative number
  costPerRoom: number;        // 0 if not computable
  stockHealth: number;        // 0-100
  categorySpend: { housekeeping: number; maintenance: number; breakfast: number };
  monthlySeries: Array<{ month: string; costPerRoom: number }>;
}

type Range = '30' | '90' | 'all';
type SortKey = 'name' | 'inventoryValue' | 'monthlySpend' | 'shrinkage' | 'costPerRoom' | 'stockHealth';

// ─── Page ───────────────────────────────────────────────────────────────────
export default function ComparePage() {
  const { user, loading: authLoading } = useAuth();
  const { properties, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [range, setRange] = useState<Range>('90');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [metrics, setMetrics] = useState<PropertyMetrics[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('inventoryValue');
  const [sortAsc, setSortAsc] = useState(false);

  // Auth
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
  }, [user, authLoading, propLoading, router]);

  // Default-select all properties when the list loads.
  useEffect(() => {
    if (properties.length > 0 && selectedIds.size === 0) {
      setSelectedIds(new Set(properties.map(p => p.id)));
    }
  }, [properties, selectedIds.size]);

  // Window start in ms.
  const rangeStart = useMemo(() => {
    if (range === 'all') return 0;
    const days = parseInt(range, 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.getTime();
  }, [range]);

  // Number of months covered, floored at 1 (avoids div-by-zero in monthly avg).
  const monthsCovered = useMemo(() => {
    if (range === 'all') return 12;
    const days = parseInt(range, 10);
    return Math.max(1, days / 30);
  }, [range]);

  // Multi-property fetch — Promise.all over each selected property.
  useEffect(() => {
    if (!user || selectedIds.size === 0) return;
    let alive = true;
    setLoading(true);

    const ids = Array.from(selectedIds);
    Promise.all(ids.map(pid => fetchPropertyMetrics(user.uid, pid, properties.find(p => p.id === pid), rangeStart, monthsCovered)))
      .then(rows => { if (alive) setMetrics(rows); })
      .catch(err => console.error('[compare] fetch failed:', err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user, selectedIds, properties, rangeStart, monthsCovered]);

  // Sort metrics for the table.
  const sortedMetrics = useMemo(() => {
    const sortable = [...metrics];
    sortable.sort((a, b) => {
      const av = sortKey === 'name' ? a.propertyName : (a as unknown as Record<string, number>)[sortKey];
      const bv = sortKey === 'name' ? b.propertyName : (b as unknown as Record<string, number>)[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return sortable;
  }, [metrics, sortKey, sortAsc]);

  // Best/worst-per-column for the green/red highlighting.
  const extremes = useMemo(() => computeExtremes(metrics), [metrics]);

  // Outlier alerts — flag values >1.5σ from mean on any metric.
  const alerts = useMemo(() => buildAlerts(metrics, lang), [metrics, lang]);

  // Cost-per-room overlay chart — merge all properties' monthly series
  // into one chart-friendly dataset keyed by month.
  const costPerRoomChartData = useMemo(() => {
    const months = new Set<string>();
    metrics.forEach(m => m.monthlySeries.forEach(s => months.add(s.month)));
    const sortedMonths = Array.from(months).sort();
    return sortedMonths.map(month => {
      const row: Record<string, string | number> = { month };
      metrics.forEach(m => {
        const found = m.monthlySeries.find(s => s.month === month);
        if (found) row[m.propertyName] = Number(found.costPerRoom.toFixed(2));
      });
      return row;
    });
  }, [metrics]);

  if (authLoading || propLoading || !user) {
    return (
      <AppLayout>
        <div style={{ padding: '60px', textAlign: 'center', color: '#757684' }}>
          {lang === 'es' ? 'Cargando...' : 'Loading...'}
        </div>
      </AppLayout>
    );
  }

  if (properties.length < 2) {
    return (
      <AppLayout>
        <div style={{ maxWidth: '600px', margin: '60px auto', padding: '24px', textAlign: 'center' }}>
          <h1 style={{ fontFamily: "'Inter', sans-serif", fontSize: '20px', fontWeight: 700, color: '#1b1c19', marginBottom: '8px' }}>
            {lang === 'es' ? 'Comparación entre propiedades' : 'Cross-Property Comparison'}
          </h1>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#757684', marginBottom: '20px' }}>
            {lang === 'es'
              ? 'Agregue más propiedades para comparar.'
              : 'Add more properties to compare.'}
          </p>
          <Link href="/inventory" style={{ color: '#006565', textDecoration: 'none', fontWeight: 600 }}>
            {lang === 'es' ? '← Volver al inventario' : '← Back to inventory'}
          </Link>
        </div>
      </AppLayout>
    );
  }

  // Helpers: best/worst class per column.
  const cellTone = (col: keyof typeof extremes, value: number): React.CSSProperties => {
    const e = extremes[col];
    if (!e || metrics.length < 2) return {};
    if (value === e.best) return { color: '#006565', fontWeight: 700 };
    if (value === e.worst) return { color: '#ba1a1a', fontWeight: 700 };
    return {};
  };

  const SortHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      onClick={() => { if (sortKey === k) setSortAsc(s => !s); else { setSortKey(k); setSortAsc(false); } }}
      style={{
        textAlign: k === 'name' ? 'left' : 'right', padding: '10px 8px',
        fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600,
        color: '#454652', textTransform: 'uppercase', letterSpacing: '0.06em',
        cursor: 'pointer', userSelect: 'none',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        {label}
        {sortKey === k && (sortAsc ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  );

  return (
    <AppLayout>
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px 24px 120px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <Link href="/inventory" style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684',
              textDecoration: 'none', marginBottom: '4px',
            }}>
              <ArrowLeft size={13} />
              {lang === 'es' ? 'Volver al inventario' : 'Back to inventory'}
            </Link>
            <h1 style={{
              fontFamily: "'Inter', sans-serif", fontSize: '24px', fontWeight: 700,
              color: '#1b1c19', margin: '4px 0 0',
            }}>
              {lang === 'es' ? 'Comparación entre Propiedades' : 'Cross-Property Comparison'}
            </h1>
          </div>
          {/* Range selector */}
          <div style={{ display: 'flex', gap: '6px', background: '#f0eee9', padding: '4px', borderRadius: '9999px' }}>
            {(['30', '90', 'all'] as const).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  padding: '6px 14px', borderRadius: '9999px', border: 'none',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer',
                  background: range === r ? '#364262' : 'transparent',
                  color: range === r ? '#fff' : '#454652',
                }}
              >
                {r === 'all' ? (lang === 'es' ? 'Todo' : 'All') : `${r}d`}
              </button>
            ))}
          </div>
        </div>

        {/* Property pills */}
        <div style={{ marginBottom: '20px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {properties.map(p => {
            const on = selectedIds.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedIds(prev => {
                    const next = new Set(prev);
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                    return next;
                  });
                }}
                style={{
                  padding: '6px 14px', borderRadius: '9999px', border: '1px solid',
                  borderColor: on ? '#006565' : '#c5c5d4',
                  background: on ? '#006565' : '#fff',
                  color: on ? '#fff' : '#454652',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {p.name}
              </button>
            );
          })}
        </div>

        {/* Outlier alerts */}
        {alerts.length > 0 && (
          <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {alerts.map((alert, i) => (
              <div key={i} style={{
                background: 'rgba(186,26,26,0.06)', border: '1px solid rgba(186,26,26,0.18)',
                borderRadius: '12px', padding: '12px 14px',
                display: 'flex', alignItems: 'center', gap: '10px',
              }}>
                <AlertTriangle size={16} color="#ba1a1a" style={{ flexShrink: 0 }} />
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#1b1c19' }}>
                  {alert}
                </span>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#757684', fontFamily: "'Inter', sans-serif" }}>
            {lang === 'es' ? 'Cargando datos de propiedades...' : 'Loading property data...'}
          </div>
        )}

        {!loading && metrics.length > 0 && (
          <>
            {/* Section 1 — Summary table */}
            <Card title={lang === 'es' ? 'Resumen Comparativo' : 'Summary Comparison'}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '720px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #c5c5d4' }}>
                      <SortHeader label={lang === 'es' ? 'Propiedad' : 'Property'} k="name" />
                      <SortHeader label={lang === 'es' ? 'Valor' : 'Inv. Value'} k="inventoryValue" />
                      <SortHeader label={lang === 'es' ? 'Gasto/Mes' : 'Monthly Spend'} k="monthlySpend" />
                      <SortHeader label={lang === 'es' ? 'Pérdida' : 'Shrinkage'} k="shrinkage" />
                      <SortHeader label={lang === 'es' ? 'Costo/Hab' : 'Cost/Room'} k="costPerRoom" />
                      <SortHeader label={lang === 'es' ? 'Salud' : 'Stock Health'} k="stockHealth" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMetrics.map(m => (
                      <tr key={m.propertyId} style={{ borderBottom: '1px solid rgba(197,197,212,0.3)' }}>
                        <td style={{ padding: '10px 8px', fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#1b1c19', fontWeight: 600 }}>{m.propertyName}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', ...cellTone('inventoryValue', m.inventoryValue) }}>{formatCurrency(m.inventoryValue)}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', ...cellTone('monthlySpend', m.monthlySpend) }}>{formatCurrency(m.monthlySpend)}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', ...cellTone('shrinkage', m.shrinkage) }}>{formatCurrency(m.shrinkage)}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', ...cellTone('costPerRoom', m.costPerRoom) }}>{m.costPerRoom > 0 ? `$${m.costPerRoom.toFixed(2)}` : '—'}</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', ...cellTone('stockHealth', m.stockHealth) }}>{Math.round(m.stockHealth)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Section 2 — Cost per occupied room overlay */}
            <Card
              title={lang === 'es' ? 'Costo por Habitación Ocupada' : 'Cost Per Occupied Room'}
              subtitle={lang === 'es' ? 'Una línea por propiedad, mensual' : 'One line per property, monthly'}
            >
              {costPerRoomChartData.length === 0 ? (
                <Empty text={lang === 'es' ? 'Necesita pedidos y datos de ocupación.' : 'Needs orders and occupancy data.'} />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={costPerRoomChartData} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                    <XAxis dataKey="month" stroke="#757684" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => `$${v.toFixed(2)}`} />
                    <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {metrics.map((m, i) => (
                      <Line key={m.propertyId} type="monotone" dataKey={m.propertyName} stroke={PROPERTY_COLORS[i % PROPERTY_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Card>

            {/* Section 3 — Shrinkage bar chart */}
            <Card
              title={lang === 'es' ? 'Pérdidas por Propiedad' : 'Shrinkage by Property'}
              subtitle={lang === 'es' ? 'Pérdida total del período (peor primero)' : 'Total period loss, sorted worst first'}
            >
              {(() => {
                const data = [...metrics]
                  .filter(m => m.shrinkage < 0)
                  .map(m => ({ name: m.propertyName, loss: Math.abs(m.shrinkage) }))
                  .sort((a, b) => b.loss - a.loss);
                if (data.length === 0) return <Empty text={lang === 'es' ? 'Sin pérdidas registradas.' : 'No losses recorded.'} />;
                return (
                  <ResponsiveContainer width="100%" height={Math.max(200, data.length * 50)}>
                    <BarChart data={data} layout="vertical" margin={{ top: 5, right: 16, left: 100, bottom: 0 }}>
                      <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => formatCurrency(v)} />
                      <YAxis type="category" dataKey="name" stroke="#454652" tick={{ fontSize: 12 }} width={100} />
                      <Tooltip formatter={(v: number) => formatCurrency(-v)} />
                      <Bar dataKey="loss" fill="#ba1a1a" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </Card>

            {/* Section 4 — Category spend stacked */}
            <Card
              title={lang === 'es' ? 'Gasto por Categoría' : 'Category Spend'}
              subtitle={lang === 'es' ? 'Apilado por categoría' : 'Stacked by category'}
            >
              {(() => {
                const data = metrics.map(m => ({
                  name: m.propertyName,
                  housekeeping: m.categorySpend.housekeeping,
                  maintenance: m.categorySpend.maintenance,
                  breakfast: m.categorySpend.breakfast,
                }));
                if (data.every(d => d.housekeeping + d.maintenance + d.breakfast === 0)) {
                  return <Empty text={lang === 'es' ? 'Sin pedidos en este período.' : 'No orders in this period.'} />;
                }
                return (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                      <XAxis dataKey="name" stroke="#757684" tick={{ fontSize: 11 }} />
                      <YAxis stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => formatCurrency(v)} />
                      <Tooltip formatter={(v: number) => formatCurrency(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="housekeeping" stackId="s" fill={CATEGORY_COLORS.housekeeping} name={CATEGORY_LABEL('housekeeping', lang)} />
                      <Bar dataKey="maintenance" stackId="s" fill={CATEGORY_COLORS.maintenance} name={CATEGORY_LABEL('maintenance', lang)} />
                      <Bar dataKey="breakfast" stackId="s" fill={CATEGORY_COLORS.breakfast} name={CATEGORY_LABEL('breakfast', lang)} />
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
}

// ─── Per-property fetch + reduce ─────────────────────────────────────────────

async function fetchPropertyMetrics(
  uid: string,
  pid: string,
  property: Property | undefined,
  rangeStart: number,
  monthsCovered: number,
): Promise<PropertyMetrics> {
  const propertyName = property?.name ?? pid.slice(0, 8);

  // Inventory items + occupancy logs in parallel.
  const [orders, counts, inventoryRows, dailyLogs] = await Promise.all([
    listInventoryOrders(uid, pid, 1000),
    listInventoryCounts(uid, pid, 1000),
    (async () => {
      const { data } = await supabase.from('inventory').select('current_stock, par_level, unit_cost, category').eq('property_id', pid);
      return (data ?? []) as Array<{ current_stock: number; par_level: number; unit_cost: number | null; category: InventoryCategory }>;
    })(),
    (async () => {
      const start = new Date();
      start.setDate(start.getDate() - 365);
      const startStr = start.toISOString().slice(0, 10);
      const { data } = await supabase.from('daily_logs').select('date, occupied').eq('property_id', pid).gte('date', startStr).order('date', { ascending: true });
      return (data ?? []) as Array<{ date: string; occupied: number }>;
    })(),
  ]);

  // Inventory value + stock health from current snapshot.
  let inventoryValue = 0;
  let healthGoodCount = 0;
  for (const r of inventoryRows) {
    if (r.unit_cost != null) inventoryValue += Number(r.unit_cost) * Number(r.current_stock ?? 0);
    const stock = Number(r.current_stock ?? 0);
    const par = Number(r.par_level ?? 0);
    if (par > 0 && stock >= par * 0.7) healthGoodCount++;
  }
  const stockHealth = inventoryRows.length > 0 ? (healthGoodCount / inventoryRows.length) * 100 : 100;

  // Period filters.
  const periodOrders = orders.filter(o => o.receivedAt && o.receivedAt.getTime() >= rangeStart);
  const periodCounts = counts.filter(c => c.countedAt && c.countedAt.getTime() >= rangeStart);
  const periodLogs = dailyLogs.filter(l => new Date(l.date + 'T00:00:00').getTime() >= rangeStart);

  const totalSpend = periodOrders.reduce((s, o) => s + (o.totalCost ?? 0), 0);
  const monthlySpend = totalSpend / monthsCovered;

  const shrinkage = periodCounts.reduce((s, c) => s + Math.min(0, c.varianceValue ?? 0), 0);

  // Cost per occupied room (period total ÷ occupied nights in period).
  const occupiedNights = periodLogs.reduce((s, l) => s + Number(l.occupied ?? 0), 0);
  const costPerRoom = occupiedNights > 0 && totalSpend > 0 ? totalSpend / occupiedNights : 0;

  // Category spend over the period.
  const inventoryItemsByOrderId = new Map<string, InventoryCategory>();
  // We don't have item.category in InventoryOrder rows directly; look it up
  // via the inventory rows we already fetched (same property, item is a subset).
  // Since inventoryRows lacks ids, fall back to looking up from a separate query
  // — but for the dashboard, just attribute orders without category lookup as
  // "housekeeping" if we can't resolve. Better: pull item rows with id+category.
  const { data: itemMap } = await supabase
    .from('inventory')
    .select('id, category')
    .eq('property_id', pid);
  const catById = new Map<string, InventoryCategory>();
  (itemMap ?? []).forEach(r => catById.set(String((r as { id: string }).id), (r as { category: InventoryCategory }).category));
  const categorySpend = { housekeeping: 0, maintenance: 0, breakfast: 0 };
  for (const o of periodOrders) {
    if (o.totalCost == null) continue;
    const cat = catById.get(o.itemId) ?? 'housekeeping';
    categorySpend[cat] += o.totalCost;
  }
  // mark unused var as intentional (kept for symmetry with audits)
  void inventoryItemsByOrderId;

  // Monthly cost-per-room series.
  const spendByMonth = new Map<string, number>();
  for (const o of periodOrders) {
    if (!o.receivedAt || o.totalCost == null) continue;
    const k = o.receivedAt.toISOString().slice(0, 7);
    spendByMonth.set(k, (spendByMonth.get(k) ?? 0) + o.totalCost);
  }
  const occByMonth = new Map<string, number>();
  for (const l of periodLogs) {
    const k = l.date.slice(0, 7);
    occByMonth.set(k, (occByMonth.get(k) ?? 0) + Number(l.occupied ?? 0));
  }
  const allMonths = new Set([...spendByMonth.keys(), ...occByMonth.keys()]);
  const monthlySeries = Array.from(allMonths).sort().map(month => {
    const spend = spendByMonth.get(month) ?? 0;
    const occ = occByMonth.get(month) ?? 0;
    if (spend === 0 || occ === 0) return null;
    return { month, costPerRoom: spend / occ };
  }).filter((r): r is { month: string; costPerRoom: number } => r !== null);

  return {
    propertyId: pid,
    propertyName,
    inventoryValue,
    monthlySpend,
    shrinkage,
    costPerRoom,
    stockHealth,
    categorySpend,
    monthlySeries,
  };
}

// ─── Best/worst extremes per metric ──────────────────────────────────────────
function computeExtremes(metrics: PropertyMetrics[]) {
  if (metrics.length === 0) return {} as Record<string, { best: number; worst: number }>;
  // For shrinkage: less negative = better. For everything else: higher = better.
  // Cost/room: lower is better. Inventory value: higher is "more capital tied up"
  // — debatable, but for simplicity we treat higher value as "better" (more healthy).
  const best = (key: keyof PropertyMetrics, direction: 'high' | 'low') => {
    const vals = metrics.map(m => m[key] as number).filter(v => typeof v === 'number');
    if (vals.length === 0) return { best: 0, worst: 0 };
    return direction === 'high'
      ? { best: Math.max(...vals), worst: Math.min(...vals) }
      : { best: Math.min(...vals), worst: Math.max(...vals) };
  };
  return {
    inventoryValue: best('inventoryValue', 'high'),
    monthlySpend:   best('monthlySpend', 'low'),
    shrinkage:      best('shrinkage', 'high'), // higher = less negative = better
    costPerRoom:    best('costPerRoom', 'low'),
    stockHealth:    best('stockHealth', 'high'),
  };
}

// ─── Outlier alerts: >1.5σ from mean ─────────────────────────────────────────
function buildAlerts(metrics: PropertyMetrics[], lang: 'en' | 'es'): string[] {
  if (metrics.length < 3) return []; // need ≥3 properties for stdev to be meaningful
  const alerts: string[] = [];
  const checks: Array<{ key: keyof PropertyMetrics; direction: 'high' | 'low'; format: (m: PropertyMetrics) => string }> = [
    { key: 'costPerRoom', direction: 'high', format: m => lang === 'es'
      ? `${m.propertyName} gasta significativamente más por habitación que el promedio. Investigue exceso de stock o pérdidas.`
      : `${m.propertyName} spends significantly more per room than your average. Investigate overstocking or shrinkage.` },
    { key: 'shrinkage', direction: 'low', format: m => lang === 'es'
      ? `${m.propertyName} tiene pérdidas mucho mayores que otras propiedades. Puede indicar robo o pérdida de lavandería.`
      : `${m.propertyName} has much higher shrinkage than other properties. May indicate theft or laundry loss.` },
    { key: 'monthlySpend', direction: 'high', format: m => lang === 'es'
      ? `${m.propertyName} tiene un gasto mensual atípico. Revise el patrón de pedidos.`
      : `${m.propertyName} has unusually high monthly spend. Review the ordering pattern.` },
  ];
  for (const check of checks) {
    if (alerts.length >= 3) break;
    const vals = metrics.map(m => m[check.key] as number);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
    const stdev = Math.sqrt(variance);
    if (stdev === 0) continue;
    for (const m of metrics) {
      const v = m[check.key] as number;
      const z = (v - mean) / stdev;
      const flag = check.direction === 'high' ? z > 1.5 : z < -1.5;
      if (flag) {
        alerts.push(check.format(m));
        break; // one per check
      }
    }
  }
  if (alerts.length === 0) {
    return [lang === 'es'
      ? 'Todas las propiedades operan dentro de rangos normales.'
      : 'All properties are operating within normal ranges.'];
  }
  return alerts.slice(0, 3);
}

// ─── Card + Empty ────────────────────────────────────────────────────────────
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: '14px', padding: '20px 22px', border: '1px solid rgba(78,90,122,0.06)', marginBottom: '16px' }}>
      <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
        {title}
      </h2>
      {subtitle && (
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '2px 0 14px' }}>
          {subtitle}
        </p>
      )}
      <div style={{ marginTop: subtitle ? 0 : '14px' }}>
        {children}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: '32px 12px', textAlign: 'center', borderRadius: '12px', background: 'rgba(0,0,0,0.02)', border: '1px dashed #c5c5d4', fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
      {text}
    </div>
  );
}
