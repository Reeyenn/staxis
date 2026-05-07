'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Inventory Analytics — five Recharts visuals over orders + counts + occupancy
//
// Sections:
//   1. Spend Over Time      — LineChart, three lines per category
//   2. Shrinkage Over Time  — BarChart, red for loss, green for gain
//   3. Cost Per Occupied    — LineChart, monthly $/room-night
//   4. Top Items by Loss    — Horizontal BarChart, top 5
//   5. Consumption Mix      — Donut (PieChart) — % of daily $ consumption
//
// Date-range selector at top: 30d / 90d / All. Each section degrades to an
// empty-state when its data source is missing.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { listInventoryOrders, listInventoryCounts, subscribeToInventory } from '@/lib/db';
import { fetchDailyAverages } from '@/lib/inventory-predictions';
import { supabase } from '@/lib/supabase';
import type { InventoryItem, InventoryCategory, InventoryOrder, InventoryCount } from '@/types';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { ArrowLeft, BarChart3 } from 'lucide-react';

// ─── Helpers (kept local to avoid circular imports with /inventory page) ────

function formatCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

const CATEGORY_COLORS: Record<InventoryCategory, string> = {
  housekeeping: '#006565',
  maintenance:  '#364262',
  breakfast:    '#c98a14',
};

const CATEGORY_LABEL = (cat: InventoryCategory, lang: 'en' | 'es') =>
  cat === 'housekeeping' ? (lang === 'es' ? 'Limpieza' : 'Housekeeping')
  : cat === 'maintenance' ? (lang === 'es' ? 'Mantenimiento' : 'Maintenance')
  : (lang === 'es' ? 'Desayuno' : 'Breakfast');

// ─── Page ───────────────────────────────────────────────────────────────────

type Range = '30' | '90' | 'all';

