'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Knowledge hub — a Communications view. Sub-tabs: SOPs · Documents.
// (Calendar and Contacts were each promoted to their own top-level
// Communications sub-tabs — see CalendarPane.tsx and ContactsPane.tsx; both
// stay AI-searchable via search_knowledge.) ALL STAFF read; MANAGERS
// publish/edit. All data flows through /api/knowledge/* (service-role); this
// component never touches the browser DB client. The real Q&A happens through
// the existing bottom-right assistant (search_knowledge tool) — the banner at
// the top points the user there; we do NOT build a second chat UI here.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import {
  BookOpen, FileText, Plus, Pencil, Trash2, Sparkles,
  Download, Loader2, ChevronLeft, Search, Lock, AlertTriangle,
  Folder, FolderPlus, Users,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/comms/client';
import type {
  KnowledgeArticleDTO, KnowledgeDocumentDTO, KnowledgeFolderDTO,
  KnowledgeSection, KnowledgeVisibility, ExtractionStatus, Dept,
} from '@/lib/knowledge/types';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import { useCommsResource } from './comms-data';
import { SANS, card, primaryBtn, ghostBtn, iconBtn, inputStyle, labelStyle, Loading, Empty } from './comms-snow';

type LFn = (en: string, es: string) => string;

// ── Extraction-status badge (drives the Documents list) ──────────────────────
function statusBadge(status: ExtractionStatus, L: LFn): { label: string; color: string; tone: 'good' | 'warn' | 'muted' } | null {
  switch (status) {
    case 'ready':       return { label: L('Searchable by AI', 'Buscable por IA'), color: 'var(--snow-sage-deep)', tone: 'good' };
    case 'partial':     return { label: L('Partially indexed', 'Indexado parcial'), color: 'var(--snow-sage-deep)', tone: 'good' };
    case 'pending':     return { label: L('Processing…', 'Procesando…'), color: 'var(--snow-ink3)', tone: 'muted' };
    case 'processing':  return { label: L('Reading scan…', 'Leyendo el escaneo…'), color: 'var(--snow-ink3)', tone: 'muted' };
    case 'unsupported': return { label: L('Not text-searchable', 'No buscable por texto'), color: 'var(--snow-ink3)', tone: 'muted' };
    case 'failed':      return { label: L('Couldn’t read', 'No se pudo leer'), color: 'var(--snow-warm)', tone: 'warn' };
    default:            return null;
  }
}

const VIS_LABEL: Record<KnowledgeVisibility, { en: string; es: string }> = {
  all_staff: { en: 'All staff', es: 'Todo el personal' },
  dept: { en: 'One department', es: 'Un departamento' },
  managers: { en: 'Managers only', es: 'Solo gerentes' },
};

// Department labels (the three real departments a document can be scoped to).
const DEPT_LABEL: Record<Dept, { en: string; es: string }> = {
  front_desk: { en: 'Front desk', es: 'Recepción' },
  housekeeping: { en: 'Housekeeping', es: 'Limpieza' },
  maintenance: { en: 'Maintenance', es: 'Mantenimiento' },
};

// The document access choice as a single value: a visibility tier OR a department.
type AccessVal = 'all_staff' | 'managers' | Dept;
const ACCESS_OPTIONS: { value: AccessVal; en: string; es: string }[] = [
  { value: 'all_staff', en: 'Everyone', es: 'Todos' },
  { value: 'front_desk', en: DEPT_LABEL.front_desk.en, es: DEPT_LABEL.front_desk.es },
  { value: 'housekeeping', en: DEPT_LABEL.housekeeping.en, es: DEPT_LABEL.housekeeping.es },
  { value: 'maintenance', en: DEPT_LABEL.maintenance.en, es: DEPT_LABEL.maintenance.es },
  { value: 'managers', en: 'Managers only', es: 'Solo gerentes' },
];
function docAccessVal(d: KnowledgeDocumentDTO): AccessVal {
  if (d.visibility === 'dept') return d.visibleDept ?? 'all_staff';
  return d.visibility; // 'all_staff' | 'managers'
}
function accessToPayload(a: AccessVal): { visibility: KnowledgeVisibility; visibleDept: Dept | null } {
  if (a === 'all_staff' || a === 'managers') return { visibility: a, visibleDept: null };
  return { visibility: 'dept', visibleDept: a };
}

