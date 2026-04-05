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
  getRoomsForDate,
} from '@/lib/firestore';
import { computePredictions, extractRoomCounts } from '@/lib/inventory-predictions';
import type { InventoryItem, InventoryCategory } from '@/types';
import type { ItemPrediction } from '@/lib/inventory-predictions';
import {
  Plus, Minus, Package, AlertTriangle, Copy, Check,
  Settings2, ClipboardList, BarChart3, Pencil,
} from 'lucide-react';

// ─── Constants ───────────────────────────────────────────────────────────────

type TabKey = 'overview' | 'reorder' | 'settings';

const TABS: { key: TabKey; icon: React.ReactNode; labelKey: 'overview' | 'reorderList' | 'usageSettings' }[] = [
  { key: 'overview', icon: <BarChart3 size={14} />, labelKey: 'overview' },
  { key: 'reorder', icon: <ClipboardList size={14} />, labelKey: 'reorderList' },
  { key: 'settings', icon: <Settings2 size={14} />, labelKey: 'usageSettings' },
];

const CATEGORIES: { key: InventoryCategory | 'all'; labelKey: 'allCategories' | 'housekeepingCategory' | 'maintenanceCategory' | 'breakfastFbCategory' }[] = [
  { key: 'all', labelKey: 'allCategories' },
  { key: 'housekeeping', labelKey: 'housekeepingCategory' },
  { key: 'maintenance', labelKey: 'maintenanceCategory' },
  { key: 'breakfast', labelKey: 'breakfastFbCategory' },
];

const URGENCY_COLORS: Record<ItemPrediction['reorderUrgency'], string> = {
  critical: '#dc2626',
  soon: '#f59e0b',
  ok: '#22c55e',
  overstocked: '#3b82f6',
};

