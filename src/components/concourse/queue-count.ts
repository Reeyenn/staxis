// ═══════════════════════════════════════════════════════════════════════════
// The Staxis pill's badge — what it counts, and when it exists at all.
//
// The badge counts ONE thing: "do this now" cards waiting at the active hotel
// (findings whose effective disposition is `propose`). Not FYIs, not questions,
// not recommendations. A badge that lights up for things a manager cannot act
// on is a badge they learn to ignore, and once they ignore it the one night it
// means something is the night it gets ignored too.
//
// Zero is not a state the badge renders. There is no grey "0" pill — the badge
// simply does not exist, because "nothing to decide" is the normal condition
// and normal conditions do not need decoration.
//
// The count itself comes from /api/findings/badge (service-role, hotel-scoped).
// This file holds only the pure decision, so the "zero shows nothing" rule and
// the bilingual label are testable without a browser.
// ═══════════════════════════════════════════════════════════════════════════

import { t, type Language } from '@/lib/translations';
import { canManageTeam, type AppRole } from '@/lib/roles';

/**
 * Whether a person's shell should ask /api/findings/badge at all.
 *
 * Gate at the FETCH, not the render — the rule QueueView and FindingCards
 * state for themselves, and for the same reason: a 403 in the logs must always
 * mean something real. The pill bar renders for EVERY signed-in person and the
 * badge route is manager-only (loadManagerCaller + managerManagesHotel), so a
 * housekeeper's shell was asking for the count on every mount, every tab
 * refocus and every navigation off the feed — a steady drip of refusals with
 * nothing wrong behind any of them, which is exactly how a log stops being
 * worth reading.
 *
 * `accounts.role` is the same signal FindingCards gates its own read on, so
 * the pill and the tab it points at agree about whose screen this is: nobody
 * is shown a number for a queue they would be refused. A company-scope reader
 * whose legacy role is not a manager one gets no hotel pill count — correct,
 * because the hotel queue is not their screen either (their cards arrive on
 * the portfolio queue), and the route would refuse them today regardless.
 *
 * Lives here rather than in ConcourseBar for the reason stated above: this
 * file is the badge's pure decisions, testable without a browser.
 */
export function shouldReadDecisionBadge(
  user: { role: AppRole } | null | undefined,
  propertyId: string | null,
): boolean {
  if (!user || !propertyId) return false;
  return canManageTeam(user.role);
}

// Queue-count broadcast — a live queue source may fire this after a manager
// clears cards. The pill treats it as a NUDGE, not a value: it re-reads the
// authoritative count rather than painting an unverified number, so a
// broadcaster counting something else (all cards, unread FYIs) can never turn
// the decisions badge into noise.

export const QUEUE_COUNT_EVENT = 'staxis:queue-count';

export function broadcastQueueCount(pending: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(QUEUE_COUNT_EVENT, { detail: { pending } }));
}

export interface PillBadge {
  /** The number painted on the pill. Always ≥ 1 — see below. */
  count: number;
  /** Screen-reader text, appended to the pill's own label. */
  label: string;
}

/**
 * The badge for a decisions count, or `null` when there should be no badge.
 *
 * `null` at zero — and at anything nonsensical, a negative or a NaN from a
 * malformed response — is the whole point: the caller passes this straight
 * through as the `badge` prop, so "no badge" is expressed by there being
 * nothing to render rather than by every renderer remembering to check.
 */
export function staxisPillBadge(count: number, lang: Language): PillBadge | null {
  if (!Number.isFinite(count)) return null;
  const n = Math.floor(count);
  if (n < 1) return null;
  const noun = t(n === 1 ? 'navDecisionWaitingOne' : 'navDecisionWaitingMany', lang);
  return { count: n, label: `${n} ${noun}` };
}

/**
 * The badge once "new on your list" is counted alongside decisions.
 *
 * ONE number on one pill, because there is one tab behind it. Two badges on one
 * pill is a person doing arithmetic to work out whether to click, and a second
 * pill is the lane system this whole screen refuses to have.
 *
 * The two counts do not overlap: a decision is a finding the AI raised, and a
 * new row is a to-do somebody wrote. Adding them is honest, and the label says
 * both halves out loud so the number is never a mystery.
 *
 * The DECISIONS half stays manager-only and arrives as 0 for everybody else
 * (their shell never asks for it — see shouldReadDecisionBadge). The NEW half
 * is for everybody, which is what makes the pill mean something on a front desk
 * screen for the first time.
 *
 * English only for the new half (founder ruling, 2026-07-29). The decisions
 * noun keeps its existing translated key rather than being torn out here.
 */
export function staxisPillCount(
  decisions: number,
  newOnList: number,
  lang: Language,
): PillBadge | null {
  const decided = Number.isFinite(decisions) ? Math.max(0, Math.floor(decisions)) : 0;
  const fresh = Number.isFinite(newOnList) ? Math.max(0, Math.floor(newOnList)) : 0;
  const total = decided + fresh;
  if (total < 1) return null;

  const parts: string[] = [];
  if (decided > 0) {
    parts.push(`${decided} ${t(decided === 1 ? 'navDecisionWaitingOne' : 'navDecisionWaitingMany', lang)}`);
  }
  if (fresh > 0) parts.push(fresh === 1 ? '1 new thing' : `${fresh} new things`);
  return { count: total, label: parts.join(', ') };
}
