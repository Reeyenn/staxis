'use client';

// ═══════════════════════════════════════════════════════════════════════════
// What Staxis knows — ONE page.
//
// One button on top: "Teach it something". One list underneath, in two groups.
// Every row is one plain sentence. That is the whole screen.
//
// ─── WHAT THIS REPLACED, AND WHY ───────────────────────────────────────────
// Until the 2026-08-05 rebuild this was a filing cabinet: two half-tabs, four
// section tabs inside one of them, a fact counter, five category headings with
// hint lines under each, and a Confirm / Edit / Remove trio on every row. Six
// buttons of navigation before you could say anything, and a manager had to
// know which drawer a sentence belonged in before they could put it away.
// Founder's verdict: "too many words, too many titles, too much random
// bullshit."
//
// So the drawers did not move; the SCREEN collapsed onto them. A person types
// a sentence, Staxis decides which of five stores it belongs in (see
// /api/memory/knows and src/lib/agent/knows-filing.ts), and everything already
// in those stores is rendered back as sentences in one list.
//
// ─── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
//   • No fact counter, on the page or on the rail button that opens it. A
//     number is a score, and nobody asked to be scored.
//   • No Confirm. Nothing on this page arrives unreviewed any more: a typed
//     sentence is written as human-authored, and a dropped file goes to the
//     document cabinet, which has no review state. A button asking somebody to
//     approve their own sentence was the filing cabinet leaking through.
//   • No category headings. The five buckets still exist in the database and
//     still classify each fact; they are simply not a thing to read.
//
// ─── THE TWO GROUPS ARE NOT A STYLE CHOICE ─────────────────────────────────
// "What it's noticed" is a guess and may be wrong, so its rows offer "That's
// wrong". "What you've taught it" is a person vouching, so its rows offer
// "Remove" instead. A manager must always be able to tell an inference from an
// assertion, and the button set is how the screen says which is which.
//
// ─── ACCESS ────────────────────────────────────────────────────────────────
// The taught group is readable by anybody signed in at this hotel, which is
// what the contact directory has always been: the front desk reaches the
// emergency numbers here, so the phone number inside a contact sentence is
// still a tap-to-call link. The noticed group and every write are manager-only,
// and the route re-checks both.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
  SessionEndedError,
} from '@/lib/api-fetch';
import { readEnvelope, type EnvelopeResult } from '@/lib/api-envelope';
import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';
import { CompanyRulebookPanel } from './CompanyRulebookPanel';
import { toldPost, putSigned } from './told-api';
import {
  UPLOAD_ACCEPT,
  uploadDocument,
  type PresignData,
} from './told-knowledge';
import {
  GROUP_TITLE,
  KNOWS_COPY,
  TEACH_MAX_CHARS,
  actionsFor,
  canSubmitTeach,
  groupKnowsItems,
  type KnowsAction,
  type KnowsItem,
} from '@/lib/knows/page-model';

// ─── Types ──────────────────────────────────────────────────────────────────

