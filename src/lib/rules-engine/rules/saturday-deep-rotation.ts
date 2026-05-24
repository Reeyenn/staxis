/**
 * RULE: saturday-deep-rotation
 * Each in-house room gets a Saturday deep clean every 4 weeks. The
 * rotation is deterministic by (week-of-year mod 4) matching
 * (room-number mod 4) — so on any given Saturday, ~25% of in-house
 * rooms get deep-cleaned, evenly spread.
 *
 * Yields to: departure, eco-stay (handled by checking those flags
 * first), and the long-stay weekly rule (which also produces 'deep'
 * but with a different reason).
 */

import { BASE_DURATION_MIN } from '../constants';
import type { Rule } from '../types';

const RULE_ID = 'saturday-deep-rotation';
const ROTATION_WEEKS = 4;

/** Week-of-year for the given UTC instant in the given timezone.
 *  Conservative day-of-year / 7 — sufficient for a 4-week rotation. */
function propertyLocalWeekOfYear(date: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(date).map((p) => [p.type, p.value]),
    );
    const y = Number(parts.year);
    const m = Number(parts.month);
    const d = Number(parts.day);
    const start = Date.UTC(y, 0, 1);
    const cur = Date.UTC(y, m - 1, d);
    const dayOfYear = Math.floor((cur - start) / (24 * 60 * 60_000)) + 1;
    return Math.floor((dayOfYear - 1) / 7);
  } catch {
    return 0;
  }
}

export const saturdayDeepRotationRule: Rule = {
  id: RULE_ID,
  description:
    'Saturday deep-clean rotation: each in-house room gets a deep clean every 4 weeks, deterministic by room number.',
  evaluate(ctx) {
    if (ctx.property.day_of_week !== 6) return null;
    if (!ctx.staying) return null;
    if (ctx.staying.eco_stay_opt_in) return null;
    if (ctx.departing) return null;

    const digits = ctx.room_number.replace(/\D/g, '');
    if (!digits) return null;
    const roomNum = Number(digits);
    if (!Number.isFinite(roomNum)) return null;

    const week = propertyLocalWeekOfYear(ctx.property.now_utc, ctx.property.property_timezone);
    if (week % ROTATION_WEEKS !== roomNum % ROTATION_WEEKS) return null;

    const tbl = BASE_DURATION_MIN.deep;
    return {
      id: RULE_ID,
      summary: `Saturday deep-clean rotation (week ${(week % ROTATION_WEEKS) + 1}/${ROTATION_WEEKS})`,
      partial: {
        cleaning_type: 'deep',
        estimated_minutes_base: ctx.is_suite ? tbl.suite : tbl.standard,
        priority: 'normal',
      },
    };
  },
};
