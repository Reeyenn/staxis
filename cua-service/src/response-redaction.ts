/**
 * PII redaction for captured network response bodies.
 *
 * SHARED CONTRACT (pinned by the orchestrator). Captured JSON bodies are the
 * rawest guest PII in the system (names, emails, phones, card numbers, auth
 * tokens) — far more than screenshots. They MUST be redacted at least as
 * strictly as screenshot-privacy.ts before they are buffered, returned by
 * network-capture, logged, persisted, or sent to Claude during the identify
 * step.
 *
 * Design rules (enforced by tests):
 *   - This module is PURE: zero imports, no I/O, never mutates its input.
 *     network-capture.ts stores nothing that didn't pass through here, so
 *     "can PII escape?" reduces to auditing this one file.
 *   - Key names + structure + row counts + dates + record IDs + statuses are
 *     PRESERVED — the mapper reconciles them against the on-screen table.
 *     Only VALUES of sensitive fields are masked.
 *   - Conservative bias: when a field is ambiguous, mask it. Every internal
 *     bail-out path (cycle, depth, parse error, throwing getter) returns a
 *     `<redacted:…>` marker — never the raw input.
 *   - Markers follow the log.ts convention: `<redacted:kind>`.
 *
 * Known, deliberate trade-offs (do not "fix" without re-reviewing privacy):
 *   - Bare `name` keys are masked even when they label a room type/product.
 *     Structural labels the mapper needs survive via STRUCTURAL_ALLOW
 *     (room_name, rate_name, …). Guest-name reconciliation is screen-side
 *     only — screenshot-privacy.ts intentionally leaves on-screen names
 *     visible; network bodies are stricter.
 *   - A bare 10–11 digit number under a non-phone key is KEPT (confirmation
 *     numbers are indistinguishable from unformatted phones; key matching
 *     catches real phone fields). Formatted phones are masked anywhere.
 *   - city/state/country are kept (coarse, and the hotel's own address is
 *     everywhere in PMS data). Street-level fields are masked.
 */

const MAX_DEPTH = 40;
const MAX_REQUEST_BODY_CHARS = 16 * 1024;

function marker(kind: string): string {
  return `<redacted:${kind}>`;
}

// ─── Key classification ──────────────────────────────────────────────────
//
// Keys are normalized (lowercase, alphanumerics only) so guest_name,
// guestName and "Guest Name" all classify identically. Two pattern tiers:
// EXACT tokens for short/ambiguous fragments (substring `cc` would nuke
// `occupancy`/`account`/`success`; `pan` would nuke `company`; `pin` is in
// `shipping`; `kin` is in `booking`; `tax` is in `tax_amount`) and
// SUBSTRINGS for fragments that are unambiguous anywhere they appear.

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Structural labels the mapper must keep (full normalized-key match).
 *  Checked FIRST, before the bare-`name` substring mask. */
const STRUCTURAL_ALLOW = new Set([
  'roomname', 'roomtypename', 'ratename', 'rateplanname', 'ratecodename',
  'planname', 'typename', 'hotelname', 'propertyname', 'pagename',
  'reportname', 'columnname', 'fieldname', 'statusname', 'categoryname',
  'floorname', 'areaname', 'sectionname', 'sourcename', 'channelname',
  'segmentname', 'marketname', 'taskname',
]);

/** Identity-document keys — must win over the generic `…id` allow below. */
const DOC_ID_SUBSTRINGS = ['nationalid', 'taxid', 'vatid', 'idnumber', 'documentnumber', 'docnumber'];

/** Payment / credential subtrees: every string+number leaf under these is
 *  masked (structure, keys, booleans, null kept). */
const NUKE_EXACT = new Set([
  'cc', 'cvv', 'cvc', 'ccv', 'cvv2', 'pan', 'pin', 'ssn', 'iban', 'swift',
  'bic', 'ach', 'kin',
]);
const NUKE_SUBSTRINGS = [
  'card', 'creditcard', 'payment', 'billing', 'password', 'passwd', 'pwd',
  'secret', 'token', 'auth', 'credential', 'cookie', 'session', 'routing',
  'sortcode', 'track1', 'track2', 'trackdata', 'magstripe', 'privatekey',
  'apikey', 'csrf', 'xsrf', 'bearer', 'ccnum', 'ccexp', 'pincode',
  'nextofkin', 'socialsecurity', 'bankaccount', 'ssn',
];

