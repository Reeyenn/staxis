'use client';

// CapEx — full capital-request approval workflow, presented as a status board
// (Kanban redesign). Submit a request → owner/GM approves / rejects / asks for
// changes → in-progress (% complete) → completed. The board groups projects
// into Pending · Active · Closed columns; clicking a card opens its binder
// (CapexDetailModal), which hosts the approve/reject/revisions decision and
// the progress controls. Forecast and the multi-property Rollup are
// switchable views (CapexProjection); the new-request form lives in
// CapexRequestModal. Smart CapEx scans a contractor quote into a new request.
// All reads/writes go through /api/financials/capex* behind the owner/GM
// finance gate. Money is integer cents.

import React, { useMemo, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { shortDateFromYmd } from '@/lib/format-date';
import {
  CAPEX_PENDING_STATUSES,
  CAPEX_ACTIVE_STATUSES,
  CAPEX_CLOSED_STATUSES,
  formatCents,
  capexEstimateCents,
  type CapexProject,
  type CapexStatus,
} from '@/lib/financials/shared';
import { Btn, Pill, Notice, T, FONT_SANS, FONT_MONO } from './fin-ui';
import { CapexCard, BigMoney, StatStrip, statNum } from './fin-board';
import { ft, capexStatusLabel, capexCategoryLabel, requestTypeLabel } from './fin-i18n';
import { ScanButton, type QuoteDraft } from './ScanButton';
import { Forecast, RollupView } from './CapexProjection';
import { RequestModal, blankRequest, type RequestForm } from './CapexRequestModal';
import { DetailModal, DecisionModal, type DecisionAction } from './CapexDetailModal';

type Lang = 'en' | 'es';
type View = 'board' | 'forecast' | 'rollup';

function statusColor(s: CapexStatus): string {
  if (s === 'completed' || s === 'approved') return T.sageDeep;
  if (s === 'in_progress') return T.caramelDeep;
  if (s === 'rejected' || s === 'cancelled') return T.ink3;
  if (s === 'revisions_needed') return T.warm;
  return T.ink2; // requested
}

// Column grouping colors (each card still carries its own real-status accent).
const COL_COLOR = { pending: '#3389A0', active: T.caramelDeep, closed: T.sageDeep };

export function CapexTab({ pid, lang, onChanged }: { pid: string; lang: Lang; onChanged: () => void }) {
  const S = ft(lang);
  const { properties } = useProperty();
  const [view, setView] = useState<View>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [requestForm, setRequestForm] = useState<RequestForm | null>(null);
  const [decision, setDecision] = useState<{ project: CapexProject; action: DecisionAction } | null>(null);
  // Mutation/retry counter — rides the URL as a fragment (never sent over
  // HTTP) so a refetch replays the full "Loading…" flash like the old load().
  const [nonce, setNonce] = useState(0);

  const list = useApiResource<{ projects: CapexProject[] }>(`/api/financials/capex?pid=${pid}#${nonce}`);
  const projects = useMemo(() => list.data?.projects ?? [], [list.data]);

  // The open project's binder. keepDataOnError holds the last-good binder
  // through a failed silent refresh (the old refreshDetail only overwrote on
  // success); opening a different project drops it and shows the loading
  // modal, exactly like before.
  const detailRes = useApiResource<{ project: CapexProject }>(
    `/api/financials/capex?pid=${pid}&id=${openId ?? ''}`,
    { enabled: openId != null, keepDataOnError: true },
  );
  const detail = detailRes.data?.project ?? null;

  const afterChange = (focusId?: string) => {
    setNonce((n) => n + 1);
    onChanged();
    if (focusId) detailRes.reload();
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
    setDecision({ project, action });
  };

  if (list.loading) return <Notice text={S.loading} />;
  if (list.error != null) return <Notice text={S.errorLoading} onRetry={() => setNonce((n) => n + 1)} />;

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
        <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 9, border: `1px solid ${T.rule}`, background: T.bg }}>
          {views.map((v) => {
            const on = view === v.key;
            return (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                style={{
                  padding: '6px 13px',
                  borderRadius: 6,
                  fontFamily: FONT_SANS,
                  fontSize: 12.5,
                  fontWeight: 600,
                  background: on ? T.ink : 'transparent',
                  color: on ? T.bg : T.ink3,
                  border: 'none',
                  cursor: 'pointer',
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
                  <BigMoney cents={totalEstimated} size={28} />
                </StatStrip>
                <StatStrip label={S.totalSpent}>
                  <BigMoney cents={totalSpent} size={28} />
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
                      <span style={{ fontFamily: FONT_SANS, fontSize: 13, fontWeight: 700, color: T.ink, flex: 1 }}>{col.label}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3 }}>{col.items.length}</span>
                      {col.addable && (
                        <button
                          onClick={() => setRequestForm(blankRequest())}
                          title={S.newRequest}
                          style={{ width: 22, height: 22, borderRadius: 6, border: `1px solid ${T.rule}`, display: 'grid', placeItems: 'center', color: T.ink2, background: T.bg, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
                        >
                          +
                        </button>
                      )}
                    </div>
                    {col.items.length === 0 ? (
                      col.addable ? (
                        <button
                          onClick={() => setRequestForm(blankRequest())}
                          style={{ width: '100%', padding: '14px 0', borderRadius: 10, border: `1px dashed ${T.rule}`, color: T.ink3, fontFamily: FONT_SANS, fontSize: 12.5, fontWeight: 600, background: 'transparent', cursor: 'pointer' }}
                        >
                          + {S.newRequest}
                        </button>
                      ) : (
                        <span style={{ fontFamily: FONT_SANS, fontStyle: 'italic', fontSize: 13, color: T.ink3, padding: '4px 2px', display: 'block' }}>{col.empty}</span>
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
                            metaLabel={[p.vendor, shortDateFromYmd(p.targetDate, lang, { fields: 'month-year' })].filter(Boolean).join(' · ')}
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
                            onOpen={() => setOpenId(p.id)}
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
          onClose={() => setOpenId(null)}
          onDecision={openDecision}
          onChanged={() => afterChange(openId)}
        />
      )}

      {/* New request modal */}
      {requestForm && (
        <RequestModal pid={pid} lang={lang} form={requestForm} setForm={setRequestForm} onClose={() => setRequestForm(null)} onCreated={() => afterChange()} />
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
            afterChange();
          }}
        />
      )}
    </div>
  );
}
