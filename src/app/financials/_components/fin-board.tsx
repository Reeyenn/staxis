'use client';

// ════════════════════════════════════════════════════════════════════════════
// Financials board kit — the visual primitives for the Kanban redesign.
//
// These are VISUAL ONLY: every component takes display props (already-formatted
// labels, colors, click handlers) so the three tabs keep all the data fetching,
// i18n, and money math. Tokens come from the Concourse contract (via fin-ui) so
// Financials sits natively in the new shell — Geist UI, Geist Mono data,
// sage/amber/rust accents, hairline cards on the app-wide wash.
//
// Money rule still holds: everything in/out is integer cents; formatCents is the
// one formatter. Big display numbers render Geist 600 (the Concourse voice);
// transactional figures stay mono (tabular-nums).
// ════════════════════════════════════════════════════════════════════════════

import React, { useRef, useState } from 'react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, SPRING, CARD_SHADOW, CARD_SHADOW_HOVER } from './fin-ui';
import { formatCents, formatCentsCompact, type Department } from '@/lib/financials/shared';

export { T, FONT_SANS, FONT_MONO, FONT_SERIF };

// A faint ink wash for column backgrounds (snow ink = rgb(31,35,28)).
const COLUMN_BG = 'rgba(31,35,28,0.022)';
const METER_TRACK = 'rgba(31,35,28,0.06)';

// ── Department accent colors ────────────────────────────────────────────────
// All drawn from the Concourse palette (ink / sage family / amber / rust) so
// the board reads as one system; former off-palette hues (teal, muted blue,
// purple, slate) map to their nearest Concourse tone.
export const DEPT_COLOR: Record<Department, string> = {
  rooms: T.ink,
  housekeeping: T.sageDeep,
  maintenance: T.warm,
  front_desk: T.sageBrand, // was teal
  breakfast: T.caramelDeep, // gold (F&B)
  utilities: T.sage, // was muted blue
  sales_marketing: T.caramel, // was purple
  admin_general: T.ink2, // was slate
  other: T.ink3,
};
export function deptColor(d: Department): string {
  return DEPT_COLOR[d] ?? T.ink3;
}

// ── Big display money, Geist 600 (summary tiles + budget remaining + capex) ─
export function BigMoney({
  cents,
  size = 23,
  color,
  compact = false,
  showCents = false,
}: {
  cents: number | null | undefined;
  size?: number;
  color?: string;
  compact?: boolean;
  showCents?: boolean;
}) {
  const txt = cents == null ? '—' : compact ? formatCentsCompact(cents) : formatCents(cents, { showCents });
  return (
    <span
      style={{
        fontFamily: FONT_SANS,
        fontSize: size,
        fontWeight: 600,
        color: color ?? T.ink,
        letterSpacing: '-0.02em',
        lineHeight: 1.05,
      }}
    >
      {txt}
    </span>
  );
}

// ── Mono caps label (tile / strip eyebrow) ──────────────────────────────────
export function Eyebrow({ children, color, style = {} }: { children: React.ReactNode; color?: string; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontSize: 9.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: color ?? T.faint,
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ── Stat strip cell (CapEx totals strip + multi-property rollup) ────────────
export function StatStrip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ marginTop: 3 }}>{children}</div>
    </div>
  );
}

export const statNum: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 24, fontWeight: 600, color: T.ink };

// ── Summary tile (the 4-up header row) ──────────────────────────────────────
export function SummaryTile({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: '1 1 170px',
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 14,
        padding: '14px 18px',
      }}
    >
      <Eyebrow>
        {label}
        {sub && <span style={{ color: T.ink3, marginLeft: 5, textTransform: 'none', letterSpacing: 0 }}>· {sub}</span>}
      </Eyebrow>
      <div style={{ marginTop: 5 }}>{children}</div>
    </div>
  );
}

