/**
 * URL template inference for drill-down mapper targets (Plan v7).
 *
 * When the mapper drills into N sample records of a list (e.g. 3 sample
 * reservations to learn the guest profile page), each drill produces a
 * concrete URL like `/Reservation/view?id=ABC123`. Runtime needs a
 * TEMPLATE (`/Reservation/view?id={pms_reservation_id}`), not the literal
 * sample URLs, so we can substitute any reservation's id at extract time.
 *
 * Algorithm:
 *   1. Parse each URL into path segments + query params.
 *   2. For each component, mark it as either INVARIANT (same across all
 *      samples) or VARIABLE (differs).
 *   3. Each variable component becomes a placeholder named after the
 *      list-column whose value matches it (best-effort heuristic).
 *
 * Limitations:
 *   - Two samples is too few — we need ≥ 3 to confidently distinguish
 *     "always varies" from "happens to differ in this pair".
 *   - URL-encoded segments are treated as opaque (no fancy decoding).
 *   - Hash fragments are dropped (PMSes rarely use them for routing).
 *
 * Codex v2 hard-pass surfaced this as P0 missing.
 */

import { log } from './log.js';

export interface UrlTemplateInferenceResult {
  /** True iff at least one variable component was identified. */
  ok: boolean;
  /** The templated URL (e.g. `/Reservation/view?id={var_0}`). Empty if !ok. */
  template: string;
  /** Map: placeholder name → list of sample values observed for it.
   *  Caller maps placeholders to list-column names by matching values
   *  to columns in the row that produced each sample URL. */
  placeholders: Record<string, string[]>;
  /** Human-readable reason if ok=false. */
  reason?: string;
}

/**
 * Infer a template from N sample URLs. Returns ok=false when:
 *   - fewer than MIN_SAMPLES URLs supplied,
 *   - URLs have different paths (can't template across distinct routes),
 *   - URLs have different param keys (one has ?id=, another has ?reservation=),
 *   - no component varied (all samples were identical — caller likely sent dups).
 */
export function inferUrlTemplate(sampleUrls: string[]): UrlTemplateInferenceResult {
  const MIN_SAMPLES = 3;
  if (sampleUrls.length < MIN_SAMPLES) {
    return {
      ok: false,
      template: '',
      placeholders: {},
      reason: `need ≥ ${MIN_SAMPLES} sample URLs, got ${sampleUrls.length}`,
    };
  }

  // Parse all samples upfront. We accept relative URLs by giving them a
  // dummy origin — only the path + search are used for inference.
  let parsed: URL[];
  try {
    parsed = sampleUrls.map((u) => new URL(u, 'https://_dummy.invalid'));
  } catch (err) {
    return {
      ok: false,
      template: '',
      placeholders: {},
      reason: `URL parse failed: ${(err as Error).message}`,
    };
  }

  // ── Path segments ───────────────────────────────────────────────────
  const pathSegmentLists = parsed.map((u) =>
    u.pathname.split('/').filter((s) => s !== ''),
  );
  const segmentLengths = new Set(pathSegmentLists.map((segs) => segs.length));
  if (segmentLengths.size !== 1) {
    return {
      ok: false,
      template: '',
      placeholders: {},
      reason: `path lengths differ across samples: ${[...segmentLengths].join(', ')}`,
    };
  }
  const segCount = pathSegmentLists[0]!.length;

  const placeholders: Record<string, string[]> = {};
  let varCounter = 0;

  const templatePathParts: string[] = [];
  for (let i = 0; i < segCount; i++) {
    const valuesAtPos = pathSegmentLists.map((segs) => segs[i]!);
    const unique = new Set(valuesAtPos);
    if (unique.size === 1) {
      templatePathParts.push(valuesAtPos[0]!);
    } else {
      const placeholder = `var_${varCounter++}`;
      templatePathParts.push(`{${placeholder}}`);
      placeholders[placeholder] = valuesAtPos;
    }
  }
  const templatePath = '/' + templatePathParts.join('/');

  // ── Query params ────────────────────────────────────────────────────
  // Require identical param keys across samples — if one URL has ?id= and
  // another has ?resvId=, that's two different routes, not one template.
  const paramKeyLists = parsed.map((u) =>
    [...u.searchParams.keys()].sort().join(','),
  );
  if (new Set(paramKeyLists).size !== 1) {
    return {
      ok: false,
      template: '',
      placeholders: {},
      reason: `query-param keys differ across samples: ${[...new Set(paramKeyLists)].join(' vs ')}`,
    };
  }

  const sampleParams = parsed[0]!.searchParams;
  const templateQueryEntries: string[] = [];
  for (const key of [...sampleParams.keys()].sort()) {
    const valuesAtKey = parsed.map((u) => u.searchParams.get(key) ?? '');
    const unique = new Set(valuesAtKey);
    if (unique.size === 1) {
      templateQueryEntries.push(`${key}=${valuesAtKey[0]}`);
    } else {
      const placeholder = `var_${varCounter++}`;
      templateQueryEntries.push(`${key}={${placeholder}}`);
      placeholders[placeholder] = valuesAtKey;
    }
  }
  const templateQuery = templateQueryEntries.length > 0 ? '?' + templateQueryEntries.join('&') : '';

  if (varCounter === 0) {
    return {
      ok: false,
      template: '',
      placeholders: {},
      reason: 'no variable components found — all samples had identical URLs',
    };
  }

  return {
    ok: true,
    template: templatePath + templateQuery,
    placeholders,
  };
}

