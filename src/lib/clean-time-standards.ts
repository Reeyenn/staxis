/**
 * Clean Times (Layer 1 — standard table): PURE helpers.
 *
 * This module has NO database import on purpose — it holds the types,
 * industry-standard defaults, and the pure resolution logic that turns a
 * property's `hk_clean_time_standards` rows (migration 0244) into a base
 * minute for a given cleaning_type (+ optional room_type). Keeping it pure
 * means the rules-engine merger (also pure, no DB) can consume the resolver
 * without taking on a Supabase dependency, and the resolver is trivially
 * unit-testable.
 *
 * The service-role fetch/upsert lives in `clean-time-standards-server.ts`
 * (imports supabase-admin, server-only). This split mirrors the codebase
 * convention that the `db.ts` shim only re-exports anon/client-safe modules
 * — re-exporting a supabase-admin module through it would break client
 * bundles, since supabase-admin throws at module load.
 *
 * How the numbers flow:
 *   - At task creation, the rules-engine merger resolves the BASE for the
 *     winning cleaning_type from the table (room_type-specific row wins over
 *     the all-rooms row); if no row exists it falls back to the rule-supplied
 *     base / the static BASE_DURATION_MIN. Deltas/extras are unchanged.
 *   - On the board / timeline / auto-assign, the table's all-rooms values
 *     overlay DEFAULT_BASE_DURATIONS as the fallback used only when a task
 *     has no stored estimated_minutes.
 */

import type { CleaningType } from '@/types/cleaning-tasks';

/** Cleaning types a manager can edit a standard time for. `no_clean` is
 *  excluded — it is definitionally 0 minutes (and the table's
 *  base_minutes CHECK forbids 0). Order is the display order in Settings. */
export const EDITABLE_CLEANING_TYPES = [
  'departure',
  'departure_deep',
  'stayover',
  'refresh',
  'deep',
  'room_check',
  'inspection_only',
] as const;

export type EditableCleaningType = (typeof EDITABLE_CLEANING_TYPES)[number];

/** Allowed range for a manager-entered standard time (minutes). Mirrors the
 *  `base_minutes` CHECK in migration 0244. */
export const MIN_CLEAN_MINUTES = 1;
export const MAX_CLEAN_MINUTES = 240;

/**
 * Industry-standard default minutes per editable cleaning_type.
 *
 * These mirror src/lib/rules-engine/constants.ts BASE_DURATION_MIN[*].standard.
 * The table is NOT pre-seeded (see migration 0244), so this map is what GET
 * /api/settings/clean-times returns for any type a property hasn't saved yet
 * — i.e. what the Settings page shows on day one. The actual estimate fallback
 * when no row exists is each consumer's own static map (the rules-engine
 * BASE_DURATION_MIN with its suite split; the assignment-engine
 * DEFAULT_BASE_DURATIONS), so behaviour is unchanged until a manager saves.
 */
export const CLEAN_TIME_DEFAULT_MINUTES: Record<EditableCleaningType, number> = {
  departure: 35,
  departure_deep: 50,
  stayover: 18,
  refresh: 15,
  deep: 90,
  room_check: 5,
  inspection_only: 5,
};

export function isEditableCleaningType(s: unknown): s is EditableCleaningType {
  return (
    typeof s === 'string' &&
    (EDITABLE_CLEANING_TYPES as readonly string[]).includes(s)
  );
}

/** True when `n` is an integer within the allowed standard-time range. */
export function isValidBaseMinutes(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= MIN_CLEAN_MINUTES &&
    n <= MAX_CLEAN_MINUTES
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shift length (properties.shift_minutes)
//
// Not a clean time, but it lives here because it is edited on the same
// Settings → Clean Times screen, saved by the same route, and gated by the
// same `manage_clean_times` capability — one length, one place. It answers
// "how much cleaning fits in one person's day", which is what turns a pile of
// minutes into a crew size: the per-housekeeper capacity bars and Over-cap /
// Near-full pills on the board, the "Recommended N HK" readout, the timeline's
// shift window, and the forecast's headcount all divide by it.
//
// It used to be editable only from a gear icon on the Housekeeping board that
// wrote `properties` through the browser client — an admin-only write, so for
// a general manager it silently saved nothing (removed 2026-07-24).
// ───────────────────────────────────────────────────────────────────────────

/** Allowed range for the per-housekeeper shift length, in minutes (1h–24h). */
export const MIN_SHIFT_MINUTES = 60;
export const MAX_SHIFT_MINUTES = 1440;

/** Fallback when `properties.shift_minutes` is unset. Mirrors
 *  DEFAULT_SHIFT_MINUTES in src/lib/forecast/index.ts — keep them equal. */
export const DEFAULT_SHIFT_MINUTES = 420;

/** True when `n` is a whole number of minutes inside the allowed shift range. */
export function isValidShiftMinutes(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= MIN_SHIFT_MINUTES &&
    n <= MAX_SHIFT_MINUTES
  );
}

