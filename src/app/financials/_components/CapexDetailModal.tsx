'use client';

// CapEx binder + decisions — the project detail modal (quote & estimate,
// approvals record, attachment, receipts/line items, delete) with the
// approve / reject / request-changes DecisionModal and the in-progress
// ProgressControls. Split out of CapexTab so the board file keeps only the
// list + workflow orchestration. All writes go through /api/financials/capex*
// behind the owner/GM finance gate. Money is integer cents.

import React, { useRef, useState } from 'react';
import { Modal, Field, TextInput, TextArea } from '@/app/maintenance/_components/_mt-snow';
import { useApiAction } from '@/lib/hooks/use-api-resource';
import { resizeImageForVision } from '@/lib/image-resize';
import {
  CAPEX_PENDING_STATUSES,
  parseDollarsToCents,
  capexEstimateCents,
  capexOverrunPct,
  type CapexProject,
  type CapexStatus,
  type CapexLineItem,
} from '@/lib/financials/shared';
import { finGet, finSend, Btn, Money, Pill, Card, Notice, BudgetBar, DollarInput, T, FONT_SANS } from './fin-ui';
import { ft, capexStatusLabel, capexCategoryLabel, requestTypeLabel } from './fin-i18n';

type Lang = 'en' | 'es';
export type DecisionAction = 'approve' | 'reject' | 'revisions';

