// ═══════════════════════════════════════════════════════════════════════════
// "What you've told it" — the decisions behind the told half of the Knows tab.
//
// WHY THIS FILE HAS NO JSX
// The suite runs under `--conditions=react-server`, where react-dom/server
// refuses to load, so a hooks-using component cannot be mounted in a test. The
// house pattern (see concourse-queue-honesty.test.ts) is to put the decisions
// in a plain module and exercise THOSE. Everything here is pure and free of
// React, so the upload flow, the access round-trip, the OCR badge states, the
// contact ordering and the tap-to-call hrefs are all testable for real rather
// than asserted against source text.
//
// The panels in ToldKnowledge.tsx / ToldContacts.tsx are the thin shell over
// this; nothing below imports a browser API.
// ═══════════════════════════════════════════════════════════════════════════

import type { EnvelopeResult } from '@/lib/api-envelope';
import type {
  ContactCategory,
  Dept,
  ExtractionStatus,
  KnowledgeContactDTO,
  KnowledgeDocumentDTO,
  KnowledgeVisibility,
  LocalCategory,
} from '@/lib/knowledge/types';
import {
  CONTACT_CATEGORIES,
  KNOWLEDGE_LIMITS,
  LOCAL_CATEGORIES,
} from '@/lib/knowledge/types';
import type { AppRole } from '@/lib/roles';
import { canManageTeam } from '@/lib/roles';

export type Lang = 'en' | 'es';
export interface Bilingual { en: string }
export function say(b: Bilingual, lang: Lang): string {
  return b.en;
}

// ── Who sees what ───────────────────────────────────────────────────────────
//
// THE RECONCILIATION. The learned half of this screen is manager-only and
// stays that way. The told half is NOT: in Communications every signed-in
// person could read the contact directory and tap an emergency number, and
// moving the directory onto a manager-gated screen would have quietly taken
// that away from the front desk. So reading the told half follows the old
// Communications rule (everyone), and only the write affordances follow the
// manager rule — which is exactly what ContactsPane/KnowledgePane did with
// their `isManager` prop.
//
// This is a RENDER decision only. The server is still the authority: reads go
// through /api/knowledge/* which check session + property access, and writes
// additionally check the manage_knowledge capability. Nothing here grants
// anything the routes would refuse.

/** Everyone signed in can READ what the hotel has told Staxis. */
export function canReadTold(role: AppRole | null | undefined): boolean {
  return !!role;
}

/** Only managers get the add/edit/delete affordances. */
export function canEditTold(role: AppRole | null | undefined): boolean {
  return !!role && canManageTeam(role);
}

/** The learned half stays a manager view — unchanged from before the move. */
export function canReadLearned(role: AppRole | null | undefined): boolean {
  return !!role && canManageTeam(role);
}

export type KnowsHalf = 'learned' | 'told';

/**
 * Which half opens first.
 *
 * A manager keeps landing on the learned half — that is what Knows was, and
 * the move should not change the screen under them. Anybody else lands on the
 * told half, because the learned half has nothing to show them and because it
 * puts the contact directory (and the emergency numbers inside it) one tap
 * closer for the people most likely to need it in a hurry.
 */
export function defaultHalf(role: AppRole | null | undefined): KnowsHalf {
  return canReadLearned(role) ? 'learned' : 'told';
}

/** Sections of the told half. Contacts is FIRST and is the default — see
 *  defaultToldSection. */
export type ToldSection = 'contacts' | 'sops' | 'documents' | 'rules';
export const TOLD_SECTIONS: readonly ToldSection[] = ['contacts', 'sops', 'documents', 'rules'];

/**
 * Contacts opens first, for ONE reason: somebody at the front desk with a
 * guest emergency in front of them should not be navigating. From the Knows
 * tab that is a single tap to the told half and the emergency numbers are
 * already on screen (they sort first — see CONTACT_GROUP_ORDER). For a
 * non-manager, who lands on the told half already, it is zero taps.
 */
export const defaultToldSection: ToldSection = 'contacts';

export const TOLD_SECTION_LABEL: Record<ToldSection, Bilingual> = {
  contacts: { en: 'Contacts', },
  sops: { en: 'How we do things', },
  documents: { en: 'Documents', },
  // The standing instructions somebody gave the companion in plain language.
  // LAST in the strip: contacts is the emergency path and must stay first (see
  // defaultToldSection), and this is the newest and least urgent of the four.
  rules: { en: 'Standing rules', },
};

