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
import { KNOWLEDGE_LIMITS } from './types';
import type {
  KnowledgeArticleDTO, KnowledgeDocumentDTO, KnowledgeContactDTO,
  KnowledgeEventDTO, ContactCategory,
} from './types';

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
/** Mimes whose *content* we extract into extracted_text for AI search in v1. */
const TEXT_EXTRACTABLE = new Set(['text/plain', 'text/markdown', 'text/csv']);

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

const ARTICLE_COLS = 'id, title, body, category, created_by_name, updated_by_name, created_at, updated_at';

export async function listArticles(pid: string): Promise<KnowledgeArticleDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_articles')
    .select(ARTICLE_COLS)
    .eq('property_id', pid)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) log.warn('knowledge.listArticles failed', { err: error.message });
  return ((data ?? []) as Record<string, unknown>[]).map(toArticleDTO);
}

export async function createArticle(
  pid: string,
  input: { title: string; body: string; category: string | null },
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_articles')
    .insert({
      property_id: pid,
      title: clean(input.title),
      body: clean(input.body),
      category: input.category ? clean(input.category) : null,
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
  input: { title: string; body: string; category: string | null },
  actor: KnowledgeActor,
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('knowledge_articles')
    .update({
      title: clean(input.title),
      body: clean(input.body),
      category: input.category ? clean(input.category) : null,
      updated_by: actor.accountId,
      updated_by_name: actor.name,
    })
    .eq('id', id)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  return !!data;
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

const DOC_COLS = 'id, title, file_path, mime_type, size_bytes, extracted_text, uploaded_by_name, created_at';

export async function listDocuments(pid: string): Promise<KnowledgeDocumentDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_documents')
    .select(DOC_COLS)
    .eq('property_id', pid)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) log.warn('knowledge.listDocuments failed', { err: error.message });
  const rows = (data ?? []) as Record<string, unknown>[];
  // Mint a short-lived signed download URL for each file (server-side; the
  // bucket is private). Done in parallel; a failure leaves downloadUrl null.
  return Promise.all(rows.map(async (r): Promise<KnowledgeDocumentDTO> => {
    const path = r.file_path as string;
    let downloadUrl: string | null = null;
    try {
      const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
      downloadUrl = signed?.signedUrl ?? null;
    } catch { /* leave null */ }
    return {
      id: r.id as string,
      title: (r.title as string) ?? '',
      mimeType: (r.mime_type as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      hasText: !!(r.extracted_text as string | null),
      uploadedByName: (r.uploaded_by_name as string | null) ?? null,
      createdAt: r.created_at as string,
      downloadUrl,
    };
  }));
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
  input: { title: string; path: string; mimeType: string; sizeBytes: number | null },
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

  let extractedText: string | null = null;
  if (TEXT_EXTRACTABLE.has(input.mimeType)) {
    extractedText = await extractTextFromObject(input.path);
  }

  const { data, error } = await supabaseAdmin
    .from('knowledge_documents')
    .insert({
      property_id: pid,
      title: clean(input.title),
      file_path: input.path,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      extracted_text: extractedText,
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

/** Download a text-like object and return its (capped) text content, or null. */
async function extractTextFromObject(path: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
    if (error || !data) return null;
    const raw = await data.text();
    // Postgres `text` cannot store NUL bytes — strip them (split/join avoids a
    // literal control char in source). Then cap length so a huge file doesn't
    // bloat the row or the ILIKE scan.
    const cleaned = raw.split(String.fromCharCode(0)).join(' ').slice(0, KNOWLEDGE_LIMITS.EXTRACTED_TEXT_MAX).trim();
    return cleaned.length ? cleaned : null;
  } catch {
    return null;
  }
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

// ── Contacts ───────────────────────────────────────────────────────────────────

const CONTACT_COLS = 'id, name, company, phone, email, notes, category, created_by_name, created_at';

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
}

export async function createContact(pid: string, input: ContactInput, actor: KnowledgeActor): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('knowledge_contacts')
    .insert({
      property_id: pid,
      name: clean(input.name), company: input.company ? clean(input.company) : null, phone: input.phone,
      email: input.email, notes: input.notes ? clean(input.notes) : null, category: input.category,
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

// ── AI search (shared by /api/knowledge/search + the search_knowledge tool) ──
//
// Keyword/ILIKE search over the property's knowledge (v1). A full embedding /
// vector RAG is a future upgrade — the point here is that the assistant can
// FIND and quote the hotel's own SOPs, contacts, events, and plain-text/markdown
// document content. ALWAYS scoped to a single property_id (the caller's), so the
// AI tool can never leak another tenant's knowledge.

export interface KnowledgeSearchResult {
  query: string;
  articles: { id: string; title: string; category: string | null; snippet: string }[];
  documents: { id: string; title: string; snippet: string | null; hasText: boolean }[];
  contacts: { id: string; name: string; company: string | null; phone: string | null; email: string | null; category: string | null; notes: string | null }[];
  events: { id: string; title: string; eventDate: string; endDate: string | null; notes: string | null }[];
  note: string;
}

/**
 * Strip everything that isn't a letter, number, space, dot, or hyphen. This
 * removes LIKE wildcards (`%` and underscore) so a user query can't widen the
 * match to "everything", and removes characters that have meaning to PostgREST.
 * The sanitized term is then passed as a *value* to `.ilike()` (never
 * interpolated into a filter string), so it can't break out of the query.
 */
function sanitizeSearchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N}\s.\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function makeSnippet(text: string | null | undefined, term: string, max = 240): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const idx = flat.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) {
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(flat.length, idx + max - 60);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/** Merge two row arrays by id, preserving the first array's order (priority matches first). */
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

export async function searchKnowledge(pid: string, rawQuery: string): Promise<KnowledgeSearchResult> {
  const term = sanitizeSearchTerm(rawQuery);
  const baseNote = 'Keyword search over this property\'s SOPs, documents (plain-text/markdown content + all titles), contacts, and calendar. Quote the source title when you answer.';
  if (term.length < 2) {
    return {
      query: term, articles: [], documents: [], contacts: [], events: [],
      note: 'Search term too short — ask the user to be more specific.',
    };
  }
  const pattern = `%${term}%`;
  const A = 'knowledge_articles', D = 'knowledge_documents', C = 'knowledge_contacts', E = 'knowledge_events';

  // Per-column ILIKE queries (no filter-string concatenation → injection-safe).
  // Title/name matches are the "primary" set so they rank ahead of body matches.
  const [
    artTitle, artBody, docTitle, docText, conName, conCompany, evtTitle, evtNotes,
  ] = await Promise.all([
    supabaseAdmin.from(A).select('id, title, category, body').eq('property_id', pid).ilike('title', pattern).limit(5),
    supabaseAdmin.from(A).select('id, title, category, body').eq('property_id', pid).ilike('body', pattern).limit(5),
    supabaseAdmin.from(D).select('id, title, extracted_text').eq('property_id', pid).ilike('title', pattern).limit(5),
    supabaseAdmin.from(D).select('id, title, extracted_text').eq('property_id', pid).ilike('extracted_text', pattern).limit(5),
    supabaseAdmin.from(C).select('id, name, company, phone, email, category, notes').eq('property_id', pid).ilike('name', pattern).limit(5),
    supabaseAdmin.from(C).select('id, name, company, phone, email, category, notes').eq('property_id', pid).ilike('company', pattern).limit(5),
    supabaseAdmin.from(E).select('id, title, event_date, end_date, notes').eq('property_id', pid).ilike('title', pattern).limit(5),
    supabaseAdmin.from(E).select('id, title, event_date, end_date, notes').eq('property_id', pid).ilike('notes', pattern).limit(5),
  ]);

  const articleRows = mergeById(
    (artTitle.data ?? []) as Record<string, unknown>[],
    (artBody.data ?? []) as Record<string, unknown>[],
    5,
  );
  const docRows = mergeById(
    (docTitle.data ?? []) as Record<string, unknown>[],
    (docText.data ?? []) as Record<string, unknown>[],
    5,
  );
  const contactRows = mergeById(
    (conName.data ?? []) as Record<string, unknown>[],
    (conCompany.data ?? []) as Record<string, unknown>[],
    8,
  );
  const eventRows = mergeById(
    (evtTitle.data ?? []) as Record<string, unknown>[],
    (evtNotes.data ?? []) as Record<string, unknown>[],
    8,
  );

  return {
    query: term,
    articles: articleRows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? '',
      category: (r.category as string | null) ?? null,
      snippet: makeSnippet(r.body as string, term) ?? '',
    })),
    documents: docRows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? '',
      snippet: makeSnippet(r.extracted_text as string | null, term),
      hasText: !!(r.extracted_text as string | null),
    })),
    contacts: contactRows.map((r) => ({
      id: r.id as string,
      name: (r.name as string) ?? '',
      company: (r.company as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      notes: makeSnippet(r.notes as string | null, term, 200),
    })),
    events: eventRows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) ?? '',
      eventDate: r.event_date as string,
      endDate: (r.end_date as string | null) ?? null,
      notes: makeSnippet(r.notes as string | null, term, 200),
    })),
    note: baseNote,
  };
}
