import { businessDate, type BusinessDateProperty } from '@/lib/business-date';
import { addDaysInTz } from '@/lib/schedule/local-date';

const PMS_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const OCCUPANCY_BACKFILL_LOOKBACK_DAYS = 14;

/** Late checkouts and late cleans get an hour of slack after the business day
 *  closes before we freeze its labels. */
export const SEAL_AFTER_HOUR_LOCAL = 1;

/**
 * Which day the nightly seal should close for this property right now, or null
 * when the day it would close is still open.
 *
 * "Yesterday" means the previous BUSINESS day (migration 0343), which ends at
 * the hotel's night-audit hour rather than at midnight. With
 * business_date_cutoff_hour = 0 — every property today — businessDate() is the
 * plain local calendar day and this returns exactly what the old
 * format-yesterday-in-tz code returned. A hotel on cutoff 3 at 02:15 local is
 * still inside yesterday's business day, so the day before that is what gets
 * sealed.
 *
 * The gate is "the current business day has been open at least an hour", i.e.
 * local hour >= cutoff + 1. Cutoff is capped at 6 by the DB CHECK, so there is
 * no midnight wraparound to reason about.
 */
export function sealTargetBusinessDate(
  property: BusinessDateProperty,
  now: Date = new Date(),
): string | null {
  const cutoff = typeof property.business_date_cutoff_hour === 'number'
    && Number.isFinite(property.business_date_cutoff_hour)
    && property.business_date_cutoff_hour >= 0
    && property.business_date_cutoff_hour <= 6
    ? Math.trunc(property.business_date_cutoff_hour)
    : 0;

  let localHour: number;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: property.timezone || 'UTC',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const raw = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '', 10);
    localHour = Number.isFinite(raw) ? raw % 24 : NaN;
  } catch {
    localHour = now.getUTCHours();
  }
  if (Number.isNaN(localHour) || localHour < cutoff + SEAL_AFTER_HOUR_LOCAL) return null;

  return addDaysInTz(businessDate(property, now), -1);
}

export type PmsSnapshotEvidence = {
  has_error: boolean | null;
  last_good_at: string | null;
  captured_at: string | null;
};

export type SealedOccupancyFields = {
  occupied: number | null;
  checkouts: number | null;
  stayovers: number | null;
  recommended_staff: number | null;
};

export function hasFreshPmsEvidence(
  snap: PmsSnapshotEvidence | null,
  now: Date = new Date(),
): boolean {
  if (!snap || snap.has_error === true) return false;
  const timestamp = snap.last_good_at ?? snap.captured_at;
  if (!timestamp) return false;
  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(timestampMs)) return false;
  return now.getTime() - timestampMs <= PMS_EVIDENCE_MAX_AGE_MS;
}

export function preserveSealedOccupancy(
  next: SealedOccupancyFields,
  existing: SealedOccupancyFields | null,
): SealedOccupancyFields {
  if (!existing) return next;
  return {
    occupied: next.occupied ?? existing.occupied,
    checkouts: next.checkouts ?? existing.checkouts,
    stayovers: next.stayovers ?? existing.stayovers,
    recommended_staff: next.recommended_staff ?? existing.recommended_staff,
  };
}

export function datesNeedingOccupancyBackfill(args: {
  targetDate: string;
  existing: { date: string; checkouts: number | null; stayovers: number | null }[];
  historyFloor: string | null;
  lookbackDays?: number;
}): string[] {
  const { targetDate, existing, historyFloor } = args;
  const lookback = args.lookbackDays ?? OCCUPANCY_BACKFILL_LOOKBACK_DAYS;
  if (!historyFloor) return [];
  const byDate = new Map(existing.map((row) => [row.date, row]));
  const dates: string[] = [];
  for (let back = lookback; back >= 1; back--) {
    const dateValue = new Date(`${targetDate}T12:00:00Z`);
    dateValue.setUTCDate(dateValue.getUTCDate() - back);
    const date = dateValue.toISOString().slice(0, 10);
    if (date < historyFloor) continue;
    const row = byDate.get(date);
    if (!row || row.checkouts === null || row.stayovers === null) dates.push(date);
  }
  return dates;
}

export function localDatesForProjection(tz: string): { today: string; tomorrow: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const tomorrowValue = new Date(`${today}T12:00:00Z`);
  tomorrowValue.setUTCDate(tomorrowValue.getUTCDate() + 1);
  return { today, tomorrow: tomorrowValue.toISOString().slice(0, 10) };
}
