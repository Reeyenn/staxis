'use client';

import React, { useEffect, useRef } from 'react';
import { T, fonts } from './tokens';
import { Caps } from './Caps';
import { Serif } from './Serif';
import { StatusDot } from './StatusPill';
import { Motion, EASE } from './motion';
import { CountUp, TickNum } from './fx';
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
// Ordering settings are management-only. The primary "Start count" button is
// the brightest thing on the rail (solid brand fill) so the #1 daily action
// stands out.
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
      {canManage && <RailBtn label={tx.addDelivery} tone="teal" onClick={() => onAction('scan')} />}
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
      {/* Ordering automation is per-hotel (vendors, how orders are placed,
          who approves) — parked as "coming soon" until the per-hotel setup
          exists. The panel code stays; only this entry point is retired. */}
      {canManage && (
        <div
          aria-disabled="true"
          style={{
            padding: '9px 12px',
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 9,
            fontFamily: fonts.sans,
            fontSize: 13.5,
            fontWeight: 500,
            color: T.dim,
            cursor: 'default',
          }}
        >
          {tx.orderingSettings}
          <span
            style={{
              padding: '1px 7px',
              borderRadius: 999,
              background: T.inkWash,
              border: `1px solid ${T.rule}`,
              fontFamily: fonts.mono,
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: T.dim,
            }}
          >
            {tx.comingSoon}
          </span>
        </div>
      )}

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
        {accent && <span aria-hidden="true"><StatusDot s="critical" size={6} /></span>}
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

function SpendStrip({ spent, cap, lang }: { spent: number; cap: number; lang: Lang }) {
  const tx = t(lang);
  const pct = cap > 0 ? Math.min(1, spent / cap) : 0;
  const remaining = Math.max(0, cap - spent);
  // Honest utilization color: comfortably inside budget = forest, past 80% of
  // the cap = gold, at/over the cap = terra. (Same family as stock statuses.)
  const barColor = pct >= 1 ? T.terra : pct >= 0.8 ? T.gold : T.forest;

  // The fill inks in from its previous level, like the stock bars.
  const fillRef = useRef<HTMLSpanElement>(null);
  const prevPct = useRef(0);
  useEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    const from = prevPct.current;
    if (from !== pct) {
      el.animate(
        [{ width: `${from * 100}%` }, { width: `${pct * 100}%` }],
        { duration: 900, easing: EASE.settle, fill: 'none' },
      );
    }
    prevPct.current = pct;
  }, [pct]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <Serif size={22}>
          <CountUp value={spent} format={(n) => fmtMoney(n)} />
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
        {cap > 0 ? `${fmtMoney(remaining)} ${tx.stillToSpend}` : tx.noBudgetSet}
      </span>
    </div>
  );
}
