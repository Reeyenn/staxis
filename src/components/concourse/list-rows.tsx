'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The non-finding rows of the one list, and the inline composer.
//
// EVERY COMPONENT IN THIS FILE IS HOOK-FREE AND FULLY CONTROLLED. That is not
// a style preference: `npm test` runs under `--conditions=react-server`, where
// react-dom/server refuses to load and the house pattern is to walk a hook-free
// component's element tree. State lives one level up, in StaxisList, so the
// rows, the buttons and the composer's defaults can all be exercised without a
// browser.
//
// They deliberately reuse the finding card's own classes (cx-dec, cx-dchip,
// fd-act) so a to-do and a card are the same object on the screen. The founder's
// list has no lanes and no tag taxonomy; two visually different row species
// would put the lanes back by other means.
//
// English only (founder ruling, 2026-07-29). No em dashes in anything a person
// reads (2026-07-28) — the copy producers in lib/feed/one-list-copy.ts are
// walked by the guard test, so new sentences belong THERE, not inline here.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import type { LogEntryDTO } from '@/lib/comms/types';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
import type { AssignedByMeItem, WorklistItem } from '@/lib/worklist/types';
import {
  ASSIGNED_COPY,
  ASSIGNED_FACE_LIMIT,
  assignedMoreLine,
  assignedNote,
  assignedStateLine,
  completionNotice,
  COMPOSER_COPY,
  COMPOSER_OTHER,
  COMPOSER_ROLES,
  dueLine,
  enterTakesNote,
  intervalHint,
  missedLine,
  otherHint,
  overdueAnswers,
  promptExample,
  repeatWord,
  ROW_MENU_COPY,
  rowFrom,
  rowKindLabel,
  rowMenuOptions,
  stalenessLine,
  waitingLine,
  WEEKDAYS,
  whenWord,
  whoWord,
  type RowMenuAction,
  type RowMenuOption,
} from '@/lib/feed/one-list-copy';
import {
  MAX_INTERVAL_DAYS,
  MIN_INTERVAL_DAYS,
  readIntervalDays,
  type ComposerPerson,
  type ParseQuestion,
  type ParseResult,
  type RepeatChoice,
} from '@/lib/feed/parse-todo';

import { CxIcon } from './icons';

/**
 * What is left of the old list stylesheet, plus the few bits the timeline rows
 * need that are too local to belong in FEED_CSS.
 *
 * The row/panel/composer geometry itself now lives in `FEED_CSS`
 * (concourse-css.tsx) under `fx-*`, because it is the /feed design language
 * rather than this file's private business. `sl-err` stays here because
 * StaxisList renders it directly.
 */
export const LIST_CSS = `
.sl-err{margin-top:9px;border-radius:10px;padding:8px 11px;font-size:12.5px;line-height:1.5;
  background:rgba(184,92,61,.10);color:#8E432B;}
.fx-rowb{min-width:0;flex:1;}
.fx-rowsub{font-size:11.5px;color:#8A9187;margin-top:2px;line-height:1.4;}
.fx-drrow{padding:10px 0;border-bottom:1px solid rgba(31,35,28,.06);}
.fx-drrow:last-child{border-bottom:none;}
.fx-drt{font-size:13.5px;font-weight:600;color:#1F231C;line-height:1.4;}
.fx-drs{font-size:12.5px;color:#5C625C;margin-top:3px;line-height:1.5;}
.fx-stale{font-size:11.5px;color:#8C6A33;margin-top:3px;}

/* ── the per-row "···" and what it opens ───────────────────────────────────
   A LIGHT menu, and that is why it is not FEED_CSS's .fx-menu: that one is
   ink-on-dark because it lives inside a finding card, and dropping it onto a
   white row would put a black slab in the middle of the list. Same geometry,
   same tap sizes, opposite palette.

   It lives here rather than in concourse-css.tsx because it is this file's own
   row furniture, which is exactly what LIST_CSS is for. */
.fx-rowa{position:relative;}
.fx-more{width:32px;padding:0;justify-content:center;letter-spacing:.08em;font-size:15px;color:#8A9187;}
.fx-more[aria-expanded="true"]{background:#F4F6F2;border-color:rgba(31,35,28,.2);}
.fx-rowmenu{position:absolute;right:0;top:calc(100% + 7px);z-index:21;min-width:236px;overflow:hidden;
  background:#fff;border:1px solid rgba(31,35,28,.12);border-radius:12px;
  box-shadow:0 22px 44px -20px rgba(31,35,28,.34);}
.fx-rowmenu button{display:block;width:100%;text-align:left;padding:9px 14px;border:none;background:transparent;
  color:#1F231C;font-size:13px;font-family:inherit;cursor:pointer;min-height:44px;}
.fx-rowmenu button:hover:not(:disabled){background:#F4F6F2;}
.fx-rowmenu button:focus-visible{outline:2px solid #3E5C48;outline-offset:-2px;}
.fx-rowmenu button:disabled{opacity:.5;cursor:default;}
.fx-rowmenu button + button{border-top:1px solid rgba(31,35,28,.07);}
.fx-mih{display:block;font-size:11.5px;color:#8A9187;line-height:1.45;margin-top:2px;}
/* The answer the option asked for, opened inside the row itself. */
.fx-ask{margin-top:9px;display:flex;gap:7px;flex-wrap:wrap;align-items:center;width:100%;}
.fx-askl{font-size:11.5px;color:#8A9187;flex:0 0 auto;}
.fx-asknum{width:74px;height:36px;padding:0 11px;border-radius:9px;font-size:13px;font-family:inherit;
  border:1px solid rgba(31,35,28,.16);background:#fff;color:#1F231C;}
.fx-asknum:focus-visible{outline:2px solid #3E5C48;outline-offset:1px;}
.fx-waiting{font-size:11.5px;color:#8C6A33;margin-top:3px;line-height:1.4;}
@media (max-width:760px){
  /* A menu pinned to the right edge of a wrapped action row can hang off the
     screen on a phone. Full width, under the row, is the same list either way. */
  .fx-rowmenu{left:0;right:0;min-width:0;}
}
`;

export interface WorkRowViewProps {
  item: WorklistItem;
  now: Date;
  busy?: boolean;
  /** True while this row is asking for the one-line reason. */
  askingReason?: boolean;
  reasonDraft?: string;
  /** True when this arrived since the person last looked at their list. */
  isNew?: boolean;
  onDone?: (item: WorklistItem) => void;
  /** "Did it yesterday" — completes, credited to the day it was due. */
  onDoneOnDay?: (item: WorklistItem) => void;
  /** "Not needed" — records that it stopped needing doing. Never a delete. */
  onNotNeeded?: (item: WorklistItem) => void;
  onAskReason?: (item: WorklistItem) => void;
  onReasonChange?: (value: string) => void;
  onCantSubmit?: (item: WorklistItem) => void;
  onCancelReason?: () => void;
  // ── the "···" ─────────────────────────────────────────────────────────────
  /** True while this row's situation menu is showing. */
  menuOpen?: boolean;
  /** Which option is collecting its answer, or null while the list is showing. */
  menuAsking?: RowMenuAction | null;
  /** The reason box / the day count, as typed. One field is ever open. */
  menuDraft?: string;
  /** Who a work order can be handed to. Housekeepers are already absent. */
  menuPeople?: readonly ComposerPerson[];
  onToggleMenu?: (item: WorklistItem, open: boolean) => void;
  /** An option was tapped. Ones that need nothing fire; the rest open a field. */
  onMenuPick?: (item: WorklistItem, option: RowMenuOption) => void;
  onMenuDraftChange?: (value: string) => void;
  /** Send the reason, or the new cadence. */
  onMenuSubmit?: (item: WorklistItem) => void;
  /** Hand the work order to this person. */
  onMenuPickPerson?: (item: WorklistItem, staffId: string) => void;
  onMenuCancel?: () => void;
}

