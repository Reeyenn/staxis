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
