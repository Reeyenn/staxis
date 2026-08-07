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
  opts: { weekday?: number | null; dayOfMonth?: number | null; intervalDays?: number | null } = {},
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
    // The open-ended one. With no number it has nothing to say, so it says the
    // safe thing rather than "every null days": a cadence label is read at a
    // glance and a wrong one is worse than a vague one.
    case 'every_n_days': {
      const n = typeof opts.intervalDays === 'number' ? opts.intervalDays : null;
      return n && n > 1 ? `Every ${n} days` : 'Every few days';
    }
    default: return 'Once';
  }
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// The situations a maintenance row is actually in
//
// A preventive schedule and a work order each carried ONE button: Done. That is
// the right big button and it stays the big button, because the list is a
// 10-second read and a row with five controls is a form. But Done was also the
// only exit, so every other situation a manager was actually in — the vendor is
// coming Thursday, the part is on back order, somebody looked and it was fine,
// this schedule fires far too often — had to be expressed by pressing a button
// that says the work happened. That is not a missing feature, it is a button
// that files a fiction, and the fiction goes into the hotel's own maintenance
// record.
//
// So: one quiet "···" beside Done, opening a SHORT list of the honest answers
// for that row type, and nothing else. The rules the menu is built to:
//
//   1. EVERY OPTION IS A REAL STATE. Each one writes to a column that already
//      meant this, and each one says out loud what it costs (`hint`). "Adjust"
//      is banned by name — an option that does not say what it does is a
//      question mark, and a manager who taps one and cannot predict the result
//      stops tapping any of them.
//   2. NO OPTION LIES. Nothing here records work that did not happen, and
//      nothing here deletes anything. "Skip this one" is one occurrence, never
//      the schedule.
//   3. THE SETS DO NOT OVERLAP BY ACCIDENT. A work order never shows preventive
//      options and the other way round, because the two row types are not two
//      flavours of the same thing.
//
// To-dos are deliberately ABSENT: their overdue row already grew three honest
// endings of its own (0453) and a menu over the top of that would be two ways
// to say the same four things.
// ═══════════════════════════════════════════════════════════════════════════

/** Every situation the "···" can record. One id per real state. */
export type RowMenuAction =
  /** pm: somebody has been called out. Rests a week, then asks once. */
  | 'called'
  /** pm: change how often this comes round. Opens a number, then saves. */
  | 'reschedule'
  /** pm: this occurrence only, put down without the work being done. */
  | 'skip'
  /** workorder: not moving, and here is the one line saying why. */
  | 'waiting'
  /** workorder: hand it to somebody else. Opens the roster. */
  | 'reassign'
  /** workorder: somebody looked, and it was not a problem. Closed, not fixed. */
  | 'not_an_issue';

/** What a menu option needs from the person before it can be sent. */
export type RowMenuInput = 'none' | 'reason' | 'days' | 'person';

export interface RowMenuOption {
  action: RowMenuAction;
  label: string;
  /** What it actually costs, said out loud. Never null: see rule 1 above. */
  hint: string;
  /** What the row asks for after the option is tapped. */
  input: RowMenuInput;
}

const PM_MENU: readonly RowMenuOption[] = [
  {
    action: 'called',
    label: "Somebody's been called",
    hint: 'Staxis goes quiet for a week, then asks once whether it happened.',
    input: 'none',
  },
  {
    action: 'reschedule',
    label: 'Change the schedule',
    hint: 'Changes how many days between each one. Nothing is marked done.',
    input: 'days',
  },
  {
    action: 'skip',
    label: 'Skip this one',
    hint: 'Skips this one only. The schedule stays, and the next one is a full cycle away.',
    input: 'none',
  },
];

const WORKORDER_MENU: readonly RowMenuOption[] = [
  {
    action: 'waiting',
    label: 'Waiting on parts',
    hint: 'Stays on the list, out of the way, with your reason on it.',
    input: 'reason',
  },
  {
    action: 'reassign',
    label: 'Give it to someone else',
    hint: 'Puts their name on it so everyone can see who has it.',
    input: 'person',
  },
  {
    action: 'not_an_issue',
    label: 'Not actually a problem',
    hint: 'Closes it as a non issue. It is not recorded as a repair.',
    input: 'none',
  },
];

