'use client';

// ═══════════════════════════════════════════════════════════════════════════
// KnowsView — "here is what I know, here is where I learned it, tell me if
// I'm wrong." The second view in the Staxis section, beside the approvals
// queue.
//
// TWO HALVES, DELIBERATELY NOT MIXED
//   Figured out on its own  what Staxis INFERRED — facts grouped into five
//                           buckets, each carrying its provenance in plain
//                           English and three actions: Confirm, Edit, Remove.
//                           Plus an open box: type a sentence or drop in a
//                           file, and it becomes facts you then approve.
//   What you've told it     what a human ASSERTED — the contact directory,
//                           the written procedures, and the document cabinet
//                           the copilot reads. Ported here from the
//                           Communications section (see ToldView.tsx).
//
// The halves are two exclusive panes behind one control and never interleave,
// because a manager must always be able to tell an inference from an
// assertion. Their access rules differ too, and that is the point:
// the inferred half is a manager view; the told half is NOT, because in
// Communications every signed-in person could reach the emergency numbers and
// moving the directory here must not quietly take that away. See canReadTold /
// canReadLearned in told-knowledge.ts.
//
// HONESTY RULES THIS SCREEN LIVES BY
//   • A brand-new hotel has zero facts. The empty state invites input; it
//     never renders a green "all clear" or implies knowledge that isn't there.
//   • A fact pulled out of something you typed or uploaded shows as NOT
//     CONFIRMED and is not used by the copilot until you say so. That is
//     enforced in the database (migration 0358), not just labelled here.
//   • Remove is permanent, and the copy says so.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAuth, type AppUser } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { useReportedValue } from '@/lib/hooks/use-reported-value';
import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
  SessionEndedError,
} from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import {
  CATEGORY_LABELS,
  MEMORY_CATEGORIES,
  factStatus,
  groupFactsByCategory,
  provenanceLine,
  statusLabel,
  type MemoryCategory,
} from '@/lib/agent/memory-facets';
import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';
import { CompanyRulebookPanel } from './CompanyRulebookPanel';
import { ToldView, ToldStyle } from './ToldView';
import { canReadLearned, defaultHalf, type KnowsHalf } from './told-knowledge';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Fact {
  id: string;
  topic: string;
  content: string;
  category: MemoryCategory;
  source: string;
  reviewState: 'unreviewed' | 'confirmed';
  createdByName: string | null;
  updatedAt: string;
  expiresAt: string | null;
}

interface KnowsData {
  stats: { totalKnown: number; patternsThisMonth: number; issuesCaughtEarly: number; pendingReview: number };
  facts: Fact[];
}

