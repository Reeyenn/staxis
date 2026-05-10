'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToInventory, addInventoryItem, updateInventoryItem, deleteInventoryItem,
  addInventoryCountBatch, addInventoryOrder, listInventoryCounts, listInventoryOrders,
  addInventoryDiscard, sumDiscardsSince,
  addInventoryReconciliation, lastReconciliationByItem,
  listInventoryBudgets, upsertInventoryBudget, monthToDateSpendByCategory,
} from '@/lib/db';
import type { InventoryDiscardReason, InventoryReconciliation } from '@/types';
import { fetchOccupancyBundle, computeOccupancyForItem, calculateEstimatedStock, type OccupancyBundle } from '@/lib/inventory-estimate';
import {
  fetchDailyAverages, predictReorders, predictionByItem, computeBudgetStatuses,
  type DailyAverages, type PredictionResult,
} from '@/lib/inventory-predictions';
import { supabase } from '@/lib/supabase';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { InventoryItem, InventoryCategory, InventoryCount, InventoryOrder } from '@/types';
import {
  Plus, Package, ClipboardCheck, AlertTriangle, Check, Info, Settings,
  TrendingDown, DollarSign, Truck, Clock, ChevronDown, ChevronRight,
  ShoppingCart, FileText, Copy, Camera, Upload, ScanLine,
  X as XIcon,
} from 'lucide-react';
import Link from 'next/link';

// ─── Constants ───────────────────────────────────────────────────────────────

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

function stockStatus(current: number, target: number, reorderAt?: number): 'good' | 'low' | 'out' {
  if (current <= 0) return 'out';
  if (typeof reorderAt === 'number' && reorderAt > 0) {
    if (current <= reorderAt * 0.5) return 'out';
    if (current <= reorderAt) return 'low';
    return 'good';
  }
  if (current < target * 0.3) return 'out';
  if (current < target * 0.7) return 'low';
  return 'good';
}

import { formatCurrency as formatCurrencyBase } from '@/lib/utils';
const formatCurrency = (n: number | null | undefined): string => formatCurrencyBase(n, true);

