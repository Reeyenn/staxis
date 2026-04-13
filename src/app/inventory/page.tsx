'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToInventory, addInventoryItem, updateInventoryItem,
} from '@/lib/firestore';
import type { InventoryItem, InventoryCategory } from '@/types';
import {
  Plus, Package, ClipboardCheck, Clock, AlertTriangle, Check,
} from 'lucide-react';

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORIES: { key: InventoryCategory | 'all'; label: string; labelEs: string }[] = [
  { key: 'all', label: 'All', labelEs: 'Todo' },
  { key: 'housekeeping', label: 'Housekeeping', labelEs: 'Limpieza' },
  { key: 'maintenance', label: 'Maintenance', labelEs: 'Mantenimiento' },
  { key: 'breakfast', label: 'Breakfast/F&B', labelEs: 'Desayuno/A&B' },
];

const DEFAULTS: Omit<InventoryItem, 'id' | 'updatedAt' | 'propertyId'>[] = [
  { name: 'King Sheets', category: 'housekeeping', currentStock: 0, parLevel: 80, unit: 'sets' },
  { name: 'Queen Sheets', category: 'housekeeping', currentStock: 0, parLevel: 120, unit: 'sets' },
  { name: 'Pillowcases', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Bath Towels', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Hand Towels', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Washcloths', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Bath Mats', category: 'housekeeping', currentStock: 0, parLevel: 100, unit: 'units' },
  { name: 'Shampoo', category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles' },
  { name: 'Conditioner', category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles' },
  { name: 'Body Wash', category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles' },
  { name: 'All-Purpose Cleaner', category: 'housekeeping', currentStock: 0, parLevel: 24, unit: 'bottles' },
  { name: 'Glass Cleaner', category: 'housekeeping', currentStock: 0, parLevel: 12, unit: 'bottles' },
  { name: 'Trash Liners (Large)', category: 'housekeeping', currentStock: 0, parLevel: 500, unit: 'bags' },
  { name: 'Coffee Pods', category: 'breakfast', currentStock: 0, parLevel: 200, unit: 'pods' },
  { name: 'Light Bulbs (LED)', category: 'maintenance', currentStock: 0, parLevel: 50, unit: 'bulbs' },
  { name: 'HVAC Filters', category: 'maintenance', currentStock: 0, parLevel: 10, unit: 'filters' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(date: Date | null | undefined | { seconds?: number; toDate?: () => Date }): string {
  if (!date) return 'Never';
  let d: Date;
  if (typeof (date as { toDate?: () => Date }).toDate === 'function') {
    d = (date as { toDate: () => Date }).toDate();
  } else if (typeof (date as { seconds?: number }).seconds === 'number') {
    d = new Date((date as { seconds: number }).seconds * 1000);
  } else {
    d = new Date(date as Date);
  }
  if (isNaN(d.getTime())) return 'Never';
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function stockStatus(current: number, target: number): 'good' | 'low' | 'out' {
  if (current <= 0) return 'out';
  if (current < target * 0.3) return 'out';
  if (current < target * 0.7) return 'low';
  return 'good';
}

const STATUS_COLORS = { good: '#006565', low: '#364262', out: '#ba1a1a' };
const STATUS_BG = { good: '#eae8e3', low: '#d3e4f8', out: '#ffdad6' };
const STATUS_LABELS = { good: 'Good', low: 'Low', out: 'Critical' };
const STATUS_LABELS_ES = { good: 'Bien', low: 'Bajo', out: 'Crítico' };

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [activeCategory, setActiveCategory] = useState<InventoryCategory | 'all'>('all');
  const [counting, setCounting] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [lowStockAlert, setLowStockAlert] = useState<InventoryItem[] | null>(null);

  const seededRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Subscribe to inventory items
  useEffect(() => {
    if (!user || !activePropertyId) return;
    let isFirst = true;
    const OLD_TO_NEW: Record<string, InventoryCategory> = {
      linens: 'housekeeping', towels: 'housekeeping', amenities: 'housekeeping',
      cleaning: 'housekeeping', other: 'housekeeping',
    };
    const NAME_CATEGORY: Record<string, InventoryCategory> = {
      'Coffee Pods': 'breakfast',
      'Light Bulbs (LED)': 'maintenance',
      'HVAC Filters': 'maintenance',
    };
    let migrated = false;
    const unsub = subscribeToInventory(user.uid, activePropertyId, (snapshot) => {
      if (!migrated) {
        migrated = true;
        snapshot.forEach(item => {
          const nameOverride = NAME_CATEGORY[item.name];
          const mapped = OLD_TO_NEW[item.category];
          const newCat = nameOverride && item.category !== nameOverride ? nameOverride : mapped;
          if (newCat) {
            updateInventoryItem(user.uid, activePropertyId, item.id, { category: newCat })
              .catch(err => console.error('[inventory] migration failed:', err));
          }
        });
      }
      setItems(snapshot.map(item => {
        const nameOverride = NAME_CATEGORY[item.name];
        if (nameOverride && item.category !== nameOverride) return { ...item, category: nameOverride };
        const mapped = OLD_TO_NEW[item.category];
        return mapped ? { ...item, category: mapped } : item;
      }));
      if (isFirst && snapshot.length === 0 && !seededRef.current) {
        seededRef.current = true;
        DEFAULTS.forEach(def => {
          addInventoryItem(user.uid, activePropertyId, { ...def, propertyId: activePropertyId })
            .catch(err => console.error('[inventory] seed default failed:', err));
        });
      }
      isFirst = false;
    });
    return unsub;
  }, [user, activePropertyId]);

  // Derived data
  const sortedItems = useMemo(() => {
    const filtered = activeCategory === 'all' ? items : items.filter(i => i.category === activeCategory);
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [items, activeCategory]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    items.forEach(i => { counts[i.category] = (counts[i.category] ?? 0) + 1; });
    return counts;
  }, [items]);

  const lowCount = useMemo(() => items.filter(i => stockStatus(i.currentStock, i.parLevel) !== 'good').length, [items]);

  const lastCounted = useMemo(() => {
    const timestamps = items.map(i => {
      const d = i.updatedAt as unknown;
      if (!d) return 0;
      if (typeof (d as { toDate?: () => Date }).toDate === 'function') return (d as { toDate: () => Date }).toDate().getTime();
      if (typeof (d as { seconds?: number }).seconds === 'number') return (d as { seconds: number }).seconds * 1000;
      const t = new Date(d as Date).getTime();
      return isNaN(t) ? 0 : t;
    }).filter(t => t > 0);
    if (timestamps.length === 0) return null;
    return new Date(Math.max(...timestamps));
  }, [items]);

  // Loading guard
  if (authLoading || propLoading || !user || !activePropertyId) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-4 rounded-full mb-3 mx-auto" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--navy)' }} />
            <div className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              {lang === 'es' ? 'Cargando inventario...' : 'Loading inventory...'}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  // ─── Computed stats for hero ───────────────────────────────────────────────
  const stockHealthPct = useMemo(() => {
    if (items.length === 0) return 100;
    const goodItems = items.filter(i => stockStatus(i.currentStock, i.parLevel) === 'good').length;
    return Math.round((goodItems / items.length) * 100);
  }, [items]);

  const countCompletionPct = useMemo(() => {
    if (items.length === 0) return 0;
    const counted = items.filter(i => i.updatedAt).length;
    return Math.round((counted / items.length) * 100);
  }, [items]);

  // AI Insight text
  const aiInsight = useMemo(() => {
    const criticalItems = items.filter(i => stockStatus(i.currentStock, i.parLevel) === 'out');
    const lowItems = items.filter(i => stockStatus(i.currentStock, i.parLevel) === 'low');
    if (criticalItems.length > 0) {
      const worst = criticalItems[0];
      const pct = worst.parLevel > 0 ? Math.round((worst.currentStock / worst.parLevel) * 100) : 0;
      return lang === 'es'
        ? `${worst.name} está ${pct}% por debajo del umbral. Se recomienda reorden inmediato.`
        : `${worst.name} ${worst.currentStock === 0 ? 'is out of stock' : `is ${100 - pct}% below threshold`}. AI recommends immediate reorder.`;
    }
    if (lowItems.length > 0) {
      return lang === 'es'
        ? `${lowItems.length} artículo(s) con stock bajo. Considere programar reorden esta semana.`
        : `${lowItems.length} item${lowItems.length > 1 ? 's' : ''} running low. Consider scheduling reorders this week.`;
    }
    return lang === 'es'
      ? 'Todos los niveles de inventario están saludables. No se requieren acciones inmediatas.'
      : 'All inventory levels are healthy. No immediate actions required.';
  }, [items, lang]);

  // Items grouped by category
  const hkItems = useMemo(() => items.filter(i => i.category === 'housekeeping').sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const maintItems = useMemo(() => items.filter(i => i.category === 'maintenance').sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const fbItems = useMemo(() => items.filter(i => i.category === 'breakfast').sort((a, b) => a.name.localeCompare(b.name)), [items]);

  // Alert counts per category
  const catAlerts = useMemo(() => ({
    housekeeping: hkItems.filter(i => stockStatus(i.currentStock, i.parLevel) !== 'good').length,
    maintenance: maintItems.filter(i => stockStatus(i.currentStock, i.parLevel) !== 'good').length,
    breakfast: fbItems.filter(i => stockStatus(i.currentStock, i.parLevel) !== 'good').length,
  }), [hkItems, maintItems, fbItems]);

  // ─── MAIN VIEW — Stitch Inventory Intelligence Layout ─────────────────────
  return (
    <AppLayout>
      <style>{`
        .inv-card:hover { transform: translateY(-2px); }
        .inv-cat-grid { display: grid; grid-template-columns: 1fr; gap: 32px; }
        @media (min-width: 768px) { .inv-cat-grid { grid-template-columns: repeat(3, 1fr); } }
      `}</style>

      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '48px 24px 160px' }}>

        {/* ── Hero: title + AI Insight ── */}
        <header style={{ marginBottom: '40px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: '24px' }}>
            <div>
              <h1 style={{
                fontFamily: "'Inter', sans-serif", fontSize: '48px', fontWeight: 600,
                color: '#1b1c19', letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '8px',
              }}>
                {lang === 'es' ? 'Inteligencia de' : 'Inventory'}<br/>
                {lang === 'es' ? 'Inventario' : 'Intelligence'}
              </h1>
              <p style={{
                fontFamily: "'Inter', sans-serif", fontSize: '16px', lineHeight: 1.6,
                color: '#454652', maxWidth: '520px',
              }}>
                {lang === 'es'
                  ? 'Optimización de stock en tiempo real basada en patrones de consumo y flujo de huéspedes.'
                  : 'Real-time stock optimization powered by historical consumption patterns and predicted guest flow.'}
              </p>
            </div>

            {/* Concierge AI Insight card */}
            <div style={{
              background: '#fff', border: '1px solid rgba(197,213,248,0.3)',
              borderRadius: '24px', padding: '24px', maxWidth: '400px', position: 'relative', overflow: 'hidden',
              boxShadow: '0 0 40px rgba(0,101,101,0.1)',
            }}>
              <div style={{ position: 'absolute', top: '16px', right: '16px', opacity: 0.1, fontSize: '64px', lineHeight: 1 }}>✦</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#006565', marginBottom: '16px' }}>
                <span style={{ fontSize: '18px' }}>✦</span>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {lang === 'es' ? 'Insight del Concierge' : 'Concierge Insight'}
                </span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', lineHeight: 1.6, color: '#1b1c19', margin: 0 }}>
                {aiInsight}
              </p>
            </div>
          </div>

          {/* ── Key Stats Bar ── */}
          <div style={{
            display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center',
            padding: '16px 24px', background: '#f5f3ee', borderRadius: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ClipboardCheck size={18} color="#364262" />
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', fontWeight: 500 }}>
                {lang === 'es' ? 'Conteo' : 'Count Completion'}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: 700, color: '#364262' }}>
                {countCompletionPct}%
              </span>
            </div>
            <div style={{ width: '1px', height: '24px', background: '#c5c5d4' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Package size={18} color={stockHealthPct >= 70 ? '#006565' : stockHealthPct >= 40 ? '#364262' : '#ba1a1a'} />
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', fontWeight: 500 }}>
                {lang === 'es' ? 'Salud de Stock' : 'Stock Health'}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: 700, color: stockHealthPct >= 70 ? '#006565' : stockHealthPct >= 40 ? '#364262' : '#ba1a1a' }}>
                {stockHealthPct}%
              </span>
            </div>
            <div style={{ width: '1px', height: '24px', background: '#c5c5d4' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Clock size={18} color="#454652" />
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', fontWeight: 500 }}>
                {lang === 'es' ? 'Último Conteo' : 'Last Count'}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '14px', fontWeight: 500, color: '#364262' }}>
                {lastCounted ? timeAgo(lastCounted) : (lang === 'es' ? 'Nunca' : 'Never')}
              </span>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <button
                onClick={() => setCounting(true)}
                style={{
                  background: '#364262', color: '#fff', border: 'none',
                  padding: '10px 24px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                  transition: 'transform 150ms',
                }}
              >
                <ClipboardCheck size={16} />
                {lang === 'es' ? 'Iniciar Conteo' : 'Start Count'}
              </button>
            </div>
          </div>
        </header>

        {/* ── Bento Grid: 3 Category Columns ── */}
        <div className="inv-cat-grid">
          {/* Render each category column */}
          {([
            { key: 'housekeeping' as InventoryCategory, label: lang === 'es' ? 'Limpieza' : 'Housekeeping', items: hkItems, alerts: catAlerts.housekeeping },
            { key: 'maintenance' as InventoryCategory, label: lang === 'es' ? 'Mantenimiento' : 'Maintenance', items: maintItems, alerts: catAlerts.maintenance },
            { key: 'breakfast' as InventoryCategory, label: lang === 'es' ? 'Alimentos y Bebidas' : 'Food & Beverage', items: fbItems, alerts: catAlerts.breakfast },
          ]).map(cat => (
            <section key={cat.key} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Category header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 500, color: '#1b1c19' }}>
                  {cat.label}
                </h2>
                {cat.alerts > 0 ? (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: 500,
                    background: '#f0eee9', color: '#454652', padding: '4px 10px', borderRadius: '8px',
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>
                    {cat.alerts} {lang === 'es' ? 'alerta' : 'active alert'}{cat.alerts > 1 ? 's' : ''}
                  </span>
                ) : (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: 500,
                    background: '#006565', color: '#fff', padding: '4px 10px', borderRadius: '8px',
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>
                    {lang === 'es' ? 'Saludable' : 'Healthy'}
                  </span>
                )}
              </div>

              {/* Item cards */}
              {cat.items.length === 0 ? (
                <div style={{
                  padding: '40px 20px', textAlign: 'center', borderRadius: '24px',
                  background: 'rgba(0,0,0,0.02)', border: '1px dashed #c5c5d4',
                }}>
                  <Package size={24} color="#757684" style={{ margin: '0 auto 8px' }} />
                  <p style={{ fontSize: '13px', color: '#757684', fontFamily: "'Inter', sans-serif" }}>
                    {lang === 'es' ? 'Sin artículos' : 'No items'}
                  </p>
                </div>
              ) : (
                cat.items.map(item => {
                  const status = stockStatus(item.currentStock, item.parLevel);
                  const pct = item.parLevel > 0 ? Math.min(100, Math.round((item.currentStock / item.parLevel) * 100)) : 0;
                  const isCritical = status === 'out';
                  const barColor = status === 'good' ? '#364262' : status === 'low' ? '#364262' : '#ba1a1a';
                  const barBg = status === 'out' ? '#ffdad6' : '#f0eee9';

                  return (
                    <div key={item.id} className="inv-card" style={{
                      background: '#fff', borderRadius: '24px', padding: '24px',
                      transition: 'all 300ms',
                    }}>
                      {/* Name + timestamp */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
                        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 500, color: '#454652' }}>
                          {item.name}
                        </span>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
                          color: isCritical ? '#ba1a1a' : '#757684',
                          fontWeight: isCritical ? 700 : 500,
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>
                          {timeAgo(item.updatedAt)}
                        </span>
                      </div>

                      {/* Stock numbers */}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '36px', fontWeight: 500,
                          color: isCritical ? '#ba1a1a' : '#364262', letterSpacing: '-0.02em',
                        }}>
                          {item.currentStock.toLocaleString()}
                        </span>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '18px',
                          color: '#c5c5d4',
                        }}>
                          / {item.parLevel.toLocaleString()}
                        </span>
                      </div>

                      {/* Progress bar */}
                      <div style={{
                        marginTop: '16px', width: '100%', height: '4px',
                        background: barBg, borderRadius: '9999px', overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%', width: `${pct}%`,
                          background: barColor, borderRadius: '9999px',
                          transition: 'width 300ms',
                        }} />
                      </div>

                      {/* Critical warning */}
                      {isCritical && (
                        <div style={{
                          marginTop: '12px', display: 'flex', alignItems: 'center', gap: '6px',
                          color: '#ba1a1a', fontSize: '13px', fontWeight: 500,
                          fontFamily: "'Inter', sans-serif",
                        }}>
                          <AlertTriangle size={14} />
                          {lang === 'es' ? 'Crítico: Reabastecimiento Requerido' : 'Critical: Replenishment Required'}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* Add item for this category */}
              <button
                onClick={() => setShowAddModal(true)}
                style={{
                  background: 'transparent', borderRadius: '24px',
                  padding: '20px', display: 'flex', alignItems: 'center', gap: '16px',
                  border: '2px dashed #c5c5d4', cursor: 'pointer',
                  transition: 'all 200ms',
                }}
              >
                <div style={{
                  width: '44px', height: '44px', borderRadius: '12px', flexShrink: 0,
                  background: '#364262', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Plus size={20} color="#fff" />
                </div>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600, color: '#364262' }}>
                  {lang === 'es' ? 'Agregar Artículo' : 'Add Item'}
                </span>
              </button>
            </section>
          ))}
        </div>
      </div>

      {/* Add item modal */}
      <AddItemModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        uid={user.uid}
        pid={activePropertyId}
        onAdded={() => showToast('Item added ✓')}
      />

      {/* Low Stock Alert */}
      {lowStockAlert && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}
          onClick={() => { setLowStockAlert(null); showToast('Inventory count saved ✓'); }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fbf9f4', borderRadius: '24px',
              width: '100%', maxWidth: '440px', maxHeight: '80vh', overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: '20px 24px', background: '#ba1a1a',
              color: '#fff', display: 'flex', alignItems: 'center', gap: '12px',
              borderRadius: '24px 24px 0 0',
            }}>
              <AlertTriangle size={22} />
              <div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px' }}>
                  {lang === 'es' ? 'Stock Bajo' : 'Running Low'}
                </div>
                <div style={{ fontSize: '13px', opacity: 0.9, fontFamily: "'Inter', sans-serif" }}>
                  {lowStockAlert.length} {lang === 'es' ? 'artículos bajo objetivo' : `item${lowStockAlert.length !== 1 ? 's' : ''} below target`}
                </div>
              </div>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {lowStockAlert.map(item => {
                const status = stockStatus(item.currentStock, item.parLevel);
                const pct = item.parLevel > 0 ? Math.round((item.currentStock / item.parLevel) * 100) : 0;
                return (
                  <div key={item.id} style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '12px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)',
                  }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: STATUS_COLORS[status], flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: '14px', color: '#1b1c19' }}>{item.name}</div>
                      <div style={{ fontSize: '12px', color: '#757684' }}>{item.category} · {item.unit}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '15px', color: STATUS_COLORS[status] }}>
                        {item.currentStock} <span style={{ fontWeight: 400, color: '#757684', fontSize: '12px' }}>/ {item.parLevel}</span>
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#757684' }}>{pct}%</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(197,197,212,0.2)' }}>
              <button
                onClick={() => { setLowStockAlert(null); showToast('Inventory count saved ✓'); }}
                style={{
                  width: '100%', padding: '14px', borderRadius: '9999px',
                  background: '#364262', color: '#fff', border: 'none',
                  fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                {lang === 'es' ? 'Entendido' : 'Got It'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Count Mode Modal */}
      {counting && (
        <CountMode
          items={items}
          uid={user.uid}
          pid={activePropertyId}
          onDone={(updatedCounts) => {
            setCounting(false);
            const lowItems = items.filter(item => {
              const newCount = updatedCounts[item.id] ?? item.currentStock;
              return newCount < item.parLevel && newCount >= 0;
            }).map(item => ({ ...item, currentStock: updatedCounts[item.id] ?? item.currentStock }));
            if (lowItems.length > 0) {
              setLowStockAlert(lowItems);
            } else {
              showToast('Inventory count saved ✓');
            }
          }}
          onCancel={() => setCounting(false)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
          padding: '12px 24px', borderRadius: '9999px',
          background: '#364262', color: '#fff',
          fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600, zIndex: 60,
          boxShadow: '0 8px 24px rgba(54,66,98,0.3)',
          backdropFilter: 'blur(12px)',
          animation: 'fadeIn 200ms ease-out',
        }}>
          {toast}
        </div>
      )}
    </AppLayout>
  );
}

// ─── COUNT MODE ──────────────────────────────────────────────────────────────

function CountMode({
  items, uid, pid, onDone, onCancel,
}: {
  items: InventoryItem[];
  uid: string;
  pid: string;
  onDone: (updatedCounts: Record<string, number>) => void;
  onCancel: () => void;
}) {
  const sorted = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const [counts, setCounts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    sorted.forEach(item => { init[item.id] = String(item.currentStock); });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleSave = async () => {
    setSaving(true);
    try {
      const finalCounts: Record<string, number> = {};
      await Promise.all(
        sorted.map(item => {
          const val = parseInt(counts[item.id] ?? '0') || 0;
          finalCounts[item.id] = val;
          if (val !== item.currentStock) {
            return updateInventoryItem(uid, pid, item.id, { currentStock: val });
          }
          return Promise.resolve();
        })
      );
      onDone(finalCounts);
    } catch {
      setSaving(false);
    }
  };

  const changedCount = sorted.filter(item => {
    const val = parseInt(counts[item.id] ?? '0') || 0;
    return val !== item.currentStock;
  }).length;

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      >
        <div style={{
          background: '#fbf9f4', borderRadius: '24px', width: '100%', maxWidth: '540px',
          maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                Inventory Count
              </h2>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', margin: '4px 0 0' }}>
                Count each item, enter the numbers below.
              </p>
            </div>
            <button
              onClick={onCancel}
              style={{
                padding: '8px 16px', borderRadius: '9999px',
                border: '1px solid #c5c5d4', background: '#fff',
                fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                color: '#454652',
              }}
            >
              Cancel
            </button>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 50px',
              gap: '8px', padding: '10px 24px', background: '#f5f3ee',
              borderBottom: '1px solid rgba(197,197,212,0.2)',
              fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.08em', color: '#757684',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              <span>Item</span>
              <span style={{ textAlign: 'center' }}>Count</span>
              <span style={{ textAlign: 'right' }}>Target</span>
            </div>

            {sorted.map((item, idx) => {
              const val = parseInt(counts[item.id] ?? '0') || 0;
              const status = stockStatus(val, item.parLevel);
              const changed = val !== item.currentStock;
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 80px 50px',
                    gap: '8px', padding: '12px 24px', alignItems: 'center',
                    borderBottom: '1px solid rgba(197,197,212,0.2)',
                    background: changed ? 'rgba(0,101,101,0.04)' : undefined,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: '14px', color: '#1b1c19', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </div>
                    <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', textTransform: 'uppercase' }}>
                      {item.category} · {item.unit}
                    </div>
                  </div>
                  <input
                    ref={el => { inputRefs.current[item.id] = el; }}
                    type="number"
                    min="0"
                    value={counts[item.id] ?? '0'}
                    onChange={e => setCounts(prev => ({ ...prev, [item.id]: e.target.value }))}
                    onFocus={e => e.target.select()}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        const nextItem = sorted[idx + 1];
                        if (nextItem) inputRefs.current[nextItem.id]?.focus();
                      }
                    }}
                    style={{
                      width: '100%', padding: '8px 6px', borderRadius: '12px',
                      border: `2px solid ${changed ? '#006565' : '#c5c5d4'}`,
                      background: '#fff', fontSize: '16px', fontWeight: 700,
                      fontFamily: "'JetBrains Mono', monospace", textAlign: 'center',
                      color: STATUS_COLORS[status], outline: 'none',
                    }}
                  />
                  <div style={{ textAlign: 'right', fontSize: '13px', color: '#757684', fontFamily: "'JetBrains Mono', monospace" }}>
                    {item.parLevel}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(197,197,212,0.2)', background: '#fbf9f4' }}>
            <button
              onClick={handleSave}
              disabled={saving || changedCount === 0}
              style={{
                width: '100%', padding: '14px', borderRadius: '9999px',
                background: changedCount > 0 ? '#364262' : '#eae8e3',
                color: changedCount > 0 ? '#fff' : '#757684', border: 'none',
                fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600,
                cursor: changedCount > 0 ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                opacity: saving ? 0.6 : 1,
              }}
            >
              <Check size={18} />
              {saving ? 'Saving...' : changedCount > 0 ? `Save Count (${changedCount} changed)` : 'No changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Add Item Modal ──────────────────────────────────────────────────────────

function AddItemModal({ isOpen, onClose, uid, pid, onAdded }: {
  isOpen: boolean;
  onClose: () => void;
  uid: string;
  pid: string;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<InventoryCategory>('housekeeping');
  const [stock, setStock] = useState('0');
  const [target, setTarget] = useState('100');
  const [unit, setUnit] = useState('units');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await addInventoryItem(uid, pid, {
        propertyId: pid,
        name: name.trim(),
        category,
        currentStock: parseInt(stock) || 0,
        parLevel: parseInt(target) || 100,
        unit: unit.trim() || 'units',
      });
      onAdded();
      onClose();
      setName(''); setStock('0'); setTarget('100'); setUnit('units');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '16px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#1b1c19',
    outline: 'none',
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: '500px',
        background: '#fbf9f4', borderRadius: '24px 24px 0 0',
        padding: '24px 24px calc(24px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
            Add Item
          </h2>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '16px', color: '#454652', lineHeight: 1 }}>✕</span>
          </button>
        </div>
        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>Item Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bath Towels" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>Category</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(['housekeeping', 'maintenance', 'breakfast'] as InventoryCategory[]).map(c => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                style={{
                  padding: '8px 16px', borderRadius: '9999px', border: 'none',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  background: category === c ? '#006565' : '#f0eee9',
                  color: category === c ? '#fff' : '#454652',
                  transition: 'all 150ms',
                }}
              >
                {c === 'housekeeping' ? 'Housekeeping' : c === 'maintenance' ? 'Maintenance' : 'Breakfast/F&B'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>In Stock</label>
            <input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>Target</label>
            <input type="number" min="0" value={target} onChange={e => setTarget(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>Unit</label>
            <input value={unit} onChange={e => setUnit(e.target.value)} placeholder="units" style={inputStyle} />
          </div>
        </div>
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || saving}
          style={{
            width: '100%', padding: '16px', border: 'none',
            borderRadius: '9999px', cursor: name.trim() && !saving ? 'pointer' : 'not-allowed',
            background: name.trim() && !saving ? '#364262' : '#eae8e3',
            color: name.trim() && !saving ? '#fff' : '#757684',
            fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600,
            transition: 'all 150ms', minHeight: '52px',
          }}
        >
          {saving ? 'Saving...' : 'Add Item'}
        </button>
      </div>
    </div>
  );
}
