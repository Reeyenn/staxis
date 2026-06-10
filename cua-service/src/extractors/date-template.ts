/**
 * Date-placeholder rendering for learned structured sources (Chat 1 plumbing).
 *
 * A learned api/csv endpoint was captured with a CONCRETE date in its URL or
 * POST body (e.g. `?start=06%2F09%2F2026`). The mapper normalizes that to a
 * `{today}` / `{date}` placeholder (see ApiHint in types.ts). If the runtime
 * ever sent a frozen date, the endpoint would silently return YESTERDAY's
 * data forever — the stale-date guard. So rendering happens AT FETCH TIME,
 * on every poll, never at template-build time.
 *
 * Placeholder grammar (100% PMS-agnostic):
 *   {today}              today's date, format resolved below
 *   {date}               alias of {today} (the poll runtime always wants "now")
 *   {today:MM/DD/YYYY}   explicit format — tokens YYYY YY MM DD M D, any
 *                        literal separators. Use when the mapper knows the
 *                        exact format the endpoint was captured with.
 *
 * Format resolution for the bare form: explicit token format (none) →
 * learned PMS-wide date format (LearnedDateFormat, high confidence only) →
 * ISO `YYYY-MM-DD`.
 *
 * Timezone: the hotel's business date, not UTC — Fly machines run UTC, so
 * `new Date().toISOString()` would flip to tomorrow at ~6-7pm US time and
 * ask the PMS for the wrong day all evening. Resolution: opts.timezone →
 * env CUA_PMS_TZ → America/Chicago (the same default cost-cap.ts uses;
 * per-hotel TZ can be threaded through `extra.timezone` when available).
 *
 * Encoding: a rendered date may contain `/` (e.g. MDY). In a URL or a
 * form-encoded body the capture would have carried `%2F`, so we
 * encodeURIComponent there; inside a JSON body, encoding would corrupt the
 * payload, so the value is substituted raw.
 */

import type { LearnedDateFormat } from '../types.js';

export type DateRenderContext = 'url' | 'json' | 'form';

export interface RenderDateOptions {
  /** IANA timezone for "today". Falls back env CUA_PMS_TZ → America/Chicago. */
  timezone?: string;
  /** Learned PMS-wide date format (knowledge file). Used for bare {today}. */
  learnedFormat?: LearnedDateFormat;
  /** Where the rendered value lands — drives percent-encoding. */
  context: DateRenderContext;
  /** Injectable clock for tests. Defaults to the real current time. */
  now?: Date;
}

const PLACEHOLDER_RE = /\{(today|date)(?::([^}]+))?\}/g;

const DEFAULT_TZ = 'America/Chicago';

/** Today's calendar date parts in the given IANA timezone. */
export function todayParts(timezone: string, now: Date = new Date()): {
  year: string; month: string; day: string;
} {
  // en-CA reliably formats as YYYY-MM-DD (the codebase-wide todayInTimezone
  // pattern — session-driver.ts / memory-monitor.ts).
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [year, month, day] = iso.split('-');
  return { year: year!, month: month!, day: day! };
}

/** Render one date value according to an explicit token format string.
 *  Tokens: YYYY, YY, MM, DD, M, D. Everything else is a literal. */
function renderTokenFormat(fmt: string, p: { year: string; month: string; day: string }): string {
  return fmt
    .replace(/YYYY/g, p.year)
    // 2-digit year AFTER the 4-digit form so "YYYY" never half-matches —
    // plenty of PMS report URLs carry e.g. `start=06/10/26`.
    .replace(/YY/g, p.year.slice(-2))
    .replace(/MM/g, p.month)
    .replace(/DD/g, p.day)
    // Single-token forms AFTER the double forms so "MM" never half-matches.
    .replace(/M/g, String(Number(p.month)))
    .replace(/D/g, String(Number(p.day)));
}

