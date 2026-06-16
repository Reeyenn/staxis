// ═══════════════════════════════════════════════════════════════════════════
// Knowledge hub — server-side core (service-role, supabaseAdmin only).
//
// Every read/write goes through here from /api/knowledge/* (authenticated via
// commsContext; writes gated on canManageTeam) and from the read-only
// search_knowledge agent tool. RLS is deny-all on the knowledge_* tables; this
// module bypasses it via supabaseAdmin AFTER the route/tool has authenticated
// the caller and scoped to a single property_id. NEVER import this from a
// client component — `import 'server-only'` makes any such import fail the build.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';
import { KNOWLEDGE_LIMITS } from './types';
import type {
  KnowledgeArticleDTO, KnowledgeDocumentDTO, KnowledgeFolderDTO, KnowledgeContactDTO,
  KnowledgeEventDTO, ContactCategory, KnowledgeVisibility, ExtractionStatus, Dept,
} from './types';
import { normalizeDept } from '@/lib/capabilities/dept-scope';
import { getDefaultEmbedder, toVectorLiteral, type Embedder } from './embeddings';
import { meterEmbeddingCost } from './indexing';
import {
  canRoleSeeManagerOnly, sanitizeSearchTerm, makeSnippet, blendChunkHits,
  docVisibilityScope, canReadDocVisibility, type DocVisibilityScope,
  type ChunkHit, type BlendedPassage,
} from './search-helpers';

/** A caller resolved for a READ — role + their own department (from commsContext
 *  or the agent ToolContext). Drives the per-department document gate. */
export interface KnowledgeReader {
  role: AppRole;
  dept: string | null;
}

/**
 * Translate a document visibility scope into PostgREST filter instructions.
 * `scope.dept` is one of the three closed dept enums (never user input), so the
 * value interpolated into the `.or()` string can't widen or break the filter.
 */
function docScopeFilter(scope: DocVisibilityScope): { orFilter?: string; eqAllStaff?: boolean } {
  if (scope.kind === 'all') return {};
  if (scope.kind === 'allStaffOnly') return { eqAllStaff: true };
  return { orFilter: `visibility.eq.all_staff,and(visibility.eq.dept,visible_dept.eq.${scope.dept})` };
}

/** Normalize an access pair to the DB invariant: a non-'dept' tier carries no
 *  department; a 'dept' tier requires a real department (else null → caller error). */
function normalizeAccess(visibility: KnowledgeVisibility, visibleDept: string | null | undefined): { visibility: KnowledgeVisibility; visibleDept: Dept | null } {
  if (visibility !== 'dept') return { visibility, visibleDept: null };
  return { visibility, visibleDept: normalizeDept(visibleDept) };
}

const BUCKET = 'knowledge-docs';
const SIGNED_URL_TTL = 60 * 60; // 1h download URLs

/** The actor performing a write — captured from commsContext at the route. */
export interface KnowledgeActor {
  accountId: string;
  name: string;
}

// ── Upload type resolution ───────────────────────────────────────────────────
// We resolve the stored Content-Type from the file EXTENSION (not the browser's
// reported mime, which is unreliable for .md/.txt). The presign route returns
// this and the client uploads with it, so the PUT's Content-Type always matches
// one of the bucket's allowed_mime_types exactly. Extensions outside this map
// are rejected at presign time.
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Strip C0 control characters (keeping tab/newline/CR) before a DB write.
 * Postgres `text` rejects NUL bytes outright, so a manager POSTing a raw
 * NUL would otherwise turn a clean insert into an uncaught 500. Built with
 * charCodeAt (no regex control-char escapes) on purpose.
 */
function clean(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue; // drop control chars except \t \n \r
    out += s[i];
  }
  return out;
}

// ── Row → DTO mappers ─────────────────────────────────────────────────────────

function toArticleDTO(r: Record<string, unknown>): KnowledgeArticleDTO {
  return {
    id: r.id as string,
    title: (r.title as string) ?? '',
    body: (r.body as string) ?? '',
    category: (r.category as string | null) ?? null,
    visibility: ((r.visibility as KnowledgeVisibility | null) ?? 'all_staff'),
    createdByName: (r.created_by_name as string | null) ?? null,
    updatedByName: (r.updated_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string) ?? (r.created_at as string),
  };
}

