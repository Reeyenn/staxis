'use client';

import React from 'react';
import {
  T,
  fonts,
  statusColor,
  statusText,
  statusTint,
  type StockStatus,
  type StockBucket,
} from './tokens';
import { StatusDot } from './StatusPill';
import { Serif } from './Serif';
import { Caps } from './Caps';
import { NoItemsPanel } from './NoItemsPanel';
import { useBucketFilter, daysSortValue } from './list-helpers';
import { useFlipList } from './motion';
import { AllClear, PingDot, TickNum } from './fx';
import { BoardCard } from './BoardCard';
import type { DisplayItem } from './types';
import { t, type Lang } from './inv-i18n';

interface StockListProps {
  lang: Lang;
  items: DisplayItem[];
  bucket: StockBucket;
  query: string;
  onEdit?: (item: DisplayItem) => void;
  onCount?: () => void;
  onAdd?: () => void;
}

function columnsFor(lang: Lang): Array<{ status: StockStatus; label: string; sub: string }> {
  const tx = t(lang);
  return [
    { status: 'critical', label: tx.colOrderNow, sub: tx.subBelowHalfPar },
    { status: 'low', label: tx.colOrderSoon, sub: tx.subUnderPar },
    { status: 'good', label: tx.colStocked, sub: tx.subAtOrAbovePar },
  ];
}

export function StockList({ lang, items, bucket, query, onEdit, onCount, onAdd }: StockListProps) {
  const tx = t(lang);
  const COLUMNS = columnsFor(lang);
  // Never-counted items are pulled OUT of the triage columns (where a 0-stock
  // seeded item would otherwise read as red "Order now") into a neutral
  // "not counted yet" section. Counted items keep the normal triage.
  const { counted, uncounted } = useBucketFilter(items, bucket, query);

  // FLIP over every card on the board: filtering/searching glides the
  // survivors into place, new cards rise in with a cascade, and an item that
  // changes triage column after a recount physically travels there.
  const boardRef = useFlipList<HTMLDivElement>({ revealNew: true });

  // Brand-new hotel (nothing counted at all, in the unfiltered "All" view) →
  // skip the empty triage board and show only the friendly "count to get
  // started" panel. A filtered-empty bucket on an established hotel keeps the
  // normal empty columns (scoped so the day-1 CTA never shows there).
  const dayOne = counted.length === 0 && bucket === 'all' && !query.trim();

  // Empty catalog (no inventory items at all) → skip the board AND the
  // not-counted section entirely and show a single "add your first item" panel.
  // Short-circuits ahead of any bucket/query filtering so switching filters on
  // an empty catalog can't surface bare triage columns. Distinct from `dayOne`
  // above, which is "items exist but none counted yet" (keeps the board + the
  // not-counted section). Guard sits after every hook so hook order is stable.
  if (items.length === 0) {
    return <NoItemsPanel lang={lang} onAdd={onAdd} />;
  }

  return (
    <div ref={boardRef} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!dayOne && (
        <div className="inv-board">
          {COLUMNS.map((col) => {
            const c = statusColor[col.status];
            const colItems = counted
              .filter((it) => it.status === col.status)
              .slice()
              .sort((a, b) => daysSortValue(a) - daysSortValue(b));
            const urgent = col.status === 'critical' && colItems.length > 0;
            return (
              <div
                key={col.status}
                style={{
                  background: statusTint[col.status],
                  borderRadius: 15,
                  padding: 12,
                  border: `1px solid ${c}22`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 12px' }}>
                  {urgent
                    ? <PingDot color={c} size={10} />
                    : <StatusDot s={col.status} size={10} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 700, color: statusText[col.status] }}>
                      {col.label}
                    </div>
                    <Caps size={8.5} color={T.dim}>{col.sub}</Caps>
                  </div>
                  <Serif size={24} color={statusText[col.status]}>
                    <TickNum>{colItems.length}</TickNum>
                  </Serif>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {colItems.map((it) => (
                    <BoardCard key={it.id} lang={lang} it={it} onEdit={onEdit} />
                  ))}
                  {colItems.length === 0 && (
                    col.status === 'critical' ? (
                      // The one empty state that is good news — celebrate it.
                      <AllClear label={tx.allClear} sub={tx.allClearSub} />
                    ) : (
                      <div
                        style={{
                          padding: '22px 0',
                          textAlign: 'center',
                          fontFamily: fonts.sans,
                          fontSize: 12.5,
                          color: T.dim,
                        }}
                      >
                        {tx.nothingHere}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {uncounted.length > 0 && (
        <NotCountedSection
          lang={lang}
          items={uncounted}
          dayOne={dayOne}
          onEdit={onEdit}
          onCount={onCount}
        />
      )}
    </div>
  );
}

// Neutral "not counted yet" group — brand-new items with no physical count.
// Rendered grey (never red), excluded from the triage columns above.
function NotCountedSection({
  lang, items, dayOne, onEdit, onCount,
}: {
  lang: Lang;
  items: DisplayItem[];
  dayOne: boolean;
  onEdit?: (item: DisplayItem) => void;
  onCount?: () => void;
}) {
  const tx = t(lang);
  return (
    <div style={{ background: T.inkWash, borderRadius: 15, padding: 12, border: `1px solid ${T.rule}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 12px', flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: T.dim, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 700, color: T.ink2 }}>
            {tx.notCountedTitle}
          </div>
          <Caps size={8.5} color={T.dim}>{tx.notCountedSub}</Caps>
        </div>
        <Serif size={24} color={T.ink3}>
          <TickNum>{items.length}</TickNum>
        </Serif>
        {onCount && (
          <button
            type="button"
            onClick={onCount}
            style={{
              border: 'none', borderRadius: 999, padding: '7px 14px', cursor: 'pointer',
              background: T.brand, color: '#fff', fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {tx.countInventory}
          </button>
        )}
      </div>
      {dayOne && (
        <div style={{ padding: '0 6px 12px', fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
          {tx.notCountedHint}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 9 }}>
        {items.map((it) => (
          <BoardCard key={it.id} lang={lang} it={it} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
}
