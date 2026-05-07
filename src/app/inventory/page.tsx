'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToInventory, addInventoryItem, updateInventoryItem, deleteInventoryItem,
  addInventoryCountBatch, addInventoryOrder, listInventoryCounts,
} from '@/lib/db';
import { fetchOccupancyBundle, computeOccupancyForItem, calculateEstimatedStock, type OccupancyBundle } from '@/lib/inventory-estimate';
import type { InventoryItem, InventoryCategory, InventoryCount } from '@/types';
import {
  Plus, Package, ClipboardCheck, AlertTriangle, Check, Info, Settings,
  TrendingDown, DollarSign, Truck, Clock, ChevronDown, ChevronRight,
} from 'lucide-react';

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
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [occupancyBundle, setOccupancyBundle] = useState<OccupancyBundle | null>(null);
  const [counting, setCounting] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBulkRates, setShowBulkRates] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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

  const aiInsight = useMemo(() => {
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
  }, [items, lang, effectiveStock]);

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
