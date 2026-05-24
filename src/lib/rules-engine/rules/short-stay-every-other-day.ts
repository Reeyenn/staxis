/**
 * RULE: short-stay-every-other-day
 * Short stays (<14 nights) get a light refresh clean on every even day
 * of stay (day 2, 4, 6, …). Yields to departure and eco-stay rules.
 */

import { BASE_DURATION_MIN, LONG_STAY_NIGHTS_THRESHOLD } from '../constants';
import type { Rule } from '../types';

const RULE_ID = 'short-stay-every-other-day';

export const shortStayEveryOtherDayRule: Rule = {
  id: RULE_ID,
  description:
    'Short stays (<14 nights) get a light refresh every other day (day-of-stay even).',
  evaluate(ctx) {
    if (!ctx.staying) return null;
    if (ctx.departing) return null;
    if (ctx.staying.eco_stay_opt_in) return null;
    const nights = ctx.staying.num_nights ?? 0;
    if (nights >= LONG_STAY_NIGHTS_THRESHOLD) return null;
    if (ctx.staying.day_of_stay <= 0) return null;
    if (ctx.staying.day_of_stay % 2 !== 0) return null;
    const tbl = BASE_DURATION_MIN.refresh;
    return {
      id: RULE_ID,
      summary: `Day ${ctx.staying.day_of_stay} of stay: light refresh clean`,
      partial: {
        cleaning_type: 'refresh',
        estimated_minutes_base: ctx.is_suite ? tbl.suite : tbl.standard,
        priority: 'normal',
      },
    };
  },
};