/**
 * One thing that needs a person, that is not an AI finding.
 *
 * ─── the controls, and why there are two sets of them ──────────────────────
 *
 * ON TIME: Done is a claim the work happened; "Can't do this" is a claim it did
 * not, WITH the reason, because the assigner otherwise learns only that nothing
 * happened and has to go and ask. That round trip is the thing the receipt
 * replaces, so the reason box is not optional and submit stays disabled without
 * one.
 *
 * OVERDUE: three answers instead, because a to-do that slipped has three true
 * endings and the plain Done offered one and a half of them.
 *
 *   Done              it happened just now, recorded just now
 *   Did it <day>      it happened on the day it was DUE, and the record says so
 *   Not needed        it stopped needing doing, recorded, never deleted
 *
 * The middle one is the whole reason this row changed. "Done" stamped the
 * moment of the tap, so work done on Tuesday and reported on Thursday went into
 * the record as Thursday's — and every pattern the product learns about when
 * work actually gets done was being taught a date nobody chose.
 *
 * The row stays ONE row however far behind it has fallen, including a repeating
 * to-do that was missed five days running. See collapseRepeatInstances.
 *
 * ─── and the "···", on the rows that had only Done ─────────────────────────
 *
 * A preventive schedule and a work order got one button, so every situation
 * that was not "it happened" had to be entered as if it were. The quiet dot
 * cluster beside Done opens the honest answers for that row type and nothing
 * else: three for a schedule, three for a ticket, none for anything else. Done
 * stays the one big button. See rowMenuOptions.
 */
