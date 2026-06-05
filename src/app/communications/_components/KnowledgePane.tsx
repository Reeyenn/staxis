'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Knowledge hub — the third Communications view (Chats · Tasks · Knowledge).
// Sub-tabs: SOPs · Documents · Contacts · Calendar. ALL STAFF read; MANAGERS
// publish/edit. All data flows through /api/knowledge/* (service-role); this
// component never touches the browser DB client. The real Q&A happens through
// the existing bottom-right assistant (search_knowledge tool) — the banner at
// the top points the user there; we do NOT build a second chat UI here.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import {
  BookOpen, FileText, Phone, CalendarDays, Plus, Pencil, Trash2, Sparkles,
  Download, Loader2, ChevronLeft, Mail, Search, Lock, AlertTriangle,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/comms/client';
import type {
  KnowledgeArticleDTO, KnowledgeDocumentDTO, KnowledgeContactDTO, KnowledgeEventDTO,
  KnowledgeSection, ContactCategory, KnowledgeVisibility, ExtractionStatus,
} from '@/lib/knowledge/types';
import { CONTACT_CATEGORIES, KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';

type LFn = (en: string, es: string) => string;

// ── Extraction-status badge (drives the Documents list) ──────────────────────
function statusBadge(status: ExtractionStatus, L: LFn): { label: string; color: string; tone: 'good' | 'warn' | 'muted' } | null {
  switch (status) {
    case 'ready':       return { label: L('Searchable by AI', 'Buscable por IA'), color: 'var(--snow-sage-deep)', tone: 'good' };
    case 'partial':     return { label: L('Partially indexed', 'Indexado parcial'), color: 'var(--snow-sage-deep)', tone: 'good' };
    case 'pending':
    case 'processing':  return { label: L('Processing…', 'Procesando…'), color: 'var(--snow-ink3)', tone: 'muted' };
    case 'unsupported': return { label: L('Not text-searchable', 'No buscable por texto'), color: 'var(--snow-ink3)', tone: 'muted' };
    case 'failed':      return { label: L('Couldn’t read', 'No se pudo leer'), color: 'var(--snow-warm)', tone: 'warn' };
    default:            return null;
  }
}

const VIS_LABEL: Record<KnowledgeVisibility, { en: string; es: string }> = {
  all_staff: { en: 'All staff', es: 'Todo el personal' },
  managers: { en: 'Managers only', es: 'Solo gerentes' },
};
const SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';

// ── shared styles ─────────────────────────────────────────────────────────
const card: React.CSSProperties = { border: '1px solid var(--snow-rule)', borderRadius: 12, background: 'var(--snow-bg)' };
const primaryBtn: React.CSSProperties = { background: 'var(--snow-sage-deep)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 6 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--snow-ink2)', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 5 };
const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--snow-ink2)' };
const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '9px 11px', fontFamily: SANS, fontSize: 14, outline: 'none', background: 'var(--snow-bg)', color: 'var(--snow-ink)', boxSizing: 'border-box' };
const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 4, display: 'block' };
const chip: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--snow-sage-deep)', background: 'var(--snow-sage-dim)', borderRadius: 999, padding: '2px 8px' };

const SECTIONS: { key: KnowledgeSection; icon: React.ReactNode; en: string; es: string }[] = [
  { key: 'sops', icon: <BookOpen size={15} />, en: 'SOPs', es: 'Procedimientos' },
  { key: 'documents', icon: <FileText size={15} />, en: 'Documents', es: 'Documentos' },
  { key: 'contacts', icon: <Phone size={15} />, en: 'Contacts', es: 'Contactos' },
  { key: 'calendar', icon: <CalendarDays size={15} />, en: 'Calendar', es: 'Calendario' },
];