// ── Expense source chip (only the two real sources exist in the ledger) ─────
export function ExpenseSourceTag({ label, tone }: { label: string; tone: 'scan' | 'manual' }) {
  const c = tone === 'scan' ? T.sageDeep : T.ink2;
  const bg = tone === 'scan' ? 'rgba(53,107,76,0.10)' : 'rgba(31,35,28,0.06)';
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        fontWeight: 600,
        color: c,
        background: bg,
        borderRadius: 999,
        padding: '3px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// ── Department swimlane column (Checkbook board) ────────────────────────────
export function FinColumn({
  color,
  name,
  count,
  spentCents,
  budgetCents,
  children,
}: {
  color: string;
  name: string;
  count: number;
  spentCents: number;
  budgetCents: number | null;
  children: React.ReactNode;
}) {
  const hasBudget = budgetCents != null && budgetCents > 0;
  const pct = hasBudget ? spentCents / (budgetCents as number) : 0;
  const over = hasBudget && spentCents > (budgetCents as number);
  return (
    <div
      style={{
        width: 250,
        flexShrink: 0,
        background: COLUMN_BG,
        borderRadius: 12,
        padding: 12,
        border: `1px solid ${T.ruleSoft}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, fontWeight: 600, color: T.ink, flex: 1, minWidth: 0 }}>{name}</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3 }}>{count}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 15, color: T.ink, fontWeight: 600 }}>{formatCents(spentCents, { showCents: false })}</span>
        {hasBudget && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: over ? T.warm : T.ink3 }}>/ {formatCents(budgetCents, { showCents: false })}</span>
        )}
      </div>
      {hasBudget ? (
        <div style={{ height: 4, background: METER_TRACK, borderRadius: 2, overflow: 'hidden', margin: '7px 0 12px' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct * 100)}%`, background: over ? T.warm : color }} />
        </div>
      ) : (
        <div style={{ height: 12 }} />
      )}
      <div>{children}</div>
    </div>
  );
}

// ── Flip expense card: front = glance, back = detail + edit/delete ──────────
const cardShell: React.CSSProperties = {
  background: T.paper,
  border: `1px solid ${T.rule}`,
  borderRadius: 14,
  padding: '11px 12px',
  boxShadow: CARD_SHADOW,
  boxSizing: 'border-box',
  overflow: 'hidden',
};

