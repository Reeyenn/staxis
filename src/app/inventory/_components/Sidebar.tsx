'use client';

import React, { useRef } from 'react';
import { T, fonts, statusColor } from './tokens';
import { Caps } from './Caps';
import { Serif } from './Serif';
import { StatusDot } from './StatusPill';
import { Motion } from './motion';
import { fmtMoney } from './format';
import { t, type Lang } from './inv-i18n';

export type SidebarAction =
  | 'count'
  | 'scan'
  | 'reorder'
  | 'orders'
  | 'ordersettings'
  | 'reports'
  | 'history'
  | 'ai'
  | 'budgets';

interface SidebarProps {
  lang: Lang;
  totalItems: number;
  reorderCount: number;
  historyCount: number;
  spendSpent: number;
  spendCap: number;
  /** Management (owner/GM/admin) — gates the Orders + Ordering-settings actions. */
  canManage: boolean;
  /** Money capability (view_financials) — gates the budget/spend surfaces:
   *  the Reports + Budgets actions and the month spend strip. Stock counts and
   *  low-stock badges stay visible to everyone. (Access cleanup 2026-06-26.) */
  canViewFinancials: boolean;
  onAction: (key: SidebarAction) => void;
}

// The Triage left action rail (224px, sticky). Full action set; Orders +
// Ordering settings are management-only.
export function Sidebar({
  lang,
  totalItems,
  reorderCount,
  historyCount,
  spendSpent,
  spendCap,
  canManage,
  canViewFinancials,
  onAction,
}: SidebarProps) {
  const tx = t(lang);

  return (
    <aside
      style={{
        background: T.bg,
        border: `1px solid ${T.rule}`,
        borderRadius: 16,
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        position: 'sticky',
        top: 16,
      }}
    >
      <Caps size={9} style={{ padding: '4px 8px 7px' }}>{tx.do}</Caps>
      <RailBtn label={tx.startCount} badge={totalItems} primary onClick={() => onAction('count')} />
      <RailBtn label={tx.scanInvoice} tone="teal" onClick={() => onAction('scan')} />
      <Divider />
      <RailBtn label={tx.reorderList} badge={reorderCount} accent onClick={() => onAction('reorder')} />
      {canManage && <RailBtn label={tx.orders} onClick={() => onAction('orders')} />}
      <Divider />
      <Caps size={9} style={{ padding: '4px 8px 7px' }}>{tx.look}</Caps>
      {/* Reports + Budgets show budget/spend dollars — money-capability only. */}
      {canViewFinancials && <RailBtn label={tx.reports} onClick={() => onAction('reports')} />}
      <RailBtn label={tx.history} badge={historyCount} onClick={() => onAction('history')} />
      <RailBtn label={tx.aiHelper} onClick={() => onAction('ai')} />
      {canViewFinancials && <RailBtn label={tx.budgets} onClick={() => onAction('budgets')} />}
      {canManage && <RailBtn label={tx.orderingSettings} onClick={() => onAction('ordersettings')} />}

      {/* Month spend vs budget — money-capability only. */}
      {canViewFinancials && (
        <>
          <div style={{ height: 1, background: T.rule, margin: '10px 8px 6px' }} />
          <div style={{ padding: '4px 10px 6px' }}>
            <Caps size={9}>{tx.thisMonth}</Caps>
            <SpendStrip spent={spendSpent} cap={spendCap} lang={lang} />
          </div>
        </>
      )}
    </aside>
  );
}

function Divider() {
  return <div style={{ height: 1, background: T.rule, margin: '6px 8px' }} />;
}

interface RailBtnProps {
  label: string;
  badge?: number;
  primary?: boolean;
  accent?: boolean;
  tone?: 'teal';
  onClick: () => void;
}

function RailBtn({ label, badge, primary, accent, tone, onClick }: RailBtnProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const teal = tone === 'teal';
  const plain = !primary && !teal;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => { Motion.pop(ref.current, 0.96); onClick(); }}
      onMouseEnter={(e) => { if (plain) e.currentTarget.style.background = T.inkWash; }}
      onMouseLeave={(e) => { if (plain) e.currentTarget.style.background = 'transparent'; }}
      style={{
        padding: '9px 12px',
        borderRadius: 9,
        cursor: 'pointer',
        background: primary ? T.ink : teal ? T.tealDim : 'transparent',
        color: primary ? T.bg : teal ? T.tealText : T.ink,
        border: `1px solid ${primary ? T.ink : teal ? `${T.teal}33` : 'transparent'}`,
        fontFamily: fonts.sans,
        fontSize: 13.5,
        fontWeight: primary || teal ? 600 : 500,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        justifyContent: 'space-between',
        width: '100%',
        textAlign: 'left',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
        {accent && <StatusDot s="critical" size={6} />}
        {(primary || teal) && <Serif size={14}>→</Serif>}
        {label}
      </span>
      {badge != null && (
        <span
          style={{
            padding: '1px 7px',
            borderRadius: 999,
            background: primary ? 'rgba(255,255,255,0.16)' : T.bg,
            border: `1px solid ${primary ? 'rgba(255,255,255,0.22)' : T.rule}`,
            fontFamily: fonts.mono,
            fontSize: 10,
            fontWeight: 600,
            color: primary ? T.bg : T.dim,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function SpendStrip({ spent, cap, lang }: { spent: number; cap: number; lang: Lang }) {
  const tx = t(lang);
  const pct = cap > 0 ? Math.min(1, spent / cap) : 0;
  const remaining = Math.max(0, cap - spent);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <Serif size={22}>{fmtMoney(spent)}</Serif>
        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.dim }}>{tx.of} {fmtMoney(cap)}</span>
      </div>
      <span
        style={{
          display: 'block',
          height: 5,
          borderRadius: 5,
          background: T.ruleSoft,
          overflow: 'hidden',
          margin: '8px 0',
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
      <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2 }}>
        {cap > 0 ? `${fmtMoney(remaining)} ${tx.stillToSpend}` : tx.noBudgetSet}
      </span>
    </div>
  );
}
