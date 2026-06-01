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

// Comms-voice audit follow-up (2026-05-22): pragmatic email regex.
// Not RFC 5322 — that would be 600 chars of regex for negligible benefit.
// Catches the realistic failure modes (typo'd `@`, missing TLD, single-
// char TLD, embedded whitespace) without rejecting legitimate plus-
// addressing or hyphenated domains. Resend still validates after this
// gate; we just don't want to pay them to reject obvious junk.
//
// Shape:
//   local @ (label .)+ tld
// where each label is 1–63 chars (DNS limit) and the TLD is 2+ chars.
const EMAIL_RX = /^[A-Z0-9._%+\-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9][A-Z0-9-]{0,61}[A-Z0-9]$/i;
const EMAIL_MAX_LEN = 254;  // RFC 5321 line-length cap

/**
 * Returns true if `s` looks like a plausibly valid email address.
 *
 * Checks: ≤254 chars, no whitespace or control chars, exactly one `@`,
 * a domain with at least one dot, and a TLD of 2+ chars. Header-injection
 * bytes (\r, \n, \0) are rejected by the regex (whitespace class doesn't
 * match), with a defensive explicit check too.
 *
 * Pure / no I/O — safe to call from any context.
 */
export function isValidEmail(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > EMAIL_MAX_LEN) return false;
  if (/[\r\n\0\s]/.test(s)) return false;
  return EMAIL_RX.test(s);
}

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

/**
 * Validate a finite (possibly fractional) number — costs, lifetimes, etc.
 * Accepts a JS number or a numeric string. Use validateInt when you need a
 * whole number. Rejects NaN / Infinity and out-of-range values.
 */
export function validateNumber(
  v: unknown,
  opts: { min?: number; max?: number; label: string },
): { error?: string; value?: number } {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
  else return { error: `${opts.label} must be a number` };
  if (!Number.isFinite(n)) return { error: `${opts.label} must be a finite number` };
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
  // Reject impossible calendar dates that Date() silently rolls forward
  // (e.g. 2026-02-30 → Mar 2): verify the parsed components round-trip.
  const [yr, mo, day] = v.split('-').map(Number);
  if (d.getUTCFullYear() !== yr || d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== day) {
    return { error: `${opts.label} is not a real date` };
  }
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

/**
 * Validate an ISO timestamp that must be in the future. Used by /api/settings/
 * notifications for `pausedUntil` (a "pause delivery until" date) — accepting
 * a past timestamp silently was a confusing UX where the API returned 200
 * but the pause didn't fire (the cron's `paused_until > now` check just
 * never matched).
 *
 * Default: STRICT — any timestamp at or before `now` is rejected. Callers
 * that need clock-skew tolerance must opt in via `clockSkewSlackMs`. The
 * notifications route opts in for 60s to absorb client-to-server round-trip
 * latency when the user picks "right now-ish."
 *
 * Options:
 *   - clockSkewSlackMs: how far in the past is still treated as "now"
 *     (default 0 = strict).
 *   - maxFutureDays: reject timestamps further than this many days out
 *     (defaults to no cap; pass e.g. 180 for "pause-until cannot be
 *     more than 6 months out").
 *   - now: override Date.now() for tests (defaults to current time).
 *
 * Returns `{ value: <iso> }` on success or `{ error: <message> }`.
 */
export function validateFutureTimestamp(
  v: unknown,
  opts: { label: string; clockSkewSlackMs?: number; maxFutureDays?: number; now?: number } = { label: 'timestamp' },
): { error?: string; value?: string } {
  const { label } = opts;
  if (typeof v !== 'string') return { error: `${label} must be an ISO date string` };
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return { error: `${label} is not a valid ISO date string` };
  const now = opts.now ?? Date.now();
  const slack = opts.clockSkewSlackMs ?? 0;
  if (ms < now - slack) return { error: `${label} must be a future timestamp` };
  if (opts.maxFutureDays !== undefined) {
    const maxMs = now + opts.maxFutureDays * 24 * 60 * 60 * 1000;
    if (ms > maxMs) return { error: `${label} cannot be more than ${opts.maxFutureDays} days in the future` };
  }
  return { value: new Date(ms).toISOString() };
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
 * Parse a free-form room-number string into an array of room numbers.
 *
 * Supports:
 *   "101"               → ["101"]
 *   "101, 102, 103"     → ["101","102","103"]
 *   "101-103"           → ["101","102","103"]
 *   "101-103, 200"      → ["101","102","103","200"]
 *   "101-112, 114-122"  → expands both ranges, skips 113 (US "no 13" convention)
 *
 * Newlines, commas, and semicolons are all treated as separators.
 *
 * Does NOT support: "except", "skip", "Suite-A" inside a range. Operator
 * with non-contiguous numbering enumerates each range explicitly. Range
 * form is numeric only — alphanumeric room numbers ("L1-201") must be
 * listed individually.
 *
 * Returns an array that may include duplicates produced by overlapping
 * ranges; validateRoomNumbers catches duplicates as a separate step.
 */
export function parseRoomList(input: string): { error?: string; value?: string[] } {
  const tokens = input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return { value: [] };

  const out: string[] = [];
  for (const tok of tokens) {
    const rangeMatch = tok.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { error: `Range "${tok}" is not numeric` };
      }
      if (start > end) {
        return { error: `Range "${tok}" goes backwards (start > end)` };
      }
      if (end - start > 5000) {
        return { error: `Range "${tok}" is too large (max 5000 rooms per range)` };
      }
      for (let n = start; n <= end; n++) out.push(String(n));
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(tok)) {
      return { error: `Room number "${tok}" contains invalid characters` };
    }
    out.push(tok);
  }
  return { value: out };
}

