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

import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
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
 */
export function dayOf(item: Pick<WorklistItem, 'dueDate'>): string | null {
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
}

export function CalendarView({
  year, monthIndex, todayIso, selectedIso, items, events,
  onSelectDay, onStepMonth, renderItem, canManageEvents = false, onDeleteEvent,
  onAddEvent, gridOnly = false,
}: CalendarViewProps) {
  const cells = monthCells(year, monthIndex, items, events);
  const selected = selectedIso
    ? cells.find((c) => c.iso === selectedIso) ?? null
    : null;

  return (
    <div data-testid="staxis-calendar">
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
        {cells.map((cell, i) => (
          <button
            key={cell.iso ?? `pad-${i}`}
            type="button"
            disabled={!cell.iso}
            className={`sc-day${cell.iso === todayIso ? ' sc-today' : ''}${cell.iso && cell.iso === selectedIso ? ' sc-on' : ''}`}
            onClick={() => cell.iso && onSelectDay(cell.iso)}
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
        ))}
      </div>

      <div className="sc-legend">
        <span className="sc-key"><span className="sc-dot" aria-hidden />To-do</span>
        <span className="sc-key"><span className="sc-dot sc-late" aria-hidden />Late</span>
        <span className="sc-key"><span className="sc-dot sc-ev" aria-hidden />Event</span>
        {canManageEvents && onAddEvent && (
          <button type="button" className="sc-add" onClick={onAddEvent}>Add event</button>
        )}
      </div>

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
