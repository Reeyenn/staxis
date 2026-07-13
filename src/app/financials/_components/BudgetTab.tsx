'use client';

// Budget — per-department monthly budget vs. actual (actual = live sum of
// checkbook expenses), as the Kanban redesign: a totals strip (Budgeted /
// Spent / Under-or-Over) + a grid of budget cards, plus the AI month-end
// overspend forecast and spend-anomaly alerts. Budgets are edited in a modal
// over the property's fixed departments (set a line to $0 to clear it). Reads
// /api/financials/budgets + /api/financials/forecast; budgets save through the
// upsert endpoint. Money is integer cents.

import React, { useState } from 'react';
import { Modal } from '@/app/maintenance/_components/_mt-snow';
import { useApiResource, useApiAction } from '@/lib/hooks/use-api-resource';
import {
  DEPARTMENTS,
  formatCents,
  parseDollarsToCents,
  type BudgetVsActual,
  type Department,
} from '@/lib/financials/shared';
import { finSend, Btn, Money, Card, Notice, DollarInput, T, FONT_SANS } from './fin-ui';
import { BudgetStatCard, BigMoney, Eyebrow, deptColor } from './fin-board';
import { ft, deptLabel, forecastTrendingMsg, anomalySpikeMsg } from './fin-i18n';

type Lang = 'en' | 'es';

interface ForecastRow {
  department: Department;
  budgetCents: number;
  projectedCents: number;
  pctOverBudget: number | null;
  trendingOver: boolean;
  confidence: 'low' | 'ok';
  message: string;
}
// SpendAnomaly rows from /api/financials/forecast (department spikes only on
// this endpoint). `message` is server-built English; the structured fields
// let the client rebuild it in the viewer's language.
interface AnomalyRow {
  department: Department | null;
  ratio: number;
  currentCents: number;
  baselineCents: number;
  message: string;
}

