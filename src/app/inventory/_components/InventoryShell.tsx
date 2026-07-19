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
  sectionBudgetKey,
  saveInventoryCountAtomic,
  type MonthSpendDetail,
} from '@/lib/db';
import { fetchWithAuth } from '@/lib/api-fetch';
import { generateId } from '@/lib/utils';
import { buildHistoryEvents } from './history-events';
import {
  clearQuickCountAttempt,
  isDefinitiveQuickCountFailure,
  loadQuickCountAttempts,
  persistQuickCountAttempt,
  QuickCountStorageError,
  type FrozenQuickCountAttempt,
} from '@/lib/inventory-quick-count-attempt';
import { fetchOccupancyBundle, type OccupancyBundle } from '@/lib/inventory-estimate';
import {
  inventoryCloseWindow,
  inventoryMonthKeyInZone,
  type InventoryMonthCloseDashboard,
} from '@/lib/inventory-month-close';
import {
  inventoryBudgetPeriodsFromDashboard,
  resolveInventoryBudgetActual,
  type InventoryBudgetActualPeriod,
} from '@/lib/inventory-budget-actual';
import { propertyTimezoneOrUTC } from '@/lib/property-timezone';
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

import { T, fonts, inBucket } from './tokens';
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
import { ComparePanel } from './overlays/ComparePanel';
import { ReportsPanel } from './overlays/ReportsPanel';
import { HistoryPanel } from './overlays/HistoryPanel';
import { BudgetsPanel } from './overlays/BudgetsPanel';
import { DeliverySheet } from './overlays/DeliverySheet';
import { AddItemSheet } from './overlays/AddItemSheet';
import { AiReportSheet } from './overlays/AiReportSheet';
import { MonthClosePanel } from './overlays/MonthClosePanel';
import { t, invLang, dateLocale } from './inv-i18n';

// The inventory tab is 100% manual — no ML numbers, no AI pre-fill. The "AI
// Helper" rail button opens the AI report as a large overlay (`ai`) right on
// the inventory tab — the silent predictions are surfaced there, the tab itself
// stays manual. `?action=ai` deep-links to it.
type OverlayKey =
  | 'count'
  | 'scan'
  | 'reports'
  | 'compare'
  | 'history'
  | 'budgets'
  | 'close'
  | 'ai'
  | 'add'
  | null;

const VALID_QUERY_ACTIONS: ReadonlyArray<Exclude<OverlayKey, null>> = [
  'count', 'scan', 'reports', 'compare', 'history', 'budgets', 'close', 'ai', 'add',
];

