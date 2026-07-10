'use client';

// CapEx — full capital-request approval workflow, presented as a status board
// (Kanban redesign). Submit a request → owner/GM approves / rejects / asks for
// changes → in-progress (% complete) → completed. The board groups projects
// into Pending · Active · Closed columns; clicking a card opens its binder,
// which now hosts the approve/reject/revisions decision and the progress
// controls. Forecast (upcoming capital spend) and a multi-property Rollup are
// switchable views. Smart CapEx scans a contractor quote into a new request.
// All reads/writes go through /api/financials/capex(+/decision,/progress,
// /forecast,/rollup,/attachment,/line-items) behind the owner/GM finance gate.
// Money is integer cents.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Field, TextInput, TextArea } from '@/app/maintenance/_components/_mt-snow';
import { useProperty } from '@/contexts/PropertyContext';
import { resizeImageForVision } from '@/lib/image-resize';
import {
  CAPEX_CATEGORIES,
  CAPEX_PENDING_STATUSES,
  CAPEX_ACTIVE_STATUSES,
  CAPEX_CLOSED_STATUSES,
  formatCents,
  parseDollarsToCents,
  capexEstimateCents,
  capexOverrunPct,
  type CapexProject,
  type CapexStatus,
  type CapexCategory,
  type CapexLineItem,
  type RequestType,
} from '@/lib/financials/shared';
import { apiGet, apiSend, Btn, Money, Pill, Card, Notice, BudgetBar, DollarInput, T, FONT_SANS, FONT_MONO } from './fin-ui';
import { CapexCard, BigMoney, Eyebrow } from './fin-board';
import { ft, capexStatusLabel, capexCategoryLabel, requestTypeLabel } from './fin-i18n';
import { ScanButton, type QuoteDraft } from './ScanButton';

type Lang = 'en' | 'es';
type View = 'board' | 'forecast' | 'rollup';
type DecisionAction = 'approve' | 'reject' | 'revisions';

function statusColor(s: CapexStatus): string {
  if (s === 'completed' || s === 'approved') return T.sageDeep;
  if (s === 'in_progress') return T.caramelDeep;
  if (s === 'rejected' || s === 'cancelled') return T.ink3;
  if (s === 'revisions_needed') return T.warm;
  return T.ink2; // requested
}

// Column grouping colors (each card still carries its own real-status accent).
const COL_COLOR = { pending: T.sageBrand, active: T.caramelDeep, closed: T.sageDeep };

interface ForecastMonth {
  month: string;
  estimatedCents: number;
  spentCents: number;
  remainingCents: number;
  projects: number;
}
interface RollupRow {
  propertyId: string;
  propertyName: string | null;
  projects: number;
  pending: number;
  active: number;
  estimatedCents: number;
  spentCents: number;
}
interface Rollup {
  properties: RollupRow[];
  totals: { projects: number; pending: number; active: number; estimatedCents: number; spentCents: number };
}

