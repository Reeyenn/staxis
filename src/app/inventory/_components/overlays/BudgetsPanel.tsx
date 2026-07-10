'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { upsertInventoryBudget } from '@/lib/db';
import type { InventoryBudget, InventoryCategory } from '@/types';

import { T, fonts, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { catLabelFor, monthsFor, type Lang } from '../inv-i18n';

interface BudgetsPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  budgets: InventoryBudget[];
}

type Mode = 'same' | 'months';

const CATS: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

function bpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'Budgets',
      italic: 'How much you have to spend',
      everyMonth: 'every month',
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save',
      howBudgetsWork: 'How budgets work',
      sameTitle: 'Same every month',
      sameSub: 'One number per category, used all year.',
      monthsTitle: 'Different each month',
      monthsSub: 'Set a different amount per month (busy season, etc).',
      month: 'Month',
      usedEveryMonth: 'used every month',
      forMonth: (m: string) => `for ${m}`,
      totalThisMonth: 'Total this month',
      copyToYear: (m: string) => `Copy ${m} to the whole year`,
      saveFailed: 'Saving the budgets failed. Please try again.',
    },
    es: {
      eyebrow: 'Presupuestos',
      italic: 'Cuánto tienes para gastar',
      everyMonth: 'cada mes',
      cancel: 'Cancelar',
      saving: 'Guardando…',
      save: 'Guardar',
      howBudgetsWork: 'Cómo funcionan los presupuestos',
      sameTitle: 'Igual cada mes',
      sameSub: 'Un número por categoría, usado todo el año.',
      monthsTitle: 'Diferente cada mes',
      monthsSub: 'Define un monto distinto por mes (temporada alta, etc).',
      month: 'Mes',
      usedEveryMonth: 'usado cada mes',
      forMonth: (m: string) => `para ${m}`,
      totalThisMonth: 'Total este mes',
      copyToYear: (m: string) => `Copiar ${m} a todo el año`,
      saveFailed: 'No se pudieron guardar los presupuestos. Inténtalo de nuevo.',
    },
  }[lang];
}

export function BudgetsPanel({ lang, open, onClose, budgets }: BudgetsPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const bp = bpStrings(lang);
  const MONTHS = monthsFor(lang);

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
      alert(bp.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={bp.eyebrow}
      italic={bp.italic}
      suffix={mode === 'same' ? bp.everyMonth : `· ${MONTHS[month]}`}
      width={720}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={saving}>
            {bp.cancel}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving}>
            {saving ? bp.saving : bp.save}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Mode toggle */}
        <div>
          <Caps>{bp.howBudgetsWork}</Caps>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <ModeBtn
              active={mode === 'same'}
              onClick={() => setMode('same')}
              title={bp.sameTitle}
              sub={bp.sameSub}
            />
            <ModeBtn
              active={mode === 'months'}
              onClick={() => setMode('months')}
              title={bp.monthsTitle}
              sub={bp.monthsSub}
            />
          </div>
        </div>

        {/* Month picker (per-month mode only) */}
        {mode === 'months' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Caps>{bp.month}</Caps>
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
                    {catLabelFor(lang, cat)}
                  </span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3 }}>
                    {mode === 'same' ? bp.usedEveryMonth : bp.forMonth(MONTHS[month])}
                  </span>
                </div>
                <div style={{ position: 'relative' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 14,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontFamily: fonts.sans,
                      fontSize: 18,
                      fontWeight: 600,
                      color: T.ink2,
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
                      fontFamily: fonts.sans,
                      fontSize: 20,
                      fontWeight: 600,
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
            <Caps>{bp.totalThisMonth}</Caps>
            <div
              style={{
                fontFamily: fonts.sans,
                fontSize: 30,
                color: T.ink,
                letterSpacing: '-0.02em',
                fontWeight: 600,
                lineHeight: 1.05,
                marginTop: 4,
              }}
            >
              {fmtMoney(total)}
            </div>
          </div>
          {mode === 'months' && (
            <Btn variant="ghost" size="md" onClick={copyToYear}>
              {bp.copyToYear(MONTHS[month])}
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
