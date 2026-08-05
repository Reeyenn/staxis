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
export function dueLine(dueIso: string | null, now: Date, dueTime?: string | null): string | null {
  if (!dueIso) return null;
  const due = Date.parse(dueIso);
  if (Number.isNaN(due)) return null;
  const days = Math.floor((startOfDay(new Date(due)) - startOfDay(now)) / 86_400_000);
  // The clock only reaches the line when the day is still ahead. "3 days late
  // by 3pm" is two deadlines in one breath and the wrong one is the loud one:
  // once a thing is late, how late it is is the only part that matters.
  const at = days >= 0 ? timeWord(dueTime ?? null) : null;
  const withTime = (base: string) => (at ? `${base} ${at}` : base);
  if (days < -1) return `${Math.abs(days)} days late`;
  if (days === -1) return 'Late since yesterday';
  if (days === 0) return withTime('Due today');
  if (days === 1) return withTime('Due tomorrow');
  if (days < 7) return withTime(`Due in ${days} days`);
  return withTime(`Due ${shortDate(new Date(due))}`);
}

/**
 * "by 3pm", "by 6:30am", "by noon". Null for no time, which is most rows.
 *
 * A stored time is 24-hour because that is the only shape with one reading.
 * Nobody SAYS 15:00 in a hotel corridor, so nothing ever shows it: the wall
 * clock goes in, the sentence comes out.
 */
export function timeWord(hhmm: string | null | undefined): string | null {
  const parsed = readClock(hhmm);
  if (!parsed) return null;
  const { hour, minute } = parsed;
  if (hour === 12 && minute === 0) return 'by noon';
  if (hour === 0 && minute === 0) return 'by midnight';
  const meridiem = hour < 12 ? 'am' : 'pm';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `by ${h12}${meridiem}`
    : `by ${h12}:${`${minute}`.padStart(2, '0')}${meridiem}`;
}

