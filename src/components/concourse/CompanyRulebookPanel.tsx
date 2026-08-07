'use client';

// ═══════════════════════════════════════════════════════════════════════════
// CompanyRulebookPanel — the management company's own book, one level above
// "what Staxis knows about this hotel."
//
// WHERE IT LIVES AND WHY
// Inside the Knows view, ABOVE the hotel's facts. Not a new top-level tab: the
// company book and the hotel book are the same relationship with the copilot at
// two altitudes, and a VP who opens Knows should see the company's rules and
// then this hotel's, in that order — which is also the order the copilot reads
// them in. A hotel with no management company renders nothing at all here.
//
// TWO AUDIENCES, ONE SCREEN
//   Company leadership  the full book: open box, Confirm / Edit / Remove, the
//                       structured reading of every approval rule, and the
//                       quiet line where a hotel's settings disagree with it.
//   A hotel GM          the same book, LOCKED. The founder's ruling: "they
//                       should know the policies they're governed by." No open
//                       box, no buttons, and the server refuses their writes
//                       regardless of what this component renders.
//
// HONESTY RULES, inherited from the hotel Knows screen:
//   • A line pulled out of something you pasted shows as NOT CONFIRMED and does
//     not reach any hotel's copilot until you say so — enforced in the database
//     (migration 0365), not just labelled here.
//   • Confirming an approval rule shows you EXACTLY what will be frozen, in one
//     sentence, before you agree to it.
//   • Remove is permanent, and the copy says so.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
  SessionEndedError,
} from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import {
  COMPANY_CATEGORIES,
  COMPANY_CATEGORY_LABELS,
  type CompanyCategory,
} from '@/lib/company/rulebook-policy';
import { CxIcon } from './icons';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Bilingual { en: string; es?: string }

interface RulebookFact {
  id: string;
  topic: string;
  content: string;
  category: CompanyCategory;
  source: string;
  reviewState: 'unreviewed' | 'confirmed';
  policyKey: string | null;
  policyValue: string | null;
  createdByName: string | null;
  updatedAt: string;
  currentRevision: number | null;
  nearDuplicateOf?: { id: string; topic: string; content: string; line: Bilingual } | null;
  reading: {
    authority: { line: Bilingual } | null;
    /**
     * Set when the line names TWO approvers and Staxis will not choose between
     * them. Rendered as its own block rather than as a `reading`, because it is
     * the opposite claim: a reading says "this is in force", this says "nothing
     * is, and here is why".
     */
    ambiguousAuthority?: { candidates: string[]; line: Bilingual } | null;
    policy: { line: Bilingual } | null;
  };
}

interface Contradiction {
  propertyId: string;
  propertyName: string;
  key: string;
  line: Bilingual;
}

interface RulebookData {
  audience: 'company' | 'hotel';
  organizationId: string;
  canEdit: boolean;
  companyRole: 'owner' | 'regional_manager' | null;
  viewOnlyBecauseHotelJob: boolean;
  settings?: {
    gms_see_rulebook: string | null;
    cross_hotel_ai_chat: string | null;
    rulebook_editors: string | null;
    setup_completed_at: string | null;
  };
  stats: { totalKnown: number; pendingReview?: number; hotelsCovered?: number };
  facts: RulebookFact[];
  contradictions?: Contradiction[];
}

