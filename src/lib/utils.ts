import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string, fmt = 'yyyy-MM-dd'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, fmt);
}

// Hard-code Central time so "today" on the HK page matches what the Texas
// scraper writes, regardless of whose phone or laptop is opening the page.
// en-CA gives us the ISO YYYY-MM-DD format directly.
const APP_TIMEZONE = 'America/Chicago';

export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(new Date());
}

export function yesterdayStr(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(d);
}

/**
 * Generate an ID for use as a primary key on a Supabase/Postgres `uuid`
 * column. Used by client-side seeding paths (PropertyContext default
 * public areas + laundry categories). Must be a real UUID v4 — the
 * previous Firestore-era 9-char base36 string produced by
 * `Math.random().toString(36).slice(2, 11)` got rejected by Postgres
 * as `invalid input syntax for type uuid`, silently breaking first
 * load of any new property.
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback — only hit in ancient browsers / SSR without
  // Web Crypto (e.g. Node < 14.17).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Formats a number as USD. Single source of truth — every page used to
 * carry its own copy with slightly different conventions (some showed
 * cents, some didn't, some returned '—' for null, some returned '$0').
 *
 * Modes:
 *   - default:        $1,234       (whole-dollar, with thousands separator)
 *   - short=true:     $1.2k        (compact for chart axes / hero stats)
 *
 * Null-safety: returns '$0' rather than throwing or '—', so the hero
 * stat strings stay aligned. Pages that need a literal '—' for null
 * should test the input themselves before calling.
 */
export function formatCurrency(n: number | null | undefined, short = false): string {
  if (n == null || isNaN(n)) return '$0';
  if (short && Math.abs(n) >= 1000) {
    const sign = n < 0 ? '-' : '';
    return `${sign}$${(Math.abs(n) / 1000).toFixed(1)}k`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatPercent(n: number): string {
  return `${Math.round(n)}%`;
}

export const FLOOR_LABELS: Record<string, string> = {
  '1': 'Floor 1',
  '2': 'Floor 2',
  '3': 'Floor 3',
  '4': 'Floor 4',
  'exterior': 'Exterior',
};

export const FLOOR_LABELS_ES: Record<string, string> = {
  '1': 'Piso 1',
  '2': 'Piso 2',
  '3': 'Piso 3',
  '4': 'Piso 4',
  'exterior': 'Exterior',
};

export function getFloorLabel(floor: string, lang: 'en' | 'es' = 'en'): string {
  return lang === 'es' ? FLOOR_LABELS_ES[floor] ?? floor : FLOOR_LABELS[floor] ?? floor;
}

export function timeAgo(date: Date | null | undefined): string {
  if (!date) return '';
  const now = Date.now();
  const d = date instanceof Date ? date.getTime() : new Date(date as unknown as string).getTime();
  const seconds = Math.floor((now - d) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Validate YYYY-MM-DD date string */
export function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}

/**
 * Serialize an unknown thrown value into a useful human string.
 *
 * `String(err)` on a plain object returns the literal "[object Object]" —
 * exactly what started surfacing in prod after we moved off Firebase (whose
 * SDK throws Error subclasses) onto Supabase (whose PostgrestError is a
 * plain object { message, details, hint, code, status }). The pattern
 * `err instanceof Error ? err.message : String(err)` silently dropped every
 * real error message.
 *
 * Use this helper in EVERY catch block where the error is going to be shown
 * or logged. Extracts .message / .code / .hint / .status / .details from
 * plain object-shaped errors (Supabase, Twilio, fetch rethrows) and falls
 * back to JSON.stringify → String() so "[object Object]" can never reach a
 * dashboard or error_logs row again.
 */
export function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const message = typeof e.message === 'string' ? e.message : null;
    const code    = typeof e.code    === 'string' ? e.code    : null;
    const hint    = typeof e.hint    === 'string' ? e.hint    : null;
    const details = typeof e.details === 'string' ? e.details : null;
    const status  = typeof e.status  === 'number' ? e.status  : null;
    if (message) {
      const extra: string[] = [];
      if (code)    extra.push(`code=${code}`);
      if (hint)    extra.push(`hint=${hint}`);
      if (status)  extra.push(`status=${status}`);
      if (details) extra.push(`details=${details}`);
      return extra.length ? `${message} (${extra.join(', ')})` : message;
    }
    try {
      const s = JSON.stringify(err);
      if (s && s !== '{}') return s.length > 300 ? `${s.slice(0, 300)}...` : s;
    } catch { /* fall through */ }
  }
  return String(err);
}
