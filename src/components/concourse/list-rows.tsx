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
  assignedStateLine,
  completionNotice,
  dueLine,
  repeatLabel,
  rowFrom,
  rowKindLabel,
  stalenessLine,
  WEEKDAYS,
} from '@/lib/feed/one-list-copy';

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

/** What the Who chip can say. A department option is "whoever is on shift". */
export interface ComposerPerson { staffId: string; name: string }

export type RepeatChoice = 'once' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';

export const REPEAT_CHOICES: readonly { value: RepeatChoice; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
];

/**
 * The role targets. HOUSEKEEPING IS NOT HERE, AND NEITHER ARE HOUSEKEEPERS in
 * the people list — see HOUSEKEEPER_NOTE. Offering a target whose work would
 * land on a screen they never open would be worse than not offering it.
 */
export const COMPOSER_ROLES: readonly { value: string; label: string }[] = [
  { value: 'dept:front_desk', label: "Whoever's on front desk" },
  { value: 'dept:maintenance', label: 'Maintenance' },
  { value: 'dept:all_staff', label: 'Everyone' },
];

export const HOUSEKEEPER_NOTE =
  'Housekeepers work from the housekeeping board, so they are not on this list.';

export interface ComposerState {
  title: string;
  /** 'me' | a staff id | 'dept:<department>'. */
  who: string;
  /** YYYY-MM-DD. Defaults to today. */
  when: string;
  repeat: RepeatChoice;
  weekday: number;
  dayOfMonth: number;
}

/** Type-and-enter means you, today, once. Nothing else to decide. */
export function composerDefaults(todayIso: string, todayWeekday: number): ComposerState {
  return { title: '', who: 'me', when: todayIso, repeat: 'once', weekday: todayWeekday, dayOfMonth: 1 };
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
  open: boolean;
  state: ComposerState;
  people: readonly ComposerPerson[];
  busy?: boolean;
  error?: string | null;
  onOpen: () => void;
  onCancel: () => void;
  onChange: (next: ComposerState) => void;
  onSubmit: () => void;
}

/**
 * The "+" row. Tapping it opens an INLINE row in the list, never a pop-up
 * window: a modal takes over the screen to capture one sentence, and the whole
 * point is that adding a to-do costs about as much as thinking of one.
 *
 * Type and press Enter and you are done. The three chips are already answered
 * (you, today, once) and only get touched when the answer is something else.
 */
export function ComposerView({
  open, state, people, busy = false, error = null, onOpen, onCancel, onChange, onSubmit,
}: ComposerViewProps) {
  const set = (patch: Partial<ComposerState>) => onChange({ ...state, ...patch });
  const canSend = state.title.trim().length > 0 && !busy;

  // The closed state already SHOWS its answers. The two chips are not controls
  // you have to go and find: they are the sentence "you, once", sitting where
  // they will still be sitting after the row opens.
  if (!open) {
    const whoLabel = state.who === 'me'
      ? 'You'
      : people.find((p) => p.staffId === state.who)?.name
        ?? COMPOSER_ROLES.find((r) => r.value === state.who)?.label
        ?? 'You';
    const repeatWord = REPEAT_CHOICES.find((r) => r.value === state.repeat)?.label ?? 'Once';
    return (
      <button type="button" className="fx-comp" onClick={onOpen} data-testid="composer-open">
        <span className="fx-compp">Add something to today</span>
        <span className="fx-chips" aria-hidden>
          <span className="fx-chip"><span className="fx-chipk">Who</span>{whoLabel}</span>
          <span className="fx-chip"><span className="fx-chipk">Repeat</span>{repeatWord}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="fx-compopen" data-testid="composer-open-row">
      <input
        className="fx-comptitle"
        type="text"
        autoFocus
        value={state.title}
        placeholder="What needs doing?"
        aria-label="What needs doing"
        onChange={(e) => set({ title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSend) { e.preventDefault(); onSubmit(); }
          if (e.key === 'Escape') onCancel();
        }}
      />

      <div className="fx-compchips">
        <label className="fx-chip">
          <span className="fx-chipk">Who</span>
          <select value={state.who} onChange={(e) => set({ who: e.target.value })} aria-label="Who">
            <option value="me">You</option>
            {people.map((p) => <option key={p.staffId} value={p.staffId}>{p.name}</option>)}
            {COMPOSER_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>

        {state.repeat === 'once' && (
          <label className="fx-chip">
            <span className="fx-chipk">When</span>
            <input type="date" value={state.when} onChange={(e) => set({ when: e.target.value })} aria-label="When" />
          </label>
        )}

        <label className="fx-chip">
          <span className="fx-chipk">Repeat</span>
          <select
            value={state.repeat}
            onChange={(e) => set({ repeat: e.target.value as RepeatChoice })}
            aria-label="Repeat"
          >
            {REPEAT_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>

        {(state.repeat === 'weekly' || state.repeat === 'biweekly') && (
          <label className="fx-chip">
            <span className="fx-chipk">Day</span>
            <select
              value={String(state.weekday)}
              onChange={(e) => set({ weekday: Number(e.target.value) })}
              aria-label="Day of the week"
            >
              {WEEKDAYS.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
            </select>
          </label>
        )}

        {state.repeat === 'monthly' && (
          <label className="fx-chip">
            <span className="fx-chipk">Day</span>
            <select
              value={String(state.dayOfMonth)}
              onChange={(e) => set({ dayOfMonth: Number(e.target.value) })}
              aria-label="Day of the month"
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={String(d)}>{d}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {state.repeat !== 'once' && (
        <div className="fx-hint">
          {repeatLabel(state.repeat, { weekday: state.weekday, dayOfMonth: state.dayOfMonth })}
          . It comes back on its own.
        </div>
      )}
      <div className="fx-hint">{HOUSEKEEPER_NOTE}</div>

      {error && <div className="sl-err">{error}</div>}

      <div className="fx-acts">
        <button type="button" className="fx-btn fx-primary" disabled={!canSend} onClick={onSubmit}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="fx-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
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