interface IntakeResult {
  added: Array<{ id: string; currentRevision?: number | null }>;
  skipped: number;
  /** English, from the server. Kept for compatibility; NOT rendered — see
   *  readNoteCode, which is the same fact in a form this panel can translate. */
  readNote: string | null;
  readNoteCode: string | null;
  nothingFound: boolean;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

const S = {
  title: { en: 'Company rulebook', },
  subEdit: {
    en: 'The rules that apply at every hotel your company runs. Staxis follows them at all of them.',

  },
  subView: {
    en: 'The rules your management company has set. You can read them here; only company leadership can change them.',

  },
  locked: { en: 'Read only', },
  coversOne: { en: 'covers 1 hotel', },
  coversMany: { en: 'hotels', },
  known: { en: 'in the book', },
  pending: { en: 'waiting for you', },
  boxEyebrow: { en: 'Add to the rulebook', },
  boxPlaceholder: {
    en: 'A policy that holds at every hotel: who you buy from, what needs a signature, how you want things run.',

  },
  boxHint: {
    en: 'Optional. Or drop in a file you already have: an operations manual, a vendor agreement, a policy memo.',

  },
  addFile: { en: 'Add a file', },
  removeFile: { en: 'Remove file', },
  submit: { en: 'Add this', },
  submitting: { en: 'Reading…', },
  intakeDoneOne: {
    en: '1 rule added below. Check it before Staxis applies it at your hotels.',

  },
  intakeDoneMany: {
    en: 'rules added below. Check each one before Staxis applies it at your hotels.',

  },
  intakeNothing: {
    en: 'Nothing company-wide in that one. Nothing was saved.',

  },
  fileTooBig: { en: 'That file is too big. Keep it under 4MB.', },
  fileWrongType: {
    en: 'Staxis can read PDF, Word, and plain text files.',

  },
  emptyTitle: { en: 'Your company book is empty', },
  emptyBody: {
    en: 'Write one rule above and every hotel in the company gets it. Nothing here is required. A book with three lines in it is a useful book.',

  },
  emptyView: {
    en: 'Your management company has not written any rules yet.',

  },
  readingEyebrow: { en: 'Staxis reads this as', },
  readingAsk: { en: 'Right?', },
  // Used where the eyebrow and the question are shown as one line. The
  // eyebrow alone is a fragment that leads into the reading below it, so
  // it cannot simply be full-stopped onto the question.
  readingConfirm: {
    en: 'Here is how Staxis reads this. Right?',

  },
  readingUnsure: { en: 'Staxis cannot read this one', },
  dupeEyebrow: { en: 'You may already have this', },
  dupeUpdate: { en: 'Update that line', },
  dupeKeepBoth: { en: 'Keep both', },
  ruleFrozen: { en: 'Approval rule in force', },
  confirm: { en: 'Confirm', },
  edit: { en: 'Edit', },
  remove: { en: 'Remove', },
  save: { en: 'Save', },
  cancel: { en: 'Cancel', },
  removeSure: {
    en: 'Remove for good? Any approval rule frozen from this line stops applying.',

  },
  removeYes: { en: 'Yes, remove', },
  nothingHere: { en: 'Nothing here yet', },
  mismatchTitle: { en: 'Worth knowing', },
  mismatchHint: {
    en: 'A hotel is set up differently from the book. Nothing is blocked. This is just so you know.',

  },
  setupTitle: { en: 'Who can do what', },
  setupHint: {
    en: 'Asked once. Change it any time.',

  },
  setupGms: {
    en: 'Your GMs can read this rulebook',

  },
  setupGmsWhy: {
    en: 'Always on. People should know the policies they are governed by.',

  },
  setupChat: {
    en: 'Company leadership can ask Staxis about all hotels at once',

  },
  setupChatWhy: {
    en: 'Off until you turn it on.',

  },
  setupEditors: { en: 'Who can change the rulebook', },
  editorOwnerOnly: { en: 'The owner only', },
  editorOwnerVp: { en: 'The owner and VPs', },
  editorCompany: { en: 'Anyone with a company-wide job', },
  saved: { en: 'Saved.', },
  on: { en: 'On', },
  off: { en: 'Off', },
  loadFailed: {
    en: 'Could not load the company rulebook right now. Do not read this as "there are no rules".',

  },

  // ── What the banner says when the server refuses ──────────────────────────
  // The routes' own `error` strings are English and always will be — they are
  // the log line. The SENTENCE belongs here, because a VP who reads Spanish
  // gets the same refusal a VP who reads English does. One entry per code the
  // rulebook routes can return.
  bannerGeneric: {
    en: 'That did not work. Nothing changed. Try again in a moment.',

  },
  errAccountNotFound: {
    en: 'Staxis could not find your account. Sign out and sign back in.',

  },
  errForbidden: {
    en: 'You do not have access to this hotel.',

  },
  errNoCompany: {
    en: 'This hotel is not part of a management company, so there is no rulebook.',

  },
  errLeadershipOnly: {
    en: 'Only company leadership can change the rulebook. Nothing changed.',

  },
  errInvalidBody: {
    en: 'Staxis could not read that. Nothing changed. Try again.',

  },
  errUnknownAction: {
    en: 'Staxis did not understand that. Nothing changed.',

  },
  errUnknownCategory: {
    en: 'Pick one of the groups in the list.',

  },
  errContentRequired: {
    en: 'Write something first. A rule cannot be empty.',

  },
  errSettingsRequired: {
    en: 'Nothing to save. Pick a choice first.',

  },
  errSettingsSaveFailed: {
    en: 'Could not save that choice. Nothing changed. Try again in a moment.',

  },
  errConfirmFailed: {
    en: 'Could not confirm that. Nothing changed. Try again in a moment.',

  },
  errFactGone: {
    en: 'That line is not in the book anymore. Somebody may have removed it.',

  },
  errRemoveFailed: {
    en: 'Could not remove that. Nothing changed. Try again in a moment.',

  },
  errSaveFailed: {
    en: 'Could not save that. Nothing changed. Try again in a moment.',

  },
  errMergeFailed: {
    en: 'Could not combine those two lines. Nothing changed. Try again in a moment.',

  },
  errRevisionConflict: {
    en: 'That line changed somewhere else. The newer version was kept. Review it and try again.',

  },
  errLedgerUnavailable: {
    en: 'The company rulebook is temporarily read only. Nothing changed. Try again shortly.',

  },
  errNothingToRead: {
    en: 'Type something or add a file first.',

  },
  errFileNoText: {
    en: 'There was no text in that file for Staxis to read.',

  },
  errFileUnreadable: {
    en: 'Staxis could not read that file. Try another copy of it.',

  },
  errFileMalformed: {
    en: 'That file did not come through. Add it again.',

  },
  errNothingReadable: {
    en: 'There was nothing readable in that. Nothing was saved.',

  },
  errAiDisabled: {
    en: 'Reading with AI is turned off right now. Nothing was saved.',

  },
  errAiUnavailable: {
    en: 'Staxis could not read that just now. Nothing was saved. Try again in a moment.',

  },
  errBudget: {
    en: 'This hotel has used up its AI for today. It starts fresh at midnight.',

  },
  errRateLimited: {
    en: 'That is a lot of changes in one hour. Give it a few minutes.',

  },
  errOffline: {
    en: 'Staxis could not reach the server. Check your connection and try again.',

  },
  readNoteTruncated: {
    en: 'That file is long. Staxis read the first part of it.',

  },
  readNoteVision: {
    en: 'That looked like a scan, so Staxis read it with AI. Double-check the wording.',

  },
} as const;

// ─── Server codes → this panel's sentences ──────────────────────────────────

/**
 * Every machine code /api/company/rulebook and its intake sibling can answer
 * with. Deliberately a lookup rather than a switch on the server's English:
 * the English is a log line that can be reworded any day without anybody
 * thinking about Spanish.
 */
const BANNER_COPY = new Map<string, keyof typeof S>([
  ['account_not_found', 'errAccountNotFound'],
  ['forbidden', 'errForbidden'],
  ['no_company', 'errNoCompany'],
  ['company_leadership_only', 'errLeadershipOnly'],
  ['invalid_body', 'errInvalidBody'],
  ['unknown_action', 'errUnknownAction'],
  ['unknown_category', 'errUnknownCategory'],
  ['content_required', 'errContentRequired'],
  ['settings_required', 'errSettingsRequired'],
  ['settings_save_failed', 'errSettingsSaveFailed'],
  ['confirm_failed', 'errConfirmFailed'],
  ['fact_gone', 'errFactGone'],
  ['remove_failed', 'errRemoveFailed'],
  ['save_failed', 'errSaveFailed'],
  ['merge_failed', 'errMergeFailed'],
  ['idempotency_conflict', 'errRevisionConflict'],
  ['upstream_failure', 'errLedgerUnavailable'],
  ['nothing_to_read', 'errNothingToRead'],
  ['file_no_text', 'errFileNoText'],
  ['file_unreadable', 'errFileUnreadable'],
  ['file_malformed', 'errFileMalformed'],
  ['file_type_unsupported', 'fileWrongType'],
  ['file_too_big', 'fileTooBig'],
  ['nothing_readable', 'errNothingReadable'],
  ['ai_disabled', 'errAiDisabled'],
  ['ai_unavailable', 'errAiUnavailable'],
  ['ai_budget_exhausted', 'errBudget'],
  // NOT an envelope code. checkAndIncrementRateLimit answers with a bare
  // { error: 'rate_limited', detail } — no `ok`, no `code` — so readEnvelope
  // hands the token back in the ERROR slot and the panel used to print the
  // word "rate_limited" at a VP. Matched here, on the client, because that
  // response shape is shared by every rate-limited route in the app.
  ['rate_limited', 'errRateLimited'],
  // Set by post() below when the request never left the building.
  ['request_failed', 'errOffline'],
]);

const READ_NOTE_COPY = new Map<string, keyof typeof S>([
  ['file_truncated', 'readNoteTruncated'],
  ['file_read_with_ai', 'readNoteVision'],
]);

/**
 * The sentence for a refusal, in the reader's language.
 *
 * `code` is the server's machine-readable reason. `serverError` is its English
 * message and is used ONLY as a second lookup key, never as output — the rate
 * limiter's response is not an envelope at all, so its reason arrives in the
 * error slot with no code beside it.
 *
 * An unrecognized key — a route that grows a new code, an HTML error page from
 * the proxy — falls through to the generic bilingual line. A Spanish screen
 * must never leak an English sentence just because nobody updated this map.
 */
export function rulebookBannerText(
  code: string | undefined,
  serverError: string | undefined,
  lang: 'en' | 'es',
): string {
  const key = code ?? serverError;
  const entry = key !== undefined ? BANNER_COPY.get(key) : undefined;
  return S[entry ?? 'bannerGeneric']['en'];
}

/** How a file got read, in the reader's language. Empty when there is nothing
 *  worth saying (or the server sent a note this build does not know). */
export function rulebookReadNoteText(code: string | null | undefined, lang: 'en' | 'es'): string {
  const entry = code ? READ_NOTE_COPY.get(code) : undefined;
  return entry ? S[entry]['en'] : '';
}

/**
 * What the banner is saying.
 *
 *   failure  a refusal from the server, carried as its CODE. The server's own
 *            English stays in the log where it belongs.
 *   text     a sentence this panel owns outright — the file picker's own
 *            checks, the result of an intake, and "Saved."
 */
export type RulebookBanner =
  | { kind: 'bad'; failure: { code?: string; serverError?: string } }
  | { kind: 'good' | 'bad'; text: string };

/** The banner element. Hookless and exported so it can be rendered on its own. */
export function rulebookBannerNote(banner: RulebookBanner, lang: 'en' | 'es'): React.ReactElement {
  const text = 'failure' in banner
    ? rulebookBannerText(banner.failure.code, banner.failure.serverError, lang)
    : banner.text;
  return <div className={`cr-note ${banner.kind === 'good' ? 'cr-good' : 'cr-bad'}`}>{text}</div>;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ACCEPT =
  '.pdf,.txt,.md,.csv,.docx,application/pdf,text/plain,text/markdown,text/csv,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Resolve from the extension rather than File.type — Safari hands back "". */
function mimeForFile(file: File): string | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return EXT_MIME[ext] ?? null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// ─── Scoped styles ──────────────────────────────────────────────────────────

const CR_CSS = `
.cr-wrap{margin-bottom:30px;}
.cr-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.cr-t{font-size:16px;font-weight:600;color:#1F231C;}
.cr-lock{font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:#6F7A6F;
  background:rgba(31,35,28,.06);border-radius:999px;padding:3px 9px;}
.cr-s{font-size:12.5px;color:#6F7A6F;line-height:1.5;margin-top:4px;max-width:640px;}
.cr-box{background:#fff;border:1px solid rgba(92,122,96,.28);border-radius:18px;padding:16px 18px;margin-top:16px;
  box-shadow:0 10px 26px -20px rgba(31,42,32,.3);}
.cr-ta{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;margin-top:9px;border-radius:12px;
  border:1px solid rgba(31,35,28,.12);background:#FCFDFB;padding:10px 12px;color:#1F231C;font-size:13.5px;
  line-height:1.5;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;outline:none;}
.cr-ta:focus{border-color:rgba(92,122,96,.55);}
.cr-ta::placeholder{color:#A6ABA6;}
.cr-boxfoot{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;}
.cr-hint{font-size:11.5px;color:#8A9187;line-height:1.45;margin-top:7px;}
.cr-file{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#3E5C48;
  background:rgba(158,183,166,.18);border-radius:999px;padding:5px 11px;max-width:100%;}
.cr-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cr-note{margin-top:12px;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.5;}
.cr-note.cr-good{background:rgba(53,107,76,.09);color:#2C5740;}
.cr-note.cr-bad{background:rgba(184,92,61,.10);color:#8E432B;}
.cr-meta{display:flex;gap:14px;margin-top:12px;flex-wrap:wrap;}
.cr-metai{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;color:#8A9187;}
.cr-grp{margin-top:20px;}
.cr-grpt{font-size:14px;font-weight:600;color:#1F231C;}
.cr-grps{font-size:11.5px;color:#8A9187;margin-top:2px;}
.cr-rows{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;margin-top:9px;overflow:hidden;}
.cr-row{padding:13px 16px;border-bottom:1px solid rgba(31,35,28,.05);}
.cr-row:last-child{border-bottom:none;}
.cr-row.cr-new{background:rgba(201,150,68,.07);}
.cr-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.cr-c{font-size:13.5px;color:#1F231C;line-height:1.5;}
.cr-p{font-size:11.5px;color:#8A9187;margin-top:4px;}
.cr-read{margin-top:9px;border-left:2px solid rgba(92,122,96,.5);padding:2px 0 2px 10px;}
.cr-reade{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6F8A72;}
.cr-readl{font-size:12.5px;color:#2F3A30;line-height:1.5;margin-top:2px;}
/* "Staxis cannot read this one" — caramel, not sage. A reading and a refusal to
   read must not look like the same kind of statement. */
.cr-unsure{border-left-color:rgba(201,150,68,.7);}
.cr-unsure .cr-reade{color:#8C6A33;}
.cr-acts{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;}
.cr-act{height:30px;padding:0 12px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.cr-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.cr-act:disabled{opacity:.5;cursor:default;}
.cr-act.cr-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.cr-act.cr-yes:hover:not(:disabled){background:#4E6952;}
.cr-act.cr-danger{color:#B85C3D;}
.cr-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cr-sel{height:30px;border-radius:999px;border:1px solid rgba(31,35,28,.14);background:#fff;color:#1F231C;
  font-size:12px;padding:0 9px;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cr-empty{background:#fff;border:1px dashed rgba(92,122,96,.4);border-radius:16px;padding:20px;margin-top:16px;text-align:center;}
.cr-mis{background:rgba(201,150,68,.07);border:1px solid rgba(201,150,68,.22);border-radius:14px;
  padding:12px 14px;margin-top:16px;}
.cr-mist{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8C6A33;}
.cr-misl{font-size:12.5px;color:#5C4A25;line-height:1.55;margin-top:5px;}
.cr-setup{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;padding:14px 16px;margin-top:16px;}
.cr-setr{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:9px 0;
  border-bottom:1px solid rgba(31,35,28,.05);}
.cr-setr:last-child{border-bottom:none;}
.cr-setl{font-size:13px;color:#1F231C;line-height:1.45;}
.cr-setw{font-size:11.5px;color:#8A9187;margin-top:2px;line-height:1.45;}
`;

// ─── Component ──────────────────────────────────────────────────────────────

export function CompanyRulebookPanel({
  lang,
  /**
   * The hotel whose company this is. Defaults to whichever hotel the app is
   * showing — which is every real call site. Explicit only for a harness that
   * renders this panel outside the app shell.
   */
  propertyId,
  organizationId,
}: {
  lang: 'en' | 'es';
  propertyId?: string | null;
  /** Explicit authoritative company context used by My Portfolio. */
  organizationId?: string | null;
}) {
  const es = false;
  const L = <K extends keyof typeof S>(k: K) => S[k]['en'];

  const { activePropertyId: contextPropertyId } = useProperty();
  const activePropertyId = organizationId ? null : (propertyId ?? contextPropertyId);
  const selectorPayload = organizationId
    ? { organizationId }
    : activePropertyId
      ? { propertyId: activePropertyId }
      : null;
  const selectorQuery = organizationId
    ? `organizationId=${encodeURIComponent(organizationId)}`
    : activePropertyId
      ? `propertyId=${encodeURIComponent(activePropertyId)}`
      : null;

  // The hotel on screen tells the server which company this is. A 404 here just
  // means "this hotel is independent", which renders nothing — an independent
  // hotel must not see an empty company panel implying it has a company.
  const { data, loading, error, reload } = useApiResource<RulebookData>(
    selectorQuery ? `/api/company/rulebook?${selectorQuery}` : '',
    {
      enabled: selectorQuery !== null,
      identityKey: selectorQuery,
      keepDataOnError: true,
    },
  );

  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<RulebookBanner | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftCat, setDraftCat] = useState<CompanyCategory>('standards');
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const [settingsBusy, setSettingsBusy] = useState(false);

  // Returns readEnvelope's own result type on purpose: the previous narrower
  // signature dropped `code`, which is the only part of a refusal this panel
  // can translate.
  const post = useCallback(
    async <T,>(url: string, payload: unknown): Promise<EnvelopeResult<T>> => {
      try {
        const res = await fetchWithAuth(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
        return await readEnvelope<T>(res);
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        // The message is for the console; `code` is what the banner reads.
        return {
          error: e instanceof Error ? e.message : 'Request failed',
          code: 'request_failed',
        };
      }
    },
    [],
  );

  const pickFile = (picked: File | null) => {
    setBanner(null);
    if (!picked) { setFile(null); return; }
    if (!mimeForFile(picked)) { setBanner({ kind: 'bad', text: L('fileWrongType') }); return; }
    if (picked.size > MAX_FILE_BYTES) { setBanner({ kind: 'bad', text: L('fileTooBig') }); return; }
    setFile(picked);
  };

  const submitIntake = async () => {
    if (!selectorPayload || busy) return;
    if (!note.trim() && !file) return;
    setBusy(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = { ...selectorPayload };
      if (note.trim()) payload.note = note.trim();
      if (file) {
        payload.file = { name: file.name, mimeType: mimeForFile(file), base64: await fileToBase64(file) };
      }
      const res = await post<IntakeResult>('/api/company/rulebook/intake', payload);
      if (res.error !== undefined || !res.data) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
        return;
      }
      const added = res.data.added ?? [];
      setJustAdded(new Set(added.map((a) => a.id)));
      setNote('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      // readNoteCode, not readNote: the server's version of this sentence is
      // English, and it used to be pasted onto the end of a Spanish headline.
      const tail = rulebookReadNoteText(res.data.readNoteCode, lang);
      const headline =
        added.length === 0 ? L('intakeNothing')
          : added.length === 1 ? L('intakeDoneOne')
            : `${added.length} ${L('intakeDoneMany')}`;
      setBanner({
        kind: added.length > 0 ? 'good' : 'bad',
        text: tail ? `${headline} ${tail}` : headline,
      });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'confirm' | 'remove') => {
    if (!selectorPayload) return;
    const revision = data?.facts.find((fact) => fact.id === id)?.currentRevision ?? null;
    if (revision === null) {
      setBanner({ kind: 'bad', failure: { code: 'upstream_failure' } });
      return;
    }
    setRowBusy(id);
    try {
      const res = await post('/api/company/rulebook', {
        ...selectorPayload, action, id, expectedRevision: revision,
      });
      if (res.error !== undefined) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
      } else {
        setConfirmingRemove(null);
      }
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  /** "That's the same rule" — put these words on the line already in the book
   *  and drop this restatement. See findNearDuplicate for why this exists. */
  const mergeInto = async (id: string, intoId: string) => {
    if (!selectorPayload) return;
    const revision = data?.facts.find((fact) => fact.id === id)?.currentRevision ?? null;
    const intoRevision = data?.facts.find((fact) => fact.id === intoId)?.currentRevision ?? null;
    if (revision === null || intoRevision === null) {
      setBanner({ kind: 'bad', failure: { code: 'upstream_failure' } });
      return;
    }
    setRowBusy(id);
    try {
      const res = await post('/api/company/rulebook', {
        ...selectorPayload,
        action: 'merge',
        id,
        intoId,
        expectedRevision: revision,
        intoExpectedRevision: intoRevision,
      });
      if (res.error !== undefined) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
      }
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const saveEdit = async (id: string) => {
    if (!selectorPayload || !draft.trim()) return;
    const revision = data?.facts.find((fact) => fact.id === id)?.currentRevision ?? null;
    if (revision === null) {
      setBanner({ kind: 'bad', failure: { code: 'upstream_failure' } });
      return;
    }
    setRowBusy(id);
    try {
      const res = await post('/api/company/rulebook', {
        ...selectorPayload,
        action: 'edit',
        id,
        expectedRevision: revision,
        content: draft.trim(),
        category: draftCat,
      });
      if (res.error !== undefined) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
      } else {
        setEditing(null);
      }
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const saveSettings = async (patch: Record<string, string>) => {
    if (!selectorPayload || settingsBusy) return;
    setSettingsBusy(true);
    try {
      const res = await post('/api/company/rulebook', {
        ...selectorPayload,
        action: 'settings',
        settings: patch,
      });
      setBanner(res.error !== undefined
        ? { kind: 'bad', failure: { code: res.code, serverError: res.error } }
        : { kind: 'good', text: L('saved') });
      await reload();
    } finally {
      setSettingsBusy(false);
    }
  };

  const groups = useMemo(() => {
    const facts = data?.facts ?? [];
    return COMPANY_CATEGORIES
      .map((category) => ({ category, items: facts.filter((f) => f.category === category) }))
      .filter((g) => g.items.length > 0);
  }, [data]);

  // An independent hotel has no company. The server says so with a 404 and this
  // panel disappears entirely rather than rendering an empty book.
  if (!loading && !data) return null;
  if (!data) return null;

  const settings = data.settings;
  const canEdit = data.canEdit && settings !== undefined;
  const hasAnything = data.facts.length > 0;

  return (
    <div className="cr-wrap">
      <style dangerouslySetInnerHTML={{ __html: CR_CSS }} />

      <div className="cr-head">
        <span className="cr-t">{L('title')}</span>
        {!canEdit && <span className="cr-lock">{L('locked')}</span>}
      </div>
      <div className="cr-s">{canEdit ? L('subEdit') : L('subView')}</div>

      {canEdit && (
        <div className="cr-box">
          <div className="cx-dec-eyebrow">{L('boxEyebrow')}</div>
          <textarea
            className="cr-ta"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={L('boxPlaceholder')}
            aria-label={L('boxEyebrow')}
            maxLength={8000}
          />
          <div className="cr-boxfoot">
            <button type="button" className="cr-act" onClick={() => fileRef.current?.click()} disabled={busy}>
              {L('addFile')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <span className="cr-file">
                <CxIcon name="inventory" size={13} />
                <span>{file.name}</span>
                <button
                  type="button"
                  className="cr-act"
                  style={{ height: 22, padding: '0 8px', border: 'none' }}
                  onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
                  aria-label={L('removeFile')}
                >
                  ×
                </button>
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="cr-act cr-yes"
              onClick={submitIntake}
              disabled={busy || (!note.trim() && !file)}
            >
              {busy ? L('submitting') : L('submit')}
            </button>
          </div>
          <div className="cr-hint">{L('boxHint')}</div>
        </div>
      )}

      {banner && rulebookBannerNote(banner, lang)}
      {error && <div className="cr-note cr-bad">{L('loadFailed')}</div>}

      <div className="cr-meta">
        <span className="cr-metai">{data.stats.totalKnown} {L('known')}</span>
        {typeof data.stats.hotelsCovered === 'number' && (
          <span className="cr-metai">
            {data.stats.hotelsCovered === 1
              ? L('coversOne')
              : `${data.stats.hotelsCovered} ${L('coversMany')}`}
          </span>
        )}
        {(data.stats.pendingReview ?? 0) > 0 && (
          <span className="cr-metai" style={{ color: '#8C6A33' }}>
            {data.stats.pendingReview} {L('pending')}
          </span>
        )}
      </div>

      {/* Quiet FYI. Never an enforcement, never a claim about the world — only
          where two structured settings genuinely disagree. */}
      {(data.contradictions?.length ?? 0) > 0 && (
        <div className="cr-mis">
          <div className="cr-mist">{L('mismatchTitle')}</div>
          {(data.contradictions ?? []).map((c) => (
            <div className="cr-misl" key={`${c.propertyId}:${c.key}`}>{c.line['en']}</div>
          ))}
          <div className="cr-setw" style={{ marginTop: 6 }}>{L('mismatchHint')}</div>
        </div>
      )}

      {!hasAnything && (
        <div className="cr-empty">
          <div className="cx-dec-t">{canEdit ? L('emptyTitle') : L('emptyView')}</div>
          {canEdit && (
            <div className="cx-dec-s" style={{ maxWidth: 470, margin: '6px auto 0' }}>{L('emptyBody')}</div>
          )}
        </div>
      )}

      {groups.map((g) => {
        const label = COMPANY_CATEGORY_LABELS[g.category];
        return (
          <div className="cr-grp" key={g.category}>
            <div className="cr-grpt">{label.title['en']}</div>
            <div className="cr-grps">{label.hint['en']}</div>
            <div className="cr-rows">
              {g.items.map((f) => {
                const unreviewed = f.reviewState === 'unreviewed';
                const isEditing = editing === f.id;
                const disabled = rowBusy === f.id;
                const reading = f.reading.authority ?? f.reading.policy;
                const ambiguous = f.reading.ambiguousAuthority ?? null;
                const dupe = unreviewed ? (f.nearDuplicateOf ?? null) : null;
                return (
                  <div className={`cr-row${justAdded.has(f.id) ? ' cr-new' : ''}`} key={f.id}>
                    <div className="cr-top">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {isEditing ? (
                          <>
                            <textarea
                              className="cr-ta"
                              style={{ marginTop: 0, minHeight: 62 }}
                              value={draft}
                              maxLength={500}
                              onChange={(e) => setDraft(e.target.value)}
                              aria-label={L('edit')}
                            />
                            <select
                              className="cr-sel"
                              style={{ marginTop: 8 }}
                              value={draftCat}
                              onChange={(e) => setDraftCat(e.target.value as CompanyCategory)}
                              aria-label={L('edit')}
                            >
                              {COMPANY_CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {COMPANY_CATEGORY_LABELS[c].title['en']}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <>
                            <div className="cr-c">{f.content}</div>
                            {f.createdByName && <div className="cr-p">{f.createdByName}</div>}
                          </>
                        )}
                      </div>
                      <span className={`cx-bdg ${unreviewed ? 'cx-warn' : 'cx-ok'}`}>
                        {unreviewed ? L('pending') : L('known')}
                      </span>
                    </div>

                    {/* The structured reading. Before confirming, this is the
                        question the person answers; after, it is the receipt of
                        what is actually in force. */}
                    {!isEditing && reading && (
                      <div className="cr-read">
                        <div className="cr-reade">
                          {unreviewed
                            ? L('readingConfirm')
                            : (f.reading.authority ? L('ruleFrozen') : L('readingEyebrow'))}
                        </div>
                        <div className="cr-readl">{reading.line['en']}</div>
                      </div>
                    )}

                    {/* Two approvers named, no rule stored. Shown whether the
                        line is confirmed or not: a confirmed sentence that
                        SOUNDS like a money rule and enforces nothing is exactly
                        the thing a VP must not have to guess about. */}
                    {!isEditing && ambiguous && (
                      <div className="cr-read cr-unsure">
                        <div className="cr-reade">{L('readingUnsure')}</div>
                        <div className="cr-readl">{ambiguous.line['en']}</div>
                      </div>
                    )}

                    {!isEditing && dupe && (
                      <div className="cr-read cr-unsure">
                        <div className="cr-reade">{L('dupeEyebrow')}</div>
                        <div className="cr-readl">{dupe.line['en']}</div>
                      </div>
                    )}

                    {canEdit && (
                      <div className="cr-acts">
                        {isEditing ? (
                          <>
                            <button
                              type="button" className="cr-act cr-yes" disabled={disabled || !draft.trim()}
                              onClick={() => saveEdit(f.id)}
                            >
                              {L('save')}
                            </button>
                            <button type="button" className="cr-act" onClick={() => setEditing(null)}>
                              {L('cancel')}
                            </button>
                          </>
                        ) : confirmingRemove === f.id ? (
                          <>
                            <span style={{ fontSize: 12, color: '#8E432B', alignSelf: 'center' }}>
                              {L('removeSure')}
                            </span>
                            <button
                              type="button" className="cr-act cr-danger" disabled={disabled}
                              onClick={() => act(f.id, 'remove')}
                            >
                              {L('removeYes')}
                            </button>
                            <button type="button" className="cr-act" onClick={() => setConfirmingRemove(null)}>
                              {L('cancel')}
                            </button>
                          </>
                        ) : (
                          <>
                            {/* A restatement gets a CHOICE rather than a
                                Confirm: fold it into the line already in the
                                book, or keep both. "Keep both" is a real
                                answer — the match is a heuristic over English
                                and must never swallow a genuinely new rule. */}
                            {unreviewed && dupe && (
                              <button
                                type="button" className="cr-act cr-yes" disabled={disabled}
                                onClick={() => mergeInto(f.id, dupe.id)}
                              >
                                {L('dupeUpdate')}
                              </button>
                            )}
                            {unreviewed && (
                              <button
                                type="button" className="cr-act cr-yes" disabled={disabled}
                                onClick={() => act(f.id, 'confirm')}
                                style={dupe ? { background: 'transparent', borderColor: 'rgba(31,35,28,.14)', color: '#5C625C' } : undefined}
                              >
                                {dupe ? L('dupeKeepBoth') : L('confirm')}
                              </button>
                            )}
                            <button
                              type="button" className="cr-act" disabled={disabled}
                              onClick={() => { setEditing(f.id); setDraft(f.content); setDraftCat(f.category); }}
                            >
                              {L('edit')}
                            </button>
                            <button
                              type="button" className="cr-act cr-danger" disabled={disabled}
                              onClick={() => setConfirmingRemove(f.id)}
                            >
                              {L('remove')}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ── Who can do what. Only the people who own the book get asked. ── */}
      {canEdit && settings && (
        <div className="cr-setup">
          <div className="cr-grpt">{L('setupTitle')}</div>
          <div className="cr-grps">{L('setupHint')}</div>

          <div className="cr-setr">
            <div>
              <div className="cr-setl">{L('setupGms')}</div>
              <div className="cr-setw">{L('setupGmsWhy')}</div>
            </div>
            <span className="cx-bdg cx-ok">{L('on')}</span>
          </div>

          <div className="cr-setr">
            <div>
              <div className="cr-setl">{L('setupChat')}</div>
              <div className="cr-setw">{L('setupChatWhy')}</div>
            </div>
            <button
              type="button"
              className={`cr-act${settings.cross_hotel_ai_chat === 'true' ? ' cr-yes' : ''}`}
              disabled={settingsBusy}
              aria-pressed={settings.cross_hotel_ai_chat === 'true'}
              onClick={() => saveSettings({
                cross_hotel_ai_chat: settings.cross_hotel_ai_chat === 'true' ? 'false' : 'true',
              })}
            >
              {settings.cross_hotel_ai_chat === 'true' ? L('on') : L('off')}
            </button>
          </div>

          <div className="cr-setr">
            <div className="cr-setl">{L('setupEditors')}</div>
            <select
              className="cr-sel"
              disabled={settingsBusy}
              value={settings.rulebook_editors ?? 'owner_and_vp'}
              aria-label={L('setupEditors')}
              onChange={(e) => saveSettings({ rulebook_editors: e.target.value })}
            >
              <option value="owner_only">{L('editorOwnerOnly')}</option>
              <option value="owner_and_vp">{L('editorOwnerVp')}</option>
              <option value="company_scope">{L('editorCompany')}</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