/** PII leaf fields whose values can be strings OR numbers (phones, zips,
 *  DOBs, loyalty numbers…): any scalar directly under the key is masked; a
 *  container under the key recurses NORMALLY so e.g.
 *  guest: { roomNumber, arrivalDate, name } keeps room + date while the
 *  inner `name` is still caught on its own. */
const MASK_EXACT = new Set([
  'ein', 'tin', 'curp', 'rfc', 'dni', 'cpf', 'aadhaar', 'nric',
  'social', 'mail', 'addr', 'nok',
]);
const MASK_SUBSTRINGS = [
  'email', 'phone', 'mobile', 'cell', 'fax', 'msisdn', 'address',
  'street', 'zip', 'postal', 'pobox', 'birth', 'dob', 'passport', 'license',
  'licence', 'plate', 'note', 'comment', 'remark', 'special', 'message',
  'loyalty', 'membership', 'rewards', 'emergency', 'photo', 'avatar',
  'signature', 'allerg', 'dietary', 'medical', 'disab', 'login', 'contact',
];

/** Person-label fields: only STRING values are masked — a number under
 *  these keys is a count/occupancy figure the mapper needs (`guests: 2`,
 *  `adults` under a guest object), never a name. */
const MASK_STRING_EXACT = new Set(['title']);
const MASK_STRING_SUBSTRINGS = [
  'name', 'guest', 'customer', 'holder', 'traveler', 'traveller',
  'occupant', 'company', 'organization', 'organisation', 'nationality',
];

type KeyClass = 'allow' | 'nuke' | 'mask' | 'maskstring' | 'plain';

function classifyKey(rawKey: string): KeyClass {
  const k = normalizeKey(rawKey);
  if (k.length === 0) return 'plain';
  if (STRUCTURAL_ALLOW.has(k)) return 'allow';
  for (const s of DOC_ID_SUBSTRINGS) if (k.includes(s)) return 'mask';
  if (NUKE_EXACT.has(k)) return 'nuke';
  for (const s of NUKE_SUBSTRINGS) if (k.includes(s)) return 'nuke';
  // Record IDs survive (mapper joins rows on them): guestId, customerId,
  // reservationUuid… — but only AFTER doc-id and credential checks above
  // (sessionId/tokenId/nationalId are already classified by then). A
  // value-bearing stem keeps its mask: `emailid`/`phoneid` often hold the
  // actual email/phone string in sloppy legacy APIs.
  if (/(id|ids|uuid|guid)$/.test(k)) {
    const stem = k.replace(/(id|ids|uuid|guid)$/, '');
    const valueBearing = ['email', 'mail', 'phone', 'mobile', 'cell', 'fax', 'ssn',
      'passport', 'license', 'licence', 'dob', 'birth', 'address'];
    return valueBearing.some((s) => stem.includes(s)) ? 'mask' : 'plain';
  }
  // Both-scalar tier first: `guestPhone` must full-mask via `phone` before
  // the string-only `guest` tier can claim it.
  if (MASK_EXACT.has(k)) return 'mask';
  for (const s of MASK_SUBSTRINGS) if (k.includes(s)) return 'mask';
  if (MASK_STRING_EXACT.has(k)) return 'maskstring';
  for (const s of MASK_STRING_SUBSTRINGS) if (k.includes(s)) return 'maskstring';
  return 'plain';
}

// ─── Value patterns ──────────────────────────────────────────────────────
// Applied to EVERY surviving string (and 13–19-digit number leaves), even
// under safe keys. The first three mirror log.ts verbatim.

const ANTHROPIC_KEY_RE = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]{20,}/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Card-number candidates: 13–19 digits, optionally space/dash separated.
// Only masked when Luhn-valid (so long confirmation numbers survive).
const PAN_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
// Phones: FORMATTED forms only (leading + / parenthesised area code /
// three separator-delimited groups). Bare digit runs are left to key
// matching — see module doc.
const PHONE_PLUS_RE = /\+\d[\d\s().-]{6,}\d/g;
const PHONE_PAREN_RE = /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}/g;
const PHONE_GROUPS_RE = /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g;

function isLuhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function scrubStringValue(s: string): string {
  let out = s;
  out = out.replace(ANTHROPIC_KEY_RE, marker('anthropic_key'));
  out = out.replace(BEARER_RE, marker('bearer'));
  out = out.replace(JWT_RE, marker('jwt'));
  out = out.replace(EMAIL_RE, marker('email'));
  out = out.replace(SSN_RE, marker('ssn'));
  out = out.replace(PAN_CANDIDATE_RE, (m) =>
    isLuhnValid(m.replace(/[ -]/g, '')) ? marker('pan') : m,
  );
  out = out.replace(PHONE_PLUS_RE, marker('phone'));
  out = out.replace(PHONE_PAREN_RE, marker('phone'));
  out = out.replace(PHONE_GROUPS_RE, marker('phone'));
  return out;
}

