'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The list, on a calendar.
//
// The founder's line: "calendar = a view of the same list items with dates".
// So this is NOT a second data source and NOT a second app. It takes the rows
// the list already has, keeps the ones that name a day, and puts them on one.
// Anything with no date simply is not here, which is the honest answer: a work
// order nobody has dated does not belong on a Tuesday.
//
// The hotel's own dated events (training days, vendor visits, brand audits)
// share the grid, because they are also things on days and they had nowhere
// else to go once Communications became Messages. They keep their own
// add/delete flow, which still runs through /api/knowledge/events and its
// manage_knowledge capability check.
//
// HOOK-FREE AND CONTROLLED, like every other view in this folder: the suite
// runs under `--conditions=react-server`, so a component with state cannot be
// exercised. The month being shown and the day selected live in StaxisList.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { EVENT_COPY, pickedDaysLine } from '@/lib/feed/one-list-copy';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import type { WorklistItem } from '@/lib/worklist/types';

import { CxIcon } from './icons';

export const CALENDAR_CSS = `
.sc-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.sc-mon{font-size:14.5px;font-weight:600;color:#1F231C;}
.sc-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:11px;}
.sc-dow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;color:#A6ABA6;
  text-transform:uppercase;letter-spacing:.07em;text-align:center;padding-bottom:2px;}
.sc-day{height:42px;border-radius:9px;border:1px solid rgba(31,35,28,.07);background:#fff;
  padding:5px 6px;cursor:pointer;text-align:left;display:flex;flex-direction:column;
  justify-content:space-between;gap:3px;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.sc-day:disabled{background:transparent;border-color:transparent;cursor:default;}
.sc-day.sc-today{background:#F1F5F0;border:1.5px solid #3E5C48;}
.sc-day.sc-today .sc-dn{font-weight:600;color:#1F231C;}
.sc-day.sc-on:not(.sc-today){border-color:#5C7A60;background:#F7FAF6;}
.sc-day:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.sc-dn{font-size:11px;color:#5C625C;font-family:var(--font-geist-mono),ui-monospace,monospace;line-height:1;}
.sc-dots{display:flex;gap:3px;flex-wrap:wrap;}
.sc-dot{width:5px;height:5px;border-radius:50%;background:#5C7A60;}
.sc-dot.sc-late{background:#B85C3D;}
.sc-dot.sc-ev{background:#4B8C9E;}
.sc-legend{display:flex;align-items:center;gap:13px;margin-top:13px;padding-top:11px;flex-wrap:wrap;
  border-top:1px solid rgba(31,35,28,.07);}
.sc-key{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#8A9187;}
.sc-add{margin-left:auto;font-size:12.5px;font-weight:600;color:#3E5C48;background:none;border:none;
  padding:0;cursor:pointer;font-family:inherit;white-space:nowrap;}
.sc-add:hover{text-decoration:underline;text-underline-offset:3px;}
.sc-add:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;border-radius:4px;}
.sc-sel{margin-top:12px;font-size:13px;font-weight:600;color:#1F231C;}
.sc-ev-row{display:flex;align-items:center;gap:10px;padding:9px 0;
  border-bottom:1px solid rgba(31,35,28,.06);}
.sc-ev-t{flex:1;min-width:0;font-size:13.5px;color:#1F231C;}
.sc-none{margin-top:10px;font-size:12.5px;color:#8A9187;}

/* ── The month, at the size a month wants to be ──
   The 2026-08-01 popover was a 388px card hanging off a button: a whole month
   in cells 42px tall, which is a thumbnail of a calendar rather than one you
   can pick a range on. This is the same grid, opened over the page, with room
   for the add-an-event panel beside it rather than instead of it. */
.sc-wrap{display:flex;gap:20px;align-items:flex-start;min-width:0;}
.sc-mgrid{flex:1;min-width:0;}
.sc-big .sc-day{height:74px;border-radius:11px;padding:7px 8px;}
.sc-big .sc-dn{font-size:12.5px;}
.sc-big .sc-grid{gap:6px;margin-top:13px;}
.sc-big .sc-mon{font-size:17px;}
.sc-big .sc-dow{font-size:10px;}
/* Picking a range: the ends are solid, the days between are washed. A drag has
   to be visible WHILE it happens or nobody believes the drag worked.

   While a range is being picked the grid also OWNS the drag. Without that a
   finger moving across the days scrolls the popup instead, the pointer stream
   is cancelled, and the range stays stuck on the day it started on: the one
   gesture the hint describes was the one gesture a phone could not make. */
.sc-big.sc-picking .sc-grid,.sc-big.sc-picking .sc-day{touch-action:none;}
.sc-big.sc-picking .sc-day{cursor:crosshair;}
.sc-day.sc-inrange{background:rgba(92,122,96,.13);border-color:rgba(92,122,96,.3);}
.sc-day.sc-edge{background:#3E5C48;border-color:#3E5C48;}
.sc-day.sc-edge .sc-dn{color:#fff;font-weight:600;}
.sc-day.sc-edge .sc-dot{background:rgba(255,255,255,.75);}
.sc-hint{margin-top:11px;font-size:11.5px;color:#8A9187;line-height:1.5;}

/* The side panel. Beside the month, never over it: the month is the control. */
.sc-panel{width:288px;flex-shrink:0;border-left:1px solid rgba(31,35,28,.08);padding-left:20px;
  display:flex;flex-direction:column;gap:12px;}
.sc-plab{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9px;letter-spacing:.11em;
  text-transform:uppercase;color:#A6ABA6;display:block;margin-bottom:5px;}
.sc-field{width:100%;box-sizing:border-box;border:1px solid rgba(31,35,28,.14);border-radius:10px;
  padding:9px 11px;font-family:inherit;font-size:13.5px;color:#1F231C;background:#fff;outline:none;}
.sc-field:focus{outline:2px solid #3E5C48;outline-offset:1px;}
textarea.sc-field{resize:vertical;min-height:66px;line-height:1.5;}
.sc-picked{font-size:13.5px;font-weight:600;color:#1F231C;line-height:1.45;}
.sc-picked.sc-empty{font-weight:400;color:#8A9187;}
.sc-pacts{display:flex;gap:8px;margin-top:2px;flex-wrap:wrap;}

@media (max-width:860px){
  /* Stacked, the month is ABOVE the panel rather than beside it, so it wants
     the whole width. align-items:flex-start on the row turns into "shrink to
     your own content" once the direction is column, which drew a whole month
     into 233px of a 353px popup: 29px days on a phone. */
  .sc-wrap{flex-direction:column;align-items:stretch;}
  .sc-mgrid{width:100%;}
  .sc-panel{width:100%;border-left:none;padding-left:0;padding-top:16px;
    border-top:1px solid rgba(31,35,28,.08);}
  .sc-big .sc-day{height:56px;}
}

/* On a phone: a day is something you hit with a thumb, and the two boxes you
   type into are 16px so iOS does not zoom the popup the moment you tap them. */
@media (max-width:760px){
  .sc-grid{gap:5px;}
  .sc-big .sc-grid{gap:5px;}
  .sc-big .sc-day{height:52px;border-radius:10px;padding:6px;}
  .sc-field{font-size:16px;}
  .sc-add{min-height:40px;display:inline-flex;align-items:center;}
  .sc-legend{gap:11px;}
  /* Stacked under the month, the panel's two answers would otherwise sit
     below the fold of the popup's own scroller, so somebody who had just
     dragged a range across the grid could not see the button that saves it.
     Sticky keeps Save on screen for the whole of the typing. */
  .sc-pacts{position:sticky;bottom:0;z-index:1;background:#fff;margin-top:0;
    padding:10px 0 4px;box-shadow:0 -10px 14px -14px rgba(31,42,32,.7);}
}
`;

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const WEEK_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** YYYY-MM-DD in the reader's own timezone. */
export function isoDay(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The day a row belongs on, or null.
 *
 * Its due date, and nothing else. Deliberately NOT falling back to when it was
 * created: "created on Tuesday" put on Tuesday's square reads as "due Tuesday",
 * and a calendar that invents deadlines is worse than one with gaps in it.
 *
 * ─── whose Tuesday ─────────────────────────────────────────────────────────
 * The HOTEL's, and the server is the only side that can say. `dueDate` is an
 * instant, and "due today" is stored as the last millisecond of the hotel's
 * day: 23:59:59.999 in Beaumont is 00:59 the NEXT morning in New York. Reading
 * the day off it in the browser therefore moved every dated row one square
 * forward for any reader east of the hotel, so a VP covering two zones saw
 * dots on the wrong days and an empty page when they clicked the right one.
 * Invisible to a manager sitting in their own hotel, which is why it survived.
 *
 * `dueDay` is that answer, worked out server-side in the hotel's calendar. The
 * instant is still read when it is absent, so a row from an older payload, or
 * one of the sources that genuinely carries only a moment, lands exactly where
 * it always did.
 */
export function dayOf(item: Pick<WorklistItem, 'dueDate' | 'dueDay'>): string | null {
  const day = item.dueDay;
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  if (!item.dueDate) return null;
  const t = Date.parse(item.dueDate);
  if (Number.isNaN(t)) return null;
  return isoDay(new Date(t));
}

export interface CalendarCell {
  /** null for the leading/trailing blanks that pad the grid to whole weeks. */
  iso: string | null;
  dayOfMonth: number | null;
  items: WorklistItem[];
  events: KnowledgeEventDTO[];
}

/**
 * One month as 7-wide rows of cells. Pure, so "does an item land on the right
 * square" is answerable without a renderer, and so a month that starts on a
 * Sunday and one that starts on a Saturday can both be checked.
 */
export function monthCells(
  year: number,
  monthIndex: number,
  items: readonly WorklistItem[],
  events: readonly KnowledgeEventDTO[],
): CalendarCell[] {
  const first = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const lead = first.getDay();

  const byDay = new Map<string, WorklistItem[]>();
  for (const item of items) {
    const iso = dayOf(item);
    if (!iso) continue;
    const bucket = byDay.get(iso);
    if (bucket) bucket.push(item); else byDay.set(iso, [item]);
  }

  const eventsByDay = new Map<string, KnowledgeEventDTO[]>();
  for (const ev of events) {
    // A multi-day event shows on every day it covers; a vendor here all week is
    // here on Wednesday too.
    const start = ev.eventDate;
    const end = ev.endDate ?? ev.eventDate;
    for (let d = new Date(`${start}T12:00:00`); isoDay(d) <= end; d.setDate(d.getDate() + 1)) {
      const iso = isoDay(d);
      const bucket = eventsByDay.get(iso);
      if (bucket) bucket.push(ev); else eventsByDay.set(iso, [ev]);
      if (iso >= end) break;
    }
  }

  const cells: CalendarCell[] = [];
  for (let i = 0; i < lead; i++) cells.push({ iso: null, dayOfMonth: null, items: [], events: [] });
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = isoDay(new Date(year, monthIndex, day));
    cells.push({ iso, dayOfMonth: day, items: byDay.get(iso) ?? [], events: eventsByDay.get(iso) ?? [] });
  }
  while (cells.length % 7 !== 0) cells.push({ iso: null, dayOfMonth: null, items: [], events: [] });
  return cells;
}