// ── Document access (the permission control) ────────────────────────────────
//
// One dropdown value stands for a visibility tier OR a department, because
// "who can see this" is one question to a manager even though the row stores
// it in two columns.

export type AccessVal = 'all_staff' | 'managers' | Dept;

export const ACCESS_OPTIONS: readonly { value: AccessVal; label: Bilingual }[] = [
  { value: 'all_staff', label: { en: 'Everyone', } },
  { value: 'front_desk', label: { en: 'Front desk', } },
  { value: 'housekeeping', label: { en: 'Housekeeping', } },
  { value: 'maintenance', label: { en: 'Maintenance', } },
  { value: 'managers', label: { en: 'Managers only', } },
];

export const DEPT_LABEL: Record<Dept, Bilingual> = {
  front_desk: { en: 'Front desk', },
  housekeeping: { en: 'Housekeeping', },
  maintenance: { en: 'Maintenance', },
};

export const MANAGERS_ONLY_LABEL: Bilingual = { en: 'Managers only', };

/** The row's two columns collapsed back into the one value the picker shows. */
export function docAccessVal(d: Pick<KnowledgeDocumentDTO, 'visibility' | 'visibleDept'>): AccessVal {
  if (d.visibility === 'dept') return d.visibleDept ?? 'all_staff';
  return d.visibility as AccessVal;
}

/** The picker's value expanded back into the two columns the route wants. */
export function accessToPayload(a: AccessVal): { visibility: KnowledgeVisibility; visibleDept: Dept | null } {
  if (a === 'all_staff' || a === 'managers') return { visibility: a, visibleDept: null };
  return { visibility: 'dept', visibleDept: a };
}

// ── Extraction status — the only place a failed scan is ever reported ───────
//
// If a scanned PDF never became text, NOTHING else in the app says so. The
// copilot just answers worse. That is why these six states each get their own
// sentence instead of collapsing into "uploaded".

export type BadgeTone = 'good' | 'warn' | 'muted';
export interface ExtractionBadge { label: Bilingual; tone: BadgeTone; spinning: boolean }

const EXTRACTION_BADGES: Record<ExtractionStatus, ExtractionBadge> = {
  ready: { label: { en: 'Searchable by AI', }, tone: 'good', spinning: false },
  partial: { label: { en: 'Partially indexed', }, tone: 'good', spinning: false },
  pending: { label: { en: 'Processing…', }, tone: 'muted', spinning: true },
  processing: { label: { en: 'Reading scan…', }, tone: 'muted', spinning: true },
  unsupported: { label: { en: 'Not text-searchable', }, tone: 'muted', spinning: false },
  failed: { label: { en: 'Couldn’t read', }, tone: 'warn', spinning: false },
};

export function extractionBadge(status: ExtractionStatus): ExtractionBadge | null {
  return EXTRACTION_BADGES[status] ?? null;
}

/** True while the document list should keep refreshing itself. */
export function isExtractionInFlight(status: ExtractionStatus): boolean {
  return status === 'pending' || status === 'processing';
}

export function anyExtractionInFlight(docs: readonly Pick<KnowledgeDocumentDTO, 'extractionStatus'>[]): boolean {
  return docs.some((d) => isExtractionInFlight(d.extractionStatus));
}

export function prettyType(mime: string | null): string {
  if (!mime) return 'File';
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'text/markdown') return 'Markdown';
  if (mime === 'text/plain') return 'Text';
  if (mime === 'text/csv') return 'CSV';
  if (mime === 'image/jpeg') return 'JPEG';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/webp') return 'WebP';
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return 'Word';
  return mime;
}

/** "1 file" / "4 files", in either language. */
export function fileCountLabel(n: number): Bilingual {
  return n === 1
    ? { en: '1 file', }
    : { en: `${n} files`, };
}

export function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── The upload flow ─────────────────────────────────────────────────────────
//
// THIS IS THE ONLY WAY A HUMAN PUTS A DOCUMENT INTO THE COPILOT'S CORPUS.
// search_knowledge tells the model to always consult it, so when this breaks
// the symptom is not an error — it is the copilot quietly getting worse. The
// three steps are sequenced here, away from React, so a test can drive the
// real thing and every failure gets its own outcome instead of a shrug.

