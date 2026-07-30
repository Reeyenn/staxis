/**
 * Revalidating a viewer's hotel coverage WITHOUT tearing the app down.
 *
 * ── The bug this exists to kill ──────────────────────────────────────────────
 * `useAuthorizationRefreshKey` used to fold a revision counter into the
 * authorization viewer key and bump that counter at every browser boundary —
 * window focus included. PropertyContext stamps its retained hotel list with
 * that key and masks the list to [] whenever the stamp stops matching, so every
 * single tab refocus produced: exposed hotels -> [], activeProperty -> null,
 * resolvedPropertyId -> null, loading -> true, capability snapshot dropped, the
 * staff subscription torn down, and every consumer keyed on the viewer key
 * remounted. Hotel staff click back into the tab constantly, so the operator saw
 * the page blank and refetch all day, losing scroll position and half-typed UI
 * state each time.
 *
 * ── The rule now ────────────────────────────────────────────────────────────
 * A browser boundary triggers a BACKGROUND revalidation. The snapshot already
 * on screen stays on screen while that request is in flight, and it only
 * changes when the server's answer actually differs from what is displayed.
 * An authoritative access event (a same-tab grant/revoke) is unchanged: it
 * still re-keys and masks immediately, because that is real new information.
 *
 * Security is preserved, not traded away:
 *   - the moment a revalidation comes back WITHOUT a hotel, that hotel is gone
 *     from the exposed list — no revoked property is ever kept on screen;
 *   - a revalidation that reveals NEW coverage exposes it immediately;
 *   - the server remains the only real wall. This list is a UI convenience and
 *     every route re-checks access on its own.
 *
 * ── Referential stability is the whole point ────────────────────────────────
 * "Nothing changed" has to mean "nothing re-rendered". If a revalidation that
 * returns byte-identical coverage still handed React a fresh array of fresh
 * objects, every memo would recompute and every effect keyed on the property
 * object would re-run — the same churn, just without the blank frame. So the
 * reconcilers below compare by CONTENT and hand back the PREVIOUS reference
 * when the content matches, at both the array and the individual-hotel level.
 */

import type { Property } from '@/types';

/**
 * `initial` — the viewer has no settled snapshot for this exact authorization
 * identity yet. Mask, show the spinner, surface a terminal error on failure.
 * `revalidation` — a snapshot for this exact identity is already on screen.
 * Refetch quietly behind it and only commit a real difference.
 */
export type AuthorizationLoadMode = 'initial' | 'revalidation';

/** Structural comparison for coverage payloads (plain JSON-ish DTOs plus the
 *  `Date` fields Property carries). Keys whose value is `undefined` are treated
 *  as absent, so an optional field the mapper omitted on one pass and emitted
 *  as `undefined` on the next is not a coverage change. */
export function sameAuthorizationValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date
      && b instanceof Date
      && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => sameAuthorizationValue(item, b[index]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => sameAuthorizationValue(left[key], right[key]));
}

/**
 * Merge a freshly fetched hotel list onto the one already exposed.
 *
 * NEVER narrows: the returned list always describes exactly the hotels in
 * `next`. The server resolved that coverage through the company spine and this
 * function's only job is deciding which object references may be reused.
 *
 * Returns the `previous` ARRAY REFERENCE when the coverage is unchanged, so
 * React bails out of the re-render entirely. When something did change, every
 * hotel that did not change still keeps its previous object reference.
 */
export function reconcilePropertyList(previous: Property[], next: Property[]): Property[] {
  if (previous === next) return previous;
  const held = new Map(previous.map((property) => [property.id, property]));
  let unchanged = previous.length === next.length;
  const merged = next.map((property, index) => {
    const prior = held.get(property.id);
    if (prior && sameAuthorizationValue(prior, property)) {
      // Same hotel, same data — but a reordered list is still a real change.
      if (previous[index] !== prior) unchanged = false;
      return prior;
    }
    unchanged = false;
    return property;
  });
  return unchanged ? previous : merged;
}

/**
 * Is this load re-resolving coverage the viewer already holds, or establishing
 * coverage for an identity that has none? Both stamps must match: a same-UID
 * authorization change moves the key, and an account switch moves the uid.
 */
export function resolveAuthorizationLoadMode(params: {
  stampedViewerUid: string | null;
  stampedAuthorizationKey: string | null;
  loadViewerUid: string;
  loadAuthorizationKey: string;
}): AuthorizationLoadMode {
  const settled = params.stampedViewerUid !== null
    && params.stampedAuthorizationKey !== null
    && params.stampedViewerUid === params.loadViewerUid
    && params.stampedAuthorizationKey === params.loadAuthorizationKey;
  return settled ? 'revalidation' : 'initial';
}

export interface CoverageSelection {
  /** The hotel that should be active once this load commits. */
  activePropertyId: string | null;
  /** True when the capability snapshot must be dropped, because the hotel it
   *  describes is no longer the hotel being worked in. */
  resetCapabilitySnapshot: boolean;
}

/**
 * Which hotel is active after coverage lands, and does the capability snapshot
 * survive?
 *
 * The one behaviour that matters here: on a background revalidation where the
 * operator's current hotel is STILL covered, keep it selected and keep its
 * capability snapshot. Re-deriving the selection from localStorage on every
 * refocus is what made gated pages flip back to their loading state.
 *
 * If that hotel is gone from the new coverage, this falls through to the normal
 * derivation and reports that the capability snapshot must be cleared — the
 * revoked hotel's access map must never outlive the hotel.
 */
export function resolveCoverageSelection(params: {
  mode: AuthorizationLoadMode;
  coverageIds: string[];
  activePropertyId: string | null;
  actingHotelId: string | null;
  storedPropertyId: string | null;
}): CoverageSelection {
  const { mode, coverageIds, activePropertyId, actingHotelId, storedPropertyId } = params;
  if (actingHotelId) {
    return {
      activePropertyId: actingHotelId,
      resetCapabilitySnapshot: mode === 'initial' || activePropertyId !== actingHotelId,
    };
  }
  if (
    mode === 'revalidation'
    && activePropertyId
    && coverageIds.includes(activePropertyId)
  ) {
    return { activePropertyId, resetCapabilitySnapshot: false };
  }
  const restored = storedPropertyId && coverageIds.includes(storedPropertyId)
    ? storedPropertyId
    : coverageIds[0] ?? null;
  return { activePropertyId: restored, resetCapabilitySnapshot: true };
}
