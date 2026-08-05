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
  assignedNote,
  assignedStateLine,
  completionNotice,
  COMPOSER_COPY,
  COMPOSER_ROLES,
  dueLine,
  enterTakesNote,
  HOUSEKEEPER_NOTE,
  repeatWord,
  rowFrom,
  rowKindLabel,
  stalenessLine,
  WEEKDAYS,
  whenWord,
  whoWord,
} from '@/lib/feed/one-list-copy';
import type { ComposerPerson, ParseQuestion, ParseResult, RepeatChoice } from '@/lib/feed/parse-todo';

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
`;

export interface WorkRowViewProps {
  item: WorklistItem;
  now: Date;
  busy?: boolean;
  /** True while this row is asking for the one-line reason. */
  askingReason?: boolean;
  reasonDraft?: string;
  onDone?: (item: WorklistItem) => void;
  onAskReason?: (item: WorklistItem) => void;
  onReasonChange?: (value: string) => void;
  onCantSubmit?: (item: WorklistItem) => void;
  onCancelReason?: () => void;
}

/**
 * One thing that needs a person, that is not an AI finding.
 *
 * Two buttons on a to-do, and they mean different things: Done is a claim the
 * work happened; "Can't do this" is a claim it did not, WITH the reason,
 * because the assigner otherwise learns only that nothing happened and has to
 * go and ask. That round trip is the thing the receipt replaces, so the reason
 * box is not optional and the submit stays disabled until there is one.
 */
export function WorkRowView({
  item, now, busy = false, askingReason = false, reasonDraft = '',
  onDone, onAskReason, onReasonChange, onCantSubmit, onCancelReason,
}: WorkRowViewProps) {
  const from = rowFrom(item);
  const due = dueLine(item.dueDate, now);
  const canRefuse = item.sourceType === 'task';
  const reasonReady = reasonDraft.trim().length > 0;

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
  // Everything the one-line row cannot hold: who handed it over, and where.
  const sub = [from, item.location].filter(Boolean).join(' · ');

  return (
    <div
      className={`fx-row${item.overdue ? ' fx-late' : ''}${askingReason ? ' fx-open' : ''}`}
      data-row-kind={item.sourceType}
      data-row-id={item.id}
    >
      <div className="fx-rowb">
        <div className="fx-rowt">{item.title}</div>
        {sub && <div className="fx-rowsub">{sub}</div>}
      </div>

      {meta && <span className={`fx-rowm${item.overdue ? ' fx-late' : ''}`}>{meta}</span>}

      <div className="fx-rowa">
        {item.canComplete && (
          <button type="button" className="fx-btn fx-primary" disabled={busy || askingReason} onClick={() => onDone?.(item)}>
            Done
          </button>
        )}
        {canRefuse && !askingReason && (
          <button type="button" className="fx-btn" disabled={busy} onClick={() => onAskReason?.(item)}>
            Can&apos;t do this
          </button>
        )}
        {!item.canComplete && (
          <a className="fx-btn" href={item.deepLink}>Open</a>
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
    </div>
  );
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
export { COMPOSER_ROLES, HOUSEKEEPER_NOTE } from '@/lib/feed/one-list-copy';

/**
 * The cadences the REPEAT row offers.
 *
 * `weekdays` is deliberately absent: it exists in the write path for templates
 * created elsewhere, and offering "every weekday" beside "every day" on a row
 * somebody is skimming is one distinction too many. The labels are the design's
 * own words, so the button and the word above it are recognisably the same
 * thing said twice.
 */
export const REPEAT_CHOICES: readonly { value: RepeatChoice; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
];

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
  /** Which button row is open, if any. */
  openRow: ComposerRow | null;
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
    openRow: null,
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
  let { who, when, repeat, weekday, dayOfMonth } = state;

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
    source.repeat = 'parsed';
  }
  if (source.when !== 'chosen' && result.when) {
    when = result.when;
    source.when = 'parsed';
  }
  if (typeof result.weekday === 'number') weekday = result.weekday;
  else if (result.when) weekday = weekdayOfIso(result.when, todayWeekday);
  if (typeof result.dayOfMonth === 'number') dayOfMonth = result.dayOfMonth;

  return { ...state, title: result.title, who, when, repeat, weekday, dayOfMonth, source };
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
  let { who, when, repeat, weekday, dayOfMonth } = state;
  if ('who' in patch) { who = patch.who ?? 'me'; source.who = 'chosen'; }
  if ('repeat' in patch) { repeat = patch.repeat ?? 'once'; source.repeat = 'chosen'; }
  if ('when' in patch) {
    // A repeating item has no single due date, so a null `when` in a patch is
    // "start today", not "no day at all".
    when = patch.when ?? todayIso;
    source.when = 'chosen';
  }
  if (typeof patch.weekday === 'number') weekday = patch.weekday;
  else if ('when' in patch && patch.when) weekday = weekdayOfIso(patch.when, todayWeekday);
  // Turning a one-off into a weekly one has to pick a day, and the only honest
  // answer is the day it was already going to happen on.
  else if ('repeat' in patch && (patch.repeat === 'weekly' || patch.repeat === 'biweekly')) {
    weekday = weekdayOfIso(when, todayWeekday);
  }
  if (typeof patch.dayOfMonth === 'number') dayOfMonth = patch.dayOfMonth;
  return { ...state, who, when, repeat, weekday, dayOfMonth, source };
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
  repeat: RepeatChoice;
  weekday?: number;
  dayOfMonth?: number;
}

export function composerPayload(state: ComposerState, meStaffId: string | null): ComposerPayload | null {
  const title = state.title.trim();
  if (!title) return null;

  let assignedStaffId: string | null = null;
  let assignedDepartment: string | null = null;
  if (state.who === 'me') assignedStaffId = meStaffId;
  else if (state.who.startsWith('dept:')) assignedDepartment = state.who.slice(5);
  else assignedStaffId = state.who;

  const payload: ComposerPayload = {
    title,
    assignedStaffId,
    assignedDepartment,
    // A repeating item has no single due date; the template decides each day.
    dueDate: state.repeat === 'once' && state.when ? state.when : null,
    repeat: state.repeat,
  };
  if (state.repeat === 'weekly' || state.repeat === 'biweekly') payload.weekday = state.weekday;
  if (state.repeat === 'monthly') payload.dayOfMonth = state.dayOfMonth;
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
  recording = false, micAvailable = true, teachLine = null,
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
  // The housekeeping line belongs to the WHO row, and to the all-three view. It
  // is never on the idle row: a line explaining who is missing, over a row
  // nobody has asked anything of yet, is noise.
  const foot = showRow('who');
  const trailing = openRow === null;

  const whoText = whoWord(state.who, people);
  const whenText = whenWord(state.when, now, { repeating });
  const repeatText = repeatWord(state.repeat, { weekday: state.weekday, dayOfMonth: state.dayOfMonth });
  const keyHint = busy ? COMPOSER_COPY.adding : (foot ? COMPOSER_COPY.enterToAdd : COMPOSER_COPY.enter);
  const tail: 'mic' | 'key' | null = recording
    ? 'mic'
    : (typed || busy ? 'key' : (micAvailable ? 'mic' : null));

  return (
    <div data-testid="composer">
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
            placeholder={openRow === 'all' ? COMPOSER_COPY.promptChoosing : COMPOSER_COPY.prompt}
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
                <span className="fx-compopts" role="radiogroup" aria-labelledby="fx-lab-repeat">
                  {REPEAT_CHOICES.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      role="radio"
                      aria-checked={state.repeat === choice.value}
                      disabled={busy}
                      className={`fx-compb${state.repeat === choice.value ? ' fx-sel' : ''}`}
                      onClick={() => onChange(withChoice(state, { repeat: choice.value }, todayIso, todayWeekday))}
                    >
                      {choice.label}
                    </button>
                  ))}
                </span>
              </div>
            )}
          </div>
        )}

        {foot && (
          <div className="fx-compfoot">
            <span className="fx-compfootl">{HOUSEKEEPER_NOTE}</span>
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
      <button type="button" className="fx-more-link" onClick={() => onOpenDrawer?.()}>
        See what you assigned <span aria-hidden>→</span>
      </button>
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
 * What came back since you last looked sits on the face of it. The full list is
 * one link further in, and opening it is what marks the notices as seen.
 */
export function AssignedRailPanel({
  notices, entries, now, open, loading = false, readFailed = false, onOpen, onClose,
}: {
  notices: readonly AssignedByMeItem[];
  entries: readonly AssignedByMeItem[];
  now: Date;
  open: boolean;
  loading?: boolean;
  readFailed?: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fx-panel">
      <div className="fx-ptop">
        <span className="fx-pt">Assigned by me</span>
        {notices.length > 0 && (
          <span className="fx-count">{notices.length} back</span>
        )}
      </div>

      {open ? (
        <>
          <AssignedByMeView entries={entries} now={now} loading={loading} readFailed={readFailed} />
          <button type="button" className="fx-more-link" onClick={onClose}>Show less</button>
        </>
      ) : notices.length > 0 ? (
        <AssignerNoticesView notices={notices} onOpenDrawer={onOpen} />
      ) : (
        <>
          <div className="fx-plain">Nothing has come back since you last looked.</div>
          <button type="button" className="fx-more-link" onClick={onOpen}>
            See what you assigned <span aria-hidden>→</span>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The rail's log book panel: today's notes, and the switch that decides whether
 * they also appear as rows on the timeline.
 *
 * The switch is the same stored preference the log-book popup owns
 * (`feed_prefs.logbookInList`); it is surfaced here as well because this is
 * where a manager is looking when they wonder why the diary is or is not in
 * their day.
 */
export function LogbookRailPanel({
  entries, mergeOn, mergeReady, mergeBusy, mergeError, onToggleMerge, onOpen,
}: {
  entries: readonly LogEntryDTO[];
  mergeOn: boolean;
  mergeReady: boolean;
  mergeBusy?: boolean;
  mergeError?: string | null;
  onToggleMerge: (next: boolean) => void;
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

      {mergeError && <div className="sl-err">{mergeError}</div>}

      <div className="fx-foot">
        <span className="fx-footl" id="fx-logsw-label">Show notes on the timeline</span>
        <button
          type="button"
          className="fx-sw"
          role="switch"
          aria-checked={mergeOn}
          aria-labelledby="fx-logsw-label"
          disabled={!mergeReady || mergeBusy === true}
          onClick={() => onToggleMerge(!mergeOn)}
        />
      </div>
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
export function KnowsRailButton({ factCount, onOpen }: {
  /** Null while the count has not been read. The subtitle then says nothing
   *  about how much is known rather than claiming a number. */
  factCount: number | null;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="fx-knows" onClick={onOpen}>
      <span className="fx-knowsi"><CxIcon name="staxis" size={17} /></span>
      <span style={{ minWidth: 0 }}>
        <span className="fx-pt" style={{ display: 'block' }}>What Staxis knows</span>
        {factCount !== null && (
          <span className="fx-ps" style={{ display: 'block' }}>
            {factCount === 1 ? '1 fact about this hotel' : `${factCount.toLocaleString('en-US')} facts about this hotel`}
          </span>
        )}
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
        <div className="fx-plain">You have not handed anything to anyone yet.</div>
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