export const UPLOAD_MAX_BYTES = 10_485_760; // 10 MB — matches the route's cap.

export const UPLOAD_ACCEPT =
  '.pdf,.txt,.md,.markdown,.csv,.doc,.docx,.jpg,.jpeg,.png,.webp';

/** Just enough of a File to sequence the upload; keeps Blob out of this module. */
export interface UploadFile { name: string; size: number }

export interface PresignData { path: string; signedUrl: string; contentType: string }

export interface UploadDeps {
  presign: (body: { pid: string; filename: string }) => Promise<EnvelopeResult<PresignData>>;
  /** PUT the bytes at the signed URL with the SERVER-resolved content type. */
  put: (signedUrl: string, contentType: string) => Promise<boolean>;
  register: (body: {
    pid: string;
    title: string;
    path: string;
    mimeType: string;
    sizeBytes: number;
    visibility: KnowledgeVisibility;
    visibleDept: Dept | null;
    folderId: string | null;
  }) => Promise<EnvelopeResult<{ id: string }>>;
}

export type UploadFailure =
  | 'too_big'
  | 'presign_failed'
  | 'put_failed'
  | 'register_failed'
  | 'threw';

export type UploadResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: UploadFailure; serverError?: string };

/** The document title we derive from a filename (extension dropped, capped). */
export function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, KNOWLEDGE_LIMITS.TITLE_MAX) || name;
}

/**
 * presign → PUT → register, in that order, stopping at the first failure.
 *
 * The content type used for the PUT is the one the SERVER resolved, never
 * File.type: Safari hands back an empty type for several accepted extensions
 * and the storage bucket allow-lists on the value we send.
 */
export async function uploadDocument(
  deps: UploadDeps,
  input: { pid: string; file: UploadFile; access: AccessVal; folderId: string | null },
): Promise<UploadResult> {
  const { pid, file, access, folderId } = input;

  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, reason: 'too_big' };

  try {
    const pre = await deps.presign({ pid, filename: file.name });
    if (pre.error !== undefined || !pre.data) {
      return { ok: false, reason: 'presign_failed', serverError: pre.error };
    }

    const put = await deps.put(pre.data.signedUrl, pre.data.contentType);
    if (!put) return { ok: false, reason: 'put_failed' };

    const a = accessToPayload(access);
    const reg = await deps.register({
      pid,
      title: titleFromFilename(file.name),
      path: pre.data.path,
      mimeType: pre.data.contentType,
      sizeBytes: file.size,
      visibility: a.visibility,
      visibleDept: a.visibleDept,
      folderId,
    });
    if (reg.error !== undefined) {
      return { ok: false, reason: 'register_failed', serverError: reg.error };
    }
    return { ok: true, id: reg.data?.id ?? null };
  } catch {
    return { ok: false, reason: 'threw' };
  }
}

export const UPLOAD_FAILURE_COPY: Record<UploadFailure, Bilingual> = {
  too_big: { en: 'That file is too big. Keep it under 10 MB.', },
  presign_failed: {
    en: 'Staxis cannot take that kind of file. Nothing was saved.',

  },
  put_failed: {
    en: 'The file did not finish uploading. Nothing was saved. Try again.',

  },
  register_failed: {
    en: 'The file uploaded but Staxis could not save it. Try again.',

  },
  threw: {
    en: 'The upload failed. Check your connection and try again.',

  },
};

// ── Contacts ────────────────────────────────────────────────────────────────

/**
 * EMERGENCY SORTS FIRST. In Communications this list ran in declaration order
 * — vendor, emergency, brand, local — so the fastest number to reach in a
 * crisis sat under the linen supplier. Nothing else about the directory
 * changed in the move; this did, deliberately.
 */
// Derived from CONTACT_CATEGORIES rather than hand-listed, with emergency
// hoisted. A category added to the shared list must never fall through
// groupContacts into no bucket at all — that would drop those contacts off
// the directory silently.
export const CONTACT_GROUP_ORDER: readonly (ContactCategory | 'other')[] = [
  'emergency',
  ...CONTACT_CATEGORIES.filter((c) => c !== 'emergency'),
  'other',
];