interface KnowsPage {
  items: KnowsItem[];
  canTeach: boolean;
  canSeeNoticed: boolean;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

const S = {
  title: { en: 'What Staxis knows' },
  bannerGeneric: { en: 'That did not work. Nothing changed. Try again in a moment.' },
  errAccountNotFound: { en: 'Staxis could not find your account. Sign out and sign back in.' },
  errForbidden: { en: 'You do not have access to this hotel.' },
  errInvalidBody: { en: 'Staxis could not read that. Nothing changed. Try again.' },
  errUnknownAction: { en: 'Staxis did not understand that. Nothing changed.' },
  errUnknownCategory: { en: 'Pick one of the groups in the list.' },
  errContentRequired: { en: 'Write something first. It cannot be empty.' },
  errConfirmFailed: { en: 'Could not confirm that. Nothing changed. Try again in a moment.' },
  errFactGone: { en: 'That one is not here anymore. Somebody may have removed it.' },
  errRemoveFailed: { en: 'Could not remove that. Nothing changed. Try again in a moment.' },
  errSaveFailed: { en: 'Could not save that. Nothing changed. Try again in a moment.' },
  errNothingToRead: { en: 'Type something or add a file first.' },
  errFileNoText: { en: 'There was no text in that file for Staxis to read.' },
  errFileUnreadable: { en: 'Staxis could not read that file. Try another copy of it.' },
  errFileMalformed: { en: 'That file did not come through. Add it again.' },
  fileWrongType: { en: 'Staxis cannot take that kind of file.' },
  fileTooBig: { en: 'That file is too big. Keep it under 10 MB.' },
  errNothingReadable: { en: 'There was nothing readable in that. Nothing was saved.' },
  errAiDisabled: { en: 'That part is turned off right now. Nothing was saved.' },
  errAiUnavailable: { en: 'Staxis could not read that just now. Nothing was saved. Try again in a moment.' },
  errBudget: { en: 'Your hotel has used up its daily allowance. It starts fresh at midnight.' },
  errRateLimited: { en: 'That is a lot of changes in one hour. Give it a few minutes.' },
  errOffline: { en: 'Staxis could not reach the server. Check your connection and try again.' },
  errUploadFailed: { en: 'The file did not finish uploading. Nothing was saved. Try again.' },
  readNoteTruncated: { en: 'That file is long. Staxis read the first part of it.' },
  readNoteVision: { en: 'That looked like a scan, so Staxis read it with help. Double-check the wording.' },
} as const;

/**
 * Every machine code the Knows route and its intake sibling can answer with.
 *
 * Deliberately a lookup rather than a switch on the server's English: the
 * English is a log line that can be reworded any day, and a raw token like
 * `rate_limited` must never reach a manager's screen.
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
 * The sentence for a refusal.
 *
 * `code` is the server's machine-readable reason. `serverError` is its English
 * message and is used ONLY as a second lookup key, never as output: the rate
 * limiter's response is not an envelope at all, so its reason arrives in the
 * error slot with no code beside it. An unrecognised key falls through to the
 * generic line rather than leaking a route's log string onto the screen.
 */
export function knowsBannerText(
  code: string | undefined,
  serverError: string | undefined,
  lang: 'en' | 'es',
): string {
  void lang; // English only, founder ruling 2026-07-29.
  const key = code ?? serverError;
  const entry = key !== undefined ? BANNER_COPY.get(key) : undefined;
  return S[entry ?? 'bannerGeneric'].en;
}

/**
 * How a file got read, when the server bothers to say.
 *
 * Retained because the document cabinet's own routes still answer with these
 * codes; empty for anything this build does not recognise, so a new code adds
 * nothing rather than printing itself.
 */
export function knowsReadNoteText(code: string | null | undefined, lang: 'en' | 'es'): string {
  void lang;
  const entry = code ? READ_NOTE_COPY.get(code) : undefined;
  return entry ? S[entry].en : '';
}

/** What the banner is saying: a refusal carried as its CODE, or owned copy. */
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

// ─── Scoped styles ──────────────────────────────────────────────────────────

const KN_CSS = `
.kn-teach{display:inline-flex;align-items:center;gap:9px;min-height:46px;padding:0 20px;border-radius:999px;
  border:none;cursor:pointer;background:#5C7A60;color:#fff;font-size:14.5px;font-weight:600;margin-top:18px;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  transition:background .2s,transform .2s;}
.kn-teach:hover{background:#4E6952;transform:translateY(-1px);}
.kn-teach:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;}
.kn-groups{display:flex;flex-direction:column;gap:26px;margin-top:26px;}
.kn-grpt{font-size:15px;font-weight:600;color:#1F231C;}
.kn-rows{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;margin-top:10px;overflow:hidden;}
.kn-row{padding:14px 16px;border-bottom:1px solid rgba(31,35,28,.05);}
.kn-row:last-child{border-bottom:none;}
.kn-c{font-size:14px;color:#1F231C;line-height:1.55;}
.kn-c a{color:#3E5C48;font-weight:600;text-decoration:none;}
.kn-c a:hover{text-decoration:underline;}
.kn-acts{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap;}
.kn-act{min-height:34px;padding:0 13px;border-radius:999px;cursor:pointer;font-size:12.5px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  display:inline-flex;align-items:center;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.kn-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.kn-act:disabled{opacity:.5;cursor:default;}
.kn-act.kn-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.kn-act.kn-yes:hover:not(:disabled){background:#4E6952;}
.kn-act.kn-danger{color:#B85C3D;}
.kn-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.kn-note{margin-top:14px;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.5;}
.kn-note.kn-good{background:rgba(53,107,76,.09);color:#2C5740;}
.kn-note.kn-bad{background:rgba(184,92,61,.10);color:#8E432B;}
.kn-empty{background:#fff;border:1px dashed rgba(92,122,96,.4);border-radius:16px;padding:26px 20px;
  margin-top:26px;text-align:center;}
.kn-emptyt{font-size:15px;font-weight:600;color:#1F231C;}
.kn-emptys{font-size:13px;color:#8A9187;margin-top:5px;}

/* ── the one box everything is typed into ── */
.kn-scrim{position:fixed;inset:0;z-index:70;background:rgba(20,26,20,.4);border:none;padding:0;cursor:default;}
.kn-pop{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:71;width:min(560px,calc(100vw - 32px));
  background:#FCFDFB;border-radius:20px;box-shadow:0 40px 80px -30px rgba(20,26,20,.6);padding:20px 20px 18px;
  box-sizing:border-box;max-height:calc(100vh - 40px);overflow:auto;}
.kn-popt{font-size:17px;font-weight:600;color:#1F231C;}
.kn-pophint{font-size:12.5px;color:#8A9187;margin-top:4px;line-height:1.5;}
.kn-tawrap{margin-top:12px;}
/* Tall enough for all four ghost lines at once. At the old 120px the fourth
   one overflowed by a pixel and the empty box opened with a scrollbar in it. */
.kn-ta{width:100%;box-sizing:border-box;min-height:136px;resize:vertical;border-radius:14px;
  border:1px solid rgba(31,35,28,.14);background:#fff;padding:13px 14px;color:#1F231C;font-size:14.5px;
  line-height:1.6;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;outline:none;}
.kn-ta:focus{border-color:rgba(92,122,96,.55);}
.kn-ta::placeholder{color:#B5BAB4;}
.kn-file{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:#3E5C48;
  background:rgba(158,183,166,.18);border-radius:999px;padding:6px 12px;max-width:100%;margin-top:10px;}
.kn-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* The footer rail: the attach button on the LEFT, Cancel and Save together on
   the right. Attaching is a way of answering, not a way of leaving, so it must
   not sit in the row a thumb reaches for when it wants out. */
.kn-popacts{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap;}
.kn-addfile{gap:7px;}
.kn-popright{display:flex;gap:8px;margin-left:auto;}
/* Dragging a file anywhere over the box. The sheet itself is the drop target,
   so there is no small rectangle to hit. */
.kn-pop.kn-over{outline:2px dashed #5C7A60;outline-offset:-5px;}
.kn-drop{position:absolute;inset:0;border-radius:20px;background:rgba(252,253,251,.94);
  display:grid;place-items:center;z-index:1;
  /* Load-bearing: an overlay that took the pointer would fire its own
     dragenter the instant it appeared and a dragleave on the box under it,
     so the highlight would strobe on and off under the cursor. */
  pointer-events:none;}
.kn-dropt{display:inline-flex;align-items:center;gap:9px;font-size:15px;font-weight:600;color:#3E5C48;}
@media (max-width:600px){
  .kn-pop{width:calc(100vw - 20px);padding:18px 16px 16px;}
}
@media (prefers-reduced-motion: reduce){
  .kn-teach{transition:none;}
  .kn-teach:hover{transform:none;}
}
`;

// ─── The box ────────────────────────────────────────────────────────────────

type BoxMode =
  | { kind: 'teach' }
  | { kind: 'adjust'; item: KnowsItem }
  | { kind: 'wrong'; item: KnowsItem };

function boxTitle(mode: BoxMode): string {
  if (mode.kind === 'adjust') return KNOWS_COPY.adjustTitle;
  if (mode.kind === 'wrong') return KNOWS_COPY.wrongTitle;
  return KNOWS_COPY.teachTitle;
}

/**
 * The one text box on the screen, in three costumes.
 *
 * Teach, Adjust and "That's wrong" are the same act — a person saying a
 * sentence — so they are the same box rather than three components that drift.
 * The only differences are the heading, whether the box starts full, and
 * whether an empty box may be submitted: on "That's wrong" it may, because
 * "no, that is not true" is a complete answer and demanding a replacement
 * sentence would turn a correction into homework.
 */
function TeachBox({ mode, busy, note, onCancel, onSubmit }: {
  mode: BoxMode;
  busy: boolean;
  /** A refusal raised while the box was open. Rendered INSIDE it: the page's
   *  own banner sits behind the scrim, where nobody would ever read it. */
  note: React.ReactElement | null;
  onCancel: () => void;
  onSubmit: (text: string, file: File | null) => void;
}) {
  const [text, setText] = useState(mode.kind === 'adjust' ? mode.item.sentence : '');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Enters counted against leaves.
   *
   * dragenter and dragleave fire once for EVERY element the pointer crosses,
   * children included, so a plain boolean turns the highlight off the moment
   * the cursor moves from the sheet onto the textarea inside it and back on a
   * pixel later. Counting is the only shape that survives a nested tree.
   */
  const depth = useRef(0);

  React.useEffect(() => { taRef.current?.focus(); }, []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const optional = mode.kind === 'wrong';
  const ready = optional || canSubmitTeach(text, !!file);
  const saveLabel = mode.kind === 'wrong' ? KNOWS_COPY.confirm : KNOWS_COPY.teachSave;
  // Only the teach costume takes a file, which is where the button is. Adjust
  // and "That's wrong" are corrections to one existing row, and a handbook is
  // not a correction to a sentence.
  const canAttach = mode.kind === 'teach' && !busy;

  /**
   * True only for a drag carrying FILES.
   *
   * Dragging selected text or a link across the sheet must leave it alone: the
   * textarea is a legitimate drop target for text, and lighting the whole box
   * up promises something that would not happen.
   */
  const draggingFile = (e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types as ArrayLike<string>).includes('Files');
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!canAttach || !draggingFile(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!canAttach || !draggingFile(e)) return;
    // Without this the browser takes the drop itself and NAVIGATES to the
    // file, throwing away whatever was typed in the box.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = () => {
    if (depth.current === 0) return;
    depth.current -= 1;
    if (depth.current === 0) setOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    depth.current = 0;
    setOver(false);
    if (!canAttach || !draggingFile(e)) return;
    e.preventDefault();
    // The first one, exactly as the picker would: the box carries one
    // attachment, and silently uploading four of them is worse than taking one.
    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped) return;
    setFile(dropped);
    // The picker keeps its own value. Left set, clearing the chip would leave
    // a previously PICKED file still selected inside the input.
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <>
      <button type="button" className="kn-scrim" aria-label={KNOWS_COPY.cancel} onClick={busy ? undefined : onCancel} />
      <div
        className={`kn-pop${over ? ' kn-over' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={boxTitle(mode)}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="kn-popt">{boxTitle(mode)}</div>
        {optional && <div className="kn-pophint">{KNOWS_COPY.wrongOptional}</div>}

        <div className="kn-tawrap">
          <textarea
            ref={taRef}
            className="kn-ta"
            value={text}
            maxLength={TEACH_MAX_CHARS}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode.kind === 'teach' ? KNOWS_COPY.teachPlaceholder : ''}
            aria-label={boxTitle(mode)}
          />
        </div>

        {file && (
          <span className="kn-file">
            <CxIcon name="paperclip" size={13} />
            <span>{file.name}</span>
            <button
              type="button"
              className="kn-act"
              style={{ minHeight: 22, padding: '0 8px', border: 'none' }}
              aria-label={KNOWS_COPY.attachRemove}
              onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
            >
              &times;
            </button>
          </span>
        )}

        {note}

        <div className="kn-popacts">
          {mode.kind === 'teach' && (
            <>
              <button
                type="button"
                className="kn-act kn-addfile"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                <CxIcon name="paperclip" size={14} />
                {KNOWS_COPY.attach}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={UPLOAD_ACCEPT}
                style={{ display: 'none' }}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </>
          )}
          <div className="kn-popright">
            <button type="button" className="kn-act" onClick={onCancel} disabled={busy}>
              {KNOWS_COPY.cancel}
            </button>
            <button
              type="button"
              className="kn-act kn-yes"
              onClick={() => onSubmit(text.trim(), file)}
              disabled={busy || !ready}
            >
              {busy ? KNOWS_COPY.teachSaving : saveLabel}
            </button>
          </div>
        </div>

        {over && (
          <div className="kn-drop">
            <span className="kn-dropt">
              <CxIcon name="paperclip" size={18} />
              {KNOWS_COPY.attachDrop}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<KnowsAction, string> = {
  adjust: KNOWS_COPY.adjust,
  wrong: KNOWS_COPY.wrong,
  remove: KNOWS_COPY.remove,
};

/**
 * One sentence, with the phone number in it still dialable.
 *
 * The tap-to-call affordance is why this is not a plain string: before the
 * rebuild the emergency numbers sat on cards with their own call button, and
 * somebody at the front desk with a guest emergency in front of them must not
 * have lost that to a redesign.
 */
function Sentence({ item }: { item: KnowsItem }) {
  // `telText` is the number as the SENTENCE prints it; `tel` is how it dials.
  // Looking for the dialable form would find nothing whenever the stored
  // number carries punctuation, and the row would print the digits a second
  // time after the sentence.
  const shown = item.telText ?? item.tel?.replace(/^tel:/, '') ?? '';
  const at = item.tel && shown ? item.sentence.indexOf(shown) : -1;
  if (!item.tel || at < 0) return <div className="kn-c">{item.sentence}</div>;
  return (
    <div className="kn-c">
      {item.sentence.slice(0, at)}
      <a href={item.tel}>{item.sentence.slice(at, at + shown.length)}</a>
      {item.sentence.slice(at + shown.length)}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function KnowsView({ lang }: { lang: 'en' | 'es' }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const scopeKey = `${user?.uid ?? 'signed-out'}:${activePropertyId ?? 'no-property'}`;

  // Every draft, file and busy flag below belongs to one exact viewer+hotel.
  // Remount synchronously on either identity change so a sentence typed for
  // Hotel A can never be submitted after the shell switches to Hotel B.
  //
  // The company's own book is passed IN rather than rendered inside, so the
  // page itself can be mounted in a test without the two contexts that panel
  // needs. It renders NOTHING for an independent hotel (its route 404s and the
  // panel returns null), so a single-hotel customer sees exactly the one page
  // this rebuild is about. It stays because it is the only surface a
  // management company's leadership has for the rulebook, and it gates itself:
  // /api/company/rulebook resolves standing from the caller's own hats.
  return (
    <KnowsPropertyView
      key={scopeKey}
      propertyId={activePropertyId}
      scopeKey={scopeKey}
      companyBook={<CompanyRulebookPanel lang={lang} />}
    />
  );
}

/**
 * Knows as a right-hand SLIDE-OVER, which is how the Staxis tab reaches it.
 *
 * Escape and a click on the scrim both close it, because a panel with only one
 * exit is a panel people stop opening. There is no fact count in the subtitle
 * any more: the page does not keep score.
 */
export function KnowsPanel({ open, lang, hotelName, onClose }: {
  open: boolean;
  lang: 'en' | 'es';
  hotelName?: string | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The typing box owns Escape while it is open. Without this guard one
      // press cancels the box AND closes the whole panel, so a manager who
      // changed their mind about one sentence loses the screen as well.
      if (e.key !== 'Escape') return;
      if (document.querySelector('.kn-pop')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <button type="button" className="fx-scrim" aria-label="Close what Staxis knows" onClick={onClose} />
      <div className="fx-drawer" role="dialog" aria-modal="true" aria-label={S.title.en}>
        <div className="fx-drawerhead">
          <span className="fx-draweri" aria-hidden><CxIcon name="staxis" size={16} /></span>
          <div style={{ minWidth: 0 }}>
            <div className="fx-drawert">{S.title.en}</div>
            {hotelName && <div className="fx-drawers">{hotelName}</div>}
          </div>
          <button type="button" className="fx-drawerx" aria-label="Close" onClick={onClose}>
            <CxIcon name="close" size={14} />
          </button>
        </div>
        <div className="fx-drawerbody">
          <KnowsView lang={lang} />
        </div>
      </div>
    </>
  );
}

/**
 * The page itself. Exported so a test can mount the real thing.
 *
 * It takes no contexts: `propertyId` and the company panel are handed in, and
 * everything else it needs is one authed GET. That is deliberate, because a
 * page whose empty state, groups and button set can only be checked by a human
 * opening it is a page whose empty state, groups and button set do not get
 * checked.
 */
export function KnowsPropertyView({ propertyId, scopeKey, companyBook }: {
  propertyId: string | null;
  scopeKey: string;
  companyBook?: React.ReactNode;
}) {
  const { data, loading, error, reload } = useApiResource<KnowsPage>(
    `/api/memory/knows?propertyId=${propertyId}`,
    { enabled: !!propertyId, keepDataOnError: true },
  );

  const [box, setBox] = useState<BoxMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<KnowsBanner | null>(null);

  const activeScopeRef = useRef<string | null>(scopeKey);
  React.useEffect(() => {
    activeScopeRef.current = scopeKey;
    return () => {
      if (activeScopeRef.current === scopeKey) activeScopeRef.current = null;
    };
  }, [scopeKey]);
  const ownsScope = useCallback(() => activeScopeRef.current === scopeKey, [scopeKey]);

  // Returns readEnvelope's own result type on purpose: the narrower shape drops
  // `code`, which is the only part of a refusal this screen can translate.
  const post = useCallback(async <T,>(payload: unknown): Promise<EnvelopeResult<T>> => {
    try {
      const res = await fetchWithAuth('/api/memory/knows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      return await readEnvelope<T>(res);
    } catch (e) {
      if (e instanceof SessionEndedError) throw e;
      return { error: e instanceof Error ? e.message : 'Request failed', code: 'request_failed' };
    }
  }, []);

  /**
   * Where an attached file goes. Presign, PUT, register: the document
   * cabinet's own three steps, unchanged, through the same helper the old
   * Documents panel used. Nothing about how a file becomes searchable moved
   * with this redesign, and the "Add a document" button and a drag-and-drop
   * both land here rather than growing a second path.
   */
  const sendFile = useCallback(async (file: File): Promise<boolean> => {
    if (!propertyId) return false;
    const result = await uploadDocument(
      {
        presign: (body) => toldPost<PresignData>('/api/knowledge/documents/presign', body),
        put: (signedUrl, contentType) => putSigned(signedUrl, file, contentType),
        register: (body) => toldPost<{ id: string }>('/api/knowledge/documents', body),
      },
      { pid: propertyId, file, access: 'all_staff', folderId: null },
    );
    if (result.ok) return true;
    setBanner(
      result.reason === 'too_big'
        ? { kind: 'bad', text: S.fileTooBig.en }
        : { kind: 'bad', text: S.errUploadFailed.en },
    );
    return false;
  }, [propertyId]);

  const submitBox = useCallback(async (text: string, file: File | null) => {
    if (!propertyId || !box || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      let fileOk = true;
      if (file) fileOk = await sendFile(file);
      if (!ownsScope()) return;

      let saidSomething = false;
      if (text) {
        const payload =
          box.kind === 'teach'
            ? { propertyId, action: 'teach', text }
            : { propertyId, action: box.kind === 'wrong' ? 'wrong' : 'adjust', kind: box.item.kind, id: box.item.id, text };
        const res = await post(payload);
        if (!ownsScope()) return;
        if (res.error !== undefined) {
          setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
          return;
        }
        saidSomething = true;
      } else if (box.kind === 'wrong') {
        // Nothing typed: the row simply stops being believed.
        const res = await post({ propertyId, action: 'wrong', kind: box.item.kind, id: box.item.id });
        if (!ownsScope()) return;
        if (res.error !== undefined) {
          setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
          return;
        }
        saidSomething = true;
      }

      // A file that did not land must never be reported as saved, even when
      // the sentence beside it went through. sendFile already set that banner;
      // the sentence still closes the box, because leaving it open with the
      // same text in it invites a second save of something already stored.
      const fileFailed = !!file && !fileOk;
      if (saidSomething || (file && fileOk)) {
        if (!fileFailed) {
          setBanner({
            kind: 'good',
            text: box.kind === 'teach'
              ? (text ? KNOWS_COPY.taughtOk : KNOWS_COPY.fileOk)
              : KNOWS_COPY.adjustedOk,
          });
        }
        setBox(null);
      }
      await reload();
    } finally {
      if (ownsScope()) setBusy(false);
    }
  }, [box, busy, ownsScope, post, propertyId, reload, sendFile]);

  const removeItem = useCallback(async (item: KnowsItem) => {
    if (!propertyId) return;
    setRowBusy(item.id);
    setBanner(null);
    try {
      const res = await post({ propertyId, action: 'remove', kind: item.kind, id: item.id });
      if (!ownsScope()) return;
      if (res.error !== undefined) {
        setBanner({ kind: 'bad', failure: { code: res.code, serverError: res.error } });
      } else {
        setBanner({ kind: 'good', text: KNOWS_COPY.removedOk });
      }
      await reload();
    } finally {
      if (ownsScope()) setRowBusy(null);
    }
  }, [ownsScope, post, propertyId, reload]);

  const groups = useMemo(() => groupKnowsItems(data?.items ?? []), [data]);
  const canTeach = data?.canTeach ?? false;

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: KN_CSS }} />

      {companyBook}

      <div className="cx-ptitle" style={{ marginTop: 0 }}>{S.title.en}</div>

      {canTeach && (
        <button type="button" className="kn-teach" onClick={() => setBox({ kind: 'teach' })}>
          <CxIcon name="staxis" size={16} />
          {KNOWS_COPY.teachButton}
        </button>
      )}

      {/* While the box is open its own copy of this is what the reader sees. */}
      {banner && !box && knowsBannerNote(banner, 'en')}

      {/* An error must never look like "your hotel has nothing". */}
      {error && !data && <div className="kn-note kn-bad">{KNOWS_COPY.loadFailed}</div>}

      {!loading && data && groups.length === 0 && (
        <div className="kn-empty">
          <div className="kn-emptyt">{KNOWS_COPY.emptyTitle}</div>
          <div className="kn-emptys">{KNOWS_COPY.emptyBody}</div>
        </div>
      )}

      {groups.length > 0 && (
        <div className="kn-groups">
          {groups.map((group) => (
            <div key={group.group}>
              <div className="kn-grpt">{GROUP_TITLE[group.group]}</div>
              <div className="kn-rows">
                {group.items.map((item) => (
                  <div className="kn-row" key={`${item.kind}:${item.id}`}>
                    <Sentence item={item} />
                    {canTeach && (
                      <div className="kn-acts">
                        {actionsFor(group.group).map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={`kn-act${action === 'remove' ? ' kn-danger' : ''}`}
                            disabled={rowBusy === item.id}
                            onClick={() => {
                              if (action === 'remove') { void removeItem(item); return; }
                              setBox({ kind: action === 'wrong' ? 'wrong' : 'adjust', item });
                            }}
                          >
                            {ACTION_LABEL[action]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {box && (
        <TeachBox
          key={box.kind === 'teach' ? 'teach' : `${box.kind}:${box.item.id}`}
          mode={box}
          busy={busy}
          note={banner ? knowsBannerNote(banner, 'en') : null}
          onCancel={() => setBox(null)}
          onSubmit={(text, file) => { void submitBox(text, file); }}
        />
      )}
    </div>
  );
}
