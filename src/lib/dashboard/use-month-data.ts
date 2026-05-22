// Mock 30-day owner-dashboard time series.
//
// This module is the single seam where the Aurora x Spotlight dashboard
// gets its monthly metrics. Today it returns a deterministic synthetic
// month so the visual works without any backend dependency. Once
// `daily_logs` carries `revenue_total`, `adr`, `revpar`, and `profit`
// columns, swap the body of `useMonthData()` to read from
// `getRecentDailyLogs()` — the surface (DayRow / MetricKey / METRICS)
// stays the same, so the dashboard component never needs to change.

import { useMemo } from 'react';

export type MetricKey = 'Occupancy' | 'Revenue' | 'ADR' | 'RevPAR' | 'Profit';

export interface DayRow {
  /** 1-based day-of-month for the underlying calendar date */
  day: number;
  date: Date;
  /** 0=Sun .. 6=Sat */
  dow: number;
  /** 0..100 */
  occ: number;
  /** USD */
  adr: number;
  /** rooms rented this day */
  rooms: number;
  /** USD */
  revenue: number;
  /** USD */
  profit: number;
  /** USD */
  revpar: number;
  isToday: boolean;
  isFuture: boolean;
}

export const METRICS: Record<MetricKey, {
  key: keyof Pick<DayRow, 'occ' | 'revenue' | 'adr' | 'revpar' | 'profit'>;
  format: (v: number) => string;
}> = {
  Occupancy: { key: 'occ',     format: (v: number) => `${v}%` },
  Revenue:   { key: 'revenue', format: (v: number) => `$${(v / 1000).toFixed(1)}k` },
  ADR:       { key: 'adr',     format: (v: number) => `$${v}` },
  RevPAR:    { key: 'revpar',  format: (v: number) => `$${v}` },
  Profit:    { key: 'profit',  format: (v: number) => `$${(v / 1000).toFixed(1)}k` },
};

// Build a 30-day window ending on `anchor`. Day shapes vary with day-of-
// week so the chart line has the rhythm a real hotel has (weekend peaks,
// Monday trough). Deterministic — same input always returns the same
// month, so the visual is stable across renders.
function buildMonth(anchor: Date, totalRooms: number): DayRow[] {
  const rows: DayRow[] = [];
  const todayKey = `${anchor.getFullYear()}-${anchor.getMonth()}-${anchor.getDate()}`;
  for (let i = 0; i < 30; i++) {
    const date = new Date(anchor);
    // Days 0..28 are past/today, day 29 is one future day. We keep 9 days
    // of forecast to the right of "today" so the dashed forecast line and
    // forecast badge have somewhere to live.
    date.setDate(anchor.getDate() - (20 - i));
    const dow = date.getDay();

    // Weekly rhythm
    let base = 76;
    if (dow === 6) base = 91;        // Saturday peak
    else if (dow === 0) base = 88;   // Sunday strong
    else if (dow === 5) base = 84;   // Friday strong
    else if (dow === 1) base = 70;   // Monday trough
    else base = 76 + (i % 3);

    const occ = Math.max(45, Math.min(98, base + ((i * 7) % 11) - 5));
    const adr = 138 + (occ - 70);
    const rooms = Math.round((occ / 100) * totalRooms);
    const revenue = adr * rooms;
    const profit = Math.round(revenue * 0.37);
    const revpar = totalRooms > 0 ? Math.round(revenue / totalRooms) : 0;

    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const isToday = dayKey === todayKey;
    const isFuture = date.getTime() > anchor.getTime();

    rows.push({
      day: date.getDate(),
      date,
      dow,
      occ,
      adr,
      rooms,
      revenue,
      profit,
      revpar,
      isToday,
      isFuture,
    });
  }
  return rows;
}

/**
 * Returns a 30-day window of synthetic owner metrics, with day index 20
 * being "today" (so there are 20 past days and 9 forecast days on
 * either side). Replace the body with a real `daily_logs` read when
 * revenue / ADR / RevPAR / profit start being tracked daily.
 *
 * @param totalRooms — property's sellable room count. Used to scale
 *   revenue / RevPAR realistically. Defaults to 108 (Comfort Suites
 *   Beaumont) when not provided.
 */
export function useMonthData(totalRooms = 108): {
  days: DayRow[];
  /** Index of the "today" row in `days` */
  todayIdx: number;
} {
  return useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = buildMonth(today, totalRooms);
    const todayIdx = days.findIndex(d => d.isToday);
    return { days, todayIdx: todayIdx >= 0 ? todayIdx : 20 };
  }, [totalRooms]);
}
