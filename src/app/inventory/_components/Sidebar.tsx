'use client';

import React, { useEffect, useRef } from 'react';
import { T, fonts } from './tokens';
import { Caps } from './Caps';
import { Serif } from './Serif';
import { Motion, EASE } from './motion';
import { CountUp, TickNum } from './fx';
import { fmtMoney } from './format';
import { t, type Lang } from './inv-i18n';
import type { InventoryBudgetActualState } from '@/lib/inventory-budget-actual';

export type SidebarAction =
  | 'count'
  | 'delivery'
  | 'close'
  | 'reports'
  | 'compare'
  | 'history'
  | 'ai'
  | 'budgets';

interface SidebarProps {
  lang: Lang;
  totalItems: number;
  historyCount: number;
  /** Purchases received this month. Shown separately from usage. */
  purchasesThisMonth: number;
  /** False means purchasesThisMonth is only the known-cost subtotal. */
  purchasesComplete: boolean;
  /** False means the purchase source failed; do not render a fake-looking $0. */
  purchasesAvailable: boolean;
  /** Closed month usage actual; null until the month is closed. */
  actualUsedThisMonth: number | null;
  actualState: InventoryBudgetActualState;
  budgetCap: number;
  /** Management (owner/GM/admin) — gates the Add-delivery action. */
  canManage: boolean;
  /** Money capability (view_financials) — gates the budget/spend surfaces:
   *  the Reports + Budgets actions and the month spend strip. Stock counts and
   *  low-stock badges stay visible to everyone. (Access cleanup 2026-06-26.) */
  canViewFinancials: boolean;
  onAction: (key: SidebarAction) => void;
}