/**
 * Validate an array of room numbers — what `properties.room_inventory`
 * stores. Each entry: non-empty, under LIMITS.ROOM_NUMBER_MAX chars,
 * unique within the list, no whitespace inside. Total cap at 2000
 * entries to match total_rooms's max.
 */
export function validateRoomNumbers(
  v: unknown,
  opts: { label?: string } = {},
): { error?: string; value?: string[] } {
  const label = opts.label ?? 'roomNumbers';
  if (!Array.isArray(v)) return { error: `${label} must be an array of strings` };
  if (v.length > 2000) return { error: `${label} too long (max 2000 rooms)` };
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const raw = v[i];
    if (typeof raw !== 'string') return { error: `${label}[${i}] must be a string` };
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { error: `${label}[${i}] is empty` };
    if (trimmed.length > LIMITS.ROOM_NUMBER_MAX) {
      return { error: `${label}[${i}] too long (max ${LIMITS.ROOM_NUMBER_MAX} chars)` };
    }
    if (/\s/.test(trimmed)) return { error: `${label}[${i}] contains whitespace` };
    if (seen.has(trimmed)) return { error: `${label} has duplicate: "${trimmed}"` };
    seen.add(trimmed);
    out.push(trimmed);
  }
  return { value: out };
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

/**
 * Redact an email for logs. Keeps the first char of the local-part plus
 * the domain so an oncall can tell synthetic from real and roughly
 * which tenant the user belongs to, without exposing the full address.
 *   "mario@hilton.com" → "m***@hilton.com"
 *   "mario@hilton.staxis.local" → "m***@hilton.staxis.local"
 */
export function redactEmail(email: string | null | undefined): string {
  if (!email) return '<no-email>';
  const at = email.indexOf('@');
  if (at < 1) return '<bad-email>';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Redact a Stripe identifier (cus_, pi_, sub_, in_, evt_, …) for logs.
 * Keeps the prefix + last-4 so an oncall can grep against the Stripe
 * Dashboard without the full identifier leaking to log aggregators.
 *   "cus_NeoSb1xLpfP7gQ" → "cus_***fP7gQ"
 * If the input doesn't look like a Stripe id (no underscore, or too
 * short to safely tail), returns a generic marker.
 */
export function redactStripeId(id: string | null | undefined): string {
  if (!id) return '<no-id>';
  const underscore = id.indexOf('_');
  if (underscore < 0 || id.length < underscore + 6) return '<short>';
  return `${id.slice(0, underscore + 1)}***${id.slice(-4)}`;
}