export function WorkRowView({
  item, now, busy = false, askingReason = false, reasonDraft = '', isNew = false,
  onDone, onDoneOnDay, onNotNeeded, onAskReason, onReasonChange, onCantSubmit, onCancelReason,
  menuOpen = false, menuAsking = null, menuDraft = '', menuPeople = [],
  onToggleMenu, onMenuPick, onMenuDraftChange, onMenuSubmit, onMenuPickPerson, onMenuCancel,
}: WorkRowViewProps) {
  const from = rowFrom(item);
  const due = dueLine(item.dueDate, now, item.dueTime);
  const canRefuse = item.sourceType === 'task';
  const reasonReady = reasonDraft.trim().length > 0;
  const menu = rowMenuOptions(item);
  const asking = menuAsking !== null;
  // The three answers, and only on a to-do: a work order has no assigner
  // waiting on a receipt and no due day to credit a completion to.
  const slipped = item.sourceType === 'task' && item.canComplete && !!item.missedSince;
  // "Did it Monday" is only TRUE on a row that speaks for itself. On a
  // collapsed repeat run the row's identity is today's instance while the day
  // named on the button belongs to an older one, so the completion would be
  // credited to today and the button would have lied about the one thing it
  // exists to get right. A run's two honest answers are "I did it just now"
  // and "it stopped needing doing"; the third slot goes back to the refusal,
  // which is where the reason for the assigner lives. Either way it is three
  // buttons, never four: a row with four controls is a menu.
  const canCreditDay = slipped && (item.supersededIds?.length ?? 0) === 0;
  const answers = overdueAnswers(item.missedSince ?? null, now);
  const missed = missedLine(item.missedSince ?? null, now);

  // "2 days late · Dana" — the mono line the design puts beside the title. The
  // clock half comes first because it is the half that decides whether this row
  // is the next thing anybody does.
  //
  // The KIND is prefixed only when it is not an ordinary to-do: "To do" over a
  // row somebody typed into the composer on this very page is a label that
  // tells them nothing, while "Work order" or "Inspection" is the difference
  // between a note and a ticket.
  const kind = item.sourceType === 'task' ? null : rowKindLabel(item.sourceType);
  const meta = [kind, due, item.assigneeName].filter(Boolean).join(' · ');
  // Everything the one-line row cannot hold: who handed it over, where, and how
  // far back it goes when it has been missed more than once.
  const sub = [from, item.location, missed].filter(Boolean).join(' · ');
  // Said on its own line rather than folded into `sub`: somebody wrote this
  // sentence about this ticket, and burying it between the room number and a
  // date would read as one more attribute.
  const waiting = waitingLine(item.waitingReason);

  return (
    <div
      className={`fx-row${item.overdue ? ' fx-late' : ''}${askingReason || asking ? ' fx-open' : ''}`}
      data-row-kind={item.sourceType}
      data-row-id={item.id}
      data-row-new={isNew ? 'true' : undefined}
    >
      <div className="fx-rowb">
        <div className="fx-rowt">
          {/* Quiet on purpose: a dot, no word, no colour anybody has to learn.
              It is answering "is this one new?", which is a question somebody
              asks with their eyes and never out loud. */}
          {isNew && <span className="fx-new" aria-label="New since you last looked" />}
          {item.title}
        </div>
        {sub && <div className="fx-rowsub">{sub}</div>}
        {waiting && <div className="fx-waiting">{waiting}</div>}
      </div>

      {meta && <span className={`fx-rowm${item.overdue ? ' fx-late' : ''}`}>{meta}</span>}

      <div className="fx-rowa">
        {item.canComplete && (
          <button type="button" className="fx-btn fx-primary" disabled={busy || askingReason} onClick={() => onDone?.(item)}>
            {answers.done}
          </button>
        )}
        {canCreditDay && !askingReason && (
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onDoneOnDay?.(item)}>
            {answers.onDay}
          </button>
        )}
        {slipped && !askingReason && (
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onNotNeeded?.(item)}>
            {answers.notNeeded}
          </button>
        )}
        {/* The refusal keeps its place except where "Did it <day>" has taken
            the slot. See canCreditDay: three buttons in every state. */}
        {canRefuse && !canCreditDay && !askingReason && (
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onAskReason?.(item)}>
            Can&apos;t do this
          </button>
        )}
        {!item.canComplete && (
          <a className="fx-btn" href={item.deepLink}>Open</a>
        )}

        {/* The quiet one. Absent entirely on a row type with no other honest
            answers, and while the row is already asking something: a second
            open control over an open field is two questions at once. */}
        {menu.length > 0 && !askingReason && !asking && (
          <>
            <button
              type="button"
              className="fx-btn fx-more"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={ROW_MENU_COPY.open}
              disabled={busy}
              onClick={() => onToggleMenu?.(item, !menuOpen)}
            >
              <span aria-hidden>···</span>
            </button>
            {menuOpen && (
              <>
                {/* Click anywhere else and it goes away. A menu whose only exit
                    is one of its own items is a trap. */}
                <button
                  type="button"
                  aria-label={ROW_MENU_COPY.cancel}
                  onClick={() => onToggleMenu?.(item, false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'transparent', border: 'none', cursor: 'default' }}
                />
                <div className="fx-rowmenu" role="menu" data-row-menu={item.sourceType}>
                  {menu.map((option) => (
                    <button
                      key={option.action}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => onMenuPick?.(item, option)}
                    >
                      {option.label}
                      {/* Said in the menu, not in a tooltip. A hint nobody on a
                          phone can reach is a hint that was not given. */}
                      <span className="fx-mih">{option.hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* The reason is not optional: the assigner otherwise learns only that
          nothing happened and has to go and ask. */}
      {askingReason && (
        <div className="fx-reason">
          <input
            className="fx-input"
            type="text"
            value={reasonDraft}
            placeholder="Why not? One line is enough."
            aria-label="Why you could not do it"
            onChange={(e) => onReasonChange?.(e.target.value)}
          />
          <button
            type="button"
            className="fx-btn fx-primary"
            disabled={busy || !reasonReady}
            onClick={() => onCantSubmit?.(item)}
          >
            Send
          </button>
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onCancelReason?.()}>
            Cancel
          </button>
        </div>
      )}

      {/* What the option asked for. One field, inside the row, never a
          dialog: the answer belongs to this row and a modal over the list would
          make a one-line reason feel like a form. */}
      {menuAsking === 'waiting' && (
        <div className="fx-ask" data-row-ask="waiting">
          <input
            className="fx-input"
            type="text"
            value={menuDraft}
            placeholder={ROW_MENU_COPY.reasonPlaceholder}
            aria-label={ROW_MENU_COPY.reasonAria}
            onChange={(e) => onMenuDraftChange?.(e.target.value)}
          />
          <button
            type="button"
            className="fx-btn fx-primary"
            disabled={busy || menuDraft.trim().length === 0}
            onClick={() => onMenuSubmit?.(item)}
          >
            {ROW_MENU_COPY.send}
          </button>
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onMenuCancel?.()}>
            {ROW_MENU_COPY.cancel}
          </button>
        </div>
      )}

      {menuAsking === 'reschedule' && (
        <div className="fx-ask" data-row-ask="reschedule">
          <span className="fx-askl" id={`fx-days-${item.id}`}>{ROW_MENU_COPY.daysLabel}</span>
          <input
            className="fx-asknum"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={menuDraft}
            aria-label={ROW_MENU_COPY.daysAria}
            aria-describedby={`fx-days-${item.id}`}
            onChange={(e) => onMenuDraftChange?.(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          <button
            type="button"
            className="fx-btn fx-primary"
            disabled={busy || !readCadenceDraft(menuDraft)}
            onClick={() => onMenuSubmit?.(item)}
          >
            {ROW_MENU_COPY.save}
          </button>
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onMenuCancel?.()}>
            {ROW_MENU_COPY.cancel}
          </button>
        </div>
      )}

      {menuAsking === 'reassign' && (
        <div className="fx-ask" data-row-ask="reassign">
          <span className="fx-askl" id={`fx-who-${item.id}`}>{ROW_MENU_COPY.personLabel}</span>
          {menuPeople.length === 0 ? (
            <span className="fx-askl">{ROW_MENU_COPY.noPeople}</span>
          ) : (
            menuPeople.map((person) => (
              <button
                key={person.staffId}
                type="button"
                className="fx-btn"
                disabled={busy}
                aria-describedby={`fx-who-${item.id}`}
                onClick={() => onMenuPickPerson?.(item, person.staffId)}
              >
                {person.name}
              </button>
            ))
          )}
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onMenuCancel?.()}>
            {ROW_MENU_COPY.cancel}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The day count somebody typed, or null while it is not yet a cadence.
 *
 * Held as a STRING in the row's draft for the same reason the composer holds
 * its interval as one: a half-typed "1" on the way to "14" must not be sendable
 * as a daily schedule. The bounds are the server's own (MIN_CADENCE_DAYS /
 * MAX_CADENCE_DAYS in /api/worklist/assign); this is the button-disabling copy
 * of them, not the authority.
 */
export function readCadenceDraft(value: string): number | null {
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 3650) return null;
  return n;
}

/**
 * A thing on the hotel's own calendar: a vendor visit, a training day, a brand
 * audit. Teal, because it is neither Staxis talking nor work anybody owes.
 *
 * It reached the timeline in the 2026-08-01 redesign. Before that these existed
 * only on the month grid, so a 2pm vendor visit was invisible on the screen a
 * manager actually watches all day.
 */
export function EventRowView({ event, meta, canManage = false, onRemove }: {
  event: KnowledgeEventDTO;
  /** "2:00 PM · in 79 minutes", already composed by the caller's clock. */
  meta?: string | null;
  canManage?: boolean;
  onRemove?: (event: KnowledgeEventDTO) => void;
}) {
  return (
    <div className="fx-row fx-event" data-row-kind="event" data-row-id={event.id}>
      <div className="fx-rowb">
        <div className="fx-rowt">{event.title}</div>
      </div>
      {meta && <span className="fx-rowm">{meta}</span>}
      {canManage && onRemove && (
        <div className="fx-rowa">
          <button type="button" className="fx-btn fx-quiet" onClick={() => onRemove(event)}>Remove</button>
        </div>
      )}
    </div>
  );
}

/** A shift note, when this person switched the log book into their list. */
export function LogRowView({ entry, onOpen }: { entry: LogEntryDTO; onOpen?: () => void }) {
  const sub = entry.authorName ? `${entry.authorName} wrote` : null;
  return (
    <div className="fx-row" data-row-kind="log" data-row-id={entry.id}>
      <div className="fx-rowb">
        <div className="fx-rowt">{entry.title}</div>
        {(sub || entry.body) && (
          <div className="fx-rowsub">
            {[sub, entry.body ? entry.body.slice(0, 140) : null].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <span className="fx-rowm">Log book</span>
      <div className="fx-rowa">
        <button type="button" className="fx-btn fx-quiet" onClick={() => onOpen?.()}>Open the log book</button>
      </div>
    </div>
  );
}

// ─── The inline composer ────────────────────────────────────────────────────

/** What the Who word can say. A department option is "whoever is on shift". */
export type { ComposerPerson, RepeatChoice } from '@/lib/feed/parse-todo';
export { COMPOSER_ROLES } from '@/lib/feed/one-list-copy';

/**
 * The cadences the REPEAT row offers, on ONE horizontally scrolling line.
 *
 * One line and not a wrapping block, because the row is a sentence somebody is
 * reading left to right and a cadence list that reflows to three rows turns the
 * composer into a form. Anything past the edge is a swipe away.
 *
 * `weekdays` is deliberately absent: it exists in the write path for templates
 * created elsewhere, and offering "every weekday" beside "every day" on a row
 * somebody is skimming is one distinction too many. The labels are the design's
 * own words, so the button and the word above it are recognisably the same
 * thing said twice.
 *
 * The blank at the end of the line is not here: it is not a fixed choice, it is
 * a number somebody types. See the `fx-compevery` control in ComposerView.
 */
export const REPEAT_CHOICES: readonly { value: RepeatChoice; label: string; intervalDays?: number }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Every day' },
  { value: 'every_n_days', label: 'Every 3 days', intervalDays: 3 },
  { value: 'every_n_days', label: 'Every 4 days', intervalDays: 4 },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
];

/** The gaps the fixed chips already cover. The blank owns everything else. */
const CHIP_INTERVALS: readonly number[] = REPEAT_CHOICES
  .filter((c) => c.value === 'every_n_days' && typeof c.intervalDays === 'number')
  .map((c) => c.intervalDays as number);

/** Which button row is open, if any. 'all' is the nothing-typed path. */
export type ComposerRow = 'who' | 'when' | 'repeat' | 'all';

/** How the value in a field was reached. Drives caramel against sage. */
export type ComposerSource = 'default' | 'parsed' | 'chosen';

export interface ComposerState {
  title: string;
  /** 'me' | a staff id | 'dept:<department>'. */
  who: string;
  /** YYYY-MM-DD. Defaults to today. */
  when: string;
  repeat: RepeatChoice;
  weekday: number;
  dayOfMonth: number;
  /**
   * How many days apart, when `repeat` is 'every_n_days'.
   *
   * Held as a STRING because it is what somebody is typing into the blank, and
   * a half-typed "1" on the way to "14" must not become a cadence. It is read
   * into a number exactly once, in composerPayload.
   */
  intervalDays: string;
  /**
   * Optional "HH:MM". Lifted from the sentence, never asked for: there is no
   * fourth word and no time picker. Somebody who writes "by 3pm" gets 3pm, and
   * somebody who does not gets exactly the row that existed before this did.
   */
  atTime: string | null;
  /** Which button row is open, if any. */
  openRow: ComposerRow | null;
  /**
   * True once somebody has tapped "Other" on the WHO row.
   *
   * The chip is a POINTER, not a person: it never touches `who`. All it does is
   * put the cursor back in the sentence and say that a name typed there works,
   * which is the one part of this control nobody discovers on their own.
   */
  otherHint: boolean;
  /** Per field, how the current value was reached. */
  source: { who: ComposerSource; when: ComposerSource; repeat: ComposerSource };
}

/** Type-and-enter means you, today, once. Nothing else to decide. */
export function composerDefaults(todayIso: string, todayWeekday: number): ComposerState {
  return {
    title: '',
    who: 'me',
    when: todayIso,
    repeat: 'once',
    weekday: todayWeekday,
    dayOfMonth: 1,
    intervalDays: '',
    atTime: null,
    openRow: null,
    otherHint: false,
    source: { who: 'default', when: 'default', repeat: 'default' },
  };
}

function weekdayOfIso(iso: string, fallback: number): number {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? fallback : d.getDay();
}

/**
 * Fold what the sentence said into the row.
 *
 * TWO RULES, and they are the whole of it.
 *
 * 1. A field somebody has TAPPED is never moved by typing. Once a person has
 *    answered a question with their thumb, the sentence does not get to argue.
 *
 * 2. A field the parser already claimed is never quietly reverted. The lift is
 *    destructive — "check the boiler every Friday" leaves "Check the boiler" in
 *    the field, so the words that produced the cadence are GONE by the time the
 *    next keystroke arrives. Re-deriving from the cleaned title would drop the
 *    cadence on the very next letter typed. A parsed value therefore stands
 *    until another parse claims the same field, or a button is tapped, or the
 *    row is emptied (which resets everything, in `composerDefaults`).
 */
export function withParse(
  state: ComposerState,
  result: ParseResult,
  todayWeekday: number,
  opts: { whoAs?: ComposerSource } = {},
): ComposerState {
  const source = { ...state.source };
  let { who, when, repeat, weekday, dayOfMonth, intervalDays } = state;

  if (source.who !== 'chosen' && result.who) {
    who = result.who;
    // A NAME IN A SENTENCE IS SAGE, not caramel. Writing "have Marcus check the
    // pool" is not something that was understood about the sentence; it is a
    // person deciding, out loud, who the work is for. A day and a cadence are
    // different: those are readings, and they wear caramel so a person can see
    // that something was worked out rather than said. The optional model
    // reading passes 'parsed' here, because a name it proposes IS a reading.
    source.who = opts.whoAs ?? 'chosen';
  }
  if (source.repeat !== 'chosen' && result.repeat) {
    repeat = result.repeat;
    // The gap travels WITH the cadence, or the blank keeps a number from the
    // last sentence and "every 3 days" typed over "every 10 days" files 10.
    intervalDays = result.repeat === 'every_n_days' && result.intervalDays
      ? String(result.intervalDays)
      : '';
    source.repeat = 'parsed';
  }
  if (source.when !== 'chosen' && result.when) {
    when = result.when;
    source.when = 'parsed';
  }
  if (typeof result.weekday === 'number') weekday = result.weekday;
  else if (result.when) weekday = weekdayOfIso(result.when, todayWeekday);
  if (typeof result.dayOfMonth === 'number') dayOfMonth = result.dayOfMonth;
  // The clock rides on WHEN and follows the same rule as WHEN: a day somebody
  // tapped is never argued with, so a time the sentence mentions is not applied
  // over it either. There is no button that sets a time, so there is no third
  // source to track.
  const atTime = state.source.when === 'chosen' ? state.atTime : (result.atTime ?? state.atTime);

  return { ...state, title: result.title, who, when, repeat, weekday, dayOfMonth, intervalDays, atTime, source };
}

/**
 * Apply an answer somebody tapped: the question's own patch, or a button.
 *
 * Everything it touches becomes 'chosen', which is what turns the word sage and
 * what makes rule 1 above bite from then on.
 */
export function withChoice(
  state: ComposerState,
  patch: Partial<ParseResult>,
  todayIso: string,
  todayWeekday: number,
): ComposerState {
  const source = { ...state.source };
  let { who, when, repeat, weekday, dayOfMonth, intervalDays, atTime } = state;
  // Answering the WHO question spends the Other hint: it exists to say that a
  // name can be typed, and somebody who just tapped a name did not need it.
  const otherHint = 'who' in patch ? false : state.otherHint;
  if ('who' in patch) {
    // "Other" is a pointer at the sentence, never an assignee. It cannot arrive
    // here, and it is refused here as well, because the one place a bad value
    // would be invisible is a to-do quietly handed to nobody.
    who = patch.who && patch.who !== COMPOSER_OTHER ? patch.who : 'me';
    source.who = 'chosen';
  }
  if ('repeat' in patch) { repeat = patch.repeat ?? 'once'; source.repeat = 'chosen'; }
  if ('intervalDays' in patch) intervalDays = patch.intervalDays ? String(patch.intervalDays) : '';
  else if ('repeat' in patch && patch.repeat !== 'every_n_days') intervalDays = '';
  if ('when' in patch) {
    // A repeating item has no single due date, so a null `when` in a patch is
    // "start today", not "no day at all".
    when = patch.when ?? todayIso;
    source.when = 'chosen';
  }
  if ('atTime' in patch) atTime = patch.atTime ?? null;
  if (typeof patch.weekday === 'number') weekday = patch.weekday;
  else if ('when' in patch && patch.when) weekday = weekdayOfIso(patch.when, todayWeekday);
  // Turning a one-off into a weekly one has to pick a day, and the only honest
  // answer is the day it was already going to happen on.
  else if ('repeat' in patch && (patch.repeat === 'weekly' || patch.repeat === 'biweekly')) {
    weekday = weekdayOfIso(when, todayWeekday);
  }
  if (typeof patch.dayOfMonth === 'number') dayOfMonth = patch.dayOfMonth;
  return { ...state, who, when, repeat, weekday, dayOfMonth, intervalDays, atTime, otherHint, source };
}

/** What the composer sends. Pure, so the defaults are provable without a fetch. */
export interface ComposerPayload {
  title: string;
  assignedStaffId: string | null;
  assignedDepartment: string | null;
  /**
   * The calendar DAY the work is due, YYYY-MM-DD — not an instant.
   *
   * The composer deliberately does not decide when that day ends. It used to
   * send `${day}T23:59:59Z`, which is the end of the day in Greenwich: a to-do
   * added on Tuesday morning in Texas turned red at 7pm that evening, and east
   * of Greenwich it landed on the wrong calendar square outright. Only the
   * server knows the hotel's timezone, so only the server can say when the
   * hotel's day is over.
   */
  dueDate: string | null;
  /**
   * Optional "HH:MM", the hotel's own wall clock. Sent alongside the DAY and
   * never folded into it: the server decides where a day ends, and a client
   * that turned "by 3pm" into an instant would be doing the exact thing the
   * dueDate comment above exists to stop.
   */
  dueTime: string | null;
  repeat: RepeatChoice;
  weekday?: number;
  dayOfMonth?: number;
  /** Only ever present on 'every_n_days', and never absent on it. */
  intervalDays?: number;
}

export function composerPayload(state: ComposerState, meStaffId: string | null): ComposerPayload | null {
  const title = state.title.trim();
  if (!title) return null;

  // A cadence that needs a number and has not been given a believable one is
  // not a cadence. It falls back to a one-off rather than being sent: a
  // template with no gap in it never spawns anything, and the person who typed
  // it would never find out why.
  const gap = state.repeat === 'every_n_days' ? readIntervalDays(state.intervalDays) : null;
  const repeat: RepeatChoice = state.repeat === 'every_n_days' && gap === null ? 'once' : state.repeat;

  let assignedStaffId: string | null = null;
  let assignedDepartment: string | null = null;
  // "Other" is the chip that points at the sentence. It is not a person, so a
  // row still carrying it is a row assigned to whoever is adding it.
  if (state.who === 'me' || state.who === COMPOSER_OTHER) assignedStaffId = meStaffId;
  else if (state.who.startsWith('dept:')) assignedDepartment = state.who.slice(5);
  else assignedStaffId = state.who;

  const payload: ComposerPayload = {
    title,
    assignedStaffId,
    assignedDepartment,
    // A repeating item has no single due date; the template decides each day.
    dueDate: repeat === 'once' && state.when ? state.when : null,
    // A repeating to-do keeps its time: the template carries it and stamps it
    // on every instance. Only the DAY is meaningless on a repeat, not the hour.
    dueTime: state.atTime ?? null,
    repeat,
  };
  if (repeat === 'weekly' || repeat === 'biweekly') payload.weekday = state.weekday;
  if (repeat === 'monthly') payload.dayOfMonth = state.dayOfMonth;
  if (repeat === 'every_n_days' && gap !== null) payload.intervalDays = gap;
  return payload;
}

export interface ComposerViewProps {
  /** True while the field has focus. Only drives the row's border. */
  open: boolean;
  state: ComposerState;
  people: readonly ComposerPerson[];
  /** The page's clock, so the WHEN buttons and the words agree with the list. */
  now: Date;
  /** At most one, and only for genuinely two-sided input. Never an error. */
  question?: ParseQuestion | null;
  busy?: boolean;
  error?: string | null;
  /** True while the mic is held. Speech is an input method, not a mode. */
  recording?: boolean;
  /** False where the browser has no speech input: the mic is then not offered. */
  micAvailable?: boolean;
  /** Shown once ever, under the row, after somebody's first plain-sentence add. */
  teachLine?: string | null;
  /**
   * Which rotating example the idle prompt is showing.
   *
   * A number rather than a string, so the SENTENCES stay in the copy producer
   * that the no-em-dash guard walks. The clock that advances it lives in
   * StaxisList: this file is hook-free.
   */
  promptTick?: number;
  /**
   * The row's own box, for the click-outside close.
   *
   * A ref is a prop, not a hook, so taking one here keeps this component
   * hook-free. The listener itself belongs to StaxisList, which is the only
   * thing on this screen allowed to touch the document.
   */
  boxRef?: React.Ref<HTMLDivElement>;
  onOpen: () => void;
  onCancel: () => void;
  onChange: (next: ComposerState) => void;
  onSubmit: () => void;
  onMicPress?: () => void;
  onMicRelease?: () => void;
}

/**
 * The three WHEN buttons: today, tomorrow, and a named day after that.
 *
 * The third one is the day AFTER tomorrow, named. Offering "Thursday" on a
 * Wednesday would be a third button for a day two of them already cover.
 */
export function whenChoices(now: Date): Array<{ label: string; iso: string }> {
  const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const named = at(2);
  return [
    { label: 'Today', iso: isoOfDay(at(0)) },
    { label: 'Tomorrow', iso: isoOfDay(at(1)) },
    { label: WEEKDAYS[named.getDay()], iso: isoOfDay(named) },
  ];
}

/**
 * Open the browser's own day picker from the "Pick a day" button.
 *
 * The native input is the only thing that can offer a real calendar, and it
 * cannot be made to look like the rest of the row. So the button is what a
 * person sees and the input sits behind it, off-screen, opened from here.
 * `showPicker` is the supported way in; focus is the fallback where it is not.
 */
function openDayPicker(button: HTMLElement): void {
  const input = button.parentElement?.querySelector('input[type="date"]') as HTMLInputElement | null;
  if (!input) return;
  try {
    const withPicker = input as HTMLInputElement & { showPicker?: () => void };
    if (typeof withPicker.showPicker === 'function') withPicker.showPicker();
    else input.focus();
  } catch {
    input.focus();
  }
}

/**
 * Put the cursor back in the sentence.
 *
 * Same trick `openDayPicker` uses and for the same reason: this file is
 * hook-free, so it cannot hold a ref to its own field. The DOM it walks is the
 * DOM it just rendered, three lines up.
 */
function focusSentence(from: HTMLElement | null | undefined): void {
  // Total, because this is the decorative half of the chip. The hint is state
  // and lands whatever happens; the cursor is a courtesy, and a chip that
  // throws because it could not find its own field would take the row down.
  try {
    const input = from?.closest?.('.fx-comp')?.querySelector('input.fx-comptitle') as HTMLInputElement | null;
    input?.focus();
  } catch { /* the hint is on the screen either way */ }
}

/**
 * The "add a to-do" row.
 *
 * ONE ROW on the timeline spine that takes a plain sentence. The only required
 * input is the words: it belongs to the person adding it, it is due today, and
 * it happens once. Three things are optional (who, when, repeat) and there are
 * two ways to reach each of them, side by side and equal:
 *
 *   1. Writing it. "check the boiler room every Friday" just works, and the
 *      person never has to know that was clever.
 *   2. Tapping the word that says it. Each of the three words on the right is
 *      both the readback AND the button, so there is nothing to go and find.
 *
 * Tapping a word opens ONE row of buttons inside this same row. Not a dropdown,
 * not a popover, not all three at once. Tapping a word with nothing typed opens
 * all three, because at that point the person is choosing rather than reading.
 *
 * Hook-free and fully controlled, like everything in this file.
 */
export function ComposerView({
  open, state, people, now, question = null, busy = false, error = null,
  recording = false, micAvailable = true, teachLine = null, promptTick = 0, boxRef,
  onOpen, onCancel, onChange, onSubmit, onMicPress, onMicRelease,
}: ComposerViewProps) {
  const set = (patch: Partial<ComposerState>) => onChange({ ...state, ...patch });
  const typed = state.title.trim().length > 0;
  const canSend = typed && !busy;
  const openRow = state.openRow;
  const repeating = state.repeat !== 'once';
  const todayIso = isoOfDay(now);
  const todayWeekday = now.getDay();
  const days = whenChoices(now);
  const gap = readIntervalDays(state.intervalDays);
  // The blank owns every gap the fixed chips do not. "Every 3 days" typed into
  // it lights the chip, not the blank, so one cadence is never selected twice.
  const customGap = state.repeat === 'every_n_days' && gap !== null && !CHIP_INTERVALS.includes(gap);
  const blankOpen = state.repeat === 'every_n_days' && (gap === null || customGap);

  // Tapping a word with NOTHING typed opens all three rows, and all three words
  // read as chosen: the person is looking at their own answers rather than at
  // something that was understood. The moment there is text, the colours go
  // back to telling the truth about where each value came from.
  const asChosen = openRow === 'all' && !typed;
  const wordClass = (field: 'who' | 'when' | 'repeat') => {
    const source = asChosen ? 'chosen' : state.source[field];
    if (source === 'parsed') return 'fx-compword fx-lift';
    if (source === 'chosen') return 'fx-compword fx-pick';
    return 'fx-compword';
  };

  const tapWord = (field: 'who' | 'when' | 'repeat') => {
    if (!typed) { set({ openRow: openRow === 'all' ? null : 'all' }); return; }
    set({ openRow: openRow === field ? null : field });
  };

  const showRow = (field: 'who' | 'when' | 'repeat') => openRow === field || openRow === 'all';
  // The foot carries the mono hint and nothing else now. The line explaining
  // that housekeepers are elsewhere was deleted on 2026-08-05: an answer to a
  // question nobody had asked, under a list of the people who ARE there.
  const foot = showRow('who');
  const trailing = openRow === null;

  const whoText = whoWord(state.who, people);
  const whenText = whenWord(state.when, now, { repeating, atTime: state.atTime });
  const repeatText = repeatWord(state.repeat, {
    weekday: state.weekday, dayOfMonth: state.dayOfMonth, intervalDays: gap,
  });
  const keyHint = busy ? COMPOSER_COPY.adding : (foot ? COMPOSER_COPY.enterToAdd : COMPOSER_COPY.enter);
  const tail: 'mic' | 'key' | null = recording
    ? 'mic'
    : (typed || busy ? 'key' : (micAvailable ? 'mic' : null));

  return (
    // `data-staxis-anchor` is a HANDLE, not a hook. Anything that needs to point
    // at this row from outside (the companion's arrow, for one) finds it by
    // attribute rather than by reaching into this component. Keep it stable:
    // renaming it silently unaims whatever is pointing at it.
    <div data-testid="composer" data-staxis-anchor="todo-composer" ref={boxRef}>
      <div className={`fx-comp${open || typed || openRow !== null ? ' fx-on' : ''}`}>
        <div className="fx-compline">
          {recording && (
            <span className="fx-compmeter" aria-hidden>
              <span className="fx-compbar" /><span className="fx-compbar" /><span className="fx-compbar" />
              <span className="fx-compbar" /><span className="fx-compbar" />
            </span>
          )}

          <input
            className={`fx-comptitle${recording ? ' fx-live' : ''}`}
            type="text"
            value={state.title}
            disabled={busy}
            /* A rotating real example, not a question. The accessible name
               below never rotates: a control that renames itself every few
               seconds is unusable with a screen reader. */
            placeholder={openRow === 'all' ? COMPOSER_COPY.promptChoosing : promptExample(promptTick)}
            aria-label="What needs doing"
            onFocus={onOpen}
            onChange={(e) => set({ title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSend) { e.preventDefault(); onSubmit(); return; }
              // Escape closes the buttons first, and only then gives up the row.
              if (e.key === 'Escape') {
                if (openRow !== null) { e.preventDefault(); set({ openRow: null }); return; }
                onCancel();
              }
            }}
          />

          <span className="fx-compw">
            <button
              type="button"
              className={wordClass('who')}
              aria-expanded={showRow('who')}
              aria-label={`${COMPOSER_COPY.whoLabel}: ${whoText}`}
              onClick={() => tapWord('who')}
            >
              {whoText}
            </button>
            <span className="fx-compdot" aria-hidden>·</span>
            <button
              type="button"
              className={wordClass('when')}
              aria-expanded={showRow('when')}
              aria-label={`${repeating ? COMPOSER_COPY.startsLabel : COMPOSER_COPY.whenLabel}: ${whenText}`}
              onClick={() => tapWord('when')}
            >
              {whenText}
            </button>
            <span className="fx-compdot" aria-hidden>·</span>
            <button
              type="button"
              className={wordClass('repeat')}
              aria-expanded={showRow('repeat')}
              aria-label={`${COMPOSER_COPY.repeatLabel}: ${repeatText}`}
              onClick={() => tapWord('repeat')}
            >
              {repeating && <CxIcon name="repeat" size={12} strokeWidth={1.9} />}
              {repeatText}
            </button>
          </span>

          {/* One thing at the end of the row, and only when the buttons are
              shut. The mic while there is nothing to send, the mono hint once
              there is. Nothing at all where the browser has no microphone and
              nothing has been typed: a hairline with nothing after it is a
              divider between one thing and no things. */}
          {trailing && tail !== null && <span className="fx-comprule" aria-hidden />}
          {trailing && tail === 'mic' && (
            <button
              type="button"
              className={`fx-compmic${recording ? ' fx-rec' : ''}`}
              aria-label="Speak instead of typing"
              aria-pressed={recording}
              onPointerDown={() => onMicPress?.()}
              onPointerUp={() => onMicRelease?.()}
              onPointerLeave={() => { if (recording) onMicRelease?.(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMicPress?.(); } }}
              onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMicRelease?.(); } }}
            >
              <CxIcon name="mic" size={15} />
            </button>
          )}
          {trailing && tail === 'key' && <span className="fx-compkey">{keyHint}</span>}
        </div>

        {/* THE QUESTION. Not an error: nothing is red, the row is not blocked,
            and Enter still works and takes the first answer. */}
        {question && (
          <div className="fx-compask" role="status" aria-live="polite">
            <span className="fx-compaskt">{question.prompt}</span>
            {question.choices.map((choice) => (
              <button
                key={choice.label}
                type="button"
                className="fx-compaskb"
                disabled={busy}
                onClick={() => onChange(withChoice(state, choice.patch, todayIso, todayWeekday))}
              >
                {choice.label}
              </button>
            ))}
            <span className="fx-compaskn">{enterTakesNote(question.choices[0]?.label ?? '')}</span>
          </div>
        )}

        {openRow !== null && (
          <div className="fx-compopen">
            {showRow('who') && (
              <div className="fx-comprow">
                <span className="fx-complab" id="fx-lab-who">{COMPOSER_COPY.whoLabel}</span>
                <span className="fx-compopts" role="radiogroup" aria-labelledby="fx-lab-who">
                  {[{ value: 'me', label: 'You' },
                    ...people.map((p) => ({ value: p.staffId, label: p.name })),
                    ...COMPOSER_ROLES].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={state.who === option.value}
                        disabled={busy}
                        className={`fx-compb${state.who === option.value ? ' fx-sel' : ''}`}
                        onClick={() => onChange(withChoice(state, { who: option.value === 'me' ? null : option.value }, todayIso, todayWeekday))}
                      >
                        {option.label}
                      </button>
                    ))}
                  {/* THE POINTER. Not a radio, not an assignee, and never
                      selected: it puts the cursor back in the sentence and
                      says that a name typed there works. Typing one already
                      worked; this is the only thing that makes it findable. */}
                  <button
                    type="button"
                    className="fx-compb fx-compother"
                    disabled={busy}
                    aria-label={COMPOSER_COPY.other}
                    onClick={(e) => {
                      focusSentence(e.currentTarget);
                      set({ otherHint: true });
                    }}
                  >
                    {COMPOSER_COPY.other}
                  </button>
                </span>
              </div>
            )}
            {showRow('who') && state.otherHint && (
              <div className="fx-comprow">
                <span className="fx-complab" aria-hidden />
                <span className="fx-comphint" role="status">
                  {otherHint(people[0]?.name ?? null)}
                </span>
              </div>
            )}

            {showRow('when') && (
              <div className="fx-comprow">
                <span className="fx-complab" id="fx-lab-when">
                  {repeating ? COMPOSER_COPY.startsLabel : COMPOSER_COPY.whenLabel}
                </span>
                <span className="fx-compopts" role="radiogroup" aria-labelledby="fx-lab-when">
                  {/* A repeating item starts on a day; it does not fall due on
                      one. So the third named weekday goes away and the row is
                      Today, Tomorrow, or a day you pick. */}
                  {days.slice(0, repeating ? 2 : 3).map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      role="radio"
                      aria-checked={state.when === choice.iso}
                      disabled={busy}
                      className={`fx-compb${state.when === choice.iso ? ' fx-sel' : ''}`}
                      onClick={() => onChange(withChoice(state, { when: choice.iso }, todayIso, todayWeekday))}
                    >
                      {choice.label}
                    </button>
                  ))}
                  <span className="fx-compdaywrap">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!days.some((c) => c.iso === state.when)}
                      disabled={busy}
                      className={`fx-compb${days.some((c) => c.iso === state.when) ? '' : ' fx-sel'}`}
                      onClick={(e) => openDayPicker(e.currentTarget)}
                    >
                      <CxIcon name="calendar" size={13} />
                      Pick a day
                    </button>
                    <input
                      className="fx-compday"
                      type="date"
                      tabIndex={-1}
                      aria-label="Pick a day"
                      value={state.when}
                      onChange={(e) => {
                        if (e.target.value) onChange(withChoice(state, { when: e.target.value }, todayIso, todayWeekday));
                      }}
                    />
                  </span>
                </span>
              </div>
            )}

            {showRow('repeat') && (
              <div className="fx-comprow">
                <span className="fx-complab" id="fx-lab-repeat">{COMPOSER_COPY.repeatLabel}</span>
                {/* ONE LINE, scrolled sideways. Not a wrapping block: the row
                    is a sentence somebody reads left to right, and a cadence
                    list that reflows to three rows is a form. */}
                <span className="fx-compopts fx-compscroll" role="radiogroup" aria-labelledby="fx-lab-repeat">
                  {REPEAT_CHOICES.map((choice) => {
                    const on = choice.value === 'every_n_days'
                      ? state.repeat === 'every_n_days' && gap === choice.intervalDays
                      : state.repeat === choice.value;
                    return (
                      <button
                        key={choice.label}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={busy}
                        className={`fx-compb${on ? ' fx-sel' : ''}`}
                        onClick={() => onChange(withChoice(
                          state,
                          { repeat: choice.value, intervalDays: choice.intervalDays ?? null },
                          todayIso,
                          todayWeekday,
                        ))}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                  {/* The blank. Any gap the chips do not cover, typed. It is a
                      chip that CONTAINS a field rather than a chip that opens
                      one: the number is the answer, so it belongs on the line
                      the answers are on. */}
                  <span className={`fx-compevery${blankOpen ? ' fx-sel' : ''}`}>
                    <span aria-hidden>{COMPOSER_COPY.everyNDaysChip}</span>
                    <input
                      className="fx-compnum"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={3}
                      size={3}
                      disabled={busy}
                      value={customGap || (state.repeat === 'every_n_days' && gap === null) ? state.intervalDays : ''}
                      aria-label={COMPOSER_COPY.everyNDaysLabel}
                      placeholder="__"
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 3);
                        // Typing a number IS choosing the cadence. Emptying it
                        // goes back to a one-off rather than leaving a repeat
                        // with no gap in it.
                        onChange(withChoice(
                          state,
                          digits
                            ? { repeat: 'every_n_days', intervalDays: Number(digits) }
                            : { repeat: 'once', intervalDays: null },
                          todayIso,
                          todayWeekday,
                        ));
                      }}
                    />
                    <span aria-hidden>{COMPOSER_COPY.everyNDaysUnit}</span>
                  </span>
                </span>
              </div>
            )}
            {showRow('repeat') && state.repeat === 'every_n_days' && gap === null && state.intervalDays !== '' && (
              <div className="fx-comprow">
                <span className="fx-complab" aria-hidden />
                <span className="fx-comphint" role="status">
                  {intervalHint(MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS)}
                </span>
              </div>
            )}
          </div>
        )}

        {foot && (
          <div className="fx-compfoot">
            <span className="fx-compkey">{keyHint}</span>
          </div>
        )}
      </div>

      {/* Under the row, never inside it. These are about what just happened. */}
      {recording && <div className="fx-compnote">{COMPOSER_COPY.speaking}</div>}
      {!recording && state.source.who !== 'default' && state.who !== 'me' && !state.who.startsWith('dept:') && (
        <div className="fx-compnote">{assignedNote(people.find((p) => p.staffId === state.who)?.name ?? '')}</div>
      )}
      {!recording && repeating && <div className="fx-compnote fx-warm">{COMPOSER_COPY.repeating}</div>}
      {!recording && teachLine && <div className="fx-compnote">{teachLine}</div>}

      {error && <div className="sl-err">{error}</div>}
    </div>
  );
}

