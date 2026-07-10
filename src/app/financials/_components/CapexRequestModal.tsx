'use client';

// CapEx new-request form — the modal that submits a capital request (title,
// estimate, type, category, target date, vendor, description), optionally
// pre-filled from a scanned contractor quote (pendingLines are added as
// line items right after the create). Split out of CapexTab so the board
// file keeps only the list + workflow orchestration. Money is integer cents.

import React from 'react';
import { Modal, Field, TextInput, TextArea } from '@/app/maintenance/_components/_mt-snow';
import { useApiAction } from '@/lib/hooks/use-api-resource';
import {
  CAPEX_CATEGORIES,
  parseDollarsToCents,
  type CapexProject,
  type CapexCategory,
  type RequestType,
} from '@/lib/financials/shared';
import { finSend, Btn, DollarInput, T, FONT_SANS } from './fin-ui';
import { ft, capexCategoryLabel } from './fin-i18n';

type Lang = 'en' | 'es';

export interface RequestForm {
  name: string;
  description: string;
  category: CapexCategory | '';
  estimate: string;
  requestType: RequestType;
  targetDate: string;
  vendor: string;
  pendingLines: Array<{ label: string; amountCents: number | null }>;
}
export function blankRequest(): RequestForm {
  return { name: '', description: '', category: '', estimate: '', requestType: 'budgeted', targetDate: '', vendor: '', pendingLines: [] };
}

export function RequestModal({
  pid,
  lang,
  form,
  setForm,
  onClose,
  onCreated,
}: {
  pid: string;
  lang: Lang;
  form: RequestForm;
  setForm: (f: RequestForm) => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const S = ft(lang);
  // One action = create + (on success) the scanned line items, sequentially.
  const create = useApiAction(async (f: RequestForm) => {
    const res = await finSend<{ project: CapexProject }>('/api/financials/capex', 'POST', {
      pid,
      name: f.name.trim(),
      description: f.description.trim() || null,
      category: f.category || null,
      estimatedCostCents: f.estimate.trim() ? parseDollarsToCents(f.estimate) ?? 0 : 0,
      requestType: f.requestType,
      targetDate: f.targetDate || null,
      vendor: f.vendor.trim() || null,
    });
    if (res.data) {
      const newId = res.data.project.id;
      for (const l of f.pendingLines) {
        await finSend('/api/financials/capex/line-items', 'POST', { pid, projectId: newId, label: l.label, amountCents: l.amountCents ?? 0, source: 'invoice_scan' });
      }
    }
    return res;
  });
  const submit = async () => {
    if (!form.name.trim()) return;
    await create.run(form);
    onClose();
    onCreated();
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
