'use client';

// CapEx — full capital-request approval workflow. Submit a request → owner/GM
// approves / rejects / asks for changes → in-progress (% complete) → completed.
// Views: Overview · Pending · Active · Closed · Forecast · Binder (+ a
// multi-property Rollup for owners with more than one hotel). Smart CapEx scans
// a contractor quote into a new request. All reads/writes go through
// /api/financials/capex(+/decision,/progress,/forecast,/rollup,/attachment,
// /line-items) behind the owner/GM finance gate. Money is integer cents.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Field, TextInput, TextArea } from '@/app/maintenance/_components/_mt-snow';
import { useProperty } from '@/contexts/PropertyContext';
import { resizeImageForVision } from '@/lib/image-resize';
import {
  CAPEX_CATEGORIES,
  CAPEX_PENDING_STATUSES,
  CAPEX_ACTIVE_STATUSES,
  CAPEX_CLOSED_STATUSES,
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
import { ft, capexStatusLabel, capexCategoryLabel, requestTypeLabel } from './fin-i18n';
import { ScanButton, type QuoteDraft } from './ScanButton';

type Lang = 'en' | 'es';
type View = 'overview' | 'pending' | 'active' | 'closed' | 'forecast' | 'binder' | 'rollup';

function statusColor(s: CapexStatus): string {
  if (s === 'completed' || s === 'approved') return T.sageDeep;
  if (s === 'in_progress') return T.caramelDeep;
  if (s === 'rejected' || s === 'cancelled') return T.ink3;
  if (s === 'revisions_needed') return T.warm;
  return T.ink2; // requested
}

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

export function CapexTab({ pid, lang, onChanged }: { pid: string; lang: Lang; onChanged: () => void }) {
  const S = ft(lang);
  const { properties } = useProperty();
  const [view, setView] = useState<View>('overview');
  const [projects, setProjects] = useState<CapexProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CapexProject | null>(null);
  const [requestForm, setRequestForm] = useState<RequestForm | null>(null);
  const [decision, setDecision] = useState<{ project: CapexProject; action: 'approve' | 'reject' | 'revisions' } | null>(null);

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

  const showRollup = properties.length > 1;
  const tabs: { key: View; label: string }[] = [
    { key: 'overview', label: S.capOverview },
    { key: 'pending', label: `${S.capPending}${pending.length ? ` (${pending.length})` : ''}` },
    { key: 'active', label: `${S.capActive}${active.length ? ` (${active.length})` : ''}` },
    { key: 'closed', label: S.capClosed },
    { key: 'forecast', label: S.capForecast },
    { key: 'binder', label: S.capBinder },
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

  if (loading) return <Notice text={S.loading} />;
  if (errored) return <Notice text={S.errorLoading} onRetry={() => void load()} />;

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600, color: T.ink }}>{S.projects}</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ScanButton mode="quote" pid={pid} label={S.scanQuote} scanningLabel={S.scanning} failLabel={S.scanFailed} onQuote={onScanQuote} />
          <Btn onClick={() => setRequestForm(blankRequest())}>+ {S.newRequest}</Btn>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 22, borderBottom: `1px solid ${T.rule}`, marginBottom: 18, overflowX: 'auto' }}>
        {tabs.map((t) => {
          const on = view === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 0 10px',
                fontFamily: FONT_SANS, fontSize: 13, fontWeight: on ? 600 : 500,
                color: on ? T.ink : T.ink2, borderBottom: on ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                marginBottom: -1, whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Views */}
      {view === 'overview' && <Overview projects={projects} lang={lang} />}
      {view === 'pending' && (
        <ProjectList
          projects={pending}
          lang={lang}
          empty={S.noPending}
          onOpen={openDetail}
          actions={(p) => (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Btn onClick={() => setDecision({ project: p, action: 'approve' })}>{S.approve}</Btn>
              <Btn variant="ghost" onClick={() => setDecision({ project: p, action: 'revisions' })}>{S.requestRevisions}</Btn>
              <Btn variant="danger" onClick={() => setDecision({ project: p, action: 'reject' })}>{S.reject}</Btn>
            </div>
          )}
        />
      )}
      {view === 'active' && (
        <ProjectList
          projects={active}
          lang={lang}
          empty={S.noActive}
          onOpen={openDetail}
          actions={(p) => <ProgressControls pid={pid} project={p} lang={lang} onChanged={() => void afterChange()} />}
        />
      )}
      {view === 'closed' && <ProjectList projects={closed} lang={lang} empty={S.noClosed} onOpen={openDetail} />}
      {view === 'forecast' && <Forecast pid={pid} lang={lang} />}
      {view === 'binder' && (
        <ProjectList projects={projects} lang={lang} empty={S.noProjects} onOpen={openDetail} hint={S.selectProject} />
      )}
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

// ─── Overview ─────────────────────────────────────────────────────────────
function Overview({ projects, lang }: { projects: CapexProject[]; lang: Lang }) {
  const S = ft(lang);
  const totalEstimated = projects.reduce((a, p) => a + capexEstimateCents(p), 0);
  const totalSpent = projects.reduce((a, p) => a + (p.spentCents ?? 0), 0);
  const budgeted = projects.filter((p) => p.requestType === 'budgeted').length;
  const emergency = projects.filter((p) => p.requestType === 'emergency').length;
  const approved = projects.filter((p) => ['approved', 'in_progress', 'completed'].includes(p.status)).length;
  const started = projects.filter((p) => ['in_progress', 'completed'].includes(p.status)).length;
  const completed = projects.filter((p) => p.status === 'completed').length;
  const total = projects.length;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  if (total === 0) return <Notice text={S.noProjects} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 18 }}>
          <Stat label={S.totalRequests}><span style={statNum}>{total}</span></Stat>
          <Stat label={S.totalEstimated}><Money cents={totalEstimated} size={22} /></Stat>
          <Stat label={S.totalSpent}><Money cents={totalSpent} size={22} /></Stat>
          <Stat label={S.budgetedVsEmergency}>
            <span style={statNum}>{budgeted}</span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink3 }}> / </span>
            <span style={{ ...statNum, color: emergency > 0 ? T.warm : T.ink }}>{emergency}</span>
          </Stat>
        </div>
      </Card>
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
          <Progress label={S.approvedPct} pct={pct(approved)} />
          <Progress label={S.startedPct} pct={pct(started)} />
          <Progress label={S.completedPct} pct={pct(completed)} />
        </div>
      </Card>
    </div>
  );
}

