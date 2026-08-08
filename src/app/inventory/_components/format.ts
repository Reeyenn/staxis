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

// Stock status from the estimated/par ratio.
//
// The house 70/30 rule, shared with every other status surface in the app
// (src/lib/stock-status.ts): good at 70% of par or more, low from 30% up to
// 70%, critical below that. This used to be a private 0.5/1.0 family, which
// made the ledger and the Ordering panel — two screens inside the SAME tab —
// disagree about the same item: 40 of a par-100 item read as a red Critical
// pill on the ledger while Ordering called it Low, and 80 read as amber
// "Order soon" on the ledger while Ordering left it off the order list
// entirely (it builds candidates through stockStatus). One helper, one answer.
export { stockStatus as ratioStatus } from '@/lib/stock-status';

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
