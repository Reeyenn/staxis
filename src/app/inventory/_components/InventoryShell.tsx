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
  listInventoryBudgetSections,
  listInventoryCustomCategories,
  upsertInventoryCustomCategory,
  deleteInventoryCustomCategory,
  updateProperty,
  monthToDateSpendDetail,
  monthlySpendHistory,
  sectionBudgetKey,
  addInventoryCount,
  updateInventoryItem,
  type MonthSpendDetail,
  type MonthlySpend,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { fetchOccupancyBundle, type OccupancyBundle } from '@/lib/inventory-estimate';
import {
  fetchDailyAverages,
  type DailyAverages,
} from '@/lib/inventory-predictions';
import { useCan } from '@/lib/capabilities/useCan';
import type {
  InventoryItem,
  InventoryCount,
  InventoryOrder,
  InventoryBudget,
  InventoryBudgetMode,
  InventoryBudgetSection,
  InventoryCustomCategory,
  InventoryTabLayout,
} from '@/types';

import { T, fonts } from './tokens';
import { startOfLocalMonth, addLocalMonths, isBudgetForLocalMonth } from './month';
import { Caps } from './Caps';
import { Serif } from './Serif';
import { StatusDot } from './StatusPill';
import { Sidebar, type SidebarAction } from './Sidebar';
import { FilterBar, type InventoryView } from './FilterBar';
import type { InvTab } from './InventoryTabs';
import { LedgerTable } from './LedgerTable';
import { StockList } from './StockList';
import { MobileInventoryTriage } from './MobileInventoryTriage';
import mobileStyles from './MobileInventoryTriage.module.css';
import { useRiseIn } from './motion';
import { InvFx, HealthRing, CountUp, PingDot } from './fx';
import { toDisplayItem, applyDraft } from './adapter';
import { fmtMoney } from './format';
import type { DisplayItem } from './types';
import type { StockBucket, StockStatus } from './tokens';