export function BudgetTab({
  pid,
  lang,
  month,
  onChanged,
}: {
  pid: string;
  lang: Lang;
  month: string;
  onChanged: () => void;
}) {
  const S = ft(lang);
  // Mutation/retry counter — rides the URLs as a fragment (never sent over
  // HTTP) so a refetch replays the full "Loading…" flash like the old load().
  const [nonce, setNonce] = useState(0);

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modalError, setModalError] = useState<string | null>(null);

  const bud = useApiResource<{ budgets: BudgetVsActual[] }>(`/api/financials/budgets?pid=${pid}&month=${month}#${nonce}`);
  // Forecast is best-effort: a failed read renders the grid without alerts /
  // projections (same as the old load(), which only errored on budgets).
  const fcRes = useApiResource<{ forecasts: ForecastRow[]; anomalies: AnomalyRow[] }>(`/api/financials/forecast?pid=${pid}&month=${month}#${nonce}`);

  const loading = bud.loading || fcRes.loading;
  const rows = bud.data?.budgets ?? [];
  const forecasts = fcRes.data?.forecasts ?? [];
  const anomalies = fcRes.data?.anomalies ?? [];

  const reloadAll = () => setNonce((n) => n + 1);

  const startEdit = () => {
    const d: Record<string, string> = {};
    for (const r of rows) d[r.department] = r.budgetCents > 0 ? (r.budgetCents / 100).toFixed(2) : '';
    setDrafts(d);
    setModalError(null);
    setEditing(true);
  };

  // One action = the whole save (only the changed departments are upserted,
  // sequentially). Stops at the first failure and reports it — a failed
  // upsert must not close the modal as if it saved. Re-saving after a
  // mid-loop failure re-upserts already-saved lines, which is harmless.
  const saveAction = useApiAction(async (changed: Array<{ department: Department; cents: number }>) => {
    for (const c of changed) {
      const res = await finSend('/api/financials/budgets', 'POST', { pid, department: c.department, month, budgetCents: c.cents });
      if (res.error) return res;
    }
    return { data: true as const };
  });

  const saveBudgets = async () => {
    const byDept = new Map(rows.map((r) => [r.department, r.budgetCents]));
    const changed: Array<{ department: Department; cents: number }> = [];
    for (const dept of DEPARTMENTS) {
      const raw = drafts[dept] ?? '';
      // Empty = clear to $0 (documented). Anything else must parse to a
      // non-negative amount — a typo ("1,50o") must NOT be coerced to $0,
      // which would silently wipe that department's existing budget.
      const cents = raw.trim() === '' ? 0 : parseDollarsToCents(raw);
      if (cents == null || cents < 0) {
        setModalError(`${S.invalidAmount} (${deptLabel(lang, dept)})`);
        return;
      }
      if (cents !== (byDept.get(dept) ?? 0)) changed.push({ department: dept, cents });
    }
    setModalError(null);
    const res = await saveAction.run(changed);
    if (res.error) {
      setModalError(S.couldNotSave);
      return;
    }
    setEditing(false);
    reloadAll();
    onChanged();
  };

  const trending = forecasts.filter((f) => f.trendingOver);

  if (loading) return <Notice text={S.loading} />;
  if (bud.error != null) return <Notice text={S.errorLoading} onRetry={reloadAll} />;

  const budgeted = rows.reduce((a, r) => a + r.budgetCents, 0);
  const spent = rows.reduce((a, r) => a + r.actualCents, 0);
  const left = budgeted - spent;
  const draftTotal = DEPARTMENTS.reduce((a, d) => a + (parseDollarsToCents(drafts[d] ?? '') ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Alerts (anomalies + trending over) */}
      {(trending.length > 0 || anomalies.length > 0) && (
        <Card style={{ borderColor: `${T.warm}44`, background: T.warmDim }}>
          <div style={{ fontFamily: FONT_SANS, fontSize: 12, fontWeight: 600, color: T.warm, marginBottom: 8 }}>⚠ {S.anomalies}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Server `message` strings are English-only; rebuild them in the
                viewer's language from the structured fields (EN output is
                identical to the server sentence). */}
            {trending.map((f) => (
              <div key={`t-${f.department}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
                {f.pctOverBudget != null
                  ? forecastTrendingMsg(lang, f.department, f.pctOverBudget, f.projectedCents, f.budgetCents)
                  : f.message}
              </div>
            ))}
            {anomalies.map((a, i) => (
              <div key={`a-${i}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
                {a.department != null
                  ? anomalySpikeMsg(lang, a.department, a.ratio, a.currentCents, a.baselineCents)
                  : a.message}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Totals strip */}
      <div style={{ display: 'flex', gap: 30, flexWrap: 'wrap', alignItems: 'center', padding: '0 0 18px', borderBottom: `1px solid ${T.ruleSoft}` }}>
        <div>
          <Eyebrow>{S.budget}</Eyebrow>
          <div style={{ marginTop: 3 }}>
            <BigMoney cents={budgeted} size={23} />
          </div>
        </div>
        <div>
          <Eyebrow>{S.actual}</Eyebrow>
          <div style={{ marginTop: 3 }}>
            <BigMoney cents={spent} size={23} />
          </div>
        </div>
        <div>
          <Eyebrow>{left >= 0 ? S.onTrack : S.overBudget}</Eyebrow>
          <div style={{ marginTop: 3 }}>
            <BigMoney cents={Math.abs(left)} size={23} color={left >= 0 ? T.sageDeep : T.warm} />
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 20 }} />
        <Btn variant="ghost" onClick={startEdit}>
          ⚙ {S.setBudgets}
        </Btn>
      </div>

      {/* Budget cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(264px, 1fr))', gap: 14 }}>
        {rows.map((r) => {
          const fc = forecasts.find((f) => f.department === r.department);
          const noBudget = r.budgetCents <= 0;
          const over = !noBudget && r.remainingCents < 0;
          const pct = r.budgetCents > 0 ? r.actualCents / r.budgetCents : 0;
          return (
            <BudgetStatCard
              key={r.department}
              name={deptLabel(lang, r.department)}
              color={deptColor(r.department)}
              pctLabel={noBudget ? '—' : over ? S.over.toUpperCase() : `${Math.round(r.pctUsed ?? 0)}%`}
              over={over}
              captionLabel={noBudget ? S.noBudget : over ? S.overBy : S.leftToSpend}
              remainingCents={noBudget ? r.actualCents : r.remainingCents}
              pct={pct}
              spentCents={r.actualCents}
              budgetCents={r.budgetCents}
              noBudget={noBudget}
              spentWord={S.spentWord}
              ofWord={S.ofWord}
              footnote={
                fc && fc.trendingOver ? (
                  <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>
                    → {S.projected}: <Money cents={fc.projectedCents} size={12} color={T.warm} /> ({S.trendingOver})
                  </div>
                ) : undefined
              }
            />
          );
        })}
      </div>

      {/* Set budgets modal */}
      {editing && (
        <Modal
          open
          onClose={() => setEditing(false)}
          title={S.setBudgets}
          width={480}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setEditing(false)}>
                {S.cancel}
              </Btn>
              <Btn onClick={() => void saveBudgets()} disabled={saveAction.saving}>
                {saveAction.saving ? S.saving : S.saveBudgets}
              </Btn>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {DEPARTMENTS.map((d) => (
              <div key={d} style={{ display: 'grid', gridTemplateColumns: '1fr 150px', alignItems: 'center', gap: 12 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 500 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: deptColor(d), flexShrink: 0 }} />
                  {deptLabel(lang, d)}
                </span>
                <DollarInput value={drafts[d] ?? ''} onChange={(v) => setDrafts({ ...drafts, [d]: v })} />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderTop: `1px solid ${T.ruleSoft}`, marginTop: 6, paddingTop: 14 }}>
              <Eyebrow>{S.totalMonthly}</Eyebrow>
              <span style={{ fontFamily: FONT_SANS, fontSize: 20, color: T.ink, fontWeight: 600, letterSpacing: '-0.02em' }}>{formatCents(draftTotal, { showCents: false })}</span>
            </div>
            {modalError && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{modalError}</span>}
          </div>
        </Modal>
      )}
    </div>
  );
}