// The Triage left action rail (224px, sticky). Add-delivery is
// management-only. The primary "Start count" button is
// the brightest thing on the rail (solid brand fill) so the #1 daily action
// stands out.
export function Sidebar({
  lang,
  totalItems,
  historyCount,
  purchasesThisMonth,
  purchasesComplete,
  purchasesAvailable,
  actualUsedThisMonth,
  actualState,
  budgetCap,
  canManage,
  canViewFinancials,
  onAction,
}: SidebarProps) {
  const tx = t(lang);

  return (
    <aside
      className="inv-rail"
      data-rise
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
      {canManage && <RailBtn label={tx.addDelivery} tone="teal" onClick={() => onAction('delivery')} />}
      {canManage && canViewFinancials && <RailBtn label={tx.monthClose} onClick={() => onAction('close')} />}
      <Divider />
      <Caps size={9} style={{ padding: '4px 8px 7px' }}>{tx.look}</Caps>
      {/* Reports + Compare + Budgets show budget/spend dollars — money-capability only. */}
      {canViewFinancials && <RailBtn label={tx.reports} onClick={() => onAction('reports')} />}
      {canViewFinancials && <RailBtn label={tx.compareMonths} onClick={() => onAction('compare')} />}
      <RailBtn label={tx.history} badge={historyCount} onClick={() => onAction('history')} />
      <RailBtn label={tx.aiHelper} onClick={() => onAction('ai')} />
      {canViewFinancials && <RailBtn label={tx.budgets} onClick={() => onAction('budgets')} />}

      {/* Closed usage vs budget — purchases stay visible but never masquerade
          as the month's P&L actual. Money-capability only. */}
      {canViewFinancials && (
        <>
          <div style={{ height: 1, background: T.rule, margin: '10px 8px 6px' }} />
          <div style={{ padding: '4px 10px 6px' }}>
            <Caps size={9}>{tx.thisMonth}</Caps>
            <UsageStrip
              actual={actualUsedThisMonth}
              purchases={purchasesThisMonth}
              purchasesComplete={purchasesComplete}
              purchasesAvailable={purchasesAvailable}
              cap={budgetCap}
              state={actualState}
              lang={lang}
            />
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
  tone?: 'teal';
  onClick: () => void;
}

function RailBtn({ label, badge, primary, tone, onClick }: RailBtnProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const teal = tone === 'teal';
  const plain = !primary && !teal;
  return (
    <button
      ref={ref}
      type="button"
      className={[
        'inv-rail-btn',
        plain ? 'inv-rail-plain' : '',
      ].join(' ').trim()}
      aria-label={badge != null ? `${label}, ${badge}` : undefined}
      onClick={() => { Motion.pop(ref.current, 0.96); onClick(); }}
      style={{
        padding: '9px 12px',
        borderRadius: 9,
        cursor: 'pointer',
        background: primary ? T.brand : teal ? T.tealDim : 'transparent',
        color: primary ? '#fff' : teal ? T.tealText : T.ink,
        border: `1px solid ${primary ? T.brand : teal ? 'rgba(92,122,96,0.28)' : 'transparent'}`,
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
        {(primary || teal) && (
          <span aria-hidden="true"><Serif size={14}><span className="inv-arrow">→</span></Serif></span>
        )}
        {label}
      </span>
      {badge != null && (
        <span
          aria-hidden="true"
          style={{
            padding: '1px 7px',
            borderRadius: 999,
            background: primary ? 'rgba(255,255,255,0.16)' : T.bg,
            border: `1px solid ${primary ? 'rgba(255,255,255,0.22)' : T.rule}`,
            fontFamily: fonts.mono,
            fontSize: 10,
            fontWeight: 600,
            color: primary ? '#fff' : T.dim,
          }}
        >
          <TickNum>{badge}</TickNum>
        </span>
      )}
    </button>
  );
}

function UsageStrip({
  actual,
  purchases,
  purchasesComplete,
  purchasesAvailable,
  cap,
  state,
  lang,
}: {
  actual: number | null;
  purchases: number;
  purchasesComplete: boolean;
  purchasesAvailable: boolean;
  cap: number;
  state: InventoryBudgetActualState;
  lang: Lang;
}) {
  const tx = t(lang);
  const complete = state === 'complete' && actual != null;
  const used = complete ? actual : 0;
  const pct = cap > 0 ? Math.min(1, used / cap) : 0;
  const remaining = cap - used;
  // Honest utilization color: comfortably inside budget = forest, past 80% of
  // the cap = gold, at/over the cap = terra. (Same family as stock statuses.)
  const barColor = used > cap && cap > 0 ? T.terra : pct >= 0.8 ? T.gold : T.forest;

  // The fill inks in from its previous level, like the stock bars.
  const fillRef = useRef<HTMLSpanElement>(null);
  const prevPct = useRef(0);
  useEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    const from = prevPct.current;
    if (complete && from !== pct) {
      el.animate(
        [{ width: `${from * 100}%` }, { width: `${pct * 100}%` }],
        { duration: 900, easing: EASE.settle, fill: 'none' },
      );
    }
    prevPct.current = pct;
  }, [complete, pct]);

  if (!complete) {
    return (
      <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 7 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 650, color: T.ink }}>
          {state === 'partial' ? tx.partialUsage : tx.usagePending}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2 }}>
          {purchasesAvailable
            ? <>{purchasesComplete ? fmtMoney(purchases) : `≥ ${fmtMoney(purchases)}`} {tx.purchasesLogged}{!purchasesComplete ? ` · ${tx.purchaseCostsMissing}` : ''}</>
            : <>— · {tx.purchasesUnavailable}</>}
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 10.5, lineHeight: 1.35, color: T.ink3 }}>
          {tx.budgetAfterClose}
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <Serif size={22}>
          <CountUp value={used} format={(n) => fmtMoney(n)} />
        </Serif>
        {cap > 0 && (
          <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.dim }}>{tx.of} {fmtMoney(cap)}</span>
        )}
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
          ref={fillRef}
          style={{
            display: 'block',
            height: '100%',
            width: `${pct * 100}%`,
            background: barColor,
            borderRadius: 5,
            transition: 'background .4s ease',
          }}
        />
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2 }}>
        {cap > 0
          ? remaining >= 0
            ? `${fmtMoney(remaining)} ${tx.leftInBudget}`
            : `${fmtMoney(Math.abs(remaining))} ${tx.overBudget}`
          : tx.noBudgetSet}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 10.5, color: T.ink3 }}>
        {purchasesAvailable
          ? <>{purchasesComplete ? fmtMoney(purchases) : `≥ ${fmtMoney(purchases)}`} {tx.purchasesLogged}{!purchasesComplete ? ` · ${tx.purchaseCostsMissing}` : ''}</>
          : <>— · {tx.purchasesUnavailable}</>} · {tx.actualUsed}
      </span>
    </div>
  );
}
