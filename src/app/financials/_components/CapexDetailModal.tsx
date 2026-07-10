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
    await decide.run(notes.trim() || null);
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
    await progress.run(patch);
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
              onMouseUp={(e) => void send({ pctComplete: Number((e.target as HTMLInputElement).value) })}
              onTouchEnd={(e) => void send({ pctComplete: Number((e.target as HTMLInputElement).value) })}
              style={{ accentColor: T.sageDeep }}
            />
          </label>
          <Btn variant="ghost" disabled={progress.saving} onClick={() => void send({ status: 'completed' })}>{S.markComplete}</Btn>
        </>
      )}
    </div>
  );
}

// ─── Detail / binder modal ──────────────────────────────────────────────────
export function DetailModal({
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const addLineAction = useApiAction((input: { projectId: string; label: string; amountCents: number }) =>
    finSend('/api/financials/capex/line-items', 'POST', { pid, ...input }),
  );

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
    await addLineAction.run({
      projectId: project.id,
      label: addLabel.trim(),
      amountCents: addAmount.trim() ? parseDollarsToCents(addAmount) ?? 0 : 0,
    });
    setAddLabel('');
    setAddAmount('');
    onChanged();
  };
  const delLine = async (id: string) => {
    await finSend('/api/financials/capex/line-items', 'DELETE', { pid, id, projectId: project.id });
    onChanged();
  };
  const delProject = async () => {
    if (!window.confirm(S.confirmDeleteProject)) return;
    const res = await finSend('/api/financials/capex', 'DELETE', { pid, id: project.id });
    if (!res.error) {
      onClose();
      onChanged();
    }
  };
  const uploadAttachment = async (file: File) => {
    setUploading(true);
    try {
      const resized = await resizeImageForVision(file);
      await finSend('/api/financials/capex/attachment', 'POST', { pid, projectId: project.id, imageBase64: resized.base64, mediaType: resized.mediaType });
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
    }
  };
  const viewAttachment = async () => {
    const res = await finGet<{ url: string | null }>(`/api/financials/capex/attachment?pid=${pid}&projectId=${project.id}`);
    if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
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
        </Section>
      </div>
    </Modal>
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