/**
 * The situations THIS row can be in.
 *
 * Keyed on the row's own source, and empty for every source that is not a
 * maintenance one. Empty is what makes the "···" not appear at all: a menu
 * button that opens nothing is worse than no button.
 *
 * `canComplete` is honoured because it is the same question in different words:
 * a row this person cannot settle from the list is not a row they can defer,
 * skip or reschedule from it either.
 */
export function rowMenuOptions(
  item: Pick<WorklistItem, 'sourceType' | 'canComplete'>,
): readonly RowMenuOption[] {
  if (!item.canComplete) return [];
  if (item.sourceType === 'pm') return PM_MENU;
  if (item.sourceType === 'workorder') return WORKORDER_MENU;
  return [];
}

/** The fixed words the menu itself uses, outside the options. */
export const ROW_MENU_COPY = {
  /** The trigger's accessible name. The glyph alone is not a label. */
  open: 'Other ways to answer this',
  cancel: 'Never mind',
  save: 'Save',
  send: 'Send',
  /** Above the roster, when handing a work order over. */
  personLabel: 'Give it to',
  /** Above the number box, when changing a cadence. */
  daysLabel: 'How many days between each one',
  /** The placeholder in the waiting-on-parts box. */
  reasonPlaceholder: 'What is it waiting on? One line is enough.',
  reasonAria: 'What this work order is waiting on',
  daysAria: 'Days between each one',
  noPeople: 'Nobody here can be given this one.',
  failed: 'That did not save. Nothing changed. Try again in a moment.',
} as const;

/**
 * The line under a work order somebody has parked, in their own words.
 *
 * Prefixed rather than shown bare, because "back ordered until Friday" on its
 * own reads as the ticket's description. The prefix is what makes the row say
 * that a person decided this, rather than that Staxis worked something out.
 */
export function waitingLine(reason: string | null | undefined): string | null {
  const said = (reason ?? '').trim();
  return said ? `Waiting on parts: ${said}` : null;
}

/** "Every 90 days" for a cadence somebody is about to change. */
export function cadenceLine(days: number | null | undefined): string | null {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 1) return null;
  if (days === 1) return 'Every day';
  return `Every ${Math.round(days)} days`;
}

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
 * HOUSEKEEPING IS NOT HERE, and neither are housekeepers in the people list:
 * they work from the housekeeping board, and offering a target whose work would
 * land on a screen they never open would be worse than not offering it. That
 * used to be SAID, in a line under the row. It was deleted on 2026-08-05: a
 * sentence explaining who is missing, over a list of who is there, is an answer
 * to a question nobody had asked yet.
 */
export const COMPOSER_ROLES: readonly { value: string; label: string }[] = [
  { value: 'dept:front_desk', label: "Whoever's on front desk" },
  { value: 'dept:maintenance', label: 'Maintenance' },
  { value: 'dept:all_staff', label: 'Everyone' },
];

/**
 * The value the "Other" chip carries. It is a POINTER, never a person.
 *
 * It never reaches `who`, and `composerPayload` refuses it outright, because a
 * to-do assigned to the word "other" is a to-do nobody has.
 */
export const COMPOSER_OTHER = 'other';

/** Every fixed sentence the composer says. No em dashes, English only. */
export const COMPOSER_COPY = {
  /** The idle prompt, before anybody has touched the row. */
  prompt: 'Add something.',
  /** The prompt once somebody has opened the buttons without typing. */
  promptChoosing: 'What needs doing?',
  /** The last chip on the WHO row. Not a person: it points at the sentence. */
  other: 'Other',
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
  /** The custom cadence chip. The blank is a number the person types. */
  everyNDaysChip: 'Every',
  everyNDaysUnit: 'days',
  everyNDaysLabel: 'Repeat every this many days',
} as const;

/**
 * The hint the "Other" chip shows, naming somebody real when there is one.
 *
 * The chip does not open a picker, because there is nothing to pick from that
 * is not already on the row. What it does is TELL somebody the sentence takes a
 * name, which is the one part of this control nobody discovers on their own.
 */
/**
 * What the blank says when the number in it is not a cadence.
 *
 * Never red, never blocking: the row still adds on Enter, as a one-off. This
 * only exists so somebody who typed 1 or 900 learns why the word above the row
 * did not change.
 */
export function intervalHint(min: number, max: number): string {
  return `Pick a number between ${min} and ${max}.`;
}

