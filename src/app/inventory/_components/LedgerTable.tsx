'use client';

import React, { useMemo, useState } from 'react';
import {
  T,
  fonts,
  statusColor,
  statusText,
  statusTint,
  catGlyph,
  type StockStatus,
  type StockBucket,
} from './tokens';
import { Thumb } from './ItemThumb';
import { StockBar } from './StockBar';
import { Caps } from './Caps';
import { Btn } from './Btn';
import { StatusDot } from './StatusPill';
import { NoItemsPanel } from './NoItemsPanel';
import { useBucketFilter, daysSortValue } from './list-helpers';
import { fmtMoney, fmtInt } from './format';
import { useFlipList } from './motion';
import type { DisplayItem } from './types';
import { t, statusLabelFor, type Lang, type InvStrings } from './inv-i18n';

// ── The Ledger ──────────────────────────────────────────────────────────────
// One sortable table of every item with a −/+ quick-count stepper on each row.
// Replaces the 3-column triage board (StockList). Adjusting a count updates the
// row's pill/bar/days/value AND the masthead ring live — the draft state lives
// in InventoryShell and is fed back here as draft-applied DisplayItems, so this
// component stays pure over its `items` prop. See the handoff bundle
// "Inventory Ledger" and README for the spec.

type SortKey = 'days' | 'stock' | 'name' | 'value';
type SortDir = 1 | -1;

interface LedgerTableProps {
  lang: Lang;
  /** Draft-applied display items (all items, pre-filter). */
  items: DisplayItem[];
  bucket: StockBucket;
  query: string;
  canViewFinancials: boolean;
  /** Open the Add/Edit sheet for a row (click anywhere outside the stepper). */
  onEdit?: (item: DisplayItem) => void;
  /** Persist a single-item quick count (debounced save lives in the shell). */
  onQuickCount: (itemId: string, nextValue: number) => void;
  /** Items whose exact request is in flight or has an ambiguous result. */
  quickCountLockedIds?: ReadonlySet<string>;
  /** Open the full Count overlay (empty / not-counted CTAs). */
  onCount?: () => void;
  /** Open the Add-item sheet (empty-catalog CTA). */
  onAdd?: () => void;
}

// Grid template — 7 columns with the money-gated Value column, 6 without.
const GRID_WITH_VALUE = 'minmax(230px,1.5fr) 92px minmax(150px,1fr) 148px 86px 64px 80px';
const GRID_NO_VALUE = 'minmax(230px,1.5fr) 92px minmax(150px,1fr) 148px 86px 64px';

// Shared base for the status pill in a row — the counted and not-counted
// variants differ only in colours (and the counted one adds a colour
// transition), so the layout/type styling lives here once.
const STATUS_PILL: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 9px 2px 7px',
  borderRadius: 999,
  fontFamily: fonts.mono,
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  justifySelf: 'start',
};

// Honesty rule (mirrors BoardCard.daysLeftLabel): only ml / rule-occupancy
// items show a real number; a par/60 fallback or no-data item is not a
// forecast, so its Days cell is an em-dash. Compact form for the Days column.
function daysLabel(d: DisplayItem): string {
  if (d.uncounted) return '—';
  if (d.burnSource === 'fallback-60d' || d.burnSource === 'no-data') return '—';
  if (d.daysLeft >= 90) return '90+d';
  return `${d.daysLeft}d`;
}

function stockRatio(d: DisplayItem): number {
  return d.par > 0 ? Math.round(d.estimated) / d.par : Infinity;
}