function toContactDTO(r: Record<string, unknown>): KnowledgeContactDTO {
  return {
    id: r.id as string,
    name: (r.name as string) ?? '',
    company: (r.company as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    category: (r.category as ContactCategory | null) ?? null,
    address: (r.address as string | null) ?? null,
    cityStateZip: (r.city_state_zip as string | null) ?? null,
    hours: (r.hours as string | null) ?? null,
    localCategory: (r.local_category as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toEventDTO(r: Record<string, unknown>): KnowledgeEventDTO {
  return {
    id: r.id as string,
    title: (r.title as string) ?? '',
    eventDate: r.event_date as string,
    endDate: (r.end_date as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

// ── Articles (SOPs) ────────────────────────────────────────────────────────────

const ARTICLE_COLS = 'id, title, body, category, visibility, created_by_name, updated_by_name, created_at, updated_at';

/**
 * List SOPs visible to `role`. Manager-only SOPs are filtered out for floor
 * staff at the QUERY level (not just hidden in the UI), so a non-manager never
 * receives a manager-only row. Default-open for callers that don't pass a role
 * is deliberately NOT offered — role is required so a missing arg can't leak.
 */
export async function listArticles(pid: string, role: AppRole): Promise<KnowledgeArticleDTO[]> {
  let q = supabaseAdmin
    .from('knowledge_articles')
    .select(ARTICLE_COLS)
    .eq('property_id', pid);
  if (!canRoleSeeManagerOnly(role)) q = q.eq('visibility', 'all_staff');
  const { data, error } = await q.order('updated_at', { ascending: false }).limit(500);
  if (error) log.warn('knowledge.listArticles failed', { err: error.message });
  return ((data ?? []) as Record<string, unknown>[]).map(toArticleDTO);
}

export async function createArticle(
  pid: string,
  input: { title: string; body: string; category: string | null; visibility: KnowledgeVisibility },
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_articles')
    .insert({
      property_id: pid,
      title: clean(input.title),
      body: clean(input.body),
      category: input.category ? clean(input.category) : null,
      visibility: input.visibility,
      created_by: actor.accountId,
      created_by_name: actor.name,
      updated_by: actor.accountId,
      updated_by_name: actor.name,
    })
    .select('id')
    .single();
  if (error) { log.error('knowledge.createArticle failed', { err: error.message }); throw error; }
  return { id: data.id as string };
}

export async function updateArticle(
  pid: string,
  id: string,
  input: { title: string; body: string; category: string | null; visibility: KnowledgeVisibility },
  actor: KnowledgeActor,
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_articles')
    .update({
      title: clean(input.title),
      body: clean(input.body),
      category: input.category ? clean(input.category) : null,
      visibility: input.visibility,
      updated_by: actor.accountId,
      updated_by_name: actor.name,
    })
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  if (!data) return false;
  // SECURITY: flip the existing chunks' denormalized visibility SYNCHRONOUSLY,
  // before returning. The route then schedules a full re-embed via after(), but
  // that runs asynchronously — without this synchronous flip there would be a
  // window where an SOP just tightened to managers-only is still searchable by
  // floor staff through its stale all_staff chunks (Codex review HIGH-1/HIGH-2).
  const { error: visErr } = await supabaseAdmin
    .from('knowledge_chunks')
    .update({ visibility: input.visibility })
    .eq('article_id', id)
    .eq('property_id', pid);
  if (visErr) log.warn('knowledge.updateArticle chunk-visibility sync failed', { err: visErr.message });
  return true;
}

export async function deleteArticle(pid: string, id: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_articles')
    .delete()
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

// ── Documents ──────────────────────────────────────────────────────────────────

const DOC_COLS = 'id, title, file_path, mime_type, size_bytes, extraction_status, visibility, visible_dept, folder_id, uploaded_by_name, created_at';

/**
 * List documents visible to `reader`, each with a short-lived signed download
 * URL. Visibility is enforced at the QUERY level via the shared dept checker
 * (docVisibilityScope): managers see all; other staff see all_staff + their own
 * department; managers-only and other-department docs are never returned — so
 * the signed URL is never minted for a doc the caller can't see. The badge state
 * comes from extraction_status.
 *
 * `opts.folderId`: undefined → all folders; null → unfiled only; a uuid → that folder.
 */
export async function listDocuments(
  pid: string,
  reader: KnowledgeReader,
  opts: { folderId?: string | null } = {},
): Promise<KnowledgeDocumentDTO[]> {
  let q = supabaseAdmin
    .from('knowledge_documents')
    .select(DOC_COLS)
    .eq('property_id', pid);

  const f = docScopeFilter(docVisibilityScope(reader.role, reader.dept));
  if (f.eqAllStaff) q = q.eq('visibility', 'all_staff');
  else if (f.orFilter) q = q.or(f.orFilter);

  if (opts.folderId === null) q = q.is('folder_id', null);
  else if (typeof opts.folderId === 'string') q = q.eq('folder_id', opts.folderId);

  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  if (error) log.warn('knowledge.listDocuments failed', { err: error.message });
  const rows = (data ?? []) as Record<string, unknown>[];
  // Mint a short-lived signed download URL for each VISIBLE file (server-side;
  // the bucket is private). Done in parallel; a failure leaves downloadUrl null.
  return Promise.all(rows.map(async (r): Promise<KnowledgeDocumentDTO> => {
    const path = r.file_path as string;
    let downloadUrl: string | null = null;
    try {
      const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
      downloadUrl = signed?.signedUrl ?? null;
    } catch { /* leave null */ }
    const status = ((r.extraction_status as ExtractionStatus | null) ?? 'pending');
    return {
      id: r.id as string,
      title: (r.title as string) ?? '',
      mimeType: (r.mime_type as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      hasText: status === 'ready' || status === 'partial',
      extractionStatus: status,
      visibility: ((r.visibility as KnowledgeVisibility | null) ?? 'all_staff'),
      visibleDept: ((r.visible_dept as Dept | null) ?? null),
      folderId: ((r.folder_id as string | null) ?? null),
      uploadedByName: (r.uploaded_by_name as string | null) ?? null,
      createdAt: r.created_at as string,
      downloadUrl,
    };
  }));
}

// ── Folders ──────────────────────────────────────────────────────────────────

const FOLDER_COLS = 'id, name, parent_id, created_by_name, created_at';

function toFolderDTO(r: Record<string, unknown>): KnowledgeFolderDTO {
  return {
    id: r.id as string,
    name: (r.name as string) ?? '',
    parentId: (r.parent_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** All folders for a property (folders carry no per-row visibility — the
 *  documents inside them do). */
export async function listFolders(pid: string): Promise<KnowledgeFolderDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_folders')
    .select(FOLDER_COLS)
    .eq('property_id', pid)
    .order('name', { ascending: true })
    .limit(500);
  if (error) log.warn('knowledge.listFolders failed', { err: error.message });
  return ((data ?? []) as Record<string, unknown>[]).map(toFolderDTO);
}

/** Confirm a folder id belongs to this property (defense against cross-tenant
 *  folder ids on register/move/create-nested). */
async function folderBelongsToProperty(pid: string, folderId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_folders')
    .select('id')
    .eq('id', folderId)
    .eq('property_id', pid)
    .maybeSingle();
  return !!data;
}

export async function createFolder(
  pid: string,
  input: { name: string; parentId: string | null },
  actor: KnowledgeActor,
): Promise<{ id: string } | { error: string }> {
  const name = clean(input.name).trim();
  if (!name) return { error: 'Folder name is required.' };
  if (input.parentId && !(await folderBelongsToProperty(pid, input.parentId))) {
    return { error: 'Parent folder not found.' };
  }
  const { data, error } = await supabaseAdmin
    .from('knowledge_folders')
    .insert({
      property_id: pid,
      parent_id: input.parentId,
      name: name.slice(0, KNOWLEDGE_LIMITS.FOLDER_NAME_MAX),
      created_by: actor.accountId,
      created_by_name: actor.name,
    })
    .select('id')
    .single();
  if (error || !data) { log.error('knowledge.createFolder failed', { err: error?.message }); return { error: 'Could not create the folder.' }; }
  return { id: data.id as string };
}

export async function renameFolder(pid: string, id: string, name: string): Promise<boolean> {
  const clean_ = clean(name).trim();
  if (!clean_) return false;
  const { data } = await supabaseAdmin
    .from('knowledge_folders')
    .update({ name: clean_.slice(0, KNOWLEDGE_LIMITS.FOLDER_NAME_MAX) })
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

/** Delete a folder. Its documents are un-filed automatically (knowledge_documents
 *  .folder_id is ON DELETE SET NULL) — the files + embeddings are NEVER deleted.
 *  Descendant folder rows cascade away; their documents un-file too. */
export async function deleteFolder(pid: string, id: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_folders')
    .delete()
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

/**
 * Mint a signed upload URL for a new document. Returns the server-resolved
 * Content-Type (from the file extension) so the client PUTs with a type that
 * matches the bucket's allowed_mime_types. Returns null on an unsupported
 * extension or a storage error.
 */
export async function presignDocument(
  pid: string,
  filename: string,
): Promise<{ path: string; signedUrl: string; token: string; contentType: string } | null> {
  const ext = extOf(filename);
  const contentType = EXT_TO_MIME[ext];
  if (!contentType) return null; // unsupported file type
  const path = `${pid}/knowledge/${crypto.randomUUID()}.${ext}`;
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return null;
    return { path, signedUrl: data.signedUrl, token: data.token, contentType };
  } catch {
    return null;
  }
}

/**
 * Register an uploaded document. CRITICAL tenant-isolation check: the path
 * MUST live under `<pid>/knowledge/` — otherwise a manager of property A could
 * register a row pointing at property B's object. For text/markdown/csv we
 * extract the file's text into extracted_text so the AI can answer from its
 * content; PDF/doc content extraction is a documented fast-follow (the file is
 * still stored + title-searchable).
 */
export async function registerDocument(
  pid: string,
  input: { title: string; path: string; mimeType: string; sizeBytes: number | null; visibility: KnowledgeVisibility; visibleDept: string | null; folderId: string | null },
  actor: KnowledgeActor,
): Promise<{ id: string } | { error: string }> {
  // Enforce the EXACT shape presignDocument mints: <pid>/knowledge/<uuid>.<ext>.
  // A prefix-only check would let a manager register a row pointing at an
  // arbitrary same-property path that never came from the presign flow (Codex
  // review). The UUID + ext shape also subsumes the `..` traversal guard.
  const prefix = `${pid}/knowledge/`;
  const rest = input.path.startsWith(prefix) ? input.path.slice(prefix.length) : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9]{1,12}$/i.test(rest)) {
    return { error: 'document path is not scoped to this property' };
  }
  // Only accept a mime we actually mint at presign time.
  if (!Object.values(EXT_TO_MIME).includes(input.mimeType)) {
    return { error: 'unsupported document type' };
  }
  // Normalize the access pair to the DB invariant; a 'dept' tier needs a real dept.
  const access = normalizeAccess(input.visibility, input.visibleDept);
  if (input.visibility === 'dept' && !access.visibleDept) {
    return { error: 'Pick a department for a department-only document.' };
  }
  // A folder id (if any) must belong to this property.
  if (input.folderId && !(await folderBelongsToProperty(pid, input.folderId))) {
    return { error: 'Folder not found.' };
  }

  // Insert the row as `pending` FIRST (no extraction inline). The upload route
  // schedules indexDocument() via after() so a slow PDF/embedding never blocks
  // the response — the UI shows pending → processing → ready/partial/etc.
  const { data, error } = await supabaseAdmin
    .from('knowledge_documents')
    .insert({
      property_id: pid,
      title: clean(input.title),
      file_path: input.path,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      extracted_text: null,
      extraction_status: 'pending',
      visibility: access.visibility,
      visible_dept: access.visibleDept,
      folder_id: input.folderId,
      uploaded_by: actor.accountId,
      uploaded_by_name: actor.name,
    })
    .select('id')
    .single();
  if (error || !data) {
    log.error('knowledge.registerDocument insert failed', { err: error?.message });
    // Don't orphan the just-uploaded object when the metadata row can't be written.
    try { await supabaseAdmin.storage.from(BUCKET).remove([input.path]); } catch { /* best-effort */ }
    // 23505 = unique_violation (this file_path was already registered).
    return { error: (error as { code?: string } | null)?.code === '23505' ? 'This file was already added.' : 'Could not save the document.' };
  }
  return { id: data.id as string };
}

export async function deleteDocument(pid: string, id: string): Promise<boolean> {
  // Fetch the path first so we can remove the storage object too (best-effort).
  const { data: row } = await supabaseAdmin
    .from('knowledge_documents')
    .select('id, file_path')
    .eq('id', id)
    .eq('property_id', pid)
    .maybeSingle();
  if (!row) return false;
  const { data: del } = await supabaseAdmin
    .from('knowledge_documents')
    .delete()
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  if (!del) return false;
  try { await supabaseAdmin.storage.from(BUCKET).remove([row.file_path as string]); } catch { /* orphaned object is harmless */ }
  return true;
}

/**
 * Change who can see a document (access tier + department). Documents are
 * immutable in content, so this NEVER re-embeds — it only updates the row, then
 * SYNCHRONOUSLY re-flips the denormalized scope on its existing chunks before
 * returning. Without that synchronous flip a doc just tightened to managers-only
 * / a department would still be searchable through its stale all_staff chunks
 * (the exact leak updateArticle() guards against — see HIGH-1/HIGH-2 there).
 */
export async function updateDocumentAccess(
  pid: string,
  id: string,
  input: { visibility: KnowledgeVisibility; visibleDept: string | null },
): Promise<{ ok: boolean } | { error: string }> {
  const access = normalizeAccess(input.visibility, input.visibleDept);
  if (input.visibility === 'dept' && !access.visibleDept) {
    return { error: 'Pick a department for a department-only document.' };
  }
  const { data } = await supabaseAdmin
    .from('knowledge_documents')
    .update({ visibility: access.visibility, visible_dept: access.visibleDept })
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  if (!data) return { ok: false };
  // SECURITY: synchronously mirror the new scope onto this doc's chunks before
  // returning, so AI search can never surface the doc via stale-scoped chunks.
  // Unlike updateArticle, documents NEVER re-embed, so there is no async pass to
  // self-heal a failed flip — a swallowed error here would leak the doc's content
  // through its stale chunks indefinitely. Fail loudly so the route returns
  // non-200 and the manager retries (the doc row is already tightened, and the
  // retry re-runs this idempotent sync). Codex + Claude review HIGH-1.
  const { error: visErr } = await supabaseAdmin
    .from('knowledge_chunks')
    .update({ visibility: access.visibility, visible_dept: access.visibleDept })
    .eq('document_id', id)
    .eq('property_id', pid);
  if (visErr) {
    log.error('knowledge.updateDocumentAccess chunk-scope sync failed', { err: visErr.message });
    return { error: 'Saved who can see it, but search may lag a moment — please try again.' };
  }
  return { ok: true };
}

/** Move a document into a folder (or out to unfiled with folderId=null). Pure
 *  metadata — no chunk/embedding change (folders don't affect visibility). */
export async function moveDocument(pid: string, id: string, folderId: string | null): Promise<{ ok: boolean } | { error: string }> {
  if (folderId && !(await folderBelongsToProperty(pid, folderId))) return { error: 'Folder not found.' };
  const { data } = await supabaseAdmin
    .from('knowledge_documents')
    .update({ folder_id: folderId })
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return { ok: !!data };
}

// ── Contacts ───────────────────────────────────────────────────────────────────

const CONTACT_COLS = 'id, name, company, phone, email, notes, category, address, city_state_zip, hours, local_category, created_by_name, created_at';

export async function listContacts(pid: string): Promise<KnowledgeContactDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_contacts')
    .select(CONTACT_COLS)
    .eq('property_id', pid)
    .order('category', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
    .limit(500);
  if (error) log.warn('knowledge.listContacts failed', { err: error.message });
  return ((data ?? []) as Record<string, unknown>[]).map(toContactDTO);
}

export interface ContactInput {
  name: string; company: string | null; phone: string | null;
  email: string | null; notes: string | null; category: ContactCategory | null;
  address: string | null; cityStateZip: string | null; hours: string | null; localCategory: string | null;
}

export async function createContact(pid: string, input: ContactInput, actor: KnowledgeActor): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_contacts')
    .insert({
      property_id: pid,
      name: clean(input.name), company: input.company ? clean(input.company) : null, phone: input.phone,
      email: input.email, notes: input.notes ? clean(input.notes) : null, category: input.category,
      address: input.address ? clean(input.address) : null,
      city_state_zip: input.cityStateZip ? clean(input.cityStateZip) : null,
      hours: input.hours ? clean(input.hours) : null,
      local_category: input.localCategory,
      created_by: actor.accountId, created_by_name: actor.name,
    })
    .select('id')
    .single();
  if (error) { log.error('knowledge.createContact failed', { err: error.message }); throw error; }
  return { id: data.id as string };
}

export async function updateContact(pid: string, id: string, input: ContactInput): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_contacts')
    .update({
      name: clean(input.name), company: input.company ? clean(input.company) : null, phone: input.phone,
      email: input.email, notes: input.notes ? clean(input.notes) : null, category: input.category,
      address: input.address ? clean(input.address) : null,
      city_state_zip: input.cityStateZip ? clean(input.cityStateZip) : null,
      hours: input.hours ? clean(input.hours) : null,
      local_category: input.localCategory,
    })
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

export async function deleteContact(pid: string, id: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_contacts')
    .delete()
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

// ── Events (calendar) ────────────────────────────────────────────────────────

const EVENT_COLS = 'id, title, event_date, end_date, notes, created_by_name, created_at';

export async function listEvents(pid: string): Promise<KnowledgeEventDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_events')
    .select(EVENT_COLS)
    .eq('property_id', pid)
    .order('event_date', { ascending: true })
    .limit(500);
  if (error) log.warn('knowledge.listEvents failed', { err: error.message });
  return ((data ?? []) as Record<string, unknown>[]).map(toEventDTO);
}

export async function createEvent(
  pid: string,
  input: { title: string; eventDate: string; endDate: string | null; notes: string | null },
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_events')
    .insert({
      property_id: pid,
      title: clean(input.title), event_date: input.eventDate, end_date: input.endDate, notes: input.notes ? clean(input.notes) : null,
      created_by: actor.accountId, created_by_name: actor.name,
    })
    .select('id')
    .single();
  if (error) { log.error('knowledge.createEvent failed', { err: error.message }); throw error; }
  return { id: data.id as string };
}

export async function deleteEvent(pid: string, id: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_events')
    .delete()
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
}

// ── AI search — HYBRID semantic (pgvector) ⊕ keyword (ILIKE) over chunks ──────
//
// Used by the search_knowledge chat tool. The query is embedded and matched by
// cosine similarity against knowledge_chunks (the embedded passages of every
// uploaded document + SOP), BLENDED with a keyword arm for exact terms (part
// numbers, proper names). ALWAYS scoped to a single property_id AND the asker's
// role: manager-only documents/SOPs are invisible to floor staff in BOTH arms
// (the RPC filters in SQL; the keyword arm adds the same visibility predicate).
// Contacts + calendar are shared directory/calendar data (no per-row visibility,
// by design — a contract that must stay private belongs in a managers-only
// document or SOP).

/** A chunk-level answer the assistant should quote/cite. */
export interface KnowledgePassage {
  sourceType: 'document' | 'article';
  sourceId: string;
  title: string;
  section: string | null;
  snippet: string;
  /** Cosine similarity (0..1) when found semantically; null for keyword-only. */
  similarity: number | null;
}

export interface KnowledgeSearchResult {
  query: string;
  /** The relevant passages (chunks) with their document/SOP + section refs. */
  passages: KnowledgePassage[];
  articles: { id: string; title: string; category: string | null; snippet: string }[];
  documents: { id: string; title: string; snippet: string | null; hasText: boolean }[];
  contacts: { id: string; name: string; company: string | null; phone: string | null; email: string | null; category: string | null; address: string | null; cityStateZip: string | null; hours: string | null; localCategory: string | null; notes: string | null }[];
  events: { id: string; title: string; eventDate: string; endDate: string | null; notes: string | null }[];
  note: string;
}

const PASSAGE_SNIPPET_MAX = 600;
const VECTOR_MATCH_COUNT = 12;

/** Merge two row arrays by id, preserving the first array's order. */
function mergeById(primary: Record<string, unknown>[], secondary: Record<string, unknown>[], cap: number): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of [...primary, ...secondary]) {
    const id = r.id as string;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

export interface SearchKnowledgeOpts {
  /** Asker's accounts.id — for metering the query-embedding cost to the
   *  property ledger. Omit to skip metering (e.g. internal callers). */
  accountId?: string;
  /** Asker's own department (staff.department) — gates 'dept'-scoped documents
   *  via the shared checker. Omit/null → all_staff only for non-managers. */
  dept?: string | null;
  /** Inject a fake embedder in tests. */
  embedder?: Embedder;
}

/**
 * Hybrid knowledge search. `role` is REQUIRED — it gates manager-only content.
 */
export async function searchKnowledge(
  pid: string,
  rawQuery: string,
  role: AppRole,
  opts: SearchKnowledgeOpts = {},
): Promise<KnowledgeSearchResult> {
  const term = sanitizeSearchTerm(rawQuery);
  const includeManagerOnly = canRoleSeeManagerOnly(role);
  // Document dept gate (managers → no filter; other staff → all_staff + own dept).
  const docFilter = docScopeFilter(docVisibilityScope(role, opts.dept ?? null));
  const deptNorm = includeManagerOnly ? null : normalizeDept(opts.dept ?? null);
  if (term.length < 2) {
    return {
      query: term, passages: [], articles: [], documents: [], contacts: [], events: [],
      note: 'Search term too short — ask the user to be more specific.',
    };
  }
  const pattern = `%${term}%`;
  const A = 'knowledge_articles', D = 'knowledge_documents', C = 'knowledge_contacts', E = 'knowledge_events';

  // ── Vector arm: embed the query, then cosine-match over chunks via the RPC.
  let vectorHits: ChunkHit[] = [];
  let semantic = false;
  try {
    const embedder = opts.embedder ?? getDefaultEmbedder();
    const res = await embedder.embed([term]);
    if (opts.accountId) {
      await meterEmbeddingCost({ accountId: opts.accountId, propertyId: pid, totalTokens: res.totalTokens, model: res.model });
    }
    const qvec = res.vectors[0];
    if (qvec && qvec.length) {
      const { data, error } = await supabaseAdmin.rpc('staxis_search_knowledge_chunks', {
        p_property_id: pid,
        p_query_embedding: toVectorLiteral(qvec),
        p_include_manager_only: includeManagerOnly,
        p_dept: deptNorm,
        p_match_count: VECTOR_MATCH_COUNT,
      });
      if (error) {
        log.warn('knowledge.searchKnowledge vector RPC failed', { err: error.message });
      } else {
        semantic = true;
        vectorHits = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          id: r.id as string,
          documentId: (r.document_id as string | null) ?? null,
          articleId: (r.article_id as string | null) ?? null,
          sourceType: r.source_type as 'document' | 'article',
          content: (r.content as string) ?? '',
          section: (r.section as string | null) ?? null,
          similarity: typeof r.similarity === 'number' ? r.similarity : Number(r.similarity ?? 0),
        }));
      }
    }
  } catch (e) {
    // Embedding unavailable (no key / network / quota) → keyword-only fallback.
    log.warn('knowledge.searchKnowledge embed failed; keyword-only', { err: e instanceof Error ? e.message : String(e) });
  }

  // ── Keyword arm over chunk content + parent titles/names/notes. All arms
  // apply the same visibility predicate for managers-only content.
  let chunkKw = supabaseAdmin
    .from('knowledge_chunks')
    .select('id, document_id, article_id, source_type, content, section, visibility')
    .eq('property_id', pid)
    .ilike('content', pattern);
  let artTitleQ = supabaseAdmin.from(A).select('id, title, category, body, visibility').eq('property_id', pid).ilike('title', pattern);
  let docTitleQ = supabaseAdmin.from(D).select('id, title, visibility, extraction_status').eq('property_id', pid).ilike('title', pattern);
  // SOPs (articles) stay binary — no 'dept' tier. Documents + their chunks use
  // the 3-tier dept gate. The chunk arm spans both sources: article chunks are
  // all_staff/managers (visible_dept null), so the dept filter keeps their
  // all_staff rows and drops managers-only rows for non-managers, exactly as
  // before; only documents add the extra dept branch.
  if (!includeManagerOnly) artTitleQ = artTitleQ.eq('visibility', 'all_staff');
  if (docFilter.eqAllStaff) {
    chunkKw = chunkKw.eq('visibility', 'all_staff');
    docTitleQ = docTitleQ.eq('visibility', 'all_staff');
  } else if (docFilter.orFilter) {
    chunkKw = chunkKw.or(docFilter.orFilter);
    docTitleQ = docTitleQ.or(docFilter.orFilter);
  }

  // Contacts: select the full directory shape (incl. local address/hours) so the
  // assistant can answer "what's the nearest pharmacy / their address / hours".
  // Four keyword arms — name, company, address, AND local_category — so "nearest
  // pharmacy" matches a Pharmacy-typed local contact ("Walgreens") whose name
  // never contains the word, and "pharmacy on Main St" matches by street too.
  const CONTACT_SELECT = 'id, name, company, phone, email, category, address, city_state_zip, hours, local_category, notes';
  const [chunkKwRes, artTitle, docTitle, conName, conCompany, conAddress, conLocalCat, evtTitle, evtNotes] = await Promise.all([
    chunkKw.limit(8),
    artTitleQ.limit(5),
    docTitleQ.limit(5),
    supabaseAdmin.from(C).select(CONTACT_SELECT).eq('property_id', pid).ilike('name', pattern).limit(5),
    supabaseAdmin.from(C).select(CONTACT_SELECT).eq('property_id', pid).ilike('company', pattern).limit(5),
    supabaseAdmin.from(C).select(CONTACT_SELECT).eq('property_id', pid).ilike('address', pattern).limit(5),
    supabaseAdmin.from(C).select(CONTACT_SELECT).eq('property_id', pid).ilike('local_category', pattern).limit(5),
    supabaseAdmin.from(E).select('id, title, event_date, end_date, notes').eq('property_id', pid).ilike('title', pattern).limit(5),
    supabaseAdmin.from(E).select('id, title, event_date, end_date, notes').eq('property_id', pid).ilike('notes', pattern).limit(5),
  ]);

  const keywordHits: ChunkHit[] = ((chunkKwRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    documentId: (r.document_id as string | null) ?? null,
    articleId: (r.article_id as string | null) ?? null,
    sourceType: r.source_type as 'document' | 'article',
    content: (r.content as string) ?? '',
    section: (r.section as string | null) ?? null,
    similarity: null,
  }));

  // Blend the two arms into ranked passages, then resolve parent titles.
  const blended: BlendedPassage[] = blendChunkHits(vectorHits, keywordHits, { limit: 6 });
  const docIds = [...new Set(blended.filter((b) => b.documentId).map((b) => b.documentId as string))];
  const artIds = [...new Set(blended.filter((b) => b.articleId).map((b) => b.articleId as string))];
  const [docTitleRows, artTitleRows] = await Promise.all([
    docIds.length
      ? supabaseAdmin.from(D).select('id, title').eq('property_id', pid).in('id', docIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    artIds.length
      ? supabaseAdmin.from(A).select('id, title').eq('property_id', pid).in('id', artIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const docTitleMap = new Map<string, string>(((docTitleRows.data ?? []) as Record<string, unknown>[]).map((r) => [r.id as string, (r.title as string) ?? '']));
  const artTitleMap = new Map<string, string>(((artTitleRows.data ?? []) as Record<string, unknown>[]).map((r) => [r.id as string, (r.title as string) ?? '']));

  const passages: KnowledgePassage[] = blended.map((b) => {
    const sourceId = (b.documentId ?? b.articleId) as string;
    const title = (b.documentId ? docTitleMap.get(b.documentId) : artTitleMap.get(b.articleId as string)) ?? '';
    const snippet = b.content.replace(/\s+/g, ' ').trim().slice(0, PASSAGE_SNIPPET_MAX);
    return { sourceType: b.sourceType, sourceId, title, section: b.section, snippet, similarity: b.similarity };
  });

  const articleRows = ((artTitle.data ?? []) as Record<string, unknown>[]);
  const docRows = ((docTitle.data ?? []) as Record<string, unknown>[]);
  const contactRows = mergeById(
    mergeById(
      mergeById(
        (conName.data ?? []) as Record<string, unknown>[],
        (conCompany.data ?? []) as Record<string, unknown>[],
        8,
      ),
      (conAddress.data ?? []) as Record<string, unknown>[],
      8,
    ),
    (conLocalCat.data ?? []) as Record<string, unknown>[],
    8,
  );
  const eventRows = mergeById(
    (evtTitle.data ?? []) as Record<string, unknown>[],
    (evtNotes.data ?? []) as Record<string, unknown>[],
    8,
  );

  const note = semantic
    ? 'Hybrid semantic + keyword search over this property\'s SOPs and documents (and the contact directory + calendar). The `passages` are the most relevant excerpts — quote the document/SOP title (and section) when you answer. If passages is empty, it isn\'t documented yet — say so; don\'t invent.'
    : 'Keyword search over this property\'s knowledge (semantic search was unavailable this turn). Quote the source title when you answer; if nothing matched, say it isn\'t documented yet.';

  return {
    query: term,
    passages,
    articles: articleRows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? '',
      category: (r.category as string | null) ?? null,
      snippet: makeSnippet(r.body as string, term) ?? '',
    })),
    documents: docRows.map((r) => {
      const status = (r.extraction_status as ExtractionStatus | null) ?? 'pending';
      return {
        id: r.id as string,
        title: (r.title as string) ?? '',
        snippet: null,
        hasText: status === 'ready' || status === 'partial',
      };
    }),
    contacts: contactRows.map((r) => ({
      id: r.id as string,
      name: (r.name as string) ?? '',
      company: (r.company as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      address: (r.address as string | null) ?? null,
      cityStateZip: (r.city_state_zip as string | null) ?? null,
      hours: (r.hours as string | null) ?? null,
      localCategory: (r.local_category as string | null) ?? null,
      notes: makeSnippet(r.notes as string | null, term, 200),
    })),
    events: eventRows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? '',
      eventDate: r.event_date as string,
      endDate: (r.end_date as string | null) ?? null,
      notes: makeSnippet(r.notes as string | null, term, 200),
    })),
    note,
  };
}

// ── fetch_document_section — pull more of a document/SOP within the tool cap ──
//
// The assistant calls this after search_knowledge when a passage looks right
// but it needs more surrounding context. Returns a window of the source's text,
// permission-checked against the caller's role.

export interface DocumentSectionResult {
  sourceType: 'document' | 'article';
  sourceId: string;
  title: string;
  section: string | null;
  text: string;
  hasMore: boolean;
  note: string;
}

const SECTION_WINDOW_MAX = 4000;

/**
 * Return a window of a document's or SOP's text. `role` gates visibility — a
 * manager-only source returns null for floor staff (same gate as search/list).
 */
export async function getDocumentSection(
  pid: string,
  reader: KnowledgeReader,
  input: { sourceType: 'document' | 'article'; sourceId: string; offset?: number },
): Promise<DocumentSectionResult | { error: string }> {
  const offset = Math.max(0, Math.floor(input.offset ?? 0));

  if (input.sourceType === 'document') {
    const { data, error } = await supabaseAdmin
      .from('knowledge_documents')
      .select('id, title, visibility, visible_dept, extracted_text, extraction_status')
      .eq('id', input.sourceId)
      .eq('property_id', pid)
      .maybeSingle();
    if (error || !data) return { error: 'Document not found.' };
    const visibility = ((data.visibility as KnowledgeVisibility | null) ?? 'all_staff');
    // Same dept gate as list/search — a doc the caller can't reach is "not found".
    if (!canReadDocVisibility(reader, visibility, (data.visible_dept as string | null) ?? null)) return { error: 'Document not found.' };
    const full = (data.extracted_text as string | null) ?? '';
    if (!full) return { error: 'This document has no readable text (it may be a scanned image or still processing).' };
    const slice = full.slice(offset, offset + SECTION_WINDOW_MAX);
    return {
      sourceType: 'document', sourceId: data.id as string, title: (data.title as string) ?? '',
      section: null, text: slice, hasMore: offset + SECTION_WINDOW_MAX < full.length,
      note: 'Excerpt of the document text. Quote the document title when you answer.',
    };
  }

  // article
  const { data, error } = await supabaseAdmin
    .from('knowledge_articles')
    .select('id, title, body, category, visibility')
    .eq('id', input.sourceId)
    .eq('property_id', pid)
    .maybeSingle();
  if (error || !data) return { error: 'SOP not found.' };
  const visibility = ((data.visibility as KnowledgeVisibility | null) ?? 'all_staff');
  // SOPs are binary (all_staff|managers); canReadDocVisibility handles both.
  if (!canReadDocVisibility(reader, visibility, null)) return { error: 'SOP not found.' };
  const full = (data.body as string | null) ?? '';
  const slice = full.slice(offset, offset + SECTION_WINDOW_MAX);
  return {
    sourceType: 'article', sourceId: data.id as string, title: (data.title as string) ?? '',
    section: (data.category as string | null) ?? null, text: slice, hasMore: offset + SECTION_WINDOW_MAX < full.length,
    note: 'Excerpt of the SOP. Quote the SOP title when you answer.',
  };
}