/**
 * Given an inferred template + per-sample list-row data, name each
 * placeholder after the list column whose value matches the sample value.
 *
 * Example: sample URLs varied in `var_0` (values ABC, DEF, GHI). The list
 * row data for those samples had `reservation_id: ABC/DEF/GHI`. Mapping:
 *   { var_0: 'reservation_id' }
 *
 * Then caller swaps var_0 → pms_reservation_id in the final template:
 *   /Reservation/view?id={pms_reservation_id}
 */
export function mapPlaceholdersToColumns(
  placeholders: Record<string, string[]>,
  sampleRowData: Array<Record<string, string>>,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [placeholder, observedValues] of Object.entries(placeholders)) {
    // For each column in the row data, check if its values match the
    // observed placeholder values 1:1 across all samples.
    if (sampleRowData.length === 0) continue;
    const candidateColumns = Object.keys(sampleRowData[0]!);
    // Collect EVERY column whose values match, not just the first. With an
    // ambiguous id column (e.g. both `reservation_id` and a numeric `seq`
    // happen to share the same sample values), picking the first match
    // could silently bind the template to the wrong field. We prefer an
    // id-looking column and warn so a wrong binding is never fully silent.
    const matches: string[] = [];
    for (const col of candidateColumns) {
      const colValues = sampleRowData.map((row) => row[col] ?? '');
      if (colValues.length === observedValues.length &&
          colValues.every((v, i) => v === observedValues[i])) {
        matches.push(col);
      }
    }
    if (matches.length === 0) {
      // No column matched — leave the placeholder unnamed; caller can
      // surface as a warning ("URL has a var we can't map to a known field").
      continue;
    }
    // Prefer a column whose name looks like the record key (ends with
    // `_id`, or mentions reservation/confirmation). Falls back to the first
    // match (preserving prior behaviour) when nothing looks id-like.
    const looksLikeId = (c: string) =>
      /(_id$|reservation|confirmation)/i.test(c);
    const chosen = matches.find(looksLikeId) ?? matches[0]!;
    if (matches.length > 1) {
      log.warn('url-template: placeholder matched multiple columns; ambiguous binding', {
        placeholder,
        candidates: matches,
        chosen,
      });
    }
    mapping[placeholder] = chosen;
  }
  return mapping;
}

/**
 * Substitute placeholder values into a template URL. Used by:
 *   - mapper's 4th-sample verification (drills with a substituted URL to
 *     confirm the template works),
 *   - runtime drill-down (substitutes a row's column values to get the
 *     concrete detail URL).
 *
 * Missing values throw — caller must validate inputs upstream.
 */
export function substituteTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (!(name in values)) {
      throw new Error(`substituteTemplate: missing value for placeholder {${name}}`);
    }
    return encodeURIComponent(values[name]!);
  });
}

/** Placeholder names appearing in a template (deduped, in order). */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!))];
}

// ─── Single-sample templating (feature/cua-column-recovery) ─────────────────
//
// inferUrlTemplate needs ≥3 samples; column recovery drills exactly ONE record
// (cost cap). With one URL nothing "varies", so instead we ANCHOR: find URL
// components that exactly equal the clicked row's known column values and
// replace them with {column} placeholders. Conservative by construction:
//   - only WHOLE path segments / WHOLE query-param values match (a room "101"
//     inside a session token can never anchor);
//   - values shorter than MIN_ANCHOR_VALUE_LEN never anchor;
//   - a value shared by two different columns is ambiguous → fail;
//   - the target's KEY column MUST be among the placeholders — a template
//     parameterized only by room/date/status fetches the WRONG record for
//     sibling rows (plan review: Codex #6);
//   - any UNMATCHED component that looks like a date fails the whole template:
//     a frozen day-scoped param verifies today and silently serves wrong/empty
//     detail pages from tomorrow (plan review: Claude #8).
// The caller then mechanically verifies the template against a SECOND row
// before accepting (substitute → navigate → extract → value-gate).

