/**
 * RULE: departure-clean
 * Fires when a guest is checking out today. Sets the base cleaning_type
 * to 'departure'. Priority/due-by are handled by modifier rules
 * (tight-turnaround, early-checkin, late-checkout).
 */

import { BASE_DURATION_MIN } from '../constants';
import type { Rule } from '../types';

const RULE_ID = 'departure-clean';

export const departureCleanRule: Rule = {
  id: RULE_ID,
  description: 'Departing guest today → create a departure clean.',
  evaluate(ctx) {
    if (!ctx.departing) return null;
    const tbl = BASE_DURATION_MIN.departure;
    const nights = ctx.departing.num_nights;
    return {
      id: RULE_ID,
      summary: nights ? `Departure (${nights}-night stay)` : 'Departure',
      partial: {
        cleaning_type: 'departure',
        estimated_minutes_base: ctx.is_suite ? tbl.suite : tbl.standard,
        priority: 'normal',
      },
    };
  },
};