// Shared Snow styles live in comms-snow.tsx; `chip` is only used here.
const chip: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--snow-sage-deep)', background: 'var(--snow-sage-dim)', borderRadius: 999, padding: '2px 8px' };

const SECTIONS: { key: KnowledgeSection; icon: React.ReactNode; en: string; es: string }[] = [
  { key: 'sops', icon: <BookOpen size={15} />, en: 'SOPs', es: 'Procedimientos' },
  { key: 'documents', icon: <FileText size={15} />, en: 'Documents', es: 'Documentos' },
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
      </div>
    </div>
  );
}

// ── small shared bits ────────────────────────────────────────────────────────

function SectionHeader({ title, action }: { title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
      {action}
    </div>
  );
}

// ════════════════════════════════ SOPs ════════════════════════════════════

function SopsSection({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [selected, setSelected] = React.useState<KnowledgeArticleDTO | null>(null);
  const [editing, setEditing] = React.useState<null | 'new' | KnowledgeArticleDTO>(null);

  const { data, loading, reload } = useCommsResource<{ articles: KnowledgeArticleDTO[] }>(`/api/knowledge/articles?pid=${encodeURIComponent(pid)}`);
  // null = still loading (spinner); a failed fetch shows the empty state.
  const items = data?.articles ?? (loading ? null : []);

  const remove = async (a: KnowledgeArticleDTO) => {
    if (!window.confirm(L(`Delete "${a.title}"?`, `¿Eliminar "${a.title}"?`))) return;
    await apiDelete(`/api/knowledge/articles?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(a.id)}`);
    setSelected(null);
    await reload();
  };

  if (editing) {
    return <SopEditor pid={pid} L={L} article={editing === 'new' ? null : editing} onDone={async () => { setEditing(null); await reload(); }} onCancel={() => setEditing(null)} />;
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

const ACCEPT_DOCS = '.pdf,.txt,.md,.markdown,.csv,.doc,.docx,.jpg,.jpeg,.png,.webp';

function DocumentsSection({ pid, isManager, L }: { pid: string; isManager: boolean; L: LFn }) {
  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploadAccess, setUploadAccess] = React.useState<AccessVal>('all_staff');
  const [uploadFolderId, setUploadFolderId] = React.useState<string | null>(null);
  const [addingFolder, setAddingFolder] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState('');
  const [editingDocId, setEditingDocId] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  // Docs + folders land together; either half failing falls back to [] on its
  // own (never an error state), exactly like the old paired setStates.
  const { data, reload } = useCommsResource<{ documents: KnowledgeDocumentDTO[]; folders: KnowledgeFolderDTO[] }>({
    key: pid,
    fetch: async () => {
      const [docsR, foldersR] = await Promise.all([
        apiGet<{ documents: KnowledgeDocumentDTO[] }>(`/api/knowledge/documents?pid=${encodeURIComponent(pid)}`),
        apiGet<{ folders: KnowledgeFolderDTO[] }>(`/api/knowledge/folders?pid=${encodeURIComponent(pid)}`),
      ]);
      return {
        data: {
          documents: docsR.ok && docsR.data ? docsR.data.documents : [],
          folders: foldersR.ok && foldersR.data ? foldersR.data.folders : [],
        },
      };
    },
  });
  const items = data ? data.documents : null;
  const folders = data?.folders ?? [];

  // Auto-refresh while any document is still being read/embedded (the upload
  // route processes in the background), so "Processing…" flips to "Searchable"
  // without a manual reload. Stops once nothing is pending/processing. A
  // one-shot timeout chain (not pollMs): it must fire even in a hidden tab.
  React.useEffect(() => {
    const anyProcessing = (items ?? []).some((d) => d.extractionStatus === 'pending' || d.extractionStatus === 'processing');
    if (!anyProcessing) return;
    const t = setTimeout(() => { void reload(); }, 4000);
    return () => clearTimeout(t);
  }, [items, reload]);

  // Uploads land in the folder you're viewing; at the root, the upload-target picker.
  const targetFolderId = currentFolderId ?? uploadFolderId;

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
      const access = accessToPayload(uploadAccess);
      const reg = await apiPost('/api/knowledge/documents', { pid, title, path: pre.data.path, mimeType: pre.data.contentType, sizeBytes: file.size, visibility: access.visibility, visibleDept: access.visibleDept, folderId: targetFolderId });
      if (!reg.ok) { setError(reg.error || L('Could not save the document.', 'No se pudo guardar el documento.')); return; }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const removeDoc = async (d: KnowledgeDocumentDTO) => {
    if (!window.confirm(L(`Delete "${d.title}"?`, `¿Eliminar "${d.title}"?`))) return;
    await apiDelete(`/api/knowledge/documents?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(d.id)}`);
    await reload();
  };

  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const r = await apiPost('/api/knowledge/folders', { pid, name });
    if (!r.ok) { setError(r.error || L('Could not create the folder.', 'No se pudo crear la carpeta.')); return; }
    setNewFolderName(''); setAddingFolder(false);
    await reload();
  };

  const renameFolder = async (f: KnowledgeFolderDTO) => {
    const name = window.prompt(L('Rename folder', 'Renombrar carpeta'), f.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === f.name) return;
    await apiPatch('/api/knowledge/folders', { pid, id: f.id, name: trimmed });
    await reload();
  };

  const removeFolder = async (f: KnowledgeFolderDTO) => {
    if (!window.confirm(L('Delete this folder? The files inside are kept — they just move out of the folder.', '¿Eliminar esta carpeta? Los archivos se conservan — solo salen de la carpeta.'))) return;
    await apiDelete(`/api/knowledge/folders?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(f.id)}`);
    if (currentFolderId === f.id) setCurrentFolderId(null);
    await reload();
  };

  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const folderCount = (fid: string) => (items ?? []).filter((d) => d.folderId === fid).length;
  // Root shows unfiled docs; inside a folder, that folder's docs.
  const visibleDocs = (items ?? []).filter((d) => (currentFolderId ? d.folderId === currentFolderId : d.folderId === null));

  const uploadControls = isManager ? (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <AccessSelect value={uploadAccess} onChange={setUploadAccess} L={L} title={L('Who can see the next upload', 'Quién verá la próxima carga')} />
      {currentFolderId === null && folders.length > 0 && (
        <FolderSelect value={uploadFolderId} onChange={setUploadFolderId} folders={folders} L={L} title={L('Upload into folder', 'Subir a la carpeta')} />
      )}
      <input ref={fileRef} type="file" accept={ACCEPT_DOCS} onChange={onPick} style={{ display: 'none' }} />
      <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />} {L('Upload', 'Subir')}</button>
    </div>
  ) : undefined;

  const docList = (emptyText: string) => (
    <DocList
      docs={visibleDocs}
      isManager={isManager}
      folders={folders}
      pid={pid}
      L={L}
      editingId={editingDocId}
      onEdit={(id) => setEditingDocId(id)}
      onRemove={removeDoc}
      onChanged={async () => { setEditingDocId(null); await reload(); }}
      emptyText={emptyText}
    />
  );

  // ── Folder view (drilled into one folder) ────────────────────────────────
  if (currentFolderId !== null) {
    return (
      <div>
        <button onClick={() => { setCurrentFolderId(null); setEditingDocId(null); }} style={{ ...ghostBtn, marginBottom: 12 }}><ChevronLeft size={14} /> {L('All documents', 'Todos los documentos')}</button>
        <SectionHeader
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Folder size={17} color="var(--snow-sage-deep)" /> {currentFolder?.name ?? L('Folder', 'Carpeta')}</span>}
          action={uploadControls}
        />
        {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        {items === null ? <Loading L={L} /> : docList(L('No documents in this folder yet.', 'Aún no hay documentos en esta carpeta.'))}
      </div>
    );
  }

  // ── Root view (folders + unfiled documents) ──────────────────────────────
  return (
    <div>
      <SectionHeader
        title={L('Documents', 'Documentos')}
        action={isManager ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {uploadControls}
            <button onClick={() => setAddingFolder((v) => !v)} style={ghostBtn}><FolderPlus size={15} /> {L('New folder', 'Nueva carpeta')}</button>
          </div>
        ) : undefined}
      />
      {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      {isManager && <div style={{ fontSize: 11.5, color: 'var(--snow-ink3)', marginBottom: 12 }}>{L('PDF, Word, Text, Markdown, CSV, and photos (JPG, PNG, WebP) up to 10 MB. The assistant reads the full text — including scanned PDFs and photos, which it transcribes with AI (that takes a moment; the badge shows “Reading scan…” until it’s ready).', 'PDF, Word, Texto, Markdown, CSV y fotos (JPG, PNG, WebP) hasta 10 MB. El asistente lee el texto completo — incluidos los PDF escaneados y las fotos, que transcribe con IA (tarda un momento; la etiqueta muestra “Leyendo el escaneo…” hasta que esté listo).')}</div>}
      {addingFolder && isManager && (
        <div style={{ ...card, padding: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            maxLength={KNOWLEDGE_LIMITS.FOLDER_NAME_MAX}
            placeholder={L('Folder name', 'Nombre de la carpeta')}
            style={{ ...inputStyle, flex: 1, minWidth: 160 }}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') void addFolder(); }}
          />
          <button onClick={() => void addFolder()} disabled={!newFolderName.trim()} style={{ ...primaryBtn, opacity: newFolderName.trim() ? 1 : 0.5 }}>{L('Create', 'Crear')}</button>
          <button onClick={() => { setAddingFolder(false); setNewFolderName(''); }} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
        </div>
      )}
      {items === null ? <Loading L={L} /> : (folders.length === 0 && visibleDocs.length === 0) ? (
        <Empty text={L('No documents yet.', 'Aún no hay documentos.')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {folders.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {folders.map((f) => (
                <div key={f.id} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => { setCurrentFolderId(f.id); setEditingDocId(null); }} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, font: 'inherit', color: 'inherit' }}>
                    <Folder size={16} color="var(--snow-sage-deep)" style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--snow-ink3)', flexShrink: 0 }}>· {folderCount(f.id)} {L('files', 'archivos')}</span>
                  </button>
                  {isManager && (
                    <>
                      <button onClick={() => void renameFolder(f)} title={L('Rename', 'Renombrar')} style={iconBtn}><Pencil size={14} /></button>
                      <button onClick={() => void removeFolder(f)} title={L('Delete folder', 'Eliminar carpeta')} style={iconBtn}><Trash2 size={14} /></button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {visibleDocs.length > 0 && (
            <div>
              {folders.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 6 }}>{L('Not in a folder', 'Sin carpeta')}</div>}
              {docList(L('No documents yet.', 'Aún no hay documentos.'))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Documents — list + row + inline access/folder editor + selects ───────────

function DocList({ docs, isManager, folders, pid, L, editingId, onEdit, onRemove, onChanged, emptyText }: {
  docs: KnowledgeDocumentDTO[]; isManager: boolean; folders: KnowledgeFolderDTO[]; pid: string; L: LFn;
  editingId: string | null; onEdit: (id: string | null) => void; onRemove: (d: KnowledgeDocumentDTO) => void; onChanged: () => void; emptyText: string;
}) {
  if (docs.length === 0) return <Empty text={emptyText} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {docs.map((d) => (
        <DocRow key={d.id} d={d} isManager={isManager} folders={folders} pid={pid} L={L}
          editing={editingId === d.id} onEdit={() => onEdit(editingId === d.id ? null : d.id)}
          onRemove={() => onRemove(d)} onChanged={onChanged} />
      ))}
    </div>
  );
}

function DocRow({ d, isManager, folders, pid, L, editing, onEdit, onRemove, onChanged }: {
  d: KnowledgeDocumentDTO; isManager: boolean; folders: KnowledgeFolderDTO[]; pid: string; L: LFn;
  editing: boolean; onEdit: () => void; onRemove: () => void; onChanged: () => void;
}) {
  const b = statusBadge(d.extractionStatus, L);
  const Icon = b ? (b.tone === 'good' ? Search : b.tone === 'warn' ? AlertTriangle : Loader2) : null;
  return (
    <div style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: editing ? 12 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <FileText size={16} color="var(--snow-ink3)" style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--snow-ink3)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{prettyType(d.mimeType)}</span>
            {d.sizeBytes != null && <span>· {prettySize(d.sizeBytes)}</span>}
            {b && Icon && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: b.color, fontWeight: 600 }}>
                <Icon size={11} className={b.tone === 'muted' && (d.extractionStatus === 'pending' || d.extractionStatus === 'processing') ? 'spin' : undefined} /> {b.label}
              </span>
            )}
            {d.visibility === 'managers' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--snow-ink3)', fontWeight: 600 }}><Lock size={11} /> {L(VIS_LABEL.managers.en, VIS_LABEL.managers.es)}</span>}
            {d.visibility === 'dept' && d.visibleDept && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--snow-sage-deep)', fontWeight: 600 }}><Users size={11} /> {L(DEPT_LABEL[d.visibleDept].en, DEPT_LABEL[d.visibleDept].es)}</span>}
          </div>
        </div>
        {d.downloadUrl && (
          <a href={d.downloadUrl} target="_blank" rel="noopener noreferrer" title={L('Download', 'Descargar')} style={{ ...iconBtn, textDecoration: 'none' }}><Download size={15} /></a>
        )}
        {isManager && <button onClick={onEdit} title={L('Access & folder', 'Acceso y carpeta')} style={{ ...iconBtn, color: editing ? 'var(--snow-sage-deep)' : 'var(--snow-ink2)' }}><Pencil size={15} /></button>}
        {isManager && <button onClick={onRemove} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={15} /></button>}
      </div>
      {isManager && editing && <DocEditor d={d} folders={folders} pid={pid} L={L} onDone={onChanged} onCancel={onEdit} />}
    </div>
  );
}

function DocEditor({ d, folders, pid, L, onDone, onCancel }: {
  d: KnowledgeDocumentDTO; folders: KnowledgeFolderDTO[]; pid: string; L: LFn; onDone: () => void; onCancel: () => void;
}) {
  const [access, setAccess] = React.useState<AccessVal>(docAccessVal(d));
  const [folderId, setFolderId] = React.useState<string | null>(d.folderId);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = access !== docAccessVal(d) || folderId !== d.folderId;
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (access !== docAccessVal(d)) {
        const a = accessToPayload(access);
        const r = await apiPatch('/api/knowledge/documents', { pid, id: d.id, action: 'access', visibility: a.visibility, visibleDept: a.visibleDept });
        if (!r.ok) { setError(r.error || L('Could not update access.', 'No se pudo actualizar el acceso.')); return; }
      }
      if (folderId !== d.folderId) {
        const r = await apiPatch('/api/knowledge/documents', { pid, id: d.id, action: 'move', folderId });
        if (!r.ok) { setError(r.error || L('Could not move the document.', 'No se pudo mover el documento.')); return; }
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--snow-rule)', paddingTop: 12, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div>
        <label style={labelStyle}>{L('Who can see it', 'Quién puede verlo')}</label>
        <AccessSelect value={access} onChange={setAccess} L={L} title={L('Who can see it', 'Quién puede verlo')} />
      </div>
      <div>
        <label style={labelStyle}>{L('Folder', 'Carpeta')}</label>
        <FolderSelect value={folderId} onChange={setFolderId} folders={folders} L={L} title={L('Folder', 'Carpeta')} />
      </div>
      <button onClick={() => void save()} disabled={busy || !dirty} style={{ ...primaryBtn, opacity: busy || !dirty ? 0.5 : 1 }}>{busy ? <Loader2 size={14} className="spin" /> : null} {L('Save', 'Guardar')}</button>
      <button onClick={onCancel} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
      {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5, width: '100%' }}>{error}</div>}
    </div>
  );
}

function AccessSelect({ value, onChange, L, title }: { value: AccessVal; onChange: (v: AccessVal) => void; L: LFn; title: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as AccessVal)} title={title} style={{ ...ghostBtn, cursor: 'pointer', padding: '7px 10px' }}>
      {ACCESS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{L(o.en, o.es)}</option>)}
    </select>
  );
}

function FolderSelect({ value, onChange, folders, L, title }: { value: string | null; onChange: (v: string | null) => void; folders: KnowledgeFolderDTO[]; L: LFn; title: string }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} title={title} style={{ ...ghostBtn, cursor: 'pointer', padding: '7px 10px' }}>
      <option value="">{L('No folder', 'Sin carpeta')}</option>
      {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
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
