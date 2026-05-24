/**
 * RULE: vip-arrival
 * VIP guest arriving today → require supervisor inspection, place
 * fruit basket, and (when the room would otherwise have no task)
 * leave a low-priority inspection_only task so the room is checked
 * before the VIP arrives.
 *
 * When a departure rule also fires for the same room, the merger
 * keeps cleaning_type='departure' (higher rank) and absorbs the VIP
 * extras + inspection requirement on top.
 */

import { BASE_DURATION_MIN } from '../constants';
import type { TaskExtra } from '@/types/cleaning-tasks';
import type { Rule } from '../types';

const RULE_ID = 'vip-arrival';

export const vipArrivalRule: Rule = {
  id: RULE_ID,
  description:
    'VIP guest arriving today → supervisor inspection + amenity setup (fruit basket).',
  evaluate(ctx) {
    if (!ctx.arriving?.is_vip) return null;
    const tier = ctx.arriving.loyalty_tier;
    const language = ctx.arriving.language;

    const noteParts: string[] = [];
    noteParts.push(tier ? `VIP ${tier}` : 'VIP');
    if (language) noteParts.push(language);

    const extras: TaskExtra[] = ['fruit_basket', 'amenity_setup'];
    const tbl = BASE_DURATION_MIN.inspection_only;

    return {
      id: RULE_ID,
      summary: tier
        ? `VIP ${tier} arrival — supervisor inspection + amenity setup`
        : 'VIP arrival — supervisor inspection + amenity setup',
      partial: {
        cleaning_type: 'inspection_only',
        estimated_minutes_base: ctx.is_suite ? tbl.suite : tbl.standard,
        requires_inspection: true,
        extras,
        notes: [noteParts.join(', ')],
      },
    };
  },
};
