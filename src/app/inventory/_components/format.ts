// Formatting helpers used across the inventory rebuild.

export function fmtMoney(v: number, opts: { c?: boolean; digits?: number } = {}): string {
  if (!Number.isFinite(v)) return opts.c === false ? '0' : '$0';
  const { c = true } = opts;
  const digits = opts.digits ?? (Math.abs(v) >= 100 ? 0 : 2);
  const n = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // Minus sign uses unicode minus (−) to match the design.
  return `${v < 0 ? '−' : ''}${c ? '$' : ''}${n}`;
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('en-US');
}

// Plain-language days-left caption used on item rows.
// daysLeft >= 90 → "plenty left"; else "out in N day(s)".
export function daysOutLabel(daysLeft: number): string {
  if (!Number.isFinite(daysLeft)) return 'unknown';
  if (daysLeft >= 90) return 'plenty left';
  const d = Math.max(0, Math.round(daysLeft));
  return `out in ${d} day${d === 1 ? '' : 's'}`;
}

// Stock status from estimated/par ratio — matches inv-page.jsx thresholds.
export function ratioStatus(estimated: number, par: number): 'good' | 'low' | 'critical' {
  if (par <= 0) return 'good';
  const r = estimated / par;
  if (r < 0.5) return 'critical';
  if (r < 1.0) return 'low';
  return 'good';
}

// Short "May 12" date string.
export function shortMonthDay(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Days between two timestamps, floored to integer.
export function daysSince(date: Date | null | undefined): number {
  if (!date) return 0;
  const ms = Date.now() - date.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// "{value}{unit}" with a thin space — used on item rows for "{stock} {unit}".
export function withUnit(value: number, unit: string): string {
  return `${fmtInt(value)} ${unit}`;
}