export const MIN_ANCHOR_VALUE_LEN = 3;

const DATE_TOKEN_RES = [
  /^\d{4}-\d{1,2}-\d{1,2}$/,            // 2026-06-12
  /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/, // 06/12/2026, 12-06-26, 6.12.26
  /^\d{1,2}[\/\-.]\d{1,2}$/,            // 06/12 (year-less)
  /^(19|20)\d{6}$/,                     // 20260612
];

export function looksLikeDateToken(value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  return DATE_TOKEN_RES.some((re) => re.test(v));
}

export interface SingleSampleTemplateResult {
  ok: boolean;
  /** Absolute templated URL (placeholders named after list columns). */
  template?: string;
  placeholders?: string[];
  reason?: string;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Build a detail-URL template from ONE sample URL + the clicked row's column
 * values. `keyColumn` is the target's record-identity column
 * (DISCOVERY_KEY_COLUMNS) and must end up anchored.
 */
export function templateFromSample(
  sampleUrl: string,
  rowValues: Record<string, string>,
  keyColumn: string,
): SingleSampleTemplateResult {
  let url: URL;
  try {
    url = new URL(sampleUrl);
  } catch {
    return { ok: false, reason: `sample URL is not absolute/parseable: ${sampleUrl.slice(0, 120)}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `unsupported scheme: ${url.protocol}` };
  }

  // value → columns claiming it (ambiguity detection).
  const valueToColumns = new Map<string, string[]>();
  for (const [col, raw] of Object.entries(rowValues)) {
    const v = (raw ?? '').trim();
    if (v.length < MIN_ANCHOR_VALUE_LEN) continue;
    const cols = valueToColumns.get(v) ?? [];
    cols.push(col);
    valueToColumns.set(v, cols);
  }

  const placeholders: string[] = [];
  const matchComponent = (
    decoded: string,
  ): { kind: 'anchor'; column: string } | { kind: 'ambiguous' } | { kind: 'none' } => {
    const cols = valueToColumns.get(decoded.trim());
    if (!cols || cols.length === 0) return { kind: 'none' };
    const unique = [...new Set(cols)];
    if (unique.length > 1) return { kind: 'ambiguous' };
    return { kind: 'anchor', column: unique[0]! };
  };

  const templatePathParts: string[] = [];
  for (const segment of url.pathname.split('/')) {
    if (segment === '') {
      templatePathParts.push(segment);
      continue;
    }
    const m = matchComponent(safeDecode(segment));
    if (m.kind === 'ambiguous') {
      return { ok: false, reason: `ambiguous anchor: path segment "${safeDecode(segment).slice(0, 40)}" matches multiple columns` };
    }
    if (m.kind === 'anchor') {
      templatePathParts.push(`{${m.column}}`);
      placeholders.push(m.column);
    } else {
      if (looksLikeDateToken(safeDecode(segment))) {
        return { ok: false, reason: `unanchored date-like path segment "${safeDecode(segment)}" — a frozen date would go stale` };
      }
      templatePathParts.push(segment);
    }
  }

  const templateQueryEntries: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const m = matchComponent(value);
    if (m.kind === 'ambiguous') {
      return { ok: false, reason: `ambiguous anchor: query param "${key}" matches multiple columns` };
    }
    if (m.kind === 'anchor') {
      templateQueryEntries.push(`${key}={${m.column}}`);
      placeholders.push(m.column);
    } else {
      if (looksLikeDateToken(value)) {
        return { ok: false, reason: `unanchored date-like query param "${key}=${value.slice(0, 20)}" — a frozen date would go stale` };
      }
      templateQueryEntries.push(`${key}=${encodeURIComponent(value)}`);
    }
  }

  const uniquePlaceholders = [...new Set(placeholders)];
  if (uniquePlaceholders.length === 0) {
    return { ok: false, reason: 'no row value anchors any URL component' };
  }
  if (!uniquePlaceholders.includes(keyColumn)) {
    return {
      ok: false,
      reason: `key column ${keyColumn} is not anchored in the URL — a non-key template would fetch the wrong record for sibling rows`,
    };
  }

  const template =
    `${url.protocol}//${url.host}${templatePathParts.join('/')}` +
    (templateQueryEntries.length > 0 ? `?${templateQueryEntries.join('&')}` : '');
  return { ok: true, template, placeholders: uniquePlaceholders };
}
