'use client';

// Checkbook — the expense register. List + month total + department filter,
// add/edit/delete, and "scan invoice" which pre-fills the add form from Claude
// Vision (vendor, total, AI-suggested department) with a 2×-outlier warning.
// All reads/writes go through /api/financials/expenses (service-role + finance
// gate). Money is integer cents; the dollar input is parsed once on save.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Field,
  TextInput,
  TextArea,
} from '@/app/maintenance/_components/_mt-snow';
import {
  DEPARTMENTS,
  parseDollarsToCents,
  type Department,
  type FinancialExpense,
} from '@/lib/financials/shared';
import { apiGet, apiSend, Btn, Money, Pill, Card, Notice, DollarInput, T, FONT_SANS, FONT_MONO } from './fin-ui';
import { ft, deptLabel } from './fin-i18n';
import { ScanButton, type InvoiceDraft } from './ScanButton';

type Lang = 'en' | 'es';

interface FormState {
  id: string | null;
  vendor: string;
  amount: string; // dollar text
  department: Department;
  category: string;
  date: string; // YYYY-MM-DD
  notes: string;
  source: 'manual' | 'invoice_scan';
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankForm(): FormState {
  return { id: null, vendor: '', amount: '', department: 'other', category: '', date: todayYmd(), notes: '', source: 'manual' };
}

export function CheckbookTab({
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
  const [expenses, setExpenses] = useState<FinancialExpense[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [deptFilter, setDeptFilter] = useState<Department | 'all'>('all');

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [anomalyWarning, setAnomalyWarning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrored(false);
    const qs = new URLSearchParams({ pid, month });
    if (deptFilter !== 'all') qs.set('department', deptFilter);
    const res = await apiGet<{ expenses: FinancialExpense[]; total: number }>(`/api/financials/expenses?${qs}`);
    if (!res.ok || !res.data) {
      setErrored(true);
      setLoading(false);
      return;
    }
    setExpenses(res.data.expenses);
    setTotal(res.data.total);
    setLoading(false);
  }, [pid, month, deptFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openAdd = () => {
    setFormError(null);
    setAnomalyWarning(null);
    setForm(blankForm());
  };
  const openEdit = (e: FinancialExpense) => {
    setFormError(null);
    setAnomalyWarning(null);
    setForm({
      id: e.id,
      vendor: e.vendor ?? '',
      amount: (e.amountCents / 100).toFixed(2),
      department: e.department,
      category: e.category ?? '',
      date: e.expenseDate,
      notes: e.notes ?? '',
      source: e.source,
    });
  };

  const onScanDraft = (draft: InvoiceDraft, warn: string | null) => {
    setFormError(null);
    setAnomalyWarning(warn);
    setForm({
      id: null,
      vendor: draft.vendor ?? '',
      amount: draft.amountCents != null ? (draft.amountCents / 100).toFixed(2) : '',
      department: (DEPARTMENTS as readonly string[]).includes(draft.department) ? (draft.department as Department) : 'other',
      category: draft.summary ?? '',
      date: draft.invoiceDate ?? todayYmd(),
      notes: '',
      source: 'invoice_scan',
    });
  };

  const save = async () => {
    if (!form) return;
    const cents = parseDollarsToCents(form.amount);
    if (cents == null || cents < 0) {
      setFormError(lang === 'es' ? 'Ingresa un monto válido.' : 'Enter a valid amount.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      setFormError(lang === 'es' ? 'Ingresa una fecha válida.' : 'Enter a valid date.');
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      pid,
      id: form.id ?? undefined,
      expenseDate: form.date,
      amountCents: cents,
      vendor: form.vendor.trim() || null,
      department: form.department,
      category: form.category.trim() || null,
      notes: form.notes.trim() || null,
      source: form.source,
    };
    const res = form.id
      ? await apiSend('/api/financials/expenses', 'PATCH', payload)
      : await apiSend('/api/financials/expenses', 'POST', payload);
    setSaving(false);
    if (!res.ok) {
      setFormError(lang === 'es' ? 'No se pudo guardar.' : 'Could not save.');
      return;
    }
    setForm(null);
    await load();
    onChanged();
  };

  const del = async (id: string) => {
    if (!window.confirm(S.confirmDelete)) return;
    const res = await apiSend('/api/financials/expenses', 'DELETE', { pid, id, month });
    if (res.ok) {
      await load();
      onChanged();
    }
  };

  const deptOptions = useMemo(
    () => [{ value: 'all' as const, label: S.allDepartments }, ...DEPARTMENTS.map((d) => ({ value: d, label: deptLabel(lang, d) }))],
    [lang, S.allDepartments],
  );

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>{S.monthTotal}</span>
          <Money cents={total} size={22} weight={600} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value as Department | 'all')}
            style={selectStyle}
          >
            {deptOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ScanButton mode="invoice" pid={pid} label={S.scanInvoice} scanningLabel={S.scanning} failLabel={S.scanFailed} onInvoice={onScanDraft} />
          <Btn onClick={openAdd}>+ {S.addExpense}</Btn>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <Notice text={S.loading} />
      ) : errored ? (
        <Notice text={S.errorLoading} onRetry={() => void load()} />
      ) : expenses.length === 0 ? (
        <Notice text={S.noExpenses} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {expenses.map((e) => (
            <Card key={e.id} style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>
                    {e.vendor || (lang === 'es' ? 'Sin proveedor' : 'No vendor')}
                  </span>
                  <Pill label={deptLabel(lang, e.department)} color={T.ink2} />
                  {e.source === 'invoice_scan' && <Pill label={S.fromScan} color={T.sageDeep} />}
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, marginTop: 3 }}>
                  {e.expenseDate}
                  {e.category ? ` · ${e.category}` : ''}
                </div>
              </div>
              <Money cents={e.amountCents} size={15} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => openEdit(e)} style={iconBtn} aria-label={S.edit}>
                  ✎
                </button>
                <button onClick={() => void del(e.id)} style={{ ...iconBtn, color: T.warm }} aria-label={S.delete}>
                  ✕
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add / edit modal */}
      {form && (
        <Modal
          open
          onClose={() => setForm(null)}
          title={form.id ? S.edit : S.addExpense}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setForm(null)}>
                {S.cancel}
              </Btn>
              <Btn onClick={() => void save()} disabled={saving}>
                {saving ? S.saving : S.save}
              </Btn>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {anomalyWarning && (
              <div style={{ padding: '10px 12px', borderRadius: 10, background: T.warmDim, border: `1px solid ${T.warm}33`, fontFamily: FONT_SANS, fontSize: 13, color: T.warm }}>
                ⚠ {anomalyWarning}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label={S.amount} required>
                <DollarInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} autoFocus />
              </Field>
              <Field label={S.date} required>
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} style={dateStyle} />
              </Field>
            </div>
            <Field label={S.vendor}>
              <TextInput value={form.vendor} onChange={(v) => setForm({ ...form, vendor: v })} placeholder={lang === 'es' ? 'p. ej. Sysco' : 'e.g. Sysco'} />
            </Field>
            <Field label={S.department} required>
              <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value as Department })} style={{ ...selectStyle, width: '100%', height: 40 }}>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {deptLabel(lang, d)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`${S.category} (${S.optional})`}>
              <TextInput value={form.category} onChange={(v) => setForm({ ...form, category: v })} placeholder={lang === 'es' ? 'p. ej. toallas' : 'e.g. towels'} />
            </Field>
            <Field label={`${S.notes} (${S.optional})`}>
              <TextArea value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} rows={2} />
            </Field>
            {formError && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{formError}</span>}
          </div>
        </Modal>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  height: 38,
  padding: '0 12px',
  borderRadius: 10,
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS,
  fontSize: 13,
  color: T.ink,
  cursor: 'pointer',
  outline: 'none',
};
const dateStyle: React.CSSProperties = {
  height: 40,
  padding: '0 12px',
  borderRadius: 10,
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS,
  fontSize: 14,
  color: T.ink,
  width: '100%',
  boxSizing: 'border-box',
  outline: 'none',
};
const iconBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: `1px solid ${T.rule}`,
  background: 'transparent',
  color: T.ink2,
  cursor: 'pointer',
  fontSize: 13,
  flexShrink: 0,
};
