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
import type {
  InventoryItem,
  InventoryCount,
  InventoryOrder,
  InventoryBudget,
} from '@/types';
import type { AutoFillItem } from '@/lib/db/ml-inventory-cockpit';

import { T, fonts } from './tokens';
import { Caps } from './Caps';
import { HeroStats } from './HeroStats';
import { Sidebar, type SidebarAction } from './Sidebar';
import { FilterBar } from './FilterBar';
import { StockList } from './StockList';
import { toDisplayItem } from './adapter';
import type { DisplayItem } from './types';
import type { StockBucket } from './tokens';

import { CountSheet } from './overlays/CountSheet';
import { ReorderPanel } from './overlays/ReorderPanel';
import { ReportsPanel } from './overlays/ReportsPanel';
import { HistoryPanel } from './overlays/HistoryPanel';
import { BudgetsPanel } from './overlays/BudgetsPanel';
import { SimpleSheet } from './overlays/SimpleSheet';
import { AddItemSheet } from './overlays/AddItemSheet';

type AiMode = 'off' | 'auto' | 'always-on';
type OverlayKey =
  | 'count'
  | 'scan'
  | 'reorder'
  | 'reports'
  | 'history'
  | 'ai'
  | 'budgets'
  | 'add'
  | null;

const VALID_QUERY_ACTIONS: ReadonlyArray<Exclude<OverlayKey, null>> = [
  'count', 'scan', 'reorder', 'reports', 'history', 'ai', 'budgets', 'add',
];

export function InventoryShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const { lang } = useLang();

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
  const [bucket, setBucket] = useState<StockBucket>('general');
  const [query, setQuery] = useState('');
  const [overlay, setOverlay] = useState<OverlayKey>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);

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

  // ── Honour ?action= deep links once on mount + when property switches ──
  useEffect(() => {
    const action = searchParams.get('action');
    if (action && VALID_QUERY_ACTIONS.includes(action as Exclude<OverlayKey, null>)) {
      setOverlay(action as OverlayKey);
    }
    // Run only on initial mount + param changes — we want sticky URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const generalCount = display.filter((d) => d.cat !== 'breakfast').length;
  const breakfastCount = display.filter((d) => d.cat === 'breakfast').length;

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

  const lastCount = useMemo<{ date: Date; by: string } | null>(() => {
    for (const c of counts) {
      if (c.countedAt) return { date: c.countedAt, by: c.countedBy || 'team' };
    }
    return null;
  }, [counts]);

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

  const onItemClick = useCallback((d: DisplayItem) => {
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

  const propertyName = activeProperty?.name ?? 'Inventory';
  const totalRooms = (activeProperty as { totalRooms?: number } | null)?.totalRooms;

  return (
    <div
      style={{
        padding: '24px 24px 48px',
        background: T.bg,
        color: T.ink,
        fontFamily: fonts.sans,
        minHeight: 'calc(100dvh - 90px)',
      }}
    >
      {/* Header strip — title left, tiny date upper-right */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 18,
          gap: 24,
        }}
      >
        <div>
          <Caps>
            Inventory · {propertyName}
          </Caps>
          <h1
            style={{
              fontFamily: fonts.serif,
              fontSize: 36,
              color: T.ink,
              margin: '4px 0 0',
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              fontWeight: 400,
            }}
          >
            <span style={{ fontStyle: 'italic' }}>What you have</span>
          </h1>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 10,
              color: T.ink2,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            {todayLabel()}
          </span>
          <div
            style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3, marginTop: 2 }}
          >
            {todayDow()}{totalRooms ? ` · ${totalRooms} rooms` : ''}
          </div>
        </div>
      </div>

      <HeroStats items={display} lastCount={lastCount} />

      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16 }}>
        <Sidebar
          totalItems={display.length}
          reorderCount={reorderCount}
          historyCount={historyCount}
          spendSpent={totalSpent}
          spendCap={totalCap}
          onAction={openOverlay}
        />
        <div>
          <div style={{ marginBottom: 12 }}>
            <FilterBar
              bucket={bucket}
              onBucket={setBucket}
              query={query}
              onQuery={setQuery}
              generalCount={generalCount}
              breakfastCount={breakfastCount}
              onAdd={() => { setEditItem(null); setOverlay('add'); }}
            />
          </div>
          <StockList
            items={display}
            bucket={bucket}
            query={query}
            onItemClick={onItemClick}
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