const DEFAULTS: Omit<InventoryItem, 'id' | 'updatedAt' | 'propertyId'>[] = [
  { name: 'King Sheets', category: 'housekeeping', currentStock: 0, parLevel: 80, unit: 'sets', usagePerCheckout: 1, usagePerStayover: 0, reorderLeadDays: 5, vendorName: '' },
  { name: 'Queen Sheets', category: 'housekeeping', currentStock: 0, parLevel: 120, unit: 'sets', usagePerCheckout: 1, usagePerStayover: 0, reorderLeadDays: 5, vendorName: '' },
  { name: 'Bath Towels', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units', usagePerCheckout: 3, usagePerStayover: 0.5, reorderLeadDays: 3, vendorName: '' },
  { name: 'Hand Towels', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units', usagePerCheckout: 2, usagePerStayover: 0.3, reorderLeadDays: 3, vendorName: '' },
  { name: 'Washcloths', category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units', usagePerCheckout: 2, usagePerStayover: 0.3, reorderLeadDays: 3, vendorName: '' },
  { name: 'Bath Mats', category: 'housekeeping', currentStock: 0, parLevel: 100, unit: 'units', usagePerCheckout: 1, usagePerStayover: 0, reorderLeadDays: 3, vendorName: '' },
  { name: 'Shampoo', category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles', usagePerCheckout: 1, usagePerStayover: 0.3, reorderLeadDays: 3, vendorName: '' },
  { name: 'Conditioner', category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles', usagePerCheckout: 1, usagePerStayover: 0.2, reorderLeadDays: 3, vendorName: '' },
  { name: 'Body Wash', category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles', usagePerCheckout: 1, usagePerStayover: 0.3, reorderLeadDays: 3, vendorName: '' },
  { name: 'All-Purpose Cleaner', category: 'housekeeping', currentStock: 0, parLevel: 24, unit: 'bottles', usagePerCheckout: 0.02, usagePerStayover: 0.01, reorderLeadDays: 5, vendorName: '' },
  { name: 'Glass Cleaner', category: 'housekeeping', currentStock: 0, parLevel: 12, unit: 'bottles', usagePerCheckout: 0.01, usagePerStayover: 0.005, reorderLeadDays: 5, vendorName: '' },
  { name: 'Trash Liners (Large)', category: 'housekeeping', currentStock: 0, parLevel: 500, unit: 'bags', usagePerCheckout: 2, usagePerStayover: 1, reorderLeadDays: 3, vendorName: '' },
  { name: 'Coffee Pods', category: 'breakfast', currentStock: 0, parLevel: 200, unit: 'pods', usagePerCheckout: 2, usagePerStayover: 1, reorderLeadDays: 3, vendorName: '' },
  { name: 'Light Bulbs (LED)', category: 'maintenance', currentStock: 0, parLevel: 50, unit: 'bulbs', usagePerCheckout: 0, usagePerStayover: 0, reorderLeadDays: 7, vendorName: '' },
  { name: 'HVAC Filters', category: 'maintenance', currentStock: 0, parLevel: 10, unit: 'filters', usagePerCheckout: 0, usagePerStayover: 0, reorderLeadDays: 14, vendorName: '' },
];

// ─── Sub-components ──────────────────────────────────────────────────────────

function ProgressBar({ value, max, color, label }: { value: number; max: number; color: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        style={{ flex: 1, height: '6px', background: 'rgba(0,0,0,0.08)', borderRadius: '99px', overflow: 'hidden' }}
      >
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '99px', transition: 'width 400ms ease' }} />
      </div>
      <span style={{ fontSize: '12px', fontWeight: 600, fontFamily: 'var(--font-mono)', color, minWidth: '30px', textAlign: 'right' }}>
        {pct}%
      </span>
    </div>
  );
}

function CategoryPill({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        padding: '6px 14px', borderRadius: 'var(--radius-full)',
        border: active ? '1.5px solid var(--navy)' : '1.5px solid var(--border)',
        background: active ? 'var(--navy)' : 'transparent',
        color: active ? '#fff' : 'var(--text-secondary)',
        fontSize: '12px', fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
        transition: 'all 150ms',
      }}
    >
      {label}
      <span style={{
        fontSize: '11px', fontWeight: 700,
        background: active ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.06)',
        padding: '1px 6px', borderRadius: '99px',
      }}>
        {count}
      </span>
    </button>
  );
}

function ItemCard({
  prediction,
  lang,
  onIncrement,
  onDecrement,
  onEdit,
  onGoSettings,
}: {
  prediction: ItemPrediction;
  lang: 'en' | 'es';
  onIncrement: () => void;
  onDecrement: () => void;
  onEdit: () => void;
  onGoSettings: () => void;
}) {
  const { item, dailyBurnRate, daysUntilEmpty, reorderUrgency } = prediction;
  const color = URGENCY_COLORS[reorderUrgency];
  const pct = item.parLevel > 0 ? Math.min(100, Math.round((item.currentStock / item.parLevel) * 100)) : (item.currentStock > 0 ? 100 : 0);
  const hasBurnRate = dailyBurnRate > 0;

  const categoryLabel = {
    housekeeping: t('housekeepingCategory', lang),
    maintenance: t('maintenanceCategory', lang),
    breakfast: t('breakfastFbCategory', lang),
  }[item.category];

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        minHeight: '48px',
      }}
    >
      {/* Name + category badge */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: color, flexShrink: 0,
        }} />
        <span style={{
          fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {item.name}
        </span>
        <span style={{
          fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: 'var(--text-muted)',
          padding: '1px 6px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--radius-full)',
          flexShrink: 0, whiteSpace: 'nowrap',
        }}>
          {categoryLabel}
        </span>
      </div>

      {/* Stock fraction */}
      <span style={{ fontSize: '11px', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', minWidth: '50px', textAlign: 'right' }}>
        {item.currentStock}/{item.parLevel}
      </span>

      {/* Thin progress bar */}
      <div style={{ width: '60px', height: '4px', background: 'rgba(0,0,0,0.08)', borderRadius: '99px', overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '99px', transition: 'width 400ms ease' }} />
      </div>

      {/* Burn rate inline */}
      {hasBurnRate && (
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', minWidth: '80px' }}>
          {reorderUrgency === 'critical' && <span style={{ color: '#dc2626', fontWeight: 600 }}>⚠️ Critical</span>}
          {reorderUrgency === 'soon' && <span style={{ color: '#f59e0b', fontWeight: 600 }}>Soon</span>}
          {reorderUrgency === 'ok' && <span>OK</span>}
        </span>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
        <button
          onClick={onDecrement}
          aria-label={`Decrease ${item.name} stock`}
          style={{
            width: '32px', height: '32px', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)', background: 'var(--bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--text-secondary)', padding: 0,
          }}
        >
          <Minus size={12} />
        </button>
        <button
          onClick={onIncrement}
          aria-label={`Increase ${item.name} stock`}
          style={{
            width: '32px', height: '32px', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)', background: 'var(--bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--text-secondary)', padding: 0,
          }}
        >
          <Plus size={12} />
        </button>
        <button
          onClick={onEdit}
          aria-label={`Edit ${item.name}`}
          style={{
            width: '32px', height: '32px', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)', background: 'var(--bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--text-secondary)', padding: 0,
          }}
        >
          <Pencil size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [roomHistory, setRoomHistory] = useState<{ date: string; checkouts: number; stayovers: number }[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [activeCategory, setActiveCategory] = useState<InventoryCategory | 'all'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const seededRef = useRef(false);
  const pendingStockRef = useRef<Record<string, number>>({});
  const stockTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Subscribe to inventory items
  useEffect(() => {
    if (!user || !activePropertyId) return;
    let isFirst = true;
    // Map old categories to new ones (one-time migration)
    const OLD_TO_NEW: Record<string, InventoryCategory> = {
      linens: 'housekeeping', towels: 'housekeeping', amenities: 'housekeeping',
      cleaning: 'housekeeping', other: 'housekeeping',
    };
    let migrated = false;
    const unsub = subscribeToInventory(user.uid, activePropertyId, (snapshot) => {
      // Migrate items with old category values (runs once per mount)
      if (!migrated) {
        migrated = true;
        snapshot.forEach(item => {
          const mapped = OLD_TO_NEW[item.category];
          if (mapped) {
            updateInventoryItem(user.uid, activePropertyId, item.id, { category: mapped });
          }
        });
      }
      setItems(snapshot.map(item => {
        const mapped = OLD_TO_NEW[item.category];
        return mapped ? { ...item, category: mapped } : item;
      }));
      // Seed defaults on first empty snapshot (seededRef prevents Strict Mode double-fire)
      if (isFirst && snapshot.length === 0 && !seededRef.current) {
        seededRef.current = true;
        DEFAULTS.forEach(def => {
          addInventoryItem(user.uid, activePropertyId, { ...def, propertyId: activePropertyId });
        });
      }
      isFirst = false;
    });
    return unsub;
  }, [user, activePropertyId]);

  // Load last 7 days of room data
  useEffect(() => {
    if (!user || !activePropertyId) return;
    let cancelled = false;
    const loadHistory = async () => {
      const dates = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (i + 1));
        return d.toLocaleDateString('en-CA');
      });
      const results = await Promise.all(
        dates.map(date => getRoomsForDate(user.uid, activePropertyId, date))
      );
      if (cancelled) return;
      const history = dates.map((date, i) => ({
        date,
        ...extractRoomCounts(results[i]),
      }));
      setRoomHistory(history);
      setHistoryLoaded(true);
    };
    loadHistory();
    return () => { cancelled = true; };
  }, [user, activePropertyId]);

  // Compute predictions
  const predictions = useMemo(() =>
    computePredictions(items, roomHistory),
    [items, roomHistory]
  );

  const criticalItems = useMemo(() => predictions.filter(p => p.reorderUrgency === 'critical'), [predictions]);
  const belowPar = useMemo(() => items.filter(i => i.currentStock < i.parLevel), [items]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    CATEGORIES.slice(1).forEach(cat => {
      counts[cat.key] = items.filter(i => i.category === cat.key).length;
    });
    return counts;
  }, [items]);

  // Avg checkouts
  const avgCheckouts = useMemo(() => {
    if (roomHistory.length === 0) return 0;
    return Math.round(roomHistory.reduce((s, d) => s + d.checkouts, 0) / roomHistory.length);
  }, [roomHistory]);

  // Sorted + filtered predictions
  const sortedPredictions = useMemo(() => {
    const urgencyOrder: Record<string, number> = { critical: 0, soon: 1, ok: 2, overstocked: 3 };
    let filtered = activeCategory === 'all'
      ? predictions
      : predictions.filter(p => p.item.category === activeCategory);
    return [...filtered].sort((a, b) => {
      const ua = urgencyOrder[a.reorderUrgency] ?? 2;
      const ub = urgencyOrder[b.reorderUrgency] ?? 2;
      if (ua !== ub) return ua - ub;
      return a.item.name.localeCompare(b.item.name);
    });
  }, [predictions, activeCategory]);

  // Reorder items
  const reorderItems = useMemo(() =>
    predictions
      .filter(p => p.reorderUrgency === 'critical' || p.reorderUrgency === 'soon')
      .sort((a, b) => {
        if (a.reorderUrgency === 'critical' && b.reorderUrgency !== 'critical') return -1;
        if (b.reorderUrgency === 'critical' && a.reorderUrgency !== 'critical') return 1;
        return a.item.name.localeCompare(b.item.name);
      }),
    [predictions]
  );

  // Toast helper
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // Stock adjustments — batches rapid taps with a short debounce
  const adjustStock = useCallback((item: InventoryItem, delta: number) => {
    if (!user || !activePropertyId) return;
    const key = item.id;
    const pending = pendingStockRef.current[key] ?? item.currentStock;
    pendingStockRef.current[key] = Math.max(0, pending + delta);
    // Optimistic UI update
    setItems(prev => prev.map(i => i.id === key ? { ...i, currentStock: pendingStockRef.current[key] } : i));
    if (stockTimerRef.current) clearTimeout(stockTimerRef.current);
    stockTimerRef.current = setTimeout(() => {
      const finalStock = pendingStockRef.current[key];
      if (finalStock !== undefined) {
        updateInventoryItem(user.uid, activePropertyId, key, { currentStock: finalStock });
        delete pendingStockRef.current[key];
        showToast(t('stockUpdated', lang));
      }
    }, 300);
  }, [user, activePropertyId, lang, showToast]);

  // Copy reorder list
  const copyReorderList = useCallback(async () => {
    const criticalList = reorderItems.filter(p => p.reorderUrgency === 'critical');
    const soonList = reorderItems.filter(p => p.reorderUrgency === 'soon');
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let text = `REORDER LIST — ${activeProperty?.name ?? 'Property'} — ${today}\n\n`;

    if (criticalList.length > 0) {
      text += 'CRITICAL:\n';
      criticalList.forEach(p => {
        const qty = suggestedOrderQty(p);
        text += `- ${p.item.name}: Order ${qty} ${p.item.unit}${p.item.vendorName ? ` (${p.item.vendorName})` : ''}\n`;
      });
      text += '\n';
    }
    if (soonList.length > 0) {
      text += 'ORDER SOON:\n';
      soonList.forEach(p => {
        const qty = suggestedOrderQty(p);
        text += `- ${p.item.name}: Order ${qty} ${p.item.unit}${p.item.vendorName ? ` (${p.item.vendorName})` : ''}\n`;
      });
    }

    try {
      await navigator.clipboard.writeText(text);
      showToast(t('copiedToClipboard', lang) + ' ✓');
    } catch {
      showToast(lang === 'es' ? 'Error al copiar' : 'Failed to copy');
    }
  }, [reorderItems, activeProperty, lang, showToast]);

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  if (!user || !activePropertyId) return null;

  return (
    <AppLayout>
      <div style={{ padding: '16px 20px 100px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* Header */}
        <div className="animate-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {t('inventoryTracking', lang)}
          </h1>
        </div>

        {/* Tab bar */}
        <div className="animate-in stagger-1" style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.04)', borderRadius: 'var(--radius-lg)', padding: '3px' }}>
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                padding: '10px 8px', borderRadius: 'var(--radius-md)',
                border: 'none', cursor: 'pointer',
                background: activeTab === tab.key ? 'var(--bg-card)' : 'transparent',
                color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: activeTab === tab.key ? 600 : 500,
                fontSize: '13px',
                boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 150ms',
              }}
            >
              {tab.icon}
              {t(tab.labelKey, lang)}
            </button>
          ))}
        </div>

        {/* ═══ OVERVIEW TAB ═══ */}
        {activeTab === 'overview' && (
          <>
            {/* Alert banner */}
            {criticalItems.length > 0 && (
              <div
                className="animate-in stagger-1"
                style={{
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-lg)',
                  background: 'linear-gradient(135deg, rgba(220,38,38,0.06) 0%, rgba(220,38,38,0.12) 100%)',
                  border: '1px solid rgba(220,38,38,0.2)',
                  display: 'flex', alignItems: 'center', gap: '12px',
                }}
              >
                <div style={{
                  width: '40px', height: '40px', borderRadius: '10px',
                  background: 'rgba(220,38,38,0.12)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <AlertTriangle size={18} color="#dc2626" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: '#dc2626', marginBottom: '2px' }}>
                    {criticalItems.length} {t('needsOrderingNow', lang)}
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {criticalItems.slice(0, 3).map(p => p.item.name).join(', ')}
                    {criticalItems.length > 3 ? ` +${criticalItems.length - 3}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => setActiveTab('reorder')}
                  style={{
                    padding: '8px 14px', borderRadius: 'var(--radius-md)',
                    background: '#dc2626', color: '#fff', border: 'none',
                    fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    flexShrink: 0, whiteSpace: 'nowrap',
                  }}
                >
                  {t('reorderList', lang)}
                </button>
              </div>
            )}

            {/* Stat cards */}
            <div className="animate-in stagger-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              <StatMini icon={<Package size={16} color="var(--navy)" />} iconBg="rgba(27,58,92,0.08)" label={t('totalItems', lang)} value={items.length} />
              <StatMini icon={<AlertTriangle size={16} color="#dc2626" />} iconBg="rgba(220,38,38,0.08)" label={t('belowPar', lang)} value={belowPar.length} />
              <StatMini icon={<BarChart3 size={16} color="var(--navy)" />} iconBg="rgba(27,58,92,0.08)" label={t('avgCheckoutsPerDay', lang)} value={historyLoaded ? `~${avgCheckouts}` : '—'} sub={historyLoaded ? '7d' : ''} />
            </div>

            {/* Category filter pills */}
            <div className="animate-in stagger-2" style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px', WebkitOverflowScrolling: 'touch' }}>
              {CATEGORIES.map(cat => (
                <CategoryPill
                  key={cat.key}
                  label={t(cat.labelKey, lang)}
                  count={categoryCounts[cat.key] ?? 0}
                  active={activeCategory === cat.key}
                  onClick={() => setActiveCategory(cat.key)}
                />
              ))}
            </div>

            {/* Item cards */}
            <div className="animate-in stagger-2" style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
              {sortedPredictions.length === 0 ? (
                <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
                  <Package size={28} color="var(--text-muted)" style={{ margin: '0 auto 8px' }} />
                  <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                    {t('noInventoryItems', lang)}
                  </p>
                </div>
              ) : (
                sortedPredictions.map(pred => (
                  <ItemCard
                    key={pred.item.id}
                    prediction={pred}
                    lang={lang}
                    onIncrement={() => adjustStock(pred.item, 1)}
                    onDecrement={() => adjustStock(pred.item, -1)}
                    onEdit={() => setEditItem(pred.item)}
                    onGoSettings={() => setActiveTab('settings')}
                  />
                ))
              )}
            </div>
          </>
        )}

        {/* ═══ REORDER TAB ═══ */}
        {activeTab === 'reorder' && (
          <>
            {reorderItems.length > 0 && (
              <button
                onClick={copyReorderList}
                className="btn btn-primary"
                style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}
              >
                <Copy size={14} />
                {t('copyReorderList', lang)}
              </button>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
              {reorderItems.length === 0 ? (
                <div className="card" style={{ padding: '40px 20px', textAlign: 'center' }}>
                  <Check size={32} color="var(--green)" style={{ margin: '0 auto 12px' }} />
                  <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                    {t('allStockedUp', lang)}
                  </p>
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                    🎉
                  </p>
                </div>
              ) : (
                reorderItems.map(pred => {
                  const { item, dailyBurnRate, daysUntilEmpty, reorderUrgency } = pred;
                  const color = URGENCY_COLORS[reorderUrgency];
                  const qty = suggestedOrderQty(pred);

                  return (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                        borderBottom: '1px solid var(--border)',
                        borderLeft: `3px solid ${color}`,
                        minHeight: '52px',
                      }}
                    >
                      {/* Item name and details */}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{
                          fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {item.name}
                          {item.vendorName && (
                            <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px', marginLeft: '4px' }}>
                              ({item.vendorName})
                            </span>
                          )}
                        </span>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '12px' }}>
                          <span>{item.currentStock}/{item.parLevel}</span>
                          {reorderUrgency === 'critical'
                            ? <span style={{ color: '#dc2626', fontWeight: 600 }}>Critical</span>
                            : <span style={{ color: '#f59e0b', fontWeight: 600 }}>Soon</span>
                          }
                        </div>
                      </div>

                      {/* Suggested order */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '1px', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          Order {qty}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {item.unit}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* ═══ SETTINGS TAB ═══ */}
        {activeTab === 'settings' && (
          <>
            <div className="card" style={{ padding: '14px 16px' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {t('usageSettingsDesc', lang)}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {items.map(item => (
                <UsageSettingsCard key={item.id} item={item} lang={lang} uid={user.uid} pid={activePropertyId} />
              ))}
            </div>
          </>
        )}

      </div>

      {/* FAB */}
      <button
        onClick={() => setShowAddModal(true)}
        aria-label={t('addItem', lang)}
        style={{
          position: 'fixed', bottom: '80px', right: '20px', zIndex: 30,
          width: '52px', height: '52px', borderRadius: '50%',
          background: 'var(--navy)', color: '#fff', border: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 4px 16px rgba(27,58,92,0.3)',
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
        lang={lang}
        onAdded={() => showToast(t('itemAdded', lang) + ' ✓')}
      />

      {/* Edit item modal */}
      {editItem && (
        <EditItemModal
          isOpen={!!editItem}
          onClose={() => setEditItem(null)}
          item={editItem}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onSaved={() => { setEditItem(null); showToast(t('stockUpdated', lang)); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '140px', left: '50%', transform: 'translateX(-50%)',
          padding: '10px 20px', borderRadius: 'var(--radius-lg)',
          background: 'var(--navy)', color: '#fff',
          fontSize: '13px', fontWeight: 600, zIndex: 50,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          animation: 'fadeIn 200ms ease',
        }}>
          {toast}
        </div>
      )}
    </AppLayout>
  );
}

// ─── Stat Mini ───────────────────────────────────────────────────────────────

function StatMini({ icon, iconBg, label, value, sub }: { icon: React.ReactNode; iconBg: string; label: string; value: string | number; sub?: string }) {
  return (
    <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
      <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', marginBottom: '2px' }}>{label}</p>
        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '22px', lineHeight: 1, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
          {value}
        </div>
        {sub && <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</p>}
      </div>
    </div>
  );
}

// ─── Suggested order quantity ────────────────────────────────────────────────

function suggestedOrderQty(pred: ItemPrediction): number {
  const raw = (pred.dailyBurnRate * 14) - pred.item.currentStock + pred.item.parLevel;
  return Math.max(10, Math.ceil(raw / 10) * 10);
}

// ─── Usage Settings Card ─────────────────────────────────────────────────────

function UsageSettingsCard({ item, lang, uid, pid }: { item: InventoryItem; lang: 'en' | 'es'; uid: string; pid: string }) {
  const [checkout, setCheckout] = useState(String(item.usagePerCheckout ?? 0));
  const [stayover, setStayover] = useState(String(item.usagePerStayover ?? 0));
  const [leadDays, setLeadDays] = useState(String(item.reorderLeadDays ?? 3));
  const [vendor, setVendor] = useState(item.vendorName ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const save = useCallback((field: string, value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const numVal = parseFloat(value);
      if (field === 'vendorName') {
        updateInventoryItem(uid, pid, item.id, { vendorName: value });
      } else if (!isNaN(numVal)) {
        updateInventoryItem(uid, pid, item.id, { [field]: numVal });
      }
    }, 500);
  }, [uid, pid, item.id]);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-md)',
    border: '1.5px solid var(--border)', background: 'var(--bg)',
    fontSize: '14px', fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
        {item.name}
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('usagePerCheckout', lang)}
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={checkout}
            onChange={e => setCheckout(e.target.value)}
            onBlur={() => save('usagePerCheckout', checkout)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('usagePerStayover', lang)}
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={stayover}
            onChange={e => setStayover(e.target.value)}
            onBlur={() => save('usagePerStayover', stayover)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('reorderLeadDays', lang)}
          </label>
          <input
            type="number"
            step="1"
            min="0"
            value={leadDays}
            onChange={e => setLeadDays(e.target.value)}
            onBlur={() => save('reorderLeadDays', leadDays)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('vendor', lang)}
          </label>
          <input
            type="text"
            value={vendor}
            onChange={e => setVendor(e.target.value)}
            onBlur={() => save('vendorName', vendor)}
            placeholder="e.g. HD Supply"
            style={{ ...inputStyle, fontFamily: 'var(--font-sans)' }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Add Item Modal ──────────────────────────────────────────────────────────

function AddItemModal({ isOpen, onClose, uid, pid, lang, onAdded }: {
  isOpen: boolean;
  onClose: () => void;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<InventoryCategory>('housekeeping');
  const [stock, setStock] = useState('0');
  const [parLevel, setParLevel] = useState('100');
  const [unit, setUnit] = useState('units');
  const [usageCheckout, setUsageCheckout] = useState('0');
  const [usageStayover, setUsageStayover] = useState('0');
  const [vendor, setVendor] = useState('');
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
        parLevel: parseInt(parLevel) || 100,
        unit: unit.trim() || 'units',
        usagePerCheckout: parseFloat(usageCheckout) || 0,
        usagePerStayover: parseFloat(usageStayover) || 0,
        reorderLeadDays: 3,
        vendorName: vendor.trim() || undefined,
      });
      onAdded();
      onClose();
      // Reset
      setName(''); setStock('0'); setParLevel('100'); setUnit('units');
      setUsageCheckout('0'); setUsageStayover('0'); setVendor('');
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
    <Modal isOpen={isOpen} onClose={onClose} title={t('addItem', lang)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('name', lang)} *
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bath Towels" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('type', lang)}
          </label>
          <select value={category} onChange={e => setCategory(e.target.value as InventoryCategory)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="housekeeping">{t('housekeepingCategory', lang)}</option>
            <option value="maintenance">{t('maintenanceCategory', lang)}</option>
            <option value="breakfast">{t('breakfastFbCategory', lang)}</option>
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('currentStock', lang)}
            </label>
            <input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('parLevel', lang)}
            </label>
            <input type="number" min="0" value={parLevel} onChange={e => setParLevel(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('unitLabel', lang)}
            </label>
            <input value={unit} onChange={e => setUnit(e.target.value)} placeholder="units" style={inputStyle} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('usagePerCheckout', lang)}
            </label>
            <input type="number" step="0.1" min="0" value={usageCheckout} onChange={e => setUsageCheckout(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('usagePerStayover', lang)}
            </label>
            <input type="number" step="0.1" min="0" value={usageStayover} onChange={e => setUsageStayover(e.target.value)} style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('vendor', lang)} ({t('optional', lang)})
          </label>
          <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder="e.g. HD Supply" style={inputStyle} />
        </div>
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || saving}
          className="btn btn-primary"
          style={{ marginTop: '4px', opacity: !name.trim() || saving ? 0.5 : 1 }}
        >
          {saving ? t('saving', lang) : t('addItem', lang)}
        </button>
      </div>
    </Modal>
  );
}

// ─── Edit Item Modal ─────────────────────────────────────────────────────────

function EditItemModal({ isOpen, onClose, item, uid, pid, lang, onSaved }: {
  isOpen: boolean;
  onClose: () => void;
  item: InventoryItem;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [stock, setStock] = useState(String(item.currentStock));
  const [parLevel, setParLevel] = useState(String(item.parLevel));
  const [unit, setUnit] = useState(item.unit);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateInventoryItem(uid, pid, item.id, {
        name: name.trim() || item.name,
        currentStock: parseInt(stock) || 0,
        parLevel: parseInt(parLevel) || 0,
        unit: unit.trim() || item.unit,
      });
      onSaved();
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
    <Modal isOpen={isOpen} onClose={onClose} title={t('edit', lang)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
            {t('name', lang)}
          </label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('currentStock', lang)}
            </label>
            <input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('parLevel', lang)}
            </label>
            <input type="number" min="0" value={parLevel} onChange={e => setParLevel(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
              {t('unitLabel', lang)}
            </label>
            <input value={unit} onChange={e => setUnit(e.target.value)} style={inputStyle} />
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary"
          style={{ marginTop: '4px', opacity: saving ? 0.5 : 1 }}
        >
          {saving ? t('saving', lang) : t('save', lang)}
        </button>
      </div>
    </Modal>
  );
}
