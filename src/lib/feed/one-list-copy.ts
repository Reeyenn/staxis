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
// Type-only, so nothing at runtime travels back the other way: parse-todo.ts
// imports WEEKDAYS and whichDayQuestion FROM here, and a value import in this
// direction would close the loop.
import type { ComposerPerson, ParseQuestion } from './parse-todo';

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

// ═══════════════════════════════════════════════════════════════════════════
// The "add a to-do" row
//
// Three words on the right of the row read back what the row is about to do:
// `for you · today · once`. They are the whole readback AND the whole
// direct-choice affordance, so every one of them is always answered and none of
// them is ever blank. The producers below are the only place those words are
// written, which is what keeps the readback and the buttons from drifting.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The role targets a to-do can be handed to.
 *
 * HOUSEKEEPING IS NOT HERE, and neither are housekeepers in the people list —
 * see HOUSEKEEPER_NOTE. Offering a target whose work would land on a screen
 * they never open would be worse than not offering it.
 */
export const COMPOSER_ROLES: readonly { value: string; label: string }[] = [
  { value: 'dept:front_desk', label: "Whoever's on front desk" },
  { value: 'dept:maintenance', label: 'Maintenance' },
  { value: 'dept:all_staff', label: 'Everyone' },
];

export const HOUSEKEEPER_NOTE =
  'Housekeepers work from the housekeeping board, so they are not on this list.';

/** Every fixed sentence the composer says. No em dashes, English only. */
export const COMPOSER_COPY = {
  /** The idle prompt, before anybody has touched the row. */
  prompt: 'Add something.',
  /** The prompt once somebody has opened the buttons without typing. */
  promptChoosing: 'What needs doing?',
  /** Under the row while the mic is held. */
  speaking: 'Let go when you are done. The words go in the same place.',
  /** Under the row when the to-do repeats. */
  repeating: 'It comes back on its own.',
  /** The mono hint where an Add button would have been. There is no Add button. */
  enter: 'Enter',
  enterToAdd: 'Enter to add',
  adding: 'Adding',
  /** Shown once, ever, after somebody's first plain-sentence to-do. */
  repeatTeach: 'You can also write when it repeats, like every Friday.',
  /** Accessible names for the three words. */
  whoLabel: 'Who',
  whenLabel: 'When',
  repeatLabel: 'Repeat',
  startsLabel: 'Starts',
} as const;

/** "for you" | "for Marcus" | "for whoever's on front desk". */
export function whoWord(who: string, people: readonly ComposerPerson[]): string {
  if (!who || who === 'me') return 'for you';
  const role = COMPOSER_ROLES.find((r) => r.value === who);
  // Lowercased because it is mid-sentence: "for whoever's on front desk".
  if (role) return `for ${role.label.charAt(0).toLowerCase()}${role.label.slice(1)}`;
  const person = people.find((p) => p.staffId === who);
  // A person keeps their capital, and only their first name: the row is a
  // sentence, and nobody says "for Marcus Webb" out loud.
  if (person?.name) return `for ${person.name.trim().split(/\s+/)[0]}`;
  return 'for you';
}

/**
 * "today" | "tomorrow" | "Friday" | "Aug 22".
 *
 * A repeating item has no single due date, so its word says where the run
 * starts instead: "from today", "from Monday".
 */
export function whenWord(iso: string | null, now: Date, opts: { repeating?: boolean } = {}): string {
  const plain = plainDay(iso, now);
  return opts.repeating ? `from ${plain}` : plain;
}

function plainDay(iso: string | null, now: Date): string {
  if (!iso) return 'today';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return 'today';
  const days = Math.floor((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  // Inside the coming week a weekday name is what a person would say. Beyond
  // it, "Friday" stops being a date and starts being a guess.
  if (days > 1 && days < 7) return WEEKDAYS[d.getDay()];
  return shortDate(d);
}

/**
 * "once" | "every day" | "every other Friday" | "every month on the 3rd".
 *
 * `repeatLabel` with its first letter dropped to lower case, and NOT
 * `.toLowerCase()`: that would turn "Every other Friday" into a day of the week
 * nobody writes. The switch itself is not duplicated.
 */
export function repeatWord(
  repeat: string,
  opts: { weekday?: number | null; dayOfMonth?: number | null } = {},
): string {
  const label = repeatLabel(repeat, opts);
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The one question this control is allowed to ask, and the only shape a
 * question may take: a short line and two answers, both of which are correct.
 *
 * It is never an error. Nothing is red, the row is not blocked, and Enter still
 * works and takes the FIRST answer.
 */
export function whichDayQuestion(dayName: string, iso: string, weekday: number): ParseQuestion {
  return {
    prompt: `Which ${dayName}?`,
    choices: [
      { label: `This ${dayName}`, patch: { when: iso, repeat: 'once', weekday } },
      { label: `Every ${dayName}`, patch: { when: null, repeat: 'weekly', weekday } },
    ],
  };
}

/** "Enter takes this Friday." Says what pressing Enter right now would do. */
export function enterTakesNote(firstChoiceLabel: string): string {
  const phrase = firstChoiceLabel.charAt(0).toLowerCase() + firstChoiceLabel.slice(1);
  return `Enter takes ${phrase}.`;
}

/**
 * The receipt promise, when a to-do is going to somebody else.
 *
 * "their" rather than a guessed pronoun: the roster carries a name and nothing
 * else, and a screen that guesses somebody's gender from their first name will
 * be wrong about a real member of staff on a real morning.
 */
export function assignedNote(name: string): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first
    ? `${first} sees it on their list today. You will see it come back.`
    : 'They see it on their list today. You will see it come back.';
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
