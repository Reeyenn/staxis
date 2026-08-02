// ═══════════════════════════════════════════════════════════════════════════
// Detector: one person's callouts land on the same weekday.
//
// ─── THIS ONE IS ABOUT A PERSON, SO IT PLAYS BY DIFFERENT RULES ───────────
//
// Every pattern here carries `sensitivity: 'people'`, and that single field is
// the whole shoulder-safety argument. `decideCompanionSpeech` skips non
// operational candidates outright, so nothing this detector produces can ever
// become a peek, a line on a screen, or an unprompted sentence in the corner
// of a room where a housekeeper is standing. It can only be said inside the
// panel, after the person opened the panel themselves (`decidePanelAsk`).
//
// It also has `page: null` and no anchors. There is nothing to draw and
// nowhere to draw it: the attendance screen is not on the companion's
// navigation allowlist, and a hairline pointing at somebody's name is the last
// thing this product should learn how to render.
//
// AND IT NEVER SAYS WHY. Three Wednesdays is a fact. What it means is a
// conversation between two people, and Staxis is not in it. The card says the
// dates and stops, which is also why it carries no buttons: there is no action
// in this product whose subject is a person's reliability, and there should not
// be one.
//
// ─── A NOTE ON THE FEED IT READS ───────────────────────────────────────────
// `callout_events` has no live writer today: the SMS coverage flow it belonged
// to was retired with the rest of Twilio in July 2026. The table, its history
// and its indexes all survive. So this detector is correct, tested, and will
// find exactly nothing at a hotel with no rows, which is the right behaviour
// and is not a bug to go and fix.
//
// PURE. Rows in, patterns out.
// ═══════════════════════════════════════════════════════════════════════════

import { plural } from '@/lib/findings/pricing';
import { tracePatternKey } from '../identity';
import type { TraceFact, TracePattern } from '../types';

export const DETECTOR_ID = 'callout_weekday';

/** Three on one weekday. Two is a coincidence and everybody knows it. */
export const MIN_CALLOUTS = 3;

/** How far back to look. Longer than this stops being about now. */
export const WINDOW_WEEKS = 10;

/** One row of `callout_events`, as this detector needs it. */
export interface TraceCallout {
  readonly id: string;
  readonly staffId: string;
  /** Resolved from `staff.name`. Never rendered outside the opened panel. */
  readonly staffName: string;
  /**
   * `callout_events.business_date`, YYYY-MM-DD.
   *
   * The hotel's operating day, NOT `reported_at`. A 5:40am call about that
   * day's shift is timestamped on that day's business date whatever the clock
   * and the timezone are doing, which is the only way a weekday count means
   * anything.
   */
  readonly businessDate: string;
}

export interface CalloutWeekdayInput {
  readonly now: Date;
  readonly callouts: readonly TraceCallout[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Which weekday a YYYY-MM-DD business date falls on.
 *
 * Parsed as UTC deliberately. A business date is a calendar label the hotel
 * assigned, not an instant, and letting the server's zone shift it by a day
 * would move a Wednesday callout onto Tuesday for anybody east of the office.
 */
export function weekdayOf(businessDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return null;
  const at = Date.parse(`${businessDate}T00:00:00Z`);
  if (!Number.isFinite(at)) return null;
  return new Date(at).getUTCDay();
}

/** "25 Jun" off a business date, without a timezone anywhere near it. */
export function businessDay(businessDate: string): string {
  const at = new Date(`${businessDate}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return businessDate;
  return `${at.getUTCDate()} ${at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function detectCalloutWeekday(input: CalloutWeekdayInput): TracePattern[] {
  const cutoff = input.now.getTime() - WINDOW_WEEKS * 7 * DAY_MS;
  const buckets = new Map<string, { name: string; staffId: string; weekday: number; dates: string[] }>();

  for (const c of input.callouts) {
    const weekday = weekdayOf(c.businessDate);
    if (weekday === null) continue;
    const at = Date.parse(`${c.businessDate}T00:00:00Z`);
    if (at < cutoff || at > input.now.getTime()) continue;
    const id = `${c.staffId}|${weekday}`;
    const bucket = buckets.get(id);
    if (bucket) {
      bucket.dates.push(c.businessDate);
      continue;
    }
    buckets.set(id, { name: c.staffName, staffId: c.staffId, weekday, dates: [c.businessDate] });
  }

  // How many callouts this person had in total, so the card can say whether the
  // weekday is the whole story or just where most of them landed. A person who
  // called out nine times including three Wednesdays does not have a Wednesday
  // pattern, and saying so is the difference between a fact and an accusation.
  const totals = new Map<string, number>();
  for (const c of input.callouts) {
    const at = Date.parse(`${c.businessDate}T00:00:00Z`);
    if (!Number.isFinite(at) || at < cutoff || at > input.now.getTime()) continue;
    totals.set(c.staffId, (totals.get(c.staffId) ?? 0) + 1);
  }

  const out: TracePattern[] = [];
  for (const bucket of buckets.values()) {
    const dates = Array.from(new Set(bucket.dates)).sort();
    if (dates.length < MIN_CALLOUTS) continue;
    const total = totals.get(bucket.staffId) ?? dates.length;
    // Most of them, not merely several of them.
    if (dates.length * 2 <= total) continue;

    const day = DAY_NAMES[bucket.weekday];
    const facts: TraceFact[] = dates.map((d) => ({
      k: businessDay(d),
      v: `${day}. Called out.`,
    }));
    const others = total - dates.length;

    out.push({
      key: tracePatternKey(DETECTOR_ID, [bucket.staffId, String(bucket.weekday)]),
      detectorId: DETECTOR_ID,
      page: null,
      ask: `There is a pattern in one person's callouts, and it lands on the same weekday. `
        + 'Mind if I show you?',
      kicker: `${plural(dates.length, day)} in ${WINDOW_WEEKS} weeks`,
      body: `${bucket.name} has called out on a ${day} ${plural(dates.length, 'time')} in the last `
        + `${WINDOW_WEEKS} weeks`
        + `${others === 0 ? ', and on no other day' : `, plus ${plural(others, 'other callout')}`}. `
        + 'That is the whole of what I know.',
      facts,
      cost: null,
      basis: `${plural(dates.length, 'callout')} recorded against this person on a ${day}, by the `
        + 'hotel\'s own business date.',
      anchors: [],
      actions: [],
      // The field that keeps this out of every unprompted surface in the app.
      sensitivity: 'people',
      severity: 'watch',
      covers: [],
      magnitude: dates.length,
    });
  }

  return out.sort((a, b) => b.magnitude - a.magnitude);
}
