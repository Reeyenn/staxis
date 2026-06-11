/**
 * Oracle verification for structured discovery (Chat 3 — mapper).
 *
 * The mapper's vision agent learns a feed as a DOM table. Structured discovery
 * then tries to find the JSON call the page itself made for the same data
 * (network-capture.ts) and emit `parse:{mode:'api'}` instead. The DOM-scraped
 * rows are the ORACLE (ground truth); this module decides — mechanically,
 * with zero trust in the LLM's column-mapping proposal — whether a captured
 * candidate's rows reconcile with that oracle.
 *
 * #1 RULE: a misidentified endpoint or a stale date param returns a FULL,
 * well-formed-but-WRONG rowset that passes downstream validation and silently
 * corrupts the DB. Every function here is therefore ABSTAIN-BY-DEFAULT: any
 * doubt → `{ok:false}` / `{reconciles:false}` and the caller keeps the DOM
 * recipe (today's behavior, zero regression). Rejecting a genuinely-good
 * candidate costs nothing; accepting a bad one corrupts a hotel's data.
 *
 * PURE module: no playwright / supabase / anthropic imports. Only leaf
 * modules (types, target-contract, parsers) so the whole safety core is
 * unit-testable offline.
 *
 * Redaction interplay: CapturedCall.responseBody has PII VALUES masked but
 * keys/shape preserved (response-redaction.ts contract). IDs, dates, room
 * numbers and status codes survive; guest names may be masked. Reconciliation
 * therefore anchors on keys/dates/counts and treats mask-looking text values
 * as "skip — counts neither for nor against".
 */

import type { Recipe } from './types.js';
import type { CapturedCall } from './network-capture.js';
import { CORE_TARGET_CONTRACTS, type CoreColumn } from './target-contract.js';
import { applyParser } from './parsers/registry.js';
// Side-effect import: registers the generic_* parsers used for parser-exact
// corroboration (same parsers the runtime will apply to the API values).
import './parsers/generic.js';
import { normEnumKey, toIsoDate } from './parsers/generic.js';

// ─── Per-target discovery semantics (target-level config, NOT per-PMS) ───────

/** The column that uniquely identifies a row, per core target. Discovery only
 *  runs for targets listed here. */
export const DISCOVERY_KEY_COLUMNS: Partial<Record<keyof Recipe['actions'], string>> = {
  getArrivals: 'pms_reservation_id',
  getDepartures: 'pms_reservation_id',
  getRoomStatus: 'room_number',
  getWorkOrders: 'pms_work_order_id',
};

/** The SEMANTIC date column that defines the feed's day-window. Bound per
 *  target (not "any uniform date column") — an arrivals feed at a property of
 *  1-night stays has a uniform departure_date too, and a "departures tomorrow"
 *  superset endpoint would wrongly pass a loose uniformity test. */
export const DISCOVERY_SEMANTIC_DATE_COLUMNS: Partial<Record<keyof Recipe['actions'], string>> = {
  getArrivals: 'arrival_date',
  getDepartures: 'departure_date',
};

/** Hard floor: below this many oracle rows the statistical checks are
 *  vacuous (key distinctness, corroboration rates), so we never attempt an
 *  api emission. Tiny feeds lose nothing by staying DOM-scraped. */
export const MIN_ORACLE_ROWS = 5;

/** Cap on oracle rows: a truncated oracle can't prove containment. */
export const MAX_ORACLE_ROWS = 300;

// ─── Small shared normalizers ────────────────────────────────────────────────

const normKey = (v: unknown): string =>
  v == null ? '' : String(v).trim().replace(/\s+/g, ' ').toLowerCase();

