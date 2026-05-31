'use client';

// CapEx — capital projects. List (quote vs spent-to-date + overrun %), project
// detail with line items, create/edit/delete, and "scan quote" which reads a
// contractor estimate into a new-project draft (Smart CapEx). Reads/writes
// through /api/financials/capex(+/line-items). Money is integer cents.

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Field, TextInput, TextArea } from '@/app/maintenance/_components/_mt-snow';
import {
  CAPEX_STATUSES,
  parseDollarsToCents,
  type CapexProject,
  type CapexLineItem,
  type CapexStatus,
} from '@/lib/financials/shared';
import { apiGet, apiSend, Btn, Money, Pill, Card, Notice, BudgetBar, DollarInput, T, FONT_SANS } from './fin-ui';
import { ft, capexStatusLabel } from './fin-i18n';
import { ScanButton, type QuoteDraft } from './ScanButton';

type Lang = 'en' | 'es';

function statusColor(s: CapexStatus): string {
  if (s === 'complete') return T.sageDeep;
  if (s === 'cancelled' || s === 'on_hold') return T.ink3;
  if (s === 'in_progress') return T.caramelDeep;
  return T.ink2;
}

interface NewProjectForm {
  name: string;
  quote: string;
  vendor: string;
  status: CapexStatus;
  startDate: string;
  targetDate: string;
  description: string;
  pendingLines: Array<{ label: string; amountCents: number | null }>;
}

export function CapexTab({ pid, lang, onChanged }: { pid: string; lang: Lang; onChanged: () => void }) {
  const S = ft(lang);
  const [projects, setProjects] = useState<CapexProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CapexProject | null>(null);
  const [form, setForm] = useState<NewProjectForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErrored(false);
    const res = await apiGet<{ projects: CapexProject[] }>(`/api/financials/capex?pid=${pid}`);
    if (!res.ok || !res.data) {
      setErrored(true);
      setLoading(false);
      return;
    }
    setProjects(res.data.projects);
    setLoading(false);
  }, [pid]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    setOpenId(id);
    setDetail(null);
    const res = await apiGet<{ project: CapexProject }>(`/api/financials/capex?pid=${pid}&id=${id}`);
    if (res.ok && res.data) setDetail(res.data.project);
  };

  const blankForm = (): NewProjectForm => ({
    name: '',
    quote: '',
    vendor: '',
    status: 'planned',
    startDate: '',
    targetDate: '',
    description: '',
    pendingLines: [],
  });

  const onScanQuote = (d: QuoteDraft) => {
    setForm({
      name: d.name ?? '',
      quote: d.quoteCents != null ? (d.quoteCents / 100).toFixed(2) : '',
      vendor: d.vendor ?? '',
      status: 'planned',
      startDate: '',
      targetDate: d.quoteDate ?? '',
      description: d.summary ?? '',
      pendingLines: d.lineItems.filter((l) => l.label.trim()),
    });
  };

  const createProject = async () => {
    if (!form) return;
    if (!form.name.trim()) return;
    setSaving(true);
    const quoteCents = form.quote.trim() ? parseDollarsToCents(form.quote) ?? 0 : 0;
    const res = await apiSend<{ project: CapexProject }>('/api/financials/capex', 'POST', {
      pid,
      name: form.name.trim(),
      quoteCents,
      vendor: form.vendor.trim() || null,
      status: form.status,
      startDate: form.startDate || null,
      targetDate: form.targetDate || null,
      description: form.description.trim() || null,
    });
    if (res.ok && res.data) {
      // Persist any scanned line items onto the new project.
      const newId = res.data.project.id;
      for (const l of form.pendingLines) {
        await apiSend('/api/financials/capex/line-items', 'POST', {
          pid,
          projectId: newId,
          label: l.label,
          amountCents: l.amountCents ?? 0,
          source: 'invoice_scan',
        });
      }
    }
    setSaving(false);
    setForm(null);
    await load();
    onChanged();
  };

  if (loading) return <Notice text={S.loading} />;
  if (errored) return <Notice text={S.errorLoading} onRetry={() => void load()} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600, color: T.ink }}>{S.projects}</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ScanButton mode="quote" pid={pid} label={S.scanQuote} scanningLabel={S.scanning} failLabel={S.scanFailed} onQuote={onScanQuote} />
          <Btn onClick={() => setForm(blankForm())}>+ {S.newProject}</Btn>
        </div>
      </div>

      {projects.length === 0 ? (
        <Notice text={S.noProjects} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map((p) => {
            const spent = p.spentCents ?? 0;
            const over = p.quoteCents > 0 && spent > p.quoteCents;
            const overrunPct = p.quoteCents > 0 ? Math.round(((spent - p.quoteCents) / p.quoteCents) * 100) : null;
            return (
              <Card key={p.id} style={{ padding: 16, cursor: 'pointer' }}>
                <div onClick={() => void openDetail(p.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600, color: T.ink }}>{p.name}</span>
                    <Pill label={capexStatusLabel(lang, p.status)} color={statusColor(p.status)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <Money cents={spent} size={18} color={over ? T.warm : T.ink} />
                    <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>
                      {S.spent} · {S.quote} <Money cents={p.quoteCents} size={12} weight={500} color={T.ink2} />
                    </span>
                  </div>
                  <BudgetBar actualCents={spent} budgetCents={p.quoteCents} status={over ? 'over' : 'good'} />
                  {overrunPct != null && (
                    <div style={{ marginTop: 7, fontFamily: FONT_SANS, fontSize: 12, color: over ? T.warm : T.sageDeep }}>
                      {over ? `${overrunPct}% ${S.overrun}` : `${Math.abs(overrunPct)}% ${S.underQuote}`}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail modal */}
      {openId && (
        <ProjectDetail
          pid={pid}
          lang={lang}
          project={detail}
          onClose={() => {
            setOpenId(null);
            setDetail(null);
          }}
          onChanged={async () => {
            await load();
            onChanged();
            if (openId) {
              const res = await apiGet<{ project: CapexProject }>(`/api/financials/capex?pid=${pid}&id=${openId}`);
              if (res.ok && res.data) setDetail(res.data.project);
            }
          }}
        />
      )}

      {/* New project modal */}
      {form && (
        <Modal
          open
          onClose={() => setForm(null)}
          title={S.newProject}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setForm(null)}>
                {S.cancel}
              </Btn>
              <Btn onClick={() => void createProject()} disabled={saving || !form.name.trim()}>
                {saving ? S.saving : S.save}
              </Btn>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label={S.projectName} required>
              <TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoFocus />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label={S.quote}>
                <DollarInput value={form.quote} onChange={(v) => setForm({ ...form, quote: v })} />
              </Field>
              <Field label={S.status}>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CapexStatus })} style={selStyle}>
                  {CAPEX_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {capexStatusLabel(lang, s)}
                    </option>
                  ))}
                </select>
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
      )}
    </div>
  );
}