// Shared container for the full-page loading / load-error notices (identical
// framing; the error variant just adds role="alert" + a retry button).
const NOTICE_STYLE: React.CSSProperties = {
  padding: '64px 24px',
  textAlign: 'center',
  fontFamily: fonts.sans,
  color: T.ink2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function monthCloseDashboardFromPayload(payload: unknown): InventoryMonthCloseDashboard | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : null;
  const candidate = data && isRecord(data.dashboard)
    ? data.dashboard
    : data ?? (isRecord(payload.dashboard) ? payload.dashboard : payload);
  if (
    typeof candidate.propertyId !== 'string'
    || typeof candidate.month !== 'string'
    || !['not_started', 'open', 'closed'].includes(String(candidate.status))
    || !Array.isArray(candidate.history)
  ) return null;
  return candidate as unknown as InventoryMonthCloseDashboard;
}

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
  // PropertyContext hydrates the stored IANA zone. Until it is available (or
  // if a legacy row is invalid), use deterministic UTC — never the browser or
  // a different hotel's hard-coded calendar.
  const propertyTimezone = propertyTimezoneOrUTC(activeProperty?.timezone);

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
    complete: true,
  });
  // The finance-gated, immutable monthly usage ledger. Purchases remain a
  // separate live flow (`spendDetail`) until a period is explicitly closed.
  const [monthCloseDashboard, setMonthCloseDashboard] = useState<InventoryMonthCloseDashboard | null>(null);
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
  const [countForMonthClose, setCountForMonthClose] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  // Initial-load gate: the page reveals ONCE, after both the first items
  // snapshot AND the stats bundle have landed. Without this, the 3-4 fetch
  // waves each reshuffled/re-animated the freshly-mounted board — the
  // "everything reloads five times" bug.
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [bundleLoaded, setBundleLoaded] = useState(false);
  const [itemsLoadError, setItemsLoadError] = useState(false);
  const [inventoryReload, setInventoryReload] = useState(0);
  const [quickCountError, setQuickCountError] = useState(false);
  const [quickCountLockedIds, setQuickCountLockedIds] = useState<Set<string>>(() => new Set());

  // ── Subscribe + fetch when property loads ──────────────────────────
  // Both mount effects depend on the user's stable uid, NOT the user object —
  // AuthContext can rebuild the object during a hard load (token refresh /
  // auth-state re-fire), and an object dep would tear down + resubscribe on
  // every rebuild, replaying the board's entrance each time (the "inventory
  // reloads five times" bug). Same identity-primitive rule PropertyContext uses.
  const uid = stableUser?.uid ?? null;
  // Async quick-count responses may arrive after the operator switches hotels.
  // Read the live property from a ref before touching visible draft/lock state,
  // so an old hotel's response can never paint an item into the new hotel.
  const activePropertyIdRef = React.useRef(activePropertyId);
  activePropertyIdRef.current = activePropertyId;
  useEffect(() => {
    if (!uid || !activePropertyId) return;
    setItems([]);
    setItemsLoaded(false);
    setBundleLoaded(false);
    setItemsLoadError(false);
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setItemsLoadError(true);
      setItemsLoaded(true);
    }, 8000);
    const unsub = subscribeToInventory(uid, activePropertyId, (snap) => {
      settled = true;
      window.clearTimeout(timeout);
      setItems(snap);
      setItemsLoadError(false);
      setItemsLoaded(true);
    }, () => {
      settled = true;
      window.clearTimeout(timeout);
      setItemsLoadError(true);
      setItemsLoaded(true);
    }, canViewFinancials);
    return () => {
      settled = true;
      window.clearTimeout(timeout);
      unsub();
    };
  }, [uid, activePropertyId, inventoryReload, canViewFinancials]);

  // ONE assembly of the board's data fetch — shared by the initial-load effect
  // and refreshData so the two query sets can never drift apart.
  // Manual page: fetch occupancy + daily averages (needed for the rule-based
  // days-left) + counts/orders/budgets/spend only. No ML predicted-rate fetch,
  // no auto-fill map, no ai-status/ai-mode call.
  const fetchBoardData = useCallback(async (uid: string, pid: string) => {
    // Property-local calendar boundaries keep a remote manager on the hotel's
    // month rather than the browser's month.
    const currentMonth = inventoryMonthKeyInZone(new Date(), propertyTimezone);
    const monthWindow = inventoryCloseWindow(currentMonth, propertyTimezone);
    const closeDashboardPromise: Promise<InventoryMonthCloseDashboard | null> = canViewFinancials
      ? fetchWithAuth(`/api/inventory/month-close?propertyId=${encodeURIComponent(pid)}`, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`month close load failed (${response.status})`);
            return monthCloseDashboardFromPayload(await response.json());
          })
          .catch((error) => {
            // The board and physical-count workflow remain available if the
            // finance ledger is temporarily unavailable. Budget status then
            // stays pending; purchases are never promoted to actual usage.
            console.error('[inventory] month close load failed', error);
            return null;
          })
      : Promise.resolve(null);
    const [occ, avg, ct, od, bd, sec, spend, closeDashboard, cats] = await Promise.all([
      fetchOccupancyBundle(pid, daysAgo(14)),
      fetchDailyAverages(pid, 14),
      // A 40-item hotel counting daily generates 1,120 rows in four weeks.
      // Keep enough local history for a full field-test month rather than
      // silently truncating the reconciliation timeline after five saves.
      listInventoryCounts(uid, pid, 2000, canViewFinancials),
      listInventoryOrders(uid, pid, 200, canViewFinancials),
      // Budget + spend are money — only fetch them for the money capability
      // so the dollar figures never reach a line-staff browser.
      canViewFinancials
        ? listInventoryBudgets(uid, pid)
        : Promise.resolve([] as InventoryBudget[]),
      canViewFinancials
        ? listInventoryBudgetSections(uid, pid)
        : Promise.resolve([] as InventoryBudgetSection[]),
      canViewFinancials
        ? monthToDateSpendDetail(uid, pid, monthWindow.monthStart, monthWindow.endExclusive)
        : Promise.resolve({
            byCat: { housekeeping: 0, maintenance: 0, breakfast: 0 },
            byItem: {},
            total: 0,
            complete: true,
          } as MonthSpendDetail),
      closeDashboardPromise,
      // Custom category tabs are not money — everyone who can see inventory
      // sees the tabs.
      listInventoryCustomCategories(uid, pid),
    ]);
    return { occ, avg, ct, od, bd, sec, spend, closeDashboard, cats };
  }, [canViewFinancials, propertyTimezone]);

  const applyBoardData = useCallback((d: Awaited<ReturnType<typeof fetchBoardData>>) => {
    setOccupancy(d.occ);
    setAverages(d.avg);
    setCounts(d.ct);
    setOrders(d.od);
    setBudgets(d.bd);
    setBudgetSections(d.sec);
    setSpendDetail(d.spend);
    setMonthCloseDashboard(d.closeDashboard);
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
  }, [uid, activePropertyId, fetchBoardData, applyBoardData, inventoryReload]);

  // ── Honour ?action= deep links once on mount + when property switches ──
  useEffect(() => {
    const action = searchParams.get('action');
    if (action && VALID_QUERY_ACTIONS.includes(action as Exclude<OverlayKey, null>)) {
      // The budget/spend overlays are money — never honour a ?action= deep link
      // to them for a non-money role (closes the deep-link back door).
      if ((action === 'reports' || action === 'compare' || action === 'budgets' || action === 'close') && !canViewFinancials) return;
      if ((action === 'scan' || action === 'close') && !canManage) return;
      // A deep-linked add opens a NEW item — clear any stale edited item (we no
      // longer clear it on close, see closeOverlay).
      if (action === 'add') setEditItem(null);
      setOverlay(action as OverlayKey);
    }
    // Run only on initial mount + param changes — we want sticky URLs.

  }, [searchParams, canViewFinancials, canManage]);

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
  const shelfValueComplete = useMemo(
    () => effectiveDisplay.every((d) => (d.raw.currentStock ?? 0) <= 0 || d.raw.unitCost != null),
    [effectiveDisplay],
  );
  // Per-tab valuation for the masthead: selecting a tab (General / Breakfast /
  // a custom tab) slides that tab's total value in to the left of "On the
  // shelf"; selecting All slides it back out. Same valuation basis as
  // shelfValue, so the tab numbers always sum to the total.
  const activeTab = bucket !== 'all' ? visibleTabs.find((tb) => tb.key === bucket) ?? null : null;
  const activeTabValue = useMemo(
    () =>
      activeTab
        ? effectiveDisplay.filter((d) => inBucket(d, bucket)).reduce((s, d) => s + d.value, 0)
        : 0,
    [activeTab, bucket, effectiveDisplay],
  );
  const activeTabValueComplete = useMemo(
    () => !activeTab || effectiveDisplay
      .filter((d) => inBucket(d, bucket))
      .every((d) => (d.raw.currentStock ?? 0) <= 0 || d.raw.unitCost != null),
    [activeTab, bucket, effectiveDisplay],
  );
  // Defaults for the Add-item sheet, honoring the hotel's visible tabs: an
  // add from All must never file the item into a HIDDEN built-in bucket
  // (it would then appear under no named tab). General hidden → first custom
  // tab; no customs but Breakfast visible → breakfast; last resort HK.
  const generalTabVisible = !tabLayout.hidden.includes('general');
  const breakfastTabVisible = !tabLayout.hidden.includes('breakfast');
  const addDefaultCustomId = bucket.startsWith('custom:')
    ? bucket.slice(7)
    : !generalTabVisible && customCategories.length > 0
      ? customCategories[0].id
      : null;
  const addDefaultCategory: 'housekeeping' | 'breakfast' =
    bucket === 'breakfast' && breakfastTabVisible
      ? 'breakfast'
      : !generalTabVisible && customCategories.length === 0 && breakfastTabVisible
        ? 'breakfast'
        : 'housekeeping';

  // Custom-tab id → name, for row sub-labels (an item living in a custom tab
  // shows its tab's name, not a built-in HK/MX/FB glyph the hotel may have
  // hidden entirely).
  const customNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of customCategories) m.set(c.id, c.name);
    return m;
  }, [customCategories]);

  // Keep the last shown label/value while the stat animates out, so the text
  // doesn't blank mid-collapse when the user taps All.
  const lastTabStatRef = React.useRef<{ label: string; value: number } | null>(null);
  if (activeTab) lastTabStatRef.current = { label: activeTab.label, value: activeTabValue };
  const tabStat = activeTab ? { label: activeTab.label, value: activeTabValue } : lastTabStatRef.current;
  // The stat's animated slot transitions to the EXACT pixel width of its
  // content. The content div keeps its natural width (min-width: max-content)
  // even while the slot clips it, so we track it with a ResizeObserver and
  // feed the number back as the slot's width. That makes the FIRST-ever
  // appearance slide open (slot is always mounted at width 0), makes a
  // "Sheets" → "Housekeeping supplies" tab switch glide between the two
  // label widths, and follows the CountUp's settling digits.
  const tabStatInnerRef = React.useRef<HTMLDivElement | null>(null);
  const [tabStatWidth, setTabStatWidth] = useState(0);
  const tabStatMounted = tabStat != null;
  React.useLayoutEffect(() => {
    const el = tabStatInnerRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.ceil(el.getBoundingClientRect().width);
      if (w > 0) setTabStatWidth(w);
      // Never store 0 — keep the last real width so the exit animation
      // shrinks from the correct size.
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabStatMounted]);

  // One entry per ACTION (count session, delivery, invoice scan, items added)
  // — the same grouping the History panel renders, so the rail badge and the
  // panel can never disagree. Keyed off the RAW item rows, not `display`:
  // the builder only reads createdAt/name, and display's identity churns on
  // every occupancy/averages tick.
  const historyEvents = useMemo(
    () => buildHistoryEvents(
      counts,
      orders,
      items,
      canViewFinancials ? (monthCloseDashboard?.history ?? []) : [],
      propertyTimezone,
    ),
    [counts, orders, items, canViewFinancials, monthCloseDashboard, propertyTimezone],
  );
  const historyCount = historyEvents.length;

  const actualPeriods: InventoryBudgetActualPeriod[] = useMemo(
    () => monthCloseDashboard
      ? inventoryBudgetPeriodsFromDashboard(monthCloseDashboard)
      : [],
    [monthCloseDashboard],
  );
  const propertyCurrentMonth = inventoryMonthKeyInZone(new Date(), propertyTimezone);
  const currentActualPeriod = actualPeriods.find(
    (period) => period.monthStart.slice(0, 7) === propertyCurrentMonth,
  ) ?? null;
  const currentActual = resolveInventoryBudgetActual(currentActualPeriod, 'total');
  // "This month" always means the full property-calendar purchase ledger.
  // A first partial close may start mid-month, but that tracking boundary must
  // never make earlier received purchases disappear from this live figure.
  const purchasesThisMonth = spendDetail.total;
  const purchasesComplete = spendDetail.complete;

  // The active month's cap (today's LOCAL month — see month.ts for the
  // UTC-drift fix), respecting the hotel's budget mode: 'total' reads the one
  // whole-inventory row; 'sections' sums the three categories plus custom
  // sections that still exist (stale section keys are ignored).
  const totalCap = useMemo(() => {
    const [currentYear, currentMonth1] = propertyCurrentMonth.split('-').map(Number);
    const liveKeys = new Set<string>([
      'housekeeping', 'maintenance', 'breakfast',
      ...budgetSections.map((s) => sectionBudgetKey(s.id)),
    ]);
    let sum = 0;
    for (const b of budgets) {
      if (
        b.basis !== 'usage'
        || !b.monthStart
        || b.monthStart.getUTCFullYear() !== currentYear
        || b.monthStart.getUTCMonth() !== currentMonth1 - 1
      ) continue;
      if (budgetMode === 'total') {
        if (b.category === 'total') sum += b.budgetCents / 100;
      } else if (liveKeys.has(b.category)) {
        sum += b.budgetCents / 100;
      }
    }
    return sum;
  }, [budgets, budgetSections, budgetMode, propertyCurrentMonth]);

  // ── Handlers ───────────────────────────────────────────────────────
  const openOverlay = useCallback((k: SidebarAction | 'add') => {
    // The "AI Helper" rail button opens the AI report as a large overlay like
    // any other action — the inventory tab itself stays manual.
    if (k === 'scan' && !canManage) return;
    if ((k === 'reports' || k === 'compare' || k === 'budgets' || k === 'close') && !canViewFinancials) return;
    if (k === 'close' && !canManage) return;
    if (k === 'count') setCountForMonthClose(false);
    setOverlay(k as OverlayKey);
  }, [canManage, canViewFinancials]);

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
  // The latest debounced envelope per item. It is already in localStorage, so
  // navigation during the debounce window cannot lose the employee's tap.
  const quickPending = React.useRef<Map<string, FrozenQuickCountAttempt>>(new Map());
  // Values whose write has SUCCESSFULLY landed, awaiting the realtime snapshot.
  // The reconcile gates on THIS (not bare value-equality): a still-pending save
  // is never cancelled just because the draft happens to equal the already-
  // stored stock (the "recount confirms the same value" case).
  const savedCounts = React.useRef<Map<string, number>>(new Map());
  // Full immutable RPC envelopes. Once an RPC begins, that item's stepper is
  // locked until success or a definitive rollback; an ambiguous response can
  // only replay this exact object.
  const quickAttempts = React.useRef<Map<string, FrozenQuickCountAttempt>>(new Map());
  const quickInFlight = React.useRef<Set<string>>(new Set());
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

  const setQuickLocked = useCallback((itemId: string, locked: boolean) => {
    setQuickCountLockedIds((prev) => {
      if (prev.has(itemId) === locked) return prev;
      const next = new Set(prev);
      if (locked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  // Submit one already-persisted immutable envelope. This function never
  // rebuilds expectedStock/actor/estimate on retry.
  const submitQuickCountAttempt = useCallback(async (attempt: FrozenQuickCountAttempt) => {
    const { itemId } = attempt;
    if (quickInFlight.current.has(itemId)) return;
    quickInFlight.current.add(itemId);
    if (activePropertyIdRef.current === attempt.propertyId) setQuickLocked(itemId, true);
    try {
      // Re-verify the durable write immediately before every RPC. A storage
      // quota/policy failure is pre-send and therefore cannot become an
      // ambiguous additive/absolute database result.
      persistQuickCountAttempt(attempt);
      await saveInventoryCountAtomic(
        attempt.userId,
        attempt.propertyId,
        attempt.requestId,
        new Date(attempt.countedAt),
        attempt.countedBy,
        [attempt.row],
      );
      const value = attempt.row.countedStock;
      clearQuickCountAttempt(attempt.propertyId, itemId, attempt.requestId);
      if (quickAttempts.current.get(itemId)?.requestId === attempt.requestId) {
        quickAttempts.current.delete(itemId);
      }
      if (activePropertyIdRef.current === attempt.propertyId) {
        savedCounts.current.set(itemId, value);
        scheduleBackstop(itemId, value);
        setQuickLocked(itemId, false);
        setQuickCountError([...quickAttempts.current.values()].some(
          (pending) => pending.propertyId === attempt.propertyId,
        ));
      }
      void fetchWithAuth('/api/inventory/post-count-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: attempt.propertyId, itemIds: [itemId] }),
      }).catch(() => {});
    } catch (err) {
      console.error('[inventory] quick-count save failed', err);
      const isActiveProperty = activePropertyIdRef.current === attempt.propertyId;
      if (isActiveProperty) setQuickCountError(true);
      if (isDefinitiveQuickCountFailure(err)) {
        // A coded database response proves rollback. Release the UUID but keep
        // the employee's visible value so the error never erases their input.
        clearQuickCountAttempt(attempt.propertyId, itemId, attempt.requestId);
        if (quickAttempts.current.get(itemId)?.requestId === attempt.requestId) {
          quickAttempts.current.delete(itemId);
          if (isActiveProperty) setQuickLocked(itemId, false);
        }
      } else {
        // Network or durable-storage uncertainty: retain the exact envelope and
        // its visible value. Only the Retry action/reload may replay it.
        quickAttempts.current.set(itemId, attempt);
        if (isActiveProperty) setQuickLocked(itemId, true);
      }
      if (isActiveProperty) {
        setDraftCounts((prev) => {
          const next = new Map(prev);
          next.set(itemId, attempt.row.countedStock);
          return next;
        });
      }
    } finally {
      quickInFlight.current.delete(itemId);
    }
  }, [scheduleBackstop, setQuickLocked]);

  const submitQuickCountAttemptRef = React.useRef(submitQuickCountAttempt);
  submitQuickCountAttemptRef.current = submitQuickCountAttempt;

  // Attempts are synchronously persisted on every tap. Unmount only cancels
  // timers; restoration will replay the exact envelopes on the next mount.
  useEffect(() => {
    const timers = quickTimers.current;
    const pending = quickPending.current;
    const backstops = quickBackstop.current;
    return () => {
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
      pending.clear();
      for (const tm of backstops.values()) clearTimeout(tm);
      backstops.clear();
    };
  }, []);

  // Ledger row tapped −/+ : update the draft immediately, debounce the save so a
  // burst of taps writes once (~1.5s after the last tap).
  const onQuickCount = useCallback((itemId: string, nextValue: number) => {
    if (!uid || !activePropertyId || !stableUser) return;
    // Once an RPC begins (or its response is ambiguous), do not allow a new
    // value to replace the frozen envelope. The row's controls are also
    // disabled; this ref guard closes the one-render click race.
    if (quickInFlight.current.has(itemId)
      || (quickAttempts.current.has(itemId) && !quickPending.current.has(itemId))) return;
    const d = displayRef.current.find((x) => x.id === itemId);
    if (!d) return;
    const curDraft = draftCountsRef.current.get(itemId);
    // Baseline for the "no change" guard is the real count (what the row's
    // stepper edits), never the occupancy estimate — see LedgerRow.onHand.
    const have = curDraft != null ? curDraft : Math.max(0, Math.round(d?.counted ?? 0));
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
      const pendingAttempt = quickAttempts.current.get(itemId);
      if (pendingAttempt && !quickInFlight.current.has(itemId)) {
        clearQuickCountAttempt(pendingAttempt.propertyId, itemId, pendingAttempt.requestId);
        quickAttempts.current.delete(itemId);
      }
      removeDraft(itemId);
      return;
    }

    // Retire the prior debounce before replacing its envelope. If persistence
    // for the new value fails, no older timer may wake up and save a value the
    // employee has already changed.
    const timers = quickTimers.current;
    const existing = timers.get(itemId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(itemId);
    }

    const previousAttempt = quickAttempts.current.get(itemId);
    const attempt: FrozenQuickCountAttempt = {
      version: 1,
      userId: uid,
      propertyId: activePropertyId,
      itemId,
      requestId: generateId(),
      countedAt: new Date().toISOString(),
      countedBy: stableUser.displayName || stableUser.username || tx.team,
      row: {
        itemId,
        expectedStock: savedCounts.current.get(itemId) ?? (d.raw.currentStock ?? 0),
        countedStock: v,
        estimatedStock: d.lastCountedAt != null && Number.isFinite(d.estimated) ? d.estimated : undefined,
      },
    };
    setDraftCounts((prev) => {
      const next = new Map(prev);
      next.set(itemId, v);
      return next;
    });
    quickAttempts.current.set(itemId, attempt);
    quickPending.current.set(itemId, attempt);
    try {
      persistQuickCountAttempt(attempt);
    } catch (err) {
      console.error('[inventory] quick-count durable save failed', err);
      quickPending.current.delete(itemId);
      if (previousAttempt && err instanceof QuickCountStorageError && !err.supersededRetired) {
        // Storage could not neutralize A, so B was never accepted. Keep A both
        // visibly and in memory; a reload may replay A, but never an obsolete
        // value hidden behind a visible B.
        quickAttempts.current.set(itemId, previousAttempt);
        setDraftCounts((prev) => {
          const next = new Map(prev);
          next.set(itemId, previousAttempt.row.countedStock);
          return next;
        });
      }
      setQuickLocked(itemId, true);
      setQuickCountError(true);
      return;
    }
    timers.set(itemId, setTimeout(() => {
      timers.delete(itemId);
      quickPending.current.delete(itemId);
      void submitQuickCountAttempt(attempt);
    }, 1500));
  }, [uid, activePropertyId, stableUser, tx.team, submitQuickCountAttempt, setQuickLocked, removeDraft]);

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

  // Property switch/remount: the old hotel's timers can stop because their
  // envelopes are durable. Restore the new hotel's exact pending values and
  // lock them before any fresh edit is possible.
  const prevPidRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (prevPidRef.current === activePropertyId) return;
    prevPidRef.current = activePropertyId;
    for (const tm of quickTimers.current.values()) clearTimeout(tm);
    quickTimers.current.clear();
    for (const tm of quickBackstop.current.values()) clearTimeout(tm);
    quickBackstop.current.clear();
    quickPending.current.clear();
    savedCounts.current.clear();
    if (!activePropertyId) {
      setDraftCounts(new Map());
      setQuickCountLockedIds(new Set());
      return;
    }
    try {
      const restored = loadQuickCountAttempts(activePropertyId);
      for (const [itemId, attempt] of quickAttempts.current) {
        if (attempt.propertyId === activePropertyId) quickAttempts.current.delete(itemId);
      }
      for (const attempt of restored) quickAttempts.current.set(attempt.itemId, attempt);
      setDraftCounts(new Map(restored.map((attempt) => [attempt.itemId, attempt.row.countedStock])));
      setQuickCountLockedIds(new Set(restored.map((attempt) => attempt.itemId)));
      setQuickCountError(restored.length > 0);
    } catch (err) {
      console.error('[inventory] quick-count restore failed', err);
      // If storage becomes temporarily unreadable during an in-app property
      // switch, retain any exact envelopes already held in memory.
      const cached = [...quickAttempts.current.values()].filter(
        (attempt) => attempt.propertyId === activePropertyId,
      );
      setDraftCounts(new Map(cached.map((attempt) => [attempt.itemId, attempt.row.countedStock])));
      setQuickCountLockedIds(new Set(cached.map((attempt) => attempt.itemId)));
      setQuickCountError(true);
    }
  }, [activePropertyId]);

  // Once authentication is ready, resolve restored envelopes automatically.
  useEffect(() => {
    if (!uid || !activePropertyId) return;
    for (const attempt of quickAttempts.current.values()) {
      if (attempt.propertyId === activePropertyId && attempt.userId === uid) {
        void submitQuickCountAttemptRef.current(attempt);
      }
    }
  }, [uid, activePropertyId]);

  const retryQuickCounts = useCallback(() => {
    if (!activePropertyId) return;
    for (const attempt of quickAttempts.current.values()) {
      if (attempt.propertyId === activePropertyId && attempt.userId === uid) {
        void submitQuickCountAttempt(attempt);
      }
    }
  }, [activePropertyId, uid, submitQuickCountAttempt]);

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
  // Persist optimistically: update local state now, write in the background.
  // The write goes through /api/inventory/property-config (service role +
  // management gate) — NOT the anon client: `properties` RLS only lets admins
  // UPDATE, so a GM's direct write was a silent no-op and their tab setup
  // reverted on reload.
  const persistLayout = useCallback((next: InventoryTabLayout) => {
    setTabLayout(next);
    if (uid && activePropertyId) {
      void fetchWithAuth('/api/inventory/property-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: activePropertyId, tabLayout: next }),
      })
        .then((res) => { if (!res.ok) throw new Error(`save failed (${res.status})`); })
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

  if (itemsLoadError) {
    return (
      <div role="alert" style={NOTICE_STYLE}>
        <div style={{ marginBottom: 14 }}>{tx.loadFailed}</div>
        <button
          type="button"
          onClick={() => setInventoryReload((n) => n + 1)}
          style={{
            minHeight: 44,
            padding: '0 18px',
            borderRadius: 10,
            border: 0,
            background: T.brand,
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          {tx.retry}
        </button>
      </div>
    );
  }

  if (!revealed || !itemsLoaded) {
    // Byte-identical to InventoryLoading in ../page.tsx (the SSR Suspense
    // fallback); any drift between the two makes React hydration re-render
    // the whole tree and the loading text visibly flash mid-load.
    return (
      <div style={{ padding: '64px 24px', textAlign: 'center', color: '#5C625C' }}>
        Loading inventory…
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

      {quickCountError && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            margin: '0 4px 14px',
            padding: '10px 14px',
            borderRadius: 10,
            border: `1px solid ${T.terra}55`,
            background: T.terraDim,
            color: T.terra,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span>{tx.quickCountSaveFailed}</span>
          {quickCountLockedIds.size > 0 && (
            <button
              type="button"
              onClick={retryQuickCounts}
              style={{
                flex: 'none', border: `1px solid ${T.terra}66`, borderRadius: 8,
                padding: '6px 10px', background: T.bg, color: T.terra,
                fontFamily: fonts.sans, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >
              {L === 'es' ? 'Reintentar conteos pendientes' : 'Retry pending counts'}
            </button>
          )}
        </div>
      )}

      <MobileInventoryTriage
        lang={L}
        items={effectiveDisplay}
        bucket={bucket}
        onBucket={setBucket}
        tabs={visibleTabs}
        stockHealth={stockHealth}
        shelfValue={shelfValue}
        shelfValueComplete={shelfValueComplete}
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
          {/* Active-tab valuation — money-capability only. The slot is ALWAYS
              mounted (collapsed to zero width on All / before any tab is ever
              picked) so its very first appearance transitions instead of
              popping in. It animates to the measured width of its content, so
              switching between short- and long-named tabs glides too. The
              -34px margin cancels the flex gap while collapsed so the ring and
              Order-now stat sit exactly where they did before this existed. */}
          {canViewFinancials && (
            <div
              aria-hidden={!activeTab}
              style={{
                display: 'flex',
                overflow: 'hidden',
                width: activeTab ? tabStatWidth : 0,
                opacity: activeTab ? 1 : 0,
                marginRight: activeTab ? 0 : -34,
                transform: activeTab ? 'translateX(0)' : 'translateX(16px)',
                transition:
                  'width .45s cubic-bezier(.22,.8,.28,1), opacity .3s ease, ' +
                  'margin-right .45s cubic-bezier(.22,.8,.28,1), transform .45s cubic-bezier(.22,.8,.28,1)',
              }}
            >
              {tabStat && (
                <div ref={tabStatInnerRef} style={{ minWidth: 'max-content' }}>
                  <HStat eyebrow={tabStat.label}>
                    <span
                      title={activeTabValueComplete ? undefined : tx.shelfCostsMissing}
                      aria-label={activeTabValueComplete
                        ? fmtMoney(tabStat.value, { digits: 0 })
                        : `${fmtMoney(tabStat.value, { digits: 0 })} minimum; ${tx.shelfCostsMissing}`}
                    >
                      {!activeTabValueComplete && <span aria-hidden>≥ </span>}
                      <CountUp value={tabStat.value} format={(n) => fmtMoney(n, { digits: 0 })} />
                    </span>
                  </HStat>
                </div>
              )}
            </div>
          )}
          {/* "On the shelf" is an inventory dollar valuation — money-capability only. */}
          {canViewFinancials && (
            <HStat eyebrow={tx.onTheShelf}>
              <span
                title={shelfValueComplete ? undefined : tx.shelfCostsMissing}
                aria-label={shelfValueComplete
                  ? fmtMoney(shelfValue, { digits: 0 })
                  : `${fmtMoney(shelfValue, { digits: 0 })} minimum; ${tx.shelfCostsMissing}`}
              >
                {!shelfValueComplete && <span aria-hidden>≥ </span>}
                <CountUp value={shelfValue} format={(n) => fmtMoney(n, { digits: 0 })} />
              </span>
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
          historyCount={historyCount}
          purchasesThisMonth={purchasesThisMonth}
          purchasesComplete={purchasesComplete}
          actualUsedThisMonth={currentActual.value}
          actualState={currentActual.state}
          budgetCap={totalCap}
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
              customNameById={customNameById}
              onEdit={onEditItem}
              onQuickCount={onQuickCount}
              quickCountLockedIds={quickCountLockedIds}
              onCount={() => setOverlay('count')}
              onAdd={() => { setEditItem(null); setOverlay('add'); }}
            />
          ) : (
            <StockList
              lang={L}
              items={effectiveDisplay}
              bucket={bucket}
              query={query}
              customNameById={customNameById}
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
        onClose={() => { setCountForMonthClose(false); closeOverlay(); void refreshData(); }}
        startWithAll={countForMonthClose}
        requireComplete={countForMonthClose}
        canViewFinancials={canViewFinancials}
        onSaved={() => {
          setCountForMonthClose(false);
          setOverlay('close');
          void refreshData();
        }}
        items={items}
        display={display}
        customCategories={customCategories}
        tabLayout={tabLayout}
      />

      <ReportsPanel
        lang={L}
        open={overlay === 'reports' && canViewFinancials}
        onClose={closeOverlay}
        display={display}
        customNameById={customNameById}
        timezone={propertyTimezone}
      />

      <ComparePanel
        lang={L}
        open={overlay === 'compare' && canViewFinancials}
        onClose={closeOverlay}
        timezone={propertyTimezone}
      />

      <HistoryPanel
        lang={L}
        open={overlay === 'history'}
        onClose={closeOverlay}
        events={historyEvents}
        canViewFinancials={canViewFinancials}
        timezone={propertyTimezone}
      />

      <BudgetsPanel
        lang={L}
        open={overlay === 'budgets' && canViewFinancials}
        onClose={() => { closeOverlay(); void refreshData(); }}
        budgets={budgets}
        sections={budgetSections}
        mode={budgetMode}
        timezone={propertyTimezone}
        display={display}
        actualPeriods={actualPeriods}
        onChanged={(m) => { if (m) setBudgetMode(m); void refreshData(); }}
      />

      <MonthClosePanel
        lang={L}
        open={overlay === 'close' && canManage && canViewFinancials}
        onClose={closeOverlay}
        onStartCount={() => { setCountForMonthClose(true); setOverlay('count'); }}
        onChanged={() => { void refreshData(); }}
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
        open={overlay === 'scan' && canManage}
        onClose={() => { closeOverlay(); void refreshData(); }}
        display={display}
        timezone={propertyTimezone}
        customCategories={customCategories}
        tabLayout={tabLayout}
      />

      <AddItemSheet
        lang={L}
        open={overlay === 'add'}
        onClose={() => { closeOverlay(); }}
        item={editItem}
        canViewFinancials={canViewFinancials}
        defaultCategory={addDefaultCategory}
        customCategories={customCategories}
        defaultCustomCategoryId={addDefaultCustomId}
        hiddenBuiltins={tabLayout.hidden}
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
