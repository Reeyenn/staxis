'use client';

// ═══════════════════════════════════════════════════════════════════════════
// KnowsView — "here is what I know, here is where I learned it, tell me if
// I'm wrong." The second view in the Staxis section, beside the approvals
// queue.
//
// Everything Staxis believes about this hotel, grouped into five buckets, each
// fact carrying its provenance in plain English and three actions: Confirm,
// Edit, Remove. Plus an open box at the top — type a sentence or drop in a
// file, and it becomes facts you then approve.
//
// HONESTY RULES THIS SCREEN LIVES BY
//   • A brand-new hotel has zero facts. The empty state invites input; it
//     never renders a green "all clear" or implies knowledge that isn't there.
//   • A fact pulled out of something you typed or uploaded shows as NOT
//     CONFIRMED and is not used by the copilot until you say so. That is
//     enforced in the database (migration 0358), not just labelled here.
//   • Remove is permanent, and the copy says so.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { canManageTeam } from '@/lib/roles';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import {
  CATEGORY_LABELS,
  MEMORY_CATEGORIES,
  factStatus,
  groupFactsByCategory,
  provenanceLine,
  statusLabel,
  type MemoryCategory,
} from '@/lib/agent/memory-facets';
import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Fact {
  id: string;
  topic: string;
  content: string;
  category: MemoryCategory;
  source: string;
  reviewState: 'unreviewed' | 'confirmed';
  createdByName: string | null;
  updatedAt: string;
  expiresAt: string | null;
}

interface KnowsData {
  stats: { totalKnown: number; patternsThisMonth: number; issuesCaughtEarly: number; pendingReview: number };
  facts: Fact[];
}