interface IntakeResult {
  added: Array<{ id: string; topic: string; content: string; category: string }>;
  skipped: number;
  /** English, from the server. Kept for compatibility; NOT rendered — see
   *  readNoteCode, which is the same fact in a form this screen can translate. */
  readNote: string | null;
  readNoteCode: string | null;
  nothingFound: boolean;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

const S = {
  title: { en: 'What Staxis knows', },
  sub: {
    en: 'Two kinds of knowledge, kept apart on purpose: what Staxis worked out by itself, and what your team has told it.',

  },

  // ── The two halves ────────────────────────────────────────────────────────
  // Named so nobody has to be told which is which. "Figured out on its own"
  // is a guess Staxis made and may be wrong; "What you've told it" is a person
  // vouching. Mixing them in one list would erase that difference.
  halfLearned: { en: 'Figured out on its own', },
  halfTold: { en: 'What you’ve told it', },
  learnedSub: {
    en: 'Everything Staxis believes about your hotel, and where it learned it. Tell it if it is wrong.',

  },
  toldSub: {
    en: 'Contacts, procedures, and documents your team wrote or uploaded. Staxis answers from these.',

  },
  boxEyebrow: { en: 'Tell Staxis about your hotel', },
  boxPlaceholder: {
    en: 'Anything at all: how things run, who to call, what keeps breaking.',

  },
  boxHint: {
    en: 'Optional. Or drop in a file you already have: a vendor list, a house rules sheet, an SOP.',

  },
  addFile: { en: 'Add a file', },
  removeFile: { en: 'Remove file', },
  submit: { en: 'Add this', },
  submitting: { en: 'Reading…', },
  intakeDoneOne: {
    en: '1 fact added below. Check it before Staxis uses it.',

  },
  intakeDoneMany: {
    en: 'facts added below. Check each one before Staxis uses it.',

  },
  intakeNothing: {
    en: 'Nothing lasting in that one. Nothing was saved.',

  },
  fileTooBig: { en: 'That file is too big. Keep it under 4MB.', },
  fileWrongType: {
    en: 'Staxis can read PDF, Word, and plain text files.',

  },
  emptyTitle: { en: 'Staxis does not know anything about your hotel yet', },
  emptyBody: {
    en: 'That is expected on day one. Tell it something above. One sentence is enough to start. It also learns on its own from what your team logs.',

  },
  confirm: { en: 'Confirm', },
  edit: { en: 'Edit', },
  remove: { en: 'Remove', },
  save: { en: 'Save', },
  cancel: { en: 'Cancel', },
  removeSure: {
    en: 'Remove for good? Staxis will not learn this again on its own.',

  },
  removeYes: { en: 'Yes, remove', },
  nothingHere: { en: 'Nothing here yet', },
  // Scoped to the LEARNED half only. The told half beside it is open to
  // everyone, so this points there rather than dead-ending the reader.
  managerOnly: {
    en: 'What Staxis has figured out on its own is a manager view. Ask your manager to open it. The contacts, procedures, and documents next door are open to you.',

  },
  loadFailed: {
    en: 'Could not load what Staxis knows right now. Do not read this as "it knows nothing".',

  },
  pending: { en: 'waiting for you', },
  known: { en: 'confirmed', },

  // ── What the banner says when the server refuses ──────────────────────────
  // The routes' own `error` strings are English and always will be — they are
  // the log line. The SENTENCE is this screen's job, because the person reading
  // it may only read Spanish. One entry per code the Knows routes can return.
  bannerGeneric: {
    en: 'That did not work. Nothing changed. Try again in a moment.',

  },
  errAccountNotFound: {
    en: 'Staxis could not find your account. Sign out and sign back in.',

  },
  errForbidden: {
    en: 'You do not have access to this hotel.',

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
    en: 'Write something first. A fact cannot be empty.',

  },
  errConfirmFailed: {
    en: 'Could not confirm that. Nothing changed. Try again in a moment.',

  },
  errFactGone: {
    en: 'That one is not here anymore. Somebody may have removed it.',

  },
  errRemoveFailed: {
    en: 'Could not remove that. Nothing changed. Try again in a moment.',

  },
  errSaveFailed: {
    en: 'Could not save that. Nothing changed. Try again in a moment.',

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
    en: 'Your hotel has used up its AI for today. It starts fresh at midnight.',

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

// ─── Server codes → this screen's sentences ─────────────────────────────────

/**
 * Every machine code /api/memory/knows and its intake sibling can answer with.
 * Deliberately a lookup rather than a switch on the server's English: the
 * English is a log line that can be reworded any day without anybody thinking
 * about Spanish.
 */
const BANNER_COPY = new Map<string, keyof typeof S>([
  ['account_not_found', 'errAccountNotFound'],
  ['forbidden', 'errForbidden'],
  ['invalid_body', 'errInvalidBody'],
  ['unknown_action', 'errUnknownAction'],
  ['unknown_category', 'errUnknownCategory'],
  ['content_required', 'errContentRequired'],
  ['confirm_failed', 'errConfirmFailed'],
  ['fact_gone', 'errFactGone'],
  ['remove_failed', 'errRemoveFailed'],
  ['save_failed', 'errSaveFailed'],
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
  // hands the token back in the ERROR slot and the screen used to print the
  // word "rate_limited" at the manager. Matched here, on the client, because
  // that response shape is shared by every rate-limited route in the app.
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
export function knowsBannerText(
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
export function knowsReadNoteText(code: string | null | undefined, lang: 'en' | 'es'): string {
  const entry = code ? READ_NOTE_COPY.get(code) : undefined;
  return entry ? S[entry]['en'] : '';
}

/**
 * What the banner is saying.
 *
 *   failure  a refusal from the server, carried as its CODE. The server's own
 *            English stays in the log where it belongs.
 *   text     a sentence this screen owns outright — the file picker's own
 *            checks, and the result of an intake.
 */
export type KnowsBanner =
  | { kind: 'bad'; failure: { code?: string; serverError?: string } }
  | { kind: 'good' | 'bad'; text: string };

/** The banner element. Hookless and exported so it can be rendered on its own. */
export function knowsBannerNote(banner: KnowsBanner, lang: 'en' | 'es'): React.ReactElement {
  const text = 'failure' in banner
    ? knowsBannerText(banner.failure.code, banner.failure.serverError, lang)
    : banner.text;
  return <div className={`kn-note ${banner.kind === 'good' ? 'kn-good' : 'kn-bad'}`}>{text}</div>;
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

/**
 * Resolve the media type from the extension rather than trusting File.type —
 * Safari hands back an empty type for several of these, and the server
 * allow-lists on the value we send. Same approach the invoice scanner takes.
 */
function mimeForFile(file: File): string | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return EXT_MIME[ext] ?? null;
}

/** Read a File as base64 with no data: prefix (mirrors the invoice scanner). */
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

const KN_CSS = `
.kn-box{background:#fff;border:1px solid rgba(92,122,96,.28);border-radius:18px;padding:16px 18px;margin-top:20px;
  box-shadow:0 10px 26px -20px rgba(31,42,32,.3);}
.kn-ta{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;margin-top:9px;border-radius:12px;
  border:1px solid rgba(31,35,28,.12);background:#FCFDFB;padding:10px 12px;color:#1F231C;font-size:13.5px;
  line-height:1.5;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;outline:none;}
.kn-ta:focus{border-color:rgba(92,122,96,.55);}
.kn-ta::placeholder{color:#A6ABA6;}
.kn-boxfoot{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;}
.kn-hint{font-size:11.5px;color:#8A9187;line-height:1.45;margin-top:7px;}
.kn-file{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#3E5C48;
  background:rgba(158,183,166,.18);border-radius:999px;padding:5px 11px;max-width:100%;}
.kn-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kn-note{margin-top:12px;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.5;}
.kn-note.kn-good{background:rgba(53,107,76,.09);color:#2C5740;}
.kn-note.kn-bad{background:rgba(184,92,61,.10);color:#8E432B;}
.kn-grp{margin-top:26px;}
.kn-grph{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}
.kn-grpt{font-size:15px;font-weight:600;color:#1F231C;}
.kn-grpc{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#A6ABA6;}
.kn-grps{font-size:11.5px;color:#8A9187;margin-top:2px;}
.kn-rows{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;margin-top:10px;overflow:hidden;}
.kn-row{padding:13px 16px;border-bottom:1px solid rgba(31,35,28,.05);}
.kn-row:last-child{border-bottom:none;}
.kn-row.kn-new{background:rgba(201,150,68,.07);}
.kn-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.kn-c{font-size:13.5px;color:#1F231C;line-height:1.5;}
.kn-p{font-size:11.5px;color:#8A9187;margin-top:4px;}
.kn-acts{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;}
.kn-act{height:30px;padding:0 12px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.kn-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.kn-act:disabled{opacity:.5;cursor:default;}
.kn-act.kn-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.kn-act.kn-yes:hover:not(:disabled){background:#4E6952;}
.kn-act.kn-danger{color:#B85C3D;}
.kn-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.kn-empty{background:#fff;border:1px dashed rgba(92,122,96,.4);border-radius:16px;padding:22px 20px;margin-top:22px;text-align:center;}
.kn-sel{height:30px;border-radius:999px;border:1px solid rgba(31,35,28,.14);background:#fff;color:#1F231C;
  font-size:12px;padding:0 9px;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.kn-meta{display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;}
.kn-metai{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;color:#8A9187;}
/* The inferred/asserted switch, and the line under it that says which one you
   are looking at. The label alone does the work — no colour coding, because
   the distinction has to survive being printed or read by somebody colour
   blind. */
.kn-halves{width:fit-content;max-width:100%;overflow-x:auto;margin-top:20px;}
.kn-halfsub{font-size:12.5px;color:#8A9187;margin-top:14px;line-height:1.5;max-width:580px;}
`;

// ─── Component ──────────────────────────────────────────────────────────────

export function KnowsView({ lang, onStats }: {
  lang: 'en' | 'es';
  /** Told how many facts the read returned, so a caller can label its own
   *  entry point without asking the server a second time. */
  onStats?: (totalKnown: number) => void;
}) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const scopeKey = `${user?.uid ?? 'signed-out'}:${activePropertyId ?? 'no-property'}`;

  // Every draft, file, confirmation and busy flag below belongs to one exact
  // viewer+hotel. Remount synchronously on either identity change so text typed
  // for Hotel A can never be submitted after the shell switches to Hotel B.
  return (
    <KnowsPropertyView
      key={scopeKey}
      lang={lang}
      user={user}
      propertyId={activePropertyId}
      scopeKey={scopeKey}
      onStats={onStats}
    />
  );
}

/**
 * Knows as a right-hand SLIDE-OVER, which is how /feed reaches it.
 *
 * ─── why this is an overlay and not a tab or a route ───────────────────────
 * It used to be half of a `Queue` / `Knows` toggle at the top of the page. That
 * pair was rejected outright in the 2026-08-01 design: it put "what Staxis has
 * noticed" and "what Staxis believes" at the same weight, so half the time the
 * screen a manager came for was the one they were not looking at. There is now
 * one button, in the rail, and the page stays mounted underneath — Knows is
 * never somewhere you have to navigate back from.
 *
 * Escape and a click on the scrim both close it, because a panel with only one
 * exit is a panel people stop opening.
 */
export function KnowsPanel({ open, lang, hotelName, onClose, onStats }: {
  open: boolean;
  lang: 'en' | 'es';
  hotelName?: string | null;
  onClose: () => void;
  onStats?: (totalKnown: number) => void;
}) {
  const [factCount, setFactCount] = useState<number | null>(null);
  const report = useCallback((total: number) => {
    setFactCount(total);
    onStats?.(total);
  }, [onStats]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sub = [
    factCount === null ? null : factCount === 1 ? '1 fact' : `${factCount.toLocaleString('en-US')} facts`,
    hotelName,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <button type="button" className="fx-scrim" aria-label="Close what Staxis knows" onClick={onClose} />
      <div className="fx-drawer" role="dialog" aria-modal="true" aria-label={S.title.en}>
        <div className="fx-drawerhead">
          <span className="fx-draweri" aria-hidden><CxIcon name="staxis" size={16} /></span>
          <div style={{ minWidth: 0 }}>
            <div className="fx-drawert">{S.title.en}</div>
            {sub && <div className="fx-drawers">{sub}</div>}
          </div>
          <button type="button" className="fx-drawerx" aria-label="Close" onClick={onClose}>
            <CxIcon name="close" size={14} />
          </button>
        </div>
        <div className="fx-drawerbody">
          <KnowsView lang={lang} onStats={report} />
        </div>
      </div>
    </>
  );
}

function KnowsPropertyView({
  lang,
  user,
  propertyId,
  scopeKey,
  onStats,
}: {
  lang: 'en' | 'es';
  user: AppUser | null;
  propertyId: string | null;
  scopeKey: string;
  onStats?: (totalKnown: number) => void;
}) {
  const es = false;
  const L = <K extends keyof typeof S>(k: K) => S[k]['en'];

  const canSee = canReadLearned(user?.role);

  // Which half is open. `null` means "nobody has chosen yet", so the default
  // is derived from the role LIVE rather than frozen at first render — `user`
  // arrives asynchronously, and freezing it would land every manager on the
  // told half just because auth had not resolved yet. An explicit tap wins
  // from then on.
  const [chosenHalf, setChosenHalf] = useState<KnowsHalf | null>(null);
  const half: KnowsHalf = chosenHalf ?? defaultHalf(user?.role);

  const { data, loading, error, reload } = useApiResource<KnowsData>(
    `/api/memory/knows?propertyId=${propertyId}`,
    { enabled: canSee && !!propertyId, keepDataOnError: true },
  );

  // Reported through the ref hook rather than a bare effect: a caller passing
  // an inline arrow would otherwise turn this into a render loop. Same edge,
  // same fix, as FindingCards' readState. `null` until the read lands, so
  // nobody can label a button with a count nothing has answered yet.
  useReportedValue(data ? data.stats.totalKnown : null, (total) => {
    if (total !== null) onStats?.(total);
  });

  // Open box
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<KnowsBanner | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Per-row UI state
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftCat, setDraftCat] = useState<MemoryCategory>('rhythm');
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const activeScopeRef = useRef<string | null>(scopeKey);
  React.useEffect(() => {
    activeScopeRef.current = scopeKey;
    return () => {
      if (activeScopeRef.current === scopeKey) activeScopeRef.current = null;
    };
  }, [scopeKey]);
  const ownsScope = useCallback(
    () => activeScopeRef.current === scopeKey,
    [scopeKey],
  );

  // Returns readEnvelope's own result type on purpose: the previous narrower
  // signature dropped `code`, which is the only part of a refusal this screen
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
    if (!propertyId || busy) return;
    if (!note.trim() && !file) return;
    setBusy(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = { propertyId };
      if (note.trim()) payload.note = note.trim();
      if (file) {
        payload.file = {
          name: file.name,
          mimeType: mimeForFile(file),
          base64: await fileToBase64(file),
        };
      }
      if (!ownsScope()) return;
      const res = await post<IntakeResult>('/api/memory/knows/intake', payload);
      if (!ownsScope()) return;
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
      const tail = knowsReadNoteText(res.data.readNoteCode, lang);
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
      if (ownsScope()) setBusy(false);
    }
  };

  const act = async (id: string, action: 'confirm' | 'remove') => {
    if (!propertyId) return;
    setRowBusy(id);
    try {
      const res = await post('/api/memory/knows', { propertyId, action, id });
      if (!ownsScope()) return;
      if (res.error !== undefined) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
      } else {
        setConfirmingRemove(null);
      }
      await reload();
    } finally {
      if (ownsScope()) setRowBusy(null);
    }
  };

  const saveEdit = async (id: string) => {
    if (!propertyId || !draft.trim()) return;
    setRowBusy(id);
    try {
      const res = await post('/api/memory/knows', {
        propertyId,
        action: 'edit',
        id,
        content: draft.trim(),
        category: draftCat,
      });
      if (!ownsScope()) return;
      if (res.error !== undefined) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
      } else {
        setEditing(null);
      }
      await reload();
    } finally {
      if (ownsScope()) setRowBusy(null);
    }
  };

  const groups = useMemo(() => groupFactsByCategory(data?.facts ?? []), [data]);
  const hasAnything = (data?.facts.length ?? 0) > 0;

  // ── The company's own book, one level up ──
  // Renders NOTHING for an independent hotel (the route 404s and the panel
  // returns null), so nothing about a single-hotel customer's screen changes.
  // For a management company it sits ABOVE the hotel's facts — the same order
  // the copilot reads them in, where the hotel wins.
  //
  // ⚠️ IT IS OUTSIDE THE MANAGER GATE ON PURPOSE, and this is the whole reason
  // it is a variable instead of one line of JSX. `canSee` reads
  // `accounts.role`, and the company vocabulary degrades least-privilege into
  // that column — a `finance` hat carries a legacy role of `front_desk`, and a
  // `vp` hat only lands on a manager word by convention. So the people the
  // company's own `rulebook_editors` setting NAMES were bounced to
  // "managers only" and never saw the book they are the only ones allowed to
  // write. The panel is self-gating: /api/company/rulebook resolves standing
  // from the caller's hats at that company and the panel renders null on a
  // refusal, so nobody who could not see it before can see it now. What stays
  // manager-only is the HOTEL's own knowledge base below.
  const companyBook = <CompanyRulebookPanel lang={lang} />;

  // The page chrome both halves share. A plain render helper, not a component:
  // it holds no state, so inlining it would only duplicate the header three
  // times. The half switch lives here so it is in the same place whichever
  // half you are on, and whoever you are.
  const shell = (body: React.ReactNode) => (
    <div className="cx-page cx-swap">
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: KN_CSS }} />
      <ToldStyle />

      {companyBook}

      <div className="cx-ptitle" style={{ marginTop: 0 }}>{L('title')}</div>
      <div className="cx-psub">{L('sub')}</div>

      <div className="cx-seg kn-halves" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={half === 'learned'}
          className={half === 'learned' ? 'cx-on' : ''}
          onClick={() => setChosenHalf('learned')}
        >
          {L('halfLearned')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={half === 'told'}
          className={half === 'told' ? 'cx-on' : ''}
          onClick={() => setChosenHalf('told')}
        >
          {L('halfTold')}
        </button>
      </div>

      {body}
    </div>
  );

  // What a person told it. Open to everyone signed in — see canReadTold.
  if (half === 'told') {
    return shell(
      <>
        <div className="kn-halfsub">{L('toldSub')}</div>
        <ToldView lang={lang} />
      </>,
    );
  }

  // What it worked out by itself. Still a manager view, and the note now
  // points at the half that is open to the reader instead of dead-ending.
  if (!canSee) return shell(<div className="kn-halfsub">{L('managerOnly')}</div>);

  return shell(
    <>
      <div className="kn-halfsub">{L('learnedSub')}</div>

      {/* ── The open box ── */}
      <div className="kn-box">
        <div className="cx-dec-eyebrow">{L('boxEyebrow')}</div>
        <textarea
          className="kn-ta"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={L('boxPlaceholder')}
          aria-label={L('boxEyebrow')}
          maxLength={8000}
        />
        <div className="kn-boxfoot">
          <button
            type="button"
            className="kn-act"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
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
            <span className="kn-file">
              <CxIcon name="inventory" size={13} />
              <span>{file.name}</span>
              <button
                type="button"
                className="kn-act"
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
            className="kn-act kn-yes"
            onClick={submitIntake}
            disabled={busy || (!note.trim() && !file)}
          >
            {busy ? L('submitting') : L('submit')}
          </button>
        </div>
        <div className="kn-hint">{L('boxHint')}</div>
      </div>

      {banner && knowsBannerNote(banner, lang)}

      {/* An error must never look like "your hotel has no facts". */}
      {error && !data && <div className="kn-note kn-bad">{L('loadFailed')}</div>}

      {data && (
        <div className="kn-meta">
          <span className="kn-metai">{data.stats.totalKnown} {L('known')}</span>
          {data.stats.pendingReview > 0 && (
            <span className="kn-metai" style={{ color: '#8C6A33' }}>
              {data.stats.pendingReview} {L('pending')}
            </span>
          )}
        </div>
      )}

      {!loading && data && !hasAnything && (
        <div className="kn-empty">
          <div className="cx-dec-t">{L('emptyTitle')}</div>
          <div className="cx-dec-s" style={{ maxWidth: 470, margin: '6px auto 0' }}>{L('emptyBody')}</div>
        </div>
      )}

      {hasAnything &&
        groups.map((g) => {
          const label = CATEGORY_LABELS[g.category];
          return (
            <div className="kn-grp" key={g.category}>
              <div className="kn-grph">
                <span className="kn-grpt">{label.title['en']}</span>
                <span className="kn-grpc">{g.items.length}</span>
              </div>
              <div className="kn-grps">{label.hint['en']}</div>

              {g.items.length === 0 ? (
                <div className="kn-rows">
                  <div className="kn-row" style={{ color: '#A6ABA6', fontSize: 12.5 }}>{L('nothingHere')}</div>
                </div>
              ) : (
                <div className="kn-rows">
                  {g.items.map((f) => {
                    const status = factStatus({ reviewState: f.reviewState, expiresAt: f.expiresAt });
                    const badgeClass =
                      status.kind === 'unreviewed' ? 'cx-warn' : status.kind === 'expiring' ? 'cx-mut' : 'cx-ok';
                    const isEditing = editing === f.id;
                    const disabled = rowBusy === f.id;
                    return (
                      <div className={`kn-row${justAdded.has(f.id) ? ' kn-new' : ''}`} key={f.id}>
                        <div className="kn-top">
                          <div style={{ minWidth: 0, flex: 1 }}>
                            {isEditing ? (
                              <>
                                <textarea
                                  className="kn-ta"
                                  style={{ marginTop: 0, minHeight: 62 }}
                                  value={draft}
                                  maxLength={500}
                                  onChange={(e) => setDraft(e.target.value)}
                                  aria-label={L('edit')}
                                />
                                <select
                                  className="kn-sel"
                                  style={{ marginTop: 8 }}
                                  value={draftCat}
                                  onChange={(e) => setDraftCat(e.target.value as MemoryCategory)}
                                  aria-label={L('edit')}
                                >
                                  {MEMORY_CATEGORIES.map((c) => (
                                    <option key={c} value={c}>{CATEGORY_LABELS[c].title['en']}</option>
                                  ))}
                                </select>
                              </>
                            ) : (
                              <>
                                <div className="kn-c">{f.content}</div>
                                <div className="kn-p">
                                  {provenanceLine(
                                    {
                                      source: f.source,
                                      topic: f.topic,
                                      createdByName: f.createdByName,
                                      updatedAt: f.updatedAt,
                                    },
                                    lang,
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                          <span className={`cx-bdg ${badgeClass}`}>{statusLabel(status, lang)}</span>
                        </div>

                        <div className="kn-acts">
                          {isEditing ? (
                            <>
                              <button
                                type="button" className="kn-act kn-yes" disabled={disabled || !draft.trim()}
                                onClick={() => saveEdit(f.id)}
                              >
                                {L('save')}
                              </button>
                              <button type="button" className="kn-act" onClick={() => setEditing(null)}>
                                {L('cancel')}
                              </button>
                            </>
                          ) : confirmingRemove === f.id ? (
                            <>
                              <span style={{ fontSize: 12, color: '#8E432B', alignSelf: 'center' }}>
                                {L('removeSure')}
                              </span>
                              <button
                                type="button" className="kn-act kn-danger" disabled={disabled}
                                onClick={() => act(f.id, 'remove')}
                              >
                                {L('removeYes')}
                              </button>
                              <button type="button" className="kn-act" onClick={() => setConfirmingRemove(null)}>
                                {L('cancel')}
                              </button>
                            </>
                          ) : (
                            <>
                              {status.kind !== 'confirmed' && (
                                <button
                                  type="button" className="kn-act kn-yes" disabled={disabled}
                                  onClick={() => act(f.id, 'confirm')}
                                >
                                  {L('confirm')}
                                </button>
                              )}
                              <button
                                type="button" className="kn-act" disabled={disabled}
                                onClick={() => { setEditing(f.id); setDraft(f.content); setDraftCat(f.category); }}
                              >
                                {L('edit')}
                              </button>
                              <button
                                type="button" className="kn-act kn-danger" disabled={disabled}
                                onClick={() => setConfirmingRemove(f.id)}
                              >
                                {L('remove')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
    </>,
  );
}