const normTextLoose = (v: unknown): string =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[.,;:'"()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sortedTokens = (s: string): string =>
  normTextLoose(s).split(' ').filter(Boolean).sort().join(' ');

/** Mask-looking value from the redaction layer. The capture chat's masks are
 *  SHAPE-PRESERVING for names ("JOHN_SMITH" → same shape), so beyond literal
 *  glyph runs we treat as masked: (a) strings whose alphabetic chars are ALL
 *  'x'/'X' ("Xxxxx, Xxxx"), and (b) strings that are mostly mask glyphs
 *  ("J*** S****"). Detection errs slightly toward "masked" — a masked cell is
 *  SKIPPED (counts neither for nor against); row identity stays anchored on
 *  keys/dates, which redaction preserves. */
export function looksMasked(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return false;
  if (/\[?redacted\]?|<redacted/i.test(s)) return true;
  // Entirely mask-ish glyphs (and at least one actual mask glyph, so a real
  // value like "-" or "x-ray" doesn't trip it).
  if (/^[\s*•·█▪◼◻#x×_–—-]+$/i.test(s) && /[*•█▪◼#]|^x+$/i.test(s)) return true;
  // Shape-preserving letter mask: ≥2 alphabetic chars, every one of them x/X.
  const alpha = s.replace(/[^a-z]/gi, '');
  if (alpha.length >= 2 && /^x+$/i.test(alpha)) return true;
  // Partial mask ("J*** S****"): mostly glyphs with ≥3 of them.
  const glyphs = (s.match(/[*•█▪◼#]/g) ?? []).length;
  return glyphs >= 3 && glyphs / s.length >= 0.6;
}

// ─── Date machinery ──────────────────────────────────────────────────────────

const pivotYear = (yy: string): number => {
  const n = parseInt(yy, 10);
  return n <= 69 ? 2000 + n : 1900 + n;
};

const MONTHS: Record<string, number> = (() => {
  const full = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const m: Record<string, number> = { sept: 9 };
  full.forEach((name, i) => { m[name] = i + 1; m[name.slice(0, 3)] = i + 1; });
  return m;
})();

/** ISO date (with optional time tail, mirroring generic_date's regex) →
 *  calendar-validated 'YYYY-MM-DD' | null. */
export function parseIsoDate(s: string): string | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (!m) return null;
  return toIsoDate(+m[1]!, +m[2]!, +m[3]!);
}

/** Textual-month forms ("Jun 10, 2026" / "10 Jun 2026") — unambiguous. */
export function parseTextualDate(s: string): string | null {
  const t = s.trim();
  const mdY = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (mdY) {
    const mo = MONTHS[mdY[1]!.toLowerCase()];
    if (mo) return toIsoDate(mdY[3]!.length <= 2 ? pivotYear(mdY[3]!) : +mdY[3]!, mo, +mdY[2]!);
  }
  const dMY = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/);
  if (dMY) {
    const mo = MONTHS[dMY[2]!.toLowerCase()];
    if (mo) return toIsoDate(dMY[3]!.length <= 2 ? pivotYear(dMY[3]!) : +dMY[3]!, mo, +dMY[1]!);
  }
  return null;
}

/** All calendar-valid ISO interpretations of a 3-part numeric date string.
 *  Returns [] for non-date-shaped input. */
export function numericDateInterpretations(s: string): string[] {
  const t = s.trim();
  if (!/^\d{1,4}([/.\-])\d{1,2}\1\d{1,4}$/.test(t)) return [];
  const parts = t.split(/[^0-9]+/).filter((p) => p !== '');
  if (parts.length !== 3) return [];
  const nums = parts.map((p) => parseInt(p, 10));
  const out = new Set<string>();
  // YMD (4-digit or 2-digit leading year)
  if (parts[0]!.length === 4) {
    const iso = toIsoDate(nums[0]!, nums[1]!, nums[2]!);
    if (iso) out.add(iso);
    return [...out]; // a 4-digit lead is unambiguously the year
  }
  const year = parts[2]!.length <= 2 ? pivotYear(parts[2]!) : nums[2]!;
  const mdy = toIsoDate(year, nums[0]!, nums[1]!);
  const dmy = toIsoDate(year, nums[1]!, nums[0]!);
  if (mdy) out.add(mdy);
  if (dmy) out.add(dmy);
  return [...out];
}

/** Year/month/day component multiset (year normalized to 4 digits) — used to
 *  corroborate an unambiguous API date against an AMBIGUOUS DOM date on a
 *  key-matched row. The row identity is already proven by the key; equal
 *  components are strong corroboration without guessing the DOM's order. */
function dateComponents(s: string): string | null {
  const iso = parseIsoDate(s) ?? parseTextualDate(s);
  if (iso) return iso.split('-').map(Number).sort((a, b) => a - b).join(',');
  const t = s.trim();
  if (!/^\d{1,4}([/.\-])\d{1,2}\1\d{1,4}$/.test(t)) return null;
  const parts = t.split(/[^0-9]+/).filter((p) => p !== '');
  if (parts.length !== 3) return null;
  // Require an explicit 4-digit year: with a 2-digit year we can't tell which
  // slot to pivot ("26/10/06"), so no safe component set exists → caller fails
  // the comparison (conservative).
  if (!parts.some((p) => p.length === 4)) return null;
  return parts.map((p) => parseInt(p, 10)).sort((a, b) => a - b).join(',');
}

/**
 * Parse an API-side date value the way the RUNTIME will. generic_date parses
 * ISO and textual-month forms BEFORE consulting the learned DOM date order, so
 * those are safe regardless of what order gets learned. A numeric API date in
 * a DIFFERENT order than the DOM would be parsed with the DOM-learned order at
 * runtime → silently wrong dates. So a numeric API date is safe ONLY when it
 * is byte-identical to the DOM cell (same format → same learned order applies).
 */
export function apiDateSafety(apiRaw: unknown, domRaw: string):
  | { safe: true; iso: string | null; byteEqual: boolean }
  | { safe: false; reason: string } {
  if (apiRaw == null || apiRaw === '') {
    return { safe: true, iso: null, byteEqual: false }; // empty → skip handled by caller
  }
  if (typeof apiRaw === 'number') {
    // Epoch / numeric date field — runtime generic_date can't parse it → the
    // required date would null out and rows would be rejected at runtime.
    return { safe: false, reason: 'numeric_date_field' };
  }
  if (typeof apiRaw !== 'string') return { safe: false, reason: 'non_string_date_field' };
  const s = apiRaw.trim();
  if (s === domRaw.trim()) return { safe: true, iso: null, byteEqual: true };
  const iso = parseIsoDate(s) ?? parseTextualDate(s);
  if (iso) return { safe: true, iso, byteEqual: false };
  return { safe: false, reason: 'ambiguous_numeric_date_format' };
}

/** Compare a DOM date cell against an API date value on a key-matched row. */
function compareDates(domRaw: string, apiRaw: unknown): 'pass' | 'fail' | 'skip' | 'unsafe' {
  const domTrim = domRaw.trim();
  const apiEmpty = apiRaw == null || apiRaw === '';
  if (domTrim === '' && apiEmpty) return 'skip';
  if (domTrim === '' || apiEmpty) return 'fail';
  const safety = apiDateSafety(apiRaw, domRaw);
  if (!safety.safe) return 'unsafe';
  if (safety.byteEqual) return 'pass';
  const domIso = parseIsoDate(domTrim) ?? parseTextualDate(domTrim);
  if (domIso) return domIso === safety.iso ? 'pass' : 'fail';
  const domInterps = numericDateInterpretations(domTrim);
  if (domInterps.length === 1) return domInterps[0] === safety.iso ? 'pass' : 'fail';
  if (domInterps.length > 1) {
    // DOM ambiguous (e.g. 06/10/2026): component-set equality on a row whose
    // identity is already key-proven.
    const a = dateComponents(domTrim);
    const b = safety.iso!.split('-').map(Number).sort((x, y) => x - y).join(',');
    return a === b ? 'pass' : 'fail';
  }
  return 'fail';
}

// ─── JSON walking ────────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface RowArrayCandidate {
  /** Dot-path from the response root to the array ('' = the root itself).
   *  Matches the ApiHint.jsonPath grammar — object keys only, no indices. */
  jsonPath: string;
  rows: Array<Record<string, unknown>>;
}

/**
 * Locate arrays-of-objects reachable through OBJECT keys only (the
 * ApiHint.jsonPath dot-path grammar can't address array indices, so anything
 * behind an array is unreachable at runtime and is not a candidate).
 */
export function findRowArrays(body: unknown, maxDepth = 4): RowArrayCandidate[] {
  const out: RowArrayCandidate[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (out.length >= 12) return;
    if (Array.isArray(node)) {
      if (node.length >= 1 && node.length <= 5000 && node.every(isPlainObject)) {
        out.push({ jsonPath: path, rows: node as Array<Record<string, unknown>> });
      }
      return; // can't path through an array
    }
    if (!isPlainObject(node) || depth > maxDepth) return;
    for (const [k, v] of Object.entries(node)) {
      visit(v, path === '' ? k : `${path}.${k}`, depth + 1);
    }
  };
  visit(body, '', 0);
  return out;
}

/** Dot-path getter (objects only — mirrors the documented columns contract). */
export function getByPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Re-extract the row array at a jsonPath using the SAME semantics the runtime
 * contract documents: explicit dot-path, or (when empty) the bare array /
 * rows|results|data envelope / single-object-as-1-row tolerance.
 */
export function extractRowsAtPath(body: unknown, jsonPath: string | undefined):
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; reason: string } {
  let val: unknown;
  if (jsonPath && jsonPath !== '') {
    val = getByPath(body, jsonPath);
  } else if (Array.isArray(body)) {
    val = body;
  } else if (isPlainObject(body)) {
    const obj = body;
    if (Array.isArray(obj.rows)) val = obj.rows;
    else if (Array.isArray(obj.results)) val = obj.results;
    else if (Array.isArray(obj.data)) val = obj.data;
    else val = [obj];
  } else {
    return { ok: false, reason: 'body_not_object_or_array' };
  }
  if (isPlainObject(val)) val = [val];
  if (!Array.isArray(val)) return { ok: false, reason: 'jsonpath_not_array' };
  if (val.length === 0) return { ok: false, reason: 'jsonpath_empty_array' };
  if (!val.every(isPlainObject)) return { ok: false, reason: 'rows_not_objects' };
  return { ok: true, rows: val as Array<Record<string, unknown>> };
}

/**
 * Envelope-decoy guard. Today's runtime unwrap tries top-level rows|results|
 * data BEFORE any jsonPath support lands (template-runner skeleton): a body
 * holding BOTH our verified array at a nested jsonPath AND an unrelated array
 * under one of those envelope keys would have the runtime ingest the WRONG —
 * never-verified — array. If such a decoy exists, abstain.
 */
export function findEnvelopeDecoy(body: unknown, jsonPath: string | undefined): string | null {
  if (!jsonPath || jsonPath === '') return null; // empty path = envelope semantics ARE the target
  if (!isPlainObject(body)) return null;
  const target = getByPath(body, jsonPath);
  for (const k of ['rows', 'results', 'data'] as const) {
    const v = body[k];
    if (Array.isArray(v) && v !== target) return k;
  }
  return null;
}

/** Apply a snake_case→dot-path columns mapping to raw rows. */
export function projectRows(
  rows: Array<Record<string, unknown>>,
  columns: Record<string, string>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [col, path] of Object.entries(columns)) {
      out[col] = getByPath(row, path);
    }
    return out;
  });
}

// ─── Same-site check (mirror of browser-utils/navigate.ts) ───────────────────

const MULTI_PART_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.au', 'org.au', 'net.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.za', 'org.za', 'gov.za',
  'com.br', 'net.br', 'org.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.mx', 'org.mx',
  'co.in', 'net.in',
  'com.sg', 'edu.sg',
  'com.hk', 'org.hk',
]);

function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(':')[0]!.split('.').filter(Boolean);
  if (labels.length < 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export function sameRegistrableDomain(hostA: string, hostB: string): boolean {
  return registrableDomain(hostA) === registrableDomain(hostB);
}

// ─── Request safety: session tokens, mutation verbs, headers ─────────────────

/** Identifier split: camelCase + separators → lowercase segments. */
function identSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const TOKEN_NAME_SUBSTRINGS = [
  'csrf', 'xsrf', 'viewstate', 'verificationtoken', 'authenticity',
  'jsession', 'phpsess', 'session', 'token',
];
const TOKEN_NAME_SEGMENTS = new Set(['auth', 'sid']);

/** A request whose URL/body carries a session-bound token replays statically
 *  and goes stale at session rotation — and a server that IGNORES the stale
 *  token can serve default-context (wrong) data. Abstain on any smell. */
export function findSessionTokenParam(url: string, body?: string | null): string | null {
  const names: string[] = [];
  try {
    const u = new URL(url);
    for (const k of u.searchParams.keys()) names.push(k);
    // ;jsessionid=... style path matrix params
    if (/;jsessionid=/i.test(u.pathname)) return 'jsessionid(path)';
  } catch { /* relative or odd URL — raw scan below still applies */ }
  if (/;jsessionid=/i.test(url)) return 'jsessionid(path)';
  if (body) {
    const t = body.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { collectJsonKeys(JSON.parse(t), names, 0); } catch { /* raw scan */ }
    } else if (/[^=&\s]+=[^&]*/.test(t)) {
      for (const pair of t.split('&')) {
        const k = pair.split('=')[0];
        if (k) names.push(decodeSafe(k));
      }
    }
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (TOKEN_NAME_SUBSTRINGS.some((sub) => lower.includes(sub))) return name;
    if (identSegments(name).some((seg) => TOKEN_NAME_SEGMENTS.has(seg))) return name;
  }
  return null;
}