export default function InventoryAnalyticsPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [range, setRange] = useState<Range>('90');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [orders, setOrders] = useState<InventoryOrder[]>([]);
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [dailyLogs, setDailyLogs] = useState<Array<{ date: string; occupied: number }>>([]);
  const [loading, setLoading] = useState(true);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Inventory subscription (so item.category lookups stay fresh)
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToInventory(user.uid, activePropertyId, setItems);
  }, [user, activePropertyId]);

  // Fetch orders + counts + occupancy logs once we have the user/property.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      listInventoryOrders(user.uid, activePropertyId, 1000),
      listInventoryCounts(user.uid, activePropertyId, 1000),
      (async () => {
        // Pull a generous occupancy window — 1 year. We filter client-side
        // when the user picks a tighter range.
        const since = new Date();
        since.setFullYear(since.getFullYear() - 1);
        const sinceDate = since.toISOString().slice(0, 10);
        const { data, error } = await supabase
          .from('daily_logs')
          .select('date, occupied')
          .eq('property_id', activePropertyId)
          .gte('date', sinceDate)
          .order('date', { ascending: true });
        if (error || !data) return [];
        return data.map(r => ({ date: String(r.date), occupied: Number(r.occupied ?? 0) }));
      })(),
    ])
      .then(([os, cs, logs]) => {
        if (!alive) return;
        setOrders(os);
        setCounts(cs);
        setDailyLogs(logs);
      })
      .catch(err => console.error('[analytics] fetch failed:', err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user, activePropertyId]);

  // Range filter — start of window in ms.
  const rangeStart = useMemo(() => {
    if (range === 'all') return 0;
    const days = parseInt(range, 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.getTime();
  }, [range]);

  const filteredOrders = useMemo(
    () => orders.filter(o => o.receivedAt && o.receivedAt.getTime() >= rangeStart),
    [orders, rangeStart],
  );
  const filteredCounts = useMemo(
    () => counts.filter(c => c.countedAt && c.countedAt.getTime() >= rangeStart),
    [counts, rangeStart],
  );
  const filteredLogs = useMemo(
    () => dailyLogs.filter(l => new Date(l.date + 'T00:00:00').getTime() >= rangeStart),
    [dailyLogs, rangeStart],
  );

  const itemsById = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);

  // ─── Section 1: spend by category over time, bucketed by week or month ─
  // Auto-scale: <60d window → weekly buckets; ≥60d → monthly.
  const spendData = useMemo(() => {
    const useMonths = range === 'all' || parseInt(range, 10) >= 60;
    const byBucket = new Map<string, { housekeeping: number; maintenance: number; breakfast: number; date: string }>();
    for (const o of filteredOrders) {
      if (!o.receivedAt || o.totalCost == null) continue;
      const item = itemsById.get(o.itemId);
      if (!item) continue;
      const key = useMonths
        ? o.receivedAt.toISOString().slice(0, 7) // YYYY-MM
        : startOfWeek(o.receivedAt).toISOString().slice(0, 10); // YYYY-MM-DD of Monday
      const bucket = byBucket.get(key) ?? { housekeeping: 0, maintenance: 0, breakfast: 0, date: key };
      bucket[item.category] += o.totalCost;
      byBucket.set(key, bucket);
    }
    return Array.from(byBucket.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredOrders, itemsById, range]);

  // ─── Section 2: shrinkage over time — sum varianceValue per count event date
  const shrinkageData = useMemo(() => {
    const byDate = new Map<string, { date: string; total: number }>();
    for (const c of filteredCounts) {
      if (!c.countedAt || c.varianceValue == null) continue;
      const key = c.countedAt.toISOString().slice(0, 10);
      const bucket = byDate.get(key) ?? { date: key, total: 0 };
      bucket.total += c.varianceValue;
      byDate.set(key, bucket);
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredCounts]);

  // ─── Section 3: cost per occupied room, monthly
  const costPerRoomData = useMemo(() => {
    // Spend per month
    const spendByMonth = new Map<string, number>();
    for (const o of filteredOrders) {
      if (!o.receivedAt || o.totalCost == null) continue;
      const key = o.receivedAt.toISOString().slice(0, 7);
      spendByMonth.set(key, (spendByMonth.get(key) ?? 0) + o.totalCost);
    }
    // Occupied nights per month
    const occByMonth = new Map<string, number>();
    for (const l of filteredLogs) {
      const key = l.date.slice(0, 7);
      occByMonth.set(key, (occByMonth.get(key) ?? 0) + l.occupied);
    }
    const allMonths = new Set([...spendByMonth.keys(), ...occByMonth.keys()]);
    const rows = Array.from(allMonths).sort().map(month => {
      const spend = spendByMonth.get(month) ?? 0;
      const occ = occByMonth.get(month) ?? 0;
      // Skip months with no data on either side
      if (spend === 0 || occ === 0) return null;
      return { month, costPerRoom: spend / occ };
    }).filter((r): r is { month: string; costPerRoom: number } => r !== null);
    return rows;
  }, [filteredOrders, filteredLogs]);

  // ─── Section 4: top items by cumulative loss
  const topLossData = useMemo(() => {
    const byItem = new Map<string, { name: string; total: number }>();
    for (const c of filteredCounts) {
      if (c.varianceValue == null || c.varianceValue >= 0) continue;
      const cur = byItem.get(c.itemName) ?? { name: c.itemName, total: 0 };
      cur.total += c.varianceValue;
      byItem.set(c.itemName, cur);
    }
    return Array.from(byItem.values())
      .sort((a, b) => a.total - b.total) // most negative first
      .slice(0, 5)
      .map(r => ({ name: r.name, loss: Math.abs(r.total) })); // positive bar height
  }, [filteredCounts]);

  // ─── Section 5: daily consumption $ mix, computed from prediction engine
  const [averages, setAverages] = useState<{ avgCheckouts: number; avgStayovers: number; days: number } | null>(null);
  useEffect(() => {
    if (!activePropertyId) return;
    fetchDailyAverages(activePropertyId, 14)
      .then(a => setAverages({
        avgCheckouts: a.avgDailyCheckouts,
        avgStayovers: a.avgDailyStayovers,
        days: a.daysOfData,
      }))
      .catch(() => setAverages(null));
  }, [activePropertyId]);

  const consumptionMix = useMemo(() => {
    if (!averages || averages.days < 7) return [];
    const byCat: Record<InventoryCategory, number> = { housekeeping: 0, maintenance: 0, breakfast: 0 };
    for (const item of items) {
      const burn =
        averages.avgCheckouts * (item.usagePerCheckout ?? 0) +
        averages.avgStayovers * (item.usagePerStayover ?? 0);
      if (burn <= 0 || item.unitCost == null) continue;
      byCat[item.category] += burn * item.unitCost;
    }
    const total = byCat.housekeeping + byCat.maintenance + byCat.breakfast;
    if (total === 0) return [];
    return (Object.keys(byCat) as InventoryCategory[]).map(c => ({
      name: CATEGORY_LABEL(c, lang),
      value: byCat[c],
      color: CATEGORY_COLORS[c],
      pct: Math.round((byCat[c] / total) * 100),
    })).filter(r => r.value > 0);
  }, [averages, items, lang]);

  // ─── Render ────────────────────────────────────────────────────────────
  if (authLoading || propLoading || !user || !activePropertyId) {
    return (
      <AppLayout>
        <div style={{ padding: '60px', textAlign: 'center', color: '#757684' }}>
          {lang === 'es' ? 'Cargando...' : 'Loading...'}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '20px 24px 120px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
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
              color: '#1b1c19', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <BarChart3 size={22} color="#364262" />
              {lang === 'es' ? 'Analíticas de Inventario' : 'Inventory Analytics'}
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

        {loading && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#757684', fontFamily: "'Inter', sans-serif" }}>
            {lang === 'es' ? 'Cargando datos...' : 'Loading data...'}
          </div>
        )}

        {/* Section 1 — Spend over time */}
        <ChartCard
          title={lang === 'es' ? 'Gasto en Reabastecimiento' : 'Spend Over Time'}
          subtitle={lang === 'es' ? 'Por categoría, agrupado por semana o mes' : 'By category, bucketed by week or month'}
        >
          {spendData.length === 0 ? (
            <EmptyState text={lang === 'es' ? 'No hay pedidos con costo en este período.' : 'No priced orders in this period.'} />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={spendData} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#757684" tick={{ fontSize: 11 }} />
                <YAxis stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="housekeeping" stroke={CATEGORY_COLORS.housekeeping} strokeWidth={2} dot={{ r: 3 }} name={CATEGORY_LABEL('housekeeping', lang)} />
                <Line type="monotone" dataKey="maintenance" stroke={CATEGORY_COLORS.maintenance} strokeWidth={2} dot={{ r: 3 }} name={CATEGORY_LABEL('maintenance', lang)} />
                <Line type="monotone" dataKey="breakfast" stroke={CATEGORY_COLORS.breakfast} strokeWidth={2} dot={{ r: 3 }} name={CATEGORY_LABEL('breakfast', lang)} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 2 — Shrinkage over time */}
        <ChartCard
          title={lang === 'es' ? 'Pérdidas en el Tiempo' : 'Shrinkage Over Time'}
          subtitle={lang === 'es' ? 'Variación total por evento de conteo (rojo = pérdida)' : 'Total variance per count event (red = loss)'}
        >
          {shrinkageData.length === 0 ? (
            <EmptyState text={lang === 'es' ? 'No hay conteos con variación en este período.' : 'No counts with variance in this period.'} />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={shrinkageData} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#757684" tick={{ fontSize: 11 }} />
                <YAxis stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => formatCurrency(v)} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="total" name={lang === 'es' ? 'Variación' : 'Variance'}>
                  {shrinkageData.map((r, i) => (
                    <Cell key={i} fill={r.total < 0 ? '#ba1a1a' : '#006565'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 3 — Cost per occupied room */}
        <ChartCard
          title={lang === 'es' ? 'Costo por Habitación Ocupada' : 'Cost Per Occupied Room'}
          subtitle={lang === 'es' ? 'Gasto total ÷ noches ocupadas, por mes' : 'Total spend ÷ occupied nights, by month'}
        >
          {costPerRoomData.length === 0 ? (
            <EmptyState text={lang === 'es' ? 'Necesita pedidos y datos de ocupación.' : 'Needs orders and occupancy data.'} />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={costPerRoomData} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                <XAxis dataKey="month" stroke="#757684" tick={{ fontSize: 11 }} />
                <YAxis stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => `$${v.toFixed(2)}`} />
                <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                <Line type="monotone" dataKey="costPerRoom" stroke="#364262" strokeWidth={2} dot={{ r: 4 }} name={lang === 'es' ? '$/Hab.' : '$/Room'} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 4 — Top items by loss */}
        <ChartCard
          title={lang === 'es' ? 'Mayores Pérdidas por Artículo' : 'Top Items by Loss'}
          subtitle={lang === 'es' ? '5 artículos con mayor pérdida acumulada' : 'Top 5 with most cumulative shrinkage'}
        >
          {topLossData.length === 0 ? (
            <EmptyState text={lang === 'es' ? 'No hay pérdidas registradas en este período.' : 'No losses recorded in this period.'} />
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(200, topLossData.length * 50)}>
              <BarChart data={topLossData} layout="vertical" margin={{ top: 5, right: 16, left: 100, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => formatCurrency(v)} />
                <YAxis type="category" dataKey="name" stroke="#454652" tick={{ fontSize: 12 }} width={100} />
                <Tooltip formatter={(v: number) => formatCurrency(-v)} />
                <Bar dataKey="loss" fill="#ba1a1a" name={lang === 'es' ? 'Pérdida' : 'Loss'} radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 5 — Consumption mix */}
        <ChartCard
          title={lang === 'es' ? 'Mezcla de Consumo' : 'Consumption Breakdown'}
          subtitle={lang === 'es' ? '% del consumo diario en dólares por categoría' : '% of daily $ consumption per category'}
        >
          {consumptionMix.length === 0 ? (
            <EmptyState text={lang === 'es' ? 'Configure tasas de uso y costos para ver esta vista.' : 'Configure usage rates + unit costs to see this view.'} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '32px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <ResponsiveContainer width={240} height={240}>
                <PieChart>
                  <Pie data={consumptionMix} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                    {consumptionMix.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => `${formatCurrency(v)}/day`} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {consumptionMix.map(s => (
                  <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: s.color }} />
                    <div>
                      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600, color: '#1b1c19' }}>
                        {s.name}
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#757684' }}>
                        {s.pct}% · {formatCurrency(s.value)}/{lang === 'es' ? 'día' : 'day'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </ChartCard>
      </div>
    </AppLayout>
  );
}

// Wrap each chart in a consistent card.
function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#fff', borderRadius: '14px', padding: '20px 22px',
      border: '1px solid rgba(78,90,122,0.06)', marginBottom: '16px',
    }}>
      <div style={{ marginBottom: '14px' }}>
        <h2 style={{
          fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700,
          color: '#1b1c19', margin: 0,
        }}>
          {title}
        </h2>
        {subtitle && (
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '2px 0 0' }}>
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      padding: '40px 12px', textAlign: 'center', borderRadius: '12px',
      background: 'rgba(0,0,0,0.02)', border: '1px dashed #c5c5d4',
      fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684',
    }}>
      {text}
    </div>
  );
}

// Monday-anchored start-of-week. ISO date returned.
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = (day + 6) % 7; // days since last Monday
  out.setDate(out.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}
