'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  subscribeToInventory,
  listInventoryCounts,
  listInventoryOrders,
  listInventoryBudgets,
  monthToDateSpendByCategory,
  getInventoryAutoFillMap,
} from '@/lib/db';
import { fetchOccupancyBundle, type OccupancyBundle } from '@/lib/inventory-estimate';
import {
  fetchDailyAverages,
  fetchMlPredictedRates,
  type DailyAverages,
} from '@/lib/inventory-predictions';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useCan } from '@/lib/capabilities/useCan';
import type { OrderingMode } from '@/lib/ordering/types';
import type {
  InventoryItem,
  InventoryCount,
  InventoryOrder,
  InventoryBudget,
} from '@/types';
import type { AutoFillItem } from '@/lib/db/ml-inventory-cockpit';

import { T, fonts } from './tokens';
import { Caps } from './Caps';
import { Serif } from './Serif';
import { StatusDot } from './StatusPill';
import { Sidebar, type SidebarAction } from './Sidebar';
import { FilterBar } from './FilterBar';
import { StockList } from './StockList';
import { toDisplayItem } from './adapter';
import { fmtMoney } from './format';
import type { DisplayItem } from './types';
import type { StockBucket, StockStatus } from './tokens';

import { CountSheet } from './overlays/CountSheet';
import { ReorderPanel } from './overlays/ReorderPanel';
import { ReportsPanel } from './overlays/ReportsPanel';
import { HistoryPanel } from './overlays/HistoryPanel';
import { BudgetsPanel } from './overlays/BudgetsPanel';
import { SimpleSheet } from './overlays/SimpleSheet';
import { AddItemSheet } from './overlays/AddItemSheet';
import { OrdersPanel } from './overlays/OrdersPanel';
import { OrderingSettingsPanel } from './overlays/OrderingSettingsPanel';
import { apiGetMode } from './ordering-api';

type AiMode = 'off' | 'auto' | 'always-on';
type OverlayKey =
  | 'count'
  | 'scan'
  | 'reorder'
  | 'orders'
  | 'ordersettings'
  | 'reports'
  | 'history'
  | 'ai'
  | 'budgets'
  | 'add'
  | null;

const VALID_QUERY_ACTIONS: ReadonlyArray<Exclude<OverlayKey, null>> = [
  'count', 'scan', 'reorder', 'orders', 'ordersettings', 'reports', 'history', 'ai', 'budgets', 'add',
];

