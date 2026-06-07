// ═══════════════════════════════════════════════════════════════════════════
// Knowledge hub — shared types (server + client safe; NO server-only imports).
//
// The client (KnowledgePane) and the server (knowledge/core.ts + the API
// routes + the search_knowledge agent tool) both import from here. Keep this
// file free of supabaseAdmin / env so it can be bundled into the client.
// ═══════════════════════════════════════════════════════════════════════════

/** The four knowledge sub-tabs. */
export type KnowledgeSection = 'sops' | 'documents' | 'contacts' | 'calendar';

/** Contact buckets (nullable on the row → 'other' in the UI). */
export type ContactCategory = 'vendor' | 'emergency' | 'brand' | 'local';
export const CONTACT_CATEGORIES: readonly ContactCategory[] = ['vendor', 'emergency', 'brand', 'local'];

/**
 * Per-document/article visibility. `all_staff` (default) is readable by every
 * authenticated user on the property; `managers` restricts to canManageTeam
 * roles (admin / owner / general_manager). Enforced in search, list, AND
 * signed-URL minting — see core.ts canRoleSeeManagerOnly.
 */
export type KnowledgeVisibility = 'all_staff' | 'managers';
export const KNOWLEDGE_VISIBILITIES: readonly KnowledgeVisibility[] = ['all_staff', 'managers'];

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
  uploadedByName: string | null;
  createdAt: string;
  /** Short-lived signed download URL, minted server-side. Null if the file
   *  couldn't be signed OR the caller's role can't see this document. */
  downloadUrl: string | null;
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
  /** Cap on how much extracted text we store per document (keeps the row + ILIKE cheap). */
  EXTRACTED_TEXT_MAX: 100_000,
} as const;
