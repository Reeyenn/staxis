/**
 * RULE: early-checkin-boost-priority
 * Either the guest explicitly requested early check-in OR the front
 * desk has approved one → boost the cleaning task's priority to HIGH
 * so the room is ready before the standard 3pm check-in.
 *
 * The tight-turnaround rule may set HIGH as well; both rules
 * contribute and the merger keeps the strongest.
 */

import type { Rule } from '../types';

const RULE_ID = 'early-checkin-boost-priority';

export const earlyCheckinRule: Rule = {
  id: RULE_ID,
  description:
    'Early-check-in request or approval → priority HIGH so the room is ready before 3pm.',
  evaluate(ctx) {
    if (!ctx.arriving) return null;
    const requested =
      ctx.arriving.has_early_checkin_request || ctx.arriving.early_checkin_approved;
    if (!requested) return null;
    const noteText = ctx.arriving.early_checkin_approved
      ? ctx.arriving.early_checkin_from
        ? `Early check-in approved from ${ctx.arriving.early_checkin_from}`
        : 'Early check-in approved'
      : 'Early check-in requested';
    return {
      id: RULE_ID,
      summary: noteText,
      partial: {
        priority: 'high',
        notes: [noteText],
      },
    };
  },
};