// ─── Recursive walker ────────────────────────────────────────────────────

type WalkMode = 'normal' | 'nuke';

function walkScalarNumber(n: number, mode: WalkMode): unknown {
  if (mode === 'nuke') return marker('masked');
  // `"cardNumber": 4111111111111111` arrives as a JSON *number* — Luhn-check
  // 13–19-digit integers regardless of key.
  if (Number.isInteger(n)) {
    const s = Math.abs(n).toString();
    if (s.length >= 13 && s.length <= 19 && isLuhnValid(s)) return marker('pan');
  }
  return n;
}

function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  // Plain assignment with key '__proto__' would set the prototype instead
  // of an own property — defineProperty sidesteps that.
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, mode: WalkMode): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') {
    return mode === 'nuke' ? marker('masked') : scrubStringValue(value as string);
  }
  if (t === 'number') return walkScalarNumber(value as number, mode);
  if (t === 'boolean') return value;
  if (t === 'bigint') return mode === 'nuke' ? marker('masked') : (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return marker('unsupported_type');

  if (depth >= MAX_DEPTH) return marker('max_depth');

  if (value instanceof Date) {
    // Dates are reconciliation anchors — keep them (except inside nuked
    // payment/credential subtrees, where an expiry date is sensitive).
    return mode === 'nuke' ? marker('masked') : value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return marker('cycle');
    seen.add(value);
    return value.map((v) => walk(v, depth + 1, seen, mode));
  }

  if (t === 'object') {
    if (seen.has(value as object)) return marker('cycle');
    if (value instanceof Map || value instanceof Set || ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer || Buffer.isBuffer(value)) {
      return marker('unsupported_type');
    }
    seen.add(value as object);
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      let v: unknown;
      try {
        v = src[key];
      } catch {
        // A throwing getter masks just that field; siblings survive.
        setOwn(out, key, marker('error'));
        continue;
      }
      if (mode === 'nuke') {
        setOwn(out, key, walk(v, depth + 1, seen, 'nuke'));
        continue;
      }
      const cls = classifyKey(key);
      if (cls === 'nuke') {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
          setOwn(out, key, marker('masked'));
        } else {
          setOwn(out, key, walk(v, depth + 1, seen, 'nuke'));
        }
      } else if (cls === 'mask') {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
          setOwn(out, key, marker('field'));
        } else {
          setOwn(out, key, walk(v, depth + 1, seen, 'normal'));
        }
      } else if (cls === 'maskstring') {
        // Person-label keys: strings are names → masked; numbers are
        // counts (`guests: 2`) → kept.
        if (typeof v === 'string' || typeof v === 'bigint') {
          setOwn(out, key, marker('field'));
        } else {
          setOwn(out, key, walk(v, depth + 1, seen, 'normal'));
        }
      } else {
        setOwn(out, key, walk(v, depth + 1, seen, 'normal'));
      }
    }
    return out;
  }

  return marker('unsupported_type');
}

/**
 * Return a deep copy of `body` with guest PII + secrets masked. Field SHAPE
 * and key names are preserved (the identify/verify step needs them) — only
 * VALUES of sensitive fields are masked, so row counts / dates / non-PII
 * fields still reconcile against the DOM oracle. Never throws; never
 * returns the input reference for objects; any internal failure yields a
 * `<redacted:error>` marker instead of raw data.
 */
export function redactResponseBody(body: unknown): unknown {
  try {
    return walk(body, 0, new WeakSet(), 'normal');
  } catch {
    return marker('error');
  }
}

// ─── URL redaction ───────────────────────────────────────────────────────

/** Free-text search params — their values are whatever a user typed into a
 *  search box (very often a guest name), so mask regardless of patterns. */
const FREE_TEXT_PARAMS = new Set(['q', 'query', 'search', 'term', 'keyword', 'lookup', 'find']);

/** Query-param names whose values are masked outright. The mapper keeps the
 *  param NAME (it learns URL templates) and date-ish values survive. */
function isSensitiveParamName(name: string): boolean {
  if (FREE_TEXT_PARAMS.has(normalizeKey(name))) return true;
  const cls = classifyKey(name);
  return cls === 'nuke' || cls === 'mask' || cls === 'maskstring';
}

