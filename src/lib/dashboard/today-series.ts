// ════════════════════════════════════════════════════════════════════
// Staxis · Today — chart time-series.
//
// Ported from the Claude Design "Staxis Today" handoff (data.js) so the
// new dashboard's 30D / 6M / 1Y / All range toggle and the Play-through
// animation all work. This generates a deterministic ~2-year daily
// history with a realistic weekly + seasonal rhythm; the final (today)
// row is anchored to the property's live occupancy when we have it.
//
// This is the same seam as `use-month-data.ts`: revenue / ADR / RevPAR /
// profit are estimated until `pms_revenue_daily` carries real daily
// history. When it does, swap the body of `buildHistory()` to read the
// real rows — the SeriesPoint / RangeDef / MetricDef surface stays the
// same so the dashboard component never changes.
// ════════════════════════════════════════════════════════════════════

export type TodayMetricKey = 'occ' | 'revenue' | 'adr' | 'revpar' | 'profit';

export interface HistRow {
  date: Date;
  /** "Jun 16" */
  label: string;
  /** "Jun ’26" — month view label */
  my: string;
  occ: number;     // 0..100
  rooms: number;   // rooms sold
  adr: number;     // USD
  revenue: number; // USD
  revpar: number;  // USD
  profit: number;  // USD
  margin: number;  // %
}

export interface RangeDef {
  key: '30d' | '6m' | '1y' | 'all';
  label: string;
  full: string;
  days: number;
  every: number;        // bucket width in days
  mode: 'day' | 'month';
}

export const RANGES: RangeDef[] = [
  { key: '30d', label: '30D', full: 'last 30 days',   days: 30,  every: 1,  mode: 'day' },
  { key: '6m',  label: '6M',  full: 'last 6 months',  days: 182, every: 7,  mode: 'day' },
  { key: '1y',  label: '1Y',  full: 'last 12 months', days: 365, every: 14, mode: 'month' },
  { key: 'all', label: 'All', full: 'all time',       days: 730, every: 30, mode: 'month' },
];

export interface MetricDef {
  key: TodayMetricKey;
  label: string;
  fmt: 'pct' | 'money';
  color: string;
}

// The five chartable headline metrics (matches the KPI strip + ring click).
export const METRIC_DEFS: MetricDef[] = [
  { key: 'occ',     label: 'Occupancy', fmt: 'pct',   color: '#356B4C' },
  { key: 'revenue', label: 'Revenue',   fmt: 'money', color: '#B85C3D' },
  { key: 'adr',     label: 'ADR',       fmt: 'money', color: '#1F231C' },
  { key: 'revpar',  label: 'RevPAR',    fmt: 'money', color: '#8C6A33' },
  { key: 'profit',  label: 'Profit',    fmt: 'money', color: '#5C7A60' },
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_2Y = 730;

// ── formatters (ported from helpers.jsx) ─────────────────────────────
export const fmtMoney = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');
export const fmtCompact = (n: number): string =>
  n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 1 : 2) + 'k' : '$' + Math.round(n);
export const fmtPct = (n: number): string => Math.round(n) + '%';
export const fmtVal = (fmt: 'pct' | 'money' | 'num', v: number): string =>
  fmt === 'pct' ? Math.round(v) + '%'
    : fmt === 'money' ? fmtMoney(v)
      : Math.round(v).toLocaleString('en-US');

// ── catmull-rom → smooth SVG path (ported from helpers.jsx) ──────────
export function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return pts.length ? `M ${pts[0][0]},${pts[0][1]}` : '';
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// Small deterministic LCG so the generated history is stable across
// renders (no Math.random — same property always charts the same line).
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * ~2 years of daily metrics ending today, scaled to `totalRooms`.
 * When `anchorOcc` is a real, positive occupancy %, today's row is pinned
 * to it (and revenue/profit follow), so the chart's "today" matches the
 * live ring + KPI strip.
 */
export function buildHistory(totalRooms = 108, anchorOcc?: number | null): HistRow[] {
  const cap = totalRooms > 0 ? totalRooms : 108;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const r = lcg(13);
  const out: HistRow[] = [];
  for (let i = DAYS_2Y - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86400000);
    const dow = dt.getDay();
    const weekend = dow === 5 || dow === 6;
    const seasonal = Math.sin((dt.getMonth() + dt.getDate() / 30) / 12 * Math.PI * 2) * 8;
    let occ = Math.round(72 + (weekend ? 15 : 5) + seasonal + (r() * 2 - 1) * 9);
    occ = Math.max(46, Math.min(98, occ));
    const sold = Math.round((occ / 100) * cap);
    const adr = Math.round(150 + r() * 16 + (weekend ? 8 : 0) + seasonal);
    const revenue = sold * adr;
    const revpar = Math.round(revenue / cap);
    const expenses = Math.round(revenue * (0.59 + r() * 0.07));
    const profit = revenue - expenses;
    const margin = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;
    out.push({
      date: dt,
      label: MON[dt.getMonth()] + ' ' + dt.getDate(),
      my: MON[dt.getMonth()] + ' ’' + String(dt.getFullYear()).slice(2),
      occ, rooms: sold, adr, revenue, revpar, profit, margin,
    });
  }
  // Anchor today to the live occupancy when we have it.
  if (anchorOcc != null && anchorOcc > 0) {
    const last = out[DAYS_2Y - 1];
    const occ = Math.max(1, Math.min(100, Math.round(anchorOcc)));
    const sold = Math.round((occ / 100) * cap);
    const revenue = sold * last.adr;
    const revpar = Math.round(revenue / cap);
    const profit = Math.round(revenue * 0.37);
    const margin = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;
    out[DAYS_2Y - 1] = { ...last, occ, rooms: sold, revenue, revpar, profit, margin };
  }
  return out;
}

export interface SeriesPoint {
  /** x-axis label */
  d: string;
  /** value for the active metric */
  v: number;
  /** every headline field at this point (KPIs follow the playhead/hover) */
  row: Record<TodayMetricKey, number>;
  today: boolean;
}

const FIELDS: TodayMetricKey[] = ['occ', 'revenue', 'adr', 'revpar', 'profit'];

/**
 * Bucket the daily history into chart points for a given range + metric.
 * Buckets average each field over `range.every` days (so 6M/1Y/All read
 * as weekly/biweekly/monthly points, 30D as raw days).
 */
export function seriesFor(history: HistRow[], range: RangeDef, metric: TodayMetricKey): SeriesPoint[] {
  const slice = history.slice(-range.days);
  const out: SeriesPoint[] = [];
  for (let end = slice.length; end > 0; end -= range.every) {
    const bucket = slice.slice(Math.max(0, end - range.every), end);
    if (!bucket.length) continue;
    const row = {} as Record<TodayMetricKey, number>;
    FIELDS.forEach(f => { row[f] = bucket.reduce((a, dd) => a + dd[f], 0) / bucket.length; });
    const lastB = bucket[bucket.length - 1];
    out.unshift({
      d: range.mode === 'month' ? lastB.my : lastB.label,
      v: row[metric],
      row,
      today: end === slice.length,
    });
  }
  return out;
}