function collectJsonKeys(node: unknown, out: string[], depth: number): void {
  if (depth > 4) return;
  if (Array.isArray(node)) { node.slice(0, 20).forEach((n) => collectJsonKeys(n, out, depth + 1)); return; }
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    out.push(k);
    collectJsonKeys(v, out, depth + 1);
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

const MUTATION_VERBS = new Set([
  'save', 'update', 'delete', 'create', 'insert', 'mark', 'ack', 'assign',
  'complete', 'submit', 'cancel', 'approve', 'add', 'remove', 'edit', 'set',
  'write', 'upsert', 'modify',
]);

/** POST endpoints whose path smells like a mutation are never replayed or
 *  emitted — a data QUERY that returns the feed rows shouldn't be named
 *  "save…". GETs are exempt (idempotent by convention). */
export function looksLikeMutation(method: string, url: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep raw */ }
  const segs = path.split('/').filter(Boolean);
  const tail = segs.slice(-2); // verbs live in the last segment or two
  return tail.some((seg) => identSegments(seg).some((w) => MUTATION_VERBS.has(w)));
}

const HEADER_KEEP = new Set(['accept', 'content-type', 'x-requested-with']);
const HEADER_ABSTAIN = /(authorization|api[-_]?key|csrf|xsrf|token|bearer|x-auth)/i;

export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  opts: { method: string; body?: string | null },
):
  | { ok: true; headers?: Record<string, string> }
  | { ok: false; reason: string } {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lower = k.toLowerCase();
    if (HEADER_ABSTAIN.test(lower)) {
      // The call depends on a short-lived credential we cannot keep fresh —
      // static replay WILL go stale. Abstain (cookie-session calls are fine:
      // the browser context carries cookies; we just never copy them).
      return { ok: false, reason: `auth_header_present:${lower}` };
    }
    if (HEADER_KEEP.has(lower)) kept[lower] = v;
  }
  const bodyTrim = (opts.body ?? '').trim();
  const jsonish = bodyTrim.startsWith('{') || bodyTrim.startsWith('[');
  if (opts.method.toUpperCase() === 'POST' && jsonish && !kept['content-type']) {
    // fetch-api.ts defaults string bodies to x-www-form-urlencoded; a JSON
    // body without its content-type would be sent mislabeled at runtime.
    return { ok: false, reason: 'json_post_missing_content_type' };
  }
  return { ok: true, headers: Object.keys(kept).length > 0 ? kept : undefined };
}

// ─── Date-param templating ───────────────────────────────────────────────────

// Cache-buster params (jQuery `_=`, `nocache=`…). The page adds these BECAUSE
// the endpoint is cache-prone — and the runtime fetch (extractors/fetch-api.ts)
// currently has no cache:'no-store', so a frozen buster value is a STABLE
// cache key: an HTTP cache could re-serve one captured rowset on every poll,
// silently and indefinitely. Until the runtime adds no-store (plumbing-chat
// one-liner, relayed), the only safe move for these endpoints is to ABSTAIN.
// Strong names abstain on any value; weak names (ts/t/r are too generic) only
// when the value is numeric (epoch/float — i.e. actually a buster).
const CACHE_BUSTER_STRONG = new Set(['_', '_t', 'cb', 'nocache', 'cachebuster', 'rnd', 'rand']);
const CACHE_BUSTER_WEAK = new Set(['ts', 't', 'r']);

function isCacheBusterParam(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (CACHE_BUSTER_STRONG.has(lower)) return true;
  return CACHE_BUSTER_WEAK.has(lower) && /^\d{6,}$|^\d+\.\d+$/.test(value);
}

/** 6-digit compact date (YYMMDD / MMDDYY / DDMMYY) with a 2015–2035 pivot
 *  year — only consulted for DATE-NAMED params, where a 6-digit number is far
 *  more likely a date than an id. */
function sixDigitPlausibleDate(raw: string): boolean {
  if (!/^\d{6}$/.test(raw)) return false;
  const a = +raw.slice(0, 2);
  const b = +raw.slice(2, 4);
  const c = +raw.slice(4, 6);
  const inRange = (y: number): boolean => y >= 2015 && y <= 2035;
  return (inRange(pivotYear(raw.slice(0, 2))) && toIsoDate(pivotYear(raw.slice(0, 2)), b, c) !== null)
    || (inRange(pivotYear(raw.slice(4, 6))) && toIsoDate(pivotYear(raw.slice(4, 6)), a, b) !== null)
    || (inRange(pivotYear(raw.slice(4, 6))) && toIsoDate(pivotYear(raw.slice(4, 6)), b, a) !== null);
}

const ID_NAME_RE = /(^|[._-])(id|ids|key|code|num|no)$|(id|key|code)s?$/i;

const DATEISH_SEGMENTS = ['date', 'day', 'from', 'to', 'start', 'end', 'begin', 'until', 'since', 'on', 'for', 'time'];

function isIdishName(name: string): boolean {
  const segs = identSegments(name);
  if (segs.some((s) => DATEISH_SEGMENTS.includes(s))) return false;
  return ID_NAME_RE.test(name) || segs.some((s) => ['id', 'ids', 'key', 'code', 'num', 'no'].includes(s));
}

function isDateishName(name: string): boolean {
  return identSegments(name).some((s) => DATEISH_SEGMENTS.includes(s));
}

/** Epoch seconds/ms that decodes to a calendar date in 2015–2035 — the range
 *  where a big number plausibly IS a date rather than an opaque id. */
function isPlausibleEpochDate(raw: string): boolean {
  if (!/^\d{10}$|^\d{13}$/.test(raw)) return false;
  const ms = epochToMs(raw);
  return ms >= Date.UTC(2015, 0, 1) && ms <= Date.UTC(2035, 11, 31);
}

interface DateHit {
  /** The matched substring. */
  text: string;
  /** {today:FORMAT} templates that render back to `text` on the anchor date.
   *  Empty → the substring is a real-looking date that is NOT the anchor. */
  formats: string[];
}

/** Derive the FORMAT token string from an observed date string + which ISO
 *  interpretation it equals. Returns null when the digits can't be mapped. */