import { CountSheet } from './overlays/CountSheet';
import { ReorderPanel } from './overlays/ReorderPanel';
import { ReportsPanel } from './overlays/ReportsPanel';
import { HistoryPanel } from './overlays/HistoryPanel';
import { BudgetsPanel } from './overlays/BudgetsPanel';
import { DeliverySheet } from './overlays/DeliverySheet';
import { AddItemSheet } from './overlays/AddItemSheet';
import { OrdersPanel } from './overlays/OrdersPanel';
import { OrderingSettingsPanel } from './overlays/OrderingSettingsPanel';
import { AiReportSheet } from './overlays/AiReportSheet';
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
  const { activePropertyId, activeProperty } = useProperty();
  const { lang } = useLang();
  const L = invLang(lang);
  const tx = t(L);
  const can = useCan();
  // Latch the signed-in user through token-refresh blips — Supabase
  // transiently nulls the session mid-refresh, and reacting to that unmounted
  // subscriptions and flickered capability-gated UI. A real sign-out
  // navigates to /signin, so the latch only ever bridges sub-second churn.
  const lastUserRef = React.useRef(user);
  if (user) lastUserRef.current = user;
  const stableUser = user ?? lastUserRef.current;
  const canManage = !!stableUser && can('manage_inventory_orders');
  // Money capability — gates every budget/spend surface (sidebar spend strip,
  // Reports + Budgets panels, the reorder budget meters) AND the budget/spend
  // data fetch below, so the figures never reach a line-staff browser. Stock
  // counts + low-stock badges stay visible to everyone. (Access cleanup 2026-06-26.)
  const canViewFinancials = !!stableUser && can('view_financials');

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
  const [budgetSections, setBudgetSections] = useState<InventoryBudgetSection[]>([]);
  // Hotel-defined custom category tabs (0307).
  const [customCategories, setCustomCategories] = useState<InventoryCustomCategory[]>([]);
  // How this hotel budgets (0306): one total number vs per-section. Seeded
  // from the property record; BudgetsPanel reports changes back via onChanged.
  const [budgetMode, setBudgetMode] = useState<InventoryBudgetMode>(
    activeProperty?.inventoryBudgetMode ?? 'sections',
  );
  const [spendDetail, setSpendDetail] = useState<MonthSpendDetail>({
    byCat: { housekeeping: 0, maintenance: 0, breakfast: 0 },
    byItem: {},
    total: 0,
  });
  // Per-month spend for the Budgets timeline (last 6 months). Money-gated.
  const [spendHistory, setSpendHistory] = useState<MonthlySpend[]>([]);
  // The property record hydrates after mount — pick up its stored mode when it
  // lands (and on property switch). Post-save the context stays quiet, so this
  // never clobbers a mode the panel just wrote.
  const storedMode = activeProperty?.inventoryBudgetMode;
  useEffect(() => {
    if (storedMode) setBudgetMode(storedMode);
  }, [storedMode]);
  // Per-hotel inventory tab layout (0308): tab order + removed built-ins.
  // Seeded from the property record; persisted via updateProperty (like mode).
  const [tabLayout, setTabLayout] = useState<InventoryTabLayout>(
    activeProperty?.inventoryTabLayout ?? { order: [], hidden: [] },
  );
  // Resync from the property record when it hydrates / on property switch. Dep
  // is a stable JSON key (not the object identity, which churns on auth-token
  // rebuilds) so an optimistic local layout is never clobbered by a re-render.
  const storedLayoutKey = activeProperty?.inventoryTabLayout
    ? JSON.stringify(activeProperty.inventoryTabLayout)
    : '';
  useEffect(() => {
    if (!storedLayoutKey) return;
    try { setTabLayout(JSON.parse(storedLayoutKey) as InventoryTabLayout); } catch { /* ignore */ }
  }, [storedLayoutKey]);
  const [bucket, setBucket] = useState<StockBucket>('all');
  const [query, setQuery] = useState('');
  // Layout: the Ledger table (default) or the old triage board (Order now /
  // Order soon / Stocked columns). Remembered per browser so a manager who
  // prefers the board keeps it. Lazy-init reads localStorage on the client only
  // (this is a 'use client' component) → no default 'ledger' flash for board fans.
  const [view, setView] = useState<InventoryView>(() => {
    if (typeof window === 'undefined') return 'ledger';
    return window.localStorage.getItem('staxis:inventory-view') === 'board' ? 'board' : 'ledger';
  });
  useEffect(() => {
    try { window.localStorage.setItem('staxis:inventory-view', view); } catch { /* private mode */ }
  }, [view]);
  // In-flight quick counts from the ledger's −/+ steppers, keyed by item id.
  // Layered over the display until the debounced single-item save lands and the
  // realtime snapshot catches up (then reconciled away below). Optimistic UI.
  const [draftCounts, setDraftCounts] = useState<Map<string, number>>(() => new Map());
  const [overlay, setOverlay] = useState<OverlayKey>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  // Initial-load gate: the page reveals ONCE, after both the first items
  // snapshot AND the stats bundle have landed. Without this, the 3-4 fetch
  // waves each reshuffled/re-animated the freshly-mounted board — the
  // "everything reloads five times" bug.
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [bundleLoaded, setBundleLoaded] = useState(false);

  // ── Subscribe + fetch when property loads ──────────────────────────
  // Both mount effects depend on the user's stable uid, NOT the user object —
  // AuthContext can rebuild the object during a hard load (token refresh /
  // auth-state re-fire), and an object dep would tear down + resubscribe on
  // every rebuild, replaying the board's entrance each time (the "inventory
  // reloads five times" bug). Same identity-primitive rule PropertyContext uses.
  const uid = stableUser?.uid ?? null;
  useEffect(() => {
    if (!uid || !activePropertyId) return;
    setItemsLoaded(false);
    setBundleLoaded(false);
    const unsub = subscribeToInventory(uid, activePropertyId, (snap) => {
      setItems(snap);
      setItemsLoaded(true);
    });
    return () => unsub();
  }, [uid, activePropertyId]);

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
    // Timeline window: the last 6 calendar months through the end of this month.
    const historyStart = addLocalMonths(monthStart, -5);
    const [occ, avg, ct, od, bd, sec, spend, hist, cats] = await Promise.all([
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
        ? listInventoryBudgetSections(uid, pid)
        : Promise.resolve([] as InventoryBudgetSection[]),
      canViewFinancials
        ? monthToDateSpendDetail(uid, pid, monthStart, monthEnd)
        : Promise.resolve({
            byCat: { housekeeping: 0, maintenance: 0, breakfast: 0 },
            byItem: {},
            total: 0,
          } as MonthSpendDetail),
      canViewFinancials
        ? monthlySpendHistory(uid, pid, historyStart, monthEnd)
        : Promise.resolve([] as MonthlySpend[]),
      // Custom category tabs are not money — everyone who can see inventory
      // sees the tabs.
      listInventoryCustomCategories(uid, pid),
    ]);
    return { occ, avg, ct, od, bd, sec, spend, hist, cats };
  }, [canViewFinancials]);

  const applyBoardData = useCallback((d: Awaited<ReturnType<typeof fetchBoardData>>) => {
    setOccupancy(d.occ);
    setAverages(d.avg);
    setCounts(d.ct);
    setOrders(d.od);
    setBudgets(d.bd);
    setBudgetSections(d.sec);
    setSpendDetail(d.spend);
    setSpendHistory(d.hist);
    setCustomCategories(d.cats);
  }, []);

  useEffect(() => {
    if (!uid || !activePropertyId) return;
    let cancelled = false;

    void (async () => {
      try {
        const d = await fetchBoardData(uid, activePropertyId);
        if (cancelled) return;
        applyBoardData(d);
      } catch (err) {
        console.error('[inventory] data load failed', err);
      } finally {
        if (!cancelled) setBundleLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, activePropertyId, fetchBoardData, applyBoardData]);

  // ── Honour ?action= deep links once on mount + when property switches ──
  useEffect(() => {
    const action = searchParams.get('action');
    if (action && VALID_QUERY_ACTIONS.includes(action as Exclude<OverlayKey, null>)) {
      // The budget/spend overlays are money — never honour a ?action= deep link
      // to them for a non-money role (closes the deep-link back door).
      if ((action === 'reports' || action === 'budgets') && !canViewFinancials) return;
      // A deep-linked add opens a NEW item — clear any stale edited item (we no
      // longer clear it on close, see closeOverlay).
      if (action === 'add') setEditItem(null);
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

  // Draft-applied view: layer the ledger's in-flight quick counts over the
  // display so the masthead ring, order-now count, shelf value AND the ledger
  // rows all recompute live before the debounced save lands. Overlays keep the
  // authoritative (persisted) `display` — a draft is at most ~1.5s from saving.
  const effectiveDisplay: DisplayItem[] = useMemo(
    () => (draftCounts.size === 0 ? display : display.map((d) => applyDraft(d, draftCounts.get(d.id)))),
    [display, draftCounts],
  );

  const totalItems = effectiveDisplay.length;
  // Built-in bucket counts EXCLUDE items that live in a custom tab (0307) — a
  // custom item shows only under its own tab (and All), never General/Breakfast.
  const generalCount = effectiveDisplay.filter((d) => !d.customCategoryId && d.cat !== 'breakfast').length;
  const breakfastCount = effectiveDisplay.filter((d) => !d.customCategoryId && d.cat === 'breakfast').length;
  const customCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of effectiveDisplay) if (d.customCategoryId) m[d.customCategoryId] = (m[d.customCategoryId] ?? 0) + 1;
    return m;
  }, [effectiveDisplay]);

  // Assemble the visible filter tabs (0308). Built-ins can be hidden; every tab
  // is orderable by the stored `order`. 'All' is pinned separately by the tab
  // bar and never appears here.
  const { visibleTabs, hiddenTabs } = useMemo(() => {
    const hiddenSet = new Set(tabLayout.hidden);
    const builtins: InvTab[] = [
      { key: 'general', label: tx.generalInventory, count: generalCount, kind: 'builtin' },
      { key: 'breakfast', label: tx.breakfastInventory, count: breakfastCount, kind: 'builtin' },
    ];
    const customs: InvTab[] = customCategories.map((c) => ({
      key: `custom:${c.id}`,
      label: c.name,
      count: customCounts[c.id] ?? 0,
      kind: 'custom',
    }));
    const all = [...builtins, ...customs];
    const orderIndex = new Map(tabLayout.order.map((k, i) => [k, i]));
    // Stable sort by stored order; tabs not yet in `order` keep their natural
    // position (built-ins first, then customs by their own sort).
    const visible = all
      .filter((tb) => !(tb.kind === 'builtin' && hiddenSet.has(tb.key)))
      .map((tb, i) => ({ tb, i }))
      .sort((a, b) => (orderIndex.get(a.tb.key) ?? 1000 + a.i) - (orderIndex.get(b.tb.key) ?? 1000 + b.i))
      .map(({ tb }) => tb);
    const hidden = builtins.filter((tb) => hiddenSet.has(tb.key));
    return { visibleTabs: visible, hiddenTabs: hidden };
  }, [tabLayout, tx, generalCount, breakfastCount, customCategories, customCounts]);
  // Never-counted items (new-hotel day 1) have no real status — exclude them
  // from the triage stats so they don't read as "16 to order now". They still
  // count toward totalItems / the "All" filter (they ARE items in the catalog).
  const countedItems = useMemo(() => effectiveDisplay.filter((d) => !d.uncounted), [effectiveDisplay]);

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
  // Inventory asset valuation — last-counted stock × unit cost (stable between
  // counts; it doesn't drift with occupancy). Live-updates as quick counts land,
  // since applyDraft rewrites `value` for drafted items.
  const shelfValue = useMemo(() => effectiveDisplay.reduce((s, d) => s + d.value, 0), [effectiveDisplay]);

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

  // Whole-inventory spend this month, in dollars. (inventory_orders costs are
  // stored as dollars — the old sum here divided by 100 again and showed ~1%
  // of true spend on the month strip. Fixed with the 0306 budgets rebuild.)
  const totalSpent = spendDetail.total;

  // The active month's cap (today's LOCAL month — see month.ts for the
  // UTC-drift fix), respecting the hotel's budget mode: 'total' reads the one
  // whole-inventory row; 'sections' sums the three categories plus custom
  // sections that still exist (stale section keys are ignored).
  const totalCap = useMemo(() => {
    const now = new Date();
    const liveKeys = new Set<string>([
      'housekeeping', 'maintenance', 'breakfast',
      ...budgetSections.map((s) => sectionBudgetKey(s.id)),
    ]);
    let sum = 0;
    for (const b of budgets) {
      if (!b.monthStart || !isBudgetForLocalMonth(b.monthStart, now)) continue;
      if (budgetMode === 'total') {
        if (b.category === 'total') sum += b.budgetCents / 100;
      } else if (liveKeys.has(b.category)) {
        sum += b.budgetCents / 100;
      }
    }
    return sum;
  }, [budgets, budgetSections, budgetMode]);

  // ── Handlers ───────────────────────────────────────────────────────
  const openOverlay = useCallback((k: SidebarAction | 'add') => {
    // The "AI Helper" rail button opens the AI report as a large overlay like
    // any other action — the inventory tab itself stays manual.
    setOverlay(k as OverlayKey);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    // Intentionally DON'T clear editItem here. The Overlay keeps the sheet
    // mounted for its ~0.2s exit animation; clearing editItem now would flip the
    // still-visible AddItemSheet from "Edit item / King Sheets" to the smaller
    // empty "New item" layout mid-exit — a flash Reeyen saw (2026-07-14). It's
    // harmless to leave stale: every path that opens the Add/Edit sheet sets
    // editItem first (onEditItem → the row; onAdd → null; the ?action=add deep
    // link is guarded below), so it's only ever read with a correct value.
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

  // ── Quick count (ledger −/+ steppers) ──────────────────────────────────
  // Optimistic + debounced single-item counts. Refs let the debounced save and
  // the reconcile read the latest display/drafts without rebuilding the timers.
  const displayRef = React.useRef(display);
  displayRef.current = display;
  const draftCountsRef = React.useRef(draftCounts);
  draftCountsRef.current = draftCounts;
  const quickTimers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Value armed on each item's pending timer, so unmount can flush it.
  const quickPending = React.useRef<Map<string, number>>(new Map());
  // Values whose write has SUCCESSFULLY landed, awaiting the realtime snapshot.
  // The reconcile gates on THIS (not bare value-equality): a still-pending save
  // is never cancelled just because the draft happens to equal the already-
  // stored stock (the "recount confirms the same value" case).
  const savedCounts = React.useRef<Map<string, number>>(new Map());
  // Backstop timers: retire an optimistic draft a couple seconds after its write
  // lands, in case the realtime snapshot never clears it (a concurrent writer to
  // the same item, or a refetch that beat savedCounts) — so a row can't strand
  // on a stale optimistic value.
  const quickBackstop = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeDraft = useCallback((itemId: string) => {
    setDraftCounts((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Map(prev);
      next.delete(itemId);
      return next;
    });
  }, []);

  const scheduleBackstop = useCallback((itemId: string, value: number) => {
    const existing = quickBackstop.current.get(itemId);
    if (existing) clearTimeout(existing);
    quickBackstop.current.set(itemId, setTimeout(() => {
      quickBackstop.current.delete(itemId);
      // Retire only if this exact value is still the un-reconciled optimistic one
      // (the realtime snapshot never cleared it). Then `display` — the
      // authoritative refetched snapshot — takes over the row.
      if (savedCounts.current.get(itemId) !== value) return;
      savedCounts.current.delete(itemId);
      setDraftCounts((prev) => {
        if (prev.get(itemId) !== value) return prev;
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
    }, 2500));
  }, []);

  // Persist one quick count through the same write path Count Mode uses. The
  // stock update (reorder-critical) goes first, then the count-history row,
  // then fire-and-forget ML post-count. Deliberately NO auto stock-up order —
  // that belongs to an authoritative full count; a ±1 correction must not
  // inflate month spend. The two writes are not transactional; stock-first
  // ordering keeps the reorder-critical value correct if the audit row alone
  // fails. On a stock-write failure the optimistic draft is rolled back.
  const saveQuickCount = useCallback(async (itemId: string, value: number) => {
    if (!uid || !activePropertyId || !stableUser) return;
    const d = displayRef.current.find((x) => x.id === itemId);
    if (!d) return;
    // Dedup: don't re-write a value that's already persisted (the net-return
    // "wiggle" case) — it would add a duplicate count-history row.
    // • savedCounts match → the original save owns the draft cleanup; just skip.
    if (savedCounts.current.get(itemId) === value) return;
    // • value already stored → skip AND retire the redundant draft so it can't
    //   strand over a later external change to the same item.
    if ((d.raw.currentStock ?? 0) === value && d.lastCountedAt != null) {
      setDraftCounts((prev) => {
        if (prev.get(itemId) !== value) return prev;
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
      return;
    }
    const now = new Date();
    const variance = Number.isFinite(d.estimated) ? value - d.estimated : undefined;
    try {
      await updateInventoryItem(uid, activePropertyId, itemId, {
        currentStock: value,
        lastCountedAt: now,
      });
      // Stock has landed — record it so the reconcile clears the draft once the
      // realtime snapshot catches up (no flicker back to the old value), even
      // if the audit-row write below happens to fail.
      savedCounts.current.set(itemId, value);
      scheduleBackstop(itemId, value);
      await addInventoryCount(uid, activePropertyId, {
        propertyId: activePropertyId,
        itemId,
        itemName: d.name,
        countedStock: value,
        estimatedStock: Number.isFinite(d.estimated) ? d.estimated : undefined,
        variance,
        varianceValue: variance !== undefined && d.unitCost > 0 ? variance * d.unitCost : undefined,
        unitCost: d.unitCost || undefined,
        countedAt: now,
        countedBy: stableUser.displayName || stableUser.username || tx.team,
      });
      void fetchWithAuth('/api/inventory/post-count-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: activePropertyId, itemIds: [itemId] }),
      }).catch(() => {});
    } catch (err) {
      console.error('[inventory] quick-count save failed', err);
      // Roll back the optimistic draft ONLY if the STOCK write itself failed
      // (nothing persisted). If stock landed and only the audit row failed, the
      // count is already reflected in stock — leave the draft for the reconcile
      // to clear. Never clobber a newer pending edit for the same item.
      if (savedCounts.current.get(itemId) !== value) {
        setDraftCounts((prev) => {
          if (prev.get(itemId) !== value) return prev;
          const next = new Map(prev);
          next.delete(itemId);
          return next;
        });
      }
    }
  }, [uid, activePropertyId, stableUser, tx.team, scheduleBackstop]);

  const saveQuickCountRef = React.useRef(saveQuickCount);
  saveQuickCountRef.current = saveQuickCount;

  // Flush any still-pending debounced counts on unmount — leaving /inventory
  // within the debounce window must not silently drop the write.
  useEffect(() => {
    const timers = quickTimers.current;
    const pending = quickPending.current;
    const backstops = quickBackstop.current;
    return () => {
      for (const [id, tm] of timers) {
        clearTimeout(tm);
        const v = pending.get(id);
        if (v != null) void saveQuickCountRef.current(id, v);
      }
      timers.clear();
      pending.clear();
      for (const tm of backstops.values()) clearTimeout(tm);
      backstops.clear();
    };
  }, []);

  // Ledger row tapped −/+ : update the draft immediately, debounce the save so a
  // burst of taps writes once (~1.5s after the last tap).
  const onQuickCount = useCallback((itemId: string, nextValue: number) => {
    const d = displayRef.current.find((x) => x.id === itemId);
    const curDraft = draftCountsRef.current.get(itemId);
    const have = curDraft != null ? curDraft : Math.max(0, Math.round(d?.estimated ?? 0));
    const v = Math.max(0, Math.round(nextValue));
    if (v === have) return; // no change (e.g. − at floor 0) → never write

    // A never-counted item returning to 0 stays "not counted" — don't fabricate
    // a counted-zero stockout from an accidental − or a +/− undo. Only while no
    // count has landed for it yet (savedCounts empty); once a real count exists,
    // stepping to 0 is a legitimate stockout and must persist. (savedCounts,
    // not the realtime-lagged d.uncounted, is what tells us a save has landed.)
    if (d?.uncounted && v === 0 && !savedCounts.current.has(itemId)) {
      const tm = quickTimers.current.get(itemId);
      if (tm) { clearTimeout(tm); quickTimers.current.delete(itemId); }
      quickPending.current.delete(itemId);
      removeDraft(itemId);
      return;
    }

    setDraftCounts((prev) => {
      const next = new Map(prev);
      next.set(itemId, v);
      return next;
    });
    quickPending.current.set(itemId, v);
    const timers = quickTimers.current;
    const existing = timers.get(itemId);
    if (existing) clearTimeout(existing);
    timers.set(itemId, setTimeout(() => {
      timers.delete(itemId);
      quickPending.current.delete(itemId);
      void saveQuickCount(itemId, v);
    }, 1500));
  }, [saveQuickCount, removeDraft]);

  // Reconcile: once a realtime snapshot reflects a SAVED quick count
  // (savedCounts[id] === currentStock) drop the draft, and cancel the now-
  // redundant same-value timer + backstop. Gating on savedCounts (a confirmed
  // write) — not bare equality — is what prevents a pending save from being lost.
  useEffect(() => {
    const saved = savedCounts.current;
    if (saved.size === 0) return;
    const drafts = draftCountsRef.current;
    let changed = false;
    const next = new Map(drafts);
    for (const it of items) {
      const sv = saved.get(it.id);
      if (sv != null && (it.currentStock ?? 0) === sv) {
        saved.delete(it.id);
        const bt = quickBackstop.current.get(it.id);
        if (bt) { clearTimeout(bt); quickBackstop.current.delete(it.id); }
        if (next.get(it.id) === sv) {
          next.delete(it.id);
          changed = true;
          const tm = quickTimers.current.get(it.id);
          if (tm) { clearTimeout(tm); quickTimers.current.delete(it.id); quickPending.current.delete(it.id); }
        }
      }
    }
    if (changed) setDraftCounts(next);
  }, [items]);

  // Property switch: the shell is NOT remounted, so drop any in-flight
  // quick-count state — its drafts/timers belong to the previous property and
  // the debounced save (which reads the now-swapped display) can't reliably
  // persist them across the switch. Clearing also stops a stale optimistic value
  // from resurrecting when switching back.
  const prevPidRef = React.useRef(activePropertyId);
  useEffect(() => {
    if (prevPidRef.current === activePropertyId) return;
    prevPidRef.current = activePropertyId;
    for (const tm of quickTimers.current.values()) clearTimeout(tm);
    quickTimers.current.clear();
    for (const tm of quickBackstop.current.values()) clearTimeout(tm);
    quickBackstop.current.clear();
    quickPending.current.clear();
    savedCounts.current.clear();
    setDraftCounts((prev) => (prev.size === 0 ? prev : new Map()));
  }, [activePropertyId]);

  const refreshData = useCallback(async () => {
    if (!uid || !activePropertyId) return;
    try {
      applyBoardData(await fetchBoardData(uid, activePropertyId));
    } catch (err) {
      console.error('[inventory] refresh failed', err);
    }
  }, [uid, activePropertyId, fetchBoardData, applyBoardData]);

  // ── Custom category tabs (0307) — add / delete ──────────────────────
  const addCustomCategory = useCallback(async (name: string) => {
    if (!uid || !activePropertyId || !name.trim()) return;
    const trimmed = name.trim();
    // Don't create a duplicate — if a tab with this name already exists, just
    // jump to it.
    const existing = customCategories.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (existing) { setBucket(`custom:${existing.id}`); return; }
    try {
      const id = await upsertInventoryCustomCategory(uid, activePropertyId, { name: trimmed, sort: customCategories.length });
      await refreshData();
      setBucket(`custom:${id}`); // jump to the new tab
    } catch (err) {
      console.error('[inventory] add category failed', err);
    }
  }, [uid, activePropertyId, customCategories, refreshData]);

  const deleteCustomCategory = useCallback(async (id: string) => {
    if (!uid || !activePropertyId) return;
    try {
      await deleteInventoryCustomCategory(uid, activePropertyId, id);
      setBucket((b) => (b === `custom:${id}` ? 'all' : b)); // leave the deleted tab
      await refreshData();
    } catch (err) {
      console.error('[inventory] delete category failed', err);
    }
  }, [uid, activePropertyId, refreshData]);

  // ── Tab layout (0308) — reorder / remove / restore built-ins ────────────
  // Persist optimistically: update local state now, write to the property in the
  // background. updateProperty only touches inventory_tab_layout (dropUndefined),
  // so it never collides with the budget-mode write.
  const persistLayout = useCallback((next: InventoryTabLayout) => {
    setTabLayout(next);
    if (uid && activePropertyId) {
      void updateProperty(uid, activePropertyId, { inventoryTabLayout: next })
        .catch((err) => console.error('[inventory] save tab layout failed', err));
    }
  }, [uid, activePropertyId]);

  const reorderTabs = useCallback((keys: string[]) => {
    persistLayout({ order: keys, hidden: tabLayout.hidden });
  }, [persistLayout, tabLayout.hidden]);

  const removeTab = useCallback((key: string) => {
    if (key.startsWith('custom:')) {
      const id = key.slice(7);
      void deleteCustomCategory(id); // deletes the row (items detach) + resets bucket
      persistLayout({ order: tabLayout.order.filter((k) => k !== key), hidden: tabLayout.hidden });
    } else {
      // Hide a built-in tab. Items keep their category and still show under All.
      const hidden = Array.from(new Set([...tabLayout.hidden, key]));
      persistLayout({ order: tabLayout.order.filter((k) => k !== key), hidden });
      setBucket((b) => (b === key ? 'all' : b));
    }
  }, [persistLayout, deleteCustomCategory, tabLayout]);

  const restoreTab = useCallback((key: string) => {
    persistLayout({
      order: [...tabLayout.order.filter((k) => k !== key), key],
      hidden: tabLayout.hidden.filter((k) => k !== key),
    });
  }, [persistLayout, tabLayout]);

  // Page-load choreography: masthead blocks, rail and filter bar rise in as a
  // cascade — ONCE. `revealed` is a one-way latch: it flips true when the
  // initial data is in (or after a 3.5s failsafe so a single failed fetch can
  // never strand the page on "loading"), and never flips back. Auth-token
  // refreshes transiently null the user; without the latch each blip
  // unmounted the whole board back to the loading branch and replayed the
  // entrance — the "UI pops up over and over" bug.
  const dataReady = !!stableUser && !!activePropertyId && itemsLoaded && bundleLoaded;
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { if (dataReady) setRevealed(true); }, [dataReady]);
  useEffect(() => {
    const failsafe = setTimeout(() => setRevealed(true), 3500);
    return () => clearTimeout(failsafe);
  }, []);
  const pageRef = useRiseIn<HTMLDivElement>([revealed], { step: 75, dist: 16 });

  if (!revealed) {
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
      className={mobileStyles.shell}
      style={{
        padding: '12px 30px 130px',
        background: 'transparent',
        color: T.ink,
        fontFamily: fonts.sans,
        minHeight: 'calc(100dvh - 90px)',
      }}
    >
      <InvFx />

      <MobileInventoryTriage
        lang={L}
        items={effectiveDisplay}
        bucket={bucket}
        onBucket={setBucket}
        tabs={visibleTabs}
        stockHealth={stockHealth}
        shelfValue={shelfValue}
        canManage={canManage}
        canViewFinancials={canViewFinancials}
        onAction={openOverlay}
        onQuickCount={onQuickCount}
        onAdd={() => { setEditItem(null); setOverlay('add'); }}
      />

      <div className={mobileStyles.desktopOnly}>
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
              tabs={visibleTabs}
              hiddenBuiltins={hiddenTabs}
              canManage={canManage}
              onReorder={reorderTabs}
              onRemove={removeTab}
              onRestore={restoreTab}
              onAddCategory={(name) => void addCustomCategory(name)}
              view={view}
              onView={setView}
              onAdd={() => { setEditItem(null); setOverlay('add'); }}
            />
          </div>
          {view === 'ledger' ? (
            <LedgerTable
              lang={L}
              items={effectiveDisplay}
              bucket={bucket}
              query={query}
              canViewFinancials={canViewFinancials}
              onEdit={onEditItem}
              onQuickCount={onQuickCount}
              onCount={() => setOverlay('count')}
              onAdd={() => { setEditItem(null); setOverlay('add'); }}
            />
          ) : (
            <StockList
              lang={L}
              items={effectiveDisplay}
              bucket={bucket}
              query={query}
              onEdit={onEditItem}
              onCount={() => setOverlay('count')}
              onAdd={() => { setEditItem(null); setOverlay('add'); }}
            />
          )}
        </div>
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
        sections={budgetSections}
        budgetMode={budgetMode}
        spendDetail={spendDetail}
        averages={averages}
        mlRateMap={EMPTY_ML_RATES}
        canManage={canManage}
        canViewFinancials={canViewFinancials}
        onViewOrders={() => setOverlay('orders')}
      />

      <OrdersPanel
        open={overlay === 'orders'}
        onClose={() => { closeOverlay(); void refreshData(); }}
        canManage={canManage}
        onChanged={() => void refreshData()}
      />

      <OrderingSettingsPanel
        open={overlay === 'ordersettings'}
        onClose={closeOverlay}
        canManage={canManage}
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
        sections={budgetSections}
        mode={budgetMode}
        display={display}
        spendDetail={spendDetail}
        spendHistory={spendHistory}
        onChanged={(m) => { if (m) setBudgetMode(m); void refreshData(); }}
      />

      <AiReportSheet
        lang={L}
        open={overlay === 'ai'}
        onClose={closeOverlay}
      />

      {/* "Add a delivery" — chooser over the scan flow + a typed-in path.
          Keeps the 'scan' overlay key so ?action=scan deep links still work. */}
      <DeliverySheet
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
        customCategories={customCategories}
        defaultCustomCategoryId={bucket.startsWith('custom:') ? bucket.slice(7) : null}
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
