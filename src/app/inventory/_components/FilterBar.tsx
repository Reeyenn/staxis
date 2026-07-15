'use client';

import React from 'react';
import { T, fonts, type StockBucket } from './tokens';
import { Btn } from './Btn';
import { t, type Lang } from './inv-i18n';
import { InventoryTabs, type InvTab } from './InventoryTabs';

export type InventoryView = 'ledger' | 'board';

interface FilterBarProps {
  lang: Lang;
  bucket: StockBucket;
  onBucket: (b: StockBucket) => void;
  query: string;
  onQuery: (q: string) => void;
  allCount: number;
  /** Ordered, visible filter tabs (excludes All + hidden built-ins). */
  tabs: InvTab[];
  /** Built-in tabs the hotel removed — offered for re-adding in edit mode. */
  hiddenBuiltins: InvTab[];
  /** Only management can rearrange / add / remove tabs. */
  canManage: boolean;
  onReorder: (keys: string[]) => void;
  onRemove: (key: string) => void;
  onRestore: (key: string) => void;
  onAddCategory: (name: string) => void;
  view: InventoryView;
  onView: (v: InventoryView) => void;
  onAdd: () => void;
}

export function FilterBar({
  lang,
  bucket,
  onBucket,
  query,
  onQuery,
  allCount,
  tabs,
  hiddenBuiltins,
  canManage,
  onReorder,
  onRemove,
  onRestore,
  onAddCategory,
  view,
  onView,
  onAdd,
}: FilterBarProps) {
  const tx = t(lang);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <InventoryTabs
        lang={lang}
        allCount={allCount}
        bucket={bucket}
        onBucket={onBucket}
        tabs={tabs}
        hiddenBuiltins={hiddenBuiltins}
        canManage={canManage}
        onReorder={onReorder}
        onRemove={onRemove}
        onRestore={onRestore}
        onAdd={onAddCategory}
      />

      <input
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={tx.search}
        className="inv-search"
        style={{
          flex: 1, minWidth: 140, height: 38, padding: '0 16px', borderRadius: 999,
          background: T.bg, border: `1px solid ${T.rule}`, fontFamily: fonts.sans, fontSize: 13, color: T.ink, outline: 'none',
        }}
      />

      {/* View switch — Ledger table ↔ triage board. */}
      <div style={{ display: 'inline-flex', border: `1px solid ${T.rule}`, borderRadius: 999, padding: 3, background: T.bg, flexShrink: 0 }}>
        {(['ledger', 'board'] as const).map((v) => {
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              aria-pressed={active}
              style={{
                padding: '7px 13px', cursor: 'pointer', background: active ? T.ink : 'transparent', color: active ? T.bg : T.ink2,
                border: 'none', borderRadius: 999, fontFamily: fonts.sans, fontSize: 12.5, fontWeight: active ? 600 : 500,
                transition: 'background .18s ease, color .18s ease',
              }}
            >
              {v === 'ledger' ? tx.viewLedger : tx.viewBoard}
            </button>
          );
        })}
      </div>
      <Btn variant="ghost" size="md" onClick={onAdd}>{tx.addItem}</Btn>
    </div>
  );
}
