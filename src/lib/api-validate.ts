/**
 * Request-body validation helpers for API routes.
 *
 * We don't pull in Zod for this — the API surface is small enough that a
 * handful of focused helpers covers everything, and adding 30 KB to our
 * cold-start budget for 6 routes isn't worth it.
 *
 * Usage:
 *   const { error, value } = validateString(body.name, { max: 100, label: 'name' });
 *   if (error) return NextResponse.json({ error }, { status: 400 });
 *   const safe = sanitizeForSms(value);
 */

// Hard upper bounds on common fields. Centralized so the next bug-fix pass
// has one place to tweak.
export const LIMITS = {
  STAFF_NAME_MAX: 100,
  ROOM_NUMBER_MAX: 10,
  ROOM_NOTE_MAX: 500,
  ISSUE_NOTE_MAX: 1000,
  STAFF_ARRAY_MAX: 200,        // crew size cap on send-shift-confirmations
  ASSIGNED_ROOMS_MAX: 100,     // rooms per HK
  ASSIGNED_AREAS_MAX: 50,
  SMS_BODY_MAX: 1600,          // Twilio's 10-segment hard cap
  SHIFT_DATE_FUTURE_DAYS: 30,  // refuse shift_date more than 30 days out
} as const;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RX_LOOSE = /^[+()\d\s.\-]{7,20}$/;

export function validateUuid(v: unknown, label = 'id'): { error?: string; value?: string } {
  if (typeof v !== 'string') return { error: `${label} must be a string` };
  if (!UUID_RX.test(v)) return { error: `${label} is not a valid UUID` };
  return { value: v };
}

export function validateString(
  v: unknown,
  opts: { max: number; min?: number; label: string; allowEmpty?: boolean },
): { error?: string; value?: string } {
  if (typeof v !== 'string') return { error: `${opts.label} must be a string` };
  if (!opts.allowEmpty && v.length === 0) return { error: `${opts.label} cannot be empty` };
  if ((opts.min ?? 0) > 0 && v.length < (opts.min ?? 0)) {
    return { error: `${opts.label} must be at least ${opts.min} chars` };
  }
  if (v.length > opts.max) {
    return { error: `${opts.label} too long (max ${opts.max} chars)` };
  }
  return { value: v };
}

export function validateInt(
  v: unknown,
  opts: { min?: number; max?: number; label: string },
): { error?: string; value?: number } {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?\d+$/.test(v)) n = parseInt(v, 10);
  else return { error: `${opts.label} must be an integer` };
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: `${opts.label} is not an integer` };
  if (opts.min !== undefined && n < opts.min) return { error: `${opts.label} must be ≥ ${opts.min}` };
  if (opts.max !== undefined && n > opts.max) return { error: `${opts.label} must be ≤ ${opts.max}` };
  return { value: n };
}

export function validateEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  label: string,
): { error?: string; value?: T } {
  if (typeof v !== 'string') return { error: `${label} must be a string` };
  if (!allowed.includes(v as T)) return { error: `${label} must be one of: ${allowed.join(', ')}` };
  return { value: v as T };
}

/**
 * Validate that a string is a real IANA timezone identifier.
 * Uses the runtime's Intl.DateTimeFormat which throws RangeError on
 * unknown zones. Catches typos like "Pacific/Wrong" before they land
 * in the DB and silently break date formatting downstream.
 */
export function validateTimezone(v: unknown, label = 'timezone'): { error?: string; value?: string } {
  if (typeof v !== 'string') return { error: `${label} must be a string` };
  if (v.length === 0 || v.length > 100) return { error: `${label} length must be 1-100 chars` };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return { value: v };
  } catch {
    return { error: `${label} is not a valid IANA timezone (e.g. America/Chicago)` };
  }
}

export function validateDateStr(
  v: unknown,
  opts: { label: string; allowFutureDays?: number; allowPastDays?: number } = { label: 'date' },
): { error?: string; value?: string } {
  if (typeof v !== 'string') return { error: `${opts.label} must be a string` };
  if (!DATE_RX.test(v)) return { error: `${opts.label} must be YYYY-MM-DD` };
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return { error: `${opts.label} is not a real date` };
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (opts.allowFutureDays !== undefined) {
    const max = now + (opts.allowFutureDays * dayMs);
    if (d.getTime() > max) return { error: `${opts.label} is too far in the future (max ${opts.allowFutureDays} days)` };
  }
  if (opts.allowPastDays !== undefined) {
    const min = now - (opts.allowPastDays * dayMs);
    if (d.getTime() < min) return { error: `${opts.label} is too far in the past (max ${opts.allowPastDays} days)` };
  }
  return { value: v };
}

export function validateArray<T>(
  v: unknown,
  opts: { max: number; min?: number; label: string },
): { error?: string; value?: T[] } {
  if (!Array.isArray(v)) return { error: `${opts.label} must be an array` };
  if ((opts.min ?? 0) > 0 && v.length < (opts.min ?? 0)) {
    return { error: `${opts.label} must have at least ${opts.min} items` };
  }
  if (v.length > opts.max) return { error: `${opts.label} too large (max ${opts.max} items)` };
  return { value: v as T[] };
}

export function validatePhone(v: unknown, label = 'phone'): { error?: string; value?: string } {
  if (typeof v !== 'string') return { error: `${label} must be a string` };
  const trimmed = v.trim();
  if (trimmed.length === 0) return { value: '' };  // empty phone is OK; caller treats as "no phone"
  if (!PHONE_RX_LOOSE.test(trimmed)) return { error: `${label} contains invalid characters` };
  return { value: trimmed };
}

/**
 * Strip newlines, carriage returns, and ASCII control chars. Use this for
 * any user-controlled string that's about to be embedded into a Twilio SMS
 * body — without it, an attacker can put a `\n` in a name and inject extra
 * SMS content, bloat segments, or break Twilio parsing.
 */
export function sanitizeForSms(s: string): string {
  return s.replace(/[\r\n\t\v\f\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Whitelist a base URL — used to keep `baseUrl` from request bodies from
 * pointing to phishing sites in the SMS link.
 */
// getstaxis.com is the canonical brand domain. The legacy
// hotelops-ai.vercel.app alias is kept here as an allowed value because
// any old SMS link Twilio fires back through this route may still embed
// it — the next.config.ts 301 will redirect the user to getstaxis.com
// on click. Once we're confident nothing in the wild references the
// alias anymore, we can drop it.
const ALLOWED_BASE_URLS = new Set<string>([
  'https://getstaxis.com',
  'https://hotelops-ai.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
]);
export function safeBaseUrl(input: unknown, fallback = 'https://getstaxis.com'): string {
  if (typeof input !== 'string') return fallback;
  try {
    const u = new URL(input);
    const candidate = `${u.protocol}//${u.host}`;
    return ALLOWED_BASE_URLS.has(candidate) ? candidate : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Redact a phone number for logs. Keeps the country code + last 4 digits so
 * we can still triage incidents without exposing PII to a log aggregator.
 *   "+15551234567" → "+1***4567"
 */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return '<no-phone>';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '<short>';
  const last4 = digits.slice(-4);
  const cc = phone.startsWith('+') ? phone.split('').slice(0, 2).join('') : '';
  return `${cc}***${last4}`;
}
