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
