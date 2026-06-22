// ═══════════════════════════════════════════════════════════════════════════
// Knowledge hub — shared types (server + client safe; NO server-only imports).
//
// The client (KnowledgePane) and the server (knowledge/core.ts + the API
// routes + the search_knowledge agent tool) both import from here. Keep this
// file free of supabaseAdmin / env so it can be bundled into the client.
// ═══════════════════════════════════════════════════════════════════════════

// dept-scope.ts is PURE + standalone (no server-only / env), so this stays
// client-safe. `Dept` is the single source of truth for the department set;
// the Documents cabinet's per-department access reuses it.
import type { Dept } from '@/lib/capabilities/dept-scope';
export type { Dept };
/** The departments a document can be scoped to (visibility='dept'). */
export const KNOWLEDGE_DEPTS: readonly Dept[] = ['front_desk', 'housekeeping', 'maintenance'];

/** The knowledge sub-tabs. (Calendar was promoted to its own Communications
 *  tab — see communications/_components/CalendarPane.tsx; it still reads/writes
 *  the knowledge_events table via /api/knowledge/events.) */
export type KnowledgeSection = 'sops' | 'documents' | 'contacts';

/** Contact buckets (nullable on the row → 'other' in the UI). */
export type ContactCategory = 'vendor' | 'emergency' | 'brand' | 'local';
export const CONTACT_CATEGORIES: readonly ContactCategory[] = ['vendor', 'emergency', 'brand', 'local'];

/**
 * Per-document/article visibility, three tiers:
 *   - `all_staff` (default) — readable by every authenticated user on the property.
 *   - `dept`      — readable by managers + staff whose own department matches the
 *                   document's `visible_dept` (Documents only; gated via the shared
 *                   Access checker canReachDeptContent).
 *   - `managers`  — restricted to canManageTeam roles (admin / owner / general_manager).
 * Enforced in search, list, AND signed-URL minting — see core.ts.
 * SOPs (articles) only ever use `all_staff` / `managers` (no `dept`).
 */
export type KnowledgeVisibility = 'all_staff' | 'dept' | 'managers';
export const KNOWLEDGE_VISIBILITIES: readonly KnowledgeVisibility[] = ['all_staff', 'dept', 'managers'];

/**
 * Document extraction lifecycle (the state machine). Source of truth for the
 * type lives here (client-safe); extraction.ts owns the logic + the
 * EXTRACTED_TEXT_MAX / TERMINAL list. KnowledgePane derives its badge from this.
 */
export type ExtractionStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'unsupported';

/** A SOP article as returned to the client. */
export interface KnowledgeArticleDTO {
  id: string;
  title: string;
  body: string;
  category: string | null;
  /** Who may read this SOP. Defaults 'all_staff'. */
  visibility: KnowledgeVisibility;
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An uploaded document's metadata as returned to the client. */
export interface KnowledgeDocumentDTO {
  id: string;
  title: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** True when the doc's *content* is AI-searchable (status ready|partial). */
  hasText: boolean;
  /** Extraction lifecycle — drives the EN/ES badge in KnowledgePane. */
  extractionStatus: ExtractionStatus;
  /** Who may read this document. Defaults 'all_staff'. */
  visibility: KnowledgeVisibility;
  /** The department a `visibility==='dept'` document is scoped to; null otherwise. */
  visibleDept: Dept | null;
  /** Folder this document lives in (knowledge_folders.id), or null when unfiled. */
  folderId: string | null;
  uploadedByName: string | null;
  createdAt: string;
  /** Short-lived signed download URL, minted server-side. Null if the file
   *  couldn't be signed OR the caller's role can't see this document. */
  downloadUrl: string | null;
}

/** A document folder as returned to the client. */
export interface KnowledgeFolderDTO {
  id: string;
  name: string;
  /** Parent folder (knowledge_folders.id) for nesting, or null at the root. */
  parentId: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** A directory contact as returned to the client. */
export interface KnowledgeContactDTO {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  category: ContactCategory | null;
  createdByName: string | null;
  createdAt: string;
}

/** A calendar entry as returned to the client. */
export interface KnowledgeEventDTO {
  id: string;
  title: string;
  eventDate: string;       // YYYY-MM-DD
  endDate: string | null;  // YYYY-MM-DD or null (single-day)
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
}

// ── Field limits (shared by client + server validation) ──────────────────────
export const KNOWLEDGE_LIMITS = {
  TITLE_MAX: 200,
  BODY_MAX: 50_000,
  CATEGORY_MAX: 60,
  CONTACT_NAME_MAX: 120,
  COMPANY_MAX: 120,
  EMAIL_MAX: 254,
  PHONE_MAX: 40,
  NOTES_MAX: 2_000,
  DOC_FILENAME_MAX: 200,
  FOLDER_NAME_MAX: 80,
  /** Cap on how much extracted text we store per document (keeps the row + ILIKE cheap). */
  EXTRACTED_TEXT_MAX: 100_000,
} as const;
