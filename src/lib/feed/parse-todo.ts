// ═══════════════════════════════════════════════════════════════════════════
// Reading a plain sentence typed into the "add a to-do" row.
//
// PURE. No React, no fetch, no `new Date()` in the body — the clock is passed
// in, so the same sentence parses the same way in a test at any hour. It runs
// on every keystroke against a string a person is still typing, so it must stay
// cheap and it must never throw.
//
// THE ONE RULE THAT MATTERS: nothing unrecognised is an error. Anything this
// file does not claim stays in the title, verbatim. There is no failure path,
// no error state, and no way for a sentence to be "wrong". A person who types
// three words and presses Enter has succeeded.
//
// THE SECOND RULE: never lift a bare number. "fix room 214 ac" must not read
// 214 as the 214th of the month, or as anything else. Every date this file
// claims is anchored on a keyword the person actually wrote.
//
// THE THIRD RULE: never invent a person. A name is only claimed when it matches
// somebody on the roster the caller passed in, which is the roster
// /api/worklist?view=assignees returns — housekeepers are absent from it, so
// they can never be matched here either. See HOUSEKEEPER_NOTE.
// ═══════════════════════════════════════════════════════════════════════════

import { WEEKDAYS, whichDayQuestion } from './one-list-copy';

/** The cadences the composer and `comms_tasks` both understand. */
export type RepeatChoice = 'once' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';

/** One row of the roster a to-do can be handed to. */
export interface ComposerPerson { staffId: string; name: string }

export interface ParseResult {
  /** The task name, with any lifted phrases removed and whitespace collapsed. */
  title: string;
  /** staffId | 'dept:<department>' | null. */
  who: string | null;
  /** YYYY-MM-DD | null. A calendar DAY, never an instant. */
  when: string | null;
  repeat: RepeatChoice | null;
  weekday: number | null;
  dayOfMonth: number | null;
  /**
   * "HH:MM" on a 24-hour clock, or null. A time of DAY, never an instant, and
   * never a timezone: the server still owns where a day begins and ends. Null
   * for the overwhelming majority of sentences, and a to-do with no time
   * behaves exactly as every to-do behaved before this field existed.
   */
  atTime: string | null;
  /** At most one. Null in the overwhelming majority of cases. */
  question: ParseQuestion | null;
}

export interface ParseQuestion {
  /** "Which Friday?" */
  prompt: string;
  /** Exactly two or three. The first is what Enter takes. */
  choices: { label: string; patch: Partial<ParseResult> }[];
}

/** Nothing claimed. The shape a caller gets for an empty or unreadable string. */
export function emptyParse(title = ''): ParseResult {
  return {
    title, who: null, when: null, repeat: null, weekday: null, dayOfMonth: null,
    atTime: null, question: null,
  };
}

// ─── the clock, in the person's own calendar ────────────────────────────────

