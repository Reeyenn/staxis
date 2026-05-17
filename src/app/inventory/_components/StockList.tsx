'use client';

import React, { useMemo } from 'react';
import { T, fonts, catLabel, type InvCat, type StockBucket } from './tokens';
import { CatIcon } from './CatIcon';
import { ItemRow } from './ItemRow';
import type { DisplayItem } from './types';

interface StockListProps {
  items: DisplayItem[];
  bucket: StockBucket;
  query: string;
  onItemClick?: (item: DisplayItem) => void;
}

export function StockList({ items, bucket, query, onItemClick }: StockListProps) {
  const filtered = useMemo(() => {
    const inBucket = (it: DisplayItem) =>
      bucket === 'breakfast' ? it.cat === 'breakfast' : it.cat !== 'breakfast';
    const q = query.trim().toLowerCase();
    return items
      .filter(inBucket)
      .filter((it) => {
        if (!q) return true;
        const hay = `${it.name} ${it.vendor} ${it.id}`.toLowerCase();
        return hay.includes(q);
      })
      .slice()
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [items, bucket, query]);

  const total = filtered.length;
  const cats: InvCat[] =
    bucket === 'breakfast' ? ['breakfast'] : ['housekeeping', 'maintenance'];

  return (
    <section>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 14,
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <h2
          style={{
            fontFamily: fonts.serif,
            fontSize: 24,
            color: T.ink,
            margin: 0,
            letterSpacing: '-0.02em',
            fontWeight: 400,
            lineHeight: 1.15,
          }}
        >
          <span style={{ fontStyle: 'italic' }}>
            {total} {total === 1 ? 'item' : 'items'}
          </span>
        </h2>
      </div>

      {cats.map((cat) => {
        const catItems = filtered.filter((it) => it.cat === cat);
        if (catItems.length === 0) return null;
        return <CategorySection key={cat} cat={cat} items={catItems} onClick={onItemClick} />;
      })}

      {total === 0 && (
        <div
          style={{
            background: T.paper,
            border: `1px solid ${T.rule}`,
            borderRadius: 14,
            padding: '48px 24px',
            textAlign: 'center',
          }}
        >
          <span
            style={{
              fontFamily: fonts.serif,
              fontSize: 22,
              color: T.ink2,
              fontStyle: 'italic',
            }}
          >
            Nothing matches.
          </span>
        </div>
      )}
    </section>
  );
}

function CategorySection({
  cat,
  items,
  onClick,
}: {
  cat: InvCat;
  items: DisplayItem[];
  onClick?: (item: DisplayItem) => void;
}) {
  return (
    <section style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
          padding: '0 4px',
        }}
      >
        <CatIcon cat={cat} size={24} />
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 15,
            color: T.ink,
            fontWeight: 600,
            letterSpacing: '-0.01em',
          }}
        >
          {catLabel[cat]}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            color: T.ink3,
            letterSpacing: '0.04em',
          }}
        >
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
        <span style={{ flex: 1, height: 1, background: T.rule }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {items.map((it) => (
          <ItemRow key={it.id} it={it} onClick={onClick} />
        ))}
      </div>
    </section>
  );
}