export function LedgerTable({
  lang,
  items,
  bucket,
  query,
  canViewFinancials,
  onEdit,
  onQuickCount,
  quickCountLockedIds,
  onCount,
  onAdd,
}: LedgerTableProps) {
  const tx = t(lang);
  const [sortKey, setSortKey] = useState<SortKey>('days');
  const [sortDir, setSortDir] = useState<SortDir>(1);
  // Rows glide when the sort/filter reorders them, and a newly-added item slides
  // in from the left + scrolls into view (same feel as the add-staff board) so
  // you can see what landed where. See useFlipList.
  const rowsRef = useFlipList<HTMLDivElement>({ revealNew: true });

  // Never-counted items are pulled out of triage (a 0-stock seeded item would
  // otherwise read as red "Order now"), parked at the bottom with a neutral
  // pill, and excluded from the live summary counts.
  const { counted, uncounted } = useBucketFilter(items, bucket, query);

  const rows = useMemo(() => {
    const cmp = (a: DisplayItem, b: DisplayItem): number => {
      switch (sortKey) {
        case 'days': return daysSortValue(a) - daysSortValue(b);
        case 'stock': return stockRatio(a) - stockRatio(b);
        case 'name': return a.name.localeCompare(b.name);
        case 'value': return a.estimated * a.unitCost - b.estimated * b.unitCost;
      }
    };
    const sortedCounted = [...counted].sort((a, b) => cmp(a, b) * sortDir);
    const sortedUncounted = [...uncounted].sort((a, b) => a.name.localeCompare(b.name));
    return [...sortedCounted, ...sortedUncounted];
  }, [counted, uncounted, sortKey, sortDir]);

  // Live triage summary over what's currently in view (counted rows only).
  const summary = useMemo(() => {
    const acc: Record<StockStatus, number> = { good: 0, low: 0, critical: 0 };
    for (const d of counted) acc[d.status] += 1;
    return acc;
  }, [counted]);

  // Empty catalog (no inventory items at all) → single "add your first item"
  // panel, short-circuiting ahead of any filtering so switching buckets on an
  // empty catalog can't surface a bare header.
  if (items.length === 0) {
    return <NoItemsPanel lang={lang} onAdd={onAdd} />;
  }

  const grid = canViewFinancials ? GRID_WITH_VALUE : GRID_NO_VALUE;
  // Brand-new hotel: items exist but none counted yet (in the unfiltered All
  // view) → nudge toward the first count.
  const dayOne = counted.length === 0 && uncounted.length > 0 && bucket === 'all' && !query.trim();

  const SORTS: Array<{ key: SortKey; label: string }> = [
    { key: 'days', label: tx.sortDays },
    { key: 'stock', label: tx.sortStock },
    { key: 'name', label: tx.sortAZ },
    ...(canViewFinancials ? [{ key: 'value' as const, label: tx.sortValue }] : []),
  ];

  const clickSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };

  const summaryLabel =
    `${summary.critical} ${tx.colOrderNow.toLowerCase()} · ` +
    `${summary.low} ${tx.colOrderSoon.toLowerCase()} · ` +
    `${summary.good} ${tx.colStocked.toLowerCase()}`;

  return (
    <div>
      <style>{`.inv-ledger-row{transition:background .2s ease}.inv-ledger-row:hover{background:rgba(158,183,166,.08)}`}</style>

      {/* Toolbar row 2 — sort chips + live summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Caps size={9}>{tx.sort}</Caps>
        {SORTS.map((s) => {
          const active = sortKey === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => clickSort(s.key)}
              style={{
                height: 30,
                padding: '0 13px',
                borderRadius: 999,
                border: `1px solid ${active ? 'rgba(92,122,96,.35)' : 'rgba(31,35,28,.12)'}`,
                background: active ? 'rgba(158,183,166,.25)' : 'transparent',
                color: active ? T.forestText : T.ink2,
                fontFamily: fonts.sans,
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background .2s ease, color .2s ease, border-color .2s ease',
              }}
            >
              {s.label}
            </button>
          );
        })}
        <span style={{ marginLeft: 'auto', fontFamily: fonts.mono, fontSize: 10, color: T.dim }}>
          {summaryLabel}
        </span>
      </div>

      {dayOne && (
        <div
          style={{
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 12,
            background: T.inkWash,
            border: `1px solid ${T.rule}`,
            fontFamily: fonts.sans,
            fontSize: 12.5,
            color: T.ink2,
          }}
        >
          {tx.notCountedHint}
        </div>
      )}

      {/* The ledger card */}
      <div
        style={{
          background: T.paper,
          border: `1px solid ${T.rule}`,
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 6px 16px -14px rgba(31,42,32,.35)',
        }}
      >
        <div ref={rowsRef} style={{ overflowX: 'auto' }}>
          {/* Header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: grid,
              gap: 14,
              alignItems: 'center',
              padding: '11px 18px',
              borderBottom: `1px solid ${T.rule}`,
              background: 'rgba(31,35,28,.02)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}
          >
            <HeaderCell>{tx.colItem}</HeaderCell>
            <HeaderCell>{tx.colStatus}</HeaderCell>
            <HeaderCell>{tx.colStockVsPar}</HeaderCell>
            <HeaderCell align="center">{tx.colOnHand}</HeaderCell>
            <HeaderCell>{tx.colPar}</HeaderCell>
            <HeaderCell>{tx.colDays}</HeaderCell>
            {canViewFinancials && <HeaderCell align="right">{tx.colValue}</HeaderCell>}
          </div>

          {rows.length === 0 ? (
            <div
              style={{
                padding: '32px 18px',
                textAlign: 'center',
                fontFamily: fonts.sans,
                fontSize: 13,
                color: T.dim,
              }}
            >
              {tx.nothingMatches}
            </div>
          ) : (
            rows.map((d) => (
              <LedgerRow
                key={d.id}
                d={d}
                grid={grid}
                lang={lang}
                tx={tx}
                canViewFinancials={canViewFinancials}
                onEdit={onEdit}
                onQuickCount={onQuickCount}
                quickCountLocked={quickCountLockedIds?.has(d.id) ?? false}
              />
            ))
          )}
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: 10 }}>
        <Caps size={8.5}>{tx.ledgerHint}</Caps>
      </div>

      {/* Not-counted items keep a way to reach the full count flow. */}
      {onCount && uncounted.length > 0 && !dayOne && (
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <Btn variant="ghost" size="sm" onClick={onCount}>
            {tx.countInventory}
          </Btn>
        </div>
      )}
    </div>
  );
}