/**
 * Redact a URL for storage: strip userinfo, scrub decoded path segments
 * (emails/tokens in paths), mask query values with sensitive names,
 * pattern-scrub the rest. Unparseable input → marker (never raw).
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    // Fragments never reach the server and can carry OAuth tokens
    // (#access_token=…) — drop them entirely.
    u.hash = '';
    const segs = u.pathname.split('/').map((seg) => {
      if (seg === '') return seg;
      let dec = seg;
      try {
        dec = decodeURIComponent(seg);
      } catch {
        // undecodable — scrub the raw segment as-is
      }
      const scrubbed = scrubStringValue(dec);
      return scrubbed === dec ? seg : encodeURIComponent(scrubbed);
    });
    u.pathname = segs.join('/');
    const entries = [...u.searchParams.entries()];
    u.search = '';
    if (entries.length === 0) return u.toString();
    const parts = entries.map(([k, v]) => {
      if (isSensitiveParamName(k)) return `${encodeURIComponent(k)}=${marker('param')}`;
      const scrubbed = scrubStringValue(v);
      return `${encodeURIComponent(k)}=${scrubbed === v ? encodeURIComponent(v) : scrubbed}`;
    });
    return `${u.toString()}?${parts.join('&')}`;
  } catch {
    return marker('unparseable_url');
  }
}

// ─── Header redaction ────────────────────────────────────────────────────

const SENSITIVE_HEADER_SUBSTRINGS = [
  'auth', 'token', 'secret', 'cookie', 'session', 'csrf', 'xsrf', 'apikey',
  'api-key', 'signature', 'credential',
];

/** Redact request headers: credential-bearing names masked, referer reduced
 *  to origin+path (its query can carry guest search terms), every other
 *  value pattern-scrubbed. Returns a new object. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue);
    if (SENSITIVE_HEADER_SUBSTRINGS.some((s) => name.includes(s))) {
      setOwn(out as unknown as Record<string, unknown>, rawName, marker('header'));
      continue;
    }
    if (name === 'referer' || name === 'referrer') {
      try {
        const u = new URL(value);
        setOwn(out as unknown as Record<string, unknown>, rawName, `${u.origin}${u.pathname}`);
      } catch {
        setOwn(out as unknown as Record<string, unknown>, rawName, marker('header'));
      }
      continue;
    }
    setOwn(out as unknown as Record<string, unknown>, rawName, scrubStringValue(value));
  }
  return out;
}

// ─── Request-body redaction ──────────────────────────────────────────────

// Longest variants first — ")]}'," must win over ")]}'".
const XSSI_PREFIXES = [")]}',", ")]}'", 'while(1);', 'while (1);', 'for(;;);', 'for (;;);'];

/** Strip BOM + known XSSI guards so legacy-framework JSON sniffs/parses. */
export function stripJsonGuards(text: string): string {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.trimStart();
  for (const p of XSSI_PREFIXES) {
    if (t.startsWith(p)) {
      t = t.slice(p.length).trimStart();
      break;
    }
  }
  return t;
}

/**
 * Redact a request body (POST data) for storage. JSON → recursive redaction;
 * urlencoded → per-key masking; anything else (multipart, binary, unknown) →
 * fully masked. Capped at 16 KB post-redaction. The mapper mainly needs
 * param NAMES + date values to learn templating.
 */
export function redactRequestBody(postData: string | null, contentType?: string | null): string | null {
  if (postData === null || postData === undefined) return null;
  // Don't parse huge bodies (file uploads) — mask wholesale.
  if (postData.length > 8 * MAX_REQUEST_BODY_CHARS) return marker('opaque_request_body');
  try {
    const ct = (contentType ?? '').toLowerCase();
    const trimmed = stripJsonGuards(postData);
    let result: string | null = null;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        result = JSON.stringify(walk(parsed, 0, new WeakSet(), 'normal'));
      } catch {
        result = null;
      }
    }
    if (result === null && (ct.includes('x-www-form-urlencoded') || /^[^=\s]+=[^\s]*(&[^=\s]+=[^\s]*)*$/.test(postData))) {
      const params = new URLSearchParams(postData);
      const parts: string[] = [];
      for (const [k, v] of params.entries()) {
        if (isSensitiveParamName(k)) {
          parts.push(`${encodeURIComponent(k)}=${marker('param')}`);
        } else {
          const scrubbed = scrubStringValue(v);
          parts.push(`${encodeURIComponent(k)}=${scrubbed === v ? encodeURIComponent(v) : scrubbed}`);
        }
      }
      result = parts.join('&');
    }
    if (result === null) result = marker('opaque_request_body');
    if (result.length > MAX_REQUEST_BODY_CHARS) {
      result = result.slice(0, MAX_REQUEST_BODY_CHARS) + marker('truncated');
    }
    return result;
  } catch {
    return marker('error');
  }
}

