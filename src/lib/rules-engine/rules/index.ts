/**
 * Rule registry. The order here ONLY affects which rule shows up
 * first in `rules_fired` — semantic precedence is handled by the
 * merger (highest-rank cleaning_type wins, strongest priority wins,
 * etc.) so add new rules wherever they read most naturally.
 *
 * To add a new rule:
 *   1. Drop a new file in this directory exporting a `Rule`.
 *   2. Add it to the array below.
 *   3. Write a unit test in src/lib/__tests__/rules-engine-rules.test.ts
 *      that proves it fires when its condition holds AND that it
 *      stays silent when the condition doesn't.
 *
 * Each rule's `evaluate(ctx)` is a pure function — no DB, no I/O.
 * That's what makes the engine testable.
 */

import type { Rule, RoomContext, RuleFireResult } from '../types';

import { departureCleanRule } from './departure-clean';
import { earlyCheckinRule } from './early-checkin';
import { ecoStayRule } from './eco-stay';
import { honeymoonAnniversaryRule } from './honeymoon-anniversary';
import { lateCheckoutRule } from './late-checkout';
import { longStayWeeklyRule } from './long-stay-weekly';
import { petStayRule } from './pet-stay';
import { saturdayDeepRotationRule } from './saturday-deep-rotation';
import { shortStayEveryOtherDayRule } from './short-stay-every-other-day';
import { tightTurnaroundRule } from './tight-turnaround';
import { vipArrivalRule } from './vip-arrival';

export const ALL_RULES: ReadonlyArray<Rule> = [
  departureCleanRule,
  longStayWeeklyRule,
  shortStayEveryOtherDayRule,
  ecoStayRule,
  saturdayDeepRotationRule,
  vipArrivalRule,
  petStayRule,
  lateCheckoutRule,
  earlyCheckinRule,
  honeymoonAnniversaryRule,
  tightTurnaroundRule,
];

/** Run every rule against the room context, return the firing results. */
export function evaluateRoomRules(
  ctx: RoomContext,
  rules: ReadonlyArray<Rule> = ALL_RULES,
): RuleFireResult[] {
  const fired: RuleFireResult[] = [];
  for (const r of rules) {
    const result = r.evaluate(ctx);
    if (result) fired.push(result);
  }
  return fired;
}
