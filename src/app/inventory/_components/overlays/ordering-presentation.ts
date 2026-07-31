// Pure presentation rules for the Ordering panel. No React, no fetch — the
// same pattern as inventory-audit-presentation.ts, so the judgement calls a
// manager actually sees (which numbers appear, and how rounded) are unit-
// testable without rendering the component.
//
// THE ROUNDING RULE IS A PRODUCT RULING (founder, 2026-07-31): the panel had
// been showing "about 207.2 a week" and "about 777 a week" — machine
// precision dressed as speech. A manager says "about five hundred a week";
// the screen now speaks the same way. Rounding is presentation only: every
// underlying figure (order quantities, prices, totals) stays exact.

/**
 * A weekly usage figure a human would actually say, or null when the honest
 * move is to show nothing.
 *
 *   • null / non-finite / non-positive rate → null (the caveat sentence in
 *     the details is the only thing allowed to speak for a missing rate)
 *   • under 1 a week → null; "about 0 a week" reads as a glitch, and the
 *     days-left line carries the story better for slow movers
 *   • under 10 → nearest whole ("about 6 a week")
 *   • under 100 → nearest 5 ("about 75 a week")
 *   • 100 and up → nearest 10 ("about 520 a week", never 518 or 207.2)
 */
export function approxWeekly(burnPerDay: number | null): string | null {
  if (burnPerDay == null || !Number.isFinite(burnPerDay) || burnPerDay <= 0) return null;
  const weekly = burnPerDay * 7;
  if (weekly < 1) return null;
  if (weekly < 10) return String(Math.round(weekly));
  if (weekly < 100) return String(Math.round(weekly / 5) * 5);
  return String(Math.round(weekly / 10) * 10);
}

/** The one context line a collapsed row is allowed to carry, and only when it
 *  earns its place: the item is measurably close to running out.
 *
 *   • no trusted days-left → null (silence, not a caveat — the caveat lives
 *     behind the tap, and the group footer already owns the general story)
 *   • more than 14 days away → null; "about 40 days left" is noise on a
 *     screen about what to do now
 *   • under a day → 'today'
 *   • otherwise → whole days
 */
export type DaysLeftCue = { kind: 'today' } | { kind: 'days'; days: number } | null;

export function daysLeftCue(daysLeft: number | null): DaysLeftCue {
  if (daysLeft == null || !Number.isFinite(daysLeft) || daysLeft < 0) return null;
  if (daysLeft < 1) return { kind: 'today' };
  const days = Math.round(daysLeft);
  if (days > 14) return null;
  return { kind: 'days', days: Math.max(1, days) };
}

/** Fill ratio for the little level gauge, clamped to [0, 1]. */
export function levelRatio(onHand: number, par: number): number {
  if (!(par > 0) || !Number.isFinite(onHand)) return 0;
  return Math.max(0, Math.min(1, onHand / par));
}