// ─── Decision modal ──────────────────────────────────────────────────────
export function DecisionModal({
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
  const decide = useApiAction((n: string | null) =>
    finSend('/api/financials/capex/decision', 'POST', { pid, id: project.id, action, notes: n }),
  );
  const title = action === 'approve' ? S.approve : action === 'reject' ? S.reject : S.requestRevisions;
  const submit = async () => {
    // A failed decision (offline, or someone else already decided → 404)
    // must not close the modal as if it were recorded.
    const res = await decide.run(notes.trim() || null);
    if (res.error) return; // decide.error renders below
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
          <Btn variant={action === 'reject' ? 'danger' : 'primary'} disabled={decide.saving} onClick={() => void submit()}>{decide.saving ? S.saving : title}</Btn>
        </>
      }
    >
      <Field label={`${S.decisionNotes}${action === 'approve' ? ` (${S.optional})` : ''}`}>
        <TextArea value={notes} onChange={setNotes} rows={3} />
      </Field>
      {decide.error && <span style={{ display: 'block', marginTop: 10, fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{S.couldNotSave}</span>}
    </Modal>
  );
}

// ─── Progress controls (active projects, inside the binder) ────────────────
function ProgressControls({ pid, project, lang, onChanged }: { pid: string; project: CapexProject; lang: Lang; onChanged: () => void }) {
  const S = ft(lang);
  const progress = useApiAction((patch: { status?: CapexStatus; pctComplete?: number }) =>
    finSend('/api/financials/capex/progress', 'POST', { pid, id: project.id, ...patch }),
  );
  const send = async (patch: { status?: CapexStatus; pctComplete?: number }) => {
    const res = await progress.run(patch);
    if (res.error) return; // progress.error renders below — don't pretend it saved
    onChanged();
  };
  // The slider commits on mouse-up / touch-end / key-up; the ref dedupes
  // repeat commits at the same value (e.g. keyup after every arrow press).
  const lastSentPctRef = useRef<number>(project.pctComplete);
  const commitPct = async (el: HTMLInputElement) => {
    const v = Number(el.value);
    if (v === lastSentPctRef.current) return;
    lastSentPctRef.current = v;
    const res = await progress.run({ pctComplete: v });
    if (res.error) {
      // Reset so the same value can be retried after the failure.
      lastSentPctRef.current = project.pctComplete;
      return;
    }
    onChanged();
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {project.status === 'approved' && <Btn disabled={progress.saving} onClick={() => void send({ status: 'in_progress' })}>{S.markInProgress}</Btn>}
      {project.status === 'in_progress' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>
            {S.percentComplete}
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={project.pctComplete}
              onMouseUp={(e) => void commitPct(e.target as HTMLInputElement)}
              onTouchEnd={(e) => void commitPct(e.target as HTMLInputElement)}
              onKeyUp={(e) => void commitPct(e.target as HTMLInputElement)}
              style={{ accentColor: T.sageDeep }}
            />
          </label>
          <Btn variant="ghost" disabled={progress.saving} onClick={() => void send({ status: 'completed' })}>{S.markComplete}</Btn>
        </>
      )}
      {progress.error && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{S.couldNotSave}</span>}
    </div>
  );
}

// ─── Detail / binder modal ──────────────────────────────────────────────────
export function DetailModal({
  pid,
  lang,
  project,
  refreshing = false,
  loadError,
  onRetryLoad,
  onClose,
  onDecision,
  onChanged,
}: {
  pid: string;
  lang: Lang;
  project: CapexProject | null;
  /** True while the exact project's binder is being loaded or refreshed. */
  refreshing?: boolean;
  /** Set when the binder fetch failed (and there's no last-good project). */
  loadError?: string | null;
  onRetryLoad?: () => void;
  onClose: () => void;
  onDecision: (project: CapexProject, action: DecisionAction) => void;
  onChanged: () => void;
}) {
  const S = ft(lang);
  const [addLabel, setAddLabel] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [lineError, setLineError] = useState<string | null>(null);
  // Failures from binder actions that have no field of their own
  // (delete line / delete project / attachment view & upload).
  const [actionError, setActionError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const addLineAction = useApiAction((input: { projectId: string; label: string; amountCents: number }) =>
    finSend('/api/financials/capex/line-items', 'POST', { pid, ...input }),
  );

  if (!project) {
    // A failed binder fetch must not spin "Loading…" forever — show the
    // standard tap-to-retry notice instead. The viewport and footer are the
    // same size as the loaded binder, so the modal never grows after opening.
    return (
      <>
        <CapexDetailStyles />
        <Modal
          open
          onClose={onClose}
          title="…"
          footer={<Btn variant="ghost" onClick={onClose}>{S.close}</Btn>}
        >
          <CapexDetailViewport busy={!loadError}>
            {loadError != null
              ? <Notice text={S.errorLoading} onRetry={onRetryLoad} />
              : <CapexDetailLoading label={S.loading} />}
          </CapexDetailViewport>
        </Modal>
      </>
    );
  }
  const spent = project.spentCents ?? 0;
  const estimate = capexEstimateCents(project);
  const over = capexOverrunPct(spent, estimate);
  const isPending = CAPEX_PENDING_STATUSES.includes(project.status);
  const isActive = project.status === 'approved' || project.status === 'in_progress';

  const addLine = async () => {
    if (!addLabel.trim()) return;
    // A typo'd amount must not be coerced to a $0 line item.
    const cents = addAmount.trim() ? parseDollarsToCents(addAmount) : 0;
    if (cents == null || cents < 0) {
      setLineError(S.invalidAmount);
      return;
    }
    setLineError(null);
    const res = await addLineAction.run({
      projectId: project.id,
      label: addLabel.trim(),
      amountCents: cents,
    });
    if (res.error) {
      // Keep what was typed; the error renders under the add row.
      setLineError(S.couldNotSave);
      return;
    }
    setAddLabel('');
    setAddAmount('');
    onChanged();
  };
  const delLine = async (id: string) => {
    setActionError(null);
    const res = await finSend('/api/financials/capex/line-items', 'DELETE', { pid, id, projectId: project.id });
    if (res.error) {
      setActionError(S.couldNotDelete);
      return;
    }
    onChanged();
  };
  const delProject = async () => {
    if (!window.confirm(S.confirmDeleteProject)) return;
    setActionError(null);
    const res = await finSend('/api/financials/capex', 'DELETE', { pid, id: project.id });
    if (res.error) {
      setActionError(S.couldNotDelete);
      return;
    }
    onClose();
    onChanged();
  };
  const uploadAttachment = async (file: File) => {
    setUploading(true);
    setActionError(null);
    try {
      const resized = await resizeImageForVision(file);
      const res = await finSend('/api/financials/capex/attachment', 'POST', { pid, projectId: project.id, imageBase64: resized.base64, mediaType: resized.mediaType });
      if (res.error) {
        setActionError(S.couldNotSave);
        return;
      }
      onChanged();
    } catch {
      setActionError(S.couldNotSave);
    } finally {
      setUploading(false);
    }
  };
  const viewAttachment = async () => {
    setActionError(null);
    // Open the tab synchronously inside the tap gesture — Safari's popup
    // blocker kills window.open after an await. Navigate it once the signed
    // URL arrives; close it (and say so) if the fetch fails.
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    const res = await finGet<{ url: string | null }>(`/api/financials/capex/attachment?pid=${pid}&projectId=${project.id}`);
    if (res.data?.url) {
      if (win) win.location.href = res.data.url;
      else window.open(res.data.url, '_blank', 'noopener');
      return;
    }
    win?.close();
    setActionError(S.attachmentOpenFailed);
  };

  return (
    <>
      <CapexDetailStyles />
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
        <CapexDetailViewport busy={refreshing}>
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
            <Btn onClick={() => void addLine()} disabled={addLineAction.saving || !addLabel.trim()}>+</Btn>
          </div>
          {lineError && <span style={{ display: 'block', marginTop: 8, fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{lineError}</span>}
        </Section>

            {actionError && <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.warm }}>{actionError}</span>}
          </div>
        </CapexDetailViewport>
      </Modal>
    </>
  );
}

function CapexDetailViewport({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <div className="capex-detail-viewport" aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

function CapexDetailLoading({ label }: { label: string }) {
  return (
    <div className="capex-detail-loading" role="status" aria-live="polite">
      <span className="capex-detail-loading-label">{label}</span>
      <div className="capex-detail-skeleton" aria-hidden="true">
        <span className="capex-detail-skeleton-actions" />
        <span className="capex-detail-skeleton-card" />
        <span className="capex-detail-skeleton-line capex-detail-skeleton-line-wide" />
        <span className="capex-detail-skeleton-line" />
        <span className="capex-detail-skeleton-card capex-detail-skeleton-card-short" />
        <span className="capex-detail-skeleton-line capex-detail-skeleton-line-wide" />
        <span className="capex-detail-skeleton-line" />
      </div>
    </div>
  );
}

function CapexDetailStyles() {
  return <style>{`
    .capex-detail-viewport {
      height: clamp(340px, calc(100dvh - 300px), 560px);
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }
    .capex-detail-loading { min-height: 100%; }
    .capex-detail-loading-label {
      display: block;
      margin-bottom: 16px;
      color: ${T.ink2};
      font-family: ${FONT_SANS};
      font-size: 13px;
    }
    .capex-detail-skeleton { display: flex; flex-direction: column; gap: 13px; }
    .capex-detail-skeleton > span {
      position: relative;
      display: block;
      overflow: hidden;
      border-radius: 10px;
      background: ${T.ruleSoft};
    }
    .capex-detail-skeleton > span::after {
      position: absolute;
      inset: 0;
      content: '';
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.72), transparent);
      transform: translateX(-100%);
      animation: capex-detail-shimmer 1.35s ease-in-out infinite;
    }
    .capex-detail-skeleton-actions { width: 48%; height: 40px; }
    .capex-detail-skeleton-card { width: 100%; height: 112px; }
    .capex-detail-skeleton-card-short { height: 72px; }
    .capex-detail-skeleton-line { width: 68%; height: 16px; }
    .capex-detail-skeleton-line-wide { width: 92%; }
    @keyframes capex-detail-shimmer { to { transform: translateX(100%); } }
    @media (max-width: 640px) {
      .capex-detail-viewport { height: clamp(300px, calc(100dvh - 260px), 520px); }
      .capex-detail-skeleton-actions { width: 72%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .capex-detail-skeleton > span::after { animation: none; display: none; }
    }
  `}</style>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