// ═══════════════════════════════════════════════════════════════════════════
// The week strip — the ambient calendar
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Seven days, always on screen, in the day header.
 *
 * The 2026-08-01 redesign deleted the `List` / `Calendar` toggle: swapping the
 * whole page to see the shape of the week was too expensive an act for a
 * question a manager asks constantly. So the week is permanent and the MONTH is
 * what opens on demand.
 */
export type WeekDot = 'todo' | 'late' | 'event' | 'past';

export interface WeekCell {
  iso: string;
  dayOfMonth: number;
  /** 0 = Sunday. */
  weekday: number;
  label: string;
  past: boolean;
  today: boolean;
  /** At most three, in the order the design reads them: late, then work, then events. */
  dots: WeekDot[];
  /** A future day carrying an event or something already late. Gets a tinted border. */
  notable: boolean;
}

/** Noon-anchored so a date-only string never lands on the previous day. */
function atNoon(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function shiftIso(iso: string, days: number): string {
  const d = atNoon(iso);
  d.setDate(d.getDate() + days);
  return isoDay(d);
}

/** The Sunday of the week containing `iso`. */
export function weekStart(iso: string): string {
  return shiftIso(iso, -atNoon(iso).getDay());
}

/**
 * The seven cells around `anchorIso`, with their dots.
 *
 * Pure, so "does a late to-do put a rust dot on Tuesday" is answerable without
 * a renderer. A day in the past shows grey dots whatever was on it: what
 * matters about Monday on Thursday is that it is over.
 */
export function weekCells(
  anchorIso: string,
  todayIso: string,
  items: readonly WorklistItem[],
  events: readonly KnowledgeEventDTO[],
): WeekCell[] {
  const start = weekStart(anchorIso);
  const cells: WeekCell[] = [];

  for (let i = 0; i < 7; i++) {
    const iso = shiftIso(start, i);
    const onDay = items.filter((it) => dayOf(it) === iso);
    const eventsOnDay = events.filter((ev) => iso >= ev.eventDate && iso <= (ev.endDate ?? ev.eventDate));
    const past = iso < todayIso;
    const late = onDay.filter((it) => it.overdue).length;
    const plain = onDay.length - late;

    const dots: WeekDot[] = past
      ? new Array(Math.min(3, onDay.length + eventsOnDay.length)).fill('past' as WeekDot)
      : [
          ...new Array(late).fill('late' as WeekDot),
          ...new Array(plain).fill('todo' as WeekDot),
          ...new Array(eventsOnDay.length).fill('event' as WeekDot),
        ].slice(0, 3);

    cells.push({
      iso,
      dayOfMonth: atNoon(iso).getDate(),
      weekday: i,
      label: WEEK_LABELS[i],
      past,
      today: iso === todayIso,
      dots,
      notable: !past && (eventsOnDay.length > 0 || late > 0),
    });
  }

  return cells;
}

/** "Jul 27 – Aug 2". En dash, which is a range, not the banned em dash. */
export function weekRangeLabel(cells: readonly WeekCell[]): string {
  if (cells.length === 0) return '';
  const first = atNoon(cells[0].iso);
  const last = atNoon(cells[cells.length - 1].iso);
  const left = `${MONTHS_SHORT[first.getMonth()]} ${first.getDate()}`;
  const right = first.getMonth() === last.getMonth()
    ? `${last.getDate()}`
    : `${MONTHS_SHORT[last.getMonth()]} ${last.getDate()}`;
  return `${left} – ${right}`;
}

/** "Thursday" and "August 1", for the day title and the context line. */
export function dayTitle(iso: string): string {
  return atNoon(iso).toLocaleDateString('en-US', { weekday: 'long' });
}

export function dayStamp(iso: string): string {
  const d = atNoon(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function WeekStrip({ cells, selectedIso, onSelectDay }: {
  cells: readonly WeekCell[];
  selectedIso: string;
  onSelectDay: (iso: string) => void;
}) {
  return (
    <div className="fx-week" role="group" aria-label="This week">
      {cells.map((cell) => {
        const classes = [
          'fx-wd',
          cell.past ? 'fx-past' : '',
          cell.today ? 'fx-today' : '',
          cell.iso === selectedIso ? 'fx-sel' : '',
          cell.notable ? 'fx-notable' : '',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={cell.iso}
            type="button"
            className={classes}
            data-day={cell.iso}
            aria-pressed={cell.iso === selectedIso}
            aria-label={`${cell.label} ${cell.dayOfMonth}`}
            onClick={() => onSelectDay(cell.iso)}
          >
            <span className="fx-wdk">{cell.label}</span>
            <span className="fx-wdn">{cell.dayOfMonth}</span>
            <span className="fx-wdots" aria-hidden>
              {cell.dots.map((dot, i) => (
                <span
                  key={`${cell.iso}-${i}`}
                  className={`fx-wdot${dot === 'late' ? ' fx-late' : dot === 'event' ? ' fx-ev' : dot === 'past' ? ' fx-gone' : ''}`}
                />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface CalendarViewProps {
  year: number;
  monthIndex: number;
  todayIso: string;
  selectedIso: string | null;
  items: readonly WorklistItem[];
  events: readonly KnowledgeEventDTO[];
  onSelectDay: (iso: string) => void;
  onStepMonth: (delta: number) => void;
  /** Rows for the selected day, rendered by the caller so a to-do looks the
   *  same here as it does in the list. */
  renderItem: (item: WorklistItem) => React.ReactNode;
  canManageEvents?: boolean;
  onDeleteEvent?: (ev: KnowledgeEventDTO) => void;
  /**
   * Opens the event editor. Present only when this reader may manage events.
   * The month grid is now an overlay rather than a page, so the "Add event"
   * control that used to sit above it belongs in its own footer.
   */
  onAddEvent?: () => void;
  /**
   * Draw only the grid: the header, the dots and the legend. Set by the month
   * overlay, where picking a day CLOSES the popup and re-anchors the timeline,
   * so listing that day's rows underneath would be showing them twice.
   */
  gridOnly?: boolean;
  /** Bigger cells. The overlay sets it; the old inline grid does not. */
  big?: boolean;
  /**
   * Picking dates for an event rather than browsing.
   *
   * In this mode a day is not a place to go, it is an answer: pointer-down
   * starts a range, dragging across days extends it, and letting go ends it.
   * `onSelectDay` is not called at all, so nothing re-anchors the timeline
   * under a panel somebody is typing into.
   */
  picking?: boolean;
  pickStart?: string | null;
  pickEnd?: string | null;
  onPickDown?: (iso: string) => void;
  onPickMove?: (iso: string) => void;
  onPickUp?: () => void;
}

/** Is `iso` inside the range, whichever end was clicked first? */
function inPicked(iso: string, start: string | null, end: string | null): 'edge' | 'inside' | null {
  if (!start) return null;
  const a = end && end < start ? end : start;
  const b = end && end < start ? start : (end ?? start);
  if (iso === a || iso === b) return 'edge';
  return iso > a && iso < b ? 'inside' : null;
}

export function CalendarView({
  year, monthIndex, todayIso, selectedIso, items, events,
  onSelectDay, onStepMonth, renderItem, canManageEvents = false, onDeleteEvent,
  onAddEvent, gridOnly = false, big = false,
  picking = false, pickStart = null, pickEnd = null, onPickDown, onPickMove, onPickUp,
}: CalendarViewProps) {
  const cells = monthCells(year, monthIndex, items, events);
  const selected = selectedIso
    ? cells.find((c) => c.iso === selectedIso) ?? null
    : null;

  return (
    <div
      data-testid="staxis-calendar"
      className={`${big ? 'sc-big' : ''}${picking ? ' sc-picking' : ''}`.trim() || undefined}
    >
      <style dangerouslySetInnerHTML={{ __html: CALENDAR_CSS }} />
      <div className="sc-bar">
        <button type="button" className="fx-step" onClick={() => onStepMonth(-1)} aria-label="Previous month">
          <CxIcon name="back" size={12} />
        </button>
        <div className="sc-mon">{MONTHS[monthIndex]} {year}</div>
        <button type="button" className="fx-step" onClick={() => onStepMonth(1)} aria-label="Next month">
          <CxIcon name="forward" size={12} />
        </button>
      </div>

      <div className="sc-grid" role="grid">
        {DOW.map((d, i) => <div className="sc-dow" key={`dow-${i}`}>{d}</div>)}
        {cells.map((cell, i) => {
          const picked = picking && cell.iso ? inPicked(cell.iso, pickStart, pickEnd) : null;
          return (
            <button
              key={cell.iso ?? `pad-${i}`}
              type="button"
              disabled={!cell.iso}
              className={[
                'sc-day',
                cell.iso === todayIso ? 'sc-today' : '',
                !picking && cell.iso && cell.iso === selectedIso ? 'sc-on' : '',
                picked === 'inside' ? 'sc-inrange' : '',
                picked === 'edge' ? 'sc-edge' : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={picking ? picked !== null : undefined}
              // A click is the degenerate drag: down and up on the same square.
              // Keeping both paths on the same handlers means a tap on a phone
              // and a drag on a desktop cannot disagree about what was picked.
              //
              // The capture release is what makes the drag work with a FINGER.
              // A touch pointer is implicitly captured by the element it went
              // down on, so every later move is delivered there and no other
              // square ever sees a pointerenter: the range would be stuck on
              // one day and the hint would be describing something that does
              // not happen.
              onPointerDown={picking ? (e?: React.PointerEvent<HTMLButtonElement>) => {
                try { e?.currentTarget?.releasePointerCapture?.(e.pointerId); } catch { /* mouse, or no capture */ }
                if (cell.iso) onPickDown?.(cell.iso);
              } : undefined}
              onPointerEnter={picking ? () => cell.iso && onPickMove?.(cell.iso) : undefined}
              onPointerUp={picking ? () => onPickUp?.() : undefined}
              onClick={picking ? undefined : () => cell.iso && onSelectDay(cell.iso)}
              aria-label={cell.iso ?? undefined}
              data-day={cell.iso ?? undefined}
            >
              {cell.dayOfMonth !== null && <span className="sc-dn">{cell.dayOfMonth}</span>}
              <span className="sc-dots">
                {cell.items.slice(0, 4).map((it) => (
                  <span key={it.id} className={`sc-dot${it.overdue ? ' sc-late' : ''}`} />
                ))}
                {cell.events.slice(0, 2).map((ev) => <span key={ev.id} className="sc-dot sc-ev" />)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="sc-legend">
        <span className="sc-key"><span className="sc-dot" aria-hidden />To-do</span>
        <span className="sc-key"><span className="sc-dot sc-late" aria-hidden />Late</span>
        <span className="sc-key"><span className="sc-dot sc-ev" aria-hidden />Event</span>
        {canManageEvents && onAddEvent && !picking && (
          <button type="button" className="sc-add" onClick={onAddEvent}>{EVENT_COPY.add}</button>
        )}
      </div>

      {picking && <div className="sc-hint">{EVENT_COPY.dragHint}</div>}

      {!gridOnly && selected && (
        <>
          <div className="sc-sel">{selected.iso}</div>
          {selected.events.map((ev) => (
            <div className="sc-ev-row" key={ev.id}>
              <span className="sc-dot sc-ev" aria-hidden />
              <span className="sc-ev-t">{ev.title}</span>
              {canManageEvents && onDeleteEvent && (
                <button type="button" className="fx-btn fx-danger" onClick={() => onDeleteEvent(ev)}>Remove</button>
              )}
            </div>
          ))}
          {selected.items.map((it) => <React.Fragment key={it.id}>{renderItem(it)}</React.Fragment>)}
          {selected.items.length === 0 && selected.events.length === 0 && (
            <div className="sc-none">Nothing is due on this day.</div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// The month, over the page
//
// WHAT WAS WRONG WITH THE OLD ONE
// The month was a 388px popover hanging off the "Month" button, and "Add event"
// CLOSED it and opened a separate form with two native date inputs in it. So
// the one screen where a person is looking at August disappeared the moment
// they wanted to put something in August, and they then typed the date they had
// just been looking at into a box. The month was decoration.
//
// WHAT THIS IS
// One overlay. The month is big enough to aim at, and it stays put. "Add event"
// opens a panel BESIDE it, and the month becomes the date control: click a day,
// or drag across days for something that runs longer. The panel reads the days
// back as you pick them, so there is never a moment where the range on the grid
// and the range in the form could disagree.
//
// HOOK-FREE AND CONTROLLED, like everything in this folder. The month being
// shown, the draft, and the in-progress drag all live in StaxisList.
// ═══════════════════════════════════════════════════════════════════════════

/** What the side panel is holding. Empty strings, never null, so the inputs
 *  stay controlled and React never warns about a switch of control. */
export interface EventDraft {
  title: string;
  notes: string;
  /** The first day picked, YYYY-MM-DD, or null before anybody has picked. */
  start: string | null;
  /** The other end of a drag. Null on a single day. */
  end: string | null;
}

export function emptyEventDraft(): EventDraft {
  return { title: '', notes: '', start: null, end: null };
}

/** The draft's days, lowest first. What the write path actually sends. */
export function draftRange(draft: EventDraft): { eventDate: string; endDate: string | null } | null {
  if (!draft.start) return null;
  if (!draft.end || draft.end === draft.start) return { eventDate: draft.start, endDate: null };
  return draft.end < draft.start
    ? { eventDate: draft.end, endDate: draft.start }
    : { eventDate: draft.start, endDate: draft.end };
}

/** A draft is sendable when it says what it is and when it is. */
export function draftReady(draft: EventDraft): boolean {
  return draft.title.trim().length > 0 && draftRange(draft) !== null;
}

export interface MonthOverlayProps {
  open: boolean;
  year: number;
  monthIndex: number;
  todayIso: string;
  selectedIso: string | null;
  items: readonly WorklistItem[];
  events: readonly KnowledgeEventDTO[];
  canManageEvents?: boolean;
  /** Non-null while the side panel is open. Null while browsing. */
  draft: EventDraft | null;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSelectDay: (iso: string) => void;
  onStepMonth: (delta: number) => void;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onDraftChange: (next: EventDraft) => void;
  onSaveEvent: () => void;
  onPickDown: (iso: string) => void;
  onPickMove: (iso: string) => void;
  onPickUp: () => void;
}

export function MonthOverlay({
  open, year, monthIndex, todayIso, selectedIso, items, events,
  canManageEvents = false, draft, busy = false, error = null,
  onClose, onSelectDay, onStepMonth, onStartAdd, onCancelAdd,
  onDraftChange, onSaveEvent, onPickDown, onPickMove, onPickUp,
}: MonthOverlayProps) {
  if (!open) return null;
  const picking = draft !== null;
  const ready = draft !== null && draftReady(draft) && !busy;

  return (
    <div data-testid="month-overlay">
      <button type="button" className="fx-scrim" aria-label={EVENT_COPY.close} onClick={onClose} />
      <div className="fx-monthover" role="dialog" aria-modal="true" aria-label={EVENT_COPY.monthTitle}>
        <div className="fx-drawerhead">
          <span className="fx-drawert">{EVENT_COPY.monthTitle}</span>
          <button type="button" className="fx-drawerx" aria-label={EVENT_COPY.close} onClick={onClose}>
            <CxIcon name="close" size={14} />
          </button>
        </div>

        <div className="fx-monthbody">
          <div className="sc-wrap">
            <div className="sc-mgrid">
              <CalendarView
                year={year}
                monthIndex={monthIndex}
                todayIso={todayIso}
                selectedIso={selectedIso}
                items={items}
                events={events}
                onSelectDay={onSelectDay}
                onStepMonth={onStepMonth}
                renderItem={() => null}
                canManageEvents={canManageEvents}
                onAddEvent={onStartAdd}
                gridOnly
                big
                picking={picking}
                pickStart={draft?.start ?? null}
                pickEnd={draft?.end ?? null}
                onPickDown={onPickDown}
                onPickMove={onPickMove}
                onPickUp={onPickUp}
              />
            </div>

            {draft && (
              <div className="sc-panel" data-testid="event-panel">
                <div>
                  <span className="sc-plab" id="sc-lab-days">{EVENT_COPY.daysLabel}</span>
                  {/* Live, as the drag happens. The grid and this line are
                      drawn from the same two dates, so they cannot disagree. */}
                  <div
                    className={`sc-picked${draft.start ? '' : ' sc-empty'}`}
                    role="status"
                    aria-labelledby="sc-lab-days"
                  >
                    {pickedDaysLine(draft.start, draft.end)}
                  </div>
                </div>

                <div>
                  <label className="sc-plab" htmlFor="sc-ev-title">{EVENT_COPY.titleLabel}</label>
                  <input
                    id="sc-ev-title"
                    className="sc-field"
                    type="text"
                    value={draft.title}
                    maxLength={KNOWLEDGE_LIMITS.TITLE_MAX}
                    placeholder={EVENT_COPY.titlePlaceholder}
                    disabled={busy}
                    onChange={(e) => onDraftChange({ ...draft, title: e.target.value })}
                  />
                </div>

                <div>
                  <label className="sc-plab" htmlFor="sc-ev-notes">{EVENT_COPY.notesLabel}</label>
                  <textarea
                    id="sc-ev-notes"
                    className="sc-field"
                    rows={3}
                    value={draft.notes}
                    maxLength={KNOWLEDGE_LIMITS.NOTES_MAX}
                    placeholder={EVENT_COPY.notesPlaceholder}
                    disabled={busy}
                    onChange={(e) => onDraftChange({ ...draft, notes: e.target.value })}
                  />
                </div>

                {error && <div className="sl-err">{error}</div>}

                <div className="sc-pacts">
                  <button type="button" className="fx-btn fx-primary" disabled={!ready} onClick={onSaveEvent}>
                    {busy ? EVENT_COPY.saving : EVENT_COPY.save}
                  </button>
                  <button type="button" className="fx-btn" disabled={busy} onClick={onCancelAdd}>
                    {EVENT_COPY.cancel}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