// ─── CSV redaction ───────────────────────────────────────────────────────
//
// Own parser on purpose: extractors/csv-download.ts's parseCsv trims fields
// and drops blank rows, which would break the exact-row-count invariant the
// mapper reconciles against.

const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;

const DATE_LIKE_RE =
  /^\s*(\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}( \d{1,2}:\d{2}(:\d{2})?( ?[APap][Mm])?)?|\d{1,2}:\d{2}(:\d{2})?( ?[APap][Mm])?)\s*$/;
const NUMERIC_CELL_RE = /^\s*-?[$€£]?[\d,]*\.?\d+\s*%?\s*$/;

interface ParsedCsv {
  rows: string[][];
  delimiter: string;
  lineEnding: string;
  trailingNewline: boolean;
}

function sniffDelimiter(firstLine: string): string {
  let best: string = ',';
  let bestCount = 0;
  for (const d of CSV_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function parseCsvPreserving(text: string): ParsedCsv {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const firstLineEnd = text.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = sniffDelimiter(firstLine.replace(/\r$/, ''));

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      // Row terminator (handles \n and \r\n; a lone \r terminates too).
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  const trailingNewline = text.endsWith('\n') || text.endsWith('\r');
  if (!trailingNewline) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, delimiter, lineEnding, trailingNewline };
}

function serializeCell(cell: string, delimiter: string): string {
  if (cell.includes('"') || cell.includes(delimiter) || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

function looksLikeHeaderRow(cells: string[]): boolean {
  if (cells.every((c) => c.trim() === '')) return false;
  // A header row has no date/numeric cells — those are data values.
  for (const c of cells) {
    const t = c.trim();
    if (t === '') continue;
    if (DATE_LIKE_RE.test(t)) return false;
    if (NUMERIC_CELL_RE.test(t)) return false;
  }
  return true;
}

function redactHeaderlessCell(raw: string): string {
  const t = raw.trim();
  if (t === '') return raw;
  if (DATE_LIKE_RE.test(t)) return raw;
  if (NUMERIC_CELL_RE.test(t)) {
    // No header to disambiguate: a 10+-digit numeric cell could be a phone.
    const digits = t.replace(/[^0-9]/g, '');
    return digits.length >= 10 ? marker('csv') : raw;
  }
  return marker('csv');
}

/**
 * Redact a CSV body while preserving the exact row count, the header names,
 * the column count and every non-PII cell (dates, numbers, statuses). With
 * a recognizable header row, columns whose header classifies as sensitive
 * are masked and every other cell is pattern-scrubbed. Without one, every
 * cell that isn't numeric/date-like/empty is masked (no key names exist to
 * disambiguate, so err toward masking). Never throws; failure → marker.
 */
export function redactCsvText(csv: string): string {
  try {
    let text = csv;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const { rows, delimiter, lineEnding, trailingNewline } = parseCsvPreserving(text);
    if (rows.length === 0) return '';

    const hasHeader = looksLikeHeaderRow(rows[0]);
    const maskedColumns = new Set<number>();
    if (hasHeader) {
      rows[0].forEach((h, idx) => {
        const cls = classifyKey(h);
        // CSV cells are always strings, so the string-only tier masks too.
        if (cls === 'nuke' || cls === 'mask' || cls === 'maskstring') maskedColumns.add(idx);
      });
    }

    const outRows = rows.map((cells, rowIdx) => {
      if (hasHeader && rowIdx === 0) {
        return cells.map((c) => serializeCell(scrubStringValue(c), delimiter)).join(delimiter);
      }
      return cells
        .map((c, colIdx) => {
          if (hasHeader) {
            const redacted =
              maskedColumns.has(colIdx) && c.trim() !== '' ? marker('csv') : scrubStringValue(c);
            return serializeCell(redacted, delimiter);
          }
          return serializeCell(redactHeaderlessCell(c), delimiter);
        })
        .join(delimiter);
    });

    return outRows.join(lineEnding) + (trailingNewline ? lineEnding : '');
  } catch {
    return marker('error');
  }
}

// Exposed for unit tests only — the classifier and value patterns are the
// load-bearing pieces (log.ts:__test__ precedent).
export const __test__ = {
  classifyKey,
  normalizeKey,
  scrubStringValue,
  isLuhnValid,
  looksLikeHeaderRow,
  sniffDelimiter,
};
