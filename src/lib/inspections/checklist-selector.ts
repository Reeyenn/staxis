/**
 * Pick the right checklist for an inspection.
 *
 * Selection precedence (most specific wins):
 *   1. Property-scoped + cleaning type + room type all match
 *   2. Property-scoped + cleaning type matches (any room type)
 *   3. Property-scoped + room type matches (any cleaning type)
 *   4. Property-scoped, no filters (catch-all for this property)
 *   5. Global (propertyId=null) + cleaning type + room type all match
 *   6. Global + cleaning type matches
 *   7. Global + room type matches
 *   8. Global catch-all
 *
 * Within a tier, the most recently updated checklist wins (it's already
 * sorted by `name` from the DB, but ties favor the newest by `updatedAt`).
 *
 * Pure function — takes the candidates already loaded from the DB and
 * picks one. Easy to test without a database.
 */

import type { InspectionChecklist } from '@/types/inspections';

export interface SelectChecklistArgs {
  candidates: InspectionChecklist[];
  cleaningType: string | null;
  roomType: string | null;
  propertyId: string;
}

export function selectChecklist(args: SelectChecklistArgs): InspectionChecklist | null {
  const { candidates, cleaningType, roomType, propertyId } = args;

  // Active only — defensive (callers already filter, but enforce here too).
  const active = candidates.filter((c) => c.isActive);
  if (active.length === 0) return null;

  const cleaningMatch = (c: InspectionChecklist) =>
    cleaningType !== null &&
    c.appliesToCleaningTypes.length > 0 &&
    c.appliesToCleaningTypes.includes(cleaningType);
  const roomMatch = (c: InspectionChecklist) =>
    roomType !== null &&
    c.appliesToRoomTypes.length > 0 &&
    c.appliesToRoomTypes.includes(roomType);

  // Score: higher is more specific. Property-scoped beats global by 100.
  // Both filters match adds 30; cleaning-type-only adds 20; room-type-only
  // adds 10; no filters adds 1 (still ranks above empty score).
  const score = (c: InspectionChecklist): number => {
    let s = 0;
    if (c.propertyId === propertyId) s += 100;
    const ct = cleaningMatch(c);
    const rt = roomMatch(c);
    if (ct && rt) s += 30;
    else if (ct) s += 20;
    else if (rt) s += 10;
    else if (c.appliesToCleaningTypes.length === 0 && c.appliesToRoomTypes.length === 0) s += 1;
    return s;
  };

  // Eliminate clearly inapplicable candidates: any checklist that requires
  // a specific cleaning type and the caller's cleaning type doesn't match.
  // (A checklist with appliesToCleaningTypes=[] is a catch-all and stays.)
  const eligible = active.filter((c) => {
    if (
      cleaningType !== null &&
      c.appliesToCleaningTypes.length > 0 &&
      !c.appliesToCleaningTypes.includes(cleaningType)
    ) return false;
    if (
      roomType !== null &&
      c.appliesToRoomTypes.length > 0 &&
      !c.appliesToRoomTypes.includes(roomType)
    ) return false;
    return true;
  });

  if (eligible.length === 0) {
    // Last resort — fall back to any active checklist for the property,
    // then any global catch-all. Don't return null unless there's literally
    // nothing.
    const fallback = active.find((c) => c.propertyId === propertyId)
      ?? active.find((c) => c.propertyId === null);
    return fallback ?? null;
  }

  let best: InspectionChecklist | null = null;
  let bestScore = -1;
  let bestUpdated = '';
  for (const c of eligible) {
    const s = score(c);
    if (
      s > bestScore ||
      (s === bestScore && c.updatedAt > bestUpdated)
    ) {
      best = c;
      bestScore = s;
      bestUpdated = c.updatedAt;
    }
  }
  return best;
}
