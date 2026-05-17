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

// Default timezone for date helpers. Stays 'America/Chicago' because that's
// where Comfort Suites (the only property today) is. Per-property TZ comes
// from `properties.timezone` (migration 0016) and is wired through callers
// that have a property id in scope — housekeeper page, ML inference, etc.
// Code paths that don't have a property in scope (admin UI, generic
// utilities) continue to use this default.
export const APP_TIMEZONE = 'America/Chicago';

/**
 * Return today's date as YYYY-MM-DD in the given IANA timezone (or
 * APP_TIMEZONE if omitted). Callers with a property in scope should pass
 * `properties.timezone` so a Florida hotel doesn't roll the day at the
 * wrong hour relative to a Texas hotel.
 */
export function todayStr(tz: string = APP_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function yesterdayStr(tz: string = APP_TIMEZONE): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
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

/**
 * Validate YYYY-MM-DD date string.
 *
 * 2026-05-12 (Codex audit): previously this only regex-checked the shape
 * and let `new Date(s)` parse it. JavaScript silently normalises invalid
 * calendar dates — `new Date('2026-02-31')` becomes March 3 — so impossible
 * dates passed the !isNaN check and flowed into shift/event validators as
 * "valid". Now we round-trip through the parsed Date and require the
 * components to match the input exactly.
 */
export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const round = `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`;
  return round === s;
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
