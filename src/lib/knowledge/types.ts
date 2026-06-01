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

/** A SOP article as returned to the client. */
export interface KnowledgeArticleDTO {
  id: string;
  title: string;
  body: string;
  category: string | null;
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
  /** True when extracted_text is present (so the doc's *content* is AI-searchable, not just its title). */
  hasText: boolean;
  uploadedByName: string | null;
  createdAt: string;
  /** Short-lived signed download URL, minted server-side. Null if the file couldn't be signed. */
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
