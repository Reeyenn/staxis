/**
 * Parser registry (Plan v7 Phase 2b).
 *
 * Per-PMS-family parser plugins. Each parser takes a raw extracted
 * value (CSV cell text, DOM text content, JSON field) and returns the
 * canonicalized typed value the generic writer expects.
 *
 * Why a registry: the mapper learns which parser to use per field
 * during the mapping run (e.g. "this column has currency strings — use
 * ca_currency"). Runtime composes by name; the parser registry is the
 * single source of truth for what's available.
 *
 * Plan v7 acknowledges that "no code per table" only applies to
 * extraction + write dispatch; per-PMS parsers ARE per-family code,
 * but they're composable (1 file per PMS family, ~5-15 parsers each).
 */

import { log } from '../log.js';
import type { ParserConfig } from '../types.js';

// feat/pms-universal-translate — parsers now accept an OPTIONAL learned config
// (date format / enum mapping). Format-only parsers (currency/integer/boolean)
// and the legacy ca_* parsers ignore the 2nd arg, so this is fully backward
// compatible: a `(raw) => …` function still satisfies the type.
export type ParserFn = (raw: unknown, config?: ParserConfig) => unknown;

const REGISTRY = new Map<string, ParserFn>();

export function registerParser(name: string, fn: ParserFn): void {
  if (REGISTRY.has(name)) {
    log.warn('parser registry: overwriting existing parser', { name });
  }
  REGISTRY.set(name, fn);
}

export function getParser(name: string): ParserFn | undefined {
  return REGISTRY.get(name);
}

/**
 * Apply a named parser to a raw value. Returns the raw value unchanged
 * if the parser isn't registered (logs a warning); the type-check layer
 * in generic-table-writer will reject if the resulting type is wrong.
 */
export function applyParser(name: string, raw: unknown, config?: ParserConfig): unknown {
  const fn = REGISTRY.get(name);
  if (!fn) {
    log.warn('parser registry: parser not found, passing through raw', { name });
    return raw;
  }
  try {
    return fn(raw, config);
  } catch (err) {
    log.warn('parser registry: parser threw, returning null', {
      name,
      raw: typeof raw === 'string' ? raw.slice(0, 100) : String(raw).slice(0, 100),
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function listRegisteredParsers(): string[] {
  return [...REGISTRY.keys()].sort();
}