export function deriveFormat(observed: string, anchorIso: string): string[] {
  const [ay, am, ad] = anchorIso.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  const t = observed.trim();

  const isoM = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoM && +isoM[1]! === ay && +isoM[2]! === am && +isoM[3]! === ad) out.push('YYYY-MM-DD');

  const sepM = t.match(/^(\d{1,4})([/.\-])(\d{1,2})\2(\d{1,4})$/);
  if (sepM) {
    const [, p0, sep, p1, p2] = sepM as unknown as [string, string, string, string, string];
    const tok = (digits: string, mTok: string): string =>
      digits.length === 2 ? mTok + mTok[0] : mTok; // 'MM'/'M', 'DD'/'D'
    const yTok = (digits: string): string | null =>
      digits.length === 4 ? 'YYYY' : digits.length === 2 ? 'YY' : null;
    const matchesYear = (digits: string): boolean =>
      digits.length === 4 ? +digits === ay : digits.length === 2 ? pivotYear(digits) === ay : false;
    // YMD
    if (p0.length >= 2 && matchesYear(p0) && +p1 === am && +p2 === ad) {
      const y = yTok(p0);
      if (y) out.push(`${y}${sep}${tok(p1, 'M')}${sep}${tok(p2, 'D')}`);
    }
    // MDY
    if (+p0 === am && +p1 === ad && matchesYear(p2)) {
      const y = yTok(p2);
      if (y) out.push(`${tok(p0, 'M')}${sep}${tok(p1, 'D')}${sep}${y}`);
    }
    // DMY
    if (+p0 === ad && +p1 === am && matchesYear(p2)) {
      const y = yTok(p2);
      if (y) out.push(`${tok(p0, 'D')}${sep}${tok(p1, 'M')}${sep}${y}`);
    }
  }

  if (/^\d{8}$/.test(t)) {
    const pad = (n: number): string => String(n).padStart(2, '0');
    if (t === `${ay}${pad(am)}${pad(ad)}`) out.push('YYYYMMDD');
    if (t === `${pad(am)}${pad(ad)}${ay}`) out.push('MMDDYYYY');
    if (t === `${pad(ad)}${pad(am)}${ay}`) out.push('DDMMYYYY');
  }
  if (/^\d{6}$/.test(t)) {
    const pad = (n: number): string => String(n).padStart(2, '0');
    const yy = pad(ay % 100);
    if (t === `${yy}${pad(am)}${pad(ad)}`) out.push('YYMMDD');
    if (t === `${pad(am)}${pad(ad)}${yy}`) out.push('MMDDYY');
    if (t === `${pad(ad)}${pad(am)}${yy}`) out.push('DDMMYY');
  }
  return [...new Set(out)];
}

/** Render a FORMAT token string at a given ISO date (mirror of the documented
 *  {today:FORMAT} grammar: tokens YYYY YY MM DD M D, non-alphabetic seps). */
export function renderDateFormat(format: string, isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return format.replace(/YYYY|YY|MM|DD|M|D/g, (tok) => {
    switch (tok) {
      case 'YYYY': return String(y).padStart(4, '0');
      case 'YY': return String(y % 100).padStart(2, '0');
      case 'MM': return String(m).padStart(2, '0');
      case 'M': return String(m);
      case 'DD': return String(d).padStart(2, '0');
      case 'D': return String(d);
      default: return tok;
    }
  });
}

/** Render an emitted template ({today:FORMAT} / bare {today}/{date}) at a
 *  concrete ISO date — used by the learn-time replay-confirm + probe. */
export function renderTemplateAtDate(template: string, isoDate: string): string {
  return template
    .replace(/\{today:([^}]+)\}/g, (_m, fmt: string) => renderDateFormat(fmt, isoDate))
    .replace(/\{today\}|\{date\}/g, isoDate);
}

/** ISO date arithmetic without wall-clock access (keeps this module pure). */
export function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Real-looking calendar date (year 2015–2035) that we'd have to treat as a
 *  query date. Used to ABSTAIN on non-anchor dates — a frozen date param is
 *  guaranteed-stale tomorrow. */
function isRealLookingDate(s: string): boolean {
  const iso = parseIsoDate(s);
  if (iso) return +iso.slice(0, 4) >= 2015 && +iso.slice(0, 4) <= 2035;
  for (const interp of numericDateInterpretations(s)) {
    const y = +interp.slice(0, 4);
    if (y >= 2015 && y <= 2035) return true;
  }
  if (/^\d{8}$/.test(s)) {
    const a = toIsoDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    const b = toIsoDate(+s.slice(4, 8), +s.slice(0, 2), +s.slice(2, 4));
    const c = toIsoDate(+s.slice(4, 8), +s.slice(2, 4), +s.slice(0, 2));
    for (const iso2 of [a, b, c]) {
      if (iso2 && +iso2.slice(0, 4) >= 2015 && +iso2.slice(0, 4) <= 2035) return true;
    }
  }
  return false;
}

// Stateless tokenizers — fresh RegExp per call (a shared /g regex carries
// lastIndex state across calls, a classic source of skipped matches).
const DATE_TOKEN_SRC = '\\d{4}-\\d{2}-\\d{2}|\\d{1,4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,4}|(?<![0-9])\\d{8}(?![0-9])';
const EPOCH_SRC = '(?<![0-9])(\\d{13}|\\d{10})(?![0-9])';

function findDateTokens(s: string): string[] {
  return [...s.matchAll(new RegExp(DATE_TOKEN_SRC, 'g'))].map((m) => m[0]!);
}

// Textual-month dates. The {today:FORMAT} grammar is numeric-only, so these
// can NEVER be templated — any real one in a request is a frozen query date →
// abstain (whether or not it's the anchor). Detection is deliberately WIDER
// than parseTextualDate: Oracle-stack PMSes render DD-MON-RR / DD-MON-YYYY
// ("10-JUN-26"), and a hyphenated form the scanner missed would replay frozen
// forever. parseTextualDate itself stays strict (whitespace forms only) —
// it must remain congruent with what the runtime's generic_date can parse.
const TEXTUAL_DATE_SRC =
  '[A-Za-z]{3,9}\\.?[\\s\\-./]*\\d{1,2}[,\\s\\-./]*\\d{2,4}' +
  '|\\d{1,2}[\\s\\-./]*[A-Za-z]{3,9}\\.?[,\\s\\-./]*\\d{2,4}';

/** Wide textual parse for SCANNING only (any of space - . / as separators,
 *  or none). Never used for value comparison — only to confirm a regex hit is
 *  a real calendar date before abstaining on it. */
function parseTextualDateWide(s: string): string | null {
  const t = s.trim();
  const mdY = t.match(/^([A-Za-z]{3,9})\.?[\s\-./]*(\d{1,2})[,\s\-./]*(\d{2,4})$/);
  if (mdY) {
    const mo = MONTHS[mdY[1]!.toLowerCase()];
    if (mo) return toIsoDate(mdY[3]!.length <= 2 ? pivotYear(mdY[3]!) : +mdY[3]!, mo, +mdY[2]!);
  }
  const dMY = t.match(/^(\d{1,2})[\s\-./]*([A-Za-z]{3,9})\.?[,\s\-./]*(\d{2,4})$/);
  if (dMY) {
    const mo = MONTHS[dMY[2]!.toLowerCase()];
    if (mo) return toIsoDate(dMY[3]!.length <= 2 ? pivotYear(dMY[3]!) : +dMY[3]!, mo, +dMY[1]!);
  }
  return null;
}

function findTextualDate(s: string): string | null {
  for (const m of s.matchAll(new RegExp(TEXTUAL_DATE_SRC, 'g'))) {
    const iso = parseTextualDateWide(m[0]!);
    if (iso) {
      const y = +iso.slice(0, 4);
      if (y >= 2015 && y <= 2035) return m[0]!;
    }
  }
  return null;
}

function findEpochTokens(s: string): string[] {
  return [...s.matchAll(new RegExp(EPOCH_SRC, 'g'))].map((m) => m[1]!);
}

function classifyDateToken(text: string, anchorIso: string): DateHit | null {
  const formats = deriveFormat(text, anchorIso);
  if (formats.length > 0) return { text, formats };
  if (isRealLookingDate(text)) return { text, formats: [] };
  return null;
}

function epochToMs(s: string): number {
  return s.length === 13 ? Number(s) : Number(s) * 1000;
}

function isEpochNearNow(ms: number, nowMs: number, windowMs: number): boolean {
  return Math.abs(ms - nowMs) <= windowMs;
}

export interface DateTemplatingResult {
  ok: boolean;
  reason?: string;
  url?: string;
  bodyTemplate?: string;
  /** Alternate render when a date's M/D order was ambiguous on the learn day
   *  (e.g. 06/06/2026) — the date-shift probe settles which is right. */
  altUrl?: string;
  altBodyTemplate?: string;
  templatedCount?: number;
}

/**
 * Template every date-like value in the request to {today:FORMAT} — or abstain.
 *
 * The invariant this enforces: an emitted request must contain ZERO concrete
 * dates. Any real-looking date ≠ anchor (a range end, a week start, a fixed
 * report date) cannot be re-templated and would silently serve a wrong window
 * forever → abstain. Epoch timestamps and textual-month dates can't be
 * expressed in the numeric {today} grammar at all → abstain; cache-buster
 * params → abstain until the runtime fetch gains cache:'no-store'.
 */
