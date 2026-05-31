// ════════════════════════════════════════════════════════════════════════════
// Financials — anomaly detection (pure functions, no I/O → unit-testable).
//
// Two detectors, modeled on src/lib/inventory-anomaly.ts (baseline-vs-current
// ratio with a floor to avoid noise on tiny numbers):
//   • detectDepartmentSpikes  — "Utilities is 30% over last month"
//   • detectInvoiceOutlier    — "This invoice is 2× your usual for this vendor"
//
// Findings are surfaced on the Financials page and, for the cron sweep, texted
// to the owner/GM. Conservative by design — a floor + a minimum history keep us
// from alerting on a $4 → $9 jump or a brand-new vendor.
// ════════════════════════════════════════════════════════════════════════════

import { DEPARTMENTS, type Department, departmentLabel, formatCents } from './shared';

export interface SpendAnomaly {
  kind: 'department_spike' | 'invoice_outlier';
  department: Department | null;
  vendor: string | null;
  currentCents: number;
  baselineCents: number;
  ratio: number; // current / baseline
  message: string;
}

export interface DepartmentSpikeOpts {
  /** Trigger when current ≥ baseline × (1 + threshold). Default 0.30 (30% over). */
  threshold?: number;
  /** Ignore departments whose baseline is below this (avoid noise). Default $500. */
  floorCents?: number;
}

/**
 * Compare this period's spend per department to a baseline period (e.g. last
 * month). Flags departments that are materially over.
 */
export function detectDepartmentSpikes(
  current: Partial<Record<Department, number>>,
  baseline: Partial<Record<Department, number>>,
  opts: DepartmentSpikeOpts = {},
): SpendAnomaly[] {
  const threshold = opts.threshold ?? 0.3;
  const floorCents = opts.floorCents ?? 50_000;
  const out: SpendAnomaly[] = [];
  for (const dept of DEPARTMENTS) {
    const cur = current[dept] ?? 0;
    const base = baseline[dept] ?? 0;
    if (base < floorCents) continue; // need a meaningful baseline
    const ratio = cur / base;
    if (ratio >= 1 + threshold) {
      const pct = Math.round((ratio - 1) * 100);
      out.push({
        kind: 'department_spike',
        department: dept,
        vendor: null,
        currentCents: cur,
        baselineCents: base,
        ratio,
        message: `${departmentLabel(dept)} spend is ${pct}% over last month (${formatCents(cur)} vs ${formatCents(base)}).`,
      });
    }
  }
  return out;
}

export interface InvoiceOutlierOpts {
  /** Trigger when amount ≥ median × multiple. Default 2 (2× usual). */
  multiple?: number;
  /** Need at least this many prior invoices from the vendor. Default 3. */
  minHistory?: number;
}

/**
 * Flag a single invoice as an outlier vs. the vendor's own history (median, so
 * one prior big bill doesn't desensitize it). Returns null when there isn't
 * enough history or the invoice is within normal range.
 */
export function detectInvoiceOutlier(
  amountCents: number,
  vendor: string | null,
  vendorHistoryCents: number[],
  opts: InvoiceOutlierOpts = {},
): SpendAnomaly | null {
  const multiple = opts.multiple ?? 2;
  const minHistory = opts.minHistory ?? 3;
  const history = vendorHistoryCents.filter((n) => Number.isFinite(n) && n > 0);
  if (history.length < minHistory) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  if (median <= 0) return null;
  const ratio = amountCents / median;
  if (ratio >= multiple) {
    const x = ratio.toFixed(1);
    return {
      kind: 'invoice_outlier',
      department: null,
      vendor,
      currentCents: amountCents,
      baselineCents: Math.round(median),
      ratio,
      message: `This ${vendor ?? 'vendor'} invoice (${formatCents(amountCents)}) is ${x}× your usual (${formatCents(Math.round(median))}).`,
    };
  }
  return null;
}
