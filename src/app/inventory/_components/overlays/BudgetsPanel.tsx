'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { upsertInventoryBudget } from '@/lib/db';
import type { InventoryBudget, InventoryCategory } from '@/types';

import { T, fonts, catLabel, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';

interface BudgetsPanelProps {
  open: boolean;
  onClose: () => void;
  budgets: InventoryBudget[];
}

type Mode = 'same' | 'months';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

export function BudgetsPanel({ open, onClose, budgets }: BudgetsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  // sameVals[cat] holds a single annual cap (when mode='same').
  // monthVals[cat][m] holds per-month caps for months 0..11 in the current year.
  const [mode, setMode] = useState<Mode>('same');
  const [month, setMonth] = useState<number>(new Date().getUTCMonth());
  const [sameVals, setSameVals] = useState<Record<InvCat, number>>({
    housekeeping: 0,
    maintenance: 0,
    breakfast: 0,
  });
  const [monthVals, setMonthVals] = useState<Record<InvCat, number[]>>({
    housekeeping: Array(12).fill(0),
    maintenance: Array(12).fill(0),
    breakfast: Array(12).fill(0),
  });
  const [saving, setSaving] = useState(false);

  // Hydrate from props whenever the panel opens or budgets change.
  useEffect(() => {
    if (!open) return;
    const year = new Date().getUTCFullYear();
    const same: Record<InvCat, number> = { housekeeping: 0, maintenance: 0, breakfast: 0 };
    const months: Record<InvCat, number[]> = {
      housekeeping: Array(12).fill(0),
      maintenance: Array(12).fill(0),
      breakfast: Array(12).fill(0),
    };
    for (const b of budgets) {
      if (!b.monthStart) continue;
      if (b.monthStart.getUTCFullYear() !== year) continue;
      const m = b.monthStart.getUTCMonth();
      months[b.category as InvCat][m] = b.budgetCents / 100;
    }
    // If every month is identical across categories, the user is in 'same' mode.
    let allSame = true;
    for (const c of CATS) {
      const arr = months[c];
      const first = arr[0];
      if (arr.some((v) => v !== first)) {
        allSame = false;
        break;
      }
    }
    if (allSame) {
      for (const c of CATS) same[c] = months[c][0];
    } else {
      // Pick the max value across the year as the "same" fallback (only used
      // if user flips back to 'same' mode and edits).
      for (const c of CATS) same[c] = Math.max(...months[c], 0);
    }
    setSameVals(same);
    setMonthVals(months);
    setMode(allSame ? 'same' : 'months');
  }, [open, budgets]);

  const setCatSame = (cat: InvCat, v: number) =>
    setSameVals((p) => ({ ...p, [cat]: v }));
  const setCatMonth = (cat: InvCat, v: number) =>
    setMonthVals((p) => ({
      ...p,
      [cat]: p[cat].map((x, i) => (i === month ? v : x)),
    }));

  const copyToYear = () => {
    setMonthVals((p) => {
      const next: Record<InvCat, number[]> = { ...p };
      for (const c of CATS) {
        const v = p[c][month];
        next[c] = Array(12).fill(v);
      }
      return next;
    });
  };

  const total = useMemo(() => {
    return CATS.reduce(
      (s, c) => s + (mode === 'same' ? sameVals[c] : monthVals[c][month]),
      0,
    );
  }, [mode, sameVals, monthVals, month]);

  const handleSave = async () => {
    if (!user || !activePropertyId || saving) return;
    setSaving(true);
    try {
      const year = new Date().getUTCFullYear();
      const writes: Array<Promise<void>> = [];
      for (const c of CATS) {
        for (let m = 0; m < 12; m++) {
          const dollars = mode === 'same' ? sameVals[c] : monthVals[c][m];
          const cents = Math.max(0, Math.round(dollars * 100));
          writes.push(
            upsertInventoryBudget(user.uid, activePropertyId, {
              category: c as InventoryCategory,
              monthStart: new Date(Date.UTC(year, m, 1)),
              budgetCents: cents,
            }),
          );
        }
      }
      await Promise.all(writes);
      onClose();
    } catch (err) {
      console.error('[budgets] save failed', err);
      alert('Saving the budgets failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow="Budgets"
      italic="How much you have to spend"
      suffix={mode === 'same' ? 'every month' : `· ${MONTHS[month]}`}
      width={720}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Mode toggle */}
        <div>
          <Caps>How budgets work</Caps>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <ModeBtn
              active={mode === 'same'}
              onClick={() => setMode('same')}
              title="Same every month"
              sub="One number per category, used all year."
            />
            <ModeBtn
              active={mode === 'months'}
              onClick={() => setMode('months')}
              title="Different each month"
              sub="Set a different amount per month (busy season, etc)."
            />
          </div>
        </div>

        {/* Month picker (per-month mode only) */}
        {mode === 'months' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Caps>Month</Caps>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {MONTHS.map((m, i) => {
                const active = i === month;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMonth(i)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 7,
                      cursor: 'pointer',
                      background: active ? T.ink : 'transparent',
                      color: active ? T.bg : T.ink2,
                      border: `1px solid ${active ? T.ink : T.rule}`,
                      fontFamily: fonts.sans,
                      fontSize: 12,
                      fontWeight: 600,
                      minWidth: 42,
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Category rows */}
        <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 18px' }}>
          {CATS.map((cat, i) => {
            const v = mode === 'same' ? sameVals[cat] : monthVals[cat][month];
            const set = (val: number) =>
              mode === 'same' ? setCatSame(cat, val) : setCatMonth(cat, val);
            return (
              <div
                key={cat}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 160px',
                  gap: 14,
                  padding: '14px 0',
                  alignItems: 'center',
                  borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
                }}
              >
                <CatIcon cat={cat} size={32} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink, fontWeight: 600 }}>
                    {catLabel[cat]}
                  </span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3 }}>
                    {mode === 'same' ? 'used every month' : `for ${MONTHS[month]}`}
                  </span>
                </div>
                <div style={{ position: 'relative' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 14,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontFamily: fonts.serif,
                      fontSize: 18,
                      color: T.ink2,
                      fontStyle: 'italic',
                    }}
                  >
                    $
                  </span>
                  <input
                    type="number"
                    value={Number.isFinite(v) ? v : 0}
                    onChange={(e) => set(Number(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      height: 42,
                      padding: '0 14px 0 28px',
                      borderRadius: 10,
                      boxSizing: 'border-box',
                      background: T.bg,
                      border: `1px solid ${T.rule}`,
                      fontFamily: fonts.serif,
                      fontSize: 20,
                      fontStyle: 'italic',
                      color: T.ink,
                      letterSpacing: '-0.02em',
                      outline: 'none',
                      textAlign: 'right',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Total + copy shortcut */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            padding: '14px 18px',
            background: T.paper,
            border: `1px solid ${T.rule}`,
            borderRadius: 14,
          }}
        >
          <div>
            <Caps>Total this month</Caps>
            <div
              style={{
                fontFamily: fonts.serif,
                fontSize: 30,
                color: T.ink,
                letterSpacing: '-0.02em',
                fontStyle: 'italic',
                fontWeight: 400,
                lineHeight: 1.05,
                marginTop: 4,
              }}
            >
              {fmtMoney(total)}
            </div>
          </div>
          {mode === 'months' && (
            <Btn variant="ghost" size="md" onClick={copyToYear}>
              Copy {MONTHS[month]} to the whole year
            </Btn>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function ModeBtn({
  active,
  onClick,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: '14px 16px',
        borderRadius: 12,
        cursor: 'pointer',
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink,
        border: `1px solid ${active ? T.ink : T.rule}`,
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600 }}>{title}</span>
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 11,
          color: active ? 'rgba(255,255,255,0.7)' : T.ink2,
          lineHeight: 1.4,
        }}
      >
        {sub}
      </span>
    </button>
  );
}