interface IntakeResult {
  added: Array<{ id: string; topic: string; content: string; category: string }>;
  skipped: number;
  readNote: string | null;
  nothingFound: boolean;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

const S = {
  title: { en: 'What Staxis knows', es: 'Lo que Staxis sabe' },
  sub: {
    en: 'Everything Staxis believes about your hotel, and where it learned it. Tell it if it is wrong.',
    es: 'Todo lo que Staxis cree sobre tu hotel, y dónde lo aprendió. Dile si está equivocado.',
  },
  boxEyebrow: { en: 'Tell Staxis about your hotel', es: 'Cuéntale a Staxis sobre tu hotel' },
  boxPlaceholder: {
    en: 'Anything at all — how things run, who to call, what keeps breaking.',
    es: 'Lo que sea: cómo funciona todo, a quién llamar, qué se rompe siempre.',
  },
  boxHint: {
    en: 'Optional. Or drop in a file you already have — a vendor list, a house rules sheet, an SOP.',
    es: 'Opcional. O sube un archivo que ya tengas: lista de proveedores, reglas de la casa, un procedimiento.',
  },
  addFile: { en: 'Add a file', es: 'Agregar archivo' },
  removeFile: { en: 'Remove file', es: 'Quitar archivo' },
  submit: { en: 'Add this', es: 'Agregar esto' },
  submitting: { en: 'Reading…', es: 'Leyendo…' },
  intakeDoneOne: {
    en: '1 fact added below — check it before Staxis uses it.',
    es: '1 dato agregado abajo: revísalo antes de que Staxis lo use.',
  },
  intakeDoneMany: {
    en: 'facts added below — check each one before Staxis uses it.',
    es: 'datos agregados abajo: revisa cada uno antes de que Staxis lo use.',
  },
  intakeNothing: {
    en: 'Nothing lasting in that one — nothing was saved.',
    es: 'Nada duradero en eso: no se guardó nada.',
  },
  fileTooBig: { en: 'That file is too big — keep it under 4MB.', es: 'Ese archivo es muy grande: máximo 4MB.' },
  fileWrongType: {
    en: 'Staxis can read PDF, Word, and plain text files.',
    es: 'Staxis puede leer archivos PDF, Word y de texto.',
  },
  emptyTitle: { en: 'Staxis does not know anything about your hotel yet', es: 'Staxis aún no sabe nada de tu hotel' },
  emptyBody: {
    en: 'That is expected on day one. Tell it something above — one sentence is enough to start. It also learns on its own from what your team logs.',
    es: 'Es normal el primer día. Cuéntale algo arriba: una frase basta para empezar. También aprende solo de lo que registra tu equipo.',
  },
  confirm: { en: 'Confirm', es: 'Confirmar' },
  edit: { en: 'Edit', es: 'Editar' },
  remove: { en: 'Remove', es: 'Quitar' },
  save: { en: 'Save', es: 'Guardar' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  removeSure: {
    en: 'Remove for good? Staxis will not learn this again on its own.',
    es: '¿Quitar definitivamente? Staxis no lo volverá a aprender por su cuenta.',
  },
  removeYes: { en: 'Yes, remove', es: 'Sí, quitar' },
  nothingHere: { en: 'Nothing here yet', es: 'Nada aquí todavía' },
  managerOnly: {
    en: 'What Staxis knows about the hotel is a manager view. Ask your manager to open it.',
    es: 'Lo que Staxis sabe del hotel es una vista de gerencia. Pídele a tu gerente que la abra.',
  },
  loadFailed: {
    en: 'Could not load what Staxis knows right now. Do not read this as "it knows nothing".',
    es: 'No se pudo cargar lo que Staxis sabe. No lo tomes como "no sabe nada".',
  },
  pending: { en: 'waiting for you', es: 'esperando tu revisión' },
  known: { en: 'confirmed', es: 'confirmados' },
} as const;

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ACCEPT =
  '.pdf,.txt,.md,.csv,.docx,application/pdf,text/plain,text/markdown,text/csv,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Resolve the media type from the extension rather than trusting File.type —
 * Safari hands back an empty type for several of these, and the server
 * allow-lists on the value we send. Same approach the invoice scanner takes.
 */
function mimeForFile(file: File): string | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return EXT_MIME[ext] ?? null;
}

/** Read a File as base64 with no data: prefix (mirrors the invoice scanner). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// ─── Scoped styles ──────────────────────────────────────────────────────────

const KN_CSS = `
.kn-box{background:#fff;border:1px solid rgba(92,122,96,.28);border-radius:18px;padding:16px 18px;margin-top:20px;
  box-shadow:0 10px 26px -20px rgba(31,42,32,.3);}
.kn-ta{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;margin-top:9px;border-radius:12px;
  border:1px solid rgba(31,35,28,.12);background:#FCFDFB;padding:10px 12px;color:#1F231C;font-size:13.5px;
  line-height:1.5;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;outline:none;}
.kn-ta:focus{border-color:rgba(92,122,96,.55);}
.kn-ta::placeholder{color:#A6ABA6;}
.kn-boxfoot{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;}
.kn-hint{font-size:11.5px;color:#8A9187;line-height:1.45;margin-top:7px;}
.kn-file{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#3E5C48;
  background:rgba(158,183,166,.18);border-radius:999px;padding:5px 11px;max-width:100%;}
.kn-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kn-note{margin-top:12px;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.5;}
.kn-note.kn-good{background:rgba(53,107,76,.09);color:#2C5740;}
.kn-note.kn-bad{background:rgba(184,92,61,.10);color:#8E432B;}
.kn-grp{margin-top:26px;}
.kn-grph{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}
.kn-grpt{font-size:15px;font-weight:600;color:#1F231C;}
.kn-grpc{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#A6ABA6;}
.kn-grps{font-size:11.5px;color:#8A9187;margin-top:2px;}
.kn-rows{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;margin-top:10px;overflow:hidden;}
.kn-row{padding:13px 16px;border-bottom:1px solid rgba(31,35,28,.05);}
.kn-row:last-child{border-bottom:none;}
.kn-row.kn-new{background:rgba(201,150,68,.07);}
.kn-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.kn-c{font-size:13.5px;color:#1F231C;line-height:1.5;}
.kn-p{font-size:11.5px;color:#8A9187;margin-top:4px;}
.kn-acts{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;}
.kn-act{height:30px;padding:0 12px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.kn-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.kn-act:disabled{opacity:.5;cursor:default;}
.kn-act.kn-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.kn-act.kn-yes:hover:not(:disabled){background:#4E6952;}
.kn-act.kn-danger{color:#B85C3D;}
.kn-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.kn-empty{background:#fff;border:1px dashed rgba(92,122,96,.4);border-radius:16px;padding:22px 20px;margin-top:22px;text-align:center;}
.kn-sel{height:30px;border-radius:999px;border:1px solid rgba(31,35,28,.14);background:#fff;color:#1F231C;
  font-size:12px;padding:0 9px;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.kn-meta{display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;}
.kn-metai{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;color:#8A9187;}
`;

// ─── Component ──────────────────────────────────────────────────────────────

export function KnowsView({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => S[k][es ? 'es' : 'en'];

  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const canSee = !!user && canManageTeam(user.role);

  const { data, loading, error, reload } = useApiResource<KnowsData>(
    `/api/memory/knows?propertyId=${activePropertyId}`,
    { enabled: canSee && !!activePropertyId, keepDataOnError: true },
  );

  // Open box
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'good' | 'bad'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Per-row UI state
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftCat, setDraftCat] = useState<MemoryCategory>('rhythm');
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());

  const post = useCallback(
    async <T,>(url: string, payload: unknown): Promise<{ data?: T; error?: string }> => {
      try {
        const res = await fetchWithAuth(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await readEnvelope<T>(res);
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        return { error: e instanceof Error ? e.message : 'Request failed' };
      }
    },
    [],
  );

  const pickFile = (picked: File | null) => {
    setBanner(null);
    if (!picked) { setFile(null); return; }
    if (!mimeForFile(picked)) { setBanner({ kind: 'bad', text: L('fileWrongType') }); return; }
    if (picked.size > MAX_FILE_BYTES) { setBanner({ kind: 'bad', text: L('fileTooBig') }); return; }
    setFile(picked);
  };

  const submitIntake = async () => {
    if (!activePropertyId || busy) return;
    if (!note.trim() && !file) return;
    setBusy(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = { propertyId: activePropertyId };
      if (note.trim()) payload.note = note.trim();
      if (file) {
        payload.file = {
          name: file.name,
          mimeType: mimeForFile(file),
          base64: await fileToBase64(file),
        };
      }
      const res = await post<IntakeResult>('/api/memory/knows/intake', payload);
      if (res.error !== undefined || !res.data) {
        setBanner({ kind: 'bad', text: res.error || 'Something went wrong.' });
        return;
      }
      const added = res.data.added ?? [];
      setJustAdded(new Set(added.map((a) => a.id)));
      setNote('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      const tail = res.data.readNote ? ` ${res.data.readNote}` : '';
      const headline =
        added.length === 0 ? L('intakeNothing')
          : added.length === 1 ? L('intakeDoneOne')
            : `${added.length} ${L('intakeDoneMany')}`;
      setBanner({ kind: added.length > 0 ? 'good' : 'bad', text: `${headline}${tail}` });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'confirm' | 'remove') => {
    if (!activePropertyId) return;
    setRowBusy(id);
    try {
      const res = await post('/api/memory/knows', { propertyId: activePropertyId, action, id });
      if (res.error !== undefined) setBanner({ kind: 'bad', text: res.error });
      else setConfirmingRemove(null);
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const saveEdit = async (id: string) => {
    if (!activePropertyId || !draft.trim()) return;
    setRowBusy(id);
    try {
      const res = await post('/api/memory/knows', {
        propertyId: activePropertyId,
        action: 'edit',
        id,
        content: draft.trim(),
        category: draftCat,
      });
      if (res.error !== undefined) setBanner({ kind: 'bad', text: res.error });
      else setEditing(null);
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const groups = useMemo(() => groupFactsByCategory(data?.facts ?? []), [data]);
  const hasAnything = (data?.facts.length ?? 0) > 0;

  if (!canSee) {
    return (
      <div className="cx-page cx-swap">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: KN_CSS }} />
        <div className="cx-ptitle" style={{ marginTop: 0 }}>{L('title')}</div>
        <div className="cx-psub">{L('managerOnly')}</div>
      </div>
    );
  }

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: KN_CSS }} />

      <div className="cx-ptitle" style={{ marginTop: 0 }}>{L('title')}</div>
      <div className="cx-psub">{L('sub')}</div>

      {/* ── The open box ── */}
      <div className="kn-box">
        <div className="cx-dec-eyebrow">{L('boxEyebrow')}</div>
        <textarea
          className="kn-ta"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={L('boxPlaceholder')}
          aria-label={L('boxEyebrow')}
          maxLength={8000}
        />
        <div className="kn-boxfoot">
          <button
            type="button"
            className="kn-act"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {L('addFile')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <span className="kn-file">
              <CxIcon name="inventory" size={13} />
              <span>{file.name}</span>
              <button
                type="button"
                className="kn-act"
                style={{ height: 22, padding: '0 8px', border: 'none' }}
                onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
                aria-label={L('removeFile')}
              >
                ×
              </button>
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="kn-act kn-yes"
            onClick={submitIntake}
            disabled={busy || (!note.trim() && !file)}
          >
            {busy ? L('submitting') : L('submit')}
          </button>
        </div>
        <div className="kn-hint">{L('boxHint')}</div>
      </div>

      {banner && (
        <div className={`kn-note ${banner.kind === 'good' ? 'kn-good' : 'kn-bad'}`}>{banner.text}</div>
      )}

      {/* An error must never look like "your hotel has no facts". */}
      {error && !data && <div className="kn-note kn-bad">{L('loadFailed')}</div>}

      {data && (
        <div className="kn-meta">
          <span className="kn-metai">{data.stats.totalKnown} {L('known')}</span>
          {data.stats.pendingReview > 0 && (
            <span className="kn-metai" style={{ color: '#8C6A33' }}>
              {data.stats.pendingReview} {L('pending')}
            </span>
          )}
        </div>
      )}

      {!loading && data && !hasAnything && (
        <div className="kn-empty">
          <div className="cx-dec-t">{L('emptyTitle')}</div>
          <div className="cx-dec-s" style={{ maxWidth: 470, margin: '6px auto 0' }}>{L('emptyBody')}</div>
        </div>
      )}

      {hasAnything &&
        groups.map((g) => {
          const label = CATEGORY_LABELS[g.category];
          return (
            <div className="kn-grp" key={g.category}>
              <div className="kn-grph">
                <span className="kn-grpt">{label.title[es ? 'es' : 'en']}</span>
                <span className="kn-grpc">{g.items.length}</span>
              </div>
              <div className="kn-grps">{label.hint[es ? 'es' : 'en']}</div>

              {g.items.length === 0 ? (
                <div className="kn-rows">
                  <div className="kn-row" style={{ color: '#A6ABA6', fontSize: 12.5 }}>{L('nothingHere')}</div>
                </div>
              ) : (
                <div className="kn-rows">
                  {g.items.map((f) => {
                    const status = factStatus({ reviewState: f.reviewState, expiresAt: f.expiresAt });
                    const badgeClass =
                      status.kind === 'unreviewed' ? 'cx-warn' : status.kind === 'expiring' ? 'cx-mut' : 'cx-ok';
                    const isEditing = editing === f.id;
                    const disabled = rowBusy === f.id;
                    return (
                      <div className={`kn-row${justAdded.has(f.id) ? ' kn-new' : ''}`} key={f.id}>
                        <div className="kn-top">
                          <div style={{ minWidth: 0, flex: 1 }}>
                            {isEditing ? (
                              <>
                                <textarea
                                  className="kn-ta"
                                  style={{ marginTop: 0, minHeight: 62 }}
                                  value={draft}
                                  maxLength={500}
                                  onChange={(e) => setDraft(e.target.value)}
                                  aria-label={L('edit')}
                                />
                                <select
                                  className="kn-sel"
                                  style={{ marginTop: 8 }}
                                  value={draftCat}
                                  onChange={(e) => setDraftCat(e.target.value as MemoryCategory)}
                                  aria-label={L('edit')}
                                >
                                  {MEMORY_CATEGORIES.map((c) => (
                                    <option key={c} value={c}>{CATEGORY_LABELS[c].title[es ? 'es' : 'en']}</option>
                                  ))}
                                </select>
                              </>
                            ) : (
                              <>
                                <div className="kn-c">{f.content}</div>
                                <div className="kn-p">
                                  {provenanceLine(
                                    {
                                      source: f.source,
                                      topic: f.topic,
                                      createdByName: f.createdByName,
                                      updatedAt: f.updatedAt,
                                    },
                                    lang,
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                          <span className={`cx-bdg ${badgeClass}`}>{statusLabel(status, lang)}</span>
                        </div>

                        <div className="kn-acts">
                          {isEditing ? (
                            <>
                              <button
                                type="button" className="kn-act kn-yes" disabled={disabled || !draft.trim()}
                                onClick={() => saveEdit(f.id)}
                              >
                                {L('save')}
                              </button>
                              <button type="button" className="kn-act" onClick={() => setEditing(null)}>
                                {L('cancel')}
                              </button>
                            </>
                          ) : confirmingRemove === f.id ? (
                            <>
                              <span style={{ fontSize: 12, color: '#8E432B', alignSelf: 'center' }}>
                                {L('removeSure')}
                              </span>
                              <button
                                type="button" className="kn-act kn-danger" disabled={disabled}
                                onClick={() => act(f.id, 'remove')}
                              >
                                {L('removeYes')}
                              </button>
                              <button type="button" className="kn-act" onClick={() => setConfirmingRemove(null)}>
                                {L('cancel')}
                              </button>
                            </>
                          ) : (
                            <>
                              {status.kind !== 'confirmed' && (
                                <button
                                  type="button" className="kn-act kn-yes" disabled={disabled}
                                  onClick={() => act(f.id, 'confirm')}
                                >
                                  {L('confirm')}
                                </button>
                              )}
                              <button
                                type="button" className="kn-act" disabled={disabled}
                                onClick={() => { setEditing(f.id); setDraft(f.content); setDraftCat(f.category); }}
                              >
                                {L('edit')}
                              </button>
                              <button
                                type="button" className="kn-act kn-danger" disabled={disabled}
                                onClick={() => setConfirmingRemove(f.id)}
                              >
                                {L('remove')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
