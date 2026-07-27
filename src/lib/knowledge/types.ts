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
 * Local-contact sub-types (only meaningful when category === 'local').
 * Mirrors QUORE's "Local" directory list so a hotel switching over finds the
 * same buckets. Stored free-text in `local_category` (no DB check — the API
 * validates this set so adding a bucket later needs no migration).
 */
export const LOCAL_CATEGORIES = [
  'Accommodations',
  'Attractions',
  'Bar/Nightlife',
  'Government Service',
  'Grocery Store',
  'Hospitals/Clinics',
  'Mail/Shipping',
  'Movie Theaters',
  'Pharmacy',
  'Place of Worship',
  'Recreation',
  'Restaurants',
  'Shopping',
  'Travel',
] as const;
export type LocalCategory = (typeof LOCAL_CATEGORIES)[number];

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
 *
 * Note: a scanned PDF or an uploaded photo sits in `processing` while the Fly
 * OCR worker transcribes it (KnowledgePane shows "Reading scan…"). That window
 * is seconds-to-minutes for scans, vs. milliseconds for a typed doc — so
 * `processing` doubles as the honest "OCR in progress" state (no new enum value,
 * no migration on the status column).
 */
export type ExtractionStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'unsupported';

/**
 * Image types the Knowledge hub accepts for photo/scan OCR. A scanned PDF and
 * these image types both route to the Fly vision-OCR worker (Claude transcribes
 * each page/photo, the text then flows through the normal chunk→embed→search
 * pipeline). Kept as a shared constant so the client accept-list, the presign
 * MIME map, and the extraction router agree on exactly one set. 10 MB cap
 * (KNOWLEDGE upload limit) applies to these like every other upload.
 */
export const KNOWLEDGE_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime && KNOWLEDGE_IMAGE_MIME_TYPES.includes(mime);
}

// ─── Why a document isn't searchable, in the reader's language ───────────────
//
// `knowledge_documents.extract_error` holds ONE English sentence, written by
// whichever step gave up. It is the right thing to store (it reads correctly in
// the database, in a log line, and in an admin screen) but it is the wrong
// thing to SHOW: half this product's users read Spanish, and a sentence frozen
// into a table at upload time can't be translated at render time.
//
// So the sentences a user might actually need to act on are declared HERE, each
// paired with a stable code. The writer stores the sentence; `docIssueReason`
// maps it back to the code; KnowledgePane renders bilingual copy for the code.
//
// Why exact-match a constant instead of adding an `extract_reason_code` column:
// this repo has shipped three separate "column that doesn't exist" outages, and
// a migration must be applied by hand here — so any code that SELECTs a new
// column is broken in production from deploy until someone runs the SQL. Exact
// string equality against these constants needs no schema change and degrades
// correctly: an unrecognized or legacy sentence maps to null and the UI simply
// shows no note, exactly as it did before.
export type DocIssueReason =
  | 'scan_too_large'
  | 'scan_too_long'
  | 'scan_empty'
  | 'scan_busy'
  | 'scan_budget'
  | 'legacy_doc';

/**
 * The exact sentence stored in `extract_error` for each reason. Writers MUST
 * use these constants rather than an inline string — that identity is the whole
 * mechanism, and `docIssueReason` round-trips it in the test suite.
 */
export const DOC_ISSUE_MESSAGE: Record<DocIssueReason, string> = {
  scan_too_large: 'This scan is too large to read. Split it up or upload a smaller file.',
  scan_too_long: 'This scan has more pages than can be read at once. Split it into smaller files.',
  scan_empty: 'The scan didn\'t contain any readable text.',
  scan_busy: 'Reading this scan timed out. Upload it again to retry.',
  scan_budget: 'This hotel has reached its daily limit for reading scans. Try again tomorrow.',
  legacy_doc: 'Legacy .doc files can\'t be read — re-save as .docx or PDF and re-upload.',
};

const ISSUE_BY_MESSAGE: ReadonlyMap<string, DocIssueReason> = new Map(
  (Object.keys(DOC_ISSUE_MESSAGE) as DocIssueReason[]).map((k) => [DOC_ISSUE_MESSAGE[k], k]),
);

/** Map a stored `extract_error` back to its code. Null for anything this
 *  vocabulary doesn't cover (older rows, embedding notes, unexpected errors) —
 *  the UI then shows the status badge alone, which is the pre-existing behavior. */
export function docIssueReason(extractError: string | null | undefined): DocIssueReason | null {
  if (!extractError) return null;
  return ISSUE_BY_MESSAGE.get(extractError) ?? null;
}

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
  /** Why a non-searchable document ended up that way, as a stable code the UI
   *  renders in the reader's language. Null when the document is fine, or when
   *  the stored reason predates this vocabulary. See docIssueReason(). */
  issueReason: DocIssueReason | null;
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
  /** Street address (local contacts — e.g. a nearby pharmacy). Free text. */
  address: string | null;
  /** City, state & ZIP on one line. Free text. */
  cityStateZip: string | null;
  /** Hours as one free-text line ("Mon–Fri 8a–9p, Sat 9a–6p"). */
  hours: string | null;
  /** Local sub-type (one of LOCAL_CATEGORIES); only set when category === 'local'. */
  localCategory: string | null;
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
  ADDRESS_MAX: 200,
  HOURS_MAX: 200,
  DOC_FILENAME_MAX: 200,
  FOLDER_NAME_MAX: 80,
  /** Cap on how much extracted text we store per document (keeps the row + ILIKE cheap). */
  EXTRACTED_TEXT_MAX: 100_000,
} as const;
