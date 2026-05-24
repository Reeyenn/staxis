/**
 * RULE: tight-turnaround
 * The next arriving guest's ETA is within 3 hours of when the room
 * is realistically ready (max of standard checkout, late checkout,
 * and actual checkout) → priority HIGH, due_by set 15 min before
 * the arrival ETA so front desk isn't waiting at check-in.
 */

import {
  TIGHT_TURNAROUND_DUE_BUFFER_MIN,
  TIGHT_TURNAROUND_THRESHOLD_MIN,
} from '../constants';
import { diffMinutes, localDateTimeToUtc, minusMinutes } from '../time-utils';
import type { Rule } from '../types';

const RULE_ID = 'tight-turnaround';

export const tightTurnaroundRule: Rule = {
  id: RULE_ID,
  description:
    'Gap between earliest room-ready time and next arrival ETA ≤ 3 hours → priority HIGH + due_by 15 min before arrival.',
  evaluate(ctx) {
    if (!ctx.arriving) return null;
    if (!ctx.arriving.arrival_time) return null;

    const tz = ctx.property.property_timezone;
    const dateStr = ctx.property.business_date;

    // earliest_ready = max(standard_checkout, late_checkout_until, actual_checkout_at)
    let earliestReady = localDateTimeToUtc(
      dateStr,
      ctx.property.standard_checkout_time,
      tz,
    );
    if (ctx.departing?.late_checkout_approved && ctx.departing.late_checkout_until) {
      const lc = localDateTimeToUtc(dateStr, ctx.departing.late_checkout_until, tz);
      if (lc && (!earliestReady || lc.getTime() > earliestReady.getTime())) {
        earliestReady = lc;
      }
    }
    if (ctx.departing?.actual_checkout_at) {
      const ac = new Date(ctx.departing.actual_checkout_at);
      if (
        !Number.isNaN(ac.getTime()) &&
        (!earliestReady || ac.getTime() > earliestReady.getTime())
      ) {
        earliestReady = ac;
      }
    }
    if (!earliestReady) return null;

    const arrivalUtc = localDateTimeToUtc(dateStr, ctx.arriving.arrival_time, tz);
    if (!arrivalUtc) return null;

    const gapMin = diffMinutes(earliestReady, arrivalUtc);
    if (gapMin <= 0) return null;
    if (gapMin > TIGHT_TURNAROUND_THRESHOLD_MIN) return null;

    const dueBy = minusMinutes(arrivalUtc, TIGHT_TURNAROUND_DUE_BUFFER_MIN);
    return {
      id: RULE_ID,
      summary: `Tight turnaround: arrival ${ctx.arriving.arrival_time}, ${Math.round(gapMin)} min after room ready`,
      partial: {
        priority: 'high',
        due_by: dueBy,
        notes: [`Tight turnaround — arrival ${ctx.arriving.arrival_time}`],
      },
    };
  },
};