/** "HH:MM" → its two numbers, or null. The one place the stored shape is read. */
function readClock(hhmm: string | null | undefined): { hour: number; minute: number } | null {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Minutes past midnight, for ordering only. Null sorts last within its day,
 * which is what "a timed thing comes before an untimed one" means in practice.
 */
export function minuteOfDay(hhmm: string | null | undefined): number | null {
  const parsed = readClock(hhmm);
  return parsed ? parsed.hour * 60 + parsed.minute : null;
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

/**
 * Where an assigned task got to, in one line, with the receipt.
 *
 * FOUR ENDINGS NOW, and the assigner sees the true one every time. The two that
 * are new are the two that used to be told as a lie or not told at all:
 *
 *   done late      the work happened, after the day it was wanted
 *   done on a day  "Marcus did it yesterday" — the completion was CREDITED to
 *                  the day it was due, so the drawer says the day the work
 *                  happened rather than the day somebody got round to tapping
 *   not needed     it stopped needing doing, and nobody had to invent a reason
 *
 * A person who hands work out and is told a comfortable version of what
 * happened stops trusting the receipts, and then stops handing work out.
 */
export function assignedStateLine(entry: AssignedByMeItem, now: Date): string {
  const who = entry.assigneeName ?? 'the person you assigned it to';
  const by = entry.settledByName ?? who;
  if (entry.state === 'done') {
    // Credited to a day: say THAT day. It is the honest half of the receipt and
    // the only one the assigner can act on.
    if (entry.completedForDate) {
      const day = relativeDay(`${entry.completedForDate}T12:00:00`, now);
      return day ? `${by} did it ${day}` : `${by} marked it done`;
    }
    const when = entry.settledAt ? relativeDay(entry.settledAt, now) : null;
    const late = wasLate(entry);
    if (when) return late ? `${by} marked it done ${when}, after it was due` : `${by} marked it done ${when}`;
    return late ? `${by} marked it done, after it was due` : `${by} marked it done`;
  }
  if (entry.state === 'cant') {
    const when = entry.settledAt ? relativeDay(entry.settledAt, now) : null;
    return when ? `${by} could not do it ${when}` : `${by} could not do it`;
  }
  if (entry.state === 'skipped') {
    const when = entry.settledAt ? relativeDay(entry.settledAt, now) : null;
    return when ? `${by} said it was not needed ${when}` : `${by} said it was not needed`;
  }
  return `Waiting on ${who}`;
}

/**
 * Did this land after the day it was wanted?
 *
 * Compared on whole DAYS, not instants. A to-do due today that somebody closed
 * at 11:58pm was done today, and calling that late over two minutes is the kind
 * of pedantry that makes a person stop reading the receipts.
 */
function wasLate(entry: Pick<AssignedByMeItem, 'dueDate' | 'settledAt'>): boolean {
  if (!entry.dueDate || !entry.settledAt) return false;
  const due = Date.parse(entry.dueDate);
  const settled = Date.parse(entry.settledAt);
  if (Number.isNaN(due) || Number.isNaN(settled)) return false;
  return startOfDay(new Date(settled)) > startOfDay(new Date(due));
}

/** The one line the assigner sees on their own list when work comes back. */
export function completionNotice(entry: AssignedByMeItem): string {
  const who = entry.settledByName ?? entry.assigneeName ?? 'Somebody';
  if (entry.state === 'cant') return `${who} could not do "${entry.title}"`;
  if (entry.state === 'skipped') return `${who} said "${entry.title}" was not needed`;
  if (entry.completedForDate) return `${who} did "${entry.title}" on the day it was due`;
  if (wasLate(entry)) return `${who} finished "${entry.title}", late`;
  return `${who} finished "${entry.title}"`;
}

// ═══════════════════════════════════════════════════════════════════════════
// An overdue row's three answers
//
// A to-do that slipped has three true endings and the old row offered one and a
// half of them. "Done" stamped the moment of the TAP, so work that happened on
// Tuesday went into the record as Thursday's, and every pattern the product
// learns about when work actually gets done was being taught a date nobody
// chose. There was no way at all to say a thing had stopped needing doing
// except to delete it, and a deleted row answers nobody.
// ═══════════════════════════════════════════════════════════════════════════

/** What the three buttons on an overdue row say, left to right. */
export interface OverdueAnswers {
  /** Completes now, recorded now. */
  done: string;
  /** Completes, CREDITED to the day it was due. Named after that day. */
  onDay: string;
  /** Records that it stopped needing doing. Never a silent delete. */
  notNeeded: string;
}

/**
 * The three labels, with the middle one named after the day it is crediting.
 *
 * "Did it yesterday" is only ever offered when the day it was due WAS
 * yesterday. On a to-do that slipped from Monday the button says "Did it
 * Monday", because a button that says yesterday and files Monday is the same
 * dishonesty this whole control exists to remove.
 */
export function overdueAnswers(missedSince: string | null, now: Date): OverdueAnswers {
  return {
    done: 'Done',
    onDay: `Did it ${missedDayPhrase(missedSince, now) ?? 'on the day'}`,
    notNeeded: 'Not needed',
  };
}

/** "yesterday" | "Monday" | "on Aug 2" | null when there is no missed day. */
export function missedDayPhrase(missedSince: string | null, now: Date): string | null {
  if (!missedSince) return null;
  const d = new Date(`${missedSince}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return 'yesterday';
  if (days < 7) return WEEKDAYS[d.getDay()];
  return `on ${shortDate(d)}`;
}

/**
 * The quiet line on a repeating row that has been missed.
 *
 * ONE row, whatever the size of the run behind it. A daily to-do that nobody
 * did for five days used to be five identical rows, which is not a list of work
 * any more, it is the same sentence shouted five times. The line says how far
 * back it goes rather than how many copies were collapsed: "missed since
 * Monday" is what somebody needs to know, and "5 instances" is bookkeeping.
 */
export function missedLine(missedSince: string | null, now: Date): string | null {
  const phrase = missedDayPhrase(missedSince, now);
  if (!phrase) return null;
  return phrase === 'yesterday' ? 'Missed yesterday' : `Missed since ${phrase.replace(/^on /, '')}`;
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
export function whenWord(
  iso: string | null,
  now: Date,
  opts: { repeating?: boolean; atTime?: string | null } = {},
): string {
  const plain = plainDay(iso, now);
  const day = opts.repeating ? `from ${plain}` : plain;
  // "today by 3pm". One word, still: the time is part of when, not a fourth
  // thing to answer, and a row with no time reads exactly as it always did.
  const at = timeWord(opts.atTime);
  return at ? `${day} ${at}` : day;
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
