'use client';

import React from 'react';
import { T, fonts } from './tokens';
import { Btn } from './Btn';
import type { StockBucket } from './tokens';

interface FilterBarProps {
  bucket: StockBucket;
  onBucket: (b: StockBucket) => void;
  query: string;
  onQuery: (q: string) => void;
  generalCount: number;
  breakfastCount: number;
  onAdd: () => void;
}

export function FilterBar({
  bucket,
  onBucket,
  query,
  onQuery,
  generalCount,
  breakfastCount,
  onAdd,
}: FilterBarProps) {
  const buckets: Array<{ key: StockBucket; label: string; count: number }> = [
    { key: 'general', label: 'General inventory', count: generalCount },
    { key: 'breakfast', label: 'Breakfast inventory', count: breakfastCount },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {buckets.map((b) => {
          const active = bucket === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => onBucket(b.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                cursor: 'pointer',
                background: active ? T.ink : T.paper,
                color: active ? T.bg : T.ink2,
                border: `1px solid ${active ? T.ink : T.rule}`,
                fontFamily: fonts.sans,
                fontSize: 12,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {b.label}
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  fontWeight: 600,
                  color: active ? 'rgba(255,255,255,0.7)' : T.ink3,
                }}
              >
                {b.count}
              </span>
            </button>
          );
        })}
      </div>
      <input
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search…"
        style={{
          flex: 1,
          minWidth: 140,
          height: 32,
          padding: '0 12px',
          borderRadius: 8,
          background: T.paper,
          border: `1px solid ${T.rule}`,
          fontFamily: fonts.sans,
          fontSize: 13,
          color: T.ink,
          outline: 'none',
        }}
      />
      <Btn variant="ghost" size="sm" onClick={onAdd}>
        + Add item
      </Btn>
    </div>
  );
}