const STATUS_COLORS = { good: '#006565', low: '#364262', out: '#ba1a1a' };

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading, properties } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [occupancyBundle, setOccupancyBundle] = useState<OccupancyBundle | null>(null);
  const [dailyAverages, setDailyAverages] = useState<DailyAverages | null>(null);
  const [counting, setCounting] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBulkRates, setShowBulkRates] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showReorderList, setShowReorderList] = useState(false);
  const [showScanInvoice, setShowScanInvoice] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [discardItem, setDiscardItem] = useState<InventoryItem | null>(null);
  const [reconcileItem, setReconcileItem] = useState<InventoryItem | null>(null);
  const [showBudgetSettings, setShowBudgetSettings] = useState(false);

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

  // Subscribe to inventory items + run silent migration
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

  // Fetch occupancy events once. Window starts at the earliest item-anchor
  // (lastCountedAt, falling back to updatedAt for pre-migration rows). We then
  // partition events per-item locally so each item gets its own window.
  useEffect(() => {
    if (!activePropertyId || items.length === 0) return;
    const anchors = items
      .map(i => {
        const ts = (i.lastCountedAt ?? i.updatedAt)?.getTime();
        return typeof ts === 'number' && ts > 0 ? ts : null;
      })
      .filter((t): t is number => t !== null);
    if (anchors.length === 0) return;
    const since = new Date(Math.min(...anchors));
    fetchOccupancyBundle(activePropertyId, since)
      .then(setOccupancyBundle)
      .catch(err => console.error('[inventory] occupancy fetch failed:', err));
  }, [activePropertyId, items]);

  // Fetch daily averages for prediction engine — last 14 days, independent of
  // when items were counted. Used by the Concierge Insight, Smart Reorder
  // List, and Ownership Report. Fire-and-forget; UI degrades to "unknown"
  // urgency until the request lands.
  useEffect(() => {
    if (!activePropertyId) return;
    fetchDailyAverages(activePropertyId, 14)
      .then(setDailyAverages)
      .catch(err => console.error('[inventory] daily averages fetch failed:', err));
  }, [activePropertyId]);

  // Per-item estimates — each item's window starts at its own last_counted_at.
  const estimates = useMemo(() => {
    const map = new Map<string, ReturnType<typeof calculateEstimatedStock>>();
    if (!occupancyBundle) return map;
    items.forEach(item => {
      const itemOccupancy = computeOccupancyForItem(occupancyBundle, item);
      map.set(item.id, calculateEstimatedStock(item, itemOccupancy));
    });
    return map;
  }, [items, occupancyBundle]);

  // Effective stock used for status decisions (estimated when available, else raw)
  const effectiveStock = useCallback((item: InventoryItem): number => {
    const est = estimates.get(item.id);
    return est?.hasEstimate ? est.estimated : item.currentStock;
  }, [estimates]);

  // Predictions — one per item, keyed by id. Pure derivation from the items
  // array + daily averages + per-item effective stock.
  const predictions = useMemo<PredictionResult[]>(() => {
    if (!dailyAverages) return [];
    const stockMap = new Map<string, number>();
    items.forEach(i => stockMap.set(i.id, effectiveStock(i)));
    return predictReorders(items, dailyAverages, stockMap);
  }, [items, dailyAverages, effectiveStock]);

  const predictionMap = useMemo(() => predictionByItem(predictions), [predictions]);

  // ─── Hero stats ─────────────────────────────────────────────────────────
  const stockHealthPct = useMemo(() => {
    if (items.length === 0) return 100;
    const goodItems = items.filter(i => stockStatus(effectiveStock(i), i.parLevel, i.reorderAt) === 'good').length;
    return Math.round((goodItems / items.length) * 100);
  }, [items, effectiveStock]);

  const totalInventoryValue = useMemo(() => {
    return items.reduce((sum, i) => {
      if (i.unitCost == null) return sum;
      return sum + Number(i.unitCost) * Number(i.currentStock);
    }, 0);
  }, [items]);

  const itemsWithCost = useMemo(() => items.filter(i => i.unitCost != null).length, [items]);

  const lastCounted = useMemo(() => {
    // Prefer last_counted_at — only bumps when current_stock changes — so the
    // hero's "Last counted" reflects an actual count, not a metadata edit.
    const timestamps = items
      .map(i => {
        const ts = (i.lastCountedAt ?? i.updatedAt)?.getTime();
        return typeof ts === 'number' ? ts : 0;
      })
      .filter(t => t > 0);
    if (timestamps.length === 0) return null;
    return new Date(Math.max(...timestamps));
  }, [items]);

  // Concierge Insight — predictive when daily averages are available, falls
  // back to the status-based summary when there's not enough data yet.
  const aiInsight = useMemo(() => {
    // Helper: find the item by id and look up its name.
    const itemNameById = (id: string) => items.find(i => i.id === id)?.name ?? '';

    // ── Predictive path: requires real averages with ≥7 days of data ─────
    if (dailyAverages && dailyAverages.daysOfData >= 7 && predictions.length > 0) {
      const nowItems = predictions
        .filter(p => p.urgency === 'now')
        .sort((a, b) => (a.daysUntilOut ?? 0) - (b.daysUntilOut ?? 0));
      const soonItems = predictions
        .filter(p => p.urgency === 'soon')
        .sort((a, b) => (a.daysUntilOut ?? 0) - (b.daysUntilOut ?? 0));
      const okItems = predictions
        .filter(p => p.urgency === 'ok')
        .sort((a, b) => (a.daysUntilOut ?? 0) - (b.daysUntilOut ?? 0));

      if (nowItems.length > 0) {
        const worst = nowItems[0];
        const days = Math.max(0, Math.round(worst.daysUntilOut ?? 0));
        const name = itemNameById(worst.itemId);
        return lang === 'es'
          ? `${name} debe reordenarse hoy. Al ritmo actual, se acabará en ${days} día${days === 1 ? '' : 's'}.`
          : `${name} needs to be reordered today. At current usage, you'll be out in ${days} day${days === 1 ? '' : 's'}.`;
      }
      if (soonItems.length > 0) {
        const worst = soonItems[0];
        const days = Math.max(0, Math.round(worst.daysUntilOut ?? 0));
        const name = itemNameById(worst.itemId);
        return lang === 'es'
          ? `${soonItems.length} artículo${soonItems.length === 1 ? '' : 's'} necesita${soonItems.length === 1 ? '' : 'n'} reorden esta semana. ${name} se acaba en ${days} día${days === 1 ? '' : 's'}.`
          : `${soonItems.length} item${soonItems.length === 1 ? '' : 's'} need${soonItems.length === 1 ? 's' : ''} reordering this week. ${name} runs out in ${days} day${days === 1 ? '' : 's'}.`;
      }
      if (okItems.length > 0) {
        const next = okItems[0];
        const days = Math.max(0, Math.round(next.daysUntilOut ?? 0));
        const name = itemNameById(next.itemId);
        return lang === 'es'
          ? `Todos los niveles saludables. Próximo reorden en ${days} día${days === 1 ? '' : 's'} (${name}).`
          : `All inventory levels healthy. Next reorder needed in ${days} day${days === 1 ? '' : 's'} (${name}).`;
      }
      // Fall through to status-based when nothing has usage rates configured.
    }

    // ── Fallback: status-based (no usage rates or <7 days of data) ───────
    const criticalItems = items.filter(i => stockStatus(effectiveStock(i), i.parLevel, i.reorderAt) === 'out');
    const lowItemsList = items.filter(i => stockStatus(effectiveStock(i), i.parLevel, i.reorderAt) === 'low');
    if (criticalItems.length > 0) {
      const worst = criticalItems[0];
      const stk = effectiveStock(worst);
      const pct = worst.parLevel > 0 ? Math.round((stk / worst.parLevel) * 100) : 0;
      return lang === 'es'
        ? `${worst.name} está ${pct}% por debajo del umbral. Se recomienda reorden inmediato.`
        : `${worst.name} ${stk === 0 ? 'is out of stock' : `is ${100 - pct}% below threshold`}. AI recommends immediate reorder.`;
    }
    if (lowItemsList.length > 0) {
      return lang === 'es'
        ? `${lowItemsList.length} artículo(s) con stock bajo. Considere programar reorden esta semana.`
        : `${lowItemsList.length} item${lowItemsList.length > 1 ? 's' : ''} running low. Consider scheduling reorders this week.`;
    }
    return lang === 'es'
      ? 'Todos los niveles de inventario están saludables. No se requieren acciones inmediatas.'
      : 'All inventory levels are healthy. No immediate actions required.';
  }, [items, lang, effectiveStock, dailyAverages, predictions]);

  const hkItems = useMemo(() => items.filter(i => i.category === 'housekeeping').sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const maintItems = useMemo(() => items.filter(i => i.category === 'maintenance').sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const fbItems = useMemo(() => items.filter(i => i.category === 'breakfast').sort((a, b) => a.name.localeCompare(b.name)), [items]);

  const catAlerts = useMemo(() => ({
    housekeeping: hkItems.filter(i => stockStatus(effectiveStock(i), i.parLevel, i.reorderAt) !== 'good').length,
    maintenance: maintItems.filter(i => stockStatus(effectiveStock(i), i.parLevel, i.reorderAt) !== 'good').length,
    breakfast: fbItems.filter(i => stockStatus(effectiveStock(i), i.parLevel, i.reorderAt) !== 'good').length,
  }), [hkItems, maintItems, fbItems, effectiveStock]);

  // ─── Count Mode save handler ───────────────────────────────────────────
  // Writes the per-item audit log and dismisses the modal with a toast.
  // Reeyen pulled the reconciliation popup + "did you receive an order?"
  // chain on 2026-05-10 — they were too many steps for a non-technical GM
  // who already saw the new numbers in the input boxes. The audit log
  // (inventory_counts) still writes silently so nothing is lost
  // historically; the user just isn't shown a recap they don't need.
  const handleCountDone = useCallback((updatedCounts: Record<string, number>) => {
    setCounting(false);

    // Per-item audit rows. We compute estimate + variance here purely so
    // the inventory_counts table has the same shape it did before — the
    // analytics chart on /inventory/reports reads variance for the
    // shrinkage trend, so we can't drop those columns.
    const countLogRows: Array<{
      propertyId: string;
      itemId: string;
      itemName: string;
      countedStock: number;
      estimatedStock?: number;
      variance?: number;
      varianceValue?: number;
      unitCost?: number;
      countedAt: Date;
      countedBy?: string;
    }> = [];
    let changedItems = 0;

    items.forEach(item => {
      const counted = updatedCounts[item.id];
      if (counted == null) return;
      if (counted !== item.currentStock) changedItems++;
      const est = estimates.get(item.id);
      const hasEst = est?.hasEstimate ?? false;
      const estimated = hasEst ? est!.estimated : undefined;
      const variance = estimated != null ? counted - estimated : undefined;
      const varianceValue = variance != null && item.unitCost != null ? variance * item.unitCost : undefined;

      countLogRows.push({
        propertyId: activePropertyId ?? '',
        itemId: item.id,
        itemName: item.name,
        countedStock: counted,
        estimatedStock: estimated,
        variance,
        varianceValue,
        unitCost: item.unitCost,
        countedAt: new Date(),
        countedBy: user?.displayName ?? user?.username ?? undefined,
      });
    });

    // Best-effort audit-log write. Non-blocking — failure here doesn't
    // surface to the user; the count itself is already persisted via the
    // updateInventoryItem calls in CountMode's handleSave.
    if (user && activePropertyId && countLogRows.length > 0) {
      addInventoryCountBatch(user.uid, activePropertyId, countLogRows)
        .catch(err => console.error('[inventory] count log failed:', err));
    }

    // SMS alerts for critical inventory are disabled (2026-05-10). The GM
    // sees the red status badge in the UI on next open; SMS was duplicate
    // noise. /api/inventory/check-alerts stays in the codebase as a dead
    // call site so a future per-property opt-in can re-enable it.

    // Single, simple confirmation. No reconciliation popup, no order prompt.
    if (changedItems > 0) {
      showToast(
        lang === 'es'
          ? `${changedItems} artículo${changedItems === 1 ? '' : 's'} actualizado${changedItems === 1 ? '' : 's'} ✓`
          : `${changedItems} item${changedItems === 1 ? '' : 's'} updated ✓`,
      );
    } else {
      showToast(lang === 'es' ? 'Sin cambios' : 'No changes');
    }
  }, [items, estimates, user, activePropertyId, lang, showToast]);

  // Loading guard
  if (authLoading || propLoading || !user || !activePropertyId) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-4 rounded-full mb-3 mx-auto" style={{ borderColor: '#c5c5d4', borderTopColor: '#364262' }} />
            <div className="text-sm font-medium" style={{ color: '#757684', fontFamily: "'Inter', sans-serif" }}>
              {lang === 'es' ? 'Cargando inventario...' : 'Loading inventory...'}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  // ─── MAIN VIEW ─────────────────────────────────────────────────────────
  return (
    <AppLayout>
      <style>{`
        .inv-card:hover { transform: translateY(-2px); }
        .inv-cat-grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
        @media (min-width: 768px) { .inv-cat-grid { grid-template-columns: repeat(3, 1fr); } }
      `}</style>

      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '16px 24px 160px' }}>

        {/* ── Compact Hero ── */}
        <header className="animate-in stagger-1" style={{ marginBottom: '20px' }}>
          <div style={{
            background: '#f5f3ee', padding: '18px 24px', borderRadius: '14px',
            position: 'relative', overflow: 'hidden',
            border: '1px solid rgba(78,90,122,0.06)',
            display: 'flex', alignItems: 'center',
            flexWrap: 'wrap', gap: '24px',
          }}>
            {/* Left: key stats */}
            <div style={{ display: 'flex', flexDirection: 'row', gap: '24px', flexShrink: 0, alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {lang === 'es' ? 'Salud' : 'Stock'}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '26px', fontWeight: 700, color: stockHealthPct >= 70 ? '#006565' : stockHealthPct >= 40 ? '#364262' : '#ba1a1a', lineHeight: 1.1 }}>
                  {stockHealthPct}%
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {lang === 'es' ? 'Valor' : 'Value'}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '26px', fontWeight: 700, color: '#364262', lineHeight: 1.1 }}>
                  {itemsWithCost > 0 ? formatCurrency(totalInventoryValue) : '—'}
                </span>
                {itemsWithCost > 0 && itemsWithCost < items.length && (
                  <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', color: '#757684' }}>
                    {itemsWithCost}/{items.length} {lang === 'es' ? 'con costo' : 'priced'}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {lang === 'es' ? 'Último conteo' : 'Last counted'}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: 700, color: '#454652', lineHeight: 1.1 }}>
                  {lastCounted ? timeAgo(lastCounted) : (lang === 'es' ? 'Nunca' : 'Never')}
                </span>
              </div>
            </div>

            {/* Center: Concierge Insight */}
            <div style={{ flex: 1, minWidth: '200px', textAlign: 'center', paddingLeft: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', color: '#006565' }}>✦</span>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#006565' }}>
                  {lang === 'es' ? 'Insight del Concierge' : 'Concierge Insight'}
                </span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', lineHeight: 1.5, color: '#1b1c19', margin: 0 }}>
                {aiInsight}
              </p>
            </div>

            {/* Right: action buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => setCounting(true)}
                style={{
                  background: '#364262', color: '#fff', border: 'none',
                  padding: '10px 20px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                  transition: 'transform 150ms',
                }}
              >
                <ClipboardCheck size={16} />
                {lang === 'es' ? 'Iniciar Conteo' : 'Start Count'}
              </button>
              <button
                onClick={() => setShowBulkRates(true)}
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                <Settings size={13} />
                {lang === 'es' ? 'Tasas de Uso' : 'Usage Rates'}
              </button>
              <button
                onClick={() => setShowHistory(true)}
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                <Clock size={13} />
                {lang === 'es' ? 'Historial' : 'History'}
              </button>
              <button
                onClick={() => setShowReorderList(true)}
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                <ShoppingCart size={13} />
                {lang === 'es' ? 'Lista de Pedidos' : 'Reorder List'}
              </button>
              <Link
                href="/inventory/reports"
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                  textDecoration: 'none',
                }}
              >
                <FileText size={13} />
                {lang === 'es' ? 'Reportes' : 'Reports'}
              </Link>
              <button
                onClick={() => setShowBudgetSettings(true)}
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                <Settings size={13} />
                {lang === 'es' ? 'Presupuestos' : 'Budgets'}
              </button>
              <button
                onClick={() => setShowScanInvoice(true)}
                style={{
                  background: '#006565', color: '#fff', border: 'none',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                <ScanLine size={13} />
                {lang === 'es' ? 'Escanear Factura' : 'Scan Invoice'}
              </button>
            </div>
          </div>
        </header>

        {/* ── Bento Grid ── */}
        <div className="inv-cat-grid animate-in stagger-2">
          {([
            { key: 'housekeeping' as InventoryCategory, label: lang === 'es' ? 'Limpieza' : 'Housekeeping', items: hkItems, alerts: catAlerts.housekeeping },
            { key: 'maintenance' as InventoryCategory, label: lang === 'es' ? 'Mantenimiento' : 'Maintenance', items: maintItems, alerts: catAlerts.maintenance },
            { key: 'breakfast' as InventoryCategory, label: lang === 'es' ? 'Alimentos y Bebidas' : 'Food & Beverage', items: fbItems, alerts: catAlerts.breakfast },
          ]).map(cat => (
            <section key={cat.key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600, color: '#1b1c19' }}>
                  {cat.label}
                </h2>
                {cat.alerts > 0 ? (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 500,
                    background: '#f0eee9', color: '#454652', padding: '3px 8px', borderRadius: '6px',
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>
                    {cat.alerts} {lang === 'es' ? 'alerta' : 'active alert'}{cat.alerts > 1 ? 's' : ''}
                  </span>
                ) : (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 500,
                    background: '#006565', color: '#fff', padding: '3px 8px', borderRadius: '6px',
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>
                    {lang === 'es' ? 'Saludable' : 'Healthy'}
                  </span>
                )}
              </div>

              {cat.items.length === 0 ? (
                <div style={{
                  padding: '20px 12px', textAlign: 'center', borderRadius: '14px',
                  background: 'rgba(0,0,0,0.02)', border: '1px dashed #c5c5d4',
                }}>
                  <Package size={18} color="#757684" style={{ margin: '0 auto 6px' }} />
                  <p style={{ fontSize: '12px', color: '#757684', fontFamily: "'Inter', sans-serif" }}>
                    {lang === 'es' ? 'Sin artículos' : 'No items'}
                  </p>
                </div>
              ) : (
                cat.items.map(item => {
                  const est = estimates.get(item.id);
                  const stk = est?.hasEstimate ? est.estimated : item.currentStock;
                  const status = stockStatus(stk, item.parLevel, item.reorderAt);
                  const pct = item.parLevel > 0 ? Math.min(100, Math.round((stk / item.parLevel) * 100)) : 0;
                  const isCritical = status === 'out';
                  const barColor = status === 'good' ? '#364262' : status === 'low' ? '#364262' : '#ba1a1a';
                  const barBg = status === 'out' ? '#ffdad6' : '#f0eee9';
                  const itemValue = item.unitCost != null ? item.unitCost * item.currentStock : null;

                  return (
                    <div key={item.id} className="inv-card" onClick={() => setEditItem(item)} style={{
                      background: '#fff', borderRadius: '14px', padding: '12px 14px',
                      transition: 'all 300ms',
                      minHeight: '104px', boxSizing: 'border-box',
                      display: 'flex', flexDirection: 'column',
                      cursor: 'pointer',
                    }}>
                      {/* Name + timestamp */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', gap: '8px' }}>
                        <span style={{
                          fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 500, color: '#454652',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          flex: 1, minWidth: 0,
                        }}>
                          {item.name}
                        </span>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
                          color: isCritical ? '#ba1a1a' : '#757684',
                          fontWeight: isCritical ? 700 : 500,
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                          flexShrink: 0,
                        }}>
                          {timeAgo(item.lastCountedAt ?? item.updatedAt)}
                        </span>
                      </div>

                      {/* Stock numbers */}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', flexWrap: 'wrap' }}>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', fontWeight: 500,
                          color: isCritical ? '#ba1a1a' : '#364262', letterSpacing: '-0.02em', lineHeight: 1,
                          textDecoration: est?.hasEstimate ? 'underline dotted #c5c5d4 2px' : 'none',
                          textUnderlineOffset: '4px',
                        }}>
                          {Math.round(stk).toLocaleString()}
                        </span>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '13px',
                          color: '#c5c5d4',
                        }}>
                          / {item.parLevel.toLocaleString()}
                        </span>
                        {est?.hasEstimate && (
                          <span title={lang === 'es' ? 'Estimado por uso' : 'Estimated from usage'} style={{
                            fontFamily: "'Inter', sans-serif", fontSize: '9px', fontWeight: 700,
                            color: '#006565', letterSpacing: '0.06em',
                            background: 'rgba(0,101,101,0.08)', padding: '1px 5px', borderRadius: '4px',
                            textTransform: 'uppercase',
                          }}>
                            {lang === 'es' ? 'EST.' : 'EST.'}
                          </span>
                        )}
                        {itemValue != null && (
                          <span style={{
                            fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
                            color: '#757684', marginLeft: 'auto',
                          }}>
                            {formatCurrency(itemValue)}
                          </span>
                        )}
                      </div>

                      {/* Progress bar */}
                      <div style={{
                        marginTop: '8px', width: '100%', height: '3px',
                        background: barBg, borderRadius: '9999px', overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%', width: `${pct}%`,
                          background: barColor, borderRadius: '9999px',
                          transition: 'width 300ms',
                        }} />
                      </div>

                      {isCritical && (
                        <div style={{
                          marginTop: '6px', display: 'flex', alignItems: 'center', gap: '5px',
                          color: '#ba1a1a', fontSize: '11px', fontWeight: 500,
                          fontFamily: "'Inter', sans-serif",
                        }}>
                          <AlertTriangle size={12} />
                          {lang === 'es' ? 'Crítico: Reabastecimiento Requerido' : 'Critical: Replenishment Required'}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* Add item */}
              <button
                onClick={() => setShowAddModal(true)}
                style={{
                  background: 'transparent', borderRadius: '14px',
                  padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px',
                  border: '2px dashed #c5c5d4', cursor: 'pointer',
                  transition: 'all 200ms',
                }}
              >
                <div style={{
                  width: '28px', height: '28px', borderRadius: '8px', flexShrink: 0,
                  background: '#364262', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Plus size={14} color="#fff" />
                </div>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#364262' }}>
                  {lang === 'es' ? 'Agregar Artículo' : 'Add Item'}
                </span>
              </button>
            </section>
          ))}
        </div>
      </div>

      {/* Add */}
      <AddItemModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        uid={user.uid}
        pid={activePropertyId}
        lang={lang}
        onAdded={() => showToast(lang === 'es' ? 'Artículo agregado ✓' : 'Item added ✓')}
      />

      {/* Edit */}
      {editItem && (
        <EditItemModal
          item={editItem}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setEditItem(null)}
          onSaved={() => { setEditItem(null); showToast(lang === 'es' ? 'Artículo actualizado ✓' : 'Item updated ✓'); }}
          onDeleted={() => { setEditItem(null); showToast(lang === 'es' ? 'Artículo eliminado ✓' : 'Item deleted ✓'); }}
          onDiscard={() => { const it = editItem; setEditItem(null); setDiscardItem(it); }}
          onReconcile={() => { const it = editItem; setEditItem(null); setReconcileItem(it); }}
        />
      )}

      {/* Discard */}
      {discardItem && (
        <DiscardModal
          item={discardItem}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setDiscardItem(null)}
          onSaved={(qty) => {
            setDiscardItem(null);
            showToast(lang === 'es' ? `${qty} descartado(s) registrado(s) ✓` : `${qty} discard(s) logged ✓`);
          }}
        />
      )}

      {/* Reconcile */}
      {reconcileItem && (
        <ReconcileModal
          item={reconcileItem}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          estimatedStockNow={effectiveStock(reconcileItem)}
          onClose={() => setReconcileItem(null)}
          onSaved={() => {
            setReconcileItem(null);
            showToast(lang === 'es' ? 'Reconciliación guardada ✓' : 'Reconciliation saved ✓');
          }}
        />
      )}

      {/* Budget Settings */}
      {showBudgetSettings && (
        <BudgetSettingsModal
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setShowBudgetSettings(false)}
          onSaved={() => { setShowBudgetSettings(false); showToast(lang === 'es' ? 'Presupuestos actualizados ✓' : 'Budgets updated ✓'); }}
        />
      )}

      {/* Bulk usage rates */}
      {showBulkRates && (
        <BulkUsageRatesModal
          items={items}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setShowBulkRates(false)}
          onSaved={(n) => { setShowBulkRates(false); showToast(lang === 'es' ? `${n} actualizado` : `${n} updated`); }}
        />
      )}

      {/* Count history */}
      {showHistory && (
        <CountHistoryModal
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Smart reorder list */}
      {showReorderList && (
        <ReorderListModal
          items={items}
          predictions={predictionMap}
          effectiveStockOf={effectiveStock}
          dailyAverages={dailyAverages}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setShowReorderList(false)}
          onLogged={(itemName) => {
            setShowReorderList(false);
            showToast(lang === 'es' ? `Pedido registrado: ${itemName}` : `Order logged: ${itemName}`);
          }}
          showToast={showToast}
          onOpenBudgets={() => { setShowReorderList(false); setShowBudgetSettings(true); }}
        />
      )}

      {/* Invoice OCR */}
      {showScanInvoice && (
        <ScanInvoiceModal
          items={items}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setShowScanInvoice(false)}
          showToast={showToast}
        />
      )}

      {/* Count Mode */}
      {counting && (
        <CountMode
          items={items}
          estimates={estimates}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onDone={handleCountDone}
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

// ─── Photo Count review modal types ────────────────────────────────────────

// One row in the Photo Count review modal — what the AI saw vs. what's
// already in the count input the user might have typed or pre-filled.
interface PhotoDetection {
  itemId: string;
  itemName: string;
  unit: string;
  aiCount: number;
  confidence: 'high' | 'medium' | 'low';
  /** Whatever was in the count input when the photo finished processing. */
  currentInput: number;
}

// One decision from the review modal — accept or reject, and (when
// accepting) whether to add the AI count to the current input or replace it.
interface PhotoDecision {
  itemId: string;
  action: 'accept' | 'reject';
  mode: 'add' | 'replace';
  aiCount: number;
  confidence: 'high' | 'medium' | 'low';
}

// ─── COUNT MODE ──────────────────────────────────────────────────────────────

function CountMode({
  items, estimates, uid, pid, lang, onDone, onCancel,
}: {
  items: InventoryItem[];
  estimates: Map<string, ReturnType<typeof calculateEstimatedStock>>;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onDone: (updatedCounts: Record<string, number>) => void;
  onCancel: () => void;
}) {
  const sorted = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items]);

  // Pre-fill the count input with the AI's best guess of current stock —
  // i.e. the estimated stock when usage rates are configured, otherwise the
  // last manually-typed value (currentStock). The user sees ONE number per
  // item and adjusts up/down based on what they physically count. We
  // deliberately don't show the estimate as a separate column anymore;
  // showing two numbers per row was confusing the GM ICP.
  const initialValueFor = useCallback((item: InventoryItem): number => {
    const est = estimates.get(item.id);
    return est?.hasEstimate ? Math.round(est.estimated) : item.currentStock;
  }, [estimates]);

  const [counts, setCounts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    sorted.forEach(item => { init[item.id] = String(initialValueFor(item)); });
    return init;
  });
  // Snapshot of what the input was pre-filled with — used to detect "untouched"
  // rows in the photo-count merge logic. Stays stable across the modal lifetime.
  const initialValuesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const snap: Record<string, string> = {};
    sorted.forEach(item => { snap[item.id] = String(initialValueFor(item)); });
    initialValuesRef.current = snap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [saving, setSaving] = useState(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Photo Count state — tracks which inputs were filled by AI and at what
  // confidence level so we can render the colored "AI" badge per row.
  // Multiple photos accumulate: later photos only fill items the AI didn't
  // touch yet (we never overwrite a previous AI value with a later AI value).
  const [aiFilled, setAiFilled] = useState<Record<string, 'high' | 'medium' | 'low'>>({});
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // After the API responds, we open a review modal with the AI's detections
  // so the user can confirm / reject each one and pick Add vs. Replace mode.
  // null = no review pending (default).
  const [photoReview, setPhotoReview] = useState<PhotoDetection[] | null>(null);

  const handlePhotoPicked = useCallback(async (img: PickedImage) => {
    setShowPhotoPicker(false);
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const res = await fetchWithAuth('/api/inventory/photo-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid, imageBase64: img.base64, mediaType: img.mediaType,
          itemNames: items.map(i => i.name),
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.detail || json.error || 'photo_count_failed');

      // Best-effort upload to Storage for audit. Non-fatal.
      try {
        const ext = img.mediaType.split('/')[1] || 'jpg';
        await supabase.storage.from('counts').upload(`${pid}/${Date.now()}.${ext}`, img.file, {
          contentType: img.mediaType,
          upsert: false,
        });
      } catch { /* non-fatal */ }

      const apiCounts: Array<{ item_name: string; estimated_count: number; confidence: 'high' | 'medium' | 'low' }> = json.counts ?? [];

      // Map detections to known items + capture the input value at the time
      // the photo was processed (so the review modal can show "Currently: N"
      // even if the user is mid-edit on another row).
      const detections: PhotoDetection[] = [];
      for (const c of apiCounts) {
        const item = items.find(i => i.name === c.item_name);
        if (!item) continue;
        const currentInput = parseInt(counts[item.id] ?? '0') || 0;
        detections.push({
          itemId: item.id,
          itemName: item.name,
          unit: item.unit,
          aiCount: c.estimated_count,
          confidence: c.confidence,
          currentInput,
        });
      }

      // Sort by confidence (high first) so the user reviews the most-trusted
      // detections at the top of the list.
      const order = { high: 0, medium: 1, low: 2 } as const;
      detections.sort((a, b) => order[a.confidence] - order[b.confidence]);

      setPhotoReview(detections);
    } catch (e) {
      setPhotoError(
        lang === 'es'
          ? 'No se pudo procesar la foto. Continúe con conteo manual.'
          : 'Photo processing failed. Continue with manual count.',
      );
    } finally {
      setPhotoBusy(false);
    }
  }, [pid, items, counts, lang]);

  // Apply user's accepted decisions from the review modal into the count
  // inputs. `mode` is per-detection so the user can mix Add and Replace.
  const handlePhotoApply = useCallback((decisions: PhotoDecision[]) => {
    const fresh: Record<string, 'high' | 'medium' | 'low'> = {};
    setCounts(prev => {
      const next = { ...prev };
      for (const d of decisions) {
        if (d.action !== 'accept') continue;
        const currentInput = parseInt(prev[d.itemId] ?? '0') || 0;
        const newValue = d.mode === 'add' ? currentInput + d.aiCount : d.aiCount;
        next[d.itemId] = String(newValue);
        fresh[d.itemId] = d.confidence;
      }
      return next;
    });
    setAiFilled(prev => ({ ...prev, ...fresh }));
    setPhotoReview(null);
  }, []);

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
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '24px', width: '100%', maxWidth: '560px',
        maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
              {lang === 'es' ? 'Conteo de Inventario' : 'Inventory Count'}
            </h2>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', margin: '4px 0 0' }}>
              {lang === 'es' ? 'Cuente cada artículo, ingrese los números abajo.' : 'Count each item, enter the numbers below.'}
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
            {lang === 'es' ? 'Cancelar' : 'Cancel'}
          </button>
        </div>

        {/* Photo Count helper bar */}
        <div style={{ padding: '12px 24px', background: 'rgba(0,101,101,0.04)', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <button
              onClick={() => { setShowPhotoPicker(true); setPhotoError(null); }}
              disabled={photoBusy}
              style={{
                padding: '8px 14px', borderRadius: '9999px', border: 'none',
                background: '#006565', color: '#fff', cursor: photoBusy ? 'wait' : 'pointer',
                fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', gap: '6px', opacity: photoBusy ? 0.6 : 1,
              }}
            >
              <Camera size={13} />
              {photoBusy
                ? (lang === 'es' ? 'Contando...' : 'Counting...')
                : (lang === 'es' ? 'Contar con Foto' : 'Photo Count')}
            </button>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', color: '#757684', marginTop: '4px' }}>
              {lang === 'es'
                ? 'Funciona mejor para artículos en estantes. Las sábanas apiladas pueden ser inexactas.'
                : 'Works best for items on shelves. Stacked linens may be inaccurate.'}
            </div>
          </div>
          {Object.keys(aiFilled).length > 0 && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700,
              background: '#006565', color: '#fff', padding: '3px 8px', borderRadius: '6px',
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              {Object.keys(aiFilled).length} {lang === 'es' ? 'pre-llenado' : 'filled'}
            </span>
          )}
        </div>
        {photoError && (
          <div style={{ padding: '10px 24px', background: 'rgba(186,26,26,0.08)', color: '#ba1a1a', fontFamily: "'Inter', sans-serif", fontSize: '12px' }}>
            {photoError}
          </div>
        )}
        {showPhotoPicker && (
          <div style={{ borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
            <ImagePickerStage
              lang={lang}
              onPicked={handlePhotoPicked}
              onUnsupported={(mt) => {
                const isHeic = mt === 'image/heic' || mt === 'image/heif';
                setPhotoError(
                  lang === 'es'
                    ? isHeic
                      ? 'Las fotos HEIC del iPhone no son compatibles. Por favor, toma la foto en formato JPEG o usa una captura de pantalla.'
                      : `Tipo de archivo no admitido (${mt}).`
                    : isHeic
                      ? 'iPhone HEIC photos are not supported. Please take the photo in JPEG or use a screenshot.'
                      : `Unsupported file type (${mt}).`
                );
              }}
            />
            <button
              onClick={() => setShowPhotoPicker(false)}
              style={{
                width: '100%', padding: '10px', background: 'transparent', border: 'none',
                color: '#757684', cursor: 'pointer', fontFamily: "'Inter', sans-serif", fontSize: '12px',
              }}
            >
              {lang === 'es' ? 'Cancelar foto' : 'Cancel photo'}
            </button>
          </div>
        )}

        {photoReview && (
          <PhotoCountReviewModal
            detections={photoReview}
            lang={lang}
            onCancel={() => setPhotoReview(null)}
            onApply={handlePhotoApply}
          />
        )}

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 80px 50px',
            gap: '8px', padding: '10px 24px', background: '#f5f3ee',
            borderBottom: '1px solid rgba(197,197,212,0.2)',
            fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: '#757684',
            position: 'sticky', top: 0, zIndex: 1,
          }}>
            <span>{lang === 'es' ? 'Artículo' : 'Item'}</span>
            <span style={{ textAlign: 'center' }}>{lang === 'es' ? 'Conteo' : 'Count'}</span>
            <span style={{ textAlign: 'right' }}>{lang === 'es' ? 'Meta' : 'Target'}</span>
          </div>

          {sorted.map((item, idx) => {
            const val = parseInt(counts[item.id] ?? '0') || 0;
            const status = stockStatus(val, item.parLevel, item.reorderAt);
            const initial = initialValuesRef.current[item.id];
            const changed = initial != null && counts[item.id] !== initial;
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
                <div style={{ position: 'relative' }}>
                  <input
                    ref={el => { inputRefs.current[item.id] = el; }}
                    type="number"
                    min="0"
                    value={counts[item.id] ?? '0'}
                    onChange={e => {
                      setCounts(prev => ({ ...prev, [item.id]: e.target.value }));
                      // Manual edit clears the AI badge for this row.
                      setAiFilled(prev => {
                        if (!prev[item.id]) return prev;
                        const { [item.id]: _drop, ...rest } = prev;
                        return rest;
                      });
                    }}
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
                  {aiFilled[item.id] && (
                    <span
                      title={`${lang === 'es' ? 'Pre-llenado por IA' : 'AI-filled'} (${aiFilled[item.id]})`}
                      style={{
                        position: 'absolute', top: '-6px', right: '-4px',
                        background: '#1b1c19', color: '#fff',
                        fontFamily: "'Inter', sans-serif", fontSize: '8px', fontWeight: 700,
                        padding: '2px 5px', borderRadius: '6px',
                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                      }}
                    >
                      <span style={{
                        width: '5px', height: '5px', borderRadius: '50%',
                        background: aiFilled[item.id] === 'high' ? '#00a050'
                          : aiFilled[item.id] === 'medium' ? '#f0ad4e' : '#dc3545',
                      }} />
                      AI
                    </span>
                  )}
                </div>
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
            {saving
              ? (lang === 'es' ? 'Guardando...' : 'Saving...')
              : changedCount > 0
                ? (lang === 'es' ? `Guardar (${changedCount} cambios)` : `Save Count (${changedCount} changed)`)
                : (lang === 'es' ? 'Sin cambios' : 'No changes')}
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Count History Modal ────────────────────────────────────────────────────
//
// Read-only audit view over the inventory_counts table. Each Count Mode save
// writes one row per item; this view groups those rows by their shared
// counted_at timestamp and shows aggregate variance + per-item drill-down.
//
// Three summary stats up top:
//   • Total counts          — number of distinct count events
//   • Avg monthly shrinkage — sum of negative variance_value, divided by
//                              months covered by the data. Negative number,
//                              floor at -inf, displayed as -$X/mo.
//   • Worst item            — itemName with the most-negative cumulative
//                              variance_value across all events.
//
// Color coding mirrors the reconciliation modal (>25% red, >10% amber, else
// green; gray when no estimate available).

function CountHistoryModal({ uid, pid, lang, onClose }: {
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
}) {
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listInventoryCounts(uid, pid, 500)
      .then(rows => { if (alive) setCounts(rows); })
      .catch(err => console.error('[count history] fetch failed:', err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [uid, pid]);

  // Group by counted_at timestamp (a Count Mode batch insert shares one
  // transaction-time now() value across all rows, so identical timestamps
  // identify a single count event).
  const groups = useMemo(() => {
    const m = new Map<string, InventoryCount[]>();
    for (const c of counts) {
      const key = c.countedAt ? c.countedAt.toISOString() : 'unknown';
      const bucket = m.get(key) ?? [];
      bucket.push(c);
      m.set(key, bucket);
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => b.localeCompare(a));
  }, [counts]);

  // ─── Summary stats ──────────────────────────────────────────────────────

  const totalCountEvents = groups.length;

  // Average monthly shrinkage: sum of negative variance_value, divided by
  // months from oldest count to newest. Floors months at 1 so a single
  // recent-week dataset doesn't show wildly inflated "monthly" loss.
  const avgMonthlyShrinkage = useMemo(() => {
    if (counts.length === 0) return 0;
    const negativeSum = counts.reduce(
      (s, c) => s + (c.varianceValue != null && c.varianceValue < 0 ? c.varianceValue : 0),
      0,
    );
    if (negativeSum === 0) return 0;
    const oldest = counts[counts.length - 1].countedAt;
    const newest = counts[0].countedAt;
    if (!oldest || !newest) return 0;
    const days = Math.max(1, (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24));
    const months = Math.max(1, days / 30);
    return negativeSum / months; // negative number
  }, [counts]);

  // Worst item: cumulative variance_value across events, take the most
  // negative. Falls back to "—" when no items have unit_cost.
  const worstItem = useMemo(() => {
    const totals = new Map<string, number>();
    for (const c of counts) {
      if (c.varianceValue == null) continue;
      totals.set(c.itemName, (totals.get(c.itemName) ?? 0) + c.varianceValue);
    }
    let worstName: string | null = null;
    let worstValue = 0;
    for (const [name, total] of totals) {
      if (total < worstValue) {
        worstValue = total;
        worstName = name;
      }
    }
    return worstName ? { name: worstName, total: worstValue } : null;
  }, [counts]);

  // ─── Per-row color logic (matches ReconciliationModal) ──────────────────
  const colorFor = (r: InventoryCount): string => {
    if (r.variance == null || r.estimatedStock == null || r.estimatedStock === 0) return '#757684';
    const pct = Math.abs(r.variance) / Math.max(1, r.estimatedStock);
    if (pct > 0.25) return '#ba1a1a';
    if (pct > 0.10) return '#c98a14';
    return '#006565';
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '24px',
        width: '100%', maxWidth: '720px', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Clock size={18} color="#364262" />
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                  {lang === 'es' ? 'Historial de Conteos' : 'Count History'}
                </h2>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', margin: '4px 0 0 28px' }}>
                {lang === 'es'
                  ? 'Cada conteo guardado, agrupado por fecha. Toque para expandir.'
                  : 'Every saved count, grouped by date. Tap to expand.'}
              </p>
            </div>
            <button
              onClick={onClose}
              style={{
                background: '#eae8e3', border: 'none', cursor: 'pointer',
                padding: '8px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <span style={{ fontSize: '16px', color: '#454652', lineHeight: 1 }}>✕</span>
            </button>
          </div>
        </div>

        {/* Summary stats */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px',
          padding: '14px 24px', background: '#f5f3ee',
          borderBottom: '1px solid rgba(197,197,212,0.2)',
        }}>
          <SummaryStat
            label={lang === 'es' ? 'Conteos' : 'Total counts'}
            value={loading ? '…' : String(totalCountEvents)}
            tone="neutral"
          />
          <SummaryStat
            label={lang === 'es' ? 'Pérdida mensual' : 'Avg monthly loss'}
            value={loading
              ? '…'
              : avgMonthlyShrinkage === 0
                ? '—'
                : formatCurrency(avgMonthlyShrinkage)}
            tone={avgMonthlyShrinkage < 0 ? 'bad' : 'neutral'}
          />
          <SummaryStat
            label={lang === 'es' ? 'Peor artículo' : 'Worst item'}
            value={loading ? '…' : worstItem ? worstItem.name : '—'}
            sub={loading ? undefined : worstItem ? formatCurrency(worstItem.total) : undefined}
            tone={worstItem ? 'bad' : 'neutral'}
          />
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: '40px 24px', textAlign: 'center' }}>
              <div className="animate-spin" style={{
                width: '24px', height: '24px', margin: '0 auto 8px',
                border: '3px solid #c5c5d4', borderTopColor: '#364262', borderRadius: '50%',
              }} />
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
                {lang === 'es' ? 'Cargando historial...' : 'Loading history...'}
              </div>
            </div>
          ) : groups.length === 0 ? (
            <div style={{ padding: '40px 24px', textAlign: 'center' }}>
              <ClipboardCheck size={28} color="#757684" style={{ margin: '0 auto 10px' }} />
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#454652', fontWeight: 600 }}>
                {lang === 'es' ? 'Aún no hay conteos guardados' : 'No counts saved yet'}
              </div>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', marginTop: '4px' }}>
                {lang === 'es'
                  ? 'Use Iniciar Conteo para registrar el primero.'
                  : 'Run Start Count to record the first one.'}
              </div>
            </div>
          ) : (
            groups.map(([key, rows]) => {
              const isOpen = expandedKey === key;
              const date = rows[0]?.countedAt;
              const counter = rows[0]?.countedBy;
              const groupVariance = rows.reduce((s, r) => s + (r.variance ?? 0), 0);
              const groupVarianceValue = rows.reduce((s, r) => s + (r.varianceValue ?? 0), 0);
              const itemsWithVariance = rows.filter(r => r.variance != null && r.variance !== 0).length;

              return (
                <div key={key} style={{ borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
                  {/* Group header */}
                  <button
                    onClick={() => setExpandedKey(isOpen ? null : key)}
                    style={{
                      width: '100%', padding: '14px 24px', background: 'transparent',
                      border: 'none', cursor: 'pointer', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: '10px',
                    }}
                  >
                    {isOpen ? <ChevronDown size={16} color="#454652" /> : <ChevronRight size={16} color="#454652" />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>
                          {date ? formatDateTime(date, lang) : '—'}
                        </span>
                        {counter && (
                          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684' }}>
                            · {counter}
                          </span>
                        )}
                      </div>
                      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '2px' }}>
                        {rows.length} {lang === 'es' ? 'artículos' : 'items'}
                        {itemsWithVariance > 0 && ` · ${itemsWithVariance} ${lang === 'es' ? 'con variación' : 'with variance'}`}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      {groupVariance !== 0 && (
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', fontWeight: 700,
                          color: groupVariance < 0 ? '#ba1a1a' : '#454652',
                        }}>
                          {groupVariance > 0 ? '+' : ''}{Math.round(groupVariance)} {lang === 'es' ? 'uds' : 'units'}
                        </div>
                      )}
                      {groupVarianceValue !== 0 && (
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
                          color: groupVarianceValue < 0 ? '#ba1a1a' : '#757684',
                          marginTop: '2px',
                        }}>
                          {groupVarianceValue > 0 ? '+' : ''}{formatCurrency(groupVarianceValue)}
                        </div>
                      )}
                    </div>
                  </button>

                  {/* Per-item detail */}
                  {isOpen && (
                    <div style={{ background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{
                        display: 'grid', gridTemplateColumns: '1fr 56px 64px 64px 64px',
                        gap: '8px', padding: '8px 24px 8px 50px',
                        fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: '0.06em', color: '#757684',
                      }}>
                        <span>{lang === 'es' ? 'Artículo' : 'Item'}</span>
                        <span style={{ textAlign: 'right' }}>{lang === 'es' ? 'Est.' : 'Est.'}</span>
                        <span style={{ textAlign: 'right' }}>{lang === 'es' ? 'Contado' : 'Counted'}</span>
                        <span style={{ textAlign: 'right' }}>{lang === 'es' ? 'Var.' : 'Var.'}</span>
                        <span style={{ textAlign: 'right' }}>$</span>
                      </div>
                      {rows
                        .slice()
                        .sort((a, b) => a.itemName.localeCompare(b.itemName))
                        .map(r => {
                          const color = colorFor(r);
                          return (
                            <div key={r.id} style={{
                              display: 'grid', gridTemplateColumns: '1fr 56px 64px 64px 64px',
                              gap: '8px', padding: '6px 24px 6px 50px', alignItems: 'center',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                <span style={{
                                  width: '6px', height: '6px', borderRadius: '50%',
                                  background: color, flexShrink: 0,
                                }} />
                                <span style={{
                                  fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#1b1c19',
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                }}>
                                  {r.itemName}
                                </span>
                              </div>
                              <span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#757684' }}>
                                {r.estimatedStock != null ? Math.round(r.estimatedStock) : '—'}
                              </span>
                              <span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#454652', fontWeight: 600 }}>
                                {r.countedStock}
                              </span>
                              <span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color, fontWeight: r.variance ? 700 : 400 }}>
                                {r.variance == null ? '—' : (r.variance > 0 ? '+' : '') + Math.round(r.variance)}
                              </span>
                              <span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color }}>
                                {r.varianceValue == null ? '—' : (r.varianceValue > 0 ? '+' : '') + formatCurrency(r.varianceValue)}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(197,197,212,0.2)' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%', padding: '12px', borderRadius: '9999px',
              background: '#364262', color: '#fff', border: 'none',
              fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600, cursor: 'pointer',
            }}
          >
            {lang === 'es' ? 'Cerrar' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Compact summary stat card used at the top of the history modal.
function SummaryStat({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone: 'neutral' | 'bad';
}) {
  const valueColor = tone === 'bad' ? '#ba1a1a' : '#364262';
  return (
    <div style={{
      background: '#fff', borderRadius: '12px', padding: '10px 12px',
      border: '1px solid rgba(78,90,122,0.06)',
    }}>
      <div style={{
        fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.06em', color: '#757684',
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: '17px', fontWeight: 700,
        color: valueColor, marginTop: '2px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#757684', marginTop: '1px' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// Locale-aware "Mar 22, 2026 · 3:47 PM" / "22 mar 2026 · 15:47" formatter.
function formatDateTime(d: Date, lang: 'en' | 'es'): string {
  try {
    const locale = lang === 'es' ? 'es-MX' : 'en-US';
    const date = d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    return `${date} · ${time}`;
  } catch {
    return d.toISOString();
  }
}

// ─── Smart Reorder List Modal ────────────────────────────────────────────────
//
// Auto-generated list of items that need to be ordered, derived from the
// prediction engine. Grouped by urgency: Now (red, expanded), Soon (amber,
// expanded), Upcoming (gray, collapsed). Each row has Mark-as-Ordered which
// pre-fills the quantity/vendor/cost from the item, writes to inventory_orders,
// and bumps the item's stock so the next refresh drops it from the list.
//
// Export List copies a clean text summary to clipboard for vendor emails.

interface ReorderRow {
  item: InventoryItem;
  prediction: PredictionResult;
  effectiveStock: number;
  suggestedQty: number;     // par - effectiveStock, floored at 0
  estimatedCost: number;    // suggestedQty * unitCost (0 when no cost)
}

function ReorderListModal({
  items, predictions, effectiveStockOf, dailyAverages,
  uid, pid, lang, onClose, showToast, onOpenBudgets,
}: {
  items: InventoryItem[];
  predictions: Map<string, PredictionResult>;
  effectiveStockOf: (item: InventoryItem) => number;
  dailyAverages: DailyAverages | null;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onLogged: (itemName: string) => void;
  showToast: (msg: string) => void;
  onOpenBudgets: () => void;
}) {
  const rows = useMemo<ReorderRow[]>(() => {
    return items
      .map(item => {
        const prediction = predictions.get(item.id);
        if (!prediction) return null;
        const eff = effectiveStockOf(item);
        const suggestedQty = Math.max(0, Math.ceil(item.parLevel - eff));
        if (suggestedQty <= 0) return null;

        // When the AI prediction has nothing to say (no usage rates
        // configured for the item, or <7 days of occupancy data), fall back
        // to a simple threshold check so items sitting at zero / critically
        // low ALWAYS show up here. Without this fallback, a critically low
        // item could display the red "Critical" badge on the main page and
        // simultaneously be missing from the reorder list — which is what
        // Reeyen flagged on 2026-05-10.
        let effectivePrediction = prediction;
        if (prediction.urgency === 'unknown') {
          const status = stockStatus(eff, item.parLevel, item.reorderAt);
          if (status === 'out') {
            effectivePrediction = { ...prediction, urgency: 'now' };
          } else if (status === 'low') {
            effectivePrediction = { ...prediction, urgency: 'soon' };
          } else {
            // status === 'good' — really no reason to surface this item.
            return null;
          }
        }

        const estimatedCost = item.unitCost ? suggestedQty * item.unitCost : 0;
        return {
          item,
          prediction: effectivePrediction,
          effectiveStock: eff,
          suggestedQty,
          estimatedCost,
        };
      })
      .filter((r): r is ReorderRow => r !== null);
  }, [items, predictions, effectiveStockOf]);

  const nowRows = rows.filter(r => r.prediction.urgency === 'now')
    .sort((a, b) => (a.prediction.daysUntilOut ?? 0) - (b.prediction.daysUntilOut ?? 0));
  const soonRows = rows.filter(r => r.prediction.urgency === 'soon')
    .sort((a, b) => (a.prediction.daysUntilOut ?? 0) - (b.prediction.daysUntilOut ?? 0));
  const okRows = rows.filter(r => r.prediction.urgency === 'ok')
    .sort((a, b) => (a.prediction.daysUntilOut ?? 0) - (b.prediction.daysUntilOut ?? 0));

  const totalCost = rows.reduce((s, r) => s + r.estimatedCost, 0);
  const allEmpty = rows.length === 0;

  const [openInline, setOpenInline] = useState<string | null>(null);
  const [showUpcoming, setShowUpcoming] = useState(false);

  // Budget headroom strip — fetched on mount.
  const [budgetStrip, setBudgetStrip] = useState<Array<{ category: InventoryCategory; budgetCents: number | null; spentCents: number; remainingCents: number | null }>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        const [budgets, spend] = await Promise.all([
          listInventoryBudgets(uid, pid, start),
          monthToDateSpendByCategory(uid, pid, start, next),
        ]);
        if (cancelled) return;
        const budgetMap: Partial<Record<InventoryCategory, number>> = {};
        for (const b of budgets) budgetMap[b.category] = b.budgetCents;
        const statuses = computeBudgetStatuses(spend, budgetMap);
        setBudgetStrip([statuses.housekeeping, statuses.maintenance, statuses.breakfast]);
      } catch (err) {
        console.error('[reorder] budget load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, pid]);

  const handleExport = useCallback(async () => {
    const lines: string[] = [];
    lines.push(lang === 'es' ? 'Lista de Pedidos' : 'Reorder List');
    lines.push(`${new Date().toLocaleDateString()}`);
    lines.push('');
    const writeSection = (title: string, sectionRows: ReorderRow[]) => {
      if (sectionRows.length === 0) return;
      lines.push(title);
      sectionRows.forEach(r => {
        const cost = r.item.unitCost ? ` (~${formatCurrency(r.estimatedCost)})` : '';
        const vendor = r.item.vendorName ? ` from ${r.item.vendorName}` : '';
        lines.push(`  ${r.item.name}: ${r.suggestedQty} ${r.item.unit}${vendor}${cost}`);
      });
      lines.push('');
    };
    writeSection(lang === 'es' ? 'Pedir Ahora' : 'Order Now', nowRows);
    writeSection(lang === 'es' ? 'Pedir Esta Semana' : 'Order This Week', soonRows);
    writeSection(lang === 'es' ? 'Próximos' : 'Upcoming', okRows);
    if (totalCost > 0) {
      lines.push(`${lang === 'es' ? 'Total estimado' : 'Total estimated'}: ${formatCurrency(totalCost)}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast(lang === 'es' ? 'Copiado al portapapeles ✓' : 'Copied to clipboard ✓');
    } catch {
      showToast(lang === 'es' ? 'No se pudo copiar' : 'Copy failed');
    }
  }, [lang, nowRows, soonRows, okRows, totalCost, showToast]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '24px',
        width: '100%', maxWidth: '640px', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ShoppingCart size={18} color="#364262" />
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Lista de Pedidos' : 'Reorder List'}
              </h2>
            </div>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', margin: '4px 0 0 28px' }}>
              {dailyAverages && dailyAverages.daysOfData >= 7
                ? (lang === 'es'
                  ? `Generado del uso de los últimos ${dailyAverages.daysOfData} días.`
                  : `Generated from the last ${dailyAverages.daysOfData} days of usage.`)
                : (lang === 'es'
                  ? 'Necesita al menos 7 días de datos para predicciones.'
                  : 'Needs at least 7 days of data for predictions.')}
            </p>
          </div>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '16px', color: '#454652', lineHeight: 1 }}>✕</span>
          </button>
        </div>

        {/* Budget headroom strip */}
        <div style={{
          padding: '10px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)',
          background: '#f5f3ee',
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {lang === 'es' ? 'Presupuesto' : 'Budget'}
          </span>
          {budgetStrip.map(b => {
            const label = b.category === 'housekeeping'
              ? (lang === 'es' ? 'Limpieza' : 'Housekeeping')
              : b.category === 'maintenance'
                ? (lang === 'es' ? 'Mant.' : 'Maint.')
                : (lang === 'es' ? 'Desayuno' : 'Breakfast');
            if (b.budgetCents == null) {
              return (
                <span key={b.category} style={{
                  fontFamily: "'Inter', sans-serif", fontSize: '11px',
                  padding: '4px 10px', borderRadius: '9999px',
                  background: '#eae8e3', color: '#757684',
                }}>
                  {label}: {lang === 'es' ? 'sin definir' : 'not set'}
                </span>
              );
            }
            const remaining = b.remainingCents ?? 0;
            const overrun = remaining < 0;
            const tone = overrun
              ? { bg: 'rgba(186,26,26,0.1)', fg: '#ba1a1a' }
              : remaining < (b.budgetCents * 0.2)
                ? { bg: 'rgba(201,138,20,0.12)', fg: '#7a5400' }
                : { bg: 'rgba(0,101,101,0.08)', fg: '#006565' };
            return (
              <span key={b.category} style={{
                fontFamily: "'Inter', sans-serif", fontSize: '11px',
                padding: '4px 10px', borderRadius: '9999px',
                background: tone.bg, color: tone.fg, fontWeight: 600,
              }}>
                {label}: ${(remaining / 100).toFixed(0)} / ${(b.budgetCents / 100).toFixed(0)}
              </span>
            );
          })}
          <button
            onClick={onOpenBudgets}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#006565', fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: '4px',
            }}
          >
            <Settings size={11} />
            {lang === 'es' ? 'Editar' : 'Edit'}
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {allEmpty ? (
            <div style={{ padding: '40px 24px', textAlign: 'center' }}>
              <div style={{
                width: '48px', height: '48px', borderRadius: '50%',
                background: 'rgba(0,101,101,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 12px',
              }}>
                <Check size={24} color="#006565" />
              </div>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '16px', fontWeight: 700, color: '#006565' }}>
                {lang === 'es' ? '¡Todo abastecido!' : 'All stocked up!'}
              </div>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', marginTop: '6px' }}>
                {lang === 'es' ? 'No se necesita reorden por ahora.' : 'No reorders needed right now.'}
              </div>
            </div>
          ) : (
            <>
              <ReorderSection
                title={lang === 'es' ? 'Pedir Ahora' : 'Order Now'}
                tone="urgent"
                rows={nowRows}
                lang={lang}
                openInline={openInline}
                setOpenInline={setOpenInline}
                uid={uid}
                pid={pid}
                showToast={showToast}
              />
              <ReorderSection
                title={lang === 'es' ? 'Pedir Esta Semana' : 'Order This Week'}
                tone="soon"
                rows={soonRows}
                lang={lang}
                openInline={openInline}
                setOpenInline={setOpenInline}
                uid={uid}
                pid={pid}
                showToast={showToast}
              />
              {/* Upcoming — collapsed by default */}
              {okRows.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowUpcoming(s => !s)}
                    style={{
                      width: '100%', padding: '10px 24px', background: '#f5f3ee', border: 'none', borderTop: '1px solid rgba(197,197,212,0.2)',
                      borderBottom: '1px solid rgba(197,197,212,0.2)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {showUpcoming ? <ChevronDown size={14} color="#454652" /> : <ChevronRight size={14} color="#454652" />}
                      <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 700, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {lang === 'es' ? `Próximos (${okRows.length})` : `Upcoming (${okRows.length})`}
                      </span>
                    </div>
                  </button>
                  {showUpcoming && (
                    <ReorderSection
                      title=""
                      tone="ok"
                      rows={okRows}
                      lang={lang}
                      openInline={openInline}
                      setOpenInline={setOpenInline}
                      uid={uid}
                      pid={pid}
                      showToast={showToast}
                      hideHeader
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(197,197,212,0.2)', background: '#fbf9f4' }}>
          {totalCost > 0 && (
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', marginBottom: '10px', textAlign: 'center' }}>
              {lang === 'es' ? 'Costo total estimado' : 'Total estimated restock cost'}
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: '#1b1c19', marginLeft: '8px' }}>
                {formatCurrency(totalCost)}
              </span>
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleExport}
              disabled={allEmpty}
              style={{
                padding: '12px 20px', borderRadius: '9999px', border: '1px solid #c5c5d4',
                background: '#fff', color: '#454652', cursor: allEmpty ? 'not-allowed' : 'pointer',
                fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '6px', opacity: allEmpty ? 0.4 : 1,
              }}
            >
              <Copy size={14} />
              {lang === 'es' ? 'Exportar' : 'Export List'}
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1, padding: '12px', borderRadius: '9999px', border: 'none',
                background: '#364262', color: '#fff', cursor: 'pointer',
                fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
              }}
            >
              {lang === 'es' ? 'Cerrar' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReorderSection({
  title, tone, rows, lang, openInline, setOpenInline, uid, pid, showToast, hideHeader,
}: {
  title: string;
  tone: 'urgent' | 'soon' | 'ok';
  rows: ReorderRow[];
  lang: 'en' | 'es';
  openInline: string | null;
  setOpenInline: (v: string | null) => void;
  uid: string;
  pid: string;
  showToast: (msg: string) => void;
  hideHeader?: boolean;
}) {
  if (rows.length === 0) return null;
  const headerColor = tone === 'urgent' ? '#ba1a1a' : tone === 'soon' ? '#c98a14' : '#757684';
  const headerBg = tone === 'urgent' ? 'rgba(186,26,26,0.06)' : tone === 'soon' ? 'rgba(201,138,20,0.06)' : '#f5f3ee';
  return (
    <div>
      {!hideHeader && (
        <div style={{
          padding: '10px 24px', background: headerBg,
          borderTop: '1px solid rgba(197,197,212,0.2)',
          borderBottom: '1px solid rgba(197,197,212,0.2)',
        }}>
          <div style={{
            fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 700,
            color: headerColor, textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            {title} ({rows.length})
          </div>
        </div>
      )}
      {rows.map(r => (
        <ReorderRowView
          key={r.item.id}
          row={r}
          tone={tone}
          lang={lang}
          isOpen={openInline === r.item.id}
          onToggle={() => setOpenInline(openInline === r.item.id ? null : r.item.id)}
          uid={uid}
          pid={pid}
          showToast={showToast}
        />
      ))}
    </div>
  );
}

function ReorderRowView({
  row, tone, lang, isOpen, onToggle, uid, pid, showToast,
}: {
  row: ReorderRow;
  tone: 'urgent' | 'soon' | 'ok';
  lang: 'en' | 'es';
  isOpen: boolean;
  onToggle: () => void;
  uid: string;
  pid: string;
  showToast: (msg: string) => void;
}) {
  const { item, prediction, effectiveStock: eff, suggestedQty, estimatedCost } = row;
  const accent = tone === 'urgent' ? '#ba1a1a' : tone === 'soon' ? '#c98a14' : '#757684';

  const [qty, setQty] = useState(String(suggestedQty));
  const [vendor, setVendor] = useState(item.vendorName ?? '');
  const [unitCost, setUnitCost] = useState(item.unitCost != null ? String(item.unitCost) : '');
  const [saving, setSaving] = useState(false);
  const [logged, setLogged] = useState(false);

  const handleConfirm = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const q = parseFloat(qty) || 0;
      const c = unitCost.trim() === '' ? undefined : parseFloat(unitCost);
      await addInventoryOrder(uid, pid, {
        propertyId: pid,
        itemId: item.id,
        itemName: item.name,
        quantity: q,
        unitCost: c,
        vendorName: vendor.trim() || undefined,
        receivedAt: new Date(),
      });
      // Bump current_stock so the next refresh drops it from the list.
      await updateInventoryItem(uid, pid, item.id, { currentStock: eff + q });
      setLogged(true);
      showToast(lang === 'es' ? `Pedido registrado: ${item.name}` : `Order logged: ${item.name}`);
    } catch (err) {
      console.error('[reorder] log failed', err);
      showToast(lang === 'es' ? 'Error al guardar' : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const orderByLabel = prediction.orderByDate
    ? prediction.orderByDate.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' })
    : '—';
  const daysUntilOutLabel = prediction.daysUntilOut != null
    ? `${Math.max(0, Math.round(prediction.daysUntilOut))} ${lang === 'es' ? 'días' : 'days'}`
    : '—';

  if (logged) {
    return (
      <div style={{ padding: '14px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', gap: '10px', opacity: 0.6 }}>
        <Check size={14} color="#006565" />
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', textDecoration: 'line-through' }}>
          {item.name} — {lang === 'es' ? 'pedido registrado' : 'order logged'}
        </span>
      </div>
    );
  }

  return (
    <div style={{ borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
      <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: accent }} />
              <span style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: '14px', color: '#1b1c19' }}>
                {item.name}
              </span>
            </div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', marginTop: '2px' }}>
              {Math.round(eff)} / {item.parLevel} {item.unit} ·{' '}
              {lang === 'es' ? `se acaba en ${daysUntilOutLabel}` : `out in ${daysUntilOutLabel}`}
              {item.vendorName ? ` · ${item.vendorName}` : ''}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '14px', color: '#1b1c19' }}>
              +{suggestedQty}
            </div>
            {estimatedCost > 0 && (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#757684' }}>
                {formatCurrency(estimatedCost)}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: accent, fontWeight: 600 }}>
            {lang === 'es' ? 'Pedir antes de' : 'Order by'} {orderByLabel}
          </span>
          <button
            onClick={onToggle}
            style={{
              padding: '6px 12px', borderRadius: '9999px',
              border: '1px solid #c5c5d4', background: isOpen ? '#f0eee9' : '#fff',
              fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 600,
              color: '#454652', cursor: 'pointer',
            }}
          >
            {isOpen
              ? (lang === 'es' ? 'Cancelar' : 'Cancel')
              : (lang === 'es' ? 'Marcar como Pedido' : 'Mark as Ordered')}
          </button>
        </div>
      </div>
      {isOpen && (
        <div style={{ padding: '12px 24px 14px', background: 'rgba(0,0,0,0.02)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '8px' }}>
            <input
              type="number" min="0" value={qty} onChange={e => setQty(e.target.value)}
              placeholder={lang === 'es' ? 'Cantidad' : 'Qty'}
              style={{ padding: '8px 10px', borderRadius: '10px', border: '1px solid #c5c5d4', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px' }}
            />
            <input
              type="number" step="0.01" min="0" value={unitCost} onChange={e => setUnitCost(e.target.value)}
              placeholder="$"
              style={{ padding: '8px 10px', borderRadius: '10px', border: '1px solid #c5c5d4', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px' }}
            />
            <input
              value={vendor} onChange={e => setVendor(e.target.value)}
              placeholder={lang === 'es' ? 'Proveedor' : 'Vendor'}
              style={{ padding: '8px 10px', borderRadius: '10px', border: '1px solid #c5c5d4', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}
            />
          </div>
          <button
            onClick={handleConfirm}
            disabled={saving}
            style={{
              padding: '10px', borderRadius: '9999px', border: 'none',
              background: '#364262', color: '#fff', cursor: 'pointer',
              fontFamily: "'Inter', sans-serif", fontSize: '13px', fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            <Check size={14} />
            {saving
              ? (lang === 'es' ? 'Guardando...' : 'Saving...')
              : (lang === 'es' ? 'Confirmar Pedido' : 'Confirm Order')}
          </button>
        </div>
      )}
    </div>
  );
}


// ─── Photo Count Review Modal ──────────────────────────────────────────────
//
// Opens after the AI returns counts from a photo. Shows every detection
// alongside the user's current count input and lets them decide per item
// whether to accept it (and whether to ADD the detected count to current
// stock or REPLACE the current value with it). Items the user rejects
// stay untouched.
//
// Mode toggle at the top is the default for all rows; per-row "use other
// mode" link lets the user mix modes when a single inventory pass mostly
// follows one rule but has exceptions (e.g. "this is a full count except
// the body wash shipment we just received — add that one").

function PhotoCountReviewModal({
  detections, lang, onCancel, onApply,
}: {
  detections: PhotoDetection[];
  lang: 'en' | 'es';
  onCancel: () => void;
  onApply: (decisions: PhotoDecision[]) => void;
}) {
  type RowState = { action: 'pending' | 'accept' | 'reject'; mode: 'add' | 'replace' };
  const [globalMode, setGlobalMode] = useState<'add' | 'replace'>('add');
  const [rowStates, setRowStates] = useState<Record<string, RowState>>(() => {
    const init: Record<string, RowState> = {};
    detections.forEach(d => { init[d.itemId] = { action: 'pending', mode: 'add' }; });
    return init;
  });

  // When the user flips the global toggle, sync any rows that haven't been
  // individually overridden. We track "overridden" implicitly: if a row's
  // mode currently matches the OLD global, it follows the new global.
  // Rows the user already toggled to the opposite mode keep their override.
  const handleGlobalMode = (next: 'add' | 'replace') => {
    setRowStates(prev => {
      const out: Record<string, RowState> = { ...prev };
      for (const id in out) {
        if (out[id].mode === globalMode) {
          out[id] = { ...out[id], mode: next };
        }
      }
      return out;
    });
    setGlobalMode(next);
  };

  const setRowAction = (id: string, action: 'accept' | 'reject') => {
    setRowStates(prev => ({ ...prev, [id]: { ...prev[id], action } }));
  };
  const flipRowMode = (id: string) => {
    setRowStates(prev => ({
      ...prev,
      [id]: { ...prev[id], mode: prev[id].mode === 'add' ? 'replace' : 'add' },
    }));
  };

  const counts = useMemo(() => {
    let accepted = 0, rejected = 0, pending = 0;
    for (const d of detections) {
      const s = rowStates[d.itemId];
      if (s?.action === 'accept') accepted++;
      else if (s?.action === 'reject') rejected++;
      else pending++;
    }
    return { accepted, rejected, pending };
  }, [detections, rowStates]);

  const allDecided = counts.pending === 0;

  const handleApplyClick = () => {
    const decisions: PhotoDecision[] = detections.map(d => ({
      itemId: d.itemId,
      action: rowStates[d.itemId]?.action === 'accept' ? 'accept' : 'reject',
      mode: rowStates[d.itemId]?.mode ?? 'add',
      aiCount: d.aiCount,
      confidence: d.confidence,
    }));
    onApply(decisions);
  };

  const handleAcceptAll = () => {
    setRowStates(prev => {
      const next: Record<string, RowState> = {};
      for (const id in prev) next[id] = { ...prev[id], action: 'accept' };
      return next;
    });
  };

  const confidenceColor = (c: 'high' | 'medium' | 'low') =>
    c === 'high' ? '#00a050' : c === 'medium' ? '#f0ad4e' : '#dc3545';
  const confidenceLabel = (c: 'high' | 'medium' | 'low') =>
    lang === 'es'
      ? (c === 'high' ? 'alta' : c === 'medium' ? 'media' : 'baja')
      : c;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(27,28,25,0.6)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        width: '100%', maxWidth: '640px', maxHeight: '90vh',
        background: '#fbf9f4', borderRadius: '24px',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px', color: '#1b1c19', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Camera size={16} color="#006565" />
                {lang === 'es' ? 'Resultados de Foto' : 'Photo Count Results'}
              </h2>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '4px 0 0' }}>
                {detections.length === 0
                  ? (lang === 'es' ? 'La IA no identificó ningún artículo. Pruebe con otra foto.' : "AI didn't see any tracked items. Try another photo.")
                  : (lang === 'es'
                    ? `La IA identificó ${detections.length} artículo${detections.length === 1 ? '' : 's'}. Acepta o rechaza cada uno.`
                    : `AI saw ${detections.length} item${detections.length === 1 ? '' : 's'}. Accept or reject each.`)}
              </p>
            </div>
            <button onClick={onCancel} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%' }}>
              <XIcon size={14} color="#454652" />
            </button>
          </div>

          {/* Mode toggle */}
          {detections.length > 0 && (
            <div style={{ marginTop: '14px' }}>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: 700, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                {lang === 'es' ? 'Modo' : 'Mode'}
              </div>
              <div style={{ display: 'inline-flex', background: '#eae8e3', borderRadius: '9999px', padding: '3px' }}>
                <ModeChip
                  active={globalMode === 'add'}
                  label={lang === 'es' ? 'Sumar al actual' : 'Add to current'}
                  onClick={() => handleGlobalMode('add')}
                />
                <ModeChip
                  active={globalMode === 'replace'}
                  label={lang === 'es' ? 'Reemplazar total' : 'Replace total'}
                  onClick={() => handleGlobalMode('replace')}
                />
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', margin: '6px 0 0' }}>
                {globalMode === 'add'
                  ? (lang === 'es'
                    ? 'El conteo de la IA se suma a lo que ya está en stock. Úsalo para conteos parciales o entregas nuevas.'
                    : 'AI count gets added to what\'s already in stock. Use this for partial counts or new deliveries.')
                  : (lang === 'es'
                    ? 'El conteo de la IA se convierte en el total nuevo. Úsalo para un conteo completo de inventario.'
                    : 'AI count becomes the new total. Use this for a full inventory count.')}
              </p>
            </div>
          )}
        </div>

        {/* Body */}
        {detections.length > 0 ? (
          <>
            <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
              {detections.map(d => {
                const state = rowStates[d.itemId];
                const newTotal = state.mode === 'add' ? d.currentInput + d.aiCount : d.aiCount;
                const isAccepted = state.action === 'accept';
                const isRejected = state.action === 'reject';
                const bg = isAccepted ? 'rgba(0,160,80,0.06)'
                  : isRejected ? 'rgba(186,26,26,0.04)'
                  : 'transparent';

                return (
                  <div key={d.itemId} style={{
                    padding: '14px 24px', background: bg,
                    borderBottom: '1px solid rgba(197,197,212,0.2)',
                    opacity: isRejected ? 0.55 : 1,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: '180px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            width: '8px', height: '8px', borderRadius: '50%',
                            background: confidenceColor(d.confidence),
                          }} />
                          <span style={{
                            fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '14px',
                            color: '#1b1c19',
                            textDecoration: isRejected ? 'line-through' : 'none',
                          }}>
                            {d.itemName}
                          </span>
                          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', color: '#757684', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {lang === 'es' ? `confianza ${confidenceLabel(d.confidence)}` : `${confidenceLabel(d.confidence)} confidence`}
                          </span>
                        </div>

                        <div style={{ display: 'flex', gap: '14px', marginTop: '6px', flexWrap: 'wrap', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px' }}>
                          <span style={{ color: '#454652' }}>
                            <span style={{ color: '#757684', fontFamily: "'Inter', sans-serif", fontSize: '11px' }}>
                              {lang === 'es' ? 'IA vio: ' : 'AI saw: '}
                            </span>
                            <strong>{d.aiCount}</strong>
                          </span>
                          <span style={{ color: '#454652' }}>
                            <span style={{ color: '#757684', fontFamily: "'Inter', sans-serif", fontSize: '11px' }}>
                              {lang === 'es' ? 'Actual: ' : 'Currently: '}
                            </span>
                            <strong>{d.currentInput}</strong>
                          </span>
                          <span style={{ color: '#006565' }}>
                            <span style={{ color: '#757684', fontFamily: "'Inter', sans-serif", fontSize: '11px' }}>
                              {lang === 'es' ? 'Nuevo total: ' : 'New total: '}
                            </span>
                            <strong>{newTotal}</strong>
                          </span>
                        </div>

                        {/* Per-row mode override */}
                        <button
                          type="button"
                          onClick={() => flipRowMode(d.itemId)}
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: '#006565', fontFamily: "'Inter', sans-serif",
                            fontSize: '11px', fontWeight: 600, padding: '4px 0', marginTop: '4px',
                          }}
                        >
                          {state.mode === 'add'
                            ? (lang === 'es' ? '↻ usar reemplazar para este' : '↻ use replace for this')
                            : (lang === 'es' ? '↻ usar sumar para este' : '↻ use add for this')}
                        </button>
                      </div>

                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          onClick={() => setRowAction(d.itemId, 'reject')}
                          style={{
                            padding: '8px 14px', borderRadius: '9999px',
                            border: isRejected ? 'none' : '1px solid #c5c5d4',
                            background: isRejected ? '#ba1a1a' : '#fff',
                            color: isRejected ? '#fff' : '#454652',
                            fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {lang === 'es' ? 'Rechazar' : 'Reject'}
                        </button>
                        <button
                          onClick={() => setRowAction(d.itemId, 'accept')}
                          style={{
                            padding: '8px 14px', borderRadius: '9999px', border: 'none',
                            background: isAccepted ? '#006565' : '#364262',
                            color: '#fff',
                            fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {isAccepted
                            ? (lang === 'es' ? '✓ Aceptado' : '✓ Accepted')
                            : (lang === 'es' ? 'Aceptar' : 'Accept')}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#454652' }}>
                <strong style={{ color: '#006565' }}>{counts.accepted}</strong> {lang === 'es' ? 'aceptado' : 'accepted'}
                {' · '}
                <strong style={{ color: '#ba1a1a' }}>{counts.rejected}</strong> {lang === 'es' ? 'rechazado' : 'rejected'}
                {' · '}
                <strong style={{ color: '#7a5400' }}>{counts.pending}</strong> {lang === 'es' ? 'pendiente' : 'pending'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {counts.pending > 0 && (
                  <button
                    onClick={handleAcceptAll}
                    style={{
                      padding: '10px 16px', borderRadius: '9999px',
                      border: '1px solid #006565', background: '#fff', color: '#006565',
                      fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {lang === 'es' ? 'Aceptar todos' : 'Accept all'}
                  </button>
                )}
                <button
                  onClick={onCancel}
                  style={{
                    padding: '10px 16px', borderRadius: '9999px',
                    border: '1px solid #c5c5d4', background: '#fff', color: '#454652',
                    fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {lang === 'es' ? 'Cancelar' : 'Cancel'}
                </button>
                <button
                  onClick={handleApplyClick}
                  disabled={!allDecided}
                  style={{
                    padding: '10px 16px', borderRadius: '9999px', border: 'none',
                    background: allDecided ? '#364262' : '#eae8e3',
                    color: allDecided ? '#fff' : '#757684',
                    fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                    cursor: allDecided ? 'pointer' : 'not-allowed',
                  }}
                >
                  {lang === 'es' ? 'Aplicar' : 'Apply'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
              {lang === 'es'
                ? 'La IA no identificó ningún artículo en esta foto. Pruebe con una imagen más clara o más cercana al estante.'
                : "AI didn't see any tracked items in this photo. Try a clearer shot or get closer to the shelf."}
            </div>
            <button
              onClick={onCancel}
              style={{
                marginTop: '16px',
                padding: '10px 20px', borderRadius: '9999px', border: 'none',
                background: '#364262', color: '#fff',
                fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {lang === 'es' ? 'Cerrar' : 'Close'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: '9999px', border: 'none',
        background: active ? '#1b1c19' : 'transparent',
        color: active ? '#fff' : '#454652',
        fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
        cursor: 'pointer',
        transition: 'all 150ms',
      }}
    >
      {label}
    </button>
  );
}

// ─── Image picker helper (shared by Invoice OCR and Photo Counting) ─────────
//
// Two-step pattern: (a) pick a file via camera or gallery, (b) confirm + upload.
// Reads the file as a base64 data URL for two reasons: (1) we send the bytes
// to /api/inventory/* anyway, (2) we display a preview before upload. Returns
// { base64, mediaType, file } so the caller can decide whether to ALSO upload
// to Supabase Storage for record-keeping.

// Must mirror SUPPORTED_MEDIA_TYPES in /api/inventory/scan-invoice and
// /api/inventory/photo-count. Adding a type here without matching the route
// (or vice versa) means the API will 400 the upload after the user already
// committed to the picker — rude.
//
// HEIC/HEIF are deliberately NOT here. Anthropic Vision rejects them, so
// we surface a "convert to JPEG" message at the picker (via the
// onUnsupported callback) instead of letting the upload fail server-side.
type PickedMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
const PICKED_MEDIA_TYPES: ReadonlySet<string> = new Set<PickedMediaType>([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

interface PickedImage {
  base64: string;        // raw base64, no data: prefix
  mediaType: PickedMediaType;
  file: File;
  previewUrl: string;    // data: URL for <img src=>
}

function ImagePickerStage({ lang, onPicked, onUnsupported, accept = 'image/*' }: {
  lang: 'en' | 'es';
  onPicked: (img: PickedImage) => void;
  /** Called when the user picks a file we can't actually send to Vision (PDFs,
   *  exotic image types). Defaults to no-op so existing call sites don't break.
   *  scan-invoice's picker passes a handler that surfaces a toast. */
  onUnsupported?: (mediaType: string) => void;
  accept?: string;
}) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:image/jpeg;base64,...."
      const m = result.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return;
      const rawMediaType = m[1];
      if (!PICKED_MEDIA_TYPES.has(rawMediaType)) {
        // PDF, HEVC video, anything exotic. Refuse at the picker — Vision
        // would reject it server-side anyway.
        onUnsupported?.(rawMediaType);
        return;
      }
      const mediaType = rawMediaType as PickedMediaType;
      const base64 = m[2];
      onPicked({ base64, mediaType, file, previewUrl: result });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' }}>
      <input
        ref={cameraInputRef}
        type="file" accept="image/*" capture="environment"
        onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
        style={{ display: 'none' }}
      />
      <input
        ref={fileInputRef}
        type="file" accept={accept}
        onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
        style={{ display: 'none' }}
      />
      <button
        onClick={() => cameraInputRef.current?.click()}
        style={{
          padding: '14px', borderRadius: '14px', border: '1px solid #c5c5d4',
          background: '#fff', color: '#1b1c19', cursor: 'pointer',
          fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}
      >
        <Camera size={16} />
        {lang === 'es' ? 'Tomar Foto' : 'Take Photo'}
      </button>
      <button
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: '14px', borderRadius: '14px', border: '1px solid #c5c5d4',
          background: '#fff', color: '#1b1c19', cursor: 'pointer',
          fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}
      >
        <Upload size={16} />
        {lang === 'es' ? 'Cargar Archivo' : 'Upload File'}
      </button>
    </div>
  );
}

// ─── Scan Invoice Modal ──────────────────────────────────────────────────────
//
// 4-step state machine: pick → uploading → confirm → done.
//
//   pick:       ImagePickerStage. User chooses camera or upload.
//   uploading:  POST image to /api/inventory/scan-invoice. Spinner.
//   confirm:    Render extracted line items in an editable table. User
//               unchecks rows they don't want, picks a fuzzy-matched item
//               for each row, edits qty/cost, then Confirms.
//   done:       Closed by parent via onClose after success toast.
//
// Image is also uploaded to Supabase Storage (invoices bucket) for the
// audit trail. Failure to upload to Storage is non-fatal — we still extract.

interface ExtractedLine {
  item_name: string;
  quantity: number;                    // resolved units
  quantity_cases: number | null;       // case count (null when received as units)
  pack_size: number | null;            // units per case (null when not specified)
  unit_cost: number | null;
  total_cost: number | null;
}

interface ConfirmRow {
  raw: ExtractedLine;
  enabled: boolean;
  matchedItemId: string | 'new' | '';  // '' = unmatched, 'new' = create-new
  matchedNewName: string;              // used when 'new'
  qty: string;                          // string for input — resolved units
  unitCost: string;
  quantityCases: number | null;         // carried through to inventory_orders so we can show "received 3 cases"
  packSizeHint: number | null;          // hint for "create new" path so the new item gets pack_size populated
}

function ScanInvoiceModal({ items, uid, pid, lang, onClose, showToast }: {
  items: InventoryItem[];
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  type Stage = 'pick' | 'uploading' | 'confirm' | 'saving';
  const [stage, setStage] = useState<Stage>('pick');
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [vendorName, setVendorName] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [rows, setRows] = useState<ConfirmRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const itemNamesLower = useMemo(() => items.map(i => ({ id: i.id, lower: i.name.toLowerCase() })), [items]);

  // Lightweight fuzzy match — substring containment in either direction.
  // Good enough for "Bath Towels" vs "BATH TOWEL 27x52" without dragging in
  // a Levenshtein dependency.
  const fuzzyMatch = useCallback((rawName: string): string => {
    const lower = rawName.toLowerCase();
    if (!lower) return '';
    // Exact
    const exact = itemNamesLower.find(i => i.lower === lower);
    if (exact) return exact.id;
    // Inventory-name contained in invoice-name
    const partial = itemNamesLower.find(i => lower.includes(i.lower));
    if (partial) return partial.id;
    // Invoice-name contained in inventory-name
    const reverse = itemNamesLower.find(i => i.lower.includes(lower));
    if (reverse) return reverse.id;
    return '';
  }, [itemNamesLower]);

  const handlePicked = useCallback(async (img: PickedImage) => {
    setPicked(img);
    setStage('uploading');
    setError(null);

    // Best-effort upload to Storage for audit. Non-blocking on failure.
    try {
      const ext = img.mediaType.split('/')[1] || 'jpg';
      const path = `${pid}/${Date.now()}.${ext}`;
      await supabase.storage.from('invoices').upload(path, img.file, {
        contentType: img.mediaType,
        upsert: false,
      });
    } catch {
      /* non-fatal */
    }

    try {
      const res = await fetchWithAuth('/api/inventory/scan-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, imageBase64: img.base64, mediaType: img.mediaType }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.detail || json.error || 'extraction_failed');

      setVendorName(json.vendor_name ?? '');
      setInvoiceDate(json.invoice_date ?? '');
      setInvoiceNumber(json.invoice_number ?? '');
      const extracted: ExtractedLine[] = json.items ?? [];
      setRows(extracted.map(line => {
        const matched = fuzzyMatch(line.item_name);
        return {
          raw: line,
          enabled: true,
          matchedItemId: matched || '',
          matchedNewName: line.item_name,
          qty: String(line.quantity),
          unitCost: line.unit_cost != null ? String(line.unit_cost) : '',
          quantityCases: line.quantity_cases ?? null,
          packSizeHint: line.pack_size ?? null,
        };
      }));
      setStage('confirm');
    } catch (e) {
      setError(
        lang === 'es'
          ? 'No se pudo leer esta factura. Intente con una foto más clara o ingrese manualmente.'
          : "Couldn't read this invoice. Try a clearer photo or enter manually.",
      );
      setStage('pick');
    }
  }, [pid, fuzzyMatch, lang]);

  const handleConfirm = async () => {
    setStage('saving');
    let logged = 0;
    try {
      for (const row of rows) {
        if (!row.enabled) continue;
        const qty = parseFloat(row.qty) || 0;
        if (qty <= 0) continue;
        const unitCostNum = row.unitCost.trim() === '' ? undefined : parseFloat(row.unitCost);

        let itemId = row.matchedItemId;

        // Create new item if user opted to.
        if (itemId === 'new' || itemId === '') {
          const created = await addInventoryItem(uid, pid, {
            propertyId: pid,
            name: row.matchedNewName.trim() || row.raw.item_name,
            category: 'housekeeping',
            currentStock: qty,            // first stock = the qty received
            parLevel: Math.max(qty * 2, 10),
            unit: 'units',
            unitCost: unitCostNum,
            vendorName: vendorName || undefined,
            // Carry pack-size from the invoice so "Bath Towels 36/case" fills in automatically.
            packSize: row.packSizeHint ?? undefined,
          });
          itemId = created;
          logged++;
        } else {
          // Bump existing item: stock += qty, optionally update unit_cost.
          const item = items.find(i => i.id === itemId);
          if (!item) continue;
          const newStock = item.currentStock + qty;
          const patch: Partial<InventoryItem> = { currentStock: newStock };
          if (unitCostNum != null && (item.unitCost == null || Math.abs(item.unitCost - unitCostNum) > 0.005)) {
            patch.unitCost = unitCostNum;
          }
          if (vendorName && !item.vendorName) patch.vendorName = vendorName;
          await updateInventoryItem(uid, pid, itemId, patch);
          logged++;
        }

        // Always log to inventory_orders for the spend ledger.
        await addInventoryOrder(uid, pid, {
          propertyId: pid,
          itemId,
          itemName: row.matchedNewName || row.raw.item_name,
          quantity: qty,
          quantityCases: row.quantityCases ?? undefined,
          unitCost: unitCostNum,
          vendorName: vendorName || undefined,
          receivedAt: invoiceDate ? new Date(invoiceDate) : new Date(),
          notes: invoiceNumber ? `Invoice #${invoiceNumber}` : undefined,
        });
      }
      onClose();
      showToast(
        lang === 'es'
          ? `${logged} artículo(s) reabastecidos desde factura`
          : `${logged} item${logged === 1 ? '' : 's'} restocked from invoice`,
      );
    } catch (e) {
      setError(lang === 'es' ? 'Error al guardar. Intente de nuevo.' : 'Save failed. Please try again.');
      setStage('confirm');
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget && stage !== 'uploading' && stage !== 'saving') onClose(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '24px',
        width: '100%', maxWidth: stage === 'confirm' ? '720px' : '480px',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ScanLine size={18} color="#006565" />
            <div>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '17px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Escanear Factura' : 'Scan Invoice'}
              </h2>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '2px 0 0' }}>
                {stage === 'pick' && (lang === 'es' ? 'Tome una foto o cargue su factura.' : 'Take a photo or upload your invoice.')}
                {stage === 'uploading' && (lang === 'es' ? 'Leyendo factura...' : 'Reading invoice...')}
                {stage === 'confirm' && (lang === 'es' ? `${rows.length} artículo${rows.length === 1 ? '' : 's'} encontrado${rows.length === 1 ? '' : 's'}${vendorName ? ' de ' + vendorName : ''}` : `${rows.length} item${rows.length === 1 ? '' : 's'} found${vendorName ? ' from ' + vendorName : ''}`)}
                {stage === 'saving' && (lang === 'es' ? 'Guardando...' : 'Saving...')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={stage === 'uploading' || stage === 'saving'}
            style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: stage === 'uploading' || stage === 'saving' ? 0.4 : 1 }}
          >
            <XIcon size={14} color="#454652" />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {error && (
            <div style={{ padding: '12px 24px', background: 'rgba(186,26,26,0.08)', color: '#ba1a1a', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
              {error}
            </div>
          )}

          {stage === 'pick' && (
            <ImagePickerStage
              lang={lang}
              onPicked={handlePicked}
              // PDFs aren't wired through to Vision yet — accept image/* only
              // and tell the user when they try a PDF/heif-but-renamed file.
              accept="image/*"
              onUnsupported={(mt) => {
                const isHeic = mt === 'image/heic' || mt === 'image/heif';
                setError(
                  lang === 'es'
                    ? isHeic
                      ? 'Las fotos HEIC del iPhone no son compatibles. Toma la foto en JPEG o usa una captura de pantalla.'
                      : `Tipo de archivo no admitido (${mt}). Usa una foto del recibo.`
                    : isHeic
                      ? 'iPhone HEIC photos are not supported. Take the photo in JPEG or use a screenshot.'
                      : `Unsupported file type (${mt}). Please upload a photo of the receipt.`
                );
              }}
            />
          )}

          {stage === 'uploading' && (
            <div style={{ padding: '60px 24px', textAlign: 'center' }}>
              <div className="animate-spin" style={{ width: '32px', height: '32px', margin: '0 auto 12px', border: '3px solid #c5c5d4', borderTopColor: '#006565', borderRadius: '50%' }} />
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
                {lang === 'es' ? 'Leyendo factura...' : 'Reading invoice...'}
              </div>
            </div>
          )}

          {stage === 'confirm' && (
            <div style={{ padding: '14px 24px 18px' }}>
              {/* Vendor / date / invoice# header */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: '8px', marginBottom: '14px' }}>
                <FieldSmall label={lang === 'es' ? 'Proveedor' : 'Vendor'}>
                  <input value={vendorName} onChange={e => setVendorName(e.target.value)} style={smallInputStyle} />
                </FieldSmall>
                <FieldSmall label={lang === 'es' ? 'Fecha' : 'Date'}>
                  <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} style={smallInputStyle} />
                </FieldSmall>
                <FieldSmall label={lang === 'es' ? 'Factura #' : 'Invoice #'}>
                  <input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} style={smallInputStyle} />
                </FieldSmall>
              </div>

              {/* Line items */}
              {rows.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: '#757684', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
                  {lang === 'es' ? 'No se detectaron artículos. Pruebe con una foto más clara.' : 'No line items detected. Try a clearer photo.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {rows.map((row, idx) => (
                    <div key={idx} style={{
                      background: '#fff', border: '1px solid #c5c5d4', borderRadius: '12px',
                      padding: '10px 12px',
                      display: 'grid', gridTemplateColumns: '20px 1.6fr 1.6fr 70px 80px',
                      gap: '8px', alignItems: 'center',
                      opacity: row.enabled ? 1 : 0.5,
                    }}>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={e => setRows(prev => prev.map((r, i) => i === idx ? { ...r, enabled: e.target.checked } : r))}
                      />
                      <div>
                        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#454652', fontWeight: 600 }}>
                          {row.raw.item_name}
                        </div>
                        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', color: '#757684' }}>
                          {lang === 'es' ? 'línea de factura' : 'invoice line'}
                        </div>
                      </div>
                      <div>
                        <select
                          value={row.matchedItemId}
                          onChange={e => setRows(prev => prev.map((r, i) => i === idx ? { ...r, matchedItemId: e.target.value as ConfirmRow['matchedItemId'] } : r))}
                          style={{ ...smallInputStyle, width: '100%' }}
                        >
                          <option value="">{lang === 'es' ? '— Seleccionar —' : '— Select —'}</option>
                          <option value="new">+ {lang === 'es' ? 'Agregar como nuevo' : 'Add as new item'}</option>
                          {items.map(it => (
                            <option key={it.id} value={it.id}>{it.name}</option>
                          ))}
                        </select>
                        {row.matchedItemId === 'new' && (
                          <input
                            value={row.matchedNewName}
                            onChange={e => setRows(prev => prev.map((r, i) => i === idx ? { ...r, matchedNewName: e.target.value } : r))}
                            placeholder={lang === 'es' ? 'Nombre del nuevo artículo' : 'New item name'}
                            style={{ ...smallInputStyle, width: '100%', marginTop: '4px' }}
                          />
                        )}
                      </div>
                      <input
                        type="number" min="0" value={row.qty}
                        onChange={e => setRows(prev => prev.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                        style={{ ...smallInputStyle, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}
                      />
                      <input
                        type="number" step="0.01" min="0" value={row.unitCost}
                        onChange={e => setRows(prev => prev.map((r, i) => i === idx ? { ...r, unitCost: e.target.value } : r))}
                        placeholder="$"
                        style={{ ...smallInputStyle, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {stage === 'saving' && (
            <div style={{ padding: '60px 24px', textAlign: 'center' }}>
              <div className="animate-spin" style={{ width: '32px', height: '32px', margin: '0 auto 12px', border: '3px solid #c5c5d4', borderTopColor: '#006565', borderRadius: '50%' }} />
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
                {lang === 'es' ? 'Guardando artículos...' : 'Saving items...'}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {stage === 'confirm' && rows.length > 0 && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(197,197,212,0.2)' }}>
            <button
              onClick={handleConfirm}
              style={{
                width: '100%', padding: '14px', borderRadius: '9999px', border: 'none',
                background: '#364262', color: '#fff', cursor: 'pointer',
                fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              }}
            >
              <Check size={16} />
              {lang === 'es'
                ? `Confirmar e Importar (${rows.filter(r => r.enabled).length})`
                : `Confirm & Import (${rows.filter(r => r.enabled).length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const smallInputStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: '8px', border: '1px solid #c5c5d4',
  background: '#fff', fontFamily: "'Inter', sans-serif", fontSize: '13px',
  color: '#1b1c19', outline: 'none',
};

function FieldSmall({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600, color: '#757684', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '4px' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Bulk Usage Rates Modal ──────────────────────────────────────────────────
//
// Big editable table for setting usage_per_checkout / usage_per_stayover /
// unit_cost on every item at once. Way faster than the one-by-one edit
// modal during onboarding.

function BulkUsageRatesModal({
  items, uid, pid, lang, onClose, onSaved,
}: {
  items: InventoryItem[];
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onSaved: (n: number) => void;
}) {
  const sorted = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const [draft, setDraft] = useState<Record<string, { perCheckout: string; perStayover: string; unitCost: string }>>(() => {
    const d: Record<string, { perCheckout: string; perStayover: string; unitCost: string }> = {};
    sorted.forEach(item => {
      d[item.id] = {
        perCheckout: item.usagePerCheckout != null ? String(item.usagePerCheckout) : '',
        perStayover: item.usagePerStayover != null ? String(item.usagePerStayover) : '',
        unitCost: item.unitCost != null ? String(item.unitCost) : '',
      };
    });
    return d;
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      let changed = 0;
      await Promise.all(sorted.map(item => {
        const d = draft[item.id];
        const perCheckout = d.perCheckout.trim() === '' ? undefined : parseFloat(d.perCheckout);
        const perStayover = d.perStayover.trim() === '' ? undefined : parseFloat(d.perStayover);
        const unitCost = d.unitCost.trim() === '' ? undefined : parseFloat(d.unitCost);

        const isChanged =
          (perCheckout ?? null) !== (item.usagePerCheckout ?? null) ||
          (perStayover ?? null) !== (item.usagePerStayover ?? null) ||
          (unitCost ?? null) !== (item.unitCost ?? null);

        if (!isChanged) return Promise.resolve();
        changed++;
        return updateInventoryItem(uid, pid, item.id, {
          usagePerCheckout: perCheckout,
          usagePerStayover: perStayover,
          unitCost,
        });
      }));
      onSaved(changed);
    } finally {
      setSaving(false);
    }
  };

  const cellStyle: React.CSSProperties = {
    width: '100%', padding: '6px 8px', borderRadius: '8px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'JetBrains Mono', monospace", fontSize: '13px',
    textAlign: 'center', outline: 'none',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(27,28,25,0.5)',
      backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '24px', width: '100%', maxWidth: '720px',
        maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Configurar Tasas de Uso' : 'Configure Usage Rates'}
              </h2>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', margin: '4px 0 0' }}>
                {lang === 'es'
                  ? 'Cuántas unidades usa cada artículo por habitación. Activa el cálculo automático de stock estimado.'
                  : 'How many units each item uses per room. Powers automatic estimated-stock calculation.'}
              </p>
            </div>
            <button
              onClick={onClose}
              style={{
                background: '#eae8e3', border: 'none', cursor: 'pointer',
                padding: '8px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <span style={{ fontSize: '16px', color: '#454652', lineHeight: 1 }}>✕</span>
            </button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px',
            gap: '8px', padding: '10px 24px', background: '#f5f3ee',
            borderBottom: '1px solid rgba(197,197,212,0.2)',
            fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: '0.06em', color: '#757684',
            position: 'sticky', top: 0, zIndex: 1,
          }}>
            <span>{lang === 'es' ? 'Artículo' : 'Item'}</span>
            <span style={{ textAlign: 'center' }}>{lang === 'es' ? 'Por C/O' : 'Per C/O'}</span>
            <span style={{ textAlign: 'center' }}>{lang === 'es' ? 'Por Stayover' : 'Per Stayover'}</span>
            <span style={{ textAlign: 'center' }}>$ / unit</span>
          </div>

          {sorted.map(item => {
            const d = draft[item.id];
            return (
              <div key={item.id} style={{
                display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px',
                gap: '8px', padding: '10px 24px', alignItems: 'center',
                borderBottom: '1px solid rgba(197,197,212,0.2)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: '13px', color: '#1b1c19', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </div>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684' }}>
                    {item.unit}
                  </div>
                </div>
                <input
                  type="number" step="0.01" min="0" placeholder="—"
                  value={d.perCheckout}
                  onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], perCheckout: e.target.value } }))}
                  style={cellStyle}
                />
                <input
                  type="number" step="0.01" min="0" placeholder="—"
                  value={d.perStayover}
                  onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], perStayover: e.target.value } }))}
                  style={cellStyle}
                />
                <input
                  type="number" step="0.01" min="0" placeholder="—"
                  value={d.unitCost}
                  onChange={e => setDraft(prev => ({ ...prev, [item.id]: { ...prev[item.id], unitCost: e.target.value } }))}
                  style={cellStyle}
                />
              </div>
            );
          })}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(197,197,212,0.2)' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              width: '100%', padding: '14px', borderRadius: '9999px',
              background: '#364262', color: '#fff', border: 'none',
              fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            <Check size={18} />
            {saving ? (lang === 'es' ? 'Guardando...' : 'Saving...') : (lang === 'es' ? 'Guardar Tasas' : 'Save Rates')}
          </button>
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
  const [target, setTarget] = useState('100');
  const [reorderAt, setReorderAt] = useState('30');
  const [unitCost, setUnitCost] = useState('');
  const [perCheckout, setPerCheckout] = useState('');
  const [perStayover, setPerStayover] = useState('');
  const [vendor, setVendor] = useState('');
  const [leadDays, setLeadDays] = useState('');
  const [packSize, setPackSize] = useState('');
  const [caseUnit, setCaseUnit] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openInfo, setOpenInfo] = useState<string | null>(null);

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
        reorderAt: parseInt(reorderAt) || 0,
        unit: 'units',
        unitCost: unitCost.trim() === '' ? undefined : parseFloat(unitCost),
        usagePerCheckout: perCheckout.trim() === '' ? undefined : parseFloat(perCheckout),
        usagePerStayover: perStayover.trim() === '' ? undefined : parseFloat(perStayover),
        vendorName: vendor.trim() || undefined,
        reorderLeadDays: leadDays.trim() === '' ? undefined : parseInt(leadDays),
        packSize: packSize.trim() === '' ? undefined : Math.max(1, parseInt(packSize) || 0),
        caseUnit: caseUnit.trim() || undefined,
      });
      onAdded();
      onClose();
      setName(''); setStock('0'); setTarget('100'); setReorderAt('30');
      setUnitCost(''); setPerCheckout(''); setPerStayover(''); setVendor(''); setLeadDays('');
      setPackSize(''); setCaseUnit('');
      setShowAdvanced(false);
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
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto',
        background: '#fbf9f4', borderRadius: '24px', padding: '24px',
        display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
            {lang === 'es' ? 'Agregar Artículo' : 'Add Item'}
          </h2>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '16px', color: '#454652', lineHeight: 1 }}>✕</span>
          </button>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Nombre del Artículo *' : 'Item Name *'}
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={lang === 'es' ? 'p.ej. Toallas de Baño' : 'e.g. Bath Towels'} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Categoría' : 'Category'}
          </label>
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
                {c === 'housekeeping' ? (lang === 'es' ? 'Limpieza' : 'Housekeeping') : c === 'maintenance' ? (lang === 'es' ? 'Mantenimiento' : 'Maintenance') : (lang === 'es' ? 'Desayuno/A&B' : 'Breakfast/F&B')}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <FieldWithInfo
            label={lang === 'es' ? 'En Stock' : 'In Stock'}
            tooltip={lang === 'es' ? 'Cuántos tiene actualmente.' : 'How many of this item you currently have on hand.'}
            isOpen={openInfo === 'stock'}
            onToggle={() => setOpenInfo(openInfo === 'stock' ? null : 'stock')}
          >
            <input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </FieldWithInfo>
          <FieldWithInfo
            label={lang === 'es' ? 'Meta' : 'Target'}
            tooltip={lang === 'es' ? 'Su nivel ideal de stock.' : 'Your ideal stock level — the amount you want to keep fully stocked.'}
            isOpen={openInfo === 'target'}
            onToggle={() => setOpenInfo(openInfo === 'target' ? null : 'target')}
          >
            <input type="number" min="0" value={target} onChange={e => setTarget(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </FieldWithInfo>
          <FieldWithInfo
            label={lang === 'es' ? 'Reordenar A' : 'Reorder At'}
            tooltip={lang === 'es' ? 'Cuando el stock baja a este número, recibirá una alerta.' : "When stock drops to this number, you'll get a notification to reorder."}
            isOpen={openInfo === 'reorder'}
            onToggle={() => setOpenInfo(openInfo === 'reorder' ? null : 'reorder')}
          >
            <input type="number" min="0" value={reorderAt} onChange={e => setReorderAt(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </FieldWithInfo>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(s => !s)}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#006565', fontFamily: "'Inter', sans-serif",
            fontSize: '12px', fontWeight: 600, padding: '4px 0', textAlign: 'left',
          }}
        >
          {showAdvanced ? '▼' : '▶'} {lang === 'es' ? 'Opciones avanzadas' : 'Advanced options'}
        </button>

        {showAdvanced && (
          <AdvancedFields
            lang={lang}
            unitCost={unitCost} setUnitCost={setUnitCost}
            perCheckout={perCheckout} setPerCheckout={setPerCheckout}
            perStayover={perStayover} setPerStayover={setPerStayover}
            vendor={vendor} setVendor={setVendor}
            leadDays={leadDays} setLeadDays={setLeadDays}
            packSize={packSize} setPackSize={setPackSize}
            caseUnit={caseUnit} setCaseUnit={setCaseUnit}
            openInfo={openInfo} setOpenInfo={setOpenInfo}
          />
        )}

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
          {saving ? (lang === 'es' ? 'Guardando...' : 'Saving...') : (lang === 'es' ? 'Agregar Artículo' : 'Add Item')}
        </button>
      </div>
    </div>
  );
}

// ─── Edit Item Modal ─────────────────────────────────────────────────────────

function EditItemModal({ item, uid, pid, lang, onClose, onSaved, onDeleted, onDiscard, onReconcile }: {
  item: InventoryItem;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  onDiscard: () => void;
  onReconcile: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState<InventoryCategory>(item.category);
  const [stock, setStock] = useState(String(item.currentStock));
  const [target, setTarget] = useState(String(item.parLevel));
  const [reorderAt, setReorderAt] = useState(String(item.reorderAt ?? ''));
  const [unitCost, setUnitCost] = useState(item.unitCost != null ? String(item.unitCost) : '');
  const [perCheckout, setPerCheckout] = useState(item.usagePerCheckout != null ? String(item.usagePerCheckout) : '');
  const [perStayover, setPerStayover] = useState(item.usagePerStayover != null ? String(item.usagePerStayover) : '');
  const [vendor, setVendor] = useState(item.vendorName ?? '');
  const [leadDays, setLeadDays] = useState(item.reorderLeadDays != null ? String(item.reorderLeadDays) : '');
  const [packSize, setPackSize] = useState(item.packSize != null ? String(item.packSize) : '');
  const [caseUnit, setCaseUnit] = useState(item.caseUnit ?? '');
  const [showAdvanced, setShowAdvanced] = useState(
    item.unitCost != null || item.usagePerCheckout != null || item.usagePerStayover != null ||
    !!item.vendorName || item.reorderLeadDays != null || item.packSize != null
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openInfo, setOpenInfo] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await updateInventoryItem(uid, pid, item.id, {
        name: name.trim(),
        category,
        currentStock: parseInt(stock) || 0,
        parLevel: parseInt(target) || 0,
        reorderAt: reorderAt.trim() === '' ? undefined : parseInt(reorderAt) || 0,
        unitCost: unitCost.trim() === '' ? undefined : parseFloat(unitCost),
        usagePerCheckout: perCheckout.trim() === '' ? undefined : parseFloat(perCheckout),
        usagePerStayover: perStayover.trim() === '' ? undefined : parseFloat(perStayover),
        vendorName: vendor.trim() || undefined,
        reorderLeadDays: leadDays.trim() === '' ? undefined : parseInt(leadDays),
        packSize: packSize.trim() === '' ? undefined : Math.max(1, parseInt(packSize) || 0),
        caseUnit: caseUnit.trim() || undefined,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    if (!confirm(lang === 'es' ? `¿Eliminar "${item.name}"? Esto no se puede deshacer.` : `Delete "${item.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteInventoryItem(uid, pid, item.id);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };

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
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto',
        background: '#fbf9f4', borderRadius: '24px', padding: '24px',
        display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
            {lang === 'es' ? 'Editar Artículo' : 'Edit Item'}
          </h2>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '16px', color: '#454652', lineHeight: 1 }}>✕</span>
          </button>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Nombre del Artículo *' : 'Item Name *'}
          </label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Categoría' : 'Category'}
          </label>
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
                {c === 'housekeeping' ? (lang === 'es' ? 'Limpieza' : 'Housekeeping') : c === 'maintenance' ? (lang === 'es' ? 'Mantenimiento' : 'Maintenance') : (lang === 'es' ? 'Desayuno/A&B' : 'Breakfast/F&B')}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
          <FieldWithInfo
            label={lang === 'es' ? 'En Stock' : 'In Stock'}
            tooltip={lang === 'es' ? 'Cuántos tiene actualmente.' : 'How many of this item you currently have on hand.'}
            isOpen={openInfo === 'stock'}
            onToggle={() => setOpenInfo(openInfo === 'stock' ? null : 'stock')}
          >
            <input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </FieldWithInfo>
          <FieldWithInfo
            label={lang === 'es' ? 'Meta' : 'Target'}
            tooltip={lang === 'es' ? 'Su nivel ideal de stock.' : 'Your ideal stock level.'}
            isOpen={openInfo === 'target'}
            onToggle={() => setOpenInfo(openInfo === 'target' ? null : 'target')}
          >
            <input type="number" min="0" value={target} onChange={e => setTarget(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </FieldWithInfo>
          <FieldWithInfo
            label={lang === 'es' ? 'Reordenar A' : 'Reorder At'}
            tooltip={lang === 'es' ? 'Umbral de stock para alertas.' : 'Stock threshold that triggers a reorder notification.'}
            isOpen={openInfo === 'reorder'}
            onToggle={() => setOpenInfo(openInfo === 'reorder' ? null : 'reorder')}
          >
            <input type="number" min="0" value={reorderAt} onChange={e => setReorderAt(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </FieldWithInfo>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(s => !s)}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#006565', fontFamily: "'Inter', sans-serif",
            fontSize: '12px', fontWeight: 600, padding: '4px 0', textAlign: 'left',
          }}
        >
          {showAdvanced ? '▼' : '▶'} {lang === 'es' ? 'Opciones avanzadas' : 'Advanced options'}
        </button>

        {showAdvanced && (
          <AdvancedFields
            lang={lang}
            unitCost={unitCost} setUnitCost={setUnitCost}
            perCheckout={perCheckout} setPerCheckout={setPerCheckout}
            perStayover={perStayover} setPerStayover={setPerStayover}
            vendor={vendor} setVendor={setVendor}
            leadDays={leadDays} setLeadDays={setLeadDays}
            packSize={packSize} setPackSize={setPackSize}
            caseUnit={caseUnit} setCaseUnit={setCaseUnit}
            openInfo={openInfo} setOpenInfo={setOpenInfo}
          />
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onDiscard}
            style={{
              flex: 1, padding: '10px 14px', border: '1px solid #c5c5d4',
              borderRadius: '9999px', cursor: 'pointer', background: '#fff',
              color: '#454652', fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            <TrendingDown size={13} />
            {lang === 'es' ? 'Marcar Descartado' : 'Mark Discarded'}
          </button>
          <button
            type="button"
            onClick={onReconcile}
            style={{
              flex: 1, padding: '10px 14px', border: '1px solid #c5c5d4',
              borderRadius: '9999px', cursor: 'pointer', background: '#fff',
              color: '#454652', fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            <ClipboardCheck size={13} />
            {lang === 'es' ? 'Reconciliar' : 'Reconcile'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
          <button
            onClick={handleDelete}
            disabled={deleting || saving}
            style={{
              padding: '14px 20px', border: '1px solid #ffdad6',
              borderRadius: '9999px', cursor: deleting || saving ? 'not-allowed' : 'pointer',
              background: '#fff', color: '#ba1a1a',
              fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
              transition: 'all 150ms', minHeight: '52px',
            }}
          >
            {deleting ? (lang === 'es' ? 'Eliminando...' : 'Deleting...') : (lang === 'es' ? 'Eliminar' : 'Delete')}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving || deleting}
            style={{
              flex: 1, padding: '16px', border: 'none',
              borderRadius: '9999px', cursor: name.trim() && !saving ? 'pointer' : 'not-allowed',
              background: name.trim() && !saving ? '#364262' : '#eae8e3',
              color: name.trim() && !saving ? '#fff' : '#757684',
              fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600,
              transition: 'all 150ms', minHeight: '52px',
            }}
          >
            {saving ? (lang === 'es' ? 'Guardando...' : 'Saving...') : (lang === 'es' ? 'Guardar Cambios' : 'Save Changes')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared Advanced Fields block ────────────────────────────────────────────

function AdvancedFields({
  lang, unitCost, setUnitCost, perCheckout, setPerCheckout, perStayover, setPerStayover,
  vendor, setVendor, leadDays, setLeadDays, packSize, setPackSize, caseUnit, setCaseUnit, openInfo, setOpenInfo,
}: {
  lang: 'en' | 'es';
  unitCost: string; setUnitCost: (v: string) => void;
  perCheckout: string; setPerCheckout: (v: string) => void;
  perStayover: string; setPerStayover: (v: string) => void;
  vendor: string; setVendor: (v: string) => void;
  leadDays: string; setLeadDays: (v: string) => void;
  packSize: string; setPackSize: (v: string) => void;
  caseUnit: string; setCaseUnit: (v: string) => void;
  openInfo: string | null; setOpenInfo: (v: string | null) => void;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '16px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#1b1c19',
    outline: 'none',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', background: 'rgba(0,101,101,0.04)', borderRadius: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#006565', fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 700 }}>
        <DollarSign size={13} />
        {lang === 'es' ? 'Inteligencia de inventario' : 'Inventory Intelligence'}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <FieldWithInfo
          label={lang === 'es' ? 'Por Checkout' : 'Per Checkout'}
          tooltip={lang === 'es' ? '¿Cuántos usa una habitación de checkout? Activa el cálculo automático de stock.' : 'How many of this item does a typical checkout room use? Powers automatic stock estimates.'}
          isOpen={openInfo === 'pco'}
          onToggle={() => setOpenInfo(openInfo === 'pco' ? null : 'pco')}
        >
          <input type="number" step="0.01" min="0" value={perCheckout} onChange={e => setPerCheckout(e.target.value)} placeholder="—" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </FieldWithInfo>
        <FieldWithInfo
          label={lang === 'es' ? 'Por Stayover' : 'Per Stayover'}
          tooltip={lang === 'es' ? '¿Cuántos usa una habitación stayover?' : 'How many of this item does a typical stayover room use?'}
          isOpen={openInfo === 'pso'}
          onToggle={() => setOpenInfo(openInfo === 'pso' ? null : 'pso')}
        >
          <input type="number" step="0.01" min="0" value={perStayover} onChange={e => setPerStayover(e.target.value)} placeholder="—" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </FieldWithInfo>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
        <FieldWithInfo
          label={lang === 'es' ? 'Costo $' : 'Unit Cost $'}
          tooltip={lang === 'es' ? 'Dólares por unidad. Activa cálculos de valor total y pérdida.' : 'Dollars per unit. Powers Total Inventory Value and dollar variance.'}
          isOpen={openInfo === 'cost'}
          onToggle={() => setOpenInfo(openInfo === 'cost' ? null : 'cost')}
        >
          <input type="number" step="0.01" min="0" value={unitCost} onChange={e => setUnitCost(e.target.value)} placeholder="—" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </FieldWithInfo>
        <FieldWithInfo
          label={lang === 'es' ? 'Días Pedido' : 'Lead Days'}
          tooltip={lang === 'es' ? 'Días entre ordenar y recibir.' : 'Days between placing an order and receiving it.'}
          isOpen={openInfo === 'lead'}
          onToggle={() => setOpenInfo(openInfo === 'lead' ? null : 'lead')}
        >
          <input type="number" min="0" value={leadDays} onChange={e => setLeadDays(e.target.value)} placeholder="—" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </FieldWithInfo>
        <FieldWithInfo
          label={lang === 'es' ? 'Proveedor' : 'Vendor'}
          tooltip={lang === 'es' ? 'Suministrador.' : 'Supplier name. Pre-fills the order log.'}
          isOpen={openInfo === 'vendor'}
          onToggle={() => setOpenInfo(openInfo === 'vendor' ? null : 'vendor')}
        >
          <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder="—" style={inputStyle} />
        </FieldWithInfo>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <FieldWithInfo
          label={lang === 'es' ? 'Tamaño de Caja' : 'Pack Size'}
          tooltip={lang === 'es' ? 'Unidades por caja. Si recibe "3 cajas de 36", deja que el sistema haga la matemática.' : 'Units per case/box. When set, receiving "3 cases" auto-resolves to N × pack-size units.'}
          isOpen={openInfo === 'pack'}
          onToggle={() => setOpenInfo(openInfo === 'pack' ? null : 'pack')}
        >
          <input type="number" min="1" value={packSize} onChange={e => setPackSize(e.target.value)} placeholder="—" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </FieldWithInfo>
        <FieldWithInfo
          label={lang === 'es' ? 'Etiqueta de Caja' : 'Pack Label'}
          tooltip={lang === 'es' ? 'Cómo llamar la caja en la UI ("caja", "docena").' : 'Display label for the pack ("case", "box", "dozen"). Cosmetic only — math comes from Pack Size.'}
          isOpen={openInfo === 'caseunit'}
          onToggle={() => setOpenInfo(openInfo === 'caseunit' ? null : 'caseunit')}
        >
          <input value={caseUnit} onChange={e => setCaseUnit(e.target.value)} placeholder={lang === 'es' ? 'caja' : 'case'} style={inputStyle} />
        </FieldWithInfo>
      </div>
    </div>
  );
}

// ─── Field With Info Tooltip ──────────────────────────────────────────────────

function FieldWithInfo({ label, tooltip, isOpen, onToggle, children }: {
  label: string;
  tooltip: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px' }}>
        <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652' }}>
          {label}
        </label>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`About ${label}`}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: isOpen ? '#006565' : '#757684',
          }}
        >
          <Info size={13} />
        </button>
      </div>
      {children}
      {isOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 10,
          background: '#1b1c19', color: '#fbf9f4',
          borderRadius: '10px', padding: '10px 12px',
          fontFamily: "'Inter', sans-serif", fontSize: '11px', lineHeight: 1.4,
          boxShadow: '0 8px 20px rgba(0,0,0,0.2)',
        }}>
          {tooltip}
        </div>
      )}
    </div>
  );
}

// ─── Discard Modal ──────────────────────────────────────────────────────────
//
// Logs a discard event (stained linen, damaged, lost, theft). Decrements
// current_stock too — the discard is removing real inventory from the floor.

function DiscardModal({ item, uid, pid, lang, onClose, onSaved }: {
  item: InventoryItem;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onSaved: (qty: number) => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState<InventoryDiscardReason>('stained');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '16px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#1b1c19',
    outline: 'none',
  };

  const reasons: { value: InventoryDiscardReason; en: string; es: string }[] = [
    { value: 'stained', en: 'Stained', es: 'Manchado' },
    { value: 'damaged', en: 'Damaged', es: 'Dañado' },
    { value: 'lost', en: 'Lost', es: 'Perdido' },
    { value: 'theft', en: 'Theft', es: 'Robo' },
    { value: 'other', en: 'Other', es: 'Otro' },
  ];

  const qty = parseInt(quantity) || 0;
  const costImpact = item.unitCost != null ? qty * item.unitCost : null;
  const canSave = qty > 0 && qty <= item.currentStock && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await addInventoryDiscard(uid, pid, {
        propertyId: pid,
        itemId: item.id,
        itemName: item.name,
        quantity: qty,
        reason,
        unitCost: item.unitCost ?? undefined,
        costValue: costImpact ?? undefined,
        discardedAt: new Date(),
        notes: notes.trim() || undefined,
      });
      // Decrement current_stock so the inventory reflects reality. Don't bump
      // last_counted_at — discards aren't counts.
      await updateInventoryItem(uid, pid, item.id, {
        currentStock: Math.max(0, item.currentStock - qty),
        lastCountedAt: item.lastCountedAt ?? undefined,
      });
      onSaved(qty);
    } catch (err) {
      console.error('[discard] save failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: '460px', background: '#fbf9f4', borderRadius: '24px',
        padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px', color: '#1b1c19', margin: 0 }}>
              {lang === 'es' ? 'Marcar como Descartado' : 'Mark as Discarded'}
            </h2>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '4px 0 0' }}>
              <strong>{item.name}</strong> — {item.currentStock} {item.unit} {lang === 'es' ? 'en stock' : 'on hand'}
            </p>
          </div>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%' }}>
            <XIcon size={14} color="#454652" />
          </button>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Cantidad' : 'Quantity'}
          </label>
          <input type="number" min="0" max={item.currentStock} value={quantity} onChange={e => setQuantity(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          {qty > item.currentStock && (
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#ba1a1a', margin: '4px 0 0' }}>
              {lang === 'es' ? `Solo hay ${item.currentStock} en stock.` : `Only ${item.currentStock} on hand.`}
            </p>
          )}
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Motivo' : 'Reason'}
          </label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {reasons.map(r => (
              <button
                key={r.value}
                type="button"
                onClick={() => setReason(r.value)}
                style={{
                  padding: '8px 14px', borderRadius: '9999px', border: 'none',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  background: reason === r.value ? '#006565' : '#f0eee9',
                  color: reason === r.value ? '#fff' : '#454652',
                }}
              >
                {lang === 'es' ? r.es : r.en}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Notas' : 'Notes'}
          </label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} placeholder={lang === 'es' ? 'Opcional' : 'Optional'} />
        </div>

        {costImpact != null && qty > 0 && (
          <div style={{
            padding: '12px 14px', background: 'rgba(186,26,26,0.06)', borderRadius: '12px',
            fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#ba1a1a',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <DollarSign size={14} />
            {lang === 'es' ? `Pérdida estimada: $${costImpact.toFixed(2)}` : `Loss value: $${costImpact.toFixed(2)}`}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{
            padding: '14px', border: 'none', borderRadius: '9999px',
            background: canSave ? '#364262' : '#eae8e3',
            color: canSave ? '#fff' : '#757684',
            fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
            cursor: canSave ? 'pointer' : 'not-allowed', minHeight: '50px',
          }}
        >
          {saving
            ? (lang === 'es' ? 'Guardando...' : 'Saving...')
            : (lang === 'es' ? 'Registrar Descarte' : 'Log Discard')}
        </button>
      </div>
    </div>
  );
}

// ─── Reconcile Modal ────────────────────────────────────────────────────────
//
// Single-item physical-recount workflow. Compares against AI estimate, deducts
// known discards since the last reconciliation, and surfaces unaccounted
// shrinkage in dollars. Updates current_stock to the physical count.

function ReconcileModal({ item, uid, pid, lang, estimatedStockNow, onClose, onSaved }: {
  item: InventoryItem;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  estimatedStockNow: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [physical, setPhysical] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastRecAt, setLastRecAt] = useState<Date | null>(null);
  const [discardsSinceLast, setDiscardsSinceLast] = useState(0);

  // Load: last reconciliation date + discards since then.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const map = await lastReconciliationByItem(uid, pid);
        const last = map.get(item.id);
        if (cancelled) return;
        const since = last?.reconciledAt ?? null;
        setLastRecAt(since);
        const sinceDate = since ?? new Date(0);
        const dQty = await sumDiscardsSince(uid, pid, item.id, sinceDate);
        if (cancelled) return;
        setDiscardsSinceLast(dQty);
      } catch (err) {
        console.error('[reconcile] failed to load history', err);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, pid, item.id]);

  const physicalNum = parseInt(physical);
  const validPhysical = Number.isFinite(physicalNum) && physicalNum >= 0;
  const variance = validPhysical ? physicalNum - (estimatedStockNow - discardsSinceLast) : 0;
  const varianceCost = item.unitCost != null && validPhysical ? variance * item.unitCost : null;
  const canSave = validPhysical && !saving;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '16px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#1b1c19',
    outline: 'none',
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await addInventoryReconciliation(uid, pid, {
        propertyId: pid,
        itemId: item.id,
        itemName: item.name,
        reconciledAt: new Date(),
        physicalCount: physicalNum,
        systemEstimate: Math.round(estimatedStockNow),
        discardsSinceLast,
        unaccountedVariance: variance,
        unaccountedVarianceValue: varianceCost ?? undefined,
        unitCost: item.unitCost ?? undefined,
        notes: notes.trim() || undefined,
      });
      // Sync current_stock to the physical count — the user just told us the
      // truth, so the AI estimate gets reset.
      await updateInventoryItem(uid, pid, item.id, {
        currentStock: physicalNum,
        lastCountedAt: new Date(),
      });
      onSaved();
    } catch (err) {
      console.error('[reconcile] save failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: '480px', background: '#fbf9f4', borderRadius: '24px',
        padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px', color: '#1b1c19', margin: 0 }}>
              {lang === 'es' ? 'Reconciliar Conteo' : 'Reconcile Count'}
            </h2>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '4px 0 0' }}>
              <strong>{item.name}</strong> · {lang === 'es' ? 'conteo físico vs estimación del sistema' : 'physical count vs system estimate'}
            </p>
          </div>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%' }}>
            <XIcon size={14} color="#454652" />
          </button>
        </div>

        <div style={{
          padding: '12px 14px', background: 'rgba(0,101,101,0.06)', borderRadius: '12px',
          fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#454652',
          display: 'flex', flexDirection: 'column', gap: '4px',
        }}>
          <div>{lang === 'es' ? 'Estimación del sistema:' : 'System estimate:'} <strong style={{ color: '#1b1c19' }}>{Math.round(estimatedStockNow)} {item.unit}</strong></div>
          <div>{lang === 'es' ? 'Descartes registrados desde la última reconciliación:' : 'Discards since last reconciliation:'} <strong style={{ color: '#1b1c19' }}>{discardsSinceLast}</strong></div>
          <div style={{ fontSize: '11px', color: '#757684' }}>
            {lastRecAt
              ? (lang === 'es' ? `Última reconciliación: ${lastRecAt.toLocaleDateString()}` : `Last reconciled: ${lastRecAt.toLocaleDateString()}`)
              : (lang === 'es' ? 'Primera reconciliación.' : 'First reconciliation.')}
          </div>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Conteo físico actual' : 'Current physical count'}
          </label>
          <input type="number" min="0" value={physical} onChange={e => setPhysical(e.target.value)} placeholder={lang === 'es' ? 'Cuente y escriba aquí' : 'Count and enter here'} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </div>

        {validPhysical && (
          <div style={{
            padding: '12px 14px',
            background: variance < 0 ? 'rgba(186,26,26,0.06)' : 'rgba(0,101,101,0.06)',
            borderRadius: '12px', fontFamily: "'Inter', sans-serif", fontSize: '13px',
            color: variance < 0 ? '#ba1a1a' : '#006565',
          }}>
            {variance === 0 ? (
              lang === 'es' ? '✓ Sin variación inexplicada.' : '✓ No unaccounted variance.'
            ) : (
              <>
                <div style={{ fontWeight: 700 }}>
                  {variance > 0
                    ? (lang === 'es' ? `Sobrante inexplicado: +${variance} ${item.unit}` : `Unaccounted surplus: +${variance} ${item.unit}`)
                    : (lang === 'es' ? `Pérdida inexplicada: ${variance} ${item.unit}` : `Unaccounted loss: ${variance} ${item.unit}`)}
                </div>
                {varianceCost != null && (
                  <div style={{ fontSize: '12px', marginTop: '2px' }}>
                    {lang === 'es' ? `Impacto: $${Math.abs(varianceCost).toFixed(2)}` : `Impact: $${Math.abs(varianceCost).toFixed(2)}`}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Notas' : 'Notes'}
          </label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} placeholder={lang === 'es' ? 'Opcional' : 'Optional'} />
        </div>

        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{
            padding: '14px', border: 'none', borderRadius: '9999px',
            background: canSave ? '#364262' : '#eae8e3',
            color: canSave ? '#fff' : '#757684',
            fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
            cursor: canSave ? 'pointer' : 'not-allowed', minHeight: '50px',
          }}
        >
          {saving
            ? (lang === 'es' ? 'Guardando...' : 'Saving...')
            : (lang === 'es' ? 'Guardar Reconciliación' : 'Save Reconciliation')}
        </button>
      </div>
    </div>
  );
}

// ─── Budget Settings Modal ──────────────────────────────────────────────────
//
// Per-property × per-category × monthly budget. The Smart Reorder List shows
// remaining budget; the Accounting page shows budget vs actual.

function BudgetSettingsModal({ uid, pid, lang, onClose, onSaved }: {
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onSaved: () => void;
}) {
  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
  }, []);
  const [housekeeping, setHousekeeping] = useState('');
  const [maintenance, setMaintenance] = useState('');
  const [breakfast, setBreakfast] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const budgets = await listInventoryBudgets(uid, pid, monthStart);
        for (const b of budgets) {
          const dollars = (b.budgetCents / 100).toFixed(2);
          if (b.category === 'housekeeping') setHousekeeping(dollars);
          else if (b.category === 'maintenance') setMaintenance(dollars);
          else if (b.category === 'breakfast') setBreakfast(dollars);
        }
      } catch (err) {
        console.error('[budgets] load failed', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [uid, pid, monthStart]);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '16px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#1b1c19',
    outline: 'none',
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const writes: Array<{ cat: InventoryCategory; cents: number }> = [
        { cat: 'housekeeping', cents: Math.max(0, Math.round(parseFloat(housekeeping || '0') * 100)) },
        { cat: 'maintenance', cents: Math.max(0, Math.round(parseFloat(maintenance || '0') * 100)) },
        { cat: 'breakfast', cents: Math.max(0, Math.round(parseFloat(breakfast || '0') * 100)) },
      ];
      for (const w of writes) {
        await upsertInventoryBudget(uid, pid, {
          propertyId: pid,
          category: w.cat,
          monthStart,
          budgetCents: w.cents,
        });
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const monthLabel = monthStart.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'long', year: 'numeric' });

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: '460px', background: '#fbf9f4', borderRadius: '24px',
        padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px', color: '#1b1c19', margin: 0 }}>
              {lang === 'es' ? 'Presupuestos Mensuales' : 'Monthly Budgets'}
            </h2>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#757684', margin: '4px 0 0', textTransform: 'capitalize' }}>
              {monthLabel}
            </p>
          </div>
          <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '8px', borderRadius: '50%' }}>
            <XIcon size={14} color="#454652" />
          </button>
        </div>

        {loading ? (
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>{lang === 'es' ? 'Cargando...' : 'Loading...'}</p>
        ) : (
          <>
            <BudgetField label={lang === 'es' ? 'Limpieza' : 'Housekeeping'} value={housekeeping} setValue={setHousekeeping} inputStyle={inputStyle} />
            <BudgetField label={lang === 'es' ? 'Mantenimiento' : 'Maintenance'} value={maintenance} setValue={setMaintenance} inputStyle={inputStyle} />
            <BudgetField label={lang === 'es' ? 'Desayuno / A&B' : 'Breakfast / F&B'} value={breakfast} setValue={setBreakfast} inputStyle={inputStyle} />

            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '14px', border: 'none', borderRadius: '9999px',
                background: '#364262', color: '#fff',
                fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', minHeight: '50px',
              }}
            >
              {saving
                ? (lang === 'es' ? 'Guardando...' : 'Saving...')
                : (lang === 'es' ? 'Guardar Presupuestos' : 'Save Budgets')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BudgetField({ label, value, setValue, inputStyle }: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  inputStyle: React.CSSProperties;
}) {
  return (
    <div>
      <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: '#757684', fontFamily: "'JetBrains Mono', monospace", fontSize: '14px' }}>$</span>
        <input
          type="number" step="0.01" min="0" value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="0.00"
          style={{ ...inputStyle, paddingLeft: '28px', fontFamily: "'JetBrains Mono', monospace" }}
        />
      </div>
    </div>
  );
}