function HeaderCell({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
}) {
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 8.5,
        fontWeight: 600,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: T.faint,
        textAlign: align,
      }}
    >
      {children}
    </span>
  );
}

function LedgerRow({
  d,
  grid,
  lang,
  tx,
  canViewFinancials,
  onEdit,
  onQuickCount,
  quickCountLocked,
}: {
  d: DisplayItem;
  grid: string;
  lang: Lang;
  tx: InvStrings;
  canViewFinancials: boolean;
  onEdit?: (item: DisplayItem) => void;
  onQuickCount: (itemId: string, nextValue: number) => void;
  quickCountLocked: boolean;
}) {
  const uncounted = d.uncounted;
  const have = Math.max(0, Math.round(d.estimated));
  const c = uncounted ? T.dim : statusText[d.status];

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className="inv-ledger-row"
      data-flip-id={d.id}
      onClick={() => onEdit?.(d)}
      style={{
        display: 'grid',
        gridTemplateColumns: grid,
        gap: 14,
        alignItems: 'center',
        padding: '9px 18px',
        borderBottom: `1px solid ${T.ruleFaint}`,
        cursor: onEdit ? 'pointer' : 'default',
      }}
    >
      {/* Item */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Thumb name={d.name} cat={d.cat} size={30} radius={9} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {d.name}
          </div>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 8.5,
              letterSpacing: '0.04em',
              color: T.faint,
            }}
          >
            {catGlyph[d.cat]} · {d.vendor || '—'}
          </span>
        </div>
      </div>

      {/* Status */}
      {uncounted ? (
        <span
          style={{
            ...STATUS_PILL,
            background: T.inkWash,
            color: T.dim,
            border: `1px solid ${T.rule}`,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.dim }} />
          {tx.notCountedPill}
        </span>
      ) : (
        <span
          style={{
            ...STATUS_PILL,
            background: statusTint[d.status],
            color: statusText[d.status],
            border: `1px solid ${statusColor[d.status]}33`,
            transition: 'background .3s ease, color .3s ease',
          }}
        >
          <StatusDot s={d.status} size={6} />
          {statusLabelFor(lang, d.status)}
        </span>
      )}

      {/* Stock vs par */}
      <StockBar
        current={have}
        par={d.par}
        status={d.status}
        height={6}
        showPar={false}
        neutral={uncounted}
      />

      {/* On hand · quick count */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <StepBtn
          kind="minus"
          disabled={quickCountLocked}
          onClick={(e) => { stop(e); onQuickCount(d.id, have - 1); }}
        />
        <span
          style={{
            width: 44,
            textAlign: 'center',
            fontFamily: fonts.sans,
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: c,
            transition: 'color .3s ease',
          }}
        >
          {have}
        </span>
        <StepBtn
          kind="plus"
          disabled={quickCountLocked}
          onClick={(e) => { stop(e); onQuickCount(d.id, have + 1); }}
        />
      </div>

      {/* Par */}
      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.dim }}>
        {fmtInt(d.par)} {d.unit}
      </span>

      {/* Days */}
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 11.5,
          fontWeight: 600,
          color: c,
          transition: 'color .3s ease',
        }}
      >
        {daysLabel(d)}
      </span>

      {/* Value (money-gated) — valuation of the on-hand quantity shown in this
          row (have × unit cost), so the two money-adjacent cells never disagree. */}
      {canViewFinancials && (
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 12,
            fontWeight: 600,
            textAlign: 'right',
          }}
        >
          {fmtMoney(have * d.unitCost)}
        </span>
      )}
    </div>
  );
}

// −/+ stepper button. Minus = white hairline chip; plus = sage-wash chip that
// fills solid brand on hover (matches the handoff's row stepper spec).
function StepBtn({
  kind,
  onClick,
  disabled = false,
}: {
  kind: 'minus' | 'plus';
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
}) {
  const plus = kind === 'plus';
  const base: React.CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: 8,
    padding: 0,
    lineHeight: 1,
    fontSize: 14,
    fontFamily: fonts.sans,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    transition: 'background .18s ease, color .18s ease, border-color .18s ease',
    border: plus ? '1px solid rgba(92,122,96,.35)' : `1px solid rgba(31,35,28,.12)`,
    background: plus ? T.tealDim : T.bg,
    color: plus ? T.tealText : T.ink,
  };
  return (
    <button
      type="button"
      aria-label={plus ? '+1' : '-1'}
      onClick={onClick}
      disabled={disabled}
      style={base}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (plus) { e.currentTarget.style.background = T.brand; e.currentTarget.style.color = '#fff'; }
        else e.currentTarget.style.background = T.inkWash;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        if (plus) { e.currentTarget.style.background = T.tealDim; e.currentTarget.style.color = T.tealText; }
        else e.currentTarget.style.background = T.bg;
      }}
    >
      {plus ? '+' : '−'}
    </button>
  );
}
