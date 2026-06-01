'use client';

import React from 'react';
import { T, fonts, statusColor } from './tokens';
import { Caps } from './Caps';
import { fmtMoney } from './format';

export type SidebarAction =
  | 'count'
  | 'scan'
  | 'reorder'
  | 'reports'
  | 'history'
  | 'ai'
  | 'budgets';

interface SidebarProps {
  totalItems: number;
  reorderCount: number;
  historyCount: number;
  spendSpent: number;
  spendCap: number;
  onAction: (key: SidebarAction) => void;
}

export function Sidebar({
  totalItems,
  reorderCount,
  historyCount,
  spendSpent,
  spendCap,
  onAction,
}: SidebarProps) {
  return (
    <aside
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignSelf: 'flex-start',
      }}
    >
      <Caps size={9} style={{ padding: '4px 8px 8px' }}>
        Do
      </Caps>
      <SidebarItem primary label="Start count" count={totalItems} onClick={() => onAction('count')} />
      <SidebarItem tone="sage" label="Scan invoice" onClick={() => onAction('scan')} />
      <Divider />
      <SidebarItem
        label="Reorder list"
        count={reorderCount}
        accent={statusColor.critical}
        onClick={() => onAction('reorder')}
      />
      <Divider />
      <Caps size={9} style={{ padding: '4px 8px 8px' }}>
        Look
      </Caps>
      <SidebarItem label="Reports" onClick={() => onAction('reports')} />
      <SidebarItem label="History" count={historyCount} onClick={() => onAction('history')} />
      <SidebarItem label="AI Helper" onClick={() => onAction('ai')} />
      <SidebarItem label="Budgets" onClick={() => onAction('budgets')} />

      <div style={{ height: 1, background: T.rule, margin: '10px 8px 6px' }} />
      <div style={{ padding: '8px 10px 4px' }}>
        <Caps size={9}>This month</Caps>
        <SpendStrip spent={spendSpent} cap={spendCap} />
      </div>
    </aside>
  );
}

function Divider() {
  return <div style={{ height: 1, background: T.rule, margin: '6px 8px' }} />;
}

interface SidebarItemProps {
  label: string;
  count?: number;
  accent?: string;
  primary?: boolean;
  tone?: 'sage';
  onClick: () => void;
}

function SidebarItem({ label, count, accent, primary, tone, onClick }: SidebarItemProps) {
  const sage = tone === 'sage';
  const bg = primary ? T.ink : sage ? 'rgba(92,122,96,0.12)' : 'transparent';
  const fg = primary ? T.bg : sage ? '#3F5A43' : T.ink;
  const bdr = primary ? T.ink : sage ? 'rgba(92,122,96,0.28)' : 'transparent';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '9px 12px',
        borderRadius: 9,
        cursor: 'pointer',
        background: bg,
        color: fg,
        border: `1px solid ${bdr}`,
        fontFamily: fonts.sans,
        fontSize: 13,
        fontWeight: primary || sage ? 600 : 500,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        justifyContent: 'space-between',
        textAlign: 'left',
        width: '100%',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
        {accent && !primary && !sage && (
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: accent,
            }}
          />
        )}
        {primary && (
          <span style={{ fontFamily: fonts.serif, fontSize: 14, fontStyle: 'italic', letterSpacing: '-0.02em' }}>
            →
          </span>
        )}
        {sage && (
          <span style={{ fontFamily: fonts.serif, fontSize: 14, fontStyle: 'italic', letterSpacing: '-0.02em' }}>
            →
          </span>
        )}
        {label}
      </span>
      {count != null && (
        <span
          style={{
            padding: '1px 7px',
            borderRadius: 999,
            background: primary
              ? 'rgba(255,255,255,0.16)'
              : sage
              ? 'rgba(63,90,67,0.10)'
              : T.bg,
            border: primary
              ? '1px solid rgba(255,255,255,0.22)'
              : sage
              ? '1px solid rgba(63,90,67,0.22)'
              : `1px solid ${T.rule}`,
            fontFamily: fonts.mono,
            fontSize: 10,
            fontWeight: 600,
            color: primary ? T.bg : sage ? '#3F5A43' : T.ink2,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SpendStrip({ spent, cap }: { spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(1, spent / cap) : 0;
  const remaining = Math.max(0, cap - spent);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span
          style={{
            fontFamily: fonts.serif,
            fontSize: 22,
            color: T.ink,
            letterSpacing: '-0.02em',
            fontStyle: 'italic',
            fontWeight: 400,
            lineHeight: 1,
          }}
        >
          {fmtMoney(spent)}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2 }}>
          of {fmtMoney(cap)}
        </span>
      </div>
      <span
        style={{
          height: 5,
          borderRadius: 5,
          background: T.rule,
          overflow: 'hidden',
          display: 'block',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${pct * 100}%`,
            background: statusColor.good,
            borderRadius: 5,
          }}
        />
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2, lineHeight: 1.4 }}>
        {cap > 0
          ? `${fmtMoney(remaining)} still to spend this month`
          : 'No budget set'}
      </span>
    </div>
  );
}
