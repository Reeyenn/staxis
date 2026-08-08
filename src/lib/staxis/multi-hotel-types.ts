import type { AssignedByMeItem } from '@/lib/worklist/types';
import type { KnowsItem } from '@/lib/knows/page-model';
import type { LogEntryDTO, LogReplyDTO } from '@/lib/comms/types';

/**
 * Client-safe contracts for the read-only multi-hotel Staxis surfaces.
 *
 * `propertyId` is deliberately carried on every row. It is the exact hotel
 * token used when a reader narrows back to the existing hotel routes; the
 * display label is never used as authority.
 */
export interface MultiHotelLabel {
  propertyId: string;
  hotelName: string;
  timezone: string | null;
}

export interface MultiHotelLogEntry extends LogEntryDTO, MultiHotelLabel {
  /** False when the per-entry reply read hit its bounded cap. */
  replyCountComplete: boolean;
}

export interface MultiHotelAssignedItem extends AssignedByMeItem, MultiHotelLabel {}

export interface MultiHotelKnowsItem extends KnowsItem, MultiHotelLabel {}

export type MultiHotelSurface = 'logbook' | 'assigned-by-me' | 'knows';

export interface MultiHotelUnavailable {
  propertyId: string;
  hotelName: string;
  reason: 'read_failed' | 'identity_unavailable' | 'scope_changed' | 'hotel_missing';
}

export interface MultiHotelCoverage {
  authorizedHotelCount: number;
  attemptedHotelCount: number;
  processedHotelCount: number;
  omittedHotelCount: number;
  unavailableHotelCount: number;
  unavailable: MultiHotelUnavailable[];
  /** Global row/byte budgets keep large portfolios bounded and explicit. */
  rowBudget: number;
  /** A lower bound when a source window or response budget hid more rows. */
  rowsReturned: number;
  rowsOmitted: number;
  responseByteBudget: number;
  responseBytesEstimated: number;
  truncated: boolean;
  complete: boolean;
}

export interface MultiHotelPayload {
  surface: MultiHotelSurface;
  hotels: MultiHotelLabel[];
  coverage: MultiHotelCoverage;
  entries?: MultiHotelLogEntry[];
  assigned?: MultiHotelAssignedItem[];
  items?: MultiHotelKnowsItem[];
  replies?: LogReplyDTO[];
  /** True only for a complete current read. Never use empty arrays as status. */
  ready: boolean;
}

/** A partial aggregate may render rows, but it may never claim whole-scope empty. */
export function canClaimMultiHotelEmpty(coverage: Pick<MultiHotelCoverage, 'complete'>): boolean {
  return coverage.complete;
}

/** Keep hotel filtering on the opaque property id, never the display label. */
export function filterMultiHotelRows<T extends MultiHotelLabel>(
  rows: readonly T[],
  propertyId: string | 'all',
): T[] {
  return propertyId === 'all'
    ? [...rows]
    : rows.filter((row) => row.propertyId === propertyId);
}

/** Format a row using the hotel's wall clock, with a safe local fallback. */
export function formatMultiHotelDate(
  value: string | null | undefined,
  timezone: string | null | undefined,
  locale?: string,
): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: timezone ?? undefined,
    }).format(parsed);
  } catch {
    return parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
}
