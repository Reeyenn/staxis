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
    for (const col of candidateColumns) {
      const colValues = sampleRowData.map((row) => row[col] ?? '');
      if (colValues.length === observedValues.length &&
          colValues.every((v, i) => v === observedValues[i])) {
        mapping[placeholder] = col;
        break;
      }
    }
    // If no column matched, leave the placeholder unnamed; caller can
    // surface as a warning ("URL has a var we can't map to a known field").
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
