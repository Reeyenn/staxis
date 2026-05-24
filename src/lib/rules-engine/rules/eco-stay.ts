/**
 * RULE: eco-stay-opt-in
 * Guest opted into the eco / no-daily-clean program → swap any
 * in-house clean for a visual room check (5 min). Eco overrides the
 * long-stay and short-stay cadence rules.
 */

import { BASE_DURATION_MIN } from '../constants';
import type { Rule } from '../types';

const RULE_ID = 'eco-stay-opt-in';

export const ecoStayRule: Rule = {
  id: RULE_ID,
  description:
    'Eco-stay opt-in (from notes / special requests) → visual room check only.',
  evaluate(ctx) {
    if (!ctx.staying) return null;
    if (!ctx.staying.eco_stay_opt_in) return null;
    if (ctx.departing) return null;
    const tbl = BASE_DURATION_MIN.room_check;
    return {
      id: RULE_ID,
      summary: 'Eco-stay opt-in: visual room check only',
      partial: {
        cleaning_type: 'room_check',
        estimated_minutes_base: ctx.is_suite ? tbl.suite : tbl.standard,
        priority: 'low',
        notes: ['Eco-stay opt-in: no daily clean'],
      },
    };
  },
};
