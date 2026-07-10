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
} from '@/lib/db';
import { fetchOccupancyBundle, type OccupancyBundle } from '@/lib/inventory-estimate';
import {
  fetchDailyAverages,
  type DailyAverages,
} from '@/lib/inventory-predictions';
import { useCan } from '@/lib/capabilities/useCan';
import type { OrderingMode } from '@/lib/ordering/types';
import type {
  InventoryItem,
  InventoryCount,
  InventoryOrder,
  InventoryBudget,
} from '@/types';

import { T, fonts } from './tokens';
import { startOfLocalMonth, addLocalMonths, isBudgetForLocalMonth } from './month';
import { Caps } from './Caps';
import { Serif } from './Serif';
import { StatusDot } from './StatusPill';
import { Sidebar, type SidebarAction } from './Sidebar';
import { FilterBar } from './FilterBar';
import { StockList } from './StockList';
import { useRiseIn } from './motion';
import { InvFx, HealthRing, CountUp, PingDot } from './fx';
import { toDisplayItem } from './adapter';
import { fmtMoney } from './format';
import type { DisplayItem } from './types';
import type { StockBucket, StockStatus } from './tokens';

import { CountSheet } from './overlays/CountSheet';
import { ReorderPanel } from './overlays/ReorderPanel';
import { ReportsPanel } from './overlays/ReportsPanel';
import { HistoryPanel } from './overlays/HistoryPanel';
import { BudgetsPanel } from './overlays/BudgetsPanel';
import { ScanInvoiceSheet } from './overlays/ScanInvoiceSheet';
import { AddItemSheet } from './overlays/AddItemSheet';
import { OrdersPanel } from './overlays/OrdersPanel';
import { OrderingSettingsPanel } from './overlays/OrderingSettingsPanel';
import { AiReportSheet } from './overlays/AiReportSheet';
import { apiGetMode } from './ordering-api';
import { t, invLang, dateLocale } from './inv-i18n';

// The inventory tab is 100% manual — no ML numbers, no AI pre-fill. The "AI
// Helper" rail button opens the AI report as a large overlay (`ai`) right on
// the inventory tab — the silent predictions are surfaced there, the tab itself
// stays manual. `?action=ai` deep-links to it.
type OverlayKey =
  | 'count'
  | 'scan'
  | 'reorder'
  | 'orders'
  | 'ordersettings'
  | 'reports'
  | 'history'
  | 'budgets'
  | 'ai'
  | 'add'
  | null;

const VALID_QUERY_ACTIONS: ReadonlyArray<Exclude<OverlayKey, null>> = [
  'count', 'scan', 'reorder', 'orders', 'ordersettings', 'reports', 'history', 'budgets', 'ai', 'add',
];