export function checkDateParams(input: {
  url: string;
  body?: string | null;
  anchorIso: string;
  nowMs: number;
}): DateTemplatingResult {
  const { anchorIso, nowMs } = input;
  let templated = 0;

  /** Replace anchor-date tokens with placeholders. Counts only on the primary
   *  pass so the alt render doesn't double-count. */
  const templateString = (s: string, useAlt: boolean, count: boolean): string =>
    s.replace(new RegExp(DATE_TOKEN_SRC, 'g'), (m) => {
      const hit = classifyDateToken(m, anchorIso);
      if (!hit || hit.formats.length === 0) return m;
      if (count) templated++;
      const fmt = useAlt && hit.formats.length > 1 ? hit.formats[1] : hit.formats[0];
      return `{today:${fmt}}`;
    });

  /** Any real-looking NON-anchor date anywhere → abstain (frozen = stale). */
  const scanForForeignDates = (s: string): string | null => {
    for (const tok of findDateTokens(s)) {
      const hit = classifyDateToken(tok, anchorIso);
      if (hit && hit.formats.length === 0) return tok;
    }
    return null;
  };

  // ── URL ── operate on the RAW query text so untouched params keep their
  // exact original encoding (round-tripping through searchParams would
  // re-encode values and mangle the literal {today:…} placeholders).
  let parsedUrl: URL;
  try { parsedUrl = new URL(input.url); } catch { return { ok: false, reason: 'unparseable_url' }; }
  const rawQuery = parsedUrl.search.startsWith('?') ? parsedUrl.search.slice(1) : parsedUrl.search;
  const rawPairs = rawQuery === '' ? [] : rawQuery.split('&');

  // Textual-month dates ("Jun 10, 2026") are untemplateable by the numeric
  // {today:FORMAT} grammar — a frozen one is guaranteed-stale → abstain. They
  // arrive percent/plus-encoded in URLs, so scan the DECODED views.
  {
    const textual = findTextualDate(decodeSafe(parsedUrl.pathname)) ?? findTextualDate(decodeSafe(rawQuery));
    if (textual) return { ok: false, reason: `textual_date_in_url:${textual.slice(0, 24)}` };
  }

  const outPairs: Array<{ raw: string } | { key: string; primary: string; alt?: string }> = [];
  for (const pair of rawPairs) {
    const eq = pair.indexOf('=');
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawVal = eq >= 0 ? pair.slice(eq + 1) : '';
    const key = decodeSafe(rawKey);
    const decodedVal = decodeSafe(rawVal);

    // Percent-encoded date (visible decoded, absent raw): the runtime renders
    // the placeholder as plain text — we can't guarantee the encoding the
    // server expects survives. Abstain.
    if (decodedVal !== rawVal) {
      for (const tok of findDateTokens(decodedVal)) {
        if (classifyDateToken(tok, anchorIso) && !rawVal.includes(tok)) {
          return { ok: false, reason: `encoded_date_param:${key}` };
        }
      }
    }

    // Cache-buster param → abstain (see CACHE_BUSTER_STRONG note: the runtime
    // fetch has no cache:'no-store' yet, so neither freezing NOR stripping a
    // buster is provably safe against HTTP-cache replay of one stale rowset).
    if (isCacheBusterParam(key, rawVal)) {
      return { ok: false, reason: `cache_buster_param:${key}` };
    }

    // Epoch-valued param.
    if (/^\d{10}$|^\d{13}$/.test(rawVal)) {
      const ms = epochToMs(rawVal);
      if (isEpochNearNow(ms, nowMs, 48 * 3_600_000)) {
        // A date/time filter in epoch form — the {today} grammar can't
        // express epochs, so this would replay frozen → stale. Abstain.
        return { ok: false, reason: `untemplateable_epoch_param:${key}` };
      }
      if (isDateishName(key) && isPlausibleEpochDate(rawVal)) {
        // A date-NAMED param holding a calendar-plausible epoch outside the
        // ±48h window (e.g. since=<Jan 1>): the page recomputes it fresh each
        // visit, a frozen replay drifts further from it every day. Abstain.
        return { ok: false, reason: `frozen_epoch_date_param:${key}` };
      }
      outPairs.push({ raw: pair });
      continue;
    }

    // Whole-value date param.
    const hit = classifyDateToken(rawVal, anchorIso);
    if (hit && hit.text === rawVal) {
      if (hit.formats.length === 0) return { ok: false, reason: `non_anchor_date_param:${key}` };
      if (isIdishName(key)) {
        // "reservationId=06102026" — almost certainly an ID colliding with
        // today's digits; templating it would corrupt every future request.
        return { ok: false, reason: `date_like_value_in_id_param:${key}` };
      }
      templated++;
      outPairs.push({
        key: rawKey,
        primary: `{today:${hit.formats[0]}}`,
        ...(hit.formats.length > 1 ? { alt: `{today:${hit.formats[1]}}` } : {}),
      });
      continue;
    }
    // 6-digit compact date in a date-NAMED param ("fromDate=250101") that is
    // NOT the anchor: a frozen window boundary → abstain. (Anchor-equal
    // 6-digit values were templated by the branch above.)
    if (isDateishName(key) && sixDigitPlausibleDate(rawVal)) {
      return { ok: false, reason: `six_digit_date_param:${key}` };
    }
    outPairs.push({ raw: pair });
  }

  // Foreign-date scan over the ORIGINAL path + query (anchor dates get
  // templated below; anything date-like that isn't the anchor abstains).
  {
    const foreignInUrl = scanForForeignDates(parsedUrl.pathname) ?? scanForForeignDates(rawQuery);
    if (foreignInUrl) return { ok: false, reason: `non_anchor_date_in_url:${foreignInUrl}` };
  }

  // Assemble: whole-value params were replaced above; anchor dates EMBEDDED in
  // compound raw values ("filter=arrivals:06/10/2026") and in the PATH
  // (/reports/2026-06-10/arrivals) are templated in place — leaving any of
  // them frozen would silently serve a stale window forever.
  const renderQuery = (useAlt: boolean, count: boolean): string =>
    outPairs
      .map((p) => ('raw' in p
        ? templateString(p.raw, useAlt, count)
        : `${p.key}=${useAlt && p.alt ? p.alt : p.primary}`))
      .join('&');

  const primaryQuery = renderQuery(false, true);
  const altQuery = renderQuery(true, false);
  const primaryPath = templateString(parsedUrl.pathname, false, true);
  const altPath = templateString(parsedUrl.pathname, true, false);

  const outUrl = `${parsedUrl.origin}${primaryPath}${primaryQuery === '' ? '' : `?${primaryQuery}`}${parsedUrl.hash}`;
  const outAltUrl = `${parsedUrl.origin}${altPath}${altQuery === '' ? '' : `?${altQuery}`}${parsedUrl.hash}`;

  for (const tok of findEpochTokens(outUrl)) {
    if (isEpochNearNow(epochToMs(tok), nowMs, 48 * 3_600_000)) {
      return { ok: false, reason: 'untemplateable_epoch_in_url' };
    }
  }

  // ── Body ──
  let outBody: string | undefined;
  let outAltBody: string | undefined;
  if (input.body != null && input.body !== '') {
    const body = input.body;

    // Percent-encoded dates hidden in the body.
    const decodedBody = decodeSafe(body);
    if (decodedBody !== body) {
      for (const tok of findDateTokens(decodedBody)) {
        if (classifyDateToken(tok, anchorIso) && !body.includes(tok)) {
          return { ok: false, reason: 'encoded_date_in_body' };
        }
      }
    }

    const foreign = scanForForeignDates(body);
    if (foreign) return { ok: false, reason: `non_anchor_date_in_body:${foreign}` };

    const textual = findTextualDate(body) ?? findTextualDate(decodedBody);
    if (textual) return { ok: false, reason: `textual_date_in_body:${textual.slice(0, 24)}` };

    // Named-param checks (urlencoded or JSON): id-named anchor dates + epochs.
    const t = body.trim();
    const pairs: Array<[string, string]> = [];
    if (t.startsWith('{') || t.startsWith('[')) {
      try { collectJsonStringPairs(JSON.parse(t), pairs, 0); } catch { /* raw scans still apply */ }
    } else if (/[^=&\s]+=[^&]*/.test(t)) {
      for (const pair of t.split('&')) {
        const eq = pair.indexOf('=');
        if (eq > 0) pairs.push([decodeSafe(pair.slice(0, eq)), decodeSafe(pair.slice(eq + 1))]);
      }
    }
    for (const [k, v] of pairs) {
      const hit = classifyDateToken(v, anchorIso);
      if (hit && hit.text === v && hit.formats.length > 0 && isIdishName(k)) {
        return { ok: false, reason: `date_like_value_in_id_body_param:${k}` };
      }
      if (isCacheBusterParam(k, v)) {
        return { ok: false, reason: `cache_buster_body_param:${k}` };
      }
      if (/^\d{10}$|^\d{13}$/.test(v) && isEpochNearNow(epochToMs(v), nowMs, 48 * 3_600_000)) {
        return { ok: false, reason: `untemplateable_epoch_body_param:${k}` };
      }
      if (isDateishName(k) && isPlausibleEpochDate(v)) {
        return { ok: false, reason: `frozen_epoch_date_body_param:${k}` };
      }
      if (isDateishName(k) && (!hit || hit.formats.length === 0) && sixDigitPlausibleDate(v)) {
        return { ok: false, reason: `six_digit_date_body_param:${k}` };
      }
    }

    outBody = templateString(body, false, true);
    outAltBody = templateString(body, true, false);

    for (const tok of findEpochTokens(outBody)) {
      if (isEpochNearNow(epochToMs(tok), nowMs, 48 * 3_600_000)) {
        return { ok: false, reason: 'untemplateable_epoch_in_body' };
      }
    }
  }

  return {
    ok: true,
    url: outUrl,
    ...(outBody !== undefined ? { bodyTemplate: outBody } : {}),
    ...(outAltUrl !== outUrl ? { altUrl: outAltUrl } : {}),
    ...(outAltBody !== undefined && outAltBody !== outBody ? { altBodyTemplate: outAltBody } : {}),
    templatedCount: templated,
  };
}

