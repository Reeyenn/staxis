'use client';

// Budget — per-department monthly budget vs. actual (actual = live sum of
// checkbook expenses). 70/30-style color bars, inline budget editor, plus the
// AI month-end overspend forecast and spend-anomaly alerts. Reads
// /api/financials/budgets + /api/financials/forecast; budgets save through the
// upsert endpoint. Money is integer cents.

import React, { useCallback, useEffect, useState } from 'react';
import {
  DEPARTMENTS,
  parseDollarsToCents,
  type BudgetVsActual,
  type Department,
} from '@/lib/financials/shared';
import { apiGet, apiSend, Btn, Money, Pill, Card, Notice, BudgetBar, DollarInput, STATUS_COLOR, T, FONT_SANS, FONT_MONO } from './fin-ui';
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

      {/* Budget vs actual */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600, color: T.ink }}>{S.budgetVsActual}</span>
          {editing ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="ghost" onClick={() => setEditing(false)}>
                {S.cancel}
              </Btn>
              <Btn onClick={() => void saveBudgets()} disabled={saving}>
                {saving ? S.saving : S.saveBudgets}
              </Btn>
            </div>
          ) : (
            <Btn variant="ghost" onClick={startEdit}>
              {S.setBudgets}
            </Btn>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => {
            const fc = forecasts.find((f) => f.department === r.department);
            const color = STATUS_COLOR[r.status];
            return (
              <Card key={r.department} style={{ padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>{deptLabel(lang, r.department)}</span>
                  {editing ? (
                    <div style={{ width: 130 }}>
                      <DollarInput value={drafts[r.department] ?? ''} onChange={(v) => setDrafts({ ...drafts, [r.department]: v })} />
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Money cents={r.actualCents} size={14} />
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>/</span>
                      <Money cents={r.budgetCents} size={13} weight={500} color={T.ink2} />
                    </div>
                  )}
                </div>
                {!editing && (
                  <>
                    <BudgetBar actualCents={r.actualCents} budgetCents={r.budgetCents} status={r.status} />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 7 }}>
                      <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>
                        {r.budgetCents === 0 ? (
                          S.noBudget
                        ) : r.remainingCents < 0 ? (
                          <>
                            <Money cents={-r.remainingCents} size={12} weight={600} color={T.warm} /> {S.over}
                          </>
                        ) : (
                          <>
                            <Money cents={r.remainingCents} size={12} weight={600} color={T.sageDeep} /> {S.headroom}
                          </>
                        )}
                      </span>
                      {r.budgetCents > 0 && <Pill label={r.pctUsed != null ? `${Math.round(r.pctUsed)}%` : '—'} color={color} />}
                    </div>
                    {fc && fc.trendingOver && (
                      <div style={{ marginTop: 7, fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>
                        → {S.projected}: <Money cents={fc.projectedCents} size={12} color={T.warm} /> ({S.trendingOver})
                      </div>
                    )}
                  </>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
