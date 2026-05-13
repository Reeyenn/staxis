'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Maintenance Analytics — 7 Recharts visuals over equipment + work_orders.
//
// Sections (per the V5 spec):
//   1. Work Orders Over Time      — line, broken down by severity
//   2. Cost Over Time             — line of monthly repair cost
//   3. Equipment Health           — horizontal bar (worst→best)
//   4. Category Breakdown         — pie/donut by equipment.category
//   5. Repair vs Replace          — cards driven by maintenance-ml
//   6. Seasonal Pattern           — grouped bar (months × category)
//   7. Top Problem Areas          — table (location → WO count)
//
// Date range selector: 30d / 90d / 6mo / All. AppLayout wrapper. Bilingual.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToWorkOrders, subscribeToEquipment } from '@/lib/db';
import { repairVsReplace, seasonalPatterns, type RepairReplaceRecommendation } from '@/lib/maintenance-ml';
import type { WorkOrder, Equipment, EquipmentCategory } from '@/types';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { ArrowLeft, BarChart3 } from 'lucide-react';

import { formatCurrency as formatCurrencyBase } from '@/lib/utils';
const formatCurrency = (n: number | null | undefined): string => formatCurrencyBase(n, true);

const CATEGORY_COLORS: Record<EquipmentCategory, string> = {
  hvac:       '#006565',
  plumbing:   '#0066cc',
  electrical: '#c98a14',
  appliance:  '#7c3aed',
  structural: '#454652',
  elevator:   '#dc2c8a',
  pool:       '#0891b2',
  laundry:    '#16a34a',
  kitchen:    '#ea580c',
  other:      '#757684',
};

const CATEGORY_LABEL = (cat: EquipmentCategory, lang: 'en' | 'es'): string => {
  const map: Record<EquipmentCategory, [string, string]> = {
    hvac: ['HVAC', 'HVAC'],
    plumbing: ['Plumbing', 'Plomería'],
    electrical: ['Electrical', 'Eléctrico'],
    appliance: ['Appliance', 'Electrodoméstico'],
    structural: ['Structural', 'Estructural'],
    elevator: ['Elevator', 'Ascensor'],
    pool: ['Pool', 'Piscina'],
    laundry: ['Laundry', 'Lavandería'],
    kitchen: ['Kitchen', 'Cocina'],
    other: ['Other', 'Otro'],
  };
  return map[cat][lang === 'es' ? 1 : 0];
};

type Range = '30' | '90' | '180' | 'all';

export default function MaintenanceAnalyticsPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [range, setRange] = useState<Range>('90');
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const u1 = subscribeToWorkOrders(user.uid, activePropertyId, setOrders);
    const u2 = subscribeToEquipment(user.uid, activePropertyId, setEquipment);
    return () => { u1(); u2(); };
  }, [user, activePropertyId]);

  const rangeStart = useMemo(() => {
    if (range === 'all') return 0;
    const days = parseInt(range, 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.getTime();
  }, [range]);

  const filteredOrders = useMemo(
    () => orders.filter(o => o.createdAt && o.createdAt.getTime() >= rangeStart),
    [orders, rangeStart],
  );

  const equipmentById = useMemo(() => new Map(equipment.map(e => [e.id, e])), [equipment]);

  // ─── Section 1: WO over time, by severity ──────────────────────────────
  const woOverTime = useMemo(() => {
    const useMonths = range === 'all' || parseInt(range, 10) >= 90;
    const buckets = new Map<string, { date: string; low: number; medium: number; urgent: number }>();
    for (const o of filteredOrders) {
      if (!o.createdAt) continue;
      const key = useMonths
        ? o.createdAt.toISOString().slice(0, 7)
        : o.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(key) ?? { date: key, low: 0, medium: 0, urgent: 0 };
      b[o.severity] += 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredOrders, range]);

  // ─── Section 2: Cost over time ─────────────────────────────────────────
  const costOverTime = useMemo(() => {
    const buckets = new Map<string, { date: string; cost: number }>();
    for (const o of filteredOrders) {
      if (!o.createdAt || o.repairCost == null) continue;
      const key = o.createdAt.toISOString().slice(0, 7);
      const b = buckets.get(key) ?? { date: key, cost: 0 };
      b.cost += o.repairCost;
      buckets.set(key, b);
    }
    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredOrders]);

  // ─── Section 3: Equipment health ───────────────────────────────────────
  const healthData = useMemo(() => {
    return equipment.map(eq => {
      let score = 100;
      if (eq.installDate && eq.expectedLifetimeYears) {
        const ageYears = (Date.now() - eq.installDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
        score -= Math.min(40, (ageYears / eq.expectedLifetimeYears) * 40);
      }
      const recent = orders.filter(o =>
        o.equipmentId === eq.id && o.createdAt &&
        Date.now() - o.createdAt.getTime() < 90 * 24 * 60 * 60 * 1000,
      );
      score -= Math.min(40, recent.length * 10);
      if (eq.status === 'failed') score -= 30;
      if (eq.status === 'degraded') score -= 15;
      return { name: eq.name, health: Math.max(0, Math.round(score)) };
    }).sort((a, b) => a.health - b.health).slice(0, 12);
  }, [equipment, orders]);

  // ─── Section 4: Category breakdown ─────────────────────────────────────
  const categoryBreakdown = useMemo(() => {
    const counts: Record<EquipmentCategory, number> = {
      hvac: 0, plumbing: 0, electrical: 0, appliance: 0, structural: 0,
      elevator: 0, pool: 0, laundry: 0, kitchen: 0, other: 0,
    };
    for (const o of filteredOrders) {
      if (!o.equipmentId) { counts.other++; continue; }
      const eq = equipmentById.get(o.equipmentId);
      if (eq) counts[eq.category]++;
    }
    return (Object.keys(counts) as EquipmentCategory[])
      .filter(c => counts[c] > 0)
      .map(c => ({ name: CATEGORY_LABEL(c, lang), value: counts[c], color: CATEGORY_COLORS[c] }));
  }, [filteredOrders, equipmentById, lang]);

  // ─── Section 5: Repair vs Replace cards ────────────────────────────────
  const recommendations = useMemo(
    () => repairVsReplace(equipment, orders).filter(r =>
      r.recommendation === 'plan_replacement' || r.recommendation === 'replace_now',
    ),
    [equipment, orders],
  );

  // ─── Section 6: Seasonal pattern ───────────────────────────────────────
  const seasonalRows = useMemo(() => {
    const patterns = seasonalPatterns(equipment, orders);
    if (patterns.length === 0) return [];
    const monthLabels = lang === 'es'
      ? ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return monthLabels.map((m, i) => {
      const row: Record<string, string | number> = { month: m };
      for (const p of patterns) {
        row[CATEGORY_LABEL(p.category, lang)] = Math.round(p.monthlyMultipliers[i] * 100) / 100;
      }
      return row;
    });
  }, [equipment, orders, lang]);
  const seasonalCategories = useMemo(() => {
    const patterns = seasonalPatterns(equipment, orders);
    return patterns.map(p => ({ key: CATEGORY_LABEL(p.category, lang), color: CATEGORY_COLORS[p.category] }));
  }, [equipment, orders, lang]);

  // ─── Section 7: Top problem areas ──────────────────────────────────────
  const topProblems = useMemo(() => {
    const byLoc = new Map<string, number>();
    for (const o of filteredOrders) {
      const loc = o.roomNumber?.trim() || (lang === 'es' ? '(sin habitación)' : '(no room)');
      byLoc.set(loc, (byLoc.get(loc) ?? 0) + 1);
    }
    return Array.from(byLoc.entries())
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [filteredOrders, lang]);

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
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <Link href="/maintenance" style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684',
              textDecoration: 'none', marginBottom: '4px',
            }}>
              <ArrowLeft size={13} />
              {lang === 'es' ? 'Volver a mantenimiento' : 'Back to maintenance'}
            </Link>
            <h1 style={{ fontFamily: "'Inter', sans-serif", fontSize: '24px', fontWeight: 700, color: '#1b1c19', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <BarChart3 size={22} color="#364262" />
              {lang === 'es' ? 'Analíticas de Mantenimiento' : 'Maintenance Analytics'}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: '6px', background: '#f0eee9', padding: '4px', borderRadius: '9999px' }}>
            {(['30', '90', '180', 'all'] as const).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  padding: '6px 14px', borderRadius: '9999px', border: 'none',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  background: range === r ? '#364262' : 'transparent',
                  color: range === r ? '#fff' : '#454652',
                }}
              >
                {r === 'all' ? (lang === 'es' ? 'Todo' : 'All') : `${r}d`}
              </button>
            ))}
          </div>
        </div>

        {/* Section 1 — WO Over Time */}
        <ChartCard title={lang === 'es' ? 'Órdenes en el Tiempo' : 'Work Orders Over Time'} subtitle={lang === 'es' ? 'Por severidad' : 'By severity'}>
          {woOverTime.length === 0 ? <Empty text={lang === 'es' ? 'Sin órdenes en este período.' : 'No work orders in this period.'} /> : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={woOverTime} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#757684" tick={{ fontSize: 11 }} />
                <YAxis stroke="#757684" tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="low" stroke="#757684" strokeWidth={2} dot={{ r: 2 }} name={lang === 'es' ? 'Baja' : 'Low'} />
                <Line type="monotone" dataKey="medium" stroke="#c98a14" strokeWidth={2} dot={{ r: 2 }} name={lang === 'es' ? 'Media' : 'Medium'} />
                <Line type="monotone" dataKey="urgent" stroke="#ba1a1a" strokeWidth={2} dot={{ r: 2 }} name={lang === 'es' ? 'Urgente' : 'Urgent'} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 2 — Cost Over Time */}
        <ChartCard title={lang === 'es' ? 'Costo en el Tiempo' : 'Cost Over Time'} subtitle={lang === 'es' ? 'Costo de reparación mensual' : 'Monthly repair spend'}>
          {costOverTime.length === 0 ? <Empty text={lang === 'es' ? 'Sin costos registrados.' : 'No repair costs logged.'} /> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={costOverTime} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#757684" tick={{ fontSize: 11 }} />
                <YAxis stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => formatCurrency(v)} />
                <Tooltip formatter={(v) => typeof v === 'number' ? formatCurrency(v) : String(v)} />
                <Line type="monotone" dataKey="cost" stroke="#364262" strokeWidth={2} dot={{ r: 3 }} name={lang === 'es' ? 'Gasto' : 'Spend'} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 3 — Equipment Health */}
        <ChartCard title={lang === 'es' ? 'Salud del Equipo' : 'Equipment Health'} subtitle={lang === 'es' ? 'Peor a mejor' : 'Worst to best'}>
          {healthData.length === 0 ? <Empty text={lang === 'es' ? 'Sin equipos registrados.' : 'No equipment registered.'} /> : (
            <ResponsiveContainer width="100%" height={Math.max(220, healthData.length * 28)}>
              <BarChart data={healthData} layout="vertical" margin={{ top: 5, right: 16, left: 110, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} stroke="#757684" tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} />
                <YAxis type="category" dataKey="name" stroke="#454652" tick={{ fontSize: 11 }} width={110} />
                <Tooltip formatter={(v) => `${v ?? 0}%`} />
                <Bar dataKey="health" radius={[0, 6, 6, 0]}>
                  {healthData.map((d, i) => (
                    <Cell key={i} fill={d.health >= 70 ? '#006565' : d.health >= 40 ? '#c98a14' : '#ba1a1a'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 4 — Category Breakdown */}
        <ChartCard title={lang === 'es' ? 'Desglose por Categoría' : 'Category Breakdown'} subtitle={lang === 'es' ? 'Órdenes por tipo de equipo' : 'Work orders by equipment type'}>
          {categoryBreakdown.length === 0 ? <Empty text={lang === 'es' ? 'Sin datos en este período.' : 'No data in this period.'} /> : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '32px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <ResponsiveContainer width={240} height={240}>
                <PieChart>
                  <Pie data={categoryBreakdown} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                    {categoryBreakdown.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {categoryBreakdown.map(s => (
                  <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: s.color }} />
                    <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#1b1c19' }}>
                      {s.name} <span style={{ color: '#757684' }}>· {s.value}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </ChartCard>

        {/* Section 5 — Repair vs Replace cards */}
        <ChartCard title={lang === 'es' ? 'Reparar vs Reemplazar' : 'Repair vs Replace'} subtitle={lang === 'es' ? 'Equipos en zona de reemplazo' : 'Equipment in replacement territory'}>
          {recommendations.length === 0 ? (
            <Empty text={lang === 'es' ? 'Ningún equipo necesita reemplazo aún.' : 'No equipment needs replacement yet.'} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
              {recommendations.map(r => {
                const eq = equipmentById.get(r.equipmentId);
                const isReplaceNow = r.recommendation === 'replace_now';
                return (
                  <div key={r.equipmentId} style={{
                    background: '#fff', borderRadius: '14px', padding: '14px 16px',
                    border: `1px solid ${isReplaceNow ? 'rgba(186,26,26,0.18)' : 'rgba(201,138,20,0.18)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                      <span style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '14px', color: '#1b1c19' }}>
                        {eq?.name ?? r.equipmentId.slice(0, 8)}
                      </span>
                      <span style={{
                        fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 700,
                        background: isReplaceNow ? '#ba1a1a' : '#c98a14',
                        color: '#fff', padding: '2px 8px', borderRadius: '6px',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        {isReplaceNow
                          ? (lang === 'es' ? 'Reemplazar Ahora' : 'Replace Now')
                          : (lang === 'es' ? 'Planear Reemplazo' : 'Plan Replacement')}
                      </span>
                    </div>
                    <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '8px' }}>
                      {r.reasoning}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '10px', flexWrap: 'wrap' }}>
                      <Stat label={lang === 'es' ? 'Reparaciones' : 'Repairs'} value={formatCurrency(r.cumulativeRepairCost)} />
                      <Stat label={lang === 'es' ? 'Próx. 12 mo.' : 'Next 12 mo.'} value={formatCurrency(r.projectedNextYearRepairCost)} />
                      <Stat label={lang === 'es' ? 'Reemplazo' : 'Replace'} value={formatCurrency(r.replacementCost)} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ChartCard>

        {/* Section 6 — Seasonal Pattern */}
        <ChartCard title={lang === 'es' ? 'Patrón Estacional' : 'Seasonal Pattern'} subtitle={lang === 'es' ? 'Multiplicador mensual vs promedio' : 'Monthly multiplier vs annual mean'}>
          {seasonalRows.length === 0 || seasonalCategories.length === 0 ? (
            <Empty text={lang === 'es' ? 'Necesita un año de datos para ver patrones.' : 'Need a year of data to see patterns.'} />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={seasonalRows} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#eae8e3" strokeDasharray="3 3" />
                <XAxis dataKey="month" stroke="#757684" tick={{ fontSize: 11 }} />
                <YAxis stroke="#757684" tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {seasonalCategories.map(cat => (
                  <Bar key={cat.key} dataKey={cat.key} fill={cat.color} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Section 7 — Top Problem Areas */}
        <ChartCard title={lang === 'es' ? 'Áreas con Más Problemas' : 'Top Problem Areas'} subtitle={lang === 'es' ? 'Habitaciones con más órdenes' : 'Rooms with the most work orders'}>
          {topProblems.length === 0 ? <Empty text={lang === 'es' ? 'Sin datos.' : 'No data.'} /> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #c5c5d4' }}>
                  <th style={{ textAlign: 'left', padding: '8px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Ubicación' : 'Location'}</th>
                  <th style={{ textAlign: 'right', padding: '8px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Órdenes' : 'Work Orders'}</th>
                </tr>
              </thead>
              <tbody>
                {topProblems.map(p => (
                  <tr key={p.location} style={{ borderBottom: '1px solid rgba(197,197,212,0.3)' }}>
                    <td style={{ padding: '8px 0', color: '#1b1c19' }}>{p.location}</td>
                    <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: p.count >= 5 ? '#ba1a1a' : '#454652', fontWeight: p.count >= 5 ? 700 : 400 }}>
                      {p.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ChartCard>
      </div>
    </AppLayout>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: '14px', padding: '20px 22px', border: '1px solid rgba(78,90,122,0.06)', marginBottom: '16px' }}>
      <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>{title}</h2>
      {subtitle && <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '2px 0 14px' }}>{subtitle}</p>}
      <div style={{ marginTop: subtitle ? 0 : '14px' }}>{children}</div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600, color: '#757684', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', fontWeight: 700, color: '#1b1c19', marginTop: '2px' }}>{value}</div>
    </div>
  );
}