export function KnowledgePane({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [section, setSection] = React.useState<KnowledgeSection>('sops');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, fontFamily: SANS, color: 'var(--snow-ink)' }}>
      {/* Ask-Staxis hint — points at the existing bottom-right assistant. */}
      <div style={{ margin: '14px 20px 0', padding: '11px 14px', borderRadius: 12, background: 'var(--snow-sage-dim)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Sparkles size={17} color="var(--snow-sage-deep)" style={{ flexShrink: 0 }} />
        <div style={{ fontSize: 12.5, color: 'var(--snow-ink)', lineHeight: 1.4 }}>
          <strong>{L('Ask the assistant anything about these docs.', 'Pregúntale al asistente sobre estos documentos.')}</strong>{' '}
          {L('Open the chat at the bottom-right and ask in plain language — it answers from your SOPs, contacts, and documents.',
             'Abre el chat abajo a la derecha y pregunta normalmente — responde con tus procedimientos, contactos y documentos.')}
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 6, padding: '12px 20px', borderBottom: '1px solid var(--snow-rule)', flexWrap: 'wrap' }}>
        {SECTIONS.map((s) => {
          const active = section === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: active ? 'var(--snow-sage-dim)' : 'transparent', color: active ? 'var(--snow-sage-deep)' : 'var(--snow-ink2)', border: active ? '1px solid var(--snow-sage)' : '1px solid transparent', borderRadius: 9, padding: '7px 13px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SANS }}
            >
              {s.icon}{L(s.en, s.es)}
            </button>
          );
        })}
      </div>

      {/* Section body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {section === 'sops' && <SopsSection pid={pid} isManager={isManager} L={L} />}
        {section === 'documents' && <DocumentsSection pid={pid} isManager={isManager} L={L} />}
        {section === 'contacts' && <ContactsSection pid={pid} isManager={isManager} L={L} />}
        {section === 'calendar' && <CalendarSection pid={pid} isManager={isManager} L={L} />}
      </div>
    </div>
  );
}

// ── small shared bits ────────────────────────────────────────────────────────

function Loading({ L }: { L: LFn }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--snow-ink3)', fontSize: 13, padding: 20 }}><Loader2 size={15} className="spin" /> {L('Loading…', 'Cargando…')}</div>;
}
function Empty({ text }: { text: string }) {
  return <div style={{ color: 'var(--snow-ink3)', fontSize: 13.5, padding: '28px 8px', textAlign: 'center' }}>{text}</div>;
}
function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
      {action}
    </div>
  );
}

// ════════════════════════════════ SOPs ════════════════════════════════════

function SopsSection({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [items, setItems] = React.useState<KnowledgeArticleDTO[] | null>(null);
  const [selected, setSelected] = React.useState<KnowledgeArticleDTO | null>(null);
  const [editing, setEditing] = React.useState<null | 'new' | KnowledgeArticleDTO>(null);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ articles: KnowledgeArticleDTO[] }>(`/api/knowledge/articles?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setItems(r.data.articles);
    else setItems([]);
  }, [pid]);
  React.useEffect(() => { void load(); }, [load]);

  const remove = async (a: KnowledgeArticleDTO) => {
    if (!window.confirm(L(`Delete "${a.title}"?`, `¿Eliminar "${a.title}"?`))) return;
    await apiDelete(`/api/knowledge/articles?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(a.id)}`);
    setSelected(null);
    await load();
  };

  if (editing) {
    return <SopEditor pid={pid} L={L} article={editing === 'new' ? null : editing} onDone={async () => { setEditing(null); await load(); }} onCancel={() => setEditing(null)} />;
  }

  if (selected) {
    return (
      <div>
        <button onClick={() => setSelected(null)} style={{ ...ghostBtn, marginBottom: 12 }}><ChevronLeft size={14} /> {L('Back', 'Atrás')}</button>
        <div style={{ ...card, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>{selected.title}</div>
              <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {selected.category && <span style={chip}>{selected.category}</span>}
                {selected.visibility === 'managers' && <span style={{ ...chip, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Lock size={10} /> {L(VIS_LABEL.managers.en, VIS_LABEL.managers.es)}</span>}
              </div>
            </div>
            {isManager && (
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button onClick={() => setEditing(selected)} title={L('Edit', 'Editar')} style={iconBtn}><Pencil size={15} /></button>
                <button onClick={() => remove(selected)} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={15} /></button>
              </div>
            )}
          </div>
          <div style={{ marginTop: 14, fontSize: 14, lineHeight: 1.6, color: 'var(--snow-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{selected.body || L('(No content yet.)', '(Sin contenido aún.)')}</div>
          {(selected.updatedByName || selected.createdByName) && (
            <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--snow-ink3)' }}>
              {L('Last updated by', 'Última actualización por')} {selected.updatedByName || selected.createdByName} · {new Date(selected.updatedAt).toLocaleDateString()}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title={L('Standard Operating Procedures', 'Procedimientos operativos')}
        action={isManager ? <button onClick={() => setEditing('new')} style={primaryBtn}><Plus size={15} /> {L('New SOP', 'Nuevo')}</button> : undefined}
      />
      {items === null ? <Loading L={L} /> : items.length === 0 ? (
        <Empty text={isManager ? L('No SOPs yet. Add your first how-to so the team — and the assistant — can find it.', 'Aún no hay procedimientos. Agrega el primero para que el equipo y el asistente lo encuentren.') : L('No SOPs published yet.', 'Aún no hay procedimientos publicados.')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((a) => (
            <button key={a.id} onClick={() => setSelected(a)} style={{ ...card, padding: '12px 14px', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
              <BookOpen size={16} color="var(--snow-ink3)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
                {a.body && <div style={{ fontSize: 12.5, color: 'var(--snow-ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.body.replace(/\s+/g, ' ').slice(0, 120)}</div>}
              </div>
              {a.visibility === 'managers' && <Lock size={13} color="var(--snow-ink3)" />}
              {a.category && <span style={chip}>{a.category}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SopEditor({ pid, article, L, onDone, onCancel }: { pid: string; article: KnowledgeArticleDTO | null; L: LFn; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = React.useState(article?.title ?? '');
  const [category, setCategory] = React.useState(article?.category ?? '');
  const [body, setBody] = React.useState(article?.body ?? '');
  const [visibility, setVisibility] = React.useState<KnowledgeVisibility>(article?.visibility ?? 'all_staff');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    const payload = { pid, title: title.trim(), body, category: category.trim() || null, visibility };
    const r = article
      ? await apiPatch('/api/knowledge/articles', { ...payload, id: article.id })
      : await apiPost('/api/knowledge/articles', payload);
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error || L('Could not save. Try again.', 'No se pudo guardar. Inténtalo de nuevo.'));
  };

  return (
    <div>
      <button onClick={onCancel} style={{ ...ghostBtn, marginBottom: 12 }}><ChevronLeft size={14} /> {L('Cancel', 'Cancelar')}</button>
      <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{article ? L('Edit SOP', 'Editar procedimiento') : L('New SOP', 'Nuevo procedimiento')}</div>
        <div>
          <label style={labelStyle}>{L('Title', 'Título')}</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={KNOWLEDGE_LIMITS.TITLE_MAX} placeholder={L('e.g. Breakfast bar setup', 'ej. Montaje del desayuno')} style={inputStyle} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('Category (optional)', 'Categoría (opcional)')}</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={KNOWLEDGE_LIMITS.CATEGORY_MAX} placeholder={L('e.g. Front desk, Breakfast, Safety', 'ej. Recepción, Desayuno, Seguridad')} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>{L('Who can see it', 'Quién puede verlo')}</label>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as KnowledgeVisibility)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="all_staff">{L(VIS_LABEL.all_staff.en, VIS_LABEL.all_staff.es)}</option>
              <option value="managers">{L(VIS_LABEL.managers.en, VIS_LABEL.managers.es)}</option>
            </select>
          </div>
        </div>
        <div>
          <label style={labelStyle}>{L('Steps / content', 'Pasos / contenido')}</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={KNOWLEDGE_LIMITS.BODY_MAX} rows={12} placeholder={L('Write the procedure here. Plain text or markdown.', 'Escribe el procedimiento aquí. Texto simple o markdown.')} style={{ ...inputStyle, resize: 'vertical', minHeight: 160, lineHeight: 1.5 }} />
        </div>
        {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={busy || !title.trim()} style={{ ...primaryBtn, opacity: busy || !title.trim() ? 0.5 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : null} {L('Save', 'Guardar')}</button>
          <button onClick={onCancel} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════ Documents ══════════════════════════════════

const ACCEPT_DOCS = '.pdf,.txt,.md,.markdown,.csv,.doc,.docx';

function DocumentsSection({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [items, setItems] = React.useState<KnowledgeDocumentDTO[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploadVis, setUploadVis] = React.useState<KnowledgeVisibility>('all_staff');
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ documents: KnowledgeDocumentDTO[] }>(`/api/knowledge/documents?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setItems(r.data.documents);
    else setItems([]);
  }, [pid]);
  React.useEffect(() => { void load(); }, [load]);

  // Auto-refresh while any document is still being read/embedded (the upload
  // route processes in the background), so "Processing…" flips to "Searchable"
  // without a manual reload. Stops once nothing is pending/processing.
  React.useEffect(() => {
    const anyProcessing = (items ?? []).some((d) => d.extractionStatus === 'pending' || d.extractionStatus === 'processing');
    if (!anyProcessing) return;
    const t = setTimeout(() => { void load(); }, 4000);
    return () => clearTimeout(t);
  }, [items, load]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > 10_485_760) { setError(L('File too large (max 10 MB).', 'Archivo muy grande (máx 10 MB).')); return; }
    setBusy(true);
    try {
      const pre = await apiPost<{ path: string; signedUrl: string; contentType: string }>('/api/knowledge/documents/presign', { pid, filename: file.name });
      if (!pre.ok || !pre.data) { setError(pre.error || L('Unsupported file type.', 'Tipo de archivo no admitido.')); return; }
      // PUT with the SERVER-resolved Content-Type so it matches the bucket's allowed types.
      const up = await fetch(pre.data.signedUrl, { method: 'PUT', body: file, headers: { 'Content-Type': pre.data.contentType } });
      if (!up.ok) { setError(L('Upload failed. Try again.', 'La carga falló. Inténtalo de nuevo.')); return; }
      const title = file.name.replace(/\.[^.]+$/, '').slice(0, KNOWLEDGE_LIMITS.TITLE_MAX) || file.name;
      const reg = await apiPost('/api/knowledge/documents', { pid, title, path: pre.data.path, mimeType: pre.data.contentType, sizeBytes: file.size, visibility: uploadVis });
      if (!reg.ok) { setError(reg.error || L('Could not save the document.', 'No se pudo guardar el documento.')); return; }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: KnowledgeDocumentDTO) => {
    if (!window.confirm(L(`Delete "${d.title}"?`, `¿Eliminar "${d.title}"?`))) return;
    await apiDelete(`/api/knowledge/documents?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(d.id)}`);
    await load();
  };

  return (
    <div>
      <SectionHeader
        title={L('Documents', 'Documentos')}
        action={isManager ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={uploadVis}
              onChange={(e) => setUploadVis(e.target.value as KnowledgeVisibility)}
              title={L('Who can see the next upload', 'Quién verá la próxima carga')}
              style={{ ...ghostBtn, cursor: 'pointer', padding: '7px 10px' }}
            >
              <option value="all_staff">{L(VIS_LABEL.all_staff.en, VIS_LABEL.all_staff.es)}</option>
              <option value="managers">{L(VIS_LABEL.managers.en, VIS_LABEL.managers.es)}</option>
            </select>
            <input ref={fileRef} type="file" accept={ACCEPT_DOCS} onChange={onPick} style={{ display: 'none' }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />} {L('Upload', 'Subir')}</button>
          </div>
        ) : undefined}
      />
      {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      {isManager && <div style={{ fontSize: 11.5, color: 'var(--snow-ink3)', marginBottom: 12 }}>{L('PDF, Word, Text, Markdown, CSV up to 10 MB. The assistant reads the full text of typed PDFs and Word docs — ask it anything about them. Scanned (photo) PDFs can’t be read yet.', 'PDF, Word, Texto, Markdown, CSV hasta 10 MB. El asistente lee el texto completo de los PDF y documentos de Word — pregúntale lo que sea. Los PDF escaneados (foto) aún no se pueden leer.')}</div>}
      {items === null ? <Loading L={L} /> : items.length === 0 ? (
        <Empty text={L('No documents yet.', 'Aún no hay documentos.')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((d) => (
            <div key={d.id} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <FileText size={16} color="var(--snow-ink3)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--snow-ink3)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{prettyType(d.mimeType)}</span>
                  {d.sizeBytes != null && <span>· {prettySize(d.sizeBytes)}</span>}
                  {(() => {
                    const b = statusBadge(d.extractionStatus, L);
                    if (!b) return null;
                    const Icon = b.tone === 'good' ? Search : b.tone === 'warn' ? AlertTriangle : Loader2;
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: b.color, fontWeight: 600 }}>
                        <Icon size={11} className={b.tone === 'muted' && (d.extractionStatus === 'pending' || d.extractionStatus === 'processing') ? 'spin' : undefined} /> {b.label}
                      </span>
                    );
                  })()}
                  {d.visibility === 'managers' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--snow-ink3)', fontWeight: 600 }}><Lock size={11} /> {L(VIS_LABEL.managers.en, VIS_LABEL.managers.es)}</span>}
                </div>
              </div>
              {d.downloadUrl && (
                <a href={d.downloadUrl} target="_blank" rel="noopener noreferrer" title={L('Download', 'Descargar')} style={{ ...iconBtn, textDecoration: 'none' }}><Download size={15} /></a>
              )}
              {isManager && <button onClick={() => remove(d)} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={15} /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function prettyType(mime: string | null): string {
  if (!mime) return 'File';
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'text/markdown') return 'Markdown';
  if (mime === 'text/plain') return 'Text';
  if (mime === 'text/csv') return 'CSV';
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return 'Word';
  return mime;
}
function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ══════════════════════════════ Contacts ════════════════════════════════════

const CONTACT_CAT_LABEL: Record<ContactCategory, { en: string; es: string }> = {
  vendor: { en: 'Vendors', es: 'Proveedores' },
  emergency: { en: 'Emergency', es: 'Emergencia' },
  brand: { en: 'Brand', es: 'Marca' },
  local: { en: 'Local', es: 'Local' },
};

function ContactsSection({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [items, setItems] = React.useState<KnowledgeContactDTO[] | null>(null);
  const [editing, setEditing] = React.useState<null | 'new' | KnowledgeContactDTO>(null);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ contacts: KnowledgeContactDTO[] }>(`/api/knowledge/contacts?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setItems(r.data.contacts);
    else setItems([]);
  }, [pid]);
  React.useEffect(() => { void load(); }, [load]);

  const remove = async (c: KnowledgeContactDTO) => {
    if (!window.confirm(L(`Delete "${c.name}"?`, `¿Eliminar "${c.name}"?`))) return;
    await apiDelete(`/api/knowledge/contacts?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(c.id)}`);
    await load();
  };

  if (editing) {
    return <ContactEditor pid={pid} L={L} contact={editing === 'new' ? null : editing} onDone={async () => { setEditing(null); await load(); }} onCancel={() => setEditing(null)} />;
  }

  // Group by category for display (null → "Other").
  const groups: { key: string; label: string; rows: KnowledgeContactDTO[] }[] = [];
  const order: (ContactCategory | 'other')[] = [...CONTACT_CATEGORIES, 'other'];
  for (const cat of order) {
    const rows = (items ?? []).filter((c) => (c.category ?? 'other') === cat);
    if (rows.length === 0) continue;
    const label = cat === 'other' ? L('Other', 'Otros') : L(CONTACT_CAT_LABEL[cat].en, CONTACT_CAT_LABEL[cat].es);
    groups.push({ key: cat, label, rows });
  }

  return (
    <div>
      <SectionHeader
        title={L('Contacts', 'Contactos')}
        action={isManager ? <button onClick={() => setEditing('new')} style={primaryBtn}><Plus size={15} /> {L('Add contact', 'Agregar')}</button> : undefined}
      />
      {items === null ? <Loading L={L} /> : items.length === 0 ? (
        <Empty text={L('No contacts yet. Add vendors, emergency numbers, and brand reps.', 'Aún no hay contactos. Agrega proveedores, números de emergencia y representantes de marca.')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 6 }}>{g.label}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {g.rows.map((c) => (
                  <div key={c.id} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}{c.company && <span style={{ fontWeight: 400, color: 'var(--snow-ink2)' }}> · {c.company}</span>}</div>
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 3 }}>
                        {c.phone && <a href={`tel:${c.phone}`} style={{ fontSize: 13, color: 'var(--snow-sage-deep)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Phone size={12} /> {c.phone}</a>}
                        {c.email && <a href={`mailto:${c.email}`} style={{ fontSize: 13, color: 'var(--snow-sage-deep)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Mail size={12} /> {c.email}</a>}
                      </div>
                      {c.notes && <div style={{ fontSize: 12.5, color: 'var(--snow-ink3)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
                    </div>
                    {isManager && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button onClick={() => setEditing(c)} title={L('Edit', 'Editar')} style={iconBtn}><Pencil size={14} /></button>
                        <button onClick={() => remove(c)} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={14} /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactEditor({ pid, contact, L, onDone, onCancel }: { pid: string; contact: KnowledgeContactDTO | null; L: LFn; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = React.useState(contact?.name ?? '');
  const [company, setCompany] = React.useState(contact?.company ?? '');
  const [category, setCategory] = React.useState<ContactCategory | ''>(contact?.category ?? '');
  const [phone, setPhone] = React.useState(contact?.phone ?? '');
  const [email, setEmail] = React.useState(contact?.email ?? '');
  const [notes, setNotes] = React.useState(contact?.notes ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    const payload = { pid, name: name.trim(), company: company.trim() || null, category: category || null, phone: phone.trim() || null, email: email.trim() || null, notes: notes.trim() || null };
    const r = contact
      ? await apiPatch('/api/knowledge/contacts', { ...payload, id: contact.id })
      : await apiPost('/api/knowledge/contacts', payload);
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error || L('Could not save. Try again.', 'No se pudo guardar. Inténtalo de nuevo.'));
  };

  return (
    <div>
      <button onClick={onCancel} style={{ ...ghostBtn, marginBottom: 12 }}><ChevronLeft size={14} /> {L('Cancel', 'Cancelar')}</button>
      <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{contact ? L('Edit contact', 'Editar contacto') : L('New contact', 'Nuevo contacto')}</div>
        <div>
          <label style={labelStyle}>{L('Name', 'Nombre')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={KNOWLEDGE_LIMITS.CONTACT_NAME_MAX} style={inputStyle} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('Role / company', 'Rol / empresa')}</label>
            <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={KNOWLEDGE_LIMITS.COMPANY_MAX} placeholder={L('e.g. Plumber, ABC Supply', 'ej. Plomero, ABC')} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>{L('Category', 'Categoría')}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as ContactCategory | '')} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">{L('— none —', '— ninguna —')}</option>
              {CONTACT_CATEGORIES.map((c) => <option key={c} value={c}>{L(CONTACT_CAT_LABEL[c].en, CONTACT_CAT_LABEL[c].es)}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>{L('Phone', 'Teléfono')}</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={KNOWLEDGE_LIMITS.PHONE_MAX} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('Email', 'Correo')}</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={KNOWLEDGE_LIMITS.EMAIL_MAX} style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>{L('Notes (optional)', 'Notas (opcional)')}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={KNOWLEDGE_LIMITS.NOTES_MAX} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
        {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={busy || !name.trim()} style={{ ...primaryBtn, opacity: busy || !name.trim() ? 0.5 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : null} {L('Save', 'Guardar')}</button>
          <button onClick={onCancel} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════ Calendar ════════════════════════════════════

function CalendarSection({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [items, setItems] = React.useState<KnowledgeEventDTO[] | null>(null);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ events: KnowledgeEventDTO[] }>(`/api/knowledge/events?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setItems(r.data.events);
    else setItems([]);
  }, [pid]);
  React.useEffect(() => { void load(); }, [load]);

  const remove = async (ev: KnowledgeEventDTO) => {
    if (!window.confirm(L(`Delete "${ev.title}"?`, `¿Eliminar "${ev.title}"?`))) return;
    await apiDelete(`/api/knowledge/events?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(ev.id)}`);
    await load();
  };

  // Split upcoming vs past (today inclusive in upcoming).
  const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
  const upcoming = (items ?? []).filter((e) => (e.endDate ?? e.eventDate) >= todayStr);
  const past = (items ?? []).filter((e) => (e.endDate ?? e.eventDate) < todayStr).reverse();

  return (
    <div>
      <SectionHeader
        title={L('Team calendar', 'Calendario del equipo')}
        action={isManager ? <button onClick={() => setAdding((v) => !v)} style={primaryBtn}><Plus size={15} /> {L('Add event', 'Agregar')}</button> : undefined}
      />
      {adding && isManager && <EventEditor pid={pid} L={L} onDone={async () => { setAdding(false); await load(); }} onCancel={() => setAdding(false)} />}
      {items === null ? <Loading L={L} /> : items.length === 0 ? (
        <Empty text={L('No events yet. Add training days, vendor visits, or brand audits.', 'Aún no hay eventos. Agrega días de capacitación, visitas de proveedores o auditorías.')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {upcoming.length > 0 && <EventList title={L('Upcoming', 'Próximos')} events={upcoming} isManager={isManager} onRemove={remove} L={L} />}
          {past.length > 0 && <EventList title={L('Past', 'Pasados')} events={past} isManager={isManager} onRemove={remove} L={L} dim />}
        </div>
      )}
    </div>
  );
}

function EventList({ title, events, isManager, onRemove, L, dim }: { title: string; events: KnowledgeEventDTO[]; isManager: boolean; onRemove: (e: KnowledgeEventDTO) => void; L: LFn; dim?: boolean }) {
  return (
    <div style={{ opacity: dim ? 0.7 : 1 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.map((ev) => (
          <div key={ev.id} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 46 }}>
              <CalendarDays size={16} color="var(--snow-sage-deep)" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{ev.title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--snow-ink2)' }}>{fmtRange(ev.eventDate, ev.endDate, L)}</div>
              {ev.notes && <div style={{ fontSize: 12.5, color: 'var(--snow-ink3)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{ev.notes}</div>}
            </div>
            {isManager && <button onClick={() => onRemove(ev)} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtRange(start: string, end: string | null, L: LFn): string {
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (!end || end === start) return fmt(start);
  return `${fmt(start)} → ${fmt(end)}`;
}

function EventEditor({ pid, L, onDone, onCancel }: { pid: string; L: LFn; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = React.useState('');
  const [eventDate, setEventDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || !eventDate || busy) return;
    setBusy(true); setError(null);
    const r = await apiPost('/api/knowledge/events', { pid, title: title.trim(), eventDate, endDate: endDate || null, notes: notes.trim() || null });
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error || L('Could not save. Try again.', 'No se pudo guardar. Inténtalo de nuevo.'));
  };

  return (
    <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16, maxWidth: 520 }}>
      <div>
        <label style={labelStyle}>{L('Title', 'Título')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={KNOWLEDGE_LIMITS.TITLE_MAX} placeholder={L('e.g. Fire safety training', 'ej. Capacitación contra incendios')} style={inputStyle} autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label style={labelStyle}>{L('Date', 'Fecha')}</label>
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label style={labelStyle}>{L('End date (optional)', 'Fecha fin (opcional)')}</label>
          <input type="date" value={endDate} min={eventDate || undefined} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
        </div>
      </div>
      <div>
        <label style={labelStyle}>{L('Notes (optional)', 'Notas (opcional)')}</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={KNOWLEDGE_LIMITS.NOTES_MAX} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>
      {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={busy || !title.trim() || !eventDate} style={{ ...primaryBtn, opacity: busy || !title.trim() || !eventDate ? 0.5 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : null} {L('Save', 'Guardar')}</button>
        <button onClick={onCancel} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}
