const PMS_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const OCCUPANCY_BACKFILL_LOOKBACK_DAYS = 14;

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
