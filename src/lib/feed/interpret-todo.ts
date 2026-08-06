// ═══════════════════════════════════════════════════════════════════════════
// The optional second reading of a to-do sentence.
//
// `parse-todo.ts` is the parser. It is pure code, it is synchronous, and it is
// the ONLY thing on the typing path. This file is a fallback that sits on top
// of it and is allowed to do exactly one thing: when the code lifted nothing at
// all out of a sentence that clearly has something in it, ask a model what it
// says, and fold the answer in as if the code had found it.
//
// EVERY RULE HERE EXISTS TO KEEP THAT OPTIONAL.
//
//   • It never runs while the code path succeeded. Something lifted means
//     nothing to ask about.
//   • Its answer arrives in the SAME SHAPE the parser returns and is applied
//     exactly like a parse: the words go caramel ("lifted"), never sage.
//   • It cannot author a title. The model reports the PHRASES it used, each of
//     which must be a literal substring of what the person typed; the title is
//     then cut and cleaned by the same code that cleans a normal parse. A model
//     that invents a phrase changes nothing.
//   • It cannot invent a person. A name it proposes must match the roster the
//     server read, on a first name or a full name, or it is dropped.
//     Housekeepers are absent from that roster, so they can never be matched.
//   • It cannot block anything. It is debounced, short-deadlined, cancelled on
//     the next keystroke and on submit, and every failure mode is silence.
//
// The word "AI" appears nowhere in the interface this feeds, and there is no
// spinner: a person who never notices this exists loses nothing at all.
// ═══════════════════════════════════════════════════════════════════════════

import { cleanTitleWithout, emptyParse, type ComposerPerson, type ParseResult, type RepeatChoice } from './parse-todo';

/** How long after the last keystroke before the reading is worth asking for. */
export const INTERPRET_DEBOUNCE_MS = 400;

/** The whole budget for the round trip. Past this, nothing happened. */
export const INTERPRET_TIMEOUT_MS = 2_500;

/**
 * Below this, a sentence is not worth a round trip.
 *
 * "fix the ice machine" is four words and means exactly what it says; there is
 * no who, no when and no cadence hiding in it. The cases this fallback is for
 * are longer and more roundabout: "can somebody take a look at the boiler
 * before the weekend".
 */
export const INTERPRET_MIN_WORDS = 5;

/** The most text ever sent. Matches the parser's own working range. */
export const INTERPRET_MAX_CHARS = 200;

/** What the model is allowed to come back with, before any of it is believed. */
export interface TodoReading {
  /** A name as written. Checked against the roster, never trusted. */
  who: string | null;
  /** YYYY-MM-DD. */
  when: string | null;
  repeat: RepeatChoice | null;
  weekday: number | null;
  dayOfMonth: number | null;
  /** The exact phrases it read those out of. Literal substrings, or ignored. */
  phrases: string[];
}

/**
 * What a reading may claim as a cadence.
 *
 * `every_n_days` is deliberately absent. It is the one cadence that carries a
 * NUMBER, and a model that named it without a believable interval would produce
 * a template with no gap in it. The pure parser reads "every 3 days" perfectly
 * well, and a sentence the parser read is a sentence this path never runs on.
 */
const REPEATS: readonly RepeatChoice[] = ['once', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];

/**
 * Is this sentence worth a second reading?
 *
 * Only when the code lifted NOTHING beyond the title, and the sentence is long
 * enough that something was plausibly meant. A question the parser already
 * asked also counts as a success: it understood enough to ask.
 */
export function shouldInterpret(raw: string, parsed: ParseResult): boolean {
  const text = (raw ?? '').trim();
  if (!text || text.length > INTERPRET_MAX_CHARS) return false;
  if (parsed.who || parsed.when || parsed.repeat || parsed.question) return false;
  return text.split(/\s+/).filter(Boolean).length >= INTERPRET_MIN_WORDS;
}

/** Case-insensitive match on a first name or a full name, and nothing else. */
export function matchRoster(name: string | null, people: readonly ComposerPerson[]): string | null {
  const wanted = (name ?? '').trim().toLowerCase();
  if (wanted.length < 2) return null;
  for (const person of people) {
    const full = (person.name ?? '').trim().toLowerCase();
    if (!full || !person.staffId) continue;
    if (full === wanted) return person.staffId;
    if ((full.split(/\s+/)[0] ?? '') === wanted) return person.staffId;
  }
  return null;
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00`);
  return !Number.isNaN(d.getTime());
}

/**
 * Turn a raw reading into the shape a parse has, or into nothing.
 *
 * Returns null when the reading claims nothing believable, which is the same as
 * the reading never having happened.
 */
export function sanitizeInterpretation(
  raw: string,
  reading: unknown,
  people: readonly ComposerPerson[],
  now: Date,
): ParseResult | null {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) return null;
  const r = reading as Record<string, unknown>;

  const who = matchRoster(typeof r.who === 'string' ? r.who : null, people);
  const when = isDay(r.when) ? r.when : null;
  const repeat = REPEATS.includes(r.repeat as RepeatChoice) ? (r.repeat as RepeatChoice) : null;
  if (!who && !when && !repeat) return null;

  // A date in the past is a misreading, not an instruction. Nobody adds a to-do
  // that was due last Tuesday, and quietly back-dating one would put it on the
  // list already late.
  const todayIso = isoOfDay(now);
  const safeWhen = when && when >= todayIso ? when : null;
  if (!who && !safeWhen && !repeat) return null;

  const phrases = Array.isArray(r.phrases)
    ? r.phrases.filter((p): p is string => typeof p === 'string').slice(0, 6)
    : [];

  const weekdayValue = Number(r.weekday);
  const dayValue = Number(r.dayOfMonth);

  return {
    ...emptyParse(cleanTitleWithout(raw, phrases)),
    who,
    when: safeWhen,
    repeat,
    weekday: Number.isInteger(weekdayValue) && weekdayValue >= 0 && weekdayValue <= 6 ? weekdayValue : null,
    dayOfMonth: Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 28 ? dayValue : null,
    // A question is the pure parser's business. This path never asks one: it
    // is already the uncertain road, and two uncertainties in a row is a form.
    question: null,
  };
}

function isoOfDay(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${`${d.getDate()}`.padStart(2, '0')}`;
}
