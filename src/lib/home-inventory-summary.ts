export type HomeInventoryTileTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface HomeInventoryTileLine {
  en: string;
  tone: HomeInventoryTileTone;
}

export interface HomeInventorySummaryRow {
  current_stock?: unknown;
  par_level?: unknown;
  last_counted_at?: unknown;
}

/**
 * Turn inventory rows into the short Home-tile status without pretending an
 * uncounted catalog is out of stock. A brand-new hotel's zeroes mean
 * "unknown" until the first physical count, not "critical". Counted rows use
 * the Inventory tab's existing rule: below 50% of par is critical, below par
 * is low, and at/above par is healthy.
 */
export function summarizeHomeInventory(
  rows: readonly HomeInventorySummaryRow[],
): HomeInventoryTileLine {
  if (rows.length === 0) {
    return { en: 'Open inventory', tone: 'muted' };
  }

  const counted = rows.filter((row) => row.last_counted_at != null);
  if (counted.length === 0) {
    return { en: 'Start first count', tone: 'muted' };
  }

  let critical = 0;
  let low = 0;
  let comparable = 0;
  for (const row of counted) {
    const stock = Number(row.current_stock ?? 0);
    const par = Number(row.par_level ?? 0);
    if (!Number.isFinite(stock) || !Number.isFinite(par) || par <= 0) continue;
    comparable++;
    const ratio = stock / par;
    if (ratio < 0.5) critical++;
    else if (ratio < 1) low++;
  }

  if (critical > 0) {
    return critical === 1
      ? { en: '1 item critical', tone: 'bad' }
      : { en: `${critical} items critical`, tone: 'bad' };
  }
  if (low > 0) {
    return low === 1
      ? { en: '1 item low', tone: 'warn' }
      : { en: `${low} items low`, tone: 'warn' };
  }
  if (comparable === 0) {
    return { en: 'Set par levels', tone: 'muted' };
  }
  return { en: 'Stock healthy', tone: 'ok' };
}