function collectJsonStringPairs(node: unknown, out: Array<[string, string]>, depth: number): void {
  if (depth > 4) return;
  if (Array.isArray(node)) { node.slice(0, 50).forEach((n) => collectJsonStringPairs(n, out, depth + 1)); return; }
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' || typeof v === 'number') out.push([k, String(v)]);
    else collectJsonStringPairs(v, out, depth + 1);
  }
}

// ─── Candidate prefilter (pure — zero LLM cost) ──────────────────────────────

export interface PrefilteredCandidate {
  call: CapturedCall;
  arrays: RowArrayCandidate[];
  score: number;
}

export function prefilterCandidates(input: {
  calls: CapturedCall[];
  domRows: Array<Record<string, string>>;
  keyColumn: string;
  loginUrl: string;
  feedPageUrl: string;
  max?: number;
}): { candidates: PrefilteredCandidate[]; skipped: Record<string, number> } {
  const { calls, domRows, keyColumn } = input;
  const max = input.max ?? 3;
  const skipped: Record<string, number> = {};
  const skip = (why: string): void => { skipped[why] = (skipped[why] ?? 0) + 1; };

  const domKeyVals = new Set(
    domRows.map((r) => normKey(r[keyColumn])).filter((v) => v !== ''),
  );
  if (domKeyVals.size === 0) return { candidates: [], skipped: { no_dom_keys: 1 } };

  let loginHost: string | null = null;
  let feedHost: string | null = null;
  try { loginHost = new URL(input.loginUrl).hostname; } catch { /* checked below */ }
  try { feedHost = new URL(input.feedPageUrl).hostname; } catch { /* checked below */ }

  const seen = new Set<string>();
  const out: PrefilteredCandidate[] = [];

  for (const call of calls) {
    const method = call.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST') { skip('method'); continue; }
    if (call.status < 200 || call.status >= 300) { skip('status'); continue; }
    if (call.responseBody == null) { skip('no_json_body'); continue; }

    let callHost: string;
    try { callHost = new URL(call.url).hostname; } catch { skip('bad_url'); continue; }
    // The runtime contract refuses cross-host endpoints relative to the LOGIN
    // URL; we additionally require same-site with the feed page (SSO setups
    // where they differ → abstain rather than emit something the runtime —
    // or worse, a confused server — handles differently).
    if (!loginHost || !sameRegistrableDomain(callHost, loginHost)) { skip('cross_host_login'); continue; }
    if (!feedHost || !sameRegistrableDomain(callHost, feedHost)) { skip('cross_host_feed'); continue; }

    if (findSessionTokenParam(call.url, call.requestBody)) { skip('session_token_param'); continue; }
    if (looksLikeMutation(method, call.url)) { skip('mutation_verb'); continue; }

    const dedupeKey = `${method} ${call.url} ${call.requestBody ?? ''}`;
    if (seen.has(dedupeKey)) { skip('duplicate'); continue; }
    seen.add(dedupeKey);

    const arrays = findRowArrays(call.responseBody)
      .filter((a) => a.rows.length >= domRows.length);
    if (arrays.length === 0) { skip('no_plausible_array'); continue; }

    const scored = arrays
      .map((a) => ({ a, s: keyOverlapScore(a.rows, domKeyVals) }))
      .filter(({ s }) => s >= 0.9)
      .sort((x, y) => y.s - x.s);
    if (scored.length === 0) { skip('low_key_overlap'); continue; }

    out.push({
      call,
      arrays: scored.slice(0, 2).map(({ a }) => a),
      score: scored[0]!.s,
    });
  }

  out.sort((a, b) =>
    b.score - a.score ||
    (a.call.method.toUpperCase() === 'GET' ? -1 : 1) - (b.call.method.toUpperCase() === 'GET' ? -1 : 1));
  return { candidates: out.slice(0, max), skipped };
}

/** Fraction of distinct DOM key values present among the candidate rows' leaf
 *  scalar values (depth ≤ 2 inside each row object). */
function keyOverlapScore(rows: Array<Record<string, unknown>>, domKeyVals: Set<string>): number {
  const leaves = new Set<string>();
  for (const row of rows.slice(0, 400)) {
    collectLeafScalars(row, leaves, 0);
  }
  let hits = 0;
  for (const k of domKeyVals) if (leaves.has(k)) hits++;
  return hits / domKeyVals.size;
}