function isoOf(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function shift(now: Date, days: number): string {
  return isoOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** The next time this weekday comes round, counting today as itself. */
function thisWeekday(now: Date, target: number): string {
  const ahead = (target - now.getDay() + 7) % 7;
  return shift(now, ahead);
}

/**
 * The same weekday in the FOLLOWING Sunday-to-Saturday week.
 *
 * "next Friday" is genuinely ambiguous in English on a Wednesday. This takes
 * the reading nobody argues with — the Friday of next week — rather than
 * "the next Friday there is", which is what a bare "Friday" already means.
 */
function nextWeekWeekday(now: Date, target: number): string {
  const sundayOfNextWeek = 7 - now.getDay();
  return shift(now, sundayOfNextWeek + target);
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14,
};

/** A month/day pair, resolved onto the nearest sensible year. */
function monthDay(now: Date, monthIndex: number, day: number): string | null {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const candidate = new Date(now.getFullYear(), monthIndex, day);
  // A real day, not "February 31" silently rolling into March.
  if (candidate.getMonth() !== monthIndex || candidate.getDate() !== day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // A date already past means next year: nobody types "Aug 22" in September
  // meaning the one that has been and gone.
  if (candidate.getTime() < today.getTime()) {
    const rolled = new Date(now.getFullYear() + 1, monthIndex, day);
    if (rolled.getMonth() !== monthIndex || rolled.getDate() !== day) return null;
    return isoOf(rolled);
  }
  return isoOf(candidate);
}

function weekdayOfIso(iso: string): number | null {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

// ─── the clock on the wall ──────────────────────────────────────────────────
//
// THE SECOND RULE, SAID AGAIN AND HARDER. A bare number is never a time.
// "fix room 214 ac" must not become work due at 2:14, and "order 3 cases of
// coffee" must not become work due at three o'clock. A time is claimed only
// when the person wrote something that cannot be anything else:
//
//   an am/pm marker        "3pm", "by 3 pm", "at 6:30am"
//   minutes after a colon  "at 6:30", "15:00"
//   the word noon          "before noon"
//
// "at 6" is deliberately NOT claimed. People do write it, and it is also the
// shape of half the numbers in a hotel. Leaving it in the title is never wrong;
// reading it as 6am when somebody meant 6pm is a job missed by twelve hours.

/** "HH:MM" on a 24-hour clock, or null when the numbers are not a real time. */
function clockOf(hour: number, minute: number, meridiem: string | null): string | null {
  let h = hour;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  // A bare 12- or 24-hour number with no marker is only accepted by the callers
  // that already matched a colon, so 13..23 arrives here legitimately.
  if (!Number.isFinite(h) || !Number.isFinite(minute)) return null;
  if (h < 0 || h > 23 || minute < 0 || minute > 59) return null;
  return `${`${h}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`;
}

/**
 * The end of the part of the day somebody named.
 *
 * "this morning" is not a clock time, and turning it into one would be an
 * invention. What it IS, on a to-do, is a deadline: work wanted this morning is
 * work wanted before the morning is over. So each phrase maps to the END of the
 * span it names, which is the only reading that does not put a number in
 * somebody's mouth that they never said.
 *
 * "every morning" is NOT here. A cadence is not a deadline, and the repeat row
 * already says the whole of what was written down.
 */
const PART_OF_DAY_END: Record<string, string> = {
  morning: '12:00',
  afternoon: '17:00',
  evening: '21:00',
  tonight: '21:00',
};

// ─── cutting phrases out of the sentence ────────────────────────────────────

type Cut = [number, number];

function overlaps(cuts: readonly Cut[], start: number, end: number): boolean {
  for (const [a, b] of cuts) if (start < b && a < end) return true;
  return false;
}

/**
 * The first match of `re` that is safe to cut.
 *
 * Safe means two things: it does not sit on top of something already cut, and
 * it is not immediately followed by a possessive. "call today's arrivals" is
 * not a to-do due today, it is a to-do about today's arrivals, and lifting the
 * word out of it leaves the nonsense title "'s arrivals". Same for a name:
 * "cover Marcus's shift" is work for whoever is reading it.
 */
function firstFree(lower: string, cuts: readonly Cut[], re: RegExp): RegExpExecArray | null {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m = scan.exec(lower);
  while (m) {
    const end = m.index + m[0].length;
    const next = lower[end];
    if (!overlaps(cuts, m.index, end) && next !== "'" && next !== '’') return m;
    m = scan.exec(lower);
  }
  return null;
}

/**
 * What is left once the lifted phrases are gone.
 *
 * Collapses the double spaces the removals leave behind, drops a connector left
 * dangling by a cut ("... on" with the day taken out of it), and capitalises the
 * first letter ONLY — the rest of the sentence is the person's own writing and
 * is never re-cased.
 */
export function cleanTitle(text: string, cuts: readonly Cut[]): string {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of sorted) {
    out += `${text.slice(at, start)} `;
    at = end;
  }
  out += text.slice(at);
  out = out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .replace(/^[,.;:\s]+/, '')
    .replace(/[,;:\s]+$/, '')
    .trim();
  // Only when something was actually removed. With no cuts the text is the
  // person's sentence exactly as typed, and trimming a word off the end of it
  // would be this file editing writing it does not understand.
  if (sorted.length > 0) out = out.replace(/\s+(and|to|on|at|by|for|from)$/i, '').trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}

/**
 * The same cleaning, driven by literal phrases rather than by regex matches.
 *
 * Used by the optional model reading, which reports the phrases it used rather
 * than authoring a title of its own. A phrase that is not literally in the text
 * is ignored, so nothing a model invents can reach the field.
 */
export function cleanTitleWithout(text: string, phrases: readonly string[]): string {
  const cuts: Cut[] = [];
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    const needle = (phrase ?? '').trim().toLowerCase();
    if (needle.length < 2 || needle.length > text.length) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      if (!overlaps(cuts, at, at + needle.length)) { cuts.push([at, at + needle.length]); break; }
      from = at + 1;
    }
  }
  return cuts.length > 0 ? cleanTitle(text, cuts) : cleanTitle(text, []);
}

// ─── the roster ─────────────────────────────────────────────────────────────

const NAME_ESCAPE = /[.*+?^${}()|[\]\\]/g;

interface NameCandidate { staffId: string; pattern: string }

/**
 * Every spelling of a name that may be matched, longest first.
 *
 * Longest first so "Marcus Webb" wins over "Marcus" when both would match, and
 * the cut removes the whole name rather than leaving a surname in the title.
 */
function nameCandidates(people: readonly ComposerPerson[]): NameCandidate[] {
  const out: NameCandidate[] = [];
  for (const person of people) {
    const full = (person.name ?? '').trim();
    if (!full || !person.staffId) continue;
    const first = full.split(/\s+/)[0] ?? '';
    for (const spelling of [full, first]) {
      if (spelling.length < 2) continue;
      const pattern = spelling.replace(NAME_ESCAPE, '\\$&');
      if (!out.some((c) => c.pattern === pattern)) out.push({ staffId: person.staffId, pattern });
    }
  }
  return out.sort((a, b) => b.pattern.length - a.pattern.length);
}

/**
 * The handoff verbs, in the order they must be tried.
 *
 * Each captures the WHOLE phrase, verb included, because "ask Marcus to check
 * the pool" has to leave "Check the pool" behind and not "ask to check the
 * pool". `%s` is where the name goes.
 */
const HANDOFF_FORMS: readonly string[] = [
  '\\bask %s to\\b',
  '\\btell %s to\\b',
  '\\bget %s to\\b',
  '\\bhave %s\\b',
  '\\b%s needs to\\b',
  '\\b%s should\\b',
  '\\bfor %s\\b',
  '\\b%s to\\b',
];

// ═══════════════════════════════════════════════════════════════════════════

export function parseTodo(
  raw: string,
  people: readonly ComposerPerson[],
  now: Date,
): ParseResult {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) return emptyParse('');
  const lower = text.toLowerCase();
  const cuts: Cut[] = [];
  const take = (m: RegExpExecArray): void => { cuts.push([m.index, m.index + m[0].length]); };

  let who: string | null = null;
  let when: string | null = null;
  let repeat: RepeatChoice | null = null;
  let weekday: number | null = null;
  let dayOfMonth: number | null = null;
  let atTime: string | null = null;
  let question: ParseQuestion | null = null;

  // ── 1. who ───────────────────────────────────────────────────────────────
  // Before the dates, so "have Marcus check it Friday" gives up its name first
  // and the weekday pass never sees the handoff clause.
  for (const candidate of nameCandidates(people)) {
    if (who) break;
    for (const form of HANDOFF_FORMS) {
      const m = firstFree(lower, cuts, new RegExp(form.replace('%s', candidate.pattern.toLowerCase()), 'gi'));
      if (m) { who = candidate.staffId; take(m); break; }
    }
  }

  // ── 1b. what time ────────────────────────────────────────────────────────
  // Before the cadence and the date, so "every day at 3pm" gives up its clock
  // first and neither of the later passes has to know that "3pm" is not a date.
  // Each form below is anchored on something that can only be a time; a bare
  // number reaches none of them. See the block comment above clockOf.
  const spelled = firstFree(lower, cuts, /\b(?:by|at|before)?\s*(?:12\s*)?noon\b/g);
  const keyedClock = spelled
    ? null
    : firstFree(lower, cuts, /\b(?:by|at|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/g);
  // A colon carries the same weight as a marker: "6:30" is a time in a way "6"
  // never is. The keyword is optional here for exactly that reason.
  const colonClock = spelled || keyedClock
    ? null
    : firstFree(lower, cuts, /\b(?:by|at|before)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?\b/g);
  // And so does a bare marker with no keyword at all: "fix the ice machine 3pm".
  const bareMeridiem = spelled || keyedClock || colonClock
    ? null
    : firstFree(lower, cuts, /\b(\d{1,2})\s*(am|pm)\b/g);

  if (spelled) {
    atTime = '12:00';
    take(spelled);
  } else if (keyedClock) {
    const t = clockOf(Number(keyedClock[1]), Number(keyedClock[2] ?? 0), meridiemOf(keyedClock[3]));
    if (t) { atTime = t; take(keyedClock); }
  } else if (colonClock) {
    const t = clockOf(Number(colonClock[1]), Number(colonClock[2]), meridiemOf(colonClock[3]));
    if (t) { atTime = t; take(colonClock); }
  } else if (bareMeridiem) {
    const t = clockOf(Number(bareMeridiem[1]), 0, meridiemOf(bareMeridiem[2]));
    if (t) { atTime = t; take(bareMeridiem); }
  }

  // ── 2. how often ─────────────────────────────────────────────────────────
  // Cadence before date, so "every Friday" is a cadence and not a day.
  const weekdayAlt = WEEKDAYS.map((d) => d.toLowerCase()).join('|');

  const everyOtherDay = firstFree(lower, cuts, new RegExp(`\\bevery other (${weekdayAlt})s?\\b`, 'g'));
  const everyOtherWeek = everyOtherDay ? null : firstFree(lower, cuts, /\bevery other week\b|\bbiweekly\b|\bbi-weekly\b|\bfortnightly\b/g);
  const everyMonthOn = firstFree(lower, cuts, /\bevery month on the (\d{1,2})(?:st|nd|rd|th)?\b/g);
  const everyMonth = everyMonthOn ? null : firstFree(lower, cuts, /\bevery month\b|\bmonthly\b/g);
  const everyWeekday = firstFree(lower, cuts, new RegExp(`\\bevery (${weekdayAlt})s?\\b`, 'g'));
  const everyWeek = everyWeekday ? null : firstFree(lower, cuts, /\bevery week\b|\bweekly\b/g);
  const everyDay = firstFree(lower, cuts, /\bevery day\b|\bevery single day\b|\bdaily\b|\bevery morning\b|\bevery night\b|\bevery evening\b|\bnightly\b/g);

  if (everyOtherDay) {
    repeat = 'biweekly';
    weekday = WEEKDAYS.findIndex((d) => d.toLowerCase() === everyOtherDay[1]);
    take(everyOtherDay);
  } else if (everyOtherWeek) {
    repeat = 'biweekly';
    take(everyOtherWeek);
  } else if (everyMonthOn) {
    const day = Number(everyMonthOn[1]);
    if (day >= 1 && day <= 28) { repeat = 'monthly'; dayOfMonth = day; take(everyMonthOn); }
  } else if (everyMonth) {
    repeat = 'monthly';
    take(everyMonth);
  } else if (everyWeekday) {
    repeat = 'weekly';
    weekday = WEEKDAYS.findIndex((d) => d.toLowerCase() === everyWeekday[1]);
    take(everyWeekday);
  } else if (everyWeek) {
    repeat = 'weekly';
    take(everyWeek);
  } else if (everyDay) {
    // "every morning" and "every night" are both daily. The time of day is not
    // stored, so it is never promised back in the words: the row says
    // "every day", which is the whole of what was written down.
    repeat = 'daily';
    take(everyDay);
  } else {
    const onceM = firstFree(lower, cuts, /(?:^|\s)just once\s*$|(?:^|\s)once\s*$/g);
    // Only a TRAILING "once". Mid-sentence it is nearly always a conjunction
    // ("once the guest checks out"), and lifting that would eat the sentence.
    if (onceM) { repeat = 'once'; take(onceM); }
  }

  // ── 3. when ──────────────────────────────────────────────────────────────
  // "this morning" is both a day and a deadline: it says today, and it says
  // before today's morning is over. The day is claimed here as it always was;
  // the time rides along below, and only when no explicit clock beat it to it.
  const today = firstFree(lower, cuts, /\btoday\b|\btonight\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b/g);
  const tomorrow = today ? null : firstFree(lower, cuts, /\btomorrow\b|\btmrw\b|\btomorrow morning\b/g);
  const thisDay = today || tomorrow ? null : firstFree(lower, cuts, new RegExp(`\\bthis (${weekdayAlt})\\b`, 'g'));
  const nextDay = today || tomorrow || thisDay ? null : firstFree(lower, cuts, new RegExp(`\\bnext (${weekdayAlt})\\b`, 'g'));
  const onDay = today || tomorrow || thisDay || nextDay ? null : firstFree(lower, cuts, new RegExp(`\\bon (${weekdayAlt})\\b`, 'g'));
  const inDays = today || tomorrow || thisDay || nextDay || onDay
    ? null
    : firstFree(lower, cuts, /\bin (\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen) days?\b/g);
  const monthFirst = today || tomorrow || thisDay || nextDay || onDay || inDays
    ? null
    : firstFree(lower, cuts, new RegExp(`\\b(${MONTH_NAMES.join('|')}|${MONTH_NAMES.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'));
  const dayFirst = today || tomorrow || thisDay || nextDay || onDay || inDays || monthFirst
    ? null
    : firstFree(lower, cuts, new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES.join('|')}|${MONTH_NAMES.map((m) => m.slice(0, 3)).join('|')})\\b`, 'g'));
  // "9/14" is a date. "1/2 inch" is a pipe fitting, and reading it as the 2nd
  // of January files the job eleven months out AND leaves the title "Replace
  // the inch elbow". The two are indistinguishable in the middle of a sentence,
  // so this form is only claimed at the END of one, where a date is what a
  // person is writing. Anything else stays in the title, which is never wrong.
  const slash = today || tomorrow || thisDay || nextDay || onDay || inDays || monthFirst || dayFirst
    ? null
    : firstFree(lower, cuts, /\b(\d{1,2})\/(\d{1,2})(?=[\s.,;:!?]*$)/g);
  const bareDay = today || tomorrow || thisDay || nextDay || onDay || inDays || monthFirst || dayFirst || slash
    ? null
    : firstFree(lower, cuts, new RegExp(`\\b(${weekdayAlt})\\b`, 'g'));

  if (today) {
    when = shift(now, 0);
    // An explicit clock always wins: somebody who wrote "this morning by 10am"
    // said 10am, and overwriting it with the end of the morning would be this
    // file preferring its own reading to the one in front of it.
    if (!atTime) {
      const part = /tonight/.test(today[0])
        ? 'tonight'
        : /morning/.test(today[0]) ? 'morning'
          : /afternoon/.test(today[0]) ? 'afternoon'
            : /evening/.test(today[0]) ? 'evening' : null;
      if (part) atTime = PART_OF_DAY_END[part] ?? null;
    }
    take(today);
  } else if (tomorrow) {
    when = shift(now, 1);
    take(tomorrow);
  } else if (thisDay) {
    const target = WEEKDAYS.findIndex((d) => d.toLowerCase() === thisDay[1]);
    when = thisWeekday(now, target);
    weekday = weekday ?? target;
    take(thisDay);
  } else if (nextDay) {
    const target = WEEKDAYS.findIndex((d) => d.toLowerCase() === nextDay[1]);
    when = nextWeekWeekday(now, target);
    weekday = weekday ?? target;
    take(nextDay);
  } else if (onDay) {
    const target = WEEKDAYS.findIndex((d) => d.toLowerCase() === onDay[1]);
    when = thisWeekday(now, target);
    weekday = weekday ?? target;
    take(onDay);
  } else if (inDays) {
    const n = Number(inDays[1]) || WORD_NUMBERS[inDays[1]] || 0;
    if (n > 0 && n <= 365) { when = shift(now, n); take(inDays); }
  } else if (monthFirst) {
    const iso = monthDay(now, monthIndexOf(monthFirst[1]), Number(monthFirst[2]));
    if (iso) { when = iso; take(monthFirst); }
  } else if (dayFirst) {
    const iso = monthDay(now, monthIndexOf(dayFirst[2]), Number(dayFirst[1]));
    if (iso) { when = iso; take(dayFirst); }
  } else if (slash) {
    const iso = monthDay(now, Number(slash[1]) - 1, Number(slash[2]));
    if (iso) { when = iso; take(slash); }
  } else if (bareDay) {
    // The ONE genuinely two-sided input. "fix room 214 ac Friday" is either
    // this Friday or every Friday, and both readings are reasonable. It is
    // asked as a question, never as an error: the safer reading (this Friday)
    // is already taken, the row is not blocked, and Enter still works.
    const target = WEEKDAYS.findIndex((d) => d.toLowerCase() === bareDay[1]);
    const iso = thisWeekday(now, target);
    when = iso;
    weekday = weekday ?? target;
    take(bareDay);
    if (repeat === null) question = whichDayQuestion(WEEKDAYS[target], iso, target);
  }

  // A repeating item has no single due date; when it names a day, that day is
  // where the run STARTS. The row says "from Monday" for exactly this reason.
  if (repeat !== null && repeat !== 'once' && weekday === null && when) {
    weekday = weekdayOfIso(when);
  }

  return {
    title: cleanTitle(text, cuts),
    who,
    when,
    repeat,
    weekday,
    dayOfMonth,
    atTime,
    question,
  };
}

/** "p.m." and "PM" and "pm" are one thing. Anything else is no marker at all. */
function meridiemOf(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.replace(/\./g, '').toLowerCase();
  return t === 'am' || t === 'pm' ? t : null;
}

function monthIndexOf(token: string): number {
  const t = token.replace('.', '');
  const exact = MONTH_NAMES.indexOf(t as (typeof MONTH_NAMES)[number]);
  if (exact >= 0) return exact;
  return MONTH_NAMES.findIndex((m) => m.slice(0, 3) === t);
}
