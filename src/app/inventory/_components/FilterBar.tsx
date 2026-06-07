'use client';

import React from 'react';
import { T, fonts, type StockBucket } from './tokens';
import { Btn } from './Btn';

interface FilterBarProps {
  bucket: StockBucket;
  onBucket: (b: StockBucket) => void;
  query: string;
  onQuery: (q: string) => void;
  allCount: number;
  generalCount: number;
  breakfastCount: number;
  onAdd: () => void;
}

export function FilterBar({
  bucket,
  onBucket,
  query,
  onQuery,
  allCount,
  generalCount,
  breakfastCount,
  onAdd,
}: FilterBarProps) {
  const segments: Array<{ key: StockBucket; label: string; count: number }> = [
    { key: 'all', label: 'All', count: allCount },
    { key: 'general', label: 'General inventory', count: generalCount },
    { key: 'breakfast', label: 'Breakfast inventory', count: breakfastCount },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {/* Bucket toggle — one segmented control, segments split by hairlines */}
      <div
        style={{
          display: 'inline-flex',
          border: `1px solid ${T.rule}`,
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        {segments.map((seg, i) => {
          const active = bucket === seg.key;
          return (
            <button
              key={seg.key}
              type="button"
              onClick={() => onBucket(seg.key)}
              style={{
                padding: '9px 15px',
                cursor: 'pointer',
                background: active ? T.ink : T.bg,
                color: active ? T.bg : T.ink2,
                border: 'none',
                borderLeft: i ? `1px solid ${T.rule}` : 'none',
                fontFamily: fonts.sans,
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {seg.label}
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  color: active ? 'rgba(255,255,255,0.6)' : T.dim,
                }}
              >
                {seg.count}
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
          height: 38,
          padding: '0 13px',
          borderRadius: 9,
          background: T.bg,
          border: `1px solid ${T.rule}`,
          fontFamily: fonts.sans,
          fontSize: 13,
          color: T.ink,
          outline: 'none',
        }}
      />
      <Btn variant="ghost" size="md" onClick={onAdd}>
        + Add item
      </Btn>
    </div>
  );
}