function collectLeafScalars(node: unknown, out: Set<string>, depth: number): void {
  if (depth > 2) return;
  if (Array.isArray(node)) { node.slice(0, 10).forEach((n) => collectLeafScalars(n, out, depth + 1)); return; }
  if (isPlainObject(node)) {
    for (const v of Object.values(node)) collectLeafScalars(v, out, depth + 1);
    return;
  }
  if (node != null && (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean')) {
    out.add(normKey(node));
  }
}

// ─── The core reconcile ──────────────────────────────────────────────────────

export interface ReconcileInput {
  actionKey: keyof Recipe['actions'];
  /** Oracle rows scraped from the live DOM with the agent's selectors. */
  domRows: Array<Record<string, string>>;
  /** Candidate rows AFTER projection through the proposed columns mapping. */
  apiRows: Array<Record<string, unknown>>;
  /** Columns present in the proposed mapping (post contract-filter). */
  mappedColumns: string[];
  /** Agent-learned DOM raw→canonical enum mappings (per column). */
  domEnumMappings?: Record<string, Record<string, string>>;
  /** Per-column canonical enum value sets from the value contract. */
  enumValueSets?: Record<string, string[]>;
  /** ISO anchor date (the feed's business day) for the pagination exception. */
  anchorIso?: string | null;
  domTruncated?: boolean;
  /** 'learn' = strict; 'replay' = small drift tolerated (data moved between
   *  capture and the confirm fetch). */
  mode?: 'learn' | 'replay';
}

export interface ReconcileResult {
  reconciles: boolean;
  reason: string;
  keyColumn?: string;
  matchedCount?: number;
  surplus?: number;
  usedPaginationException?: boolean;
  /** Optional mapped columns that failed/were unverifiable — caller must drop
   *  them from the emitted mapping. */
  droppedOptionalColumns?: string[];
  /** API-raw→canonical additions needed for enum columns (beyond the raws
   *  that byte-match the DOM vocabulary). */
  derivedEnumMappings?: Record<string, Record<string, string>>;
  /** Required text columns accepted without value corroboration because every
   *  API value was redaction-masked (logged for transparency). */
  maskAcceptedColumns?: string[];
}

const fail = (reason: string): ReconcileResult => ({ reconciles: false, reason });

export function reconcileRows(input: ReconcileInput): ReconcileResult {
  const mode = input.mode ?? 'learn';
  const contract = CORE_TARGET_CONTRACTS[input.actionKey];
  if (!contract) return fail('not_core_target');
  const keyCol = DISCOVERY_KEY_COLUMNS[input.actionKey];
  if (!keyCol) return fail('no_key_column_for_target');
  if (!input.mappedColumns.includes(keyCol)) return fail('key_not_mapped');

  const { domRows, apiRows } = input;
  if (input.domTruncated) return fail('dom_truncated');
  if (domRows.length < MIN_ORACLE_ROWS) return fail('dom_too_small');
  if (apiRows.length === 0) return fail('api_empty');

  // ── Key quality ──
  const domKeys = domRows.map((r) => normKey(r[keyCol]));
  if (domKeys.some((k) => k === '')) return fail('dom_key_blank');
  if (new Set(domKeys).size !== domKeys.length) return fail('dom_key_not_distinct');
  if (isSequentialRun(domKeys)) return fail('dom_key_sequential_rownums');

  // ── DOM ⊆ API at 100% ──
  // Anything less is destructive: pms_work_orders_v2 uses reconcile-missing →
  // auto-resolved at the writer, so a DOM row absent from the API rowset would
  // CLOSE a real work order on the first poll.
  const apiKeyToIdx = new Map<string, number[]>();
  apiRows.forEach((r, i) => {
    const k = normKey(r[keyCol]);
    if (k === '') return;
    const arr = apiKeyToIdx.get(k) ?? [];
    arr.push(i);
    apiKeyToIdx.set(k, arr);
  });
  for (const [k, idxs] of apiKeyToIdx) {
    if (idxs.length > 1) return fail(`api_key_duplicates:${k.slice(0, 20)}`);
  }
  // The key column is text-typed in every core contract: numeric JSON key
  // values would match here (string-normalized) but be rejected row-by-row by
  // the writer's typeMatches at runtime → a verified-then-broken feed.
  const keySpec = contract.columns.find((c) => c.name === keyCol);
  if (keySpec?.type === 'text' && apiRows.some((r) => r[keyCol] != null && typeof r[keyCol] !== 'string')) {
    return fail('api_key_not_string');
  }

  const matchedPairs: Array<[number, number]> = [];
  let misses = 0;
  domKeys.forEach((k, domIdx) => {
    const idxs = apiKeyToIdx.get(k);
    if (idxs && idxs.length > 0) matchedPairs.push([domIdx, idxs[0]!]);
    else misses++;
  });
  if (mode === 'learn' && misses > 0) return fail(`dom_keys_missing_from_api:${misses}`);
  if (mode === 'replay') {
    if (misses > 2) return fail(`replay_drift_too_large:${misses}`);
    if (matchedPairs.length < 3) return fail('replay_too_few_matches');
  }

  // ── Count: bijective, or the bounded pagination exception ──
  const surplus = apiRows.length - matchedPairs.length;
  let usedPaginationException = false;
  const semanticDateCol = DISCOVERY_SEMANTIC_DATE_COLUMNS[input.actionKey];
  const replaySlack = mode === 'replay' ? Math.max(2, Math.ceil(domRows.length * 0.1)) : 0;

  if (surplus > replaySlack) {
    // The DOM may legitimately be paginated (showing 25 of 60). We accept an
    // API superset ONLY when the target has a semantic date column and EVERY
    // API row (matched and surplus alike) carries the anchor date — that's
    // what separates "the full today-page" from "this week" / "all bookings".
    if (!semanticDateCol) return fail(`api_superset_no_date_anchor:${surplus}`);
    if (!input.mappedColumns.includes(semanticDateCol)) return fail('api_superset_date_col_unmapped');
    if (!input.anchorIso) return fail('api_superset_no_anchor');

    const domDateRaws = new Set(domRows.map((r) => (r[semanticDateCol] ?? '').trim()));
    if (domDateRaws.size !== 1) return fail('pagination_dom_date_not_uniform');
    const domDateRaw = [...domDateRaws][0]!;
    // An ambiguous numeric DOM date is fine HERE as long as the anchor is one
    // of its readings — the caller derived the anchor from this very value by
    // matching it against the wall-clock today.
    const direct = parseIsoDate(domDateRaw) ?? parseTextualDate(domDateRaw);
    const domInterps = direct ? [direct] : numericDateInterpretations(domDateRaw);
    if (!domInterps.includes(input.anchorIso)) return fail('pagination_dom_date_not_anchor');

    for (const r of apiRows) {
      const safety = apiDateSafety(r[semanticDateCol], domDateRaw);
      if (!safety.safe) return fail('pagination_api_date_unsafe');
      const rowIso: string | null = safety.byteEqual ? (input.anchorIso ?? null) : safety.iso;
      if (rowIso !== input.anchorIso) return fail('pagination_api_date_mismatch');
    }
    usedPaginationException = true;
  }

  // ── Per-column, parser-exact corroboration over matched pairs ──
  const colByName = new Map<string, CoreColumn>(contract.columns.map((c) => [c.name, c]));
  const dropped: string[] = [];
  const maskAccepted: string[] = [];
  const derivedEnums: Record<string, Record<string, string>> = {};
  let verifiedNonKeyCols = 0;
  let verifiedNonUniformCols = 0;

  for (const col of input.mappedColumns) {
    if (col === keyCol) continue;
    const spec = colByName.get(col);
    if (!spec) return fail(`mapped_column_not_in_contract:${col}`);
    const enumValues = input.enumValueSets?.[col];

    if (enumValues && enumValues.length > 0) {
      const verdict = corroborateEnumColumn({
        col, matchedPairs, domRows, apiRows,
        domMapping: input.domEnumMappings?.[col],
        canonical: enumValues,
      });
      if (!verdict.ok) {
        if (spec.required) return fail(verdict.reason);
        dropped.push(col);
        continue;
      }
      if (Object.keys(verdict.derived).length > 0) derivedEnums[col] = verdict.derived;
      if (verdict.corroborated) {
        verifiedNonKeyCols++;
        if (verdict.nonUniform) verifiedNonUniformCols++;
      }
      continue;
    }

    const verdict = corroborateColumn({ col, type: spec.type, matchedPairs, domRows, apiRows });
    if (verdict.kind === 'verified') {
      verifiedNonKeyCols++;
      if (verdict.nonUniform) verifiedNonUniformCols++;
      continue;
    }
    if (verdict.kind === 'mask_skipped') {
      if (spec.required) maskAccepted.push(col);
      else dropped.push(col);
      continue;
    }
    if (verdict.kind === 'unverifiable') {
      if (spec.required) return fail(`required_column_unverifiable:${col}`);
      dropped.push(col);
      continue;
    }
    // 'failed'
    if (spec.required) return fail(`required_column_mismatch:${col}`);
    dropped.push(col);
  }

  // A key match alone is not enough — at least one independent column must
  // corroborate the rows are the SAME records, not just records that share
  // identifiers (e.g. a rooms-list endpoint vs the room-status feed).
  if (verifiedNonKeyCols < 1) return fail('no_corroborating_columns');
  // …and a SINGLE corroborating column whose value was identical on every row
  // (all rooms "Clean" at 3pm) is a coincidence-at-snapshot, not proof — a
  // perfectly-correlated wrong column passes it. Require either a second
  // verified column or at least one column whose values actually varied.
  if (verifiedNonKeyCols === 1 && verifiedNonUniformCols === 0) {
    return fail('corroboration_uniform_only');
  }

  // Every required contract column must be in the mapping at all (a feed
  // missing a required column writes 0 rows at runtime — keep the DOM recipe
  // and its park_draft path instead of emitting a broken api recipe).
  for (const c of contract.columns) {
    if (c.required && !input.mappedColumns.includes(c.name)) {
      return fail(`required_column_not_mapped:${c.name}`);
    }
  }

  return {
    reconciles: true,
    reason: 'ok',
    keyColumn: keyCol,
    matchedCount: matchedPairs.length,
    surplus,
    usedPaginationException,
    ...(dropped.length > 0 ? { droppedOptionalColumns: dropped } : {}),
    ...(Object.keys(derivedEnums).length > 0 ? { derivedEnumMappings: derivedEnums } : {}),
    ...(maskAccepted.length > 0 ? { maskAcceptedColumns: maskAccepted } : {}),
  };
}

/** Rownum smell: a key column of 0/1-based consecutive integers is almost
 *  certainly a display row number, not an identifier. Real-world sequential
 *  ids that START HIGHER (room numbers 101..106) are legitimate keys. */
function isSequentialRun(keys: string[]): boolean {
  const nums = keys.map((k) => (/^\d+$/.test(k) ? Number(k) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return false;
  const sorted = [...nums].sort((a, b) => a - b);
  if (sorted[0]! > 1) return false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! !== 1) return false;
  }
  return true;
}

type ColumnVerdict = 'verified' | 'failed' | 'unverifiable' | 'mask_skipped';

function corroborateColumn(args: {
  col: string;
  type: CoreColumn['type'];
  matchedPairs: Array<[number, number]>;
  domRows: Array<Record<string, string>>;
  apiRows: Array<Record<string, unknown>>;
}): { kind: ColumnVerdict; nonUniform: boolean } {
  const { col, type } = args;
  let passes = 0;
  let fails = 0;
  let masked = 0;
  // Distinct DOM values among PASSING pairs — a column that corroborated with
  // the same value on every row is weak evidence (snapshot coincidence).
  const passedDomValues = new Set<string>();

  const parserName =
    type === 'integer' ? 'generic_integer'
    : type === 'bigint' ? (col.endsWith('_cents') ? 'generic_currency' : 'generic_integer')
    : type === 'numeric' ? 'generic_number'
    : type === 'boolean' ? 'generic_boolean'
    : null;

  const verdictOf = (kind: ColumnVerdict): { kind: ColumnVerdict; nonUniform: boolean } =>
    ({ kind, nonUniform: passedDomValues.size >= 2 });

  for (const [domIdx, apiIdx] of args.matchedPairs) {
    const domRaw = args.domRows[domIdx]![col] ?? '';
    const apiRaw = args.apiRows[apiIdx]![col];

    if (type === 'date') {
      const r = compareDates(domRaw, apiRaw);
      if (r === 'unsafe') return verdictOf('failed'); // runtime would misparse → never emit
      if (r === 'pass') { passes++; passedDomValues.add(domRaw.trim()); }
      else if (r === 'fail') fails++;
      continue;
    }

    if (parserName) {
      const domEmpty = domRaw.trim() === '';
      const apiEmpty = apiRaw == null || apiRaw === '';
      if (domEmpty && apiEmpty) continue;
      const a = applyParser(parserName, domRaw);
      const b = applyParser(parserName, apiRaw);
      if (a == null && b == null) continue;
      if (a != null && b != null && a === b) { passes++; passedDomValues.add(String(a)); }
      else fails++;
      continue;
    }

    // text columns — writer's typeMatches requires strings; numbers would
    // reject whole rows at runtime.
    const domEmpty = domRaw.trim() === '';
    const apiEmpty = apiRaw == null || apiRaw === '';
    if (domEmpty && apiEmpty) continue;
    if (apiEmpty || domEmpty) { fails++; continue; }
    if (typeof apiRaw !== 'string') { fails++; continue; }
    if (looksMasked(apiRaw)) { masked++; continue; }
    const a = normTextLoose(domRaw);
    const b = normTextLoose(apiRaw);
    if (a === b || sortedTokens(domRaw) === sortedTokens(apiRaw)) { passes++; passedDomValues.add(a); }
    else fails++;
  }

  if (fails > 0) return verdictOf('failed');
  if (passes > 0) return verdictOf('verified');
  if (masked > 0) return verdictOf('mask_skipped');
  return verdictOf('unverifiable');
}

function corroborateEnumColumn(args: {
  col: string;
  matchedPairs: Array<[number, number]>;
  domRows: Array<Record<string, string>>;
  apiRows: Array<Record<string, unknown>>;
  domMapping: Record<string, string> | undefined;
  canonical: string[];
}):
  | { ok: true; derived: Record<string, string>; corroborated: boolean; nonUniform: boolean }
  | { ok: false; reason: string } {
  const { col } = args;
  const domMapNorm = new Map<string, string>();
  for (const [raw, canon] of Object.entries(args.domMapping ?? {})) {
    domMapNorm.set(normEnumKey(raw), canon);
  }
  const canonicalSet = new Set(args.canonical);

  const derived = new Map<string, string>(); // apiRawNorm → canonical
  const derivedOriginal = new Map<string, string>(); // apiRawNorm → original api raw
  const derivedCanonCounts = new Map<string, number>();
  const comparedDomNorms = new Set<string>();
  let byteMatches = 0;
  let comparable = 0;

  for (const [domIdx, apiIdx] of args.matchedPairs) {
    const domRaw = (args.domRows[domIdx]![col] ?? '').trim();
    const apiVal = args.apiRows[apiIdx]![col];
    const apiEmpty = apiVal == null || apiVal === '';
    if (domRaw === '' && apiEmpty) continue;
    if (domRaw === '' || apiEmpty) return { ok: false, reason: `enum_presence_mismatch:${col}` };
    if (typeof apiVal === 'object') return { ok: false, reason: `enum_non_scalar:${col}` };
    const apiRaw = String(apiVal).trim();
    if (looksMasked(apiRaw)) continue;
    comparable++;

    const domNorm = normEnumKey(domRaw);
    comparedDomNorms.add(domNorm);
    const apiNorm = normEnumKey(apiRaw);
    if (domNorm === apiNorm) { byteMatches++; continue; }

    // Different vocabulary on the API side. We can derive apiRaw→canonical
    // through the pairing — but only via the agent's learned DOM mapping
    // (never inventing canonicals).
    const canon = domMapNorm.get(domNorm);
    if (!canon || !canonicalSet.has(canon)) {
      return { ok: false, reason: `enum_dom_raw_unlearned:${col}` };
    }
    // Contradiction: the API uses a raw the AGENT already learned, but the
    // pairing maps it elsewhere — strong wrong-column smell (e.g. an
    // occupancy flag column masquerading as cleanliness status).
    const domMeaning = domMapNorm.get(apiNorm);
    if (domMeaning && domMeaning !== canon) {
      return { ok: false, reason: `enum_contradiction:${col}` };
    }
    const prior = derived.get(apiNorm);
    if (prior && prior !== canon) return { ok: false, reason: `enum_inconsistent:${col}` };
    if (!prior) {
      derived.set(apiNorm, canon);
      derivedOriginal.set(apiNorm, apiRaw);
    }
    derivedCanonCounts.set(canon, (derivedCanonCounts.get(canon) ?? 0) + 1);
  }

  if (comparable === 0) {
    // No usable pairs — for an enum we can't verify the column at all.
    return { ok: false, reason: `enum_unverifiable:${col}` };
  }

  if (derived.size > 0) {
    // Diversity gate: a single perfectly-correlated canonical (all rooms
    // "occupied" at 3pm) is consistent-but-unproven. Require ≥2 distinct
    // canonicals each observed ≥2 times before trusting a derived vocabulary.
    const canons = [...derivedCanonCounts.entries()];
    if (canons.length < 2 || canons.some(([, n]) => n < 2)) {
      return { ok: false, reason: `enum_derivation_low_diversity:${col}` };
    }
  }

  // Coverage: every API row's value (incl. pagination-surplus rows the runtime
  // WILL ingest) must resolve through dom-vocabulary or the derived additions —
  // otherwise required statuses null out at runtime and rows get dropped.
  for (const r of args.apiRows) {
    const v = r[col];
    if (v == null || v === '') continue;
    if (typeof v === 'object') return { ok: false, reason: `enum_non_scalar:${col}` };
    const s = String(v).trim();
    if (looksMasked(s)) continue;
    const n = normEnumKey(s);
    if (!domMapNorm.has(n) && !derived.has(n)) {
      return { ok: false, reason: `enum_uncovered_value:${col}` };
    }
  }

  const out: Record<string, string> = {};
  for (const [apiNorm, canon] of derived) out[derivedOriginal.get(apiNorm)!] = canon;
  return {
    ok: true,
    derived: out,
    corroborated: byteMatches + derived.size > 0,
    nonUniform: comparedDomNorms.size >= 2,
  };
}
