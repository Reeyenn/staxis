'use client';

import React from 'react';
import { T, fonts, statusColor } from './tokens';
import { Caps } from './Caps';
import { fmtMoney, fmtInt, shortMonthDay } from './format';
import type { DisplayItem } from './types';

interface HeroStatsProps {
  items: DisplayItem[];
  lastCount: { date: Date; by: string } | null;
}

export function HeroStats({ items, lastCount }: HeroStatsProps) {
  const total = items.length;
  const goodCount = items.filter((i) => i.status === 'good').length;
  const stockHealthPct = total > 0 ? Math.round((100 * goodCount) / total) : 0;
  const totalValue = items.reduce((s, i) => s + i.value, 0);

  const stats: Array<{ eyebrow: string; big: string; sub: string; accent?: string }> = [
    {
      eyebrow: 'Stock health',
      big: `${stockHealthPct}%`,
      sub: total > 0
        ? `${fmtInt(goodCount)} of ${fmtInt(total)} items have enough`
        : 'No items yet',
      accent: statusColor.good,
    },
    {
      eyebrow: 'On the shelf',
      big: fmtMoney(totalValue),
      sub: `What everything's worth today`,
    },
    {
      eyebrow: 'Last counted',
      big: lastCount ? shortMonthDay(lastCount.date) : '—',
      sub: lastCount
        ? `${daysAgoLabel(lastCount.date)} by ${lastCount.by || 'team'}`
        : 'No count yet',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 10,
        marginBottom: 16,
      }}
    >
      {stats.map((s, i) => (
        <div
          key={i}
          style={{
            background: T.paper,
            border: `1px solid ${T.rule}`,
            borderRadius: 14,
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Caps size={9}>{s.eyebrow}</Caps>
            {s.accent && (
              <span
                style={{
                  display: 'inline-block',
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: s.accent,
                }}
              />
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: fonts.serif,
                fontSize: 32,
                color: T.ink,
                letterSpacing: '-0.03em',
                lineHeight: 1,
                fontStyle: 'italic',
                fontWeight: 400,
              }}
            >
              {s.big}
            </span>
            <span
              style={{
                fontFamily: fonts.sans,
                fontSize: 12,
                color: T.ink2,
                textAlign: 'right',
                textWrap: 'pretty' as React.CSSProperties['textWrap'],
              }}
            >
              {s.sub}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function daysAgoLabel(date: Date): string {
  const ms = Date.now() - date.getTime();
  const d = Math.max(0, Math.floor(ms / 86_400_000));
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}