// ── Project detail (line items) ──────────────────────────────────────────
function ProjectDetail({
  pid,
  lang,
  project,
  onClose,
  onChanged,
}: {
  pid: string;
  lang: Lang;
  project: CapexProject | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const S = ft(lang);
  const [addLabel, setAddLabel] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [busy, setBusy] = useState(false);

  if (!project) {
    return (
      <Modal open onClose={onClose} title="…">
        <Notice text={S.loading} />
      </Modal>
    );
  }

  const spent = project.spentCents ?? 0;
  const over = project.quoteCents > 0 && spent > project.quoteCents;

  const addLine = async () => {
    if (!addLabel.trim()) return;
    setBusy(true);
    await apiSend('/api/financials/capex/line-items', 'POST', {
      pid,
      projectId: project.id,
      label: addLabel.trim(),
      amountCents: addAmount.trim() ? parseDollarsToCents(addAmount) ?? 0 : 0,
    });
    setAddLabel('');
    setAddAmount('');
    setBusy(false);
    onChanged();
  };

  const delLine = async (id: string) => {
    await apiSend('/api/financials/capex/line-items', 'DELETE', { pid, id, projectId: project.id });
    onChanged();
  };

  const delProject = async () => {
    if (!window.confirm(S.confirmDeleteProject)) return;
    const res = await apiSend('/api/financials/capex', 'DELETE', { pid, id: project.id });
    if (res.ok) {
      onClose();
      onChanged();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={project.name}
      subtitle={project.vendor ?? undefined}
      footer={
        <>
          <Btn variant="danger" onClick={() => void delProject()}>
            {S.deleteProject}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>
            {S.close}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card style={{ background: T.bg }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <Money cents={spent} size={22} color={over ? T.warm : T.ink} />
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>
              {S.spent} / {S.quote} <Money cents={project.quoteCents} size={12} weight={500} color={T.ink2} />
            </span>
          </div>
          <BudgetBar actualCents={spent} budgetCents={project.quoteCents} status={over ? 'over' : 'good'} />
        </Card>

        <div>
          <div style={{ fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 8 }}>{S.lineItems}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(project.lineItems ?? []).map((l: CapexLineItem) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${T.ruleSoft}` }}>
                <span style={{ flex: 1, fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>{l.label}</span>
                <Money cents={l.amountCents} size={13} />
                <button onClick={() => void delLine(l.id)} style={{ background: 'transparent', border: 'none', color: T.warm, cursor: 'pointer', fontSize: 13 }} aria-label={S.delete}>
                  ✕
                </button>
              </div>
            ))}
            {(project.lineItems ?? []).length === 0 && (
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3 }}>—</span>
            )}
          </div>

          {/* Add line */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <TextInput value={addLabel} onChange={setAddLabel} placeholder={S.label} />
            </div>
            <div style={{ width: 120 }}>
              <DollarInput value={addAmount} onChange={setAddAmount} />
            </div>
            <Btn onClick={() => void addLine()} disabled={busy || !addLabel.trim()}>
              +
            </Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const selStyle: React.CSSProperties = {
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
  cursor: 'pointer',
};
