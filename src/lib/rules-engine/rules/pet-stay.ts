/**
 * RULE: pet-stay
 * Pet detected on the departing, arriving, or in-house reservation →
 * add +10 minutes, the pet-clean checklist tag, and (on arrival) a
 * pet welcome kit.
 */

import { PET_STAY_DURATION_MIN } from '../constants';
import type { TaskExtra } from '@/types/cleaning-tasks';
import type { Rule } from '../types';

const RULE_ID = 'pet-stay';

export const petStayRule: Rule = {
  id: RULE_ID,
  description:
    'Pet detected on the reservation → +10 min, pet-clean checklist tag, pet-kit on arrival.',
  evaluate(ctx) {
    const hasPet =
      ctx.departing?.has_pet || ctx.arriving?.has_pet || ctx.staying?.has_pet;
    if (!hasPet) return null;
    const extras: TaskExtra[] = ['pet_clean_checklist'];
    if (ctx.arriving?.has_pet) extras.push('pet_kit');
    return {
      id: RULE_ID,
      summary: 'Pet stay — +10 min, pet-clean checklist',
      partial: {
        estimated_minutes_delta: PET_STAY_DURATION_MIN,
        extras,
        notes: ['Pet in room'],
      },
    };
  },
};
