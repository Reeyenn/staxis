/**
 * RULE: long-stay-weekly-deep
 * Stays of 14+ nights get a full deep clean every 7th day of the stay
 * (day 7, 14, 21, …). Yields to the departure rule if the guest is
 * checking out today.
 */

import { BASE_DURATION_MIN, LONG_STAY_NIGHTS_THRESHOLD } from '../constants';
import type { Rule } from '../types';

const RULE_ID = 'long-stay-weekly-deep';

export const longStayWeeklyRule: Rule = {
  id: RULE_ID,
  description:
    'Long-stay guests (14+ nights) get a deep clean every 7 days of their stay.',
  evaluate(ctx) {
    if (!ctx.staying) return null;
    if (ctx.departing) return null;
    if (ctx.staying.eco_stay_opt_in) return null;
    const nights = ctx.staying.num_nights ?? 0;
    if (nights < LONG_STAY_NIGHTS_THRESHOLD) return null;
    if (ctx.staying.day_of_stay <= 0) return null;
    if (ctx.staying.day_of_stay % 7 !== 0) return null;
    const tbl = BASE_DURATION_MIN.deep;
    return {
      id: RULE_ID,
      summary: `Long stay (${nights} nights), day ${ctx.staying.day_of_stay}: weekly deep clean`,
      partial: {
        cleaning_type: 'deep',
        estimated_minutes_base: ctx.is_suite ? tbl.suite : tbl.standard,
        priority: 'normal',
      },
    };
  },
};
