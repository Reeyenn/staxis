'use client';

// CapEx new-request form — the modal that submits a capital request (title,
// estimate, type, category, target date, vendor, description), optionally
// pre-filled from a scanned contractor quote (pendingLines are added as
// line items right after the create). Split out of CapexTab so the board
// file keeps only the list + workflow orchestration. Money is integer cents.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Field, TextInput, TextArea } from '@/app/maintenance/_components/_mt-snow';
import { useApiAction } from '@/lib/hooks/use-api-resource';
import {
  CAPEX_CATEGORIES,
  parseDollarsToCents,
  type CapexProject,
  type CapexCategory,
  type RequestType,
} from '@/lib/financials/shared';
import { finSend, newFinancialCreateOperationId, Btn, DollarInput, T, FONT_SANS } from './fin-ui';
import { ft, capexCategoryLabel } from './fin-i18n';

type Lang = 'en' | 'es';

export interface RequestForm {
  /** Frozen for this create form so a lost response can be retried exactly. */
  operationId: string;
  name: string;
  description: string;
  category: CapexCategory | '';
  estimate: string;
  requestType: RequestType;
  targetDate: string;
  vendor: string;
  pendingLines: Array<{ operationId: string; label: string; amountCents: number | null }>;
}
export function blankRequest(): RequestForm {
  return {
    operationId: newFinancialCreateOperationId(),
    name: '',
    description: '',
    category: '',
    estimate: '',
    requestType: 'budgeted',
    targetDate: '',
    vendor: '',
    pendingLines: [],
  };
}

export function RequestModal({
  scopeKey,
  pid,
  lang,
  form,
  setForm,
  onClose,
  onCreated,
}: {
  scopeKey: string;
  pid: string;
  lang: Lang;
  form: RequestForm;
  setForm: (f: RequestForm) => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const S = ft(lang);
  const activeScopeRef = useRef<string | null>(scopeKey);
  const submitAttemptRef = useRef(0);
  useEffect(() => {
    activeScopeRef.current = scopeKey;
    return () => {
      activeScopeRef.current = null;
      submitAttemptRef.current += 1;
    };
  }, [scopeKey]);
  const ownsScope = useCallback(
    () => activeScopeRef.current === scopeKey,
    [scopeKey],
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  // One action = create + (on success) the scanned line items, sequentially.
  // Returns an error result when the CREATE fails (the modal must stay open —
  // closing would silently discard everything typed); line-item failures are
  // counted so a partial add is surfaced, not swallowed.
  const create = useApiAction(async (input: { propertyId: string; draft: RequestForm }) => {
    const f = input.draft;
    const res = await finSend<{ project: CapexProject }>('/api/financials/capex', 'POST', {
      pid: input.propertyId,
      operationId: f.operationId,
      name: f.name.trim(),
      description: f.description.trim() || null,
      category: f.category || null,
      estimatedCostCents: f.estimate.trim() ? parseDollarsToCents(f.estimate) ?? 0 : 0,
      requestType: f.requestType,
      targetDate: f.targetDate || null,
      vendor: f.vendor.trim() || null,
    });
    if (res.error !== undefined) return res;
    if (!ownsScope()) return { error: 'Financial scope changed' };
    const newId = res.data.project.id;
    let failedLines = 0;
    for (const l of f.pendingLines) {
      if (!ownsScope()) return { error: 'Financial scope changed' };
      const lineRes = await finSend('/api/financials/capex/line-items', 'POST', {
        pid: input.propertyId,
        operationId: l.operationId,
        projectId: newId,
        label: l.label,
        amountCents: l.amountCents ?? 0,
        source: 'invoice_scan',
      });
      if (lineRes.error) failedLines += 1;
    }
    return { data: { project: res.data.project, failedLines } };
  }, {
    // This is a finite composite action: every finSend has its own 30-second
    // transport/body deadline. Do not race the whole workflow at 30 seconds;
    // the project may already exist while scanned lines are still settling,
    // and reporting total failure here would let a retry create a duplicate.
    timeoutMs: null,
  });
  const submit = async () => {
    if (!form.name.trim()) return;
    setSubmitError(null);
    const requestedPropertyId = pid;
    const attempt = ++submitAttemptRef.current;
    const ownsAttempt = () => ownsScope() && submitAttemptRef.current === attempt;
    const res = await create.run({
      propertyId: requestedPropertyId,
      draft: { ...form, pendingLines: form.pendingLines.map((line) => ({ ...line })) },
    });
    if (!ownsAttempt()) return;
    if (res.error) {
      setSubmitError(S.couldNotSave);
      return;
    }
    onClose();
    onCreated();
    if (res.data && res.data.failedLines > 0) {
      // The project itself saved (the board refetch shows it) — but don't
      // pretend the scanned line items all made it in.
      window.alert(S.linesPartial);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={S.newRequest}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>{S.cancel}</Btn>
          <Btn onClick={() => void submit()} disabled={create.saving || !form.name.trim()}>{create.saving ? S.saving : S.submitRequest}</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={S.requestTitle} required>
          <TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoFocus />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={S.estimatedCost}>
            <DollarInput value={form.estimate} onChange={(v) => setForm({ ...form, estimate: v })} />
          </Field>
          <Field label={S.typeLabel}>
            <select value={form.requestType} onChange={(e) => setForm({ ...form, requestType: e.target.value as RequestType })} style={selStyle}>
              <option value="budgeted">{S.budgeted}</option>
              <option value="emergency">{S.emergency}</option>
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={S.category}>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as CapexCategory | '' })} style={selStyle}>
              <option value="">—</option>
              {CAPEX_CATEGORIES.map((c) => (
                <option key={c} value={c}>{capexCategoryLabel(lang, c)}</option>
              ))}
            </select>
          </Field>
          <Field label={S.targetDate}>
            <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} style={dateStyle} />
          </Field>
        </div>
        <Field label={S.vendor}>
          <TextInput value={form.vendor} onChange={(v) => setForm({ ...form, vendor: v })} />
        </Field>
        {form.pendingLines.length > 0 && (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: T.sageDim, fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>
            {form.pendingLines.length} {S.lineItems.toLowerCase()} {lang === 'es' ? 'del escaneo se agregarán' : 'from the scan will be added'}.
          </div>
        )}
        <Field label={`${S.description} (${S.optional})`}>
          <TextArea value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={2} />
        </Field>
        {submitError && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{submitError}</span>}
      </div>
    </Modal>
  );
}

const selStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10, background: T.bg, border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%', boxSizing: 'border-box', outline: 'none', cursor: 'pointer',
};
const dateStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10, background: T.bg, border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%', boxSizing: 'border-box', outline: 'none',
};
