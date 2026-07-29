'use client';

// ═══════════════════════════════════════════════════════════════════════════
// SOPs and Documents, on the Knows tab's told half.
//
// Ported from communications/_components/KnowledgePane.tsx. Same routes
// (/api/knowledge/articles, /documents, /documents/presign, /folders), same
// capabilities, same private bucket — only the surface changed.
//
// WHAT MUST NOT BE LOST HERE, because nothing else in the app does it:
//   • Per-document ACCESS is a permission control (Everyone / one department /
//     managers only), not a label.
//   • Folders, and moving a document between them.
//   • The extraction badge. If a scanned PDF never became text, THIS IS THE
//     ONLY PLACE a manager finds out — everywhere else the copilot simply
//     answers worse. "Couldn’t read" is a real state and it stays visible.
//
// Uploading is the only way a human puts anything into the copilot's document
// corpus (search_knowledge is told to always consult it), so the three-step
// flow lives in told-knowledge.ts where a test can drive it end to end.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import type { EnvelopeResult } from '@/lib/api-envelope';
import type {
  KnowledgeArticleDTO, KnowledgeDocumentDTO, KnowledgeFolderDTO, KnowledgeVisibility,
} from '@/lib/knowledge/types';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import { toldGet, toldPost, toldPatch, toldDelete, putSigned } from './told-api';
import {
  ACCESS_OPTIONS, DEPT_LABEL, MANAGERS_ONLY_LABEL, UPLOAD_ACCEPT, UPLOAD_FAILURE_COPY,
  accessToPayload, anyExtractionInFlight, docAccessVal, extractionBadge, fileCountLabel, prettySize,
  prettyType, say, uploadDocument,
  type AccessVal, type Bilingual, type Lang,
} from './told-knowledge';

