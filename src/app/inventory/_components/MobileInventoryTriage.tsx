'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtMoney } from './format';
import { t, type Lang } from './inv-i18n';
import type { InvTab } from './InventoryTabs';
import type { SidebarAction } from './Sidebar';
import {
  inBucket,
  monogram,
  type InvCat,
  type StockBucket,
  type StockStatus,
} from './tokens';
import type { DisplayItem } from './types';
import { partitionMobileInventory } from './mobile-inventory-triage';
import { SetAsideTag } from './SetAsideTag';
import { ShelfValueWarning } from './ShelfValueWarning';
import { missingPriceItemNames } from './inventory-value';
import styles from './MobileInventoryTriage.module.css';

export interface MobileInventoryTriageProps {
  lang: Lang;
  items: DisplayItem[];
  bucket: StockBucket;
  onBucket: (bucket: StockBucket) => void;
  query: string;
  onQuery: (query: string) => void;
  tabs: InvTab[];
  stockHealth: number | null;
  shelfValue: number;
  canManage: boolean;
  canViewFinancials: boolean;
  onAction: (action: SidebarAction) => void;
  onQuickCount: (itemId: string, nextValue: number) => void;
  quickCountLockedIds?: ReadonlySet<string>;
  /** Opens the same complete Add/Edit sheet used on desktop. */
  onEdit?: (item: DisplayItem) => void;
  onAdd?: () => void;
}

const STATUS_CLASS: Record<StockStatus, string> = {
  critical: styles.statusCritical,
  low: styles.statusLow,
  good: styles.statusGood,
};

const CATEGORY_CLASS: Record<InvCat, string> = {
  housekeeping: styles.categoryHousekeeping,
  maintenance: styles.categoryMaintenance,
  breakfast: styles.categoryBreakfast,
};

interface MobileAction {
  key: SidebarAction;
  label: string;
  variant?: 'primary' | 'sage' | 'attention';
  leading?: 'arrow' | 'dot';
  badge?: number;
}

