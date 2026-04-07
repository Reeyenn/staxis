'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
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

const STATUS_COLORS = { good: 'var(--green)', low: 'var(--amber)', out: 'var(--red)' };
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

  // ─── COUNT MODE ────────────────────────────────────────────────────────────
  if (counting) {
    return (
      <CountMode
        items={items}
        uid={user.uid}
        pid={activePropertyId}
        onDone={(updatedCounts) => {
          setCounting(false);
          // Check which items are now below target
          const lowItems = items.filter(item => {
            const newCount = updatedCounts[item.id] ?? item.currentStock;
            return newCount < item.parLevel && newCount >= 0;
          }).map(item => ({ ...item, currentStock: updatedCounts[item.id] ?? item.currentStock }));
          if (lowItems.length > 0) {
            setLowStockAlert(lowItems);
            // TODO: Twilio SMS — when verified, call API route to text owner
            // e.g. fetch('/api/alerts/low-stock', { method: 'POST', body: JSON.stringify({ items: lowItems }) })
          } else {
            showToast('Inventory count saved ✓');
          }
        }}
        onCancel={() => setCounting(false)}
      />
    );
  }

  // ─── MAIN VIEW ─────────────────────────────────────────────────────────────
  return (
    <AppLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '100px', alignItems: 'center' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', margin: 0, alignSelf: 'flex-start' }}>
          {lang === 'es' ? 'Inventario' : 'Inventory'}
        </h1>

        {/* Count CTA */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '20px',
          padding: '14px 24px', borderRadius: 'var(--radius-lg)',
          background: 'linear-gradient(135deg, var(--navy, #1b3a5c), var(--navy-light, #2a5a8c))',
          color: '#fff',
        }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
              {lang === 'es' ? 'Conteo Semanal de Inventario' : 'Weekly Inventory Count'}
            </div>
            <div style={{ fontSize: '12px', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={12} />
              {lang === 'es' ? 'Último conteo: ' : 'Last counted: '}{lastCounted ? timeAgo(lastCounted) : (lang === 'es' ? 'Nunca' : 'Never')}
              {lowCount > 0 && (
                <span style={{ marginLeft: '8px', padding: '2px 8px', borderRadius: '99px', background: 'rgba(220,38,38,0.3)', fontSize: '11px', fontWeight: 600 }}>
                  {lowCount} {lang === 'es' ? 'bajo' : 'low'}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setCounting(true)}
            style={{
              padding: '10px 20px', borderRadius: 'var(--radius-md)',
              background: '#fff', color: 'var(--navy, #1b3a5c)', border: 'none',
              fontWeight: 700, fontSize: '14px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}
          >
            <ClipboardCheck size={16} />
            {lang === 'es' ? 'Contar Ahora' : 'Count Now'}
          </button>
        </div>

        {/* Category filters */}
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
          {CATEGORIES.map(cat => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              style={{
                padding: '6px 14px', borderRadius: 'var(--radius-full)',
                border: activeCategory === cat.key ? 'none' : '1px solid var(--border)',
                background: activeCategory === cat.key ? 'var(--navy, #1b3a5c)' : 'var(--bg)',
                color: activeCategory === cat.key ? '#fff' : 'var(--text-secondary)',
                fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px',
              }}
            >
              {lang === 'es' ? cat.labelEs : cat.label}
              <span style={{
                fontSize: '11px', fontWeight: 700,
                opacity: activeCategory === cat.key ? 0.8 : 0.5,
              }}>
                {categoryCounts[cat.key] ?? 0}
              </span>
            </button>
          ))}
        </div>

        {/* Item grid — 3 columns */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', width: '100%',
          borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden',
        }}>
          {sortedItems.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center' }}>
              <Package size={28} color="var(--text-muted)" style={{ margin: '0 auto 8px' }} />
              <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                {lang === 'es' ? 'No hay artículos en esta categoría' : 'No items in this category'}
              </p>
            </div>
          ) : (
            sortedItems.map(item => {
              const status = stockStatus(item.currentStock, item.parLevel);
              const pct = item.parLevel > 0 ? Math.min(100, Math.round((item.currentStock / item.parLevel) * 100)) : 0;
              return (
                <div key={item.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px',
                  borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)',
                  minHeight: '44px',
                }}>
                  {/* Status dot */}
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: STATUS_COLORS[status], flexShrink: 0 }} />

                  {/* Name + time */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
                      {timeAgo(item.updatedAt)}
                    </div>
                  </div>

                  {/* Count / Target */}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13px', color: STATUS_COLORS[status] }}>
                      {item.currentStock}
                    </div>
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                      / {item.parLevel}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* FAB */}
      <button
        onClick={() => setShowAddModal(true)}
        aria-label="Add Item"
        style={{
          position: 'fixed', bottom: '80px', right: '20px', zIndex: 30,
          width: '52px', height: '52px', borderRadius: '50%',
          background: 'var(--navy)', color: '#fff', border: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', boxShadow: '0 4px 16px rgba(27,58,92,0.3)',
        }}
      >
        <Plus size={22} />
      </button>

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
          background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '20px',
        }}
          onClick={() => { setLowStockAlert(null); showToast('Inventory count saved ✓'); }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface, #fff)', borderRadius: 'var(--radius-lg)',
              width: '100%', maxWidth: '400px', maxHeight: '80vh', overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* Alert header */}
            <div style={{
              padding: '16px 20px', background: 'linear-gradient(135deg, var(--red), #ef4444)',
              color: '#fff', display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <AlertTriangle size={22} />
              <div>
                <div style={{ fontWeight: 700, fontSize: '16px' }}>Running Low</div>
                <div style={{ fontSize: '12px', opacity: 0.9 }}>
                  {lowStockAlert.length} item{lowStockAlert.length !== 1 ? 's' : ''} below target
                </div>
              </div>
            </div>

            {/* Item list */}
            <div style={{ overflow: 'auto', flex: 1 }}>
              {lowStockAlert.map(item => {
                const status = stockStatus(item.currentStock, item.parLevel);
                const pct = item.parLevel > 0 ? Math.round((item.currentStock / item.parLevel) * 100) : 0;
                return (
                  <div key={item.id} style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 20px', borderBottom: '1px solid var(--border)',
                  }}>
                    <span style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      background: STATUS_COLORS[status], flexShrink: 0,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {item.name}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {item.category} · {item.unit}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{
                        fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px',
                        color: STATUS_COLORS[status],
                      }}>
                        {item.currentStock} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>/ {item.parLevel}</span>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{pct}%</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Dismiss button */}
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)' }}>
              <button
                onClick={() => { setLowStockAlert(null); showToast('Inventory count saved ✓'); }}
                style={{
                  width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
                  background: 'var(--navy, #1b3a5c)', color: '#fff', border: 'none',
                  fontSize: '14px', fontWeight: 700, cursor: 'pointer',
                }}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '140px', left: '50%', transform: 'translateX(-50%)',
          padding: '10px 20px', borderRadius: 'var(--radius-lg)',
          background: 'var(--navy)', color: '#fff',
          fontSize: '13px', fontWeight: 600, zIndex: 50,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
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
    <AppLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '100px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Inventory Count
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Go to the supply room, count each item, enter the numbers below.
            </p>
          </div>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)', background: 'var(--bg)',
              fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            Cancel
          </button>
        </div>

        {/* Count list */}
        <div style={{ borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 90px 60px',
            gap: '8px', padding: '8px 14px', background: 'rgba(0,0,0,0.03)',
            borderBottom: '1px solid var(--border)',
            fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'var(--text-muted)',
          }}>
            <span>Item</span>
            <span style={{ textAlign: 'center' }}>Count</span>
            <span style={{ textAlign: 'right' }}>Target</span>
          </div>

          {/* Item rows */}
          {sorted.map((item, idx) => {
            const val = parseInt(counts[item.id] ?? '0') || 0;
            const status = stockStatus(val, item.parLevel);
            const changed = val !== item.currentStock;
            return (
              <div
                key={item.id}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 90px 60px',
                  gap: '8px', padding: '10px 14px', alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  background: changed ? 'rgba(34,197,94,0.04)' : undefined,
                }}
              >
                {/* Name + category */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    {item.category} · {item.unit}
                  </div>
                </div>

                {/* Count input */}
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
                    width: '100%', padding: '8px 10px', borderRadius: '6px',
                    border: `2px solid ${changed ? 'var(--green)' : 'var(--border)'}`,
                    background: 'var(--bg)', fontSize: '16px', fontWeight: 700,
                    fontFamily: 'var(--font-mono)', textAlign: 'center',
                    color: STATUS_COLORS[status],
                  }}
                />

                {/* Target */}
                <div style={{ textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {item.parLevel}
                </div>
              </div>
            );
          })}
        </div>

        {/* Save button — sticky at bottom */}
        <div style={{
          position: 'fixed', bottom: '70px', left: 0, right: 0,
          padding: '12px 20px', background: 'var(--surface, #fff)',
          borderTop: '1px solid var(--border)', zIndex: 30,
        }}>
          <button
            onClick={handleSave}
            disabled={saving || changedCount === 0}
            style={{
              width: '100%', padding: '14px', borderRadius: 'var(--radius-md)',
              background: changedCount > 0 ? 'var(--navy, #1b3a5c)' : 'var(--border)',
              color: '#fff', border: 'none',
              fontSize: '15px', fontWeight: 700, cursor: changedCount > 0 ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              opacity: saving ? 0.6 : 1,
            }}
          >
            <Check size={18} />
            {saving ? 'Saving...' : changedCount > 0 ? `Save Count (${changedCount} changed)` : 'No changes'}
          </button>
        </div>
      </div>
    </AppLayout>
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

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)',
    border: '1.5px solid var(--border)', background: 'var(--bg)',
    fontSize: '14px', color: 'var(--text-primary)',
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Item">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            Item Name *
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bath Towels" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            Category
          </label>
          <select value={category} onChange={e => setCategory(e.target.value as InventoryCategory)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="housekeeping">Housekeeping</option>
            <option value="maintenance">Maintenance</option>
            <option value="breakfast">Breakfast/F&B</option>
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              In Stock
            </label>
            <input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Target Stock
            </label>
            <input type="number" min="0" value={target} onChange={e => setTarget(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              Unit
            </label>
            <input value={unit} onChange={e => setUnit(e.target.value)} placeholder="units" style={inputStyle} />
          </div>
        </div>
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || saving}
          className="btn btn-primary"
          style={{ marginTop: '4px', opacity: !name.trim() || saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving...' : 'Add Item'}
        </button>
      </div>
    </Modal>
  );
}
