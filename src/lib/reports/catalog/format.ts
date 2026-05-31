/**
 * Pure cell formatting for report values. Client-safe (no server imports) —
 * used by the Reports page table, the CSV/XLSX export, and the scheduled
 * email renderer so all three present identical values.
 */

import type { ColumnKind } from './types';

type Lang = 'en' | 'es';

export function formatCell(
  value: string | number | null | undefined,
  kind: ColumnKind = 'text',
  lang: Lang = 'en',
): string {
  if (value === null || value === undefined || value === '') return '—';
  const locale = lang === 'es' ? 'es-MX' : 'en-US';
  switch (kind) {
    case 'minutes': {
      const n = Number(value);
      return Number.isFinite(n) ? `${n}m` : String(value);
    }
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? `${n}%` : String(value);
    }
    case 'currency': {
      // values are integer cents
      const cents = Number(value);
      if (!Number.isFinite(cents)) return String(value);
      return `$${(cents / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString(locale) : String(value);
    }
    case 'datetime': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(locale);
    }
    case 'date':
    case 'text':
    default:
      return String(value);
  }
}