/** Render per the learned PMS-wide format (order + separator). */
function renderLearnedFormat(
  learned: LearnedDateFormat,
  p: { year: string; month: string; day: string },
): string {
  const sep = learned.separator ?? '/';
  switch (learned.order) {
    case 'MDY': return [p.month, p.day, p.year].join(sep);
    case 'DMY': return [p.day, p.month, p.year].join(sep);
    case 'YMD': return [p.year, p.month, p.day].join(sep);
  }
}

/** Resolve the date string for ONE placeholder occurrence. */
function resolveDateValue(
  explicitFormat: string | undefined,
  opts: RenderDateOptions,
): string {
  const tz = opts.timezone || process.env.CUA_PMS_TZ || DEFAULT_TZ;
  const parts = todayParts(tz, opts.now ?? new Date());

  if (explicitFormat && explicitFormat.trim() !== '') {
    return renderTokenFormat(explicitFormat, parts);
  }
  // Bare {today}: trust the learned PMS format only when the mapper was
  // confident about the order — a low-confidence (all-ambiguous samples)
  // guess of MDY vs DMY is a coin flip we must not bake into a request.
  if (opts.learnedFormat && opts.learnedFormat.confidence === 'high') {
    return renderLearnedFormat(opts.learnedFormat, parts);
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Replace every {today}/{date} placeholder in `input` with the current
 * date, computed at CALL time. Strings without placeholders pass through
 * untouched (cheap + idempotent — safe to call at multiple layers).
 */
export function renderDatePlaceholders(input: string, opts: RenderDateOptions): string {
  if (!input || !input.includes('{')) return input;
  return input.replace(PLACEHOLDER_RE, (_m, _name: string, fmt: string | undefined) => {
    const value = resolveDateValue(fmt, opts);
    return opts.context === 'json' ? value : encodeURIComponent(value);
  });
}

/** True when a string still carries an unrendered date placeholder. */
export function hasDatePlaceholder(input: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(input);
}

/**
 * Frozen-date detector: does a query/body VALUE look like a full calendar
 * date literal? Used to warn when a learned url/body carries a concrete
 * mapping-day date the mapper failed to turn into a {today} placeholder —
 * that feed silently re-fetches mapping day forever. Deliberately
 * conservative (4-digit-year shapes only, value positions only) so version
 * strings ("v2.1.3") and numeric ids don't trip it.
 */
const DATE_LITERAL_VALUE_RE =
  /(?:^|[=&?,;{[:\s"'])(\d{4}-\d{2}-\d{2}|\d{1,2}(?:\/|%2F|\.|-)\d{1,2}(?:\/|%2F|\.|-)\d{4})(?=$|[&,;\s"'}\]&])/i;

export function looksLikeLiteralDateValue(input: string): boolean {
  if (!input) return false;
  return DATE_LITERAL_VALUE_RE.test(input);
}

/**
 * Render placeholders inside a request body. Strings render directly
 * (JSON-looking bodies render raw; form-encoded bodies render encoded);
 * object bodies (legacy knowledge-file feeds) render every string LEAF
 * recursively (nested filter objects like {filter:{start:'{today}'}} are
 * common in JSON APIs) — they get JSON.stringify'd by the fetch layer.
 */
export function renderBodyDatePlaceholders(
  body: string | Record<string, unknown> | undefined,
  opts: Omit<RenderDateOptions, 'context'>,
): string | Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    return renderDatePlaceholders(body, { ...opts, context: isJson ? 'json' : 'form' });
  }
  return renderValueDeep(body, opts, 0) as Record<string, unknown>;
}

/** Depth cap for body recursion — captured request bodies are shallow; a
 *  pathological self-referencing object must not stack-overflow a poll. */
const MAX_BODY_DEPTH = 8;

function renderValueDeep(
  value: unknown,
  opts: Omit<RenderDateOptions, 'context'>,
  depth: number,
): unknown {
  if (typeof value === 'string') {
    return renderDatePlaceholders(value, { ...opts, context: 'json' });
  }
  if (depth >= MAX_BODY_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderValueDeep(v, opts, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = renderValueDeep(v, opts, depth + 1);
  }
  return out;
}
