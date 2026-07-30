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

export const LIST_CSS = `
.sl-row{margin-top:12px;}
.sl-from{font-size:11.5px;color:#8A9187;margin-bottom:2px;}
.sl-reason{margin-top:9px;display:flex;gap:7px;flex-wrap:wrap;align-items:center;}
.sl-input{flex:1;min-width:200px;height:34px;padding:0 11px;border-radius:10px;font-size:13px;
  border:1px solid rgba(31,35,28,.16);background:#fff;color:#1F231C;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.sl-input:focus{outline:2px solid #3E5C48;outline-offset:1px;}
.sl-hint{font-size:11.5px;color:#8A9187;margin-top:6px;line-height:1.5;}
.sl-add{display:flex;align-items:center;gap:9px;margin-top:14px;padding:11px 14px;width:100%;
  border-radius:14px;border:1px dashed rgba(31,35,28,.18);background:#FAFBF9;cursor:pointer;
  font-size:13.5px;color:#5C625C;text-align:left;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.sl-add:hover{background:#F4F6F2;border-color:rgba(62,92,72,.34);color:#3E5C48;}
.sl-add:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.sl-comp{margin-top:14px;border-radius:16px;border:1px solid rgba(62,92,72,.28);background:#fff;
  padding:13px 14px;}
.sl-title{width:100%;border:none;background:transparent;font-size:14.5px;font-weight:600;color:#1F231C;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;padding:2px 0;}
.sl-title:focus{outline:none;}
.sl-title::placeholder{color:#A6ABA6;font-weight:500;}
.sl-chips{display:flex;gap:7px;margin-top:11px;flex-wrap:wrap;align-items:center;}
.sl-chip{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border-radius:999px;
  border:1px solid rgba(31,35,28,.14);background:#fff;font-size:12px;color:#5C625C;cursor:pointer;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.sl-chip:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.sl-chipk{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;color:#A6ABA6;
  text-transform:uppercase;letter-spacing:.07em;}
.sl-chip select,.sl-chip input{border:none;background:transparent;font-size:12px;color:#1F231C;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;}
.sl-chip select:focus,.sl-chip input:focus{outline:none;}
.sl-err{margin-top:9px;border-radius:10px;padding:8px 11px;font-size:12.5px;line-height:1.5;
  background:rgba(184,92,61,.10);color:#8E432B;}
.sl-drawer{margin-top:12px;border-radius:16px;border:1px solid rgba(31,35,28,.09);background:#fff;
  padding:14px 15px;}
.sl-dr{padding:10px 0;border-bottom:1px solid rgba(31,35,28,.06);}
.sl-dr:last-child{border-bottom:none;}
.sl-drt{font-size:13.5px;font-weight:600;color:#1F231C;line-height:1.4;}
.sl-drs{font-size:12px;color:#5C625C;margin-top:3px;line-height:1.5;}
.sl-drq{font-size:12.5px;color:#8E432B;margin-top:4px;line-height:1.5;}
.sl-stale{font-size:11.5px;color:#8C6A33;margin-top:3px;}
.sl-note{margin-top:10px;border-radius:12px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:11px 13px;font-size:12.5px;line-height:1.6;color:#5C625C;}
.sl-sw{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;}
.sl-swl{font-size:13.5px;color:#1F231C;}
.sl-back{margin-top:12px;border-radius:14px;border:1px solid rgba(92,122,96,.28);background:rgba(158,183,166,.14);
  padding:11px 14px;}
.sl-backl{font-size:13px;color:#3E5C48;line-height:1.55;}
.sl-backl + .sl-backl{margin-top:3px;}
`;

/** Which chip colour a row wears. Matches the finding cards' severity chips so
 *  the list reads as one thing rather than two systems sharing a page. */
