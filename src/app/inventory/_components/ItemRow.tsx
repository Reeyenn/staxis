'use client';

import React from 'react';
import { T, fonts, statusColor, statusText } from './tokens';
import { ItemThumb } from './ItemThumb';
import { StockBar } from './StockBar';
import { StatusPill } from './StatusPill';
import { fmtMoney, fmtInt, daysOutLabel } from './format';
import type { DisplayItem } from './types';

// Shared single-line stock row. Used by the maintenance Parts tab (and any
// future flat list). The Triage board uses BoardCard, not this. Restyles to
// the Triage palette automatically via tokens.
interface ItemRowProps {
  it: DisplayItem;
  onClick?: (item: DisplayItem) => void;
}

export function ItemRow({ it, onClick }: ItemRowProps) {
  const Container = onClick ? 'button' : 'div';
  return (
    <Container
      type={onClick ? 'button' : undefined}
      onClick={onClick ? () => onClick(it) : undefined}
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 14,
        padding: '12px 14px',
        display: 'grid',
        gridTemplateColumns: '36px minmax(140px, 1.6fr) 84px minmax(110px, 1fr) 70px 70px',
        gap: 12,
        alignItems: 'center',
        position: 'relative',
        overflow: 'hidden',
        textAlign: 'left',
        cursor: onClick ? 'pointer' : 'default',
        width: '100%',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: statusColor[it.status],
        }}
      />
      <ItemThumb thumb={it.thumb} cat={it.cat} size={32} />

      {/* name + vendor */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 14,
            color: T.ink,
            fontWeight: 600,
            letterSpacing: '-0.005em',
          }}
        >
          {it.name}
        </span>
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            color: T.ink3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {it.vendor || '—'}
        </span>
      </div>

      {/* current stock — big number + unit */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 22,
            color: T.ink,
            letterSpacing: '-0.02em',
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          {fmtInt(it.estimated)}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2 }}>{it.unit}</span>
      </div>

      {/* stock bar + plain days */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          paddingTop: 1,
          minWidth: 0,
        }}
      >
        <StockBar current={it.estimated} par={it.par} status={it.status} height={6} />
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            color: statusText[it.status],
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {/*
            Honesty-audit Phase 4: when the burn rate came from the par/60
            default (no rule, no model) or there is no data at all, the
            numeric daysLeft is a fixed function of par — not a prediction.
            Render an em-dash instead so the GM doesn't read "60d left" as
            a forecast. ML and rule-occupancy items keep showing the number.
          */}
          {it.burnSource === 'fallback-60d' || it.burnSource === 'no-data'
            ? '—'
            : daysOutLabel(it.daysLeft)}
        </span>
      </div>

      {/* on-the-shelf $ */}
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 14,
          color: T.ink,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          textAlign: 'right',
        }}
      >
        {fmtMoney(it.value)}
      </span>

      <StatusPill s={it.status} />
    </Container>
  );
}