function Progress({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600, color: T.ink }}>{pct}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: T.rule, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: T.sageDeep, borderRadius: 999 }} />
      </div>
    </div>
  );
}

// ─── Project list + card ──────────────────────────────────────────────────
function ProjectList({
  projects,
  lang,
  empty,
  onOpen,
  actions,
  hint,
}: {
  projects: CapexProject[];
  lang: Lang;
  empty: string;
  onOpen: (id: string) => void;
  actions?: (p: CapexProject) => React.ReactNode;
  hint?: string;
}) {
  const S = ft(lang);
  if (projects.length === 0) return <Notice text={empty} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hint && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3, marginBottom: 2 }}>{hint}</span>}
      {projects.map((p) => {
        const spent = p.spentCents ?? 0;
        const estimate = capexEstimateCents(p);
        const overrun = capexOverrunPct(spent, estimate);
        const over = overrun != null && overrun > 0;
        return (
          <Card key={p.id} style={{ padding: 15 }}>
            <div onClick={() => onOpen(p.id)} style={{ cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600, color: T.ink }}>{p.name}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {p.requestType === 'emergency' && <Pill label={requestTypeLabel(lang, 'emergency')} color={T.warm} />}
                  {p.category && <Pill label={capexCategoryLabel(lang, p.category)} color={T.ink2} />}
                  <Pill label={capexStatusLabel(lang, p.status)} color={statusColor(p.status)} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <Money cents={spent} size={17} color={over ? T.warm : T.ink} />
                <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>
                  {S.spent} · {S.estimate} <Money cents={estimate} size={12} weight={500} color={T.ink2} />
                </span>
                {p.status === 'in_progress' && (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>· {p.pctComplete}% {S.percentComplete}</span>
                )}
              </div>
              <BudgetBar actualCents={spent} budgetCents={estimate} status={over ? 'over' : 'good'} />
              {overrun != null && (
                <div style={{ marginTop: 6, fontFamily: FONT_SANS, fontSize: 12, color: over ? T.warm : T.sageDeep }}>
                  {over ? `${Math.round(overrun)}% ${S.overrun}` : `${Math.abs(Math.round(overrun))}% ${S.underQuote}`}
                </div>
              )}
            </div>
            {actions && <div style={{ marginTop: 12 }}>{actions(p)}</div>}
          </Card>
        );
      })}
    </div>
  );
}

// ─── Progress controls (active projects) ──────────────────────────────────
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
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>{S.acrossProperties}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 16 }}>
          <Stat label={S.totalRequests}><span style={statNum}>{data.totals.projects}</span></Stat>
          <Stat label={S.capPending}><span style={statNum}>{data.totals.pending}</span></Stat>
          <Stat label={S.capActive}><span style={statNum}>{data.totals.active}</span></Stat>
          <Stat label={S.totalEstimated}><Money cents={data.totals.estimatedCents} size={20} /></Stat>
          <Stat label={S.totalSpent}><Money cents={data.totals.spentCents} size={20} /></Stat>
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
  action: 'approve' | 'reject' | 'revisions';
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

// ─── Detail / binder modal ──────────────────────────────────────────────────
function DetailModal({ pid, lang, project, onClose, onChanged }: { pid: string; lang: Lang; project: CapexProject | null; onClose: () => void; onChanged: () => void }) {
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
        {/* Quote & estimate */}
        <Section title={S.binderQuote}>
          <Card style={{ background: T.bg }}>
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
            {project.decisionNotes && <div style={{ fontStyle: 'italic' }}>“{project.decisionNotes}”</div>}
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
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div>{children}</div>
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

const statNum: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 24, fontWeight: 600, color: T.ink };
const selStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10, background: T.bg, border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%', boxSizing: 'border-box', outline: 'none', cursor: 'pointer',
};
const dateStyle: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 10, background: T.bg, border: `1px solid ${T.rule}`,
  fontFamily: FONT_SANS, fontSize: 14, color: T.ink, width: '100%', boxSizing: 'border-box', outline: 'none',
};