function rowChipClass(item: WorklistItem): string {
  if (item.overdue) return 'cx-rust';
  if (item.priority === 'urgent' || item.priority === 'high') return 'cx-caramel';
  return 'cx-sage';
}

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

  return (
    <div className="cx-dec sl-row" data-row-kind={item.sourceType} data-row-id={item.id}>
      <div className={`cx-dchip ${rowChipClass(item)}`}>
        <CxIcon name="staxis" size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cx-dec-eyebrow">{rowKindLabel(item.sourceType)}</div>
        {from && <div className="sl-from">{from}</div>}
        <div className="cx-dec-t">{item.title}</div>
        {item.location && <div className="cx-dec-s">{item.location}</div>}

        <div className="fd-meta">
          {due && <span className={`fd-metai${item.overdue ? ' fd-age' : ''}`}>{due}</span>}
          {item.assigneeName && <span className="fd-metai">{item.assigneeName}</span>}
        </div>

        {askingReason ? (
          <div className="sl-reason">
            <input
              className="sl-input"
              type="text"
              value={reasonDraft}
              placeholder="Why not? One line is enough."
              aria-label="Why you could not do it"
              onChange={(e) => onReasonChange?.(e.target.value)}
            />
            <button
              type="button"
              className="fd-act fd-yes"
              disabled={busy || !reasonReady}
              onClick={() => onCantSubmit?.(item)}
            >
              Send
            </button>
            <button type="button" className="fd-act" disabled={busy} onClick={() => onCancelReason?.()}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="fd-acts">
            {item.canComplete && (
              <button type="button" className="fd-act fd-yes" disabled={busy} onClick={() => onDone?.(item)}>
                Done
              </button>
            )}
            {canRefuse && (
              <button type="button" className="fd-act fd-danger" disabled={busy} onClick={() => onAskReason?.(item)}>
                Can&apos;t do this
              </button>
            )}
            {!item.canComplete && (
              <a className="fd-act" href={item.deepLink} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
                Open
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A shift note, when this person switched the log book into their list. */
export function LogRowView({ entry, onOpen }: { entry: LogEntryDTO; onOpen?: () => void }) {
  return (
    <div className="cx-dec sl-row" data-row-kind="log" data-row-id={entry.id}>
      <div className="cx-dchip cx-sage">
        <CxIcon name="staxis" size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cx-dec-eyebrow">Log book</div>
        {entry.authorName && <div className="sl-from">{entry.authorName} wrote</div>}
        <div className="cx-dec-t">{entry.title}</div>
        {entry.body && <div className="cx-dec-s">{entry.body.slice(0, 180)}</div>}
        <div className="fd-acts">
          <button type="button" className="fd-act" onClick={() => onOpen?.()}>Open the log book</button>
        </div>
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
  dueAt: string | null;
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
    dueAt: state.repeat === 'once' && state.when ? `${state.when}T23:59:59.000Z` : null,
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
  if (!open) {
    return (
      <button type="button" className="sl-add" onClick={onOpen} data-testid="composer-open">
        <span aria-hidden style={{ fontSize: 17, lineHeight: 1, color: '#5C7A60' }}>+</span>
        <span>Add something</span>
      </button>
    );
  }

  const set = (patch: Partial<ComposerState>) => onChange({ ...state, ...patch });
  const canSend = state.title.trim().length > 0 && !busy;

  return (
    <div className="sl-comp" data-testid="composer-open-row">
      <input
        className="sl-title"
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

      <div className="sl-chips">
        <label className="sl-chip">
          <span className="sl-chipk">Who</span>
          <select value={state.who} onChange={(e) => set({ who: e.target.value })} aria-label="Who">
            <option value="me">You</option>
            {people.map((p) => <option key={p.staffId} value={p.staffId}>{p.name}</option>)}
            {COMPOSER_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>

        {state.repeat === 'once' && (
          <label className="sl-chip">
            <span className="sl-chipk">When</span>
            <input type="date" value={state.when} onChange={(e) => set({ when: e.target.value })} aria-label="When" />
          </label>
        )}

        <label className="sl-chip">
          <span className="sl-chipk">Repeat</span>
          <select
            value={state.repeat}
            onChange={(e) => set({ repeat: e.target.value as RepeatChoice })}
            aria-label="Repeat"
          >
            {REPEAT_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>

        {(state.repeat === 'weekly' || state.repeat === 'biweekly') && (
          <label className="sl-chip">
            <span className="sl-chipk">Day</span>
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
          <label className="sl-chip">
            <span className="sl-chipk">Day</span>
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
        <div className="sl-hint">
          {repeatLabel(state.repeat, { weekday: state.weekday, dayOfMonth: state.dayOfMonth })}
          . It comes back on its own.
        </div>
      )}
      <div className="sl-hint">{HOUSEKEEPER_NOTE}</div>

      {error && <div className="sl-err">{error}</div>}

      <div className="fd-acts">
        <button type="button" className="fd-act fd-yes" disabled={!canSend} onClick={onSubmit}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="fd-act" disabled={busy} onClick={onCancel}>Cancel</button>
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
    <div className="sl-back" data-testid="assigner-notices">
      {notices.map((n) => (
        <div className="sl-backl" key={n.taskId}>{completionNotice(n)}</div>
      ))}
      <div className="fd-acts">
        <button type="button" className="fd-act" onClick={() => onOpenDrawer?.()}>See what you assigned</button>
      </div>
    </div>
  );
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
      <div className="sl-drawer" data-testid="assigned-drawer">
        <div className="sl-err">
          Staxis could not read this just now. Do not read it as &quot;nothing outstanding&quot;.
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="sl-drawer" data-testid="assigned-drawer">
        <div className="sl-drs" role="status" aria-live="polite">One moment…</div>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="sl-drawer" data-testid="assigned-drawer">
        <div className="sl-drs">You have not handed anything to anyone yet.</div>
      </div>
    );
  }
  return (
    <div className="sl-drawer" data-testid="assigned-drawer">
      {entries.map((e) => {
        const stale = stalenessLine(e);
        return (
          <div className="sl-dr" key={e.taskId} data-assigned-state={e.state}>
            <div className="sl-drt">{e.title}</div>
            <div className="sl-drs">{assignedStateLine(e, now)}</div>
            {e.reason && <div className="sl-drq">&ldquo;{e.reason}&rdquo;</div>}
            {stale && <div className="sl-stale">{stale}</div>}
          </div>
        );
      })}
    </div>
  );
}