// ─── Response-shape parsers ───────────────────────────────────────────────
//
// Each parser takes an unknown (the raw JSON body the client got back from
// a server route) and either returns a strongly-typed value OR an error
// string the caller can surface in a toast. They replace `as` casts that
// would silently coerce undefined into 0 / null / false on server-side
// shape drift. Audit Flow 1 #4, Flow 2 #5, Flow 2 #10.
//
// Hand-rolled (no Zod) to match the rest of this module's pattern; see
// the file header for the cold-start argument.

export interface Parsed<T> {
  value?: T;
  error?: string;
}

/**
 * Parse the `{ ok: true, data: { trusted: boolean } }` envelope returned
 * by POST /api/auth/check-trust. The client-side cast that this replaces
 * was `body.data?.trusted` → silently false on shape drift (which then
 * forces the user into the OTP path with no visible signal).
 */
export function parseCheckTrustResponse(raw: unknown): Parsed<{ trusted: boolean }> {
  if (!raw || typeof raw !== 'object') return { error: 'check-trust: not an object' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return { error: `check-trust: ok=${String(r.ok)}` };
  const data = r.data;
  if (!data || typeof data !== 'object') return { error: 'check-trust: data missing' };
  const trusted = (data as Record<string, unknown>).trusted;
  if (typeof trusted !== 'boolean') return { error: 'check-trust: trusted not boolean' };
  return { value: { trusted } };
}

/**
 * Parse the `{ ok: true, data: { status, step, progressPct, error, result } }`
 * envelope returned by GET /api/pms/job-status. The client polls this
 * every 3s — a silent shape drift (e.g. snake_case slipping into the
 * response) would freeze the progress bar permanently.
 */
export function parsePmsJobStatusResponse(raw: unknown): Parsed<{
  status: 'queued' | 'running' | 'mapping' | 'extracting' | 'complete' | 'failed';
  step: string | null;
  progressPct: number;
  error: string | null;
  result: Record<string, unknown> | null;
}> {
  if (!raw || typeof raw !== 'object') return { error: 'job-status: not an object' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return { error: `job-status: ok=${String(r.ok)}` };
  const data = r.data;
  if (!data || typeof data !== 'object') return { error: 'job-status: data missing' };
  const d = data as Record<string, unknown>;
  const statusV = validateEnum(d.status, ['queued','running','mapping','extracting','complete','failed'] as const, 'status');
  if (statusV.error) return { error: `job-status: ${statusV.error}` };
  if (d.step !== null && typeof d.step !== 'string') return { error: 'job-status: step not string-or-null' };
  if (typeof d.progressPct !== 'number') return { error: 'job-status: progressPct not number' };
  if (d.error !== null && typeof d.error !== 'string') return { error: 'job-status: error not string-or-null' };
  if (d.result !== null && (typeof d.result !== 'object')) return { error: 'job-status: result not object-or-null' };
  return {
    value: {
      status: statusV.value!,
      step: d.step as string | null,
      progressPct: d.progressPct,
      error: d.error as string | null,
      result: d.result as Record<string, unknown> | null,
    },
  };
}

/**
 * Parse the success-result payload that lands in `jobStatus.result` when an
 * onboarding job completes. The pre-fix code did
 *   `(r.rooms_count as number) ?? 0`
 * which silently shows "0 rooms" if the field is renamed or absent.
 * Returning an error here lets the UI distinguish "0 rooms found"
 * (legitimate but unusual) from "the server changed the field name."
 */
export function parsePmsOnboardResult(raw: unknown): Parsed<{
  rooms_count: number;
  staff_count: number;
}> {
  if (!raw || typeof raw !== 'object') return { error: 'onboard-result: not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.rooms_count !== 'number') {
    return { error: 'onboard-result: rooms_count missing or not a number' };
  }
  if (typeof r.staff_count !== 'number') {
    return { error: 'onboard-result: staff_count missing or not a number' };
  }
  return { value: { rooms_count: r.rooms_count, staff_count: r.staff_count } };
}
