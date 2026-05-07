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
} from '@/lib/db';
import { fetchOccupancyBundle, computeOccupancyForItem, calculateEstimatedStock, type OccupancyBundle } from '@/lib/inventory-estimate';
import {
  fetchDailyAverages, predictReorders, predictionByItem,
  type DailyAverages, type PredictionResult,
} from '@/lib/inventory-predictions';
import { supabase } from '@/lib/supabase';
import type { InventoryItem, InventoryCategory, InventoryCount, InventoryOrder } from '@/types';
import {
  Plus, Package, ClipboardCheck, AlertTriangle, Check, Info, Settings,
  TrendingDown, DollarSign, Truck, Clock, ChevronDown, ChevronRight,
  ShoppingCart, FileText, BarChart3, Printer, Copy, Camera, Upload, ScanLine,
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

function formatCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

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
  const [showReport, setShowReport] = useState(false);
  const [showScanInvoice, setShowScanInvoice] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationData | null>(null);
  const [orderPrompt, setOrderPrompt] = useState<OrderPromptData | null>(null);

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

  // ─── Count Mode → Reconciliation pipeline ──────────────────────────────
  const handleCountDone = useCallback((updatedCounts: Record<string, number>) => {
    setCounting(false);

    // Build reconciliation rows: one per item that changed.
    const rows: ReconciliationRow[] = [];
    const orderRows: OrderPromptRow[] = [];

    items.forEach(item => {
      const counted = updatedCounts[item.id];
      if (counted == null) return;
      const previous = item.currentStock;
      const est = estimates.get(item.id);
      const hasEst = est?.hasEstimate ?? false;
      const estimated = hasEst ? est!.estimated : null;
      const variance = estimated != null ? counted - estimated : null;
      const varianceValue = variance != null && item.unitCost != null ? variance * item.unitCost : null;

      rows.push({
        item,
        counted,
        previous,
        estimated,
        variance,
        varianceValue,
      });

      // If stock went up, candidate for order logging.
      // Snapshot previous + new explicitly so the modal doesn't have to
      // re-derive them from a captured `item` whose currentStock is the
      // pre-count value.
      if (counted > previous) {
        orderRows.push({
          item,
          delta: counted - previous,
          previousStock: previous,
          newStock: counted,
        });
      }
    });

    // Save count rows to the audit log (best-effort; non-blocking)
    if (user && activePropertyId) {
      const countLogRows = rows.map(r => ({
        propertyId: activePropertyId,
        itemId: r.item.id,
        itemName: r.item.name,
        countedStock: r.counted,
        estimatedStock: r.estimated ?? undefined,
        variance: r.variance ?? undefined,
        varianceValue: r.varianceValue ?? undefined,
        unitCost: r.item.unitCost,
        countedAt: new Date(),
        countedBy: user.displayName ?? user.username ?? undefined,
      }));
      addInventoryCountBatch(user.uid, activePropertyId, countLogRows)
        .catch(err => console.error('[inventory] count log failed:', err));
    }

    // Critical SMS alerts: ONLY items that newly transitioned into critical
    // status during this count. An item that was already critical before the
    // count (e.g. zero stock that's still zero, or an item that started below
    // its reorder threshold and is still below) does NOT re-alert. This
    // prevents the SMS-burst bug where every below-par item fired an alert
    // every time the user saved a count.
    //
    // Transition definition: stockStatus(previous) was 'good' OR 'low', AND
    // stockStatus(counted) is 'out'. The 24h dedupe inside the API route is
    // a second line of defense if a transition happens twice in a window.
    const transitionedIds = items
      .filter(item => {
        const counted = updatedCounts[item.id];
        if (counted == null) return false;
        const prevStatus = stockStatus(item.currentStock, item.parLevel, item.reorderAt);
        const newStatus = stockStatus(counted, item.parLevel, item.reorderAt);
        return prevStatus !== 'out' && newStatus === 'out';
      })
      .map(i => i.id);

    if (transitionedIds.length > 0 && activePropertyId) {
      fetch('/api/inventory/check-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, criticalItemIds: transitionedIds }),
      })
        .then(r => r.json())
        .then(data => {
          if (data?.sent > 0) {
            showToast(lang === 'es' ? `Alerta SMS enviada (${data.sent})` : `SMS alert sent (${data.sent})`);
          }
        })
        .catch(err => console.error('[inventory] alert dispatch failed:', err));
    }

    // Always show reconciliation; chain to order prompt + low stock notice from there.
    setReconciliation({ rows, pendingOrders: orderRows });
  }, [items, estimates, user, activePropertyId, lang, showToast]);

  const handleReconciliationClose = useCallback(() => {
    setReconciliation(prev => {
      if (prev?.pendingOrders && prev.pendingOrders.length > 0) {
        setOrderPrompt({ rows: prev.pendingOrders, index: 0 });
      } else {
        showToast(lang === 'es' ? 'Conteo guardado ✓' : 'Inventory count saved ✓');
      }
      return null;
    });
  }, [lang, showToast]);

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
              <button
                onClick={() => setShowReport(true)}
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                <FileText size={13} />
                {lang === 'es' ? 'Reporte' : 'Report'}
              </button>
              <Link
                href="/inventory/analytics"
                style={{
                  background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                  padding: '8px 16px', borderRadius: '9999px',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                  textDecoration: 'none',
                }}
              >
                <BarChart3 size={13} />
                {lang === 'es' ? 'Analíticas' : 'Analytics'}
              </Link>
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
              {properties.length > 1 && (
                <Link
                  href="/inventory/compare"
                  style={{
                    background: 'transparent', color: '#364262', border: '1px solid #c5c5d4',
                    padding: '8px 16px', borderRadius: '9999px',
                    fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                    textDecoration: 'none',
                  }}
                >
                  <Package size={13} />
                  {lang === 'es' ? 'Comparar' : 'Compare'}
                </Link>
              )}
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
        />
      )}

      {/* Ownership report */}
      {showReport && (
        <OwnershipReportModal
          items={items}
          predictions={predictionMap}
          effectiveStockOf={effectiveStock}
          totalInventoryValue={totalInventoryValue}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onClose={() => setShowReport(false)}
          showToast={showToast}
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

      {/* Reconciliation */}
      {reconciliation && (
        <ReconciliationModal
          rows={reconciliation.rows}
          lang={lang}
          onClose={handleReconciliationClose}
        />
      )}

      {/* Order logging */}
      {orderPrompt && (
        <OrderLoggingModal
          rows={orderPrompt.rows}
          index={orderPrompt.index}
          uid={user.uid}
          pid={activePropertyId}
          lang={lang}
          onAdvance={(nextIdx) => {
            if (nextIdx >= orderPrompt.rows.length) {
              setOrderPrompt(null);
              showToast(lang === 'es' ? 'Conteo guardado ✓' : 'Inventory count saved ✓');
            } else {
              setOrderPrompt({ ...orderPrompt, index: nextIdx });
            }
          }}
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

// ─── Reconciliation types ───────────────────────────────────────────────────

interface ReconciliationRow {
  item: InventoryItem;
  counted: number;
  previous: number;
  estimated: number | null;
  variance: number | null;       // counted - estimated
  varianceValue: number | null;  // variance * unit_cost
}

interface ReconciliationData {
  rows: ReconciliationRow[];
  pendingOrders: OrderPromptRow[];
}

interface OrderPromptRow {
  item: InventoryItem;
  delta: number;
  /**
   * Stock BEFORE the count. The captured `item.currentStock` is also the
   * pre-count value (Realtime hasn't refreshed yet at capture time), but
   * we snapshot it explicitly so the modal isn't subtly tied to that
   * race-condition.
   */
  previousStock: number;
  /** Stock AFTER the count (= previousStock + delta). */
  newStock: number;
}

interface OrderPromptData {
  rows: OrderPromptRow[];
  index: number;
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
  const [counts, setCounts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    sorted.forEach(item => { init[item.id] = String(item.currentStock); });
    return init;
  });
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

  const handlePhotoPicked = useCallback(async (img: PickedImage) => {
    setShowPhotoPicker(false);
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const res = await fetch('/api/inventory/photo-count', {
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

      const fresh: Record<string, 'high' | 'medium' | 'low'> = {};
      const updates: Record<string, string> = {};
      const counts: Array<{ item_name: string; estimated_count: number; confidence: 'high' | 'medium' | 'low' }> = json.counts ?? [];
      for (const c of counts) {
        const item = items.find(i => i.name === c.item_name);
        if (!item) continue;
        // Don't overwrite a value we already AI-filled in a previous photo.
        if (aiFilled[item.id]) continue;
        updates[item.id] = String(c.estimated_count);
        fresh[item.id] = c.confidence;
      }
      if (Object.keys(updates).length === 0) {
        setPhotoError(
          lang === 'es'
            ? 'No se identificaron artículos. Pruebe con otra foto.'
            : "No items identified. Try another photo.",
        );
      } else {
        setCounts(prev => ({ ...prev, ...updates }));
        setAiFilled(prev => ({ ...prev, ...fresh }));
      }
    } catch (e) {
      setPhotoError(
        lang === 'es'
          ? 'No se pudo procesar la foto. Continúe con conteo manual.'
          : 'Photo processing failed. Continue with manual count.',
      );
    } finally {
      setPhotoBusy(false);
    }
  }, [pid, items, aiFilled, lang]);

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
            <ImagePickerStage lang={lang} onPicked={handlePhotoPicked} />
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

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 64px 80px 50px',
            gap: '8px', padding: '10px 24px', background: '#f5f3ee',
            borderBottom: '1px solid rgba(197,197,212,0.2)',
            fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: '#757684',
            position: 'sticky', top: 0, zIndex: 1,
          }}>
            <span>{lang === 'es' ? 'Artículo' : 'Item'}</span>
            <span style={{ textAlign: 'right' }}>{lang === 'es' ? 'Est.' : 'Est.'}</span>
            <span style={{ textAlign: 'center' }}>{lang === 'es' ? 'Conteo' : 'Count'}</span>
            <span style={{ textAlign: 'right' }}>{lang === 'es' ? 'Meta' : 'Target'}</span>
          </div>

          {sorted.map((item, idx) => {
            const val = parseInt(counts[item.id] ?? '0') || 0;
            const status = stockStatus(val, item.parLevel, item.reorderAt);
            const changed = val !== item.currentStock;
            const est = estimates.get(item.id);
            return (
              <div
                key={item.id}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 64px 80px 50px',
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
                <div style={{ textAlign: 'right', fontSize: '12px', color: est?.hasEstimate ? '#006565' : '#c5c5d4', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                  {est?.hasEstimate ? Math.round(est.estimated) : '—'}
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

// ─── Reconciliation Modal ────────────────────────────────────────────────────
//
// Shown after a Count Mode save. Lists items where the system estimate
// differed from the user's count by more than 1 unit. Color-coded by
// magnitude. Total dollar variance shown at the top when unit costs are set.

function ReconciliationModal({
  rows, lang, onClose,
}: {
  rows: ReconciliationRow[];
  lang: 'en' | 'es';
  onClose: () => void;
}) {
  // Filter: only show rows with meaningful variance (>1)
  const significant = useMemo(
    () => rows.filter(r => r.variance != null && Math.abs(r.variance) > 1),
    [rows],
  );

  const totalVarianceDollars = useMemo(
    () => significant.reduce((sum, r) => sum + (r.varianceValue ?? 0), 0),
    [significant],
  );

  // Nothing to show → auto-close (hooks must run before any conditional return).
  useEffect(() => {
    if (significant.length === 0) onClose();
  }, [significant.length, onClose]);

  if (significant.length === 0) return null;

  const colorFor = (r: ReconciliationRow) => {
    if (r.variance == null || r.estimated == null || r.estimated === 0) return '#757684';
    const pct = Math.abs(r.variance) / Math.max(1, r.estimated);
    if (pct > 0.25) return '#ba1a1a';
    if (pct > 0.10) return '#c98a14';
    return '#006565';
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fbf9f4', borderRadius: '24px',
        width: '100%', maxWidth: '560px', maxHeight: '85vh', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '20px 24px', background: '#1b1c19',
          color: '#fff', borderRadius: '24px 24px 0 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
            <TrendingDown size={22} />
            <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px' }}>
              {lang === 'es' ? 'Reconciliación' : 'Reconciliation'}
            </div>
          </div>
          <div style={{ fontSize: '13px', opacity: 0.85, fontFamily: "'Inter', sans-serif" }}>
            {lang === 'es'
              ? `${significant.length} artículo(s) con variación. Pérdida no contabilizada: ${formatCurrency(totalVarianceDollars)}`
              : `${significant.length} item${significant.length !== 1 ? 's' : ''} with variance. Unaccounted: ${formatCurrency(totalVarianceDollars)}`}
          </div>
        </div>

        <div style={{ overflow: 'auto', flex: 1 }}>
          {significant.map(r => {
            const color = colorFor(r);
            const variance = r.variance ?? 0;
            return (
              <div key={r.item.id} style={{
                padding: '14px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)',
                display: 'flex', flexDirection: 'column', gap: '4px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: '14px', color: '#1b1c19' }}>
                    {r.item.name}
                  </span>
                  {r.varianceValue != null && (
                    <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '13px', color }}>
                      {variance > 0 ? '+' : ''}{formatCurrency(r.varianceValue)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '14px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: '#757684', paddingLeft: '16px' }}>
                  <span>{lang === 'es' ? 'Estimado' : 'Estimated'}: <strong style={{ color: '#454652' }}>{r.estimated != null ? Math.round(r.estimated) : '—'}</strong></span>
                  <span>{lang === 'es' ? 'Contado' : 'Counted'}: <strong style={{ color: '#454652' }}>{r.counted}</strong></span>
                  <span>{lang === 'es' ? 'Variación' : 'Variance'}: <strong style={{ color }}>{variance > 0 ? '+' : ''}{Math.round(variance)}</strong></span>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(197,197,212,0.2)' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%', padding: '14px', borderRadius: '9999px',
              background: '#364262', color: '#fff', border: 'none',
              fontFamily: "'Inter', sans-serif", fontSize: '15px', fontWeight: 600, cursor: 'pointer',
            }}
          >
            {lang === 'es' ? 'Continuar' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Order Logging Modal ─────────────────────────────────────────────────────
//
// Shown one item at a time when stock went UP after a count. User confirms
// they received an order; we write a row to inventory_orders.

function OrderLoggingModal({
  rows, index, uid, pid, lang, onAdvance,
}: {
  rows: OrderPromptRow[];
  index: number;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onAdvance: (nextIdx: number) => void;
}) {
  const current = rows[index];
  const [quantity, setQuantity] = useState(String(current.delta));
  const [unitCost, setUnitCost] = useState(current.item.unitCost != null ? String(current.item.unitCost) : '');
  const [vendor, setVendor] = useState(current.item.vendorName ?? '');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset when index changes
  useEffect(() => {
    setQuantity(String(current.delta));
    setUnitCost(current.item.unitCost != null ? String(current.item.unitCost) : '');
    setVendor(current.item.vendorName ?? '');
    setNotes('');
  }, [current]);

  const handleConfirm = async () => {
    setSaving(true);
    try {
      const qty = parseFloat(quantity) || 0;
      const cost = unitCost.trim() === '' ? undefined : parseFloat(unitCost);
      await addInventoryOrder(uid, pid, {
        propertyId: pid,
        itemId: current.item.id,
        itemName: current.item.name,
        quantity: qty,
        unitCost: cost,
        vendorName: vendor.trim() || undefined,
        receivedAt: new Date(),
        notes: notes.trim() || undefined,
      });
      onAdvance(index + 1);
    } catch (err) {
      console.error('[order log] save failed', err);
      onAdvance(index + 1);
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => onAdvance(index + 1);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', borderRadius: '16px',
    border: '1px solid #c5c5d4', background: '#fff',
    fontFamily: "'Inter', sans-serif", fontSize: '14px', color: '#1b1c19',
    outline: 'none',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(27,28,25,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}>
      <div style={{
        width: '100%', maxWidth: '480px', background: '#fbf9f4', borderRadius: '24px',
        padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
            <Truck size={20} color="#006565" />
            <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '17px', color: '#1b1c19', margin: 0 }}>
              {lang === 'es' ? '¿Recibió un pedido?' : 'Did you receive an order?'}
            </h2>
          </div>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', margin: 0 }}>
            <strong>{current.item.name}</strong> — {lang === 'es'
              ? `el stock subió de ${current.previousStock} a ${current.newStock} (+${current.delta}).`
              : `stock went from ${current.previousStock} to ${current.newStock} (+${current.delta}).`}
          </p>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', color: '#757684', margin: '6px 0 0' }}>
            {lang === 'es' ? `Item ${index + 1} de ${rows.length}` : `Item ${index + 1} of ${rows.length}`}
          </p>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Cantidad recibida' : 'Quantity received'}
          </label>
          <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
              {lang === 'es' ? 'Costo unitario ($)' : 'Unit cost ($)'}
            </label>
            <input type="number" step="0.01" min="0" value={unitCost} onChange={e => setUnitCost(e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} placeholder="—" />
          </div>
          <div>
            <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
              {lang === 'es' ? 'Proveedor' : 'Vendor'}
            </label>
            <input value={vendor} onChange={e => setVendor(e.target.value)} style={inputStyle} placeholder={lang === 'es' ? 'Opcional' : 'Optional'} />
          </div>
        </div>

        <div>
          <label style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600, color: '#454652', display: 'block', marginBottom: '6px' }}>
            {lang === 'es' ? 'Notas' : 'Notes'}
          </label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} placeholder={lang === 'es' ? 'Opcional' : 'Optional'} />
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
          <button
            onClick={handleSkip}
            disabled={saving}
            style={{
              padding: '14px 20px', border: '1px solid #c5c5d4', borderRadius: '9999px',
              background: '#fff', color: '#454652', cursor: 'pointer',
              fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
            }}
          >
            {lang === 'es' ? 'Omitir' : 'Skip'}
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            style={{
              flex: 1, padding: '14px', border: 'none', borderRadius: '9999px',
              background: '#364262', color: '#fff', cursor: 'pointer',
              fontFamily: "'Inter', sans-serif", fontSize: '14px', fontWeight: 600,
            }}
          >
            {saving
              ? (lang === 'es' ? 'Guardando...' : 'Saving...')
              : (lang === 'es' ? 'Registrar Pedido' : 'Log Order')}
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
  uid, pid, lang, onClose, showToast,
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
}) {
  const rows = useMemo<ReorderRow[]>(() => {
    return items
      .map(item => {
        const prediction = predictions.get(item.id);
        if (!prediction) return null;
        if (prediction.urgency === 'unknown') return null;
        const eff = effectiveStockOf(item);
        const suggestedQty = Math.max(0, Math.ceil(item.parLevel - eff));
        if (suggestedQty <= 0) return null;
        const estimatedCost = item.unitCost ? suggestedQty * item.unitCost : 0;
        return { item, prediction, effectiveStock: eff, suggestedQty, estimatedCost };
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

// ─── Ownership Report Modal ──────────────────────────────────────────────────
//
// Print-friendly snapshot for property owners/investors. NOT a daily-use
// dashboard. Designed to convey "is everything OK or do I need to look
// harder?" in 30 seconds. Print-friendly @media print CSS is injected
// inline so window.print() produces a clean B&W-friendly page without
// the dashboard chrome.

function OwnershipReportModal({
  items, predictions, effectiveStockOf, totalInventoryValue,
  uid, pid, lang, onClose, showToast,
}: {
  items: InventoryItem[];
  predictions: Map<string, PredictionResult>;
  effectiveStockOf: (item: InventoryItem) => number;
  totalInventoryValue: number;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const [period, setPeriod] = useState<30 | 60 | 90>(30);
  const [orders, setOrders] = useState<InventoryOrder[]>([]);
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [occupiedNights, setOccupiedNights] = useState<{ thisMonth: number; lastMonth: number }>({ thisMonth: 0, lastMonth: 0 });
  const [loading, setLoading] = useState(true);
  const [propertyName, setPropertyName] = useState('Property');

  // Period bookends. "This period" = last `period` days.
  const periodStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - period);
    return d;
  }, [period]);

  // Month boundaries for MoM comparison (current vs previous calendar month).
  const monthBounds = useMemo(() => {
    const now = new Date();
    const thisStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { thisStart, lastStart };
  }, []);

  // Fetch orders + counts + occupancy on mount and when period changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      listInventoryOrders(uid, pid, 500),
      listInventoryCounts(uid, pid, 500),
      // Occupied room-nights for this month and last month
      (async () => {
        const startStr = monthBounds.lastStart.toISOString().slice(0, 10);
        const { data, error } = await supabase
          .from('daily_logs')
          .select('date, occupied')
          .eq('property_id', pid)
          .gte('date', startStr);
        if (error || !data) return { thisMonth: 0, lastMonth: 0 };
        let thisM = 0, lastM = 0;
        const thisStartStr = monthBounds.thisStart.toISOString().slice(0, 10);
        for (const r of data) {
          if (r.date >= thisStartStr) thisM += Number(r.occupied ?? 0);
          else lastM += Number(r.occupied ?? 0);
        }
        return { thisMonth: thisM, lastMonth: lastM };
      })(),
      // Property name
      (async () => {
        const { data } = await supabase.from('properties').select('name').eq('id', pid).maybeSingle();
        return data?.name ?? 'Property';
      })(),
    ])
      .then(([os, cs, occ, name]) => {
        if (!alive) return;
        setOrders(os);
        setCounts(cs);
        setOccupiedNights(occ);
        setPropertyName(String(name));
      })
      .catch(err => console.error('[report] fetch failed:', err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [uid, pid, period, monthBounds]);

  // ─── Derive metrics ──────────────────────────────────────────────────
  const periodOrders = useMemo(
    () => orders.filter(o => o.receivedAt && o.receivedAt >= periodStart),
    [orders, periodStart],
  );
  const periodCounts = useMemo(
    () => counts.filter(c => c.countedAt && c.countedAt >= periodStart),
    [counts, periodStart],
  );

  const totalSpend = periodOrders.reduce((s, o) => s + (o.totalCost ?? 0), 0);
  const totalShrinkage = periodCounts.reduce((s, c) => s + Math.min(0, c.varianceValue ?? 0), 0); // negative number
  const occupiedSinceStart = useMemo(() => {
    // Sum occupied nights since periodStart from the daily_logs we already have.
    // Approximation: we only fetched since lastStart; if periodStart is older,
    // we cap at occupiedNights.thisMonth + occupiedNights.lastMonth.
    return occupiedNights.thisMonth + occupiedNights.lastMonth;
  }, [occupiedNights]);
  const costPerOccupiedRoom = occupiedSinceStart > 0 && totalSpend > 0
    ? totalSpend / occupiedSinceStart
    : 0;

  // MoM comparison by category — compute "value this month" vs "value last month"
  // by looking at received orders bucketed into each calendar month, summed by
  // category. Items without unit_cost don't contribute (matches Total Inventory
  // Value semantics elsewhere).
  const monthOverMonth = useMemo(() => {
    const byCat: Record<InventoryCategory, { thisM: number; lastM: number }> = {
      housekeeping: { thisM: 0, lastM: 0 },
      maintenance: { thisM: 0, lastM: 0 },
      breakfast: { thisM: 0, lastM: 0 },
    };
    const itemsById = new Map(items.map(i => [i.id, i]));
    for (const o of orders) {
      if (!o.receivedAt || o.totalCost == null) continue;
      const item = itemsById.get(o.itemId);
      if (!item) continue;
      if (o.receivedAt >= monthBounds.thisStart) byCat[item.category].thisM += o.totalCost;
      else if (o.receivedAt >= monthBounds.lastStart) byCat[item.category].lastM += o.totalCost;
    }
    return byCat;
  }, [orders, items, monthBounds]);

  // Items requiring attention — under-par + stockout-soon, top 5.
  const itemsNeedingAttention = useMemo(() => {
    const rows = items
      .map(item => {
        const eff = effectiveStockOf(item);
        const pred = predictions.get(item.id);
        const status = stockStatus(eff, item.parLevel, item.reorderAt);
        return { item, eff, pred, status };
      })
      .filter(r => r.status !== 'good' || r.pred?.urgency === 'now' || r.pred?.urgency === 'soon')
      .sort((a, b) => {
        // Prioritize critical first, then soonest stockout
        const aScore = a.status === 'out' ? 0 : a.status === 'low' ? 1 : 2;
        const bScore = b.status === 'out' ? 0 : b.status === 'low' ? 1 : 2;
        if (aScore !== bScore) return aScore - bScore;
        return (a.pred?.daysUntilOut ?? 999) - (b.pred?.daysUntilOut ?? 999);
      })
      .slice(0, 7);
    return rows;
  }, [items, effectiveStockOf, predictions]);

  const handlePrint = () => {
    window.print();
  };

  const handleCopySummary = async () => {
    const lines: string[] = [];
    lines.push(`${propertyName} — ${lang === 'es' ? 'Reporte de Inventario' : 'Inventory Report'}`);
    lines.push(`${lang === 'es' ? 'Período' : 'Period'}: ${lang === 'es' ? 'últimos' : 'last'} ${period} ${lang === 'es' ? 'días' : 'days'}`);
    lines.push(`${lang === 'es' ? 'Generado' : 'Generated'}: ${new Date().toLocaleDateString()}`);
    lines.push('');
    lines.push(`${lang === 'es' ? 'Valor de inventario' : 'Inventory value'}: ${formatCurrency(totalInventoryValue)}`);
    lines.push(`${lang === 'es' ? 'Gasto del período' : 'Period spend'}: ${formatCurrency(totalSpend)}`);
    lines.push(`${lang === 'es' ? 'Pérdida no contabilizada' : 'Unaccounted loss'}: ${formatCurrency(totalShrinkage)}`);
    if (costPerOccupiedRoom > 0) {
      lines.push(`${lang === 'es' ? 'Costo por habitación ocupada' : 'Cost per occupied room'}: ${formatCurrency(costPerOccupiedRoom)}`);
    }
    if (itemsNeedingAttention.length > 0) {
      lines.push('');
      lines.push(lang === 'es' ? 'Necesita atención:' : 'Needs attention:');
      itemsNeedingAttention.forEach(r => {
        const days = r.pred?.daysUntilOut != null ? ` (${Math.round(r.pred.daysUntilOut)}d)` : '';
        lines.push(`  - ${r.item.name}: ${Math.round(r.eff)}/${r.item.parLevel}${days}`);
      });
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast(lang === 'es' ? 'Resumen copiado ✓' : 'Summary copied ✓');
    } catch {
      showToast(lang === 'es' ? 'No se pudo copiar' : 'Copy failed');
    }
  };

  const fmtPctChange = (thisM: number, lastM: number) => {
    if (lastM === 0) return thisM > 0 ? '—' : '0%';
    const pct = ((thisM - lastM) / lastM) * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(0)}%`;
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
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .ownership-report, .ownership-report * { visibility: visible !important; }
          .ownership-report { position: absolute !important; left: 0; top: 0; width: 100% !important; max-width: none !important; max-height: none !important; box-shadow: none !important; border-radius: 0 !important; }
          .ownership-report .no-print { display: none !important; }
        }
      `}</style>
      <div className="ownership-report" style={{
        background: '#fff', borderRadius: '24px',
        width: '100%', maxWidth: '760px', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Header (no-print: keep close + period selector) */}
        <div className="no-print" style={{ padding: '14px 24px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fbf9f4' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            {([30, 60, 90] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                style={{
                  padding: '6px 14px', borderRadius: '9999px', border: 'none',
                  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer',
                  background: period === p ? '#364262' : '#f0eee9',
                  color: period === p ? '#fff' : '#454652',
                }}
              >
                {p}d
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleCopySummary}
              style={{
                padding: '6px 14px', borderRadius: '9999px', border: '1px solid #c5c5d4',
                background: '#fff', color: '#454652', cursor: 'pointer',
                fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '5px',
              }}
            >
              <Copy size={12} />
              {lang === 'es' ? 'Copiar' : 'Copy'}
            </button>
            <button
              onClick={handlePrint}
              style={{
                padding: '6px 14px', borderRadius: '9999px', border: '1px solid #c5c5d4',
                background: '#fff', color: '#454652', cursor: 'pointer',
                fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '5px',
              }}
            >
              <Printer size={12} />
              {lang === 'es' ? 'Imprimir' : 'Print'}
            </button>
            <button onClick={onClose} style={{ background: '#eae8e3', border: 'none', cursor: 'pointer', padding: '6px 10px', borderRadius: '9999px', fontFamily: "'Inter', sans-serif", fontSize: '12px', color: '#454652' }}>
              ✕
            </button>
          </div>
        </div>

        {/* Body — printable */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '32px 36px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#757684', fontFamily: "'Inter', sans-serif" }}>
              {lang === 'es' ? 'Cargando reporte...' : 'Loading report...'}
            </div>
          ) : (
            <>
              {/* Header */}
              <div style={{ marginBottom: '28px', borderBottom: '2px solid #1b1c19', paddingBottom: '14px' }}>
                <h1 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '22px', color: '#1b1c19', margin: 0 }}>
                  {propertyName}
                </h1>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684', marginTop: '4px' }}>
                  {lang === 'es' ? 'Reporte de Inventario' : 'Inventory Report'} · {lang === 'es' ? `últimos ${period} días` : `Last ${period} days`} · {lang === 'es' ? 'Generado' : 'Generated'} {new Date().toLocaleDateString()}
                </div>
              </div>

              {/* Section 1 — Summary cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '28px' }}>
                <ReportStat label={lang === 'es' ? 'Valor Actual' : 'Inventory Value'} value={formatCurrency(totalInventoryValue)} />
                <ReportStat label={lang === 'es' ? 'Gasto del Período' : 'Period Spend'} value={formatCurrency(totalSpend)} />
                <ReportStat
                  label={lang === 'es' ? 'Pérdida' : 'Shrinkage'}
                  value={formatCurrency(totalShrinkage)}
                  tone={totalShrinkage < 0 ? 'bad' : 'neutral'}
                />
                <ReportStat
                  label={lang === 'es' ? 'Costo / Hab.' : 'Cost / Room'}
                  value={costPerOccupiedRoom > 0 ? formatCurrency(costPerOccupiedRoom) : '—'}
                />
              </div>

              {/* Section 2 — MoM */}
              <div style={{ marginBottom: '28px' }}>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '14px', color: '#1b1c19', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
                  {lang === 'es' ? 'Mes vs Mes' : 'Month over Month'}
                </h2>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #c5c5d4' }}>
                      <th style={{ textAlign: 'left', padding: '8px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Categoría' : 'Category'}</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Mes Anterior' : 'Last Month'}</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Este Mes' : 'This Month'}</th>
                      <th style={{ textAlign: 'right', padding: '8px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Cambio' : 'Change'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['housekeeping', 'maintenance', 'breakfast'] as const).map(cat => {
                      const data = monthOverMonth[cat];
                      const change = data.thisM - data.lastM;
                      const color = change > 0 ? '#ba1a1a' : change < 0 ? '#006565' : '#757684';
                      const label = cat === 'housekeeping' ? (lang === 'es' ? 'Limpieza' : 'Housekeeping')
                        : cat === 'maintenance' ? (lang === 'es' ? 'Mantenimiento' : 'Maintenance')
                        : (lang === 'es' ? 'Desayuno' : 'Breakfast');
                      return (
                        <tr key={cat} style={{ borderBottom: '1px solid rgba(197,197,212,0.3)' }}>
                          <td style={{ padding: '8px 0', color: '#1b1c19' }}>{label}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#454652' }}>{formatCurrency(data.lastM)}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#454652' }}>{formatCurrency(data.thisM)}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color, fontWeight: 600 }}>
                            {change >= 0 ? '+' : ''}{formatCurrency(change)} <span style={{ fontSize: '11px', opacity: 0.7 }}>({fmtPctChange(data.thisM, data.lastM)})</span>
                          </td>
                        </tr>
                      );
                    })}
                    {(() => {
                      const totalLast = Object.values(monthOverMonth).reduce((s, c) => s + c.lastM, 0);
                      const totalThis = Object.values(monthOverMonth).reduce((s, c) => s + c.thisM, 0);
                      const change = totalThis - totalLast;
                      const color = change > 0 ? '#ba1a1a' : change < 0 ? '#006565' : '#757684';
                      return (
                        <tr style={{ borderTop: '2px solid #1b1c19' }}>
                          <td style={{ padding: '8px 0', color: '#1b1c19', fontWeight: 700 }}>{lang === 'es' ? 'Total' : 'Total'}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', fontWeight: 700 }}>{formatCurrency(totalLast)}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', fontWeight: 700 }}>{formatCurrency(totalThis)}</td>
                          <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color, fontWeight: 700 }}>
                            {change >= 0 ? '+' : ''}{formatCurrency(change)}
                          </td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>

              {/* Section 3 — Items Requiring Attention */}
              <div style={{ marginBottom: '28px' }}>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '14px', color: '#1b1c19', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
                  {lang === 'es' ? 'Necesita Atención' : 'Needs Attention'}
                </h2>
                {itemsNeedingAttention.length === 0 ? (
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#006565' }}>
                    ✓ {lang === 'es' ? 'Todos los artículos están saludables.' : 'All items healthy.'}
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #c5c5d4' }}>
                        <th style={{ textAlign: 'left', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Artículo' : 'Item'}</th>
                        <th style={{ textAlign: 'right', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Stock' : 'Stock'}</th>
                        <th style={{ textAlign: 'right', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Días' : 'Days'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itemsNeedingAttention.map(r => (
                        <tr key={r.item.id} style={{ borderBottom: '1px solid rgba(197,197,212,0.3)' }}>
                          <td style={{ padding: '6px 0', color: '#1b1c19' }}>{r.item.name}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: r.status === 'out' ? '#ba1a1a' : '#454652' }}>
                            {Math.round(r.eff)} / {r.item.parLevel}
                          </td>
                          <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#454652' }}>
                            {r.pred?.daysUntilOut != null ? Math.round(r.pred.daysUntilOut) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Section 4 — Orders this period */}
              <div>
                <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: '14px', color: '#1b1c19', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
                  {lang === 'es' ? 'Pedidos del Período' : 'Orders This Period'}
                </h2>
                {periodOrders.length === 0 ? (
                  <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '13px', color: '#757684' }}>
                    {lang === 'es' ? 'Sin pedidos registrados.' : 'No orders logged.'}
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #c5c5d4' }}>
                        <th style={{ textAlign: 'left', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Fecha' : 'Date'}</th>
                        <th style={{ textAlign: 'left', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Artículo' : 'Item'}</th>
                        <th style={{ textAlign: 'right', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Cantidad' : 'Qty'}</th>
                        <th style={{ textAlign: 'left', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Proveedor' : 'Vendor'}</th>
                        <th style={{ textAlign: 'right', padding: '6px 0', color: '#454652', fontWeight: 600 }}>{lang === 'es' ? 'Costo' : 'Cost'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periodOrders.slice(0, 20).map(o => (
                        <tr key={o.id} style={{ borderBottom: '1px solid rgba(197,197,212,0.3)' }}>
                          <td style={{ padding: '6px 0', fontFamily: "'JetBrains Mono', monospace", color: '#454652', fontSize: '12px' }}>
                            {o.receivedAt?.toLocaleDateString() ?? '—'}
                          </td>
                          <td style={{ padding: '6px 0', color: '#1b1c19' }}>{o.itemName}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{Math.round(o.quantity)}</td>
                          <td style={{ padding: '6px 0', color: '#454652', fontSize: '12px' }}>{o.vendorName ?? '—'}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#454652' }}>
                            {o.totalCost != null ? formatCurrency(o.totalCost) : '—'}
                          </td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid #1b1c19' }}>
                        <td colSpan={4} style={{ padding: '8px 0', fontWeight: 700 }}>
                          {lang === 'es' ? 'Total' : 'Total'}
                        </td>
                        <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                          {formatCurrency(totalSpend)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportStat({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'neutral' }) {
  const valueColor = tone === 'bad' ? '#ba1a1a' : '#1b1c19';
  return (
    <div style={{
      border: '1px solid rgba(78,90,122,0.12)', borderRadius: '12px', padding: '12px',
      background: '#fff',
    }}>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '10px', fontWeight: 600, color: '#757684', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: 700, color: valueColor, marginTop: '4px' }}>
        {value}
      </div>
    </div>
  );
}

// ─── Image picker helper (shared by Invoice OCR and Photo Counting) ─────────
//
// Two-step pattern: (a) pick a file via camera or gallery, (b) confirm + upload.
// Reads the file as a base64 data URL for two reasons: (1) we send the bytes
// to /api/inventory/* anyway, (2) we display a preview before upload. Returns
// { base64, mediaType, file } so the caller can decide whether to ALSO upload
// to Supabase Storage for record-keeping.

interface PickedImage {
  base64: string;        // raw base64, no data: prefix
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  file: File;
  previewUrl: string;    // data: URL for <img src=>
}

function ImagePickerStage({ lang, onPicked, accept = 'image/*' }: {
  lang: 'en' | 'es';
  onPicked: (img: PickedImage) => void;
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
      const mediaType = m[1] as PickedImage['mediaType'];
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
  quantity: number;
  unit_cost: number | null;
  total_cost: number | null;
}

interface ConfirmRow {
  raw: ExtractedLine;
  enabled: boolean;
  matchedItemId: string | 'new' | '';  // '' = unmatched, 'new' = create-new
  matchedNewName: string;              // used when 'new'
  qty: string;                          // string for input
  unitCost: string;
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
      const res = await fetch('/api/inventory/scan-invoice', {
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

          {stage === 'pick' && <ImagePickerStage lang={lang} onPicked={handlePicked} accept="image/*,application/pdf" />}

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
      });
      onAdded();
      onClose();
      setName(''); setStock('0'); setTarget('100'); setReorderAt('30');
      setUnitCost(''); setPerCheckout(''); setPerStayover(''); setVendor(''); setLeadDays('');
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

function EditItemModal({ item, uid, pid, lang, onClose, onSaved, onDeleted }: {
  item: InventoryItem;
  uid: string;
  pid: string;
  lang: 'en' | 'es';
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
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
  const [showAdvanced, setShowAdvanced] = useState(
    item.unitCost != null || item.usagePerCheckout != null || item.usagePerStayover != null ||
    !!item.vendorName || item.reorderLeadDays != null
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
            openInfo={openInfo} setOpenInfo={setOpenInfo}
          />
        )}

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
  vendor, setVendor, leadDays, setLeadDays, openInfo, setOpenInfo,
}: {
  lang: 'en' | 'es';
  unitCost: string; setUnitCost: (v: string) => void;
  perCheckout: string; setPerCheckout: (v: string) => void;
  perStayover: string; setPerStayover: (v: string) => void;
  vendor: string; setVendor: (v: string) => void;
  leadDays: string; setLeadDays: (v: string) => void;
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
