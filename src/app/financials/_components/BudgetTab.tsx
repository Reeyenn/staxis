'use client';

// Budget — per-department monthly budget vs. actual (actual = live sum of
// checkbook expenses), as the Kanban redesign: a totals strip (Budgeted /
// Spent / Under-or-Over) + a grid of budget cards, plus the AI month-end
// overspend forecast and spend-anomaly alerts. Budgets are edited in a modal
// over the property's fixed departments (set a line to $0 to clear it). Reads
// /api/financials/budgets + /api/financials/forecast; budgets save through the
// upsert endpoint. Money is integer cents.

import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/app/maintenance/_components/_mt-snow';
import {
  DEPARTMENTS,
  formatCents,
  parseDollarsToCents,
  type BudgetVsActual,
  type Department,
} from '@/lib/financials/shared';
import { apiGet, apiSend, Btn, Money, Card, Notice, DollarInput, T, FONT_SANS, FONT_MONO, FONT_SERIF } from './fin-ui';
import { BudgetStatCard, BigMoney, Eyebrow, deptColor } from './fin-board';
import { ft, deptLabel } from './fin-i18n';

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
interface AnomalyRow {
  department: Department | null;
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
  const [rows, setRows] = useState<BudgetVsActual[]>([]);
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErrored(false);
    const [b, f] = await Promise.all([
      apiGet<{ budgets: BudgetVsActual[] }>(`/api/financials/budgets?pid=${pid}&month=${month}`),
      apiGet<{ forecasts: ForecastRow[]; anomalies: AnomalyRow[] }>(`/api/financials/forecast?pid=${pid}&month=${month}`),
    ]);
    if (!b.ok || !b.data) {
      setErrored(true);
      setLoading(false);
      return;
    }
    setRows(b.data.budgets);
    setForecasts(f.ok && f.data ? f.data.forecasts : []);
    setAnomalies(f.ok && f.data ? f.data.anomalies : []);
    setLoading(false);
  }, [pid, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = () => {
    const d: Record<string, string> = {};
    for (const r of rows) d[r.department] = r.budgetCents > 0 ? (r.budgetCents / 100).toFixed(2) : '';
    setDrafts(d);
    setEditing(true);
  };

  const saveBudgets = async () => {
    setSaving(true);
    const byDept = new Map(rows.map((r) => [r.department, r.budgetCents]));
    const changed: Array<{ department: Department; cents: number }> = [];
    for (const dept of DEPARTMENTS) {
      const raw = drafts[dept] ?? '';
      const cents = raw.trim() === '' ? 0 : parseDollarsToCents(raw) ?? 0;
      if (cents !== (byDept.get(dept) ?? 0)) changed.push({ department: dept, cents });
    }
    for (const c of changed) {
      await apiSend('/api/financials/budgets', 'POST', { pid, department: c.department, month, budgetCents: c.cents });
    }
    setSaving(false);
    setEditing(false);
    await load();
    onChanged();
  };

  const trending = forecasts.filter((f) => f.trendingOver);

  if (loading) return <Notice text={S.loading} />;
  if (errored) return <Notice text={S.errorLoading} onRetry={() => void load()} />;

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
            {trending.map((f) => (
              <div key={`t-${f.department}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
                {f.message}
              </div>
            ))}
            {anomalies.map((a, i) => (
              <div key={`a-${i}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
                {a.message}
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
            <BigMoney cents={budgeted} size={30} />
          </div>
        </div>
        <div>
          <Eyebrow>{S.actual}</Eyebrow>
          <div style={{ marginTop: 3 }}>
            <BigMoney cents={spent} size={30} />
          </div>
        </div>
        <div>
          <Eyebrow>{left >= 0 ? S.onTrack : S.overBudget}</Eyebrow>
          <div style={{ marginTop: 3 }}>
            <BigMoney cents={Math.abs(left)} size={30} color={left >= 0 ? T.sageDeep : T.warm} />
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
              <Btn onClick={() => void saveBudgets()} disabled={saving}>
                {saving ? S.saving : S.saveBudgets}
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
              <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 24, color: T.ink, fontWeight: 500 }}>{formatCents(draftTotal, { showCents: false })}</span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
