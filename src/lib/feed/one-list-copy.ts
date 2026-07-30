// ═══════════════════════════════════════════════════════════════════════════
// Every sentence the one list says out loud.
//
// Pure producers, no React, no clock of their own. Two reasons they live here
// rather than inline in the components:
//
//   1. The no-em-dash guard walks PRODUCERS, not source. A rule enforced by
//      grepping files passes on the bug that actually shipped (the dash arrives
//      through a joiner in one file wrapping a fragment from another) and fails
//      on every harmless rename. See findings-copy-rules.test.ts.
//
//   2. "Who it is from" is part of the row's SENTENCE, not a category system.
//      The founder was explicit: no lanes, no tag taxonomy, no filters. A row
//      reads "Marcus asked you to change the lobby filters", not [TASK]
//      [ASSIGNED] [MARCUS]. That only stays true if one function owns the
//      sentence and every row goes through it.
//
// English only (founder ruling, 2026-07-29).
// ═══════════════════════════════════════════════════════════════════════════

import type { AssignedByMeItem, WorklistItem } from '@/lib/worklist/types';

/**
 * The front half of a row: who this is from, or nothing.
 *
 * Returns null far more often than not, and that is correct. A work order is a
 * fact about the hotel; nobody asked. Naming a sender for it would be a claim
 * with nothing behind it, and the moment a manager catches one invented
 * attribution they stop trusting the real ones.
 */
export function rowFrom(item: Pick<WorklistItem, 'sourceType' | 'fromLabel'>): string | null {
  const who = (item.fromLabel ?? '').trim();
  switch (item.sourceType) {
    case 'task':
      return who ? `${who} asked you to` : null;
    case 'reminder':
      return who ? `${who} set a reminder` : 'You set a reminder';
    case 'complaint':
      return 'A guest reported this';
    case 'approval':
      return who ? `${who} is waiting on you` : 'Waiting on you';
    default:
      return null;
  }
}

/** What kind of thing this row is, in words a person would use. */
export function rowKindLabel(sourceType: WorklistItem['sourceType']): string {
  switch (sourceType) {
    case 'task': return 'To do';
    case 'reminder': return 'Reminder';
    case 'complaint': return 'Complaint';
    case 'workorder': return 'Work order';
    case 'inspection': return 'Inspection';
    case 'pm': return 'Preventive';
    case 'approval': return 'Your call';
    default: return 'To do';
  }
}

/**
 * When it is due, in glanceable words. Never a bare timestamp: "due 2026-08-02"
 * makes a person do arithmetic to find out whether it matters today.
 *
 * Both clocks are passed in so the same row renders the same sentence in a test
 * as it does at 4am on a Tuesday.
 */
export function dueLine(dueIso: string | null, now: Date): string | null {
  if (!dueIso) return null;
  const due = Date.parse(dueIso);
  if (Number.isNaN(due)) return null;
  const days = Math.floor((startOfDay(new Date(due)) - startOfDay(now)) / 86_400_000);
  if (days < -1) return `${Math.abs(days)} days late`;
  if (days === -1) return 'Late since yesterday';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days < 7) return `Due in ${days} days`;
  return `Due ${shortDate(new Date(due))}`;
}

/**
 * The staleness line in the Assigned-by-me drawer. Only says anything once it
 * is worth saying: "assigned today, still open" is not news, and a drawer that
 * nags about everything gets closed and never reopened.
 */
export function stalenessLine(entry: Pick<AssignedByMeItem, 'state' | 'ageDays'>): string | null {
  if (entry.state !== 'waiting') return null;
  if (entry.ageDays < 2) return null;
  return `Assigned ${entry.ageDays} days ago, still open`;
}

/** Where an assigned task got to, in one line, with the receipt. */
export function assignedStateLine(entry: AssignedByMeItem, now: Date): string {
  const who = entry.assigneeName ?? 'the person you assigned it to';
  if (entry.state === 'done') {
    const when = entry.settledAt ? relativeDay(entry.settledAt, now) : null;
    const by = entry.settledByName ?? who;
    return when ? `${by} marked it done ${when}` : `${by} marked it done`;
  }
  if (entry.state === 'cant') {
    const when = entry.settledAt ? relativeDay(entry.settledAt, now) : null;
    const by = entry.settledByName ?? who;
    return when ? `${by} could not do it ${when}` : `${by} could not do it`;
  }
  return `Waiting on ${who}`;
}

/** The one line the assigner sees on their own list when work comes back done. */
export function completionNotice(entry: AssignedByMeItem): string {
  const who = entry.settledByName ?? entry.assigneeName ?? 'Somebody';
  if (entry.state === 'cant') return `${who} could not do "${entry.title}"`;
  return `${who} finished "${entry.title}"`;
}

/** Plain-English cadence, for the composer chip and the row it creates. */
export function repeatLabel(
  repeat: string,
  opts: { weekday?: number | null; dayOfMonth?: number | null } = {},
): string {
  const day = typeof opts.weekday === 'number' ? WEEKDAYS[opts.weekday] ?? null : null;
  switch (repeat) {
    case 'daily': return 'Every day';
    case 'weekdays': return 'Every weekday';
    case 'weekly': return day ? `Every ${day}` : 'Every week';
    case 'biweekly': return day ? `Every other ${day}` : 'Every other week';
    case 'monthly': return opts.dayOfMonth
      ? `Every month on the ${ordinal(opts.dayOfMonth)}`
      : 'Every month';
    default: return 'Once';
  }
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The empty state. Never reads as an all clear on a hotel nobody has checked. */
export function emptyListNote(opts: { canSeeFindings: boolean }): string {
  return opts.canSeeFindings
    ? 'Nothing is waiting on you right now. Anything Staxis notices will land here.'
    : 'Nothing is waiting on you right now.';
}

// ── helpers ────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function shortDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function relativeDay(iso: string, now: Date): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((startOfDay(now) - startOfDay(new Date(t))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${shortDate(new Date(t))}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