/** Today in the browser's own calendar, as YYYY-MM-DD. */
function isoOfDay(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/**
 * "Marcus finished the lobby filters." One line per thing that came back since
 * you last looked, and then it is gone.
 *
 * Not a notification and not a toast: it does not chase anybody, it cannot be
 * missed by being away from the screen, and there is nothing to dismiss. It
 * clears when the drawer is opened, because opening the drawer IS having seen
 * it. Same discipline as the findings queue: nothing on this page ever has to
 * be cleared.
 */
export function AssignerNoticesView({ notices, onOpenDrawer }: {
  notices: readonly AssignedByMeItem[];
  onOpenDrawer?: () => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div data-testid="assigner-notices">
      {notices.map((n) => (
        <div className="fx-report" key={n.taskId}>{completionNotice(n)}</div>
      ))}
      {onOpenDrawer && (
        <button type="button" className="fx-more-link" onClick={() => onOpenDrawer()}>
          See what you assigned <span aria-hidden>→</span>
        </button>
      )}
    </div>
  );
}

/**
 * The rail's "Assigned by me" panel.
 *
 * A PANEL with its content showing, not a button that hides a view. That was
 * the core complaint the 2026-08-01 redesign answers: the old screen put
 * `Assigned by me` and `Log book` in a row of same-weight buttons, so what you
 * handed out was one click away from being invisible, and nobody clicked.
 *
 * ─── three, then the door (2026-08-05) ─────────────────────────────────────
 * The face used to be either the notices or the words "nothing has come back",
 * and everything you had handed out lived behind a link. So a manager with
 * eleven open assignments and nothing settled today read "nothing has come back
 * since you last looked" over an empty panel, which is the truth about the last
 * hour and says nothing at all about the eleven.
 *
 * Now the face carries THE THREE MOST RECENT, which is what you handed out most
 * recently and therefore what you are most likely to be wondering about, and
 * "Show more" opens the whole list, newest first, in a popup over the page. The
 * notices stay above them: something that came back three weeks after it was
 * assigned is news, and it would not be in the newest three.
 */
export function AssignedRailPanel({
  notices, entries, now, loading = false, readFailed = false, onOpen,
}: {
  notices: readonly AssignedByMeItem[];
  entries: readonly AssignedByMeItem[];
  now: Date;
  loading?: boolean;
  readFailed?: boolean;
  /** Opens the popup. Opening it is also what marks the notices as seen. */
  onOpen: () => void;
}) {
  const face = entries.slice(0, ASSIGNED_FACE_LIMIT);
  const more = assignedMoreLine(entries.length, face.length);
  return (
    <div className="fx-panel">
      <div className="fx-ptop">
        <span className="fx-pt">{ASSIGNED_COPY.title}</span>
        {notices.length > 0 && (
          <span className="fx-count">{notices.length} back</span>
        )}
      </div>

      <AssignerNoticesView notices={notices} />

      <AssignedByMeView entries={face} now={now} loading={loading} readFailed={readFailed} />

      {/* The door. Open whenever there is something behind it, and ALSO whenever
          something has come back, because opening it is what marks the notices
          as seen: a person with two assignments and one that just came back
          would otherwise carry that count forever. */}
      {(more || notices.length > 0) && (
        <button type="button" className="fx-more-link" onClick={onOpen}>
          {more ? ASSIGNED_COPY.showMore : ASSIGNED_COPY.seeAll}
          {more && <span className="fx-morec">{more}</span>}
        </button>
      )}
    </div>
  );
}

/**
 * Everything you assigned, newest first, over the page.
 *
 * A popup and not an expanding panel: the full list is unbounded, and a rail
 * column that grows to forty rows pushes the log book off the bottom of the
 * screen. The ordering is the read's own (created_at descending) and is not
 * re-sorted here; two sort orders for one list is how they drift.
 */
export function AssignedPopupView({
  open, entries, now, loading = false, readFailed = false, onClose,
}: {
  open: boolean;
  entries: readonly AssignedByMeItem[];
  now: Date;
  loading?: boolean;
  readFailed?: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div data-testid="assigned-popup">
      <button type="button" className="fx-scrim" aria-label={ASSIGNED_COPY.close} onClick={onClose} />
      <div className="fx-drawer" role="dialog" aria-modal="true" aria-label={ASSIGNED_COPY.popupTitle}>
        <div className="fx-drawerhead">
          <span style={{ minWidth: 0 }}>
            <span className="fx-drawert" style={{ display: 'block' }}>{ASSIGNED_COPY.popupTitle}</span>
            <span className="fx-drawers" style={{ display: 'block' }}>{ASSIGNED_COPY.popupNote}</span>
          </span>
          <button type="button" className="fx-drawerx" aria-label={ASSIGNED_COPY.close} onClick={onClose}>
            <CxIcon name="close" size={14} />
          </button>
        </div>
        <div className="fx-drawerbody" style={{ padding: '4px 22px 22px' }}>
          <AssignedByMeView entries={entries} now={now} loading={loading} readFailed={readFailed} />
        </div>
      </div>
    </div>
  );
}

/**
 * The rail's log book panel: today's notes, and the way in.
 *
 * ─── the switch is not here any more (2026-08-05) ──────────────────────────
 * "Show notes on the timeline" used to sit at the foot of this panel AND at the
 * foot of the opened log book. One preference, two controls, on one screen. The
 * clean view of the rail is a glance at what got written down today; a setting
 * about how the diary is displayed is not part of that glance and belongs where
 * somebody has already gone looking for the diary. It now lives ONLY inside the
 * popup, where its behaviour is exactly what it always was.
 */
export function LogbookRailPanel({ entries, onOpen }: {
  entries: readonly LogEntryDTO[];
  onOpen: () => void;
}) {
  return (
    <div className="fx-panel">
      <div className="fx-ptop">
        <span className="fx-pt">Log book</span>
        <span className="fx-tally-r">{entries.length === 1 ? '1 today' : `${entries.length} today`}</span>
      </div>

      {entries.length === 0 ? (
        <div className="fx-plain">Nothing written down today.</div>
      ) : (
        entries.slice(0, 3).map((e) => (
          <div className="fx-log" key={e.id}>
            <span className="fx-logt">{shortClock(e.createdAt)}</span>
            <span className="fx-logb">{e.title}</span>
          </div>
        ))
      )}

      <button type="button" className="fx-more-link" onClick={onOpen}>
        Open the log book <span aria-hidden>→</span>
      </button>
    </div>
  );
}

/**
 * The rail's one door into everything Staxis believes about this hotel.
 *
 * It REPLACES the old `Queue` / `Knows` tab pair outright. There is no queue
 * affordance any more, because the page IS the queue, and Knows opens over it
 * rather than navigating away from it.
 */
export function KnowsRailButton({ onOpen }: { onOpen: () => void }) {
  // No fact count under the label any more (2026-08-05). It used to read "37
  // facts about this hotel", which turned a knowledge screen into a score, and
  // a number nobody asked for is the first thing people start gaming.
  return (
    <button type="button" className="fx-knows" onClick={onOpen}>
      <span className="fx-knowsi"><CxIcon name="staxis" size={17} /></span>
      <span style={{ minWidth: 0 }}>
        <span className="fx-pt" style={{ display: 'block' }}>What Staxis knows</span>
      </span>
      <span className="fx-knowsgo" aria-hidden><CxIcon name="arrowUpRight" size={15} /></span>
    </button>
  );
}

/** "7:12a" — the log book's own timestamp form. Empty on an unusable value. */
export function shortClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = `${d.getMinutes()}`.padStart(2, '0');
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m}${h < 12 ? 'a' : 'p'}`;
}

// ─── Assigned by me ─────────────────────────────────────────────────────────

export interface AssignedByMeViewProps {
  entries: readonly AssignedByMeItem[];
  now: Date;
  loading?: boolean;
  readFailed?: boolean;
}

/**
 * What you handed out, and where it got to.
 *
 * Exists because a delegated task is deliberately NOT on your own list. Without
 * this the assigner has no way to check without asking, and an assigner who
 * cannot check stops delegating.
 *
 * A failed read is never rendered as "nothing outstanding" — that is the same
 * lie as an empty findings queue on an unchecked hotel.
 */
export function AssignedByMeView({ entries, now, loading = false, readFailed = false }: AssignedByMeViewProps) {
  if (readFailed) {
    return (
      <div data-testid="assigned-drawer">
        <div className="sl-err">
          Staxis could not read this just now. Do not read it as &quot;nothing outstanding&quot;.
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div data-testid="assigned-drawer">
        <div className="fx-plain" role="status" aria-live="polite">One moment…</div>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div data-testid="assigned-drawer">
        <div className="fx-plain">{ASSIGNED_COPY.empty}</div>
      </div>
    );
  }
  return (
    <div data-testid="assigned-drawer">
      {entries.map((e) => {
        const stale = stalenessLine(e);
        return (
          <div className="fx-drrow" key={e.taskId} data-assigned-state={e.state}>
            <div className="fx-drt">{e.title}</div>
            <div className="fx-drs">{assignedStateLine(e, now)}</div>
            {e.reason && <div className="fx-quote">&ldquo;{e.reason}&rdquo;</div>}
            {stale && <div className="fx-stale">{stale}</div>}
          </div>
        );
      })}
    </div>
  );
}