export function InventoryShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const can = useCan();
  const canManage = !!user && can('manage_inventory_orders');

  // ── Core data state ────────────────────────────────────────────────
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [occupancy, setOccupancy] = useState<OccupancyBundle | null>(null);
  const [averages, setAverages] = useState<DailyAverages | null>(null);
  const [mlRateMap, setMlRateMap] = useState<Map<string, number>>(() => new Map());
  const [autoFill, setAutoFill] = useState<AutoFillItem[]>([]);
  const [aiMode, setAiMode] = useState<AiMode>('auto');
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [orders, setOrders] = useState<InventoryOrder[]>([]);
  const [budgets, setBudgets] = useState<InventoryBudget[]>([]);
  const [spendByCat, setSpendByCat] = useState<Record<string, number>>({});
  const [bucket, setBucket] = useState<StockBucket>('all');
  const [query, setQuery] = useState('');
  const [overlay, setOverlay] = useState<OverlayKey>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [orderingMode, setOrderingMode] = useState<OrderingMode>('simple');

  // ── Subscribe + fetch when property loads ──────────────────────────
  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToInventory(user.uid, activePropertyId, (snap) => {
      setItems(snap);
    });
    return () => unsub();
  }, [user, activePropertyId]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    let cancelled = false;

    void (async () => {
      try {
        const aiStatusUrl = `/api/inventory/ai-status?propertyId=${activePropertyId}`;
        const statusRes = await fetchWithAuth(aiStatusUrl, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const initialMode = (statusRes?.data?.aiMode as AiMode) ?? 'auto';

        const monthStart = startOfMonth(new Date());
        const monthEnd = startOfMonth(addMonths(new Date(), 1));
        const [occ, avg, rates, fill, ct, od, bd, spend] =
          await Promise.all([
            fetchOccupancyBundle(activePropertyId, daysAgo(14)),
            fetchDailyAverages(activePropertyId, 14),
            fetchMlPredictedRates(activePropertyId),
            getInventoryAutoFillMap(activePropertyId, initialMode).catch(() => [] as AutoFillItem[]),
            listInventoryCounts(user.uid, activePropertyId, 200),
            listInventoryOrders(user.uid, activePropertyId, 200),
            listInventoryBudgets(user.uid, activePropertyId),
            monthToDateSpendByCategory(user.uid, activePropertyId, monthStart, monthEnd),
          ]);
        if (cancelled) return;
        setOccupancy(occ);
        setAverages(avg);
        setMlRateMap(rates);
        setAutoFill(fill);
        setAiMode(initialMode);
        setCounts(ct);
        setOrders(od);
        setBudgets(bd);
        setSpendByCat(spend as Record<string, number>);
      } catch (err) {
        console.error('[inventory] data load failed', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, activePropertyId]);

  // ── Ordering mode (management only — drives the Reorder/Orders UX) ──
  useEffect(() => {
    if (!activePropertyId || !canManage) return;
    let cancelled = false;
    void apiGetMode(activePropertyId)
      .then((m) => { if (!cancelled) setOrderingMode(m); })
      .catch(() => { /* default 'simple' */ });
    return () => { cancelled = true; };
  }, [activePropertyId, canManage]);

  // ── Honour ?action= deep links once on mount + when property switches ──
  useEffect(() => {
    const action = searchParams.get('action');
    if (action && VALID_QUERY_ACTIONS.includes(action as Exclude<OverlayKey, null>)) {
      setOverlay(action as OverlayKey);
    }
    // Run only on initial mount + param changes — we want sticky URLs.

  }, [searchParams]);

  // ── Derived display items ──────────────────────────────────────────
  const autoFillGraduated = useMemo(() => {
    const s = new Set<string>();
    for (const f of autoFill) {
      if ((f as { graduated?: boolean }).graduated) s.add(f.itemId);
    }
    return s;
  }, [autoFill]);

  const display: DisplayItem[] = useMemo(
    () =>
      items.map((it) =>
        toDisplayItem(it, {
          occupancy,
          dailyAverages: averages,
          mlRateMap,
          autoFillGraduated,
        }),
      ),
    [items, occupancy, averages, mlRateMap, autoFillGraduated],
  );

  const totalItems = display.length;
  const generalCount = display.filter((d) => d.cat !== 'breakfast').length;
  const breakfastCount = display.filter((d) => d.cat === 'breakfast').length;

  const statusCounts = useMemo(() => {
    const acc: Record<StockStatus, number> = { good: 0, low: 0, critical: 0 };
    for (const d of display) acc[d.status] += 1;
    return acc;
  }, [display]);
  const stockHealth = totalItems > 0 ? Math.round((100 * statusCounts.good) / totalItems) : 0;
  const shelfValue = useMemo(() => display.reduce((s, d) => s + d.value, 0), [display]);

  const reorderCount = useMemo(
    () => display.filter((d) => d.status !== 'good').length,
    [display],
  );
  // Group count rows by countedAt timestamp so the sidebar shows distinct
  // count events (one per session), not raw row count. Matches HistoryPanel.
  const historyCount = useMemo(() => {
    const countEvents = new Set<string>();
    for (const c of counts) {
      if (c.countedAt) countEvents.add(c.countedAt.toISOString());
    }
    return orders.length + countEvents.size;
  }, [counts, orders]);

  const totalSpent = useMemo(
    () => Object.values(spendByCat).reduce((s, n) => s + (n || 0), 0) / 100,
    [spendByCat],
  );

  // Sum the active month's budget caps (use the cap relevant for today's month).
  const totalCap = useMemo(() => {
    const now = new Date();
    const ymStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let sum = 0;
    for (const b of budgets) {
      if (!b.monthStart) continue;
      if (b.monthStart.getUTCFullYear() === ymStart.getUTCFullYear()
          && b.monthStart.getUTCMonth() === ymStart.getUTCMonth()) {
        sum += b.budgetCents / 100;
      }
    }
    return sum;
  }, [budgets]);

  // ── Handlers ───────────────────────────────────────────────────────
  const openOverlay = useCallback((k: SidebarAction | 'add') => {
    setOverlay(k as OverlayKey);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    setEditItem(null);
    // strip ?action= from the URL on close
    const url = new URL(window.location.href);
    if (url.searchParams.has('action')) {
      url.searchParams.delete('action');
      router.replace(`${url.pathname}${url.search}`);
    }
  }, [router]);

  const onEditItem = useCallback((d: DisplayItem) => {
    setEditItem(d.raw);
    setOverlay('add');
  }, []);

  const refreshData = useCallback(async () => {
    if (!user || !activePropertyId) return;
    try {
      const monthStart = startOfMonth(new Date());
      const monthEnd = startOfMonth(addMonths(new Date(), 1));
      const [ct, od, bd, spend, occ, avg, rates] = await Promise.all([
        listInventoryCounts(user.uid, activePropertyId, 200),
        listInventoryOrders(user.uid, activePropertyId, 200),
        listInventoryBudgets(user.uid, activePropertyId),
        monthToDateSpendByCategory(user.uid, activePropertyId, monthStart, monthEnd),
        fetchOccupancyBundle(activePropertyId, daysAgo(14)),
        fetchDailyAverages(activePropertyId, 14),
        fetchMlPredictedRates(activePropertyId),
      ]);
      setCounts(ct);
      setOrders(od);
      setBudgets(bd);
      setSpendByCat(spend as Record<string, number>);
      setOccupancy(occ);
      setAverages(avg);
      setMlRateMap(rates);
    } catch (err) {
      console.error('[inventory] refresh failed', err);
    }
  }, [user, activePropertyId]);

  const updateAiMode = useCallback(async (mode: AiMode) => {
    if (!activePropertyId) return;
    setAiMode(mode);
    try {
      await fetchWithAuth('/api/inventory/ai-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, mode }),
      });
      // Refresh auto-fill map so the new mode takes effect immediately.
      const fresh = await getInventoryAutoFillMap(activePropertyId, mode);
      setAutoFill(fresh);
    } catch (err) {
      console.error('[inventory] ai-mode update failed', err);
    }
  }, [activePropertyId]);

  if (!user || !activePropertyId) {
    return (
      <div
        style={{
          padding: '64px 24px',
          textAlign: 'center',
          fontFamily: fonts.sans,
          color: T.ink2,
        }}
      >
        Loading…
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '26px 30px 48px',
        background: T.bg,
        color: T.ink,
        fontFamily: fonts.sans,
        minHeight: 'calc(100dvh - 90px)',
      }}
    >
      {/* Header — centered stat cluster + date */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          marginBottom: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 32,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          <HStat eyebrow="Stock health" big={`${stockHealth}%`} dot="good" />
          <HStat eyebrow="Order now" big={String(statusCounts.critical)} dot="critical" />
          <HStat eyebrow="On the shelf" big={fmtMoney(shelfValue)} />
          <div style={{ paddingTop: 2 }}>
            <Caps size={9}>{todayLabel()}</Caps>
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.dim, marginTop: 2 }}>
              {todayDow()}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '224px 1fr', gap: 18, alignItems: 'start' }}>
        <Sidebar
          totalItems={totalItems}
          reorderCount={reorderCount}
          historyCount={historyCount}
          spendSpent={totalSpent}
          spendCap={totalCap}
          canManage={canManage}
          onAction={openOverlay}
        />
        <div>
          <div style={{ marginBottom: 16 }}>
            <FilterBar
              bucket={bucket}
              onBucket={setBucket}
              query={query}
              onQuery={setQuery}
              allCount={totalItems}
              generalCount={generalCount}
              breakfastCount={breakfastCount}
              onAdd={() => { setEditItem(null); setOverlay('add'); }}
            />
          </div>
          <StockList
            items={display}
            bucket={bucket}
            query={query}
            onEdit={onEditItem}
            onCount={() => setOverlay('count')}
            onReorder={() => setOverlay('reorder')}
          />
        </div>
      </div>

      <CountSheet
        open={overlay === 'count'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        items={items}
        display={display}
        autoFill={autoFill}
        aiMode={aiMode}
      />

      <ReorderPanel
        open={overlay === 'reorder'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        items={items}
        display={display}
        budgets={budgets}
        spendByCat={spendByCat}
        averages={averages}
        mlRateMap={mlRateMap}
        canManage={canManage}
        orderingMode={orderingMode}
        onViewOrders={() => setOverlay('orders')}
      />

      <OrdersPanel
        open={overlay === 'orders'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        canManage={canManage}
        orderingMode={orderingMode}
        onChanged={() => void refreshData()}
      />

      <OrderingSettingsPanel
        open={overlay === 'ordersettings'}
        onClose={closeOverlay}
        canManage={canManage}
        orderingMode={orderingMode}
        onModeChange={setOrderingMode}
        onChanged={() => void refreshData()}
      />

      <ReportsPanel
        open={overlay === 'reports'}
        onClose={closeOverlay}
        display={display}
      />

      <HistoryPanel
        open={overlay === 'history'}
        onClose={closeOverlay}
        counts={counts}
        orders={orders}
      />

      <BudgetsPanel
        open={overlay === 'budgets'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        budgets={budgets}
      />

      <SimpleSheet
        open={overlay === 'scan' || overlay === 'ai'}
        kind={overlay === 'scan' ? 'scan' : 'ai'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        aiMode={aiMode}
        onModeChange={updateAiMode}
        display={display}
      />

      <AddItemSheet
        open={overlay === 'add'}
        onClose={() => { closeOverlay(); }}
        item={editItem}
      />
    </div>
  );
}

// Inline header stat: mono eyebrow (+ optional status dot) over a big serif value.
function HStat({ eyebrow, big, dot }: { eyebrow: string; big: string; dot?: StockStatus }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Caps size={9}>{eyebrow}</Caps>
        {dot && <StatusDot s={dot} size={5} />}
      </div>
      <Serif size={27}>{big}</Serif>
    </div>
  );
}

function todayLabel(): string {
  const d = new Date();
  return d
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .toUpperCase();
}
function todayDow(): string {
  const d = new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}
function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}
