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

export const CALENDAR_CSS = `
.sc-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;}
.sc-mon{font-size:14.5px;font-weight:600;color:#1F231C;}
.sc-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:10px;}
.sc-dow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;color:#A6ABA6;
  text-transform:uppercase;letter-spacing:.07em;text-align:center;padding-bottom:2px;}
.sc-day{min-height:56px;border-radius:10px;border:1px solid rgba(31,35,28,.07);background:#fff;
  padding:5px 6px;cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:3px;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.sc-day:disabled{background:transparent;border-color:transparent;cursor:default;}
.sc-day.sc-today{border-color:rgba(62,92,72,.45);}
.sc-day.sc-on{background:#F1F5F0;border-color:#5C7A60;}
.sc-day:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.sc-dn{font-size:11.5px;color:#5C625C;font-family:var(--font-geist-mono),ui-monospace,monospace;}
.sc-dots{display:flex;gap:3px;flex-wrap:wrap;}
.sc-dot{width:6px;height:6px;border-radius:50%;background:#5C7A60;}
.sc-dot.sc-late{background:#B85C3D;}
.sc-dot.sc-ev{background:#4B8C9E;}
.sc-sel{margin-top:12px;font-size:13px;font-weight:600;color:#1F231C;}
.sc-ev-row{display:flex;align-items:center;gap:10px;padding:9px 0;
  border-bottom:1px solid rgba(31,35,28,.06);}
.sc-ev-t{flex:1;min-width:0;font-size:13.5px;color:#1F231C;}
.sc-none{margin-top:10px;font-size:12.5px;color:#8A9187;}
`;

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
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
}

export function CalendarView({
  year, monthIndex, todayIso, selectedIso, items, events,
  onSelectDay, onStepMonth, renderItem, canManageEvents = false, onDeleteEvent,
}: CalendarViewProps) {
  const cells = monthCells(year, monthIndex, items, events);
  const selected = selectedIso
    ? cells.find((c) => c.iso === selectedIso) ?? null
    : null;

  return (
    <div data-testid="staxis-calendar">
      <style dangerouslySetInnerHTML={{ __html: CALENDAR_CSS }} />
      <div className="sc-bar">
        <button type="button" className="fd-act" onClick={() => onStepMonth(-1)} aria-label="Previous month">←</button>
        <div className="sc-mon">{MONTHS[monthIndex]} {year}</div>
        <button type="button" className="fd-act" onClick={() => onStepMonth(1)} aria-label="Next month">→</button>
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

      {selected && (
        <>
          <div className="sc-sel">{selected.iso}</div>
          {selected.events.map((ev) => (
            <div className="sc-ev-row" key={ev.id}>
              <span className="sc-dot sc-ev" aria-hidden />
              <span className="sc-ev-t">{ev.title}</span>
              {canManageEvents && onDeleteEvent && (
                <button type="button" className="fd-act fd-danger" onClick={() => onDeleteEvent(ev)}>Remove</button>
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