const S = {
  sopsTitle: { en: 'How we do things', es: 'Cómo hacemos las cosas' },
  sopsSub: {
    en: 'The written procedures for this hotel. Staxis answers from these.',
    es: 'Los procedimientos escritos de este hotel. Staxis responde con ellos.',
  },
  docsTitle: { en: 'Documents', es: 'Documentos' },
  docsSub: {
    en: 'Files you have given Staxis to read. It searches the full text of each one.',
    es: 'Archivos que le diste a Staxis para leer. Busca en el texto completo de cada uno.',
  },
  newSop: { en: 'Add a procedure', es: 'Agregar procedimiento' },
  editSop: { en: 'Edit procedure', es: 'Editar procedimiento' },
  upload: { en: 'Upload a file', es: 'Subir archivo' },
  uploading: { en: 'Uploading…', es: 'Subiendo…' },
  newFolder: { en: 'New folder', es: 'Nueva carpeta' },
  create: { en: 'Create', es: 'Crear' },
  rename: { en: 'Rename', es: 'Renombrar' },
  folderName: { en: 'Folder name', es: 'Nombre de la carpeta' },
  allDocs: { en: 'All documents', es: 'Todos los documentos' },
  notInFolder: { en: 'Not in a folder', es: 'Sin carpeta' },
  noFolder: { en: 'No folder', es: 'Sin carpeta' },
  folder: { en: 'Folder', es: 'Carpeta' },
  whoSees: { en: 'Who can see it', es: 'Quién puede verlo' },
  access: { en: 'Access & folder', es: 'Acceso y carpeta' },
  download: { en: 'Download', es: 'Descargar' },
  back: { en: 'Back', es: 'Atrás' },
  edit: { en: 'Edit', es: 'Editar' },
  remove: { en: 'Delete', es: 'Eliminar' },
  save: { en: 'Save', es: 'Guardar' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  loading: { en: 'Loading…', es: 'Cargando…' },
  dismiss: { en: 'Dismiss', es: 'Cerrar' },
  retry: { en: 'Try again', es: 'Reintentar' },
  uploadHint: {
    en: 'PDF, Word, Text, Markdown, CSV, and photos (JPG, PNG, WebP) up to 10 MB. Staxis reads the full text, including scanned PDFs and photos, which it transcribes with AI. That takes a moment; the file says “Reading scan…” until it is ready.',
    es: 'PDF, Word, Texto, Markdown, CSV y fotos (JPG, PNG, WebP) hasta 10 MB. Staxis lee el texto completo, incluidos los PDF escaneados y las fotos, que transcribe con IA. Tarda un momento; el archivo dice “Leyendo el escaneo…” hasta que esté listo.',
  },
  sopsEmpty: {
    en: 'No procedures yet. Write down the first how-to so the team and Staxis can find it.',
    es: 'Aún no hay procedimientos. Escribe el primero para que el equipo y Staxis lo encuentren.',
  },
  sopsEmptyStaff: { en: 'No procedures have been published yet.', es: 'Aún no hay procedimientos publicados.' },
  docsEmpty: { en: 'No documents yet.', es: 'Aún no hay documentos.' },
  docsEmptyFolder: { en: 'No documents in this folder yet.', es: 'Aún no hay documentos en esta carpeta.' },
  sopsLoadFailed: {
    en: 'The procedures could not load. Do not read this as "there are none". Check your connection and try again.',
    es: 'No se pudieron cargar los procedimientos. No lo tomes como "no hay": revisa tu conexión e inténtalo de nuevo.',
  },
  sopsRefreshFailed: {
    en: 'The procedures could not refresh. Showing the last results.',
    es: 'No se pudieron actualizar los procedimientos. Se muestran los últimos resultados.',
  },
  docsLoadFailed: {
    en: 'The documents could not load. Do not read this as "there are none". Check your connection and try again.',
    es: 'No se pudieron cargar los documentos. No lo tomes como "no hay": revisa tu conexión e inténtalo de nuevo.',
  },
  docsRefreshFailed: {
    en: 'The documents could not refresh. Showing the last results.',
    es: 'No se pudieron actualizar los documentos. Se muestran los últimos resultados.',
  },
  docsUnavailable: { en: 'Documents could not load.', es: 'No se pudieron cargar los documentos.' },
  foldersUnavailable: { en: 'Folders could not load.', es: 'No se pudieron cargar las carpetas.' },
  sopDeleteFailed: { en: 'The procedure was not deleted. Try again.', es: 'No se eliminó el procedimiento. Inténtalo de nuevo.' },
  docDeleteFailed: { en: 'The document was not deleted. Try again.', es: 'No se eliminó el documento. Inténtalo de nuevo.' },
  folderCreateFailed: { en: 'Could not create the folder.', es: 'No se pudo crear la carpeta.' },
  folderRenameFailed: { en: 'The folder was not renamed.', es: 'No se cambió el nombre de la carpeta.' },
  folderDeleteFailed: { en: 'The folder was not deleted.', es: 'No se eliminó la carpeta.' },
  accessFailed: { en: 'Could not update who can see it.', es: 'No se pudo actualizar quién puede verlo.' },
  moveFailed: { en: 'Could not move the document.', es: 'No se pudo mover el documento.' },
  saveFailed: { en: 'Could not save. Try again.', es: 'No se pudo guardar. Inténtalo de nuevo.' },
  confirmDeleteSop: { en: 'Delete this procedure?', es: '¿Eliminar este procedimiento?' },
  confirmDeleteDoc: { en: 'Delete this document?', es: '¿Eliminar este documento?' },
  confirmDeleteFolder: {
    en: 'Delete this folder? The files inside are kept. They just move out of the folder.',
    es: '¿Eliminar esta carpeta? Los archivos se conservan. Solo salen de la carpeta.',
  },
  fTitle: { en: 'Title', es: 'Título' },
  fTitlePh: { en: 'e.g. Breakfast bar setup', es: 'ej. Montaje del desayuno' },
  fCategory: { en: 'Category (optional)', es: 'Categoría (opcional)' },
  fCategoryPh: { en: 'e.g. Front desk, Breakfast, Safety', es: 'ej. Recepción, Desayuno, Seguridad' },
  fBody: { en: 'Steps / content', es: 'Pasos / contenido' },
  fBodyPh: { en: 'Write the procedure here.', es: 'Escribe el procedimiento aquí.' },
  visAll: { en: 'All staff', es: 'Todo el personal' },
  visManagers: { en: 'Managers only', es: 'Solo gerentes' },
  emptyBody: { en: '(No content yet.)', es: '(Sin contenido aún.)' },
  lastUpdated: { en: 'Last updated by', es: 'Última actualización por' },
} as const satisfies Record<string, Bilingual>;

// ════════════════════════════════ SOPs ══════════════════════════════════════

export function ToldSops({ pid, canEdit, lang }: { pid: string; canEdit: boolean; lang: Lang }) {
  const L = (k: keyof typeof S) => say(S[k], lang);
  const [selected, setSelected] = React.useState<KnowledgeArticleDTO | null>(null);
  const [editing, setEditing] = React.useState<null | 'new' | KnowledgeArticleDTO>(null);
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  const { data, loading, error: loadError, reload } = useApiResource<{ articles: KnowledgeArticleDTO[] }>(
    `/api/knowledge/articles?pid=${encodeURIComponent(pid)}`,
    { keepDataOnError: true },
  );
  const items = data?.articles ?? null;

  const remove = async (a: KnowledgeArticleDTO) => {
    if (!window.confirm(`${L('confirmDeleteSop')}\n\n${a.title}`)) return;
    setMutationError(null);
    const r = await toldDelete(
      `/api/knowledge/articles?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(a.id)}`,
    );
    if (r.error !== undefined) { setMutationError(L('sopDeleteFailed')); return; }
    setSelected(null);
    await reload();
  };

  if (editing) {
    return (
      <SopEditor pid={pid} lang={lang} article={editing === 'new' ? null : editing}
        onDone={async () => {
          // Drop the detail card too: it holds the PRE-edit object, so
          // returning to it after a save showed the old text as though the
          // save had not happened.
          setEditing(null); setSelected(null); await reload();
        }} onCancel={() => setEditing(null)} />
    );
  }

  if (selected) {
    return (
      <div>
        <button type="button" className="td-act" onClick={() => setSelected(null)}>{L('back')}</button>
        {mutationError && (
          <div className="td-note td-bad" role="alert">
            <span>{mutationError}</span>
            <button type="button" className="td-act" onClick={() => setMutationError(null)}>{L('dismiss')}</button>
          </div>
        )}
        <div className="td-panel">
          <div className="td-head">
            <div>
              <div className="td-h2">{selected.title}</div>
              <div className="td-chips">
                {selected.category && <span className="td-chip">{selected.category}</span>}
                {selected.visibility === 'managers' && (
                  <span className="td-chip td-lock">{say(MANAGERS_ONLY_LABEL, lang)}</span>
                )}
              </div>
            </div>
            {canEdit && (
              <div className="td-cardacts">
                <button type="button" className="td-act" onClick={() => setEditing(selected)}>{L('edit')}</button>
                <button type="button" className="td-act td-danger" onClick={() => void remove(selected)}>{L('remove')}</button>
              </div>
            )}
          </div>
          <div className="td-body">{selected.body || L('emptyBody')}</div>
          {(selected.updatedByName || selected.createdByName) && (
            <div className="td-prov">
              {L('lastUpdated')} {selected.updatedByName || selected.createdByName} ·{' '}
              {new Date(selected.updatedAt).toLocaleDateString()}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="td-head">
        <div>
          <div className="td-h2">{L('sopsTitle')}</div>
          <div className="td-sub">{L('sopsSub')}</div>
        </div>
        {canEdit && (
          <button type="button" className="td-act td-yes" onClick={() => setEditing('new')}>{L('newSop')}</button>
        )}
      </div>

      {mutationError && (
        <div className="td-note td-bad" role="alert">
          <span>{mutationError}</span>
          <button type="button" className="td-act" onClick={() => setMutationError(null)}>{L('dismiss')}</button>
        </div>
      )}
      {loadError && (
        <div className="td-note td-bad" role="alert">
          <span>{data ? L('sopsRefreshFailed') : L('sopsLoadFailed')}</span>
          <button type="button" className="td-act" onClick={() => void reload()}>{L('retry')}</button>
        </div>
      )}

      {loading && !data ? (
        <div className="td-muted">{L('loading')}</div>
      ) : items && items.length === 0 ? (
        <div className="td-empty">{canEdit ? L('sopsEmpty') : L('sopsEmptyStaff')}</div>
      ) : items ? (
        <div className="td-cards">
          {items.map((a) => (
            <button key={a.id} type="button" className="td-card td-clickable" onClick={() => setSelected(a)}>
              <div className="td-cardmain">
                <div className="td-cname">{a.title}</div>
                {a.body && <div className="td-cmeta td-clip">{a.body.replace(/\s+/g, ' ').slice(0, 120)}</div>}
              </div>
              <div className="td-chips">
                {a.visibility === 'managers' && <span className="td-chip td-lock">{say(MANAGERS_ONLY_LABEL, lang)}</span>}
                {a.category && <span className="td-chip">{a.category}</span>}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SopEditor({ pid, article, lang, onDone, onCancel }: {
  pid: string; article: KnowledgeArticleDTO | null; lang: Lang; onDone: () => void; onCancel: () => void;
}) {
  const L = (k: keyof typeof S) => say(S[k], lang);
  const [title, setTitle] = React.useState(article?.title ?? '');
  const [category, setCategory] = React.useState(article?.category ?? '');
  const [body, setBody] = React.useState(article?.body ?? '');
  const [visibility, setVisibility] = React.useState<KnowledgeVisibility>(article?.visibility ?? 'all_staff');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const payload = { pid, title: title.trim(), body, category: category.trim() || null, visibility };
      const r = article
        ? await toldPatch('/api/knowledge/articles', { ...payload, id: article.id })
        : await toldPost('/api/knowledge/articles', payload);
      if (r.error === undefined) onDone();
      else setError(r.error || L('saveFailed'));
    } finally {
      // See ContactEditor.save — the envelope helpers rethrow
      // SessionEndedError, and a stuck-disabled Save button is the symptom.
      setBusy(false);
    }
  };

  return (
    <div>
      <button type="button" className="td-act" onClick={onCancel}>{L('cancel')}</button>
      <div className="td-panel">
        <div className="td-h2">{article ? L('editSop') : L('newSop')}</div>

        <label className="td-lab" htmlFor="td-s-title">{L('fTitle')}</label>
        <input id="td-s-title" className="td-in" value={title} autoFocus placeholder={L('fTitlePh')}
          maxLength={KNOWLEDGE_LIMITS.TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />

        <div className="td-row">
          <div className="td-col">
            <label className="td-lab" htmlFor="td-s-cat">{L('fCategory')}</label>
            <input id="td-s-cat" className="td-in" value={category} placeholder={L('fCategoryPh')}
              maxLength={KNOWLEDGE_LIMITS.CATEGORY_MAX} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div className="td-col">
            <label className="td-lab" htmlFor="td-s-vis">{L('whoSees')}</label>
            <select id="td-s-vis" className="td-in" value={visibility}
              onChange={(e) => setVisibility(e.target.value as KnowledgeVisibility)}>
              <option value="all_staff">{L('visAll')}</option>
              <option value="managers">{L('visManagers')}</option>
            </select>
          </div>
        </div>

        <label className="td-lab" htmlFor="td-s-body">{L('fBody')}</label>
        <textarea id="td-s-body" className="td-in td-ta td-tall" value={body} rows={12} placeholder={L('fBodyPh')}
          maxLength={KNOWLEDGE_LIMITS.BODY_MAX} onChange={(e) => setBody(e.target.value)} />

        {error && <div className="td-note td-bad" role="alert">{error}</div>}

        <div className="td-acts">
          <button type="button" className="td-act td-yes" disabled={busy || !title.trim()}
            onClick={() => void save()}>{L('save')}</button>
          <button type="button" className="td-act" onClick={onCancel}>{L('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════ Documents ═══════════════════════════════════

interface DocsData { documents: KnowledgeDocumentDTO[]; folders: KnowledgeFolderDTO[] }

export function ToldDocuments({ pid, canEdit, lang }: { pid: string; canEdit: boolean; lang: Lang }) {
  const L = (k: keyof typeof S) => say(S[k], lang);
  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploadAccess, setUploadAccess] = React.useState<AccessVal>('all_staff');
  const [uploadFolderId, setUploadFolderId] = React.useState<string | null>(null);
  const [addingFolder, setAddingFolder] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState('');
  const [editingDocId, setEditingDocId] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  // Documents and folders are ONE display contract. If either read fails the
  // failure is surfaced — a partial result must never be presented as a
  // genuinely empty cabinet.
  const fetchDocs = React.useCallback(async (): Promise<EnvelopeResult<DocsData>> => {
    const [docsR, foldersR] = await Promise.all([
      toldGet<{ documents: KnowledgeDocumentDTO[] }>(`/api/knowledge/documents?pid=${encodeURIComponent(pid)}`),
      toldGet<{ folders: KnowledgeFolderDTO[] }>(`/api/knowledge/folders?pid=${encodeURIComponent(pid)}`),
    ]);
    if (docsR.error !== undefined || !docsR.data) return { error: docsR.error ?? say(S.docsUnavailable, lang) };
    if (foldersR.error !== undefined || !foldersR.data) return { error: foldersR.error ?? say(S.foldersUnavailable, lang) };
    return { data: { documents: docsR.data.documents, folders: foldersR.data.folders } };
  }, [pid, lang]);

  const { data, loading, error: loadError, reload } = useApiResource<DocsData>(fetchDocs, { keepDataOnError: true });
  const items = data ? data.documents : null;
  const folders = data?.folders ?? [];

  // Keep refreshing while anything is still being read, so "Reading scan…"
  // flips to "Searchable by AI" without a manual reload. A one-shot timeout
  // chain rather than pollMs: it must fire even in a backgrounded tab.
  // `tick` is what keeps the chain alive. Under keepDataOnError a FAILED
  // refresh hands back the previous data by reference, so `items` keeps its
  // identity, the effect never re-runs, and the chain dies silently on the
  // first blip — leaving "Reading scan…" on screen forever even though the
  // text was extracted. Bumping a counter after every attempt re-arms it.
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!items || !anyExtractionInFlight(items)) return;
    const t = setTimeout(() => { void reload().finally(() => setTick((n) => n + 1)); }, 4000);
    return () => clearTimeout(t);
  }, [items, reload, tick]);

  const targetFolderId = currentFolderId ?? uploadFolderId;

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy(true);
    const result = await uploadDocument(
      {
        presign: (body) => toldPost('/api/knowledge/documents/presign', body),
        put: (signedUrl, contentType) => putSigned(signedUrl, file, contentType),
        register: (body) => toldPost('/api/knowledge/documents', body),
      },
      { pid, file, access: uploadAccess, folderId: targetFolderId },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.serverError || say(UPLOAD_FAILURE_COPY[result.reason], lang));
      return;
    }
    await reload();
  };

  const removeDoc = async (d: KnowledgeDocumentDTO) => {
    if (!window.confirm(`${L('confirmDeleteDoc')}\n\n${d.title}`)) return;
    setError(null);
    const r = await toldDelete(
      `/api/knowledge/documents?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(d.id)}`,
    );
    if (r.error !== undefined) { setError(r.error || L('docDeleteFailed')); return; }
    await reload();
  };

  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setError(null);
    const r = await toldPost('/api/knowledge/folders', { pid, name });
    if (r.error !== undefined) { setError(r.error || L('folderCreateFailed')); return; }
    setNewFolderName(''); setAddingFolder(false);
    await reload();
  };

  const renameFolder = async (f: KnowledgeFolderDTO) => {
    const name = window.prompt(L('rename'), f.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === f.name) return;
    setError(null);
    const r = await toldPatch('/api/knowledge/folders', { pid, id: f.id, name: trimmed });
    if (r.error !== undefined) { setError(r.error || L('folderRenameFailed')); return; }
    await reload();
  };

  const removeFolder = async (f: KnowledgeFolderDTO) => {
    if (!window.confirm(L('confirmDeleteFolder'))) return;
    setError(null);
    const r = await toldDelete(
      `/api/knowledge/folders?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(f.id)}`,
    );
    if (r.error !== undefined) { setError(r.error || L('folderDeleteFailed')); return; }
    if (currentFolderId === f.id) setCurrentFolderId(null);
    // The picker would fall back to displaying "No folder" while this state
    // still held the dead id, and the next upload would be filed into a
    // folder the user was just told it was not going into.
    if (uploadFolderId === f.id) setUploadFolderId(null);
    await reload();
  };

  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const folderCount = (fid: string) => (items ?? []).filter((d) => d.folderId === fid).length;
  const visibleDocs = (items ?? []).filter((d) =>
    currentFolderId ? d.folderId === currentFolderId : d.folderId === null,
  );

  const uploadControls = canEdit ? (
    <div className="td-uploadbar">
      <AccessSelect value={uploadAccess} onChange={setUploadAccess} lang={lang} label={L('whoSees')} />
      {currentFolderId === null && folders.length > 0 && (
        <FolderSelect value={uploadFolderId} onChange={setUploadFolderId} folders={folders} lang={lang} label={L('folder')} />
      )}
      <input ref={fileRef} type="file" accept={UPLOAD_ACCEPT} style={{ display: 'none' }}
        onChange={(e) => void onPick(e)} />
      <button type="button" className="td-act td-yes" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? L('uploading') : L('upload')}
      </button>
    </div>
  ) : null;

  const docList = (emptyText: string) => (
    <DocList docs={visibleDocs} canEdit={canEdit} folders={folders} pid={pid} lang={lang}
      editingId={editingDocId} onEdit={(id) => setEditingDocId(id)} onRemove={removeDoc}
      onChanged={async () => { setEditingDocId(null); await reload(); }} emptyText={emptyText} />
  );

  const errorNotes = (
    <>
      {error && (
        <div className="td-note td-bad" role="alert">
          <span>{error}</span>
          <button type="button" className="td-act" onClick={() => setError(null)}>{L('dismiss')}</button>
        </div>
      )}
      {loadError && (
        <div className="td-note td-bad" role="alert">
          <span>{data ? L('docsRefreshFailed') : L('docsLoadFailed')}</span>
          <button type="button" className="td-act" onClick={() => void reload()}>{L('retry')}</button>
        </div>
      )}
    </>
  );

  // ── Inside one folder ────────────────────────────────────────────────────
  if (currentFolderId !== null) {
    return (
      <div>
        <button type="button" className="td-act"
          onClick={() => { setCurrentFolderId(null); setEditingDocId(null); }}>{L('allDocs')}</button>
        <div className="td-head">
          <div className="td-h2">{currentFolder?.name ?? L('folder')}</div>
          {uploadControls}
        </div>
        {errorNotes}
        {loading && !data ? <div className="td-muted">{L('loading')}</div>
          : data ? docList(L('docsEmptyFolder')) : null}
      </div>
    );
  }

  // ── Root: folders, then the unfiled documents ────────────────────────────
  return (
    <div>
      <div className="td-head">
        <div>
          <div className="td-h2">{L('docsTitle')}</div>
          <div className="td-sub">{L('docsSub')}</div>
        </div>
        {canEdit && (
          <div className="td-uploadbar">
            {uploadControls}
            <button type="button" className="td-act" onClick={() => setAddingFolder((v) => !v)}>{L('newFolder')}</button>
          </div>
        )}
      </div>

      {errorNotes}
      {canEdit && <div className="td-hint">{L('uploadHint')}</div>}

      {addingFolder && canEdit && (
        <div className="td-panel td-inline">
          <input className="td-in" value={newFolderName} autoFocus placeholder={L('folderName')}
            maxLength={KNOWLEDGE_LIMITS.FOLDER_NAME_MAX}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addFolder(); }} />
          <button type="button" className="td-act td-yes" disabled={!newFolderName.trim()}
            onClick={() => void addFolder()}>{L('create')}</button>
          <button type="button" className="td-act"
            onClick={() => { setAddingFolder(false); setNewFolderName(''); }}>{L('cancel')}</button>
        </div>
      )}

      {loading && !data ? (
        <div className="td-muted">{L('loading')}</div>
      ) : data && folders.length === 0 && visibleDocs.length === 0 ? (
        <div className="td-empty">{L('docsEmpty')}</div>
      ) : data ? (
        <div className="td-groups">
          {folders.length > 0 && (
            <div className="td-cards">
              {folders.map((f) => (
                <div key={f.id} className="td-card">
                  <button type="button" className="td-foldbtn"
                    onClick={() => { setCurrentFolderId(f.id); setEditingDocId(null); }}>
                    <span className="td-cname">{f.name}</span>
                    <span className="td-cmeta">· {say(fileCountLabel(folderCount(f.id)), lang)}</span>
                  </button>
                  {canEdit && (
                    <div className="td-cardacts">
                      <button type="button" className="td-act" onClick={() => void renameFolder(f)}>{L('rename')}</button>
                      <button type="button" className="td-act td-danger" onClick={() => void removeFolder(f)}>{L('remove')}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {visibleDocs.length > 0 && (
            <div>
              {folders.length > 0 && <div className="td-grpl">{L('notInFolder')}</div>}
              {docList(L('docsEmpty'))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Document list / row / access editor ─────────────────────────────────────

function DocList({ docs, canEdit, folders, pid, lang, editingId, onEdit, onRemove, onChanged, emptyText }: {
  docs: KnowledgeDocumentDTO[]; canEdit: boolean; folders: KnowledgeFolderDTO[]; pid: string; lang: Lang;
  editingId: string | null; onEdit: (id: string | null) => void;
  onRemove: (d: KnowledgeDocumentDTO) => void; onChanged: () => void; emptyText: string;
}) {
  if (docs.length === 0) return <div className="td-empty">{emptyText}</div>;
  return (
    <div className="td-cards">
      {docs.map((d) => (
        <DocRow key={d.id} d={d} canEdit={canEdit} folders={folders} pid={pid} lang={lang}
          editing={editingId === d.id} onEdit={() => onEdit(editingId === d.id ? null : d.id)}
          onRemove={() => onRemove(d)} onChanged={onChanged} />
      ))}
    </div>
  );
}

function DocRow({ d, canEdit, folders, pid, lang, editing, onEdit, onRemove, onChanged }: {
  d: KnowledgeDocumentDTO; canEdit: boolean; folders: KnowledgeFolderDTO[]; pid: string; lang: Lang;
  editing: boolean; onEdit: () => void; onRemove: () => void; onChanged: () => void;
}) {
  const L = (k: keyof typeof S) => say(S[k], lang);
  const badge = extractionBadge(d.extractionStatus);

  return (
    <div className="td-card td-col-card">
      <div className="td-cardrow">
        <div className="td-cardmain">
          <div className="td-cname">{d.title}</div>
          <div className="td-cmeta td-metarow">
            <span>{prettyType(d.mimeType)}</span>
            {d.sizeBytes != null && <span>· {prettySize(d.sizeBytes)}</span>}
            {badge && (
              <span className={`td-bdg td-${badge.tone}${badge.spinning ? ' td-working' : ''}`}>
                {say(badge.label, lang)}
              </span>
            )}
            {d.visibility === 'managers' && (
              <span className="td-bdg td-muted-b">{say(MANAGERS_ONLY_LABEL, lang)}</span>
            )}
            {d.visibility === 'dept' && d.visibleDept && (
              <span className="td-bdg td-dept">{say(DEPT_LABEL[d.visibleDept], lang)}</span>
            )}
          </div>
        </div>
        <div className="td-cardacts">
          {d.downloadUrl && (
            <a className="td-act" href={d.downloadUrl} target="_blank" rel="noopener noreferrer">{L('download')}</a>
          )}
          {canEdit && <button type="button" className="td-act" onClick={onEdit}>{L('access')}</button>}
          {canEdit && <button type="button" className="td-act td-danger" onClick={onRemove}>{L('remove')}</button>}
        </div>
      </div>
      {canEdit && editing && (
        <DocEditor d={d} folders={folders} pid={pid} lang={lang} onDone={onChanged} onCancel={onEdit} />
      )}
    </div>
  );
}

function DocEditor({ d, folders, pid, lang, onDone, onCancel }: {
  d: KnowledgeDocumentDTO; folders: KnowledgeFolderDTO[]; pid: string; lang: Lang;
  onDone: () => void; onCancel: () => void;
}) {
  const L = (k: keyof typeof S) => say(S[k], lang);
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
        const r = await toldPatch('/api/knowledge/documents', {
          pid, id: d.id, action: 'access', visibility: a.visibility, visibleDept: a.visibleDept,
        });
        if (r.error !== undefined) { setError(r.error || L('accessFailed')); return; }
      }
      if (folderId !== d.folderId) {
        const r = await toldPatch('/api/knowledge/documents', { pid, id: d.id, action: 'move', folderId });
        if (r.error !== undefined) { setError(r.error || L('moveFailed')); return; }
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="td-docedit">
      <div className="td-col">
        <label className="td-lab">{L('whoSees')}</label>
        <AccessSelect value={access} onChange={setAccess} lang={lang} label={L('whoSees')} />
      </div>
      <div className="td-col">
        <label className="td-lab">{L('folder')}</label>
        <FolderSelect value={folderId} onChange={setFolderId} folders={folders} lang={lang} label={L('folder')} />
      </div>
      <button type="button" className="td-act td-yes" disabled={busy || !dirty} onClick={() => void save()}>{L('save')}</button>
      <button type="button" className="td-act" onClick={onCancel}>{L('cancel')}</button>
      {error && <div className="td-note td-bad" role="alert">{error}</div>}
    </div>
  );
}

function AccessSelect({ value, onChange, lang, label }: {
  value: AccessVal; onChange: (v: AccessVal) => void; lang: Lang; label: string;
}) {
  return (
    <select className="td-sel" value={value} aria-label={label}
      onChange={(e) => onChange(e.target.value as AccessVal)}>
      {ACCESS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{say(o.label, lang)}</option>)}
    </select>
  );
}

function FolderSelect({ value, onChange, folders, lang, label }: {
  value: string | null; onChange: (v: string | null) => void;
  folders: KnowledgeFolderDTO[]; lang: Lang; label: string;
}) {
  return (
    <select className="td-sel" value={value ?? ''} aria-label={label}
      onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{say(S.noFolder, lang)}</option>
      {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );
}