export function otherHint(exampleName?: string | null): string {
  const first = (exampleName ?? '').trim().split(/\s+/)[0];
  return first
    ? `Type their name in the sentence, like "ask ${first} to check the lobby".`
    : 'Type their name in the sentence, like "ask Sam to check the lobby".';
}

// ═══════════════════════════════════════════════════════════════════════════
// The rotating prompt
//
// A field that says "What needs doing?" is a question. A field that says "Try:
// Fix the ice machine tomorrow" is an ANSWER, and the whole point of this row
// is that a plain sentence carries the day, the person and the cadence. One
// static example would teach one trick; a slow rotation teaches the shape.
//
// The accessible name never rotates. See the aria-label on the field: a screen
// reader that renamed the same control every few seconds would be unusable.
// ═══════════════════════════════════════════════════════════════════════════

/** How long each example stays up. Slow on purpose: this is not an animation. */
export const PROMPT_ROTATE_MS = 7_000;

/** Real sentences, each of which genuinely parses into something. */
export const PROMPT_EXAMPLES: readonly string[] = [
  'Add a to-do. Try: Fix the ice machine tomorrow',
  'Try: Towel delivery every Tuesday',
  'Try: Have Marcus check the pool Friday',
  'Try: Flush the water heater every 3 days',
  'Try: Deep clean the lobby every month on the 1st',
];

/** The example at this tick. Wraps, and never fails on a silly index. */
export function promptExample(tick: number): string {
  const n = PROMPT_EXAMPLES.length;
  if (n === 0) return COMPOSER_COPY.prompt;
  const i = Number.isFinite(tick) ? ((Math.trunc(tick) % n) + n) % n : 0;
  return PROMPT_EXAMPLES[i];
}

// ═══════════════════════════════════════════════════════════════════════════
// Assigned by me
// ═══════════════════════════════════════════════════════════════════════════

/** How many of the things you handed out sit on the face of the panel. */
export const ASSIGNED_FACE_LIMIT = 3;

export const ASSIGNED_COPY = {
  title: 'Assigned by me',
  showMore: 'Show more',
  /**
   * The same door, when there is nothing hidden behind it but there IS news.
   *
   * Opening the popup is what marks the notices as seen, so a person with two
   * assignments and one that just came back has to be able to reach it. Called
   * "Show more" it would be a button promising something it does not have.
   */
  seeAll: 'See what you assigned',
  popupTitle: 'Everything you assigned',
  /** Under the popup title. Says the order, so nobody has to work it out. */
  popupNote: 'Newest first.',
  empty: 'You have not handed anything to anyone yet.',
  close: 'Close',
} as const;

/** "3 of 11 shown" is bookkeeping. This says the only useful part. */
export function assignedMoreLine(total: number, shown: number): string | null {
  const hidden = total - shown;
  if (hidden <= 0) return null;
  return hidden === 1 ? '1 more' : `${hidden} more`;
}

// ═══════════════════════════════════════════════════════════════════════════
// The month, and adding something to it
// ═══════════════════════════════════════════════════════════════════════════

export const EVENT_COPY = {
  add: 'Add event',
  /** The one thing about this control nobody guesses. */
  dragHint: 'Click a day, or drag across days for something that runs longer.',
  titleLabel: 'What is it',
  titlePlaceholder: 'Fire safety training',
  notesLabel: 'Notes',
  notesPlaceholder: 'Anything the team should know.',
  daysLabel: 'Days',
  noDays: 'Pick a day on the month.',
  save: 'Save',
  cancel: 'Cancel',
  saving: 'Saving',
  failed: 'That did not save. Nothing changed. Try again in a moment.',
  monthTitle: 'Month',
  close: 'Close',
} as const;

/** "August 12" or "August 12 to August 15". The live readback in the panel. */
export function pickedDaysLine(start: string | null, end: string | null): string {
  if (!start) return EVENT_COPY.noDays;
  const from = longDay(start);
  if (!from) return EVENT_COPY.noDays;
  if (!end || end === start) return from;
  const to = longDay(end);
  return to ? `${from} to ${to}` : from;
}

function longDay(iso: string): string | null {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return `${LONG_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

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
  opts: { weekday?: number | null; dayOfMonth?: number | null; intervalDays?: number | null } = {},
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