export function FlipExpenseCard({
  memo,
  dateLabel,
  amountCents,
  sourceTag,
  vendorLabel,
  detailRows,
  deptName,
  deptColorHex,
  editLabel,
  deleteLabel,
  onEdit,
  onDelete,
}: {
  memo: string;
  dateLabel: string;
  amountCents: number;
  sourceTag: React.ReactNode;
  vendorLabel: string;
  detailRows: { label: string; value: string }[];
  deptName: string;
  deptColorHex: string;
  editLabel: string;
  deleteLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Two-phase rotateY flip with the content swapped at the half-turn. Content
  // stays in normal flow (auto height) so a taller "back" never clips its
  // buttons, and it can never get stuck invisible — the flip is enhancement.
  const [face, setFace] = useState<0 | 1>(0);
  const [deg, setDeg] = useState(0);
  const busy = useRef(false);
  const flip = () => {
    if (busy.current) return;
    busy.current = true;
    setDeg(90);
  };
  const onTransEnd = () => {
    if (deg === 90) {
      setFace((f) => (f ? 0 : 1));
      setDeg(0);
    } else {
      busy.current = false;
    }
  };
  return (
    <div style={{ perspective: 1000, marginBottom: 8 }}>
      <div
        onClick={flip}
        onTransitionEnd={onTransEnd}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            flip();
          }
        }}
        style={{
          ...cardShell,
          minHeight: 84,
          cursor: 'pointer',
          transition: `transform 0.3s ${SPRING}`,
          transform: `perspective(1000px) rotateY(${deg}deg)`,
        }}
      >
        {face === 0 ? (
          <>
            <div style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500, lineHeight: 1.25 }}>{memo}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8 }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: T.ink3 }}>{dateLabel}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: T.ink, fontWeight: 700, letterSpacing: '-0.01em' }}>{formatCents(amountCents)}</span>
            </div>
            <div style={{ marginTop: 7 }}>{sourceTag}</div>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.ink2, fontWeight: 600 }}>{vendorLabel}</div>
            {detailRows.map((r, i) => (
              <div key={i} style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: T.ink2 }}>
                {r.label} · {r.value}
              </div>
            ))}
            <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: deptColorHex }}>{deptName.toUpperCase()}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                style={miniBtn(T.ink2)}
              >
                {editLabel}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                style={miniBtn(T.warm)}
              >
                {deleteLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function miniBtn(color: string): React.CSSProperties {
  return {
    fontFamily: FONT_SANS,
    fontSize: 11,
    fontWeight: 600,
    color,
    background: 'transparent',
    border: `1px solid ${color}55`,
    borderRadius: 999,
    padding: '3px 10px',
    cursor: 'pointer',
  };
}

// ── Budget card (Budget grid) ───────────────────────────────────────────────
export function BudgetStatCard({
  name,
  color,
  pctLabel,
  over,
  captionLabel,
  remainingCents,
  pct,
  spentCents,
  budgetCents,
  noBudget = false,
  spentWord = 'spent',
  ofWord = 'of',
  footnote,
}: {
  name: string;
  color: string;
  pctLabel: string;
  over: boolean;
  captionLabel: string;
  remainingCents: number;
  pct: number;
  spentCents: number;
  budgetCents: number;
  noBudget?: boolean;
  /** Localized footer words for "$1,200 spent / of $2,000" (EN/ES). */
  spentWord?: string;
  ofWord?: string;
  footnote?: React.ReactNode;
}) {
  const statusColor = noBudget ? T.ink3 : over ? T.warm : color;
  return (
    <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '16px 17px', boxShadow: CARD_SHADOW }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontFamily: FONT_SANS, fontSize: 14.5, fontWeight: 600, color: T.ink, flex: 1, minWidth: 0 }}>{name}</span>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: statusColor,
            background: `${statusColor}1A`,
            borderRadius: 999,
            padding: '3px 8px',
            whiteSpace: 'nowrap',
          }}
        >
          {pctLabel}
        </span>
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ fontFamily: FONT_SANS, fontSize: 11.5, color: T.ink3 }}>{captionLabel}</div>
        <div style={{ marginTop: 2 }}>
          <BigMoney cents={Math.abs(remainingCents)} size={26} color={statusColor} />
        </div>
      </div>
      <div style={{ height: 6, background: METER_TRACK, borderRadius: 3, overflow: 'hidden', marginTop: 14 }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.max(0, pct * 100))}%`, background: budgetCents > 0 ? statusColor : T.ink3, borderRadius: 3 }} />
      </div>
      {!noBudget && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>{formatCents(spentCents, { showCents: false })} {spentWord}</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>{ofWord} {formatCents(budgetCents, { showCents: false })}</span>
        </div>
      )}
      {footnote && <div style={{ marginTop: 8 }}>{footnote}</div>}
    </div>
  );
}

// ── CapEx project card (status board) ───────────────────────────────────────
export function CapexCard({
  accent,
  name,
  metaLabel,
  spentCents,
  estimateCents,
  spentLabel,
  estimateLabel,
  pills,
  onOpen,
}: {
  accent: string;
  name: string;
  metaLabel: string;
  spentCents: number;
  estimateCents: number;
  spentLabel: string;
  estimateLabel: string;
  pills?: React.ReactNode;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(92,122,96,0.45)';
        e.currentTarget.style.borderLeftColor = accent;
        e.currentTarget.style.transform = 'translateY(-5px)';
        e.currentTarget.style.boxShadow = CARD_SHADOW_HOVER;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = T.rule;
        e.currentTarget.style.borderLeftColor = accent;
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = CARD_SHADOW;
      }}
      style={{
        textAlign: 'left',
        width: '100%',
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 14,
        padding: '12px 13px',
        marginBottom: 8,
        cursor: 'pointer',
        transition: `border-color 0.55s ${SPRING}, transform 0.55s ${SPRING}, box-shadow 0.55s ${SPRING}`,
        boxShadow: CARD_SHADOW,
      }}
    >
      <div style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 600, lineHeight: 1.25 }}>{name}</div>
      {metaLabel && <div style={{ fontFamily: FONT_SANS, fontSize: 11.5, color: T.ink3, marginTop: 3 }}>{metaLabel}</div>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
        <BigMoney cents={spentCents} size={20} color={T.ink} />
        <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3 }}>
          {spentLabel} · {estimateLabel} {formatCents(estimateCents, { showCents: false })}
        </span>
      </div>
      {pills && <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>{pills}</div>}
    </button>
  );
}

// ── Horizontal board scroller ───────────────────────────────────────────────
export function BoardScroller({ center = false, children }: { center?: boolean; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        overflowX: 'auto',
        alignItems: 'flex-start',
        justifyContent: center ? 'center' : 'flex-start',
        paddingBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
