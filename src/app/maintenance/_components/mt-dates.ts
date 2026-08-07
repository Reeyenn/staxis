// Pure date / cadence helpers for the Maintenance boards. No React — kept in
// a plain .ts module (re-exported through _mt-snow) so src/lib/__tests__ can
// exercise the logic directly.
//
const LOCALE = 'en-US';

export function fmtDate(d: Date): string {
  return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateShort(d: Date): string {
  return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
}

// Days between two dates ignoring time-of-day. Positive = b is later.
export function daysBetween(a: Date, b: Date): number {
  const aa = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bb = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bb.getTime() - aa.getTime()) / (24 * 60 * 60 * 1000));
}

// Add N calendar days in LOCAL time — DST-safe. Raw `getTime() + N * 86400000`
// lands one hour short across the November fall-back, which shifts
// midnight-anchored dates (backfilled "last completed" dates stored at local
// 00:00) to 23:00 the PREVIOUS day: the due date then displays and bands a
// full day early.
export function addDaysLocal(d: Date, days: number): Date {
  return new Date(
    d.getFullYear(), d.getMonth(), d.getDate() + days,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
  );
}

// "7:51 AM · today" / "May 11 · 1d ago" — used in the detail modal byline.
// Days-ago counts CALENDAR days (via daysBetween), not elapsed 24h blocks:
// last night at 11pm viewed at 7am is "1d ago", not the old nonsense "0d ago".
export function fmtSubmittedAt(d: Date | null, now: Date = new Date()): string {
  if (!d) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    const time = d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${time} · today`;
  }
  const daysAgo = Math.max(1, daysBetween(d, now));
  if (daysAgo < 7) {
    return `${fmtDateShort(d)} · ${daysAgo}d ago`;
  }
  return fmtDate(d);
}

// Compact byline for the board cards: time-only for today, "May 11 · 1d" for
// the last week. Replaces the old `.replace(' · today', '').replace(/ ago$/,
// '')` string surgery on fmtSubmittedAt output.
export function fmtSubmittedAtCompact(d: Date | null, now: Date = new Date()): string {
  if (!d) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  const daysAgo = Math.max(1, daysBetween(d, now));
  if (daysAgo < 7) return `${fmtDateShort(d)} · ${daysAgo}d`;
  return fmtDate(d);
}

// Due-relative string from "days until due" (negative = overdue). Used on the
// Preventive board cards.
export function relDue(days: number): string {
  if (days === 0) return 'due today';
  if (days < 0) return `${-days}d overdue`;
  if (days === 1) return 'due tomorrow';
  if (days <= 7) return `in ${days}d`;
  if (days <= 60) return `in ${Math.round(days / 7)}w`;
  return `in ${Math.round(days / 30)}mo`;
}

// Cadence text for a stored frequency-in-days. Exact-divisibility only: the
// old `days >= 30 → round(days / 30)` branch made a 45-day cadence read
// "every 2 mo" and a 12-week (84-day) cadence read "every 3 mo". Preference
// order mirrors daysToCountUnit (years > months > weeks > days), so anything
// entered through the frequency editor round-trips to its own label.
export function cadenceLabel(days: number): string {
  if (days >= 365 && days % 365 === 0) { const n = days / 365; return `every ${n} yr`; }
  if (days >= 30 && days % 30 === 0) { const n = days / 30; return `every ${n} mo`; }
  if (days >= 7 && days % 7 === 0) { const n = days / 7; return `every ${n} wk`; }
  if (days === 1) return 'every day';
  return `every ${days} days`;
}

// ── how a finished ticket is described, and by whom ────────────────────────
//
// The History popup is the hotel's record of what maintenance it carried out,
// and for a while it had exactly one sentence for two different endings. A
// ticket somebody looked at and judged not to be a fault ('closed', written by
// the Staxis list's "Not actually a problem") arrived there wearing a green
// "Done", under a heading that counted it as resolved, with the name of whoever
// dismissed it printed under "Fixed by". That is a repair the hotel never did,
// in the only place anybody would go to check what it did.
//
// Pure, and here rather than inline in the modal, because "what does this
// screen claim happened" is the whole of the bug and it should be assertable
// without rendering anything.
export interface WorkOrderEnding {
  /** The pill on the row. */
  label: string;
  /** The column heading for the name beside it. */
  byLabel: string;
  /** 'sage' reads as a completed repair; 'neutral' deliberately does not. */
  tone: 'sage' | 'neutral';
  /** True only for work that was actually carried out. */
  countsAsRepair: boolean;
}

export function workOrderEnding(settledAs: 'resolved' | 'closed' | null | undefined): WorkOrderEnding {
  if (settledAs === 'closed') {
    return { label: 'Not a problem', byLabel: 'Closed by', tone: 'neutral', countsAsRepair: false };
  }
  return { label: 'Done', byLabel: 'Fixed by', tone: 'sage', countsAsRepair: true };
}

// The line under the History popup's title. Says what is actually in the list:
// a hotel that dismissed four tickets and repaired none must not be told it
// resolved four.
export function workOrderHistoryCount(repairs: number, nonIssues: number): string {
  const repaired = `${repairs} ${repairs === 1 ? 'repair' : 'repairs'}`;
  if (nonIssues === 0) return `${repaired} · everything closed out`;
  const dismissed = nonIssues === 1 ? '1 was not a problem' : `${nonIssues} were not a problem`;
  return `${repaired} · ${dismissed}`;
}

// ── where an upkeep schedule sits on the Preventive board ──────────────────
//
// `unstarted` is the honest fourth band. A schedule with no last-done date has
// NO due date: there is no elapsed interval to count, and the only dates
// available to invent one from are the day somebody typed the row in and today.
// The nightly detector refuses to claim lateness for exactly this reason
// (findings/detectors/preventive-due.ts) and issues one card saying the date is
// missing. The board did the opposite — its next-due fell back to `new Date()`,
// so an unstarted schedule was filed under "Due this month" and its card read
// "due today · next Aug 6", a due date the hotel never gave. Reachable in
// ordinary use: setting a schedule up through the Staxis chat stores no date at
// all when the manager says they do not know when it was last done.
export type Band = 'overdue' | 'unstarted' | 'soon' | 'upcoming';

/** The two fields the band rules need. Kept structural so the tests do not have
 *  to build a whole PreventiveTask to ask a date question. */
export interface SchedulePosition {
  lastCompletedAt: Date | null | undefined;
  frequencyDays: number;
}

/** When this comes round again, or NULL when the hotel never said it was done. */
export function nextDueDate(t: SchedulePosition): Date | null {
  if (!t.lastCompletedAt) return null;
  // Calendar-day addition (DST-safe) — raw ms addition landed backfilled
  // midnight-anchored dates at 23:00 the previous day across the fall-back,
  // banding/displaying the due date one day early.
  return addDaysLocal(t.lastCompletedAt, t.frequencyDays);
}

/** Days until due, or null when there is no due date to count to. */
export function daysUntilDue(t: SchedulePosition, now: Date = new Date()): number | null {
  const due = nextDueDate(t);
  return due ? daysBetween(now, due) : null;
}

export function bandFor(t: SchedulePosition, now: Date = new Date()): Band {
  const d = daysUntilDue(t, now);
  if (d === null) return 'unstarted';
  if (d < 0) return 'overdue';
  if (d <= 30) return 'soon';
  return 'upcoming';
}

/** The relative-due chip on a card. Says nothing it cannot support. */
export function dueChipLabel(daysUntil: number | null): string {
  return daysUntil === null ? 'no due date' : relDue(daysUntil);
}

/** The footer line under a card: the next date, or what is missing. */
export function nextDueLine(due: Date | null): string {
  return due ? `next · ${fmtDateShort(due)}` : 'add a last-done date to start it';
}

// ── setting a new upkeep schedule going ────────────────────────────────────
//
// The New-task form has an optional "Last completed" box, and leaving it blank
// starts the count from today. That is a reasonable default and it stays. What
// was NOT reasonable is what the form did with it: it wrote the creator's own
// name into `last_completed_by`, so a manager who typed "Fire extinguisher
// check, every 6 months" and pressed Add became, permanently and in this
// hotel's own maintenance record, the person who last performed that service.
// The companion reads that column back and will say so out loud.
//
// The chat door already refuses to do this and says why in one line: "the
// manager told us WHEN it was last done, not that they were the one who did it"
// (agent/tools/staxis-setup.ts). The form now agrees with it, and says out loud
// what a blank box means instead of quietly deciding.
export interface NewScheduleStart {
  /** What goes in last_completed_at. */
  lastCompletedAt: Date;
  /** True when the box was left blank and the count simply starts now. */
  startsFromToday: boolean;
}

export function newScheduleStart(lastCompletedISO: string | null, now: Date = new Date()): NewScheduleStart {
  const parsed = lastCompletedISO ? new Date(lastCompletedISO) : null;
  return parsed && Number.isFinite(parsed.getTime())
    ? { lastCompletedAt: parsed, startsFromToday: false }
    : { lastCompletedAt: now, startsFromToday: true };
}

/** What the form says about a blank last-done box. Empty when one was given. */
export function newScheduleStartNote(startsFromToday: boolean): string {
  return startsFromToday
    ? 'No last-done date, so the count starts today. Nothing is recorded as having been done.'
    : '';
}

// Format a location for display: bare room numbers get a "Rm " prefix; named
// areas ("Lobby", "Pool Deck") pass through verbatim.
export function displayLoc(loc: string): string {
  const t = (loc || '').trim();
  return /^\d{1,4}$/.test(t) ? `Rm ${t}` : t;
}
