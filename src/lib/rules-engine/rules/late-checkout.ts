/**
 * RULE: late-checkout
 * Approved late checkout → surface the time as a note on the task so
 * the housekeeper knows when the room actually frees up. The
 * tight-turnaround rule reads `ctx.departing.late_checkout_until`
 * directly to fold the late checkout into its gap calculation, so
 * this rule deliberately does NOT touch due_by — that would make the
 * merger's "earliest due_by wins" semantics misleading.
 */

import type { Rule } from '../types';

const RULE_ID = 'late-checkout';

export const lateCheckoutRule: Rule = {
  id: RULE_ID,
  description:
    'Approved late checkout → annotate the task with the late checkout time.',
  evaluate(ctx) {
    if (!ctx.departing?.late_checkout_approved) return null;
    if (!ctx.departing.late_checkout_until) return null;
    return {
      id: RULE_ID,
      summary: `Late checkout approved until ${ctx.departing.late_checkout_until}`,
      partial: {
        notes: [`Late checkout until ${ctx.departing.late_checkout_until}`],
      },
    };
  },
};
