'use client';

import React from 'react';
import { T, fonts, statusColor } from './tokens';
import { Caps } from './Caps';
import { fmtMoney, fmtInt } from './format';
import type { DisplayItem } from './types';
import { t, dateLocale, type Lang } from './inv-i18n';

interface HeroStatsProps {
  items: DisplayItem[];
  lastCount: { date: Date; by: string } | null;
  lang?: Lang;
}

export function HeroStats({ items, lastCount, lang = 'en' }: HeroStatsProps) {
  const tx = t(lang);
  const total = items.length;
  const goodCount = items.filter((i) => i.status === 'good').length;
  const stockHealthPct = total > 0 ? Math.round((100 * goodCount) / total) : 0;
  const totalValue = items.reduce((s, i) => s + i.value, 0);

  const stats: Array<{ eyebrow: string; big: string; sub: string; accent?: string }> = [
    {
      eyebrow: tx.stockHealth,
      big: `${stockHealthPct}%`,
      sub: total > 0
        ? `${fmtInt(goodCount)} ${tx.of} ${fmtInt(total)} ${tx.itemsHaveEnough}`
        : tx.noItemsYet,
      accent: statusColor.good,
    },
    {
      eyebrow: tx.onTheShelf,
      big: fmtMoney(totalValue),
      sub: tx.whatEverythingsWorth,
    },
    {
      eyebrow: tx.lastCounted,
      big: lastCount
        ? lastCount.date.toLocaleDateString(dateLocale(lang), { month: 'short', day: 'numeric' })
        : '—',
      sub: lastCount
        ? `${daysAgoLabel(lastCount.date, lang)} ${tx.by} ${lastCount.by || tx.team}`
        : tx.noCountYet,
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
                fontFamily: fonts.sans,
                fontSize: 32,
                color: T.ink,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                fontWeight: 600,
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

function daysAgoLabel(date: Date, lang: Lang): string {
  const tx = t(lang);
  const ms = Date.now() - date.getTime();
  const d = Math.max(0, Math.floor(ms / 86_400_000));
  if (d === 0) return tx.today;
  if (d === 1) return tx.yesterday;
  return `${d} ${tx.daysAgo}`;
}