/** A single standard row, as read from `hk_clean_time_standards`. */
export interface CleanTimeStandardRow {
  cleaning_type: string;
  /** NULL = applies to all room types. */
  room_type: string | null;
  base_minutes: number;
}

/**
 * Indexed view of a property's standards for O(1) base lookups, keyed by
 * `${cleaning_type}::${room_type ?? '*'}`. Built once per property per engine
 * run (the table is tiny — at most a handful of rows per property).
 */
export type CleanTimeStandardsIndex = Map<string, number>;

function indexKey(cleaningType: string, roomType: string | null | undefined): string {
  return `${cleaningType}::${roomType ?? '*'}`;
}

export function indexStandards(rows: readonly CleanTimeStandardRow[]): CleanTimeStandardsIndex {
  const idx: CleanTimeStandardsIndex = new Map();
  for (const r of rows) {
    if (typeof r.base_minutes !== 'number') continue;
    idx.set(indexKey(r.cleaning_type, r.room_type), r.base_minutes);
  }
  return idx;
}

/**
 * Resolve the manager-set base minutes for a cleaning_type, preferring a
 * room_type-specific row over the all-rooms (`*`) row. Returns `undefined`
 * when the property has no matching standard — callers then fall back to
 * their existing static defaults so nothing breaks pre-seed.
 *
 * Note: the table carries a single value per (type, room_type) with no
 * standard/suite split. When only an all-rooms row exists, that single value
 * applies to suites too — the manager's entered number is authoritative. The
 * legacy suite premium survives only as the merger's static fallback (used
 * when a property has no row for the type at all).
 */
export function resolveStandardMinutes(
  index: CleanTimeStandardsIndex,
  cleaningType: string,
  roomType?: string | null,
): number | undefined {
  if (roomType != null) {
    const specific = index.get(indexKey(cleaningType, roomType));
    if (specific != null) return specific;
  }
  return index.get(indexKey(cleaningType, null));
}

/**
 * Flatten a property's standards into a `cleaning_type -> minutes` map using
 * only the all-rooms (NULL room_type) rows. This is the shape the
 * assignment-engine's `baseDurations` fallback expects (it keys by
 * cleaning_type only, with no room dimension). Overlay this on
 * DEFAULT_BASE_DURATIONS.
 */
export function standardsToBaseDurations(
  rows: readonly CleanTimeStandardRow[],
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) {
    if (r.room_type == null && typeof r.base_minutes === 'number') {
      map[r.cleaning_type] = r.base_minutes;
    }
  }
  return map;
}

/**
 * The default standards as table-shaped rows (all-rooms). A convenience for
 * tests and for any caller that wants the default set in row shape. (The GET
 * API builds its response from CLEAN_TIME_DEFAULT_MINUTES directly.)
 */
export function defaultStandardRows(): Array<{ cleaning_type: EditableCleaningType; room_type: null; base_minutes: number }> {
  return EDITABLE_CLEANING_TYPES.map((cleaning_type) => ({
    cleaning_type,
    room_type: null,
    base_minutes: CLEAN_TIME_DEFAULT_MINUTES[cleaning_type],
  }));
}

// Compile-time guard: EditableCleaningType must stay a subset of CleaningType.
// Tuple-wrapped so the check is non-distributive — if someone removes/renames
// a cleaning_type in @/types/cleaning-tasks, this resolves to `never` and the
// assignment errors at build time.
type _EditableIsSubsetOfCleaningType =
  [EditableCleaningType] extends [CleaningType] ? true : never;
const _subsetGuard: _EditableIsSubsetOfCleaningType = true;
void _subsetGuard;
