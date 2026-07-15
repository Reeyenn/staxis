'use client';

import React, { useState } from 'react';
import { T, fonts, type StockBucket } from './tokens';
import { Btn } from './Btn';
import { TickNum } from './fx';
import { t, type Lang } from './inv-i18n';
import type { InventoryCustomCategory } from '@/types';

export type InventoryView = 'ledger' | 'board';

interface FilterBarProps {
  lang: Lang;
  bucket: StockBucket;
  onBucket: (b: StockBucket) => void;
  query: string;
  onQuery: (q: string) => void;
  allCount: number;
  generalCount: number;
  breakfastCount: number;
  /** Hotel-defined category tabs (0307). */
  customCategories: InventoryCustomCategory[];
  /** Item count per custom category id. */
  customCounts: Record<string, number>;
  /** Only management can add / remove tabs. */
  canManage: boolean;
  onAddCategory: (name: string) => void;
  onDeleteCategory: (id: string) => void;
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
  generalCount,
  breakfastCount,
  customCategories,
  customCounts,
  canManage,
  onAddCategory,
  onDeleteCategory,
  view,
  onView,
  onAdd,
}: FilterBarProps) {
  const tx = t(lang);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const builtins: Array<{ key: StockBucket; label: string; count: number }> = [
    { key: 'all', label: tx.all, count: allCount },
    { key: 'general', label: tx.generalInventory, count: generalCount },
    { key: 'breakfast', label: tx.breakfastInventory, count: breakfastCount },
  ];

  // Enter commits (once); Escape or clicking away cancels — blur never
  // auto-creates, so cancelling can't accidentally add a tab. commit() clears
  // state first so the unmount blur that follows is a no-op cancel.
  const commitNew = () => {
    const name = newName.trim();
    setNewName('');
    setAdding(false);
    if (name) onAddCategory(name);
  };
  const cancelNew = () => {
    setNewName('');
    setAdding(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {/* Bucket tabs — built-in + hotel-defined custom categories + add */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {builtins.map((seg) => (
          <BucketChip key={seg.key} active={bucket === seg.key} label={seg.label} count={seg.count} onClick={() => onBucket(seg.key)} />
        ))}
        {customCategories.map((c) => {
          const key: StockBucket = `custom:${c.id}`;
          const active = bucket === key;
          return (
            <BucketChip
              key={c.id}
              active={active}
              label={c.name}
              count={customCounts[c.id] ?? 0}
              onClick={() => onBucket(key)}
              onRemove={
                canManage && active
                  ? () => {
                      if (confirm(tx.removeTabConfirm)) onDeleteCategory(c.id);
                    }
                  : undefined
              }
              removeLabel={tx.removeTab}
            />
          );
        })}

        {/* Add a tab */}
        {canManage && (adding ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitNew(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelNew(); }
              }}
              onBlur={cancelNew}
              placeholder={tx.newTabPh}
              maxLength={40}
              style={{
                height: 34, width: 150, padding: '0 12px', borderRadius: 999,
                background: T.bg, border: `1px solid ${T.ink}`, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink, outline: 'none',
              }}
            />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={tx.addTab}
            title={tx.addTab}
            style={{
              width: 34, height: 34, borderRadius: 999, cursor: 'pointer',
              background: 'transparent', color: T.ink2, border: `1px dashed ${T.rule}`,
              fontFamily: fonts.sans, fontSize: 18, fontWeight: 500, lineHeight: 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ＋
          </button>
        ))}
      </div>

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

function BucketChip({
  active, label, count, onClick, onRemove, removeLabel,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center',
        background: active ? T.ink : 'transparent',
        border: `1px solid ${active ? T.ink : T.rule}`,
        borderRadius: 999,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: onRemove ? '7px 6px 7px 14px' : '7px 14px',
          background: 'transparent', border: 'none', borderRadius: 999, cursor: 'pointer',
          color: active ? T.bg : T.ink2, fontFamily: fonts.sans, fontSize: 12.5, fontWeight: active ? 600 : 500,
        }}
      >
        {label}
        <span style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: active ? 'rgba(255,255,255,0.6)' : T.dim }}>
          <TickNum>{count}</TickNum>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          style={{
            padding: '0 10px 0 4px', background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.6)', fontFamily: fonts.sans, fontSize: 14, lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </span>
  );
}