export function MobileInventoryTriage({
  lang,
  items,
  bucket,
  onBucket,
  query,
  onQuery,
  tabs,
  stockHealth,
  shelfValue,
  canManage,
  canViewFinancials,
  onAction,
  onQuickCount,
  quickCountLockedIds,
  onEdit,
  onAdd,
}: MobileInventoryTriageProps) {
  const tx = t(lang);
  const partition = useMemo(
    () => partitionMobileInventory(items, bucket, query),
    [items, bucket, query],
  );
  const countedItems = items.filter((item) => !item.uncounted);
  const orderNowCount = countedItems.filter((item) => item.status === 'critical').length;
  // Selected tab's valuation for the masthead (same basis as shelfValue).
  const activeTab = bucket !== 'all' ? tabs.find((tb) => tb.key === bucket) ?? null : null;
  const activeTabValue = activeTab
    ? items.filter((d) => inBucket(d, bucket)).reduce((s, d) => s + d.value, 0)
    : 0;
  const activeTabMissingPriceItems = activeTab
    ? missingPriceItemNames(items.filter((d) => inBucket(d, bucket)))
    : [];
  const shelfMissingPriceItems = missingPriceItemNames(items);

  const warningCopy = {
    label: tx.shelfCostsMissing,
    intro: tx.shelfValueWarningIntro,
    listLabel: tx.shelfValueWarningList,
    resolution: tx.shelfValueWarningResolution,
  };

  const actions = useMemo<MobileAction[]>(() => {
    const next: MobileAction[] = [
      {
        key: 'count',
        label: tx.startCount,
        variant: 'primary',
        leading: 'arrow',
        badge: items.length,
      },
    ];
    // Add-delivery writes stock + the received-purchase ledger — management only, same as the
    // desktop rail. openOverlay already blocks the tap for non-managers;
    // gating here too avoids showing a button that silently does nothing.
    if (canManage) {
      next.push({ key: 'delivery', label: tx.addDelivery, variant: 'sage', leading: 'arrow' });
    }
    if (canManage && canViewFinancials) {
      next.push({ key: 'close', label: tx.monthClose });
    }
    next.push({ key: 'ai', label: tx.aiHelper });
    next.push({ key: 'history', label: tx.history });
    if (canViewFinancials) {
      next.push({ key: 'reports', label: tx.reports });
      next.push({ key: 'compare', label: tx.compareMonths });
      next.push({ key: 'budgets', label: tx.budgets });
    }
    return next;
  }, [canManage, canViewFinancials, items.length, tx]);

  const filterTabs = useMemo(
    () => [
      { key: 'all' as StockBucket, label: tx.all, count: items.length },
      ...tabs.map((tab) => ({
        key: tab.key as StockBucket,
        label: compactTabLabel(tab, lang),
        count: tab.count,
      })),
    ],
    [items.length, lang, tabs, tx.all],
  );

  const actionRailRef = useRef<HTMLDivElement>(null);
  const [actionOverflow, setActionOverflow] = useState({ previous: false, next: false });
  const syncActionOverflow = useCallback(() => {
    const rail = actionRailRef.current;
    if (!rail) return;
    const previous = rail.scrollLeft > 2;
    const next = Math.ceil(rail.scrollLeft + rail.clientWidth) < rail.scrollWidth - 2;
    setActionOverflow((current) => (
      current.previous === previous && current.next === next
        ? current
        : { previous, next }
    ));
  }, []);

  useEffect(() => {
    const rail = actionRailRef.current;
    if (!rail) return;
    syncActionOverflow();
    rail.addEventListener('scroll', syncActionOverflow, { passive: true });
    window.addEventListener('resize', syncActionOverflow);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(syncActionOverflow);
    observer?.observe(rail);
    return () => {
      rail.removeEventListener('scroll', syncActionOverflow);
      window.removeEventListener('resize', syncActionOverflow);
      observer?.disconnect();
    };
  }, [actions.length, onAdd, syncActionOverflow]);

  const scrollActions = useCallback((direction: -1 | 1) => {
    const rail = actionRailRef.current;
    if (!rail) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    rail.scrollBy({
      left: direction * Math.max(180, Math.floor(rail.clientWidth * 0.72)),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, []);

  return (
    <section className={styles.mobileOnly} aria-label={tx.pageTitle}>
      <div className={styles.masthead}>
        <div className={styles.stats} aria-live="polite">
          <MobileStat label={tx.orderNow} value={String(orderNowCount)} critical />
          {/* Selected tab's total value, mirroring the desktop masthead stat. */}
          {canViewFinancials && activeTab ? (
            <MobileStat
              label={compactTabLabel(activeTab, lang)}
              value={fmtMoney(activeTabValue, { digits: 0 })}
              warning={activeTabMissingPriceItems.length > 0
                ? { ...warningCopy, itemNames: activeTabMissingPriceItems }
                : undefined}
            />
          ) : null}
          {canViewFinancials ? (
            <MobileStat
              label={tx.onTheShelf}
              value={fmtMoney(shelfValue, { digits: 0 })}
              warning={shelfMissingPriceItems.length > 0
                ? { ...warningCopy, itemNames: shelfMissingPriceItems }
                : undefined}
            />
          ) : null}
        </div>
        <MobileHealthRing lang={lang} value={stockHealth} label={tx.stockHealth} />
      </div>
      <div className={styles.hairline} aria-hidden="true" />

      <div className={styles.actionRailWrap}>
        <div ref={actionRailRef} className={styles.actionRail} role="group" aria-label={tx.do}>
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className={actionClassName(action.variant)}
              onClick={() => onAction(action.key)}
              aria-label={action.badge == null ? action.label : `${action.label}, ${action.badge}`}
            >
              {action.leading === 'arrow' ? (
                <span className={styles.actionArrow} aria-hidden="true">→</span>
              ) : null}
              {action.leading === 'dot' ? (
                <span className={styles.actionDot} aria-hidden="true" />
              ) : null}
              <span className={styles.actionLabel}>{action.label}</span>
              {action.badge != null ? (
                <span className={styles.actionBadge} aria-hidden="true">{action.badge}</span>
              ) : null}
            </button>
          ))}
          {onAdd ? (
            // Desktop always shows "+ Add item" in the filter bar; without this
            // a phone user with a non-empty catalog had NO direct add path
            // (only the empty-catalog panel wired onAdd).
            <button
              type="button"
              className={actionClassName(undefined)}
              onClick={onAdd}
              aria-label={tx.addItem}
            >
              <span className={styles.actionLabel}>{tx.addItem}</span>
            </button>
          ) : null}
        </div>
        {actionOverflow.previous ? (
          <button
            type="button"
            className={`${styles.railScrollButton} ${styles.railScrollPrevious}`}
            onClick={() => scrollActions(-1)}
            aria-label={tx.previousActions}
          >
            <span aria-hidden="true">‹</span>
          </button>
        ) : null}
        {actionOverflow.next ? (
          <button
            type="button"
            className={`${styles.railScrollButton} ${styles.railScrollNext}`}
            onClick={() => scrollActions(1)}
            aria-label={tx.moreActions}
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </div>

      <div className={styles.searchWrap}>
        <svg className={styles.searchIcon} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={tx.search}
          aria-label={tx.searchInventory}
          className={styles.searchInput}
        />
        {query ? (
          <button
            type="button"
            className={styles.clearSearch}
            onClick={() => onQuery('')}
            aria-label={tx.clearSearch}
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </div>

      <div className={styles.filterRail} role="group" aria-label={tx.pageTitle}>
        {filterTabs.map((tab) => {
          const active = bucket === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              className={styles.filterTarget}
              aria-pressed={active}
              onClick={() => onBucket(tab.key)}
            >
              <span className={active ? styles.filterChipActive : styles.filterChip}>
                <span>{tab.label}</span>
                <span className={styles.filterCount}>{tab.count}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.triageBoard}>
        {items.length === 0 ? (
          <EmptyCatalog lang={lang} onAdd={onAdd} />
        ) : partition.visibleCount === 0 ? (
          <div className={styles.noMatches} role="status">
            <span>{query.trim() ? tx.nothingMatches : tx.emptyTab}</span>
            {query.trim() ? (
              <button type="button" onClick={() => onQuery('')}>{tx.clearSearch}</button>
            ) : null}
          </div>
        ) : (
          <>
            <TriageGroup
              label={tx.colOrderNow}
              status="critical"
              items={partition.critical}
              lang={lang}
              emptyLabel={tx.nothingHere}
              onQuickCount={onQuickCount}
              quickCountLockedIds={quickCountLockedIds}
              onEdit={onEdit}
            />
            <TriageGroup
              label={tx.colOrderSoon}
              status="low"
              items={partition.low}
              lang={lang}
              emptyLabel={tx.nothingHere}
              onQuickCount={onQuickCount}
              quickCountLockedIds={quickCountLockedIds}
              onEdit={onEdit}
            />
            <TriageGroup
              label={tx.colStocked}
              status="good"
              items={partition.good}
              lang={lang}
              emptyLabel={tx.nothingHere}
              onQuickCount={onQuickCount}
              quickCountLockedIds={quickCountLockedIds}
              onEdit={onEdit}
            />
            {partition.uncounted.length > 0 ? (
              <TriageGroup
                label={tx.notCountedTitle}
                status="neutral"
                items={partition.uncounted}
                lang={lang}
                emptyLabel={tx.nothingHere}
                onQuickCount={onQuickCount}
                quickCountLockedIds={quickCountLockedIds}
                onEdit={onEdit}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function actionClassName(variant: MobileAction['variant']) {
  return [
    styles.actionButton,
    variant === 'primary' && styles.actionPrimary,
    variant === 'sage' && styles.actionSage,
    variant === 'attention' && styles.actionAttention,
  ].filter(Boolean).join(' ');
}

function compactTabLabel(tab: InvTab, lang: Lang) {
  if (tab.key === 'general') return 'General';
  if (tab.key === 'breakfast') return lang === 'es' ? 'Desayuno' : 'Breakfast';
  return tab.label;
}

function MobileStat({
  label,
  value,
  critical = false,
  warning,
}: {
  label: string;
  value: string;
  critical?: boolean;
  warning?: React.ComponentProps<typeof ShelfValueWarning>;
}) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={critical ? styles.statValueCritical : styles.statValue}>
        {value}
        {warning ? <ShelfValueWarning {...warning} /> : null}
      </span>
    </div>
  );
}

function MobileHealthRing({
  lang,
  value,
  label,
}: {
  lang: Lang;
  value: number | null;
  label: string;
}) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const circumference = 2 * Math.PI * 22.5;
  const ringClass = value == null
    ? styles.ringUnknown
    : value >= 70
      ? styles.ringGood
      : value >= 30
        ? styles.ringLow
        : styles.ringCritical;
  const shown = value == null ? '—' : `${Math.round(value)}%`;
  const ariaLabel = lang === 'es'
    ? `${label}: ${value == null ? 'sin datos' : shown}`
    : `${label}: ${value == null ? 'no data' : shown}`;

  return (
    <div className={`${styles.healthRing} ${ringClass}`} role="img" aria-label={ariaLabel}>
      <svg width="50" height="50" viewBox="0 0 50 50" aria-hidden="true">
        <circle className={styles.ringTrack} cx="25" cy="25" r="22.5" />
        <circle
          className={styles.ringArc}
          cx="25"
          cy="25"
          r="22.5"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <span className={styles.ringValue}>{shown}</span>
    </div>
  );
}

function TriageGroup({
  label,
  status,
  items,
  lang,
  emptyLabel,
  onQuickCount,
  quickCountLockedIds,
  onEdit,
}: {
  label: string;
  status: StockStatus | 'neutral';
  items: DisplayItem[];
  lang: Lang;
  emptyLabel: string;
  onQuickCount: (itemId: string, nextValue: number) => void;
  quickCountLockedIds?: ReadonlySet<string>;
  onEdit?: (item: DisplayItem) => void;
}) {
  const statusClass = status === 'neutral' ? styles.statusNeutral : STATUS_CLASS[status];
  return (
    <section className={`${styles.group} ${statusClass}`} aria-labelledby={`mobile-inv-${status}`}>
      <h2 id={`mobile-inv-${status}`} className={styles.groupHeader}>
        <span className={styles.groupDot} aria-hidden="true" />
        <span>{label}</span>
        <span className={styles.groupCount}>{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <div className={styles.groupEmpty}>{emptyLabel}</div>
      ) : (
        <ul className={styles.cardList}>
          {items.map((item) => (
            <li key={item.id}>
              <InventoryCard
                item={item}
                lang={lang}
                onQuickCount={onQuickCount}
                quickCountLocked={quickCountLockedIds?.has(item.id) ?? false}
                onEdit={onEdit}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InventoryCard({
  item,
  lang,
  onQuickCount,
  quickCountLocked,
  onEdit,
}: {
  item: DisplayItem;
  lang: Lang;
  onQuickCount: (itemId: string, nextValue: number) => void;
  quickCountLocked: boolean;
  onEdit?: (item: DisplayItem) => void;
}) {
  // Real last count, not the occupancy estimate — the +/− steppers save a new
  // physical count, so stepping off the estimate would silently rewrite the
  // count with a projection (same fix as LedgerRow.onHand on desktop).
  const onHand = Math.max(0, Math.round(item.counted));
  const par = Math.max(0, Math.round(item.par));
  // The bar shows USABLE stock (total minus set-aside) so it agrees with the
  // status color — a set-aside pile can't serve rooms.
  const usableNow = Math.max(0, onHand - item.setAside);
  const fill = par > 0 ? Math.max(0, Math.min(100, (100 * usableNow) / par)) : 100;
  const statusClass = item.uncounted ? styles.statusNeutral : STATUS_CLASS[item.status];
  const categoryClass = CATEGORY_CLASS[item.cat] ?? styles.categoryHousekeeping;
  const days = daysLabel(item);
  const stockLabel = `${onHand}/${par} · ${days}`;
  const decrease = lang === 'es'
    ? `Reducir existencias de ${item.name}`
    : `Decrease ${item.name} on hand`;
  const increase = lang === 'es'
    ? `Aumentar existencias de ${item.name}`
    : `Increase ${item.name} on hand`;
  const editLabel = lang === 'es' ? `Editar ${item.name}` : `Edit ${item.name}`;
  const savingLabel = `${t(lang).savingQuickCount}: ${item.name}`;

  return (
    <article
      className={`${styles.itemCard} ${statusClass}`}
      aria-label={`${item.name}, ${stockLabel}`}
    >
      <span className={`${styles.monogram} ${categoryClass}`} aria-hidden="true">
        {monogram(item.name)}
      </span>
      <div className={styles.itemBody}>
        <div className={styles.itemName} title={item.name}>
          {item.name}
          {item.setAside > 0 && (
            <span style={{ marginLeft: 6 }}>
              <SetAsideTag count={item.setAside} lang={lang} />
            </span>
          )}
        </div>
        <div className={styles.stockRow}>
          <span
            className={styles.stockBar}
            role="progressbar"
            aria-label={lang === 'es' ? `Existencias contra nivel ideal de ${item.name}` : `${item.name} stock versus par`}
            aria-valuemin={0}
            aria-valuemax={Math.max(1, par, onHand)}
            aria-valuenow={onHand}
            aria-valuetext={stockLabel}
          >
            <span
              className={styles.stockFill}
              style={{ '--mobile-stock-width': `${fill}%` } as React.CSSProperties}
            />
          </span>
          <span className={styles.stockCaption}>{stockLabel}</span>
        </div>
      </div>
      <div className={styles.cardControls}>
        {onEdit ? (
          <button
            type="button"
            className={styles.editButton}
            onClick={() => onEdit(item)}
            aria-label={editLabel}
          >
            {t(lang).edit}
          </button>
        ) : null}
        <div
          className={styles.stepper}
          role="group"
          aria-label={lang === 'es' ? `Conteo rápido de ${item.name}` : `Quick count ${item.name}`}
          aria-busy={quickCountLocked}
        >
          <button
            type="button"
            className={styles.stepButton}
            onClick={() => onQuickCount(item.id, Math.max(0, onHand - 1))}
            aria-label={decrease}
            disabled={quickCountLocked || onHand === 0}
          >
            <span aria-hidden="true">−</span>
          </button>
          <span className={styles.stepValue} aria-live="polite">
            {quickCountLocked ? (
              <span className={styles.quickSaving} role="status" aria-label={savingLabel}>
                <span aria-hidden="true" />
              </span>
            ) : onHand}
          </span>
          <button
            type="button"
            className={`${styles.stepButton} ${styles.stepButtonPlus}`}
            onClick={() => onQuickCount(item.id, onHand + 1)}
            aria-label={increase}
            disabled={quickCountLocked}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>
    </article>
  );
}

function daysLabel(item: DisplayItem) {
  if (item.uncounted || item.burnSource === 'fallback-60d' || item.burnSource === 'no-data') return '—';
  if (item.daysLeft >= 90) return '90+d';
  return `${Math.max(0, Math.round(item.daysLeft))}d`;
}

function EmptyCatalog({ lang, onAdd }: { lang: Lang; onAdd?: () => void }) {
  const tx = t(lang);
  return (
    <div className={styles.emptyCatalog} role="status">
      {/* Neutral mark — a hardcoded "HK" here read as a housekeeping tag on
          hotels that don't even show the built-in categories. */}
      <span className={styles.emptyIcon} aria-hidden="true">▢</span>
      <strong>{tx.noItemsYet}</strong>
      <span>{tx.noItemsBody}</span>
      {onAdd ? (
        <button type="button" onClick={onAdd}>{tx.addItem.replace(/^\+\s*/, '')}</button>
      ) : null}
    </div>
  );
}