function shortDate(ymd: string | null, lang: Lang): string {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function CapexTab({ pid, lang, onChanged }: { pid: string; lang: Lang; onChanged: () => void }) {
  const S = ft(lang);
  const { properties } = useProperty();
  const [view, setView] = useState<View>('board');
  const [projects, setProjects] = useState<CapexProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CapexProject | null>(null);
  const [requestForm, setRequestForm] = useState<RequestForm | null>(null);
  const [decision, setDecision] = useState<{ project: CapexProject; action: DecisionAction } | null>(null);

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

  const refreshDetail = useCallback(
    async (id: string) => {
      const res = await apiGet<{ project: CapexProject }>(`/api/financials/capex?pid=${pid}&id=${id}`);
      if (res.ok && res.data) setDetail(res.data.project);
    },
    [pid],
  );

  const openDetail = async (id: string) => {
    setOpenId(id);
    setDetail(null);
    await refreshDetail(id);
  };

  const afterChange = async (focusId?: string) => {
    await load();
    onChanged();
    if (focusId) await refreshDetail(focusId);
  };

  const pending = useMemo(() => projects.filter((p) => CAPEX_PENDING_STATUSES.includes(p.status)), [projects]);
  const active = useMemo(() => projects.filter((p) => CAPEX_ACTIVE_STATUSES.includes(p.status)), [projects]);
  const closed = useMemo(() => projects.filter((p) => CAPEX_CLOSED_STATUSES.includes(p.status)), [projects]);

  const totalEstimated = projects.reduce((a, p) => a + capexEstimateCents(p), 0);
  const totalSpent = projects.reduce((a, p) => a + (p.spentCents ?? 0), 0);
  const emergency = projects.filter((p) => p.requestType === 'emergency').length;

  const showRollup = properties.length > 1;
  const views: { key: View; label: string }[] = [
    { key: 'board', label: S.projects },
    { key: 'forecast', label: S.capForecast },
    ...(showRollup ? [{ key: 'rollup' as const, label: S.rollup }] : []),
  ];

  const onScanQuote = (d: QuoteDraft) => {
    setRequestForm({
      ...blankRequest(),
      name: d.name ?? '',
      estimate: d.quoteCents != null ? (d.quoteCents / 100).toFixed(2) : '',
      vendor: d.vendor ?? '',
      targetDate: d.quoteDate ?? '',
      description: d.summary ?? '',
      pendingLines: d.lineItems.filter((l) => l.label.trim()),
    });
  };

  const openDecision = (project: CapexProject, action: DecisionAction) => {
    setOpenId(null);
    setDetail(null);
    setDecision({ project, action });
  };

  if (loading) return <Notice text={S.loading} />;
  if (errored) return <Notice text={S.errorLoading} onRetry={() => void load()} />;

  const columns: { key: 'pending' | 'active' | 'closed'; label: string; items: CapexProject[]; empty: string; addable: boolean }[] = [
    { key: 'pending', label: S.capPending, items: pending, empty: S.noPending, addable: true },
    { key: 'active', label: S.capActive, items: active, empty: S.noActive, addable: false },
    { key: 'closed', label: S.capClosed, items: closed, empty: S.noClosed, addable: false },
  ];

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* View switcher */}
        <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 999, background: 'rgba(31,35,28,0.05)' }}>
          {views.map((v) => {
            const on = view === v.key;
            return (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                style={{
                  padding: '6px 13px',
                  borderRadius: 999,
                  fontFamily: FONT_MONO,
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  background: on ? T.ink : 'transparent',
                  color: on ? '#fff' : T.ink3,
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {v.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink }}>{formatCents(totalEstimated, { showCents: false })} {lang === 'es' ? 'comprometido' : 'committed'}</span>
          <ScanButton mode="quote" pid={pid} label={S.scanQuote} scanningLabel={S.scanning} failLabel={S.scanFailed} onQuote={onScanQuote} />
          <Btn onClick={() => setRequestForm(blankRequest())}>+ {S.newRequest}</Btn>
        </div>
      </div>

      {view === 'board' && (
        <>
          {projects.length === 0 ? (
            <Notice text={S.noProjects} />
          ) : (
            <>
              {/* CapEx totals strip */}
              <div style={{ display: 'flex', gap: 30, flexWrap: 'wrap', alignItems: 'center', padding: '0 0 16px', borderBottom: `1px solid ${T.ruleSoft}`, marginBottom: 18 }}>
                <StatStrip label={S.totalRequests}>
                  <span style={statNum}>{projects.length}</span>
                </StatStrip>
                <StatStrip label={S.totalEstimated}>
                  <BigMoney cents={totalEstimated} size={23} />
                </StatStrip>
                <StatStrip label={S.totalSpent}>
                  <BigMoney cents={totalSpent} size={23} />
                </StatStrip>
                <StatStrip label={S.emergency}>
                  <span style={{ ...statNum, color: emergency > 0 ? T.warm : T.ink }}>{emergency}</span>
                </StatStrip>
              </div>

              {/* Status board */}
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap' }}>
                {columns.map((col) => (
                  <div key={col.key} style={{ flex: '1 1 0', minWidth: 270, maxWidth: 420, background: 'rgba(31,35,28,0.022)', borderRadius: 12, padding: 12, border: `1px solid ${T.ruleSoft}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: COL_COLOR[col.key], flexShrink: 0 }} />
                      <span style={{ fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, color: T.ink, flex: 1 }}>{col.label}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3 }}>{col.items.length}</span>
                      {col.addable && (
                        <button
                          onClick={() => setRequestForm(blankRequest())}
                          title={S.newRequest}
                          style={{ width: 22, height: 22, borderRadius: 999, border: `1px solid ${T.ruleInput}`, display: 'grid', placeItems: 'center', color: T.ink2, background: T.bg, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
                        >
                          +
                        </button>
                      )}
                    </div>
                    {col.items.length === 0 ? (
                      col.addable ? (
                        <button
                          onClick={() => setRequestForm(blankRequest())}
                          style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: `1px dashed ${T.ruleInput}`, color: T.ink3, fontFamily: FONT_SANS, fontSize: 12.5, fontWeight: 600, background: 'transparent', cursor: 'pointer' }}
                        >
                          + {S.newRequest}
                        </button>
                      ) : (
                        <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3, padding: '4px 2px', display: 'block' }}>{col.empty}</span>
                      )
                    ) : (
                      col.items.map((p) => {
                        const spent = p.spentCents ?? 0;
                        const estimate = capexEstimateCents(p);
                        return (
                          <CapexCard
                            key={p.id}
                            accent={statusColor(p.status)}
                            name={p.name}
                            metaLabel={[p.vendor, shortDate(p.targetDate, lang)].filter(Boolean).join(' · ')}
                            spentCents={spent}
                            estimateCents={estimate}
                            spentLabel={S.spent}
                            estimateLabel={S.estimate}
                            pills={
                              <>
                                {p.requestType === 'emergency' && <Pill label={requestTypeLabel(lang, 'emergency')} color={T.warm} />}
                                {p.category && <Pill label={capexCategoryLabel(lang, p.category)} color={T.ink2} />}
                                <Pill label={capexStatusLabel(lang, p.status)} color={statusColor(p.status)} />
                                {p.status === 'in_progress' && <Pill label={`${p.pctComplete}%`} color={T.caramelDeep} />}
                              </>
                            }
                            onOpen={() => void openDetail(p.id)}
                          />
                        );
                      })
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {view === 'forecast' && <Forecast pid={pid} lang={lang} />}
      {view === 'rollup' && <RollupView lang={lang} />}

      {/* Detail / binder modal */}
      {openId && (
        <DetailModal
          pid={pid}
          lang={lang}
          project={detail}
          onClose={() => {
            setOpenId(null);
            setDetail(null);
          }}
          onDecision={openDecision}
          onChanged={() => void afterChange(openId)}
        />
      )}

      {/* New request modal */}
      {requestForm && (
        <RequestModal pid={pid} lang={lang} form={requestForm} setForm={setRequestForm} onClose={() => setRequestForm(null)} onCreated={() => void afterChange()} />
      )}

      {/* Decision modal */}
      {decision && (
        <DecisionModal
          pid={pid}
          lang={lang}
          project={decision.project}
          action={decision.action}
          onClose={() => setDecision(null)}
          onDone={() => {
            setDecision(null);
            void afterChange();
          }}
        />
      )}
    </div>
  );
}

// ─── Forecast ──────────────────────────────────────────────────────────────
function Forecast({ pid, lang }: { pid: string; lang: Lang }) {
  const S = ft(lang);
  const [rows, setRows] = useState<ForecastMonth[] | null>(null);
  useEffect(() => {
    void apiGet<{ forecast: ForecastMonth[] }>(`/api/financials/capex/forecast?pid=${pid}`).then((r) => setRows(r.ok && r.data ? r.data.forecast : []));
  }, [pid]);
  if (rows == null) return <Notice text={S.loading} />;
  if (rows.length === 0) return <Notice text={S.noForecastCapex} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 4 }}>{S.upcomingByMonth}</span>
      {rows.map((m) => (
        <Card key={m.month} style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>{monthName(m.month, lang)}</span>
          <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>{m.projects} {S.projects.toLowerCase()}</span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>{S.remaining}: <Money cents={m.remainingCents} size={14} /></span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>{S.estimate}: <Money cents={m.estimatedCents} size={12} weight={500} color={T.ink2} /></span>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Multi-property rollup ─────────────────────────────────────────────────
function RollupView({ lang }: { lang: Lang }) {
  const S = ft(lang);
  const [data, setData] = useState<Rollup | null>(null);
  useEffect(() => {
    void apiGet<{ rollup: Rollup }>(`/api/financials/capex/rollup`).then((r) => setData(r.ok && r.data ? r.data.rollup : { properties: [], totals: { projects: 0, pending: 0, active: 0, estimatedCents: 0, spentCents: 0 } }));
  }, []);
  if (data == null) return <Notice text={S.loading} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <div style={{ fontFamily: FONT_MONO, fontSize: 9.5, color: T.faint, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>{S.acrossProperties}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 16 }}>
          <StatStrip label={S.totalRequests}><span style={statNum}>{data.totals.projects}</span></StatStrip>
          <StatStrip label={S.capPending}><span style={statNum}>{data.totals.pending}</span></StatStrip>
          <StatStrip label={S.capActive}><span style={statNum}>{data.totals.active}</span></StatStrip>
          <StatStrip label={S.totalEstimated}><Money cents={data.totals.estimatedCents} size={20} /></StatStrip>
          <StatStrip label={S.totalSpent}><Money cents={data.totals.spentCents} size={20} /></StatStrip>
        </div>
      </Card>
      {data.properties.map((p) => (
        <Card key={p.propertyId} style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>{p.propertyName ?? p.propertyId.slice(0, 8)}</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>
            <span>{p.projects} {S.projects.toLowerCase()}</span>
            <span>{S.capPending}: {p.pending}</span>
            <span>{S.capActive}: {p.active}</span>
            <span>{S.totalSpent} <Money cents={p.spentCents} size={13} /> / <Money cents={p.estimatedCents} size={12} weight={500} color={T.ink3} /></span>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── New-request modal ──────────────────────────────────────────────────────
interface RequestForm {
  name: string;
  description: string;
  category: CapexCategory | '';
  estimate: string;
  requestType: RequestType;
  targetDate: string;
  vendor: string;
  pendingLines: Array<{ label: string; amountCents: number | null }>;
}
function blankRequest(): RequestForm {
  return { name: '', description: '', category: '', estimate: '', requestType: 'budgeted', targetDate: '', vendor: '', pendingLines: [] };
}

function RequestModal({
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
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const res = await apiSend<{ project: CapexProject }>('/api/financials/capex', 'POST', {
      pid,
      name: form.name.trim(),
      description: form.description.trim() || null,
      category: form.category || null,
      estimatedCostCents: form.estimate.trim() ? parseDollarsToCents(form.estimate) ?? 0 : 0,
      requestType: form.requestType,
      targetDate: form.targetDate || null,
      vendor: form.vendor.trim() || null,
    });
    if (res.ok && res.data) {
      const newId = res.data.project.id;
      for (const l of form.pendingLines) {
        await apiSend('/api/financials/capex/line-items', 'POST', { pid, projectId: newId, label: l.label, amountCents: l.amountCents ?? 0, source: 'invoice_scan' });
      }
    }
    setSaving(false);
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
          <Btn onClick={() => void submit()} disabled={saving || !form.name.trim()}>{saving ? S.saving : S.submitRequest}</Btn>
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

// ─── Decision modal ──────────────────────────────────────────────────────
function DecisionModal({
  pid,
  lang,
  project,
  action,
  onClose,
  onDone,
}: {
  pid: string;
  lang: Lang;
  project: CapexProject;
  action: DecisionAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const S = ft(lang);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const title = action === 'approve' ? S.approve : action === 'reject' ? S.reject : S.requestRevisions;
  const submit = async () => {
    setBusy(true);
    await apiSend('/api/financials/capex/decision', 'POST', { pid, id: project.id, action, notes: notes.trim() || null });
    setBusy(false);
    onDone();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${title} — ${project.name}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>{S.cancel}</Btn>
          <Btn variant={action === 'reject' ? 'danger' : 'primary'} disabled={busy} onClick={() => void submit()}>{busy ? S.saving : title}</Btn>
        </>
      }
    >
      <Field label={`${S.decisionNotes}${action === 'approve' ? ` (${S.optional})` : ''}`}>
        <TextArea value={notes} onChange={setNotes} rows={3} />
      </Field>
    </Modal>
  );
}

// ─── Progress controls (active projects, inside the binder) ────────────────
function ProgressControls({ pid, project, lang, onChanged }: { pid: string; project: CapexProject; lang: Lang; onChanged: () => void }) {
  const S = ft(lang);
  const [busy, setBusy] = useState(false);
  const send = async (patch: { status?: CapexStatus; pctComplete?: number }) => {
    setBusy(true);
    await apiSend('/api/financials/capex/progress', 'POST', { pid, id: project.id, ...patch });
    setBusy(false);
    onChanged();
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {project.status === 'approved' && <Btn disabled={busy} onClick={() => void send({ status: 'in_progress' })}>{S.markInProgress}</Btn>}
      {project.status === 'in_progress' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>
            {S.percentComplete}
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={project.pctComplete}
              onMouseUp={(e) => void send({ pctComplete: Number((e.target as HTMLInputElement).value) })}
              onTouchEnd={(e) => void send({ pctComplete: Number((e.target as HTMLInputElement).value) })}
              style={{ accentColor: T.sageDeep }}
            />
          </label>
          <Btn variant="ghost" disabled={busy} onClick={() => void send({ status: 'completed' })}>{S.markComplete}</Btn>
        </>
      )}
    </div>
  );
}

// ─── Detail / binder modal ──────────────────────────────────────────────────
function DetailModal({
  pid,
  lang,
  project,
  onClose,
  onDecision,
  onChanged,
}: {
  pid: string;
  lang: Lang;
  project: CapexProject | null;
  onClose: () => void;
  onDecision: (project: CapexProject, action: DecisionAction) => void;
  onChanged: () => void;
}) {
  const S = ft(lang);
  const [addLabel, setAddLabel] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  if (!project) {
    return (
      <Modal open onClose={onClose} title="…"><Notice text={S.loading} /></Modal>
    );
  }
  const spent = project.spentCents ?? 0;
  const estimate = capexEstimateCents(project);
  const over = capexOverrunPct(spent, estimate);
  const isPending = CAPEX_PENDING_STATUSES.includes(project.status);
  const isActive = project.status === 'approved' || project.status === 'in_progress';

  const addLine = async () => {
    if (!addLabel.trim()) return;
    setBusy(true);
    await apiSend('/api/financials/capex/line-items', 'POST', { pid, projectId: project.id, label: addLabel.trim(), amountCents: addAmount.trim() ? parseDollarsToCents(addAmount) ?? 0 : 0 });
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
  const uploadAttachment = async (file: File) => {
    setUploading(true);
    try {
      const resized = await resizeImageForVision(file);
      await apiSend('/api/financials/capex/attachment', 'POST', { pid, projectId: project.id, imageBase64: resized.base64, mediaType: resized.mediaType });
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
    }
  };
  const viewAttachment = async () => {
    const res = await apiGet<{ url: string | null }>(`/api/financials/capex/attachment?pid=${pid}&projectId=${project.id}`);
    if (res.ok && res.data?.url) window.open(res.data.url, '_blank', 'noopener');
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={project.name}
      subtitle={`${capexStatusLabel(lang, project.status)}${project.vendor ? ` · ${project.vendor}` : ''}`}
      footer={
        <>
          <Btn variant="danger" onClick={() => void delProject()}>{S.deleteProject}</Btn>
          <Btn variant="ghost" onClick={onClose}>{S.close}</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Workflow actions */}
        {isPending && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 4 }}>
            <Btn onClick={() => onDecision(project, 'approve')}>{S.approve}</Btn>
            <Btn variant="ghost" onClick={() => onDecision(project, 'revisions')}>{S.requestRevisions}</Btn>
            <Btn variant="danger" onClick={() => onDecision(project, 'reject')}>{S.reject}</Btn>
          </div>
        )}
        {isActive && (
          <div style={{ paddingBottom: 4 }}>
            <ProgressControls pid={pid} project={project} lang={lang} onChanged={onChanged} />
          </div>
        )}

        {/* Quote & estimate */}
        <Section title={S.binderQuote}>
          <Card style={{ background: 'rgba(31,35,28,0.03)', boxShadow: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <Money cents={spent} size={22} color={over != null && over > 0 ? T.warm : T.ink} />
              <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>
                {S.spent} / {S.estimate} <Money cents={estimate} size={12} weight={500} color={T.ink2} />
              </span>
              {project.requestType === 'emergency' && <Pill label={requestTypeLabel(lang, 'emergency')} color={T.warm} />}
              {project.category && <Pill label={capexCategoryLabel(lang, project.category)} color={T.ink2} />}
            </div>
            <BudgetBar actualCents={spent} budgetCents={estimate} status={over != null && over > 0 ? 'over' : 'good'} />
            {project.description && <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '10px 0 0' }}>{project.description}</p>}
          </Card>
        </Section>

        {/* Approvals */}
        <Section title={S.binderApprovals}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
            {project.submittedByName && <div>{S.submittedBy}: <strong style={{ color: T.ink }}>{project.submittedByName}</strong></div>}
            {project.approvedByName && (
              <div>
                {S.decidedBy}: <strong style={{ color: T.ink }}>{project.approvedByName}</strong>
                {project.decidedAt ? ` · ${project.decidedAt.slice(0, 10)}` : ''}
              </div>
            )}
            {project.decisionNotes && <div style={{ color: T.ink2 }}>“{project.decisionNotes}”</div>}
            {!project.submittedByName && !project.approvedByName && <span style={{ color: T.ink3 }}>—</span>}
          </div>
        </Section>

        {/* Attachment */}
        <Section title={S.attachment}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {project.attachmentPath ? (
              <Btn variant="ghost" onClick={() => void viewAttachment()}>{S.viewAttachment}</Btn>
            ) : (
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3 }}>{S.noAttachment}</span>
            )}
            <Btn variant="ghost" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? S.saving : S.addAttachment}
            </Btn>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAttachment(f);
                if (e.target) e.target.value = '';
              }}
            />
          </div>
        </Section>

        {/* Receipts / line items */}
        <Section title={S.binderReceipts}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(project.lineItems ?? []).map((l: CapexLineItem) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${T.ruleSoft}` }}>
                <span style={{ flex: 1, fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>{l.label}</span>
                <Money cents={l.amountCents} size={13} />
                <button onClick={() => void delLine(l.id)} style={{ background: 'transparent', border: 'none', color: T.warm, cursor: 'pointer', fontSize: 13 }} aria-label={S.delete}>✕</button>
              </div>
            ))}
            {(project.lineItems ?? []).length === 0 && <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3 }}>—</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <div style={{ flex: 1 }}><TextInput value={addLabel} onChange={setAddLabel} placeholder={S.label} /></div>
            <div style={{ width: 120 }}><DollarInput value={addAmount} onChange={setAddAmount} /></div>
            <Btn onClick={() => void addLine()} disabled={busy || !addLabel.trim()}>+</Btn>
          </div>
        </Section>
      </div>
    </Modal>
  );
}

// ─── small shared bits ──────────────────────────────────────────────────────
function StatStrip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ marginTop: 3 }}>{children}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function monthName(m: string, lang: Lang): string {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const statNum: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 23, fontWeight: 600, color: T.ink };
const selStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10, background: T.bg, border: `1px solid ${T.ruleInput}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%', boxSizing: 'border-box', outline: 'none', cursor: 'pointer',
};
const dateStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10, background: T.bg, border: `1px solid ${T.ruleInput}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%', boxSizing: 'border-box', outline: 'none',
};
