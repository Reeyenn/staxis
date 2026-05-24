/**
 * RULE: honeymoon-anniversary
 * Honeymoon or anniversary detected on an arriving reservation →
 * place a welcome amenity. Detection happens upstream in
 * detection.ts and feeds the has_honeymoon / has_anniversary flags
 * on ArrivingReservation.
 */

import type { TaskExtra } from '@/types/cleaning-tasks';
import type { Rule } from '../types';

const RULE_ID = 'honeymoon-anniversary';

export const honeymoonAnniversaryRule: Rule = {
  id: RULE_ID,
  description:
    'Honeymoon or anniversary on incoming reservation → place welcome amenity.',
  evaluate(ctx) {
    if (!ctx.arriving) return null;
    const isHoneymoon = ctx.arriving.has_honeymoon;
    const isAnniversary = ctx.arriving.has_anniversary;
    if (!isHoneymoon && !isAnniversary) return null;

    const extras: TaskExtra[] = ['welcome_amenity'];
    let occasion = 'Celebration';
    if (isHoneymoon) {
      extras.push('honeymoon_amenity');
      occasion = 'Honeymoon';
    } else if (isAnniversary) {
      extras.push('anniversary_amenity');
      occasion = 'Anniversary';
    }
    return {
      id: RULE_ID,
      summary: `${occasion} stay — place welcome amenity`,
      partial: {
        extras,
        notes: [`${occasion} stay`],
      },
    };
  },
};