export const CONTACT_CAT_LABEL: Record<ContactCategory | 'other', Bilingual> = {
  emergency: { en: 'Emergency', },
  vendor: { en: 'Vendors', },
  brand: { en: 'Brand', },
  local: { en: 'Local', },
  other: { en: 'Other', },
};

export const LOCAL_CAT_LABEL: Record<LocalCategory, Bilingual> = {
  'Accommodations': { en: 'Accommodations', },
  'Attractions': { en: 'Attractions', },
  'Bar/Nightlife': { en: 'Bar / Nightlife', },
  'Government Service': { en: 'Government Service', },
  'Grocery Store': { en: 'Grocery Store', },
  'Hospitals/Clinics': { en: 'Hospitals / Clinics', },
  'Mail/Shipping': { en: 'Mail / Shipping', },
  'Movie Theaters': { en: 'Movie Theaters', },
  'Pharmacy': { en: 'Pharmacy', },
  'Place of Worship': { en: 'Place of Worship', },
  'Recreation': { en: 'Recreation', },
  'Restaurants': { en: 'Restaurants', },
  'Shopping': { en: 'Shopping', },
  'Travel': { en: 'Travel', },
};

export const OTHER_LOCAL_LABEL: Bilingual = { en: 'Other local', };

export function localLabel(v: string | null): Bilingual {
  if (!v) return OTHER_LOCAL_LABEL;
  return LOCAL_CAT_LABEL[v as LocalCategory] ?? { en: v, };
}

export interface ContactSubGroup {
  key: string;
  label: Bilingual;
  rows: KnowledgeContactDTO[];
}

export interface ContactGroup {
  key: ContactCategory | 'other';
  label: Bilingual;
  /** Emergency is styled as the urgent group; nothing else is. */
  urgent: boolean;
  rows: KnowledgeContactDTO[];
  /** Only the Local bucket sub-groups (the 14-way taxonomy). */
  subGroups: ContactSubGroup[] | null;
}

/** Local rows bucketed by sub-type, in LOCAL_CATEGORIES order, unknowns last. */
export function localSubGroups(rows: readonly KnowledgeContactDTO[]): ContactSubGroup[] {
  const out: ContactSubGroup[] = [];
  for (const lc of LOCAL_CATEGORIES) {
    const sub = rows.filter((c) => c.localCategory === lc);
    if (sub.length) out.push({ key: lc, label: localLabel(lc), rows: sub });
  }
  const other = rows.filter(
    (c) => !c.localCategory || !(LOCAL_CATEGORIES as readonly string[]).includes(c.localCategory),
  );
  if (other.length) out.push({ key: '__other', label: OTHER_LOCAL_LABEL, rows: other });
  return out;
}

/** Group the directory for display. Empty groups are dropped. */
export function groupContacts(rows: readonly KnowledgeContactDTO[]): ContactGroup[] {
  const out: ContactGroup[] = [];
  for (const cat of CONTACT_GROUP_ORDER) {
    const inCat = rows.filter((c) => (c.category ?? 'other') === cat);
    if (inCat.length === 0) continue;
    out.push({
      key: cat,
      label: CONTACT_CAT_LABEL[cat],
      urgent: cat === 'emergency',
      rows: inCat,
      subGroups: cat === 'local' ? localSubGroups(inCat) : null,
    });
  }
  return out;
}

// ── Tap targets ─────────────────────────────────────────────────────────────
//
// The old cards interpolated the stored string straight into `tel:`, so a
// number saved as "(409) 555-1234" produced a href with literal spaces and
// brackets in it. Formatting punctuation is stripped; everything else — a
// leading +, a short code like 911, an extension — is left verbatim.

export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const dial = phone.replace(/[\s().\-–—]/g, '');
  return dial ? `tel:${dial}` : null;
}

export function mailtoHref(email: string | null | undefined): string | null {
  const e = email?.trim();
  return e ? `mailto:${e}` : null;
}

export function mapHref(
  address: string | null | undefined,
  cityStateZip: string | null | undefined,
): string | null {
  const q = [address, cityStateZip].filter(Boolean).join(', ').trim();
  return q ? `https://maps.google.com/?q=${encodeURIComponent(q)}` : null;
}

export function addressLine(
  address: string | null | undefined,
  cityStateZip: string | null | undefined,
): string {
  return [address, cityStateZip].filter(Boolean).join(', ');
}