export function InventoryShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const L = invLang(lang);
  const tx = t(L);
  const can = useCan();
  const canManage = !!user && can('manage_inventory_orders');
  // Money capability — gates every budget/spend surface (sidebar spend strip,
  // Reports + Budgets panels, the reorder budget meters) AND the budget/spend
  // data fetch below, so the figures never reach a line-staff browser. Stock
  // counts + low-stock badges stay visible to everyone. (Access cleanup 2026-06-26.)
  const canViewFinancials = !!user && can('view_financials');

  // ── Core data state ────────────────────────────────────────────────
  // No ML state here on purpose. The manual inventory tab never fetches ML
  // predicted rates or the auto-fill map — days-left + reorder suggestions run
  // only on the occupancy-weighted usage rule and the static fallback. The
  // (empty) map below is threaded through the adapter/panel so selectBurnRate
  // can never pick the 'ml' source. The AI's silent predictions live on the
  // separate /inventory/ai report screen.
  const EMPTY_ML_RATES: Map<string, number> = useMemo(() => new Map(), []);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [occupancy, setOccupancy] = useState<OccupancyBundle | null>(null);
  const [averages, setAverages] = useState<DailyAverages | null>(null);
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

  // ONE assembly of the board's data fetch — shared by the initial-load effect
  // and refreshData so the two query sets can never drift apart.
  // Manual page: fetch occupancy + daily averages (needed for the rule-based
  // days-left) + counts/orders/budgets/spend only. No ML predicted-rate fetch,
  // no auto-fill map, no ai-status/ai-mode call.
  const fetchBoardData = useCallback(async (uid: string, pid: string) => {
    // LOCAL month window — "this month" means the hotel's calendar month, not
    // the UTC one (which flips hours early in US timezones).
    const monthStart = startOfLocalMonth(new Date());
    const monthEnd = addLocalMonths(new Date(), 1);
    const [occ, avg, ct, od, bd, spend] = await Promise.all([
      fetchOccupancyBundle(pid, daysAgo(14)),
      fetchDailyAverages(pid, 14),
      listInventoryCounts(uid, pid, 200),
      listInventoryOrders(uid, pid, 200),
      // Budget + spend are money — only fetch them for the money capability
      // so the dollar figures never reach a line-staff browser.
      canViewFinancials
        ? listInventoryBudgets(uid, pid)
        : Promise.resolve([] as InventoryBudget[]),
      canViewFinancials
        ? monthToDateSpendByCategory(uid, pid, monthStart, monthEnd)
        : Promise.resolve({} as Record<string, number>),
    ]);
    return { occ, avg, ct, od, bd, spend };
  }, [canViewFinancials]);

  const applyBoardData = useCallback((d: Awaited<ReturnType<typeof fetchBoardData>>) => {
    setOccupancy(d.occ);
    setAverages(d.avg);
    setCounts(d.ct);
    setOrders(d.od);
    setBudgets(d.bd);
    setSpendByCat(d.spend as Record<string, number>);
  }, []);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    let cancelled = false;

    void (async () => {
      try {
        const d = await fetchBoardData(user.uid, activePropertyId);
        if (cancelled) return;
        applyBoardData(d);
      } catch (err) {
        console.error('[inventory] data load failed', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, activePropertyId, fetchBoardData, applyBoardData]);

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
      // The budget/spend overlays are money — never honour a ?action= deep link
      // to them for a non-money role (closes the deep-link back door).
      if ((action === 'reports' || action === 'budgets') && !canViewFinancials) return;
      setOverlay(action as OverlayKey);
    }
    // Run only on initial mount + param changes — we want sticky URLs.

  }, [searchParams, canViewFinancials]);

  // ── Derived display items ──────────────────────────────────────────
  // Fully manual: no ML rates and no "ai-tracked" graduation marks. Empty
  // maps force selectBurnRate down the rule-occupancy → fallback-60d → no-data
  // path, and no card ever shows the ai-tracked label.
  const NO_GRADUATED: Set<string> = useMemo(() => new Set(), []);

  const display: DisplayItem[] = useMemo(
    () =>
      items.map((it) =>
        toDisplayItem(it, {
          occupancy,
          dailyAverages: averages,
          mlRateMap: EMPTY_ML_RATES,
          autoFillGraduated: NO_GRADUATED,
        }),
      ),
    [items, occupancy, averages, EMPTY_ML_RATES, NO_GRADUATED],
  );

  const totalItems = display.length;
  const generalCount = display.filter((d) => d.cat !== 'breakfast').length;
  const breakfastCount = display.filter((d) => d.cat === 'breakfast').length;
  // Never-counted items (new-hotel day 1) have no real status — exclude them
  // from the triage stats so they don't read as "16 to order now". They still
  // count toward totalItems / the "All" filter (they ARE items in the catalog).
  const countedItems = useMemo(() => display.filter((d) => !d.uncounted), [display]);

  const statusCounts = useMemo(() => {
    const acc: Record<StockStatus, number> = { good: 0, low: 0, critical: 0 };
    for (const d of countedItems) acc[d.status] += 1;
    return acc;
  }, [countedItems]);
  // Stock health over COUNTED items only; null → "—" until a first count exists
  // (avoids a misleading 0% on a hotel that simply hasn't counted yet).
  const stockHealth = countedItems.length > 0
    ? Math.round((100 * statusCounts.good) / countedItems.length)
    : null;
  const shelfValue = useMemo(() => display.reduce((s, d) => s + d.value, 0), [display]);

  const reorderCount = useMemo(
    () => countedItems.filter((d) => d.status !== 'good').length,
    [countedItems],
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

  // Sum the active month's budget caps (use the cap relevant for today's
  // LOCAL month — see month.ts for the UTC-drift fix).
  const totalCap = useMemo(() => {
    const now = new Date();
    let sum = 0;
    for (const b of budgets) {
      if (!b.monthStart) continue;
      if (isBudgetForLocalMonth(b.monthStart, now)) {
        sum += b.budgetCents / 100;
      }
    }
    return sum;
  }, [budgets]);

  // ── Handlers ───────────────────────────────────────────────────────
  const openOverlay = useCallback((k: SidebarAction | 'add') => {
    // The "AI Helper" rail button opens the AI report as a large overlay like
    // any other action — the inventory tab itself stays manual.
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
      applyBoardData(await fetchBoardData(user.uid, activePropertyId));
    } catch (err) {
      console.error('[inventory] refresh failed', err);
    }
  }, [user, activePropertyId, fetchBoardData, applyBoardData]);

  // Page-load choreography: masthead blocks, rail and filter bar rise in as a
  // cascade. Keyed on readiness (not mount) — on a hard page load the shell
  // shows the loading branch first, and the cascade must fire when the real
  // page appears. The board itself animates via FLIP in StockList.
  const ready = !!user && !!activePropertyId;
  const pageRef = useRiseIn<HTMLDivElement>([ready], { step: 75, dist: 16 });

  if (!ready) {
    return (
      <div
        style={{
          padding: '64px 24px',
          textAlign: 'center',
          fontFamily: fonts.sans,
          color: T.ink2,
        }}
      >
        {tx.loading}
      </div>
    );
  }

  return (
    <div
      ref={pageRef}
      style={{
        padding: '12px 30px 48px',
        background: T.bg,
        color: T.ink,
        fontFamily: fonts.sans,
        minHeight: 'calc(100dvh - 90px)',
      }}
    >
      <InvFx />

      {/* Masthead — editorial title block on the left, living stats on the right.
          Kept deliberately tight: this row + hairline is the only air above the board. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px 40px',
          flexWrap: 'wrap',
          padding: '0 4px',
        }}
      >
        <div data-rise>
          <Caps size={9.5}>{todayLabel(L)} · {todayDow(L)}</Caps>
          <div style={{ marginTop: 3 }}>
            <Serif size={33}>{tx.pageTitle}</Serif>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 34,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div data-rise style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HealthRing pct={stockHealth} size={58} />
            <Caps size={9}>{tx.stockHealth}</Caps>
          </div>
          <HStat
            eyebrow={tx.orderNow}
            dot={statusCounts.critical > 0 ? 'critical' : 'good'}
            ping={statusCounts.critical > 0}
          >
            <CountUp value={statusCounts.critical} />
          </HStat>
          {/* "On the shelf" is an inventory dollar valuation — money-capability only. */}
          {canViewFinancials && (
            <HStat eyebrow={tx.onTheShelf}>
              <CountUp value={shelfValue} format={(n) => fmtMoney(n, { digits: 0 })} />
            </HStat>
          )}
        </div>
      </div>

      {/* Editorial hairline that draws itself across on load */}
      <div className="inv-rule-draw" style={{ height: 1, background: T.rule, margin: '10px 0 16px' }} />

      <div className="inv-layout">
        <Sidebar
          lang={L}
          totalItems={totalItems}
          reorderCount={reorderCount}
          historyCount={historyCount}
          spendSpent={totalSpent}
          spendCap={totalCap}
          canManage={canManage}
          canViewFinancials={canViewFinancials}
          onAction={openOverlay}
        />
        <div>
          <div data-rise style={{ marginBottom: 16 }}>
            <FilterBar
              lang={L}
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
            lang={L}
            items={display}
            bucket={bucket}
            query={query}
            onEdit={onEditItem}
            onCount={() => setOverlay('count')}
            onReorder={() => setOverlay('reorder')}
            onAdd={() => { setEditItem(null); setOverlay('add'); }}
          />
        </div>
      </div>

      <CountSheet
        lang={L}
        open={overlay === 'count'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        items={items}
        display={display}
      />

      <ReorderPanel
        open={overlay === 'reorder'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        items={items}
        display={display}
        budgets={budgets}
        spendByCat={spendByCat}
        averages={averages}
        mlRateMap={EMPTY_ML_RATES}
        canManage={canManage}
        canViewFinancials={canViewFinancials}
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
        lang={L}
        open={overlay === 'reports' && canViewFinancials}
        onClose={closeOverlay}
        display={display}
      />

      <HistoryPanel
        lang={L}
        open={overlay === 'history'}
        onClose={closeOverlay}
        counts={counts}
        orders={orders}
      />

      <BudgetsPanel
        lang={L}
        open={overlay === 'budgets' && canViewFinancials}
        onClose={() => { closeOverlay(); void refreshData(); }}
        budgets={budgets}
      />

      <AiReportSheet
        lang={L}
        open={overlay === 'ai'}
        onClose={closeOverlay}
      />

      <ScanInvoiceSheet
        lang={L}
        open={overlay === 'scan'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        display={display}
      />

      <AddItemSheet
        lang={L}
        open={overlay === 'add'}
        onClose={() => { closeOverlay(); }}
        item={editItem}
      />
    </div>
  );
}

// Inline masthead stat: mono eyebrow (+ status dot, optionally pinging) over a
// big italic-serif animated value.
function HStat({
  eyebrow,
  dot,
  ping,
  children,
}: {
  eyebrow: string;
  dot?: StockStatus;
  ping?: boolean;
  children: React.ReactNode;
}) {
  const dotColor = dot === 'critical' ? T.terra : dot === 'low' ? T.gold : T.forest;
  return (
    <div data-rise style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Caps size={9}>{eyebrow}</Caps>
        {dot && (ping
          ? <PingDot color={dotColor} size={5} />
          : <StatusDot s={dot} size={5} />)}
      </div>
      <Serif size={30}>{children}</Serif>
    </div>
  );
}

function todayLabel(lang: 'en' | 'es'): string {
  const d = new Date();
  return d
    .toLocaleDateString(dateLocale(lang), { month: 'short', day: 'numeric', year: 'numeric' })
    .toUpperCase();
}
function todayDow(lang: 'en' | 'es'): string {
  const d = new Date();
  return d.toLocaleDateString(dateLocale(lang), { weekday: 'long' });
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}
