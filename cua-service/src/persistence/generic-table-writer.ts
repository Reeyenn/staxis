/**
 * Generic table writer (Plan v7 Phase 2b).
 *
 * `saveGenericTable(propertyId, tableName, rows, options?)` is the
 * universal write path for any pms_* table. It replaces the hand-coded
 * per-table writers in new-schema-writer.ts.
 *
 * Behavior is driven by the descriptor in `pms_table_schemas` (migration
 * 0207). The descriptor declares:
 *   - write_strategy: 'upsert' | 'append' | 'reconcile'
 *   - snapshot_scope_default: 'full' | 'delta' (REQUIRED for reconcile
 *     auto-resolve safety — Codex v2 P1-RECONCILE finding)
 *   - natural_key: array of columns used in ON CONFLICT
 *   - reconcile_key_field: row-identity column for reconcile diff
 *   - columns: jsonb array of column type + range/enum descriptors
 *
 * Two-layer validation (Codex v2 P1-VALIDATION):
 *   1. **Type check** from descriptor (column types match, range checks,
 *      allowed_values for enums). Done inline here.
 *   2. **Per-table validator function** from validators.ts (cross-field
 *      invariants like "occupied + vacant ≤ total_rooms"). Wired in
 *      chunk 4 — looked up by tableName from a registry.
 *
 * Per-row error handling: validation failures log to `error_logs` with
 * the row index + bad value; the rest of the batch still writes. No
 * whole-batch failure from one bad row.
 *
 * Shadow mode (Plan v7 parity-gate mechanism, env CUA_SHADOW_MODE=true):
 * writes to `pms_X_shadow` tables instead of authoritative ones.
 * Reconcile-mode tables in shadow mode SKIP the destructive auto-resolve
 * step and log "would auto-resolve row X" instead — preserving live data.
 */

import { supabase } from '../supabase.js';
import { log } from '../log.js';
import { env } from '../env.js';

// ─── Descriptor cache ────────────────────────────────────────────────────
// The descriptor table is read-mostly (admins rarely edit). Cache for the
// worker's lifetime; we'd add a TTL or invalidation hook if descriptors
// start changing in flight.

export type WriteStrategy = 'upsert' | 'append' | 'reconcile';
export type SnapshotScope = 'full' | 'delta';

export interface ColumnDescriptor {
  name: string;
  type: 'text' | 'integer' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';
  required: boolean;
  nullable: boolean;
  range_min?: number;
  range_max?: number;
  allowed_values?: unknown[];
}

export interface TableSchemaDescriptor {
  table_name: string;
  write_strategy: WriteStrategy;
  snapshot_scope_default: SnapshotScope;
  natural_key: string[];
  reconcile_key_field: string | null;
  columns: ColumnDescriptor[];
  notes?: string;
}

const SCHEMA_CACHE = new Map<string, TableSchemaDescriptor>();

async function loadDescriptor(tableName: string): Promise<TableSchemaDescriptor | null> {
  if (SCHEMA_CACHE.has(tableName)) return SCHEMA_CACHE.get(tableName)!;
  const { data, error } = await supabase
    .from('pms_table_schemas')
    .select('table_name, write_strategy, snapshot_scope_default, natural_key, reconcile_key_field, columns, notes')
    .eq('table_name', tableName)
    .maybeSingle();
  if (error || !data) {
    log.warn('generic-table-writer: no descriptor for table', { tableName, err: error?.message });
    return null;
  }
  const descriptor = data as TableSchemaDescriptor;
  SCHEMA_CACHE.set(tableName, descriptor);
  return descriptor;
}

// ─── Reconcile-on-missing behavior ──────────────────────────────────────
// Per-table override for what to do with rows that exist in the DB but
// disappear from a full snapshot. Today only 2 tables use reconcile; a
// future migration could move this into the descriptor as a jsonb field
// if the list grows.

interface OnMissingBehavior {
  column: string;
  value: string;
}
const RECONCILE_ON_MISSING: Record<string, OnMissingBehavior> = {
  pms_work_orders_v2: { column: 'status', value: 'resolved' },
  pms_lost_and_found: { column: 'status', value: 'disposed' },
};

// ─── Validation ─────────────────────────────────────────────────────────

interface ValidationOutcome {
  valid: Array<Record<string, unknown>>;
  rejected: Array<{ rowIndex: number; row: Record<string, unknown>; reason: string }>;
}

function validateRows(
  rows: Array<Record<string, unknown>>,
  descriptor: TableSchemaDescriptor,
): ValidationOutcome {
  const valid: Array<Record<string, unknown>> = [];
  const rejected: ValidationOutcome['rejected'] = [];
  const columnsByName = new Map(descriptor.columns.map((c) => [c.name, c]));

  rows.forEach((row, rowIndex) => {
    for (const col of descriptor.columns) {
      const value = row[col.name];
      const present = value !== undefined && value !== null;

      // Required-field check.
      if (col.required && !present) {
        rejected.push({ rowIndex, row, reason: `required field "${col.name}" missing` });
        return;
      }
      if (!present) continue;  // optional + missing = fine

      // Type check.
      const typeOk = typeMatches(value, col.type);
      if (!typeOk) {
        rejected.push({ rowIndex, row, reason: `field "${col.name}" type ${typeof value} doesn't match expected ${col.type}` });
        return;
      }

      // Range check for numerics.
      if ((col.type === 'integer' || col.type === 'bigint' || col.type === 'numeric') &&
          typeof value === 'number') {
        if (col.range_min !== undefined && value < col.range_min) {
          rejected.push({ rowIndex, row, reason: `field "${col.name}" value ${value} < range_min ${col.range_min}` });
          return;
        }
        if (col.range_max !== undefined && value > col.range_max) {
          rejected.push({ rowIndex, row, reason: `field "${col.name}" value ${value} > range_max ${col.range_max}` });
          return;
        }
      }

      // Enum check.
      if (col.allowed_values && col.allowed_values.length > 0) {
        if (!col.allowed_values.includes(value as unknown)) {
          rejected.push({ rowIndex, row, reason: `field "${col.name}" value "${String(value)}" not in allowed_values` });
          return;
        }
      }
    }

    // Reject any extra fields not in the descriptor — they'd be dropped by
    // Postgres anyway (Supabase strips unknown columns) but flagging here
    // surfaces schema drift.
    for (const k of Object.keys(row)) {
      if (k === 'property_id') continue;  // always allowed
      if (!columnsByName.has(k)) {
        log.warn('generic-table-writer: row has field not in descriptor', {
          tableName: descriptor.table_name,
          rowIndex,
          extraField: k,
        });
      }
    }

    valid.push(row);
  });

  return { valid, rejected };
}

function typeMatches(value: unknown, type: ColumnDescriptor['type']): boolean {
  switch (type) {
    case 'text':         return typeof value === 'string';
    case 'integer':
    case 'bigint':
    case 'numeric':      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':      return typeof value === 'boolean';
    case 'date':         return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);
    case 'timestamptz':  return typeof value === 'string';  // ISO 8601, accept the string
    case 'jsonb':        return value !== null;
    default:             return false;
  }
}

// ─── Save ──────────────────────────────────────────────────────────────

export interface SaveGenericTableOptions {
  /** Override descriptor's snapshot_scope_default. Required when caller
   *  knows the extractor produced a partial view (e.g. filtered to today). */
  snapshotScope?: SnapshotScope;
  /** Force shadow-mode write target. If not set, reads env CUA_SHADOW_MODE. */
  shadowMode?: boolean;
}

export interface SaveGenericTableResult {
  ok: boolean;
  tableName: string;
  inserted: number;
  updated: number;
  /** For reconcile-mode tables: rows auto-resolved because they
   *  disappeared from the snapshot. 0 in shadow mode (resolved is logged
   *  but not applied). */
  autoResolved: number;
  rejected: number;
  errors: string[];
}

export async function saveGenericTable(
  propertyId: string,
  tableName: string,
  rows: Array<Record<string, unknown>>,
  options: SaveGenericTableOptions = {},
): Promise<SaveGenericTableResult> {
  const descriptor = await loadDescriptor(tableName);
  if (!descriptor) {
    return {
      ok: false, tableName, inserted: 0, updated: 0, autoResolved: 0, rejected: 0,
      errors: [`no descriptor in pms_table_schemas for ${tableName}`],
    };
  }

  const snapshotScope = options.snapshotScope ?? descriptor.snapshot_scope_default;
  const shadowMode = options.shadowMode ?? env.CUA_SHADOW_MODE ?? false;
  const targetTable = shadowMode ? `${tableName}_shadow` : tableName;

  // ── Validate ──
  // Stamp property_id on every row before validation so the required-field
  // check sees it.
  const stamped = rows.map((r) => ({ ...r, property_id: propertyId }));
  const validation = validateRows(stamped, descriptor);

  if (validation.rejected.length > 0) {
    // Best-effort: log to error_logs (admin's recent-errors panel).
    for (const r of validation.rejected) {
      void supabase.from('error_logs').insert({
        source: 'generic-table-writer',
        message: `${tableName} row ${r.rowIndex}: ${r.reason}`,
        property_id: propertyId,
        stack: null,
      });
    }
  }

  if (validation.valid.length === 0) {
    return {
      ok: false, tableName, inserted: 0, updated: 0, autoResolved: 0,
      rejected: validation.rejected.length,
      errors: validation.rejected.length > 0
        ? [`all ${rows.length} rows rejected by validation`]
        : ['no rows to write'],
    };
  }

  // ── Dispatch ──
  try {
    switch (descriptor.write_strategy) {
      case 'append':
        return await writeAppend(targetTable, validation.valid, validation.rejected.length);
      case 'upsert':
        return await writeUpsert(targetTable, validation.valid, descriptor, validation.rejected.length);
      case 'reconcile':
        return await writeReconcile(
          targetTable, validation.valid, descriptor, snapshotScope,
          shadowMode, propertyId, validation.rejected.length,
        );
    }
  } catch (err) {
    log.error('generic-table-writer: write failed', {
      tableName: targetTable,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false, tableName: targetTable, inserted: 0, updated: 0, autoResolved: 0,
      rejected: validation.rejected.length,
      errors: [(err as Error).message],
    };
  }
}

async function writeAppend(
  tableName: string,
  rows: Array<Record<string, unknown>>,
  rejected: number,
): Promise<SaveGenericTableResult> {
  const { error } = await supabase.from(tableName).insert(rows);
  if (error) throw error;
  return {
    ok: true, tableName, inserted: rows.length, updated: 0, autoResolved: 0,
    rejected, errors: [],
  };
}

async function writeUpsert(
  tableName: string,
  rows: Array<Record<string, unknown>>,
  descriptor: TableSchemaDescriptor,
  rejected: number,
): Promise<SaveGenericTableResult> {
  // ON CONFLICT target = the natural_key columns. Supabase JS client's
  // upsert() takes `onConflict` as a comma-separated string of columns.
  const onConflict = descriptor.natural_key.join(',');
  const { error } = await supabase.from(tableName).upsert(rows, { onConflict });
  if (error) throw error;
  // upsert() doesn't distinguish inserts from updates in the response.
  // For now, report all as 'inserted' — admin UI cares about the delta,
  // not the split. Generic writer could SELECT pre+post counts if a
  // future use-case needed it.
  return {
    ok: true, tableName, inserted: rows.length, updated: 0, autoResolved: 0,
    rejected, errors: [],
  };
}

async function writeReconcile(
  tableName: string,
  rows: Array<Record<string, unknown>>,
  descriptor: TableSchemaDescriptor,
  snapshotScope: SnapshotScope,
  shadowMode: boolean,
  propertyId: string,
  rejected: number,
): Promise<SaveGenericTableResult> {
  if (!descriptor.reconcile_key_field) {
    throw new Error(`reconcile strategy on ${tableName} requires reconcile_key_field in descriptor`);
  }

  // Step 1: upsert all incoming rows.
  const onConflict = descriptor.natural_key.join(',');
  const { error: upsertErr } = await supabase.from(tableName).upsert(rows, { onConflict });
  if (upsertErr) throw upsertErr;

  // Step 2: auto-resolve disappeared rows. ONLY for full snapshots (Codex
  // v2 P1-RECONCILE — auto-resolve on a delta would falsely resolve real
  // rows that the partial view just didn't include).
  let autoResolved = 0;
  if (snapshotScope === 'full') {
    const onMissing = RECONCILE_ON_MISSING[descriptor.table_name];
    if (!onMissing) {
      log.warn('reconcile: no on_missing behavior for table', { tableName: descriptor.table_name });
    } else {
      // Find rows currently in DB for this property whose status is "open"
      // (i.e. not already resolved) and whose key isn't in the incoming set.
      const reconcileKey = descriptor.reconcile_key_field;
      const incomingKeys = new Set(rows.map((r) => r[reconcileKey]).filter((k) => k !== undefined && k !== null));

      // Dynamic select string — Supabase JS's typed select rejects
      // computed column lists, so we use untyped-then-cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectCols = `id, ${reconcileKey}, ${onMissing.column}` as any;
      const { data: existingRaw, error: selErr } = await supabase
        .from(tableName)
        .select(selectCols)
        .eq('property_id', propertyId)
        .neq(onMissing.column, onMissing.value);  // skip already-resolved rows
      if (selErr) throw selErr;

      const existing = (existingRaw ?? []) as unknown as Array<Record<string, unknown>>;
      const toResolve = existing.filter((row) => !incomingKeys.has(row[reconcileKey] as string));

      if (toResolve.length === 0) {
        autoResolved = 0;
      } else if (shadowMode) {
        // Shadow mode: log what we WOULD resolve, don't actually mutate.
        log.info('reconcile (shadow mode): would auto-resolve disappeared rows', {
          tableName: descriptor.table_name,
          count: toResolve.length,
          keys: toResolve.map((r) => r[reconcileKey]),
        });
        autoResolved = 0;  // shadow mode reports zero applied
      } else {
        const idsToResolve = toResolve.map((r) => r.id);
        const { error: updErr } = await supabase
          .from(tableName)
          .update({ [onMissing.column]: onMissing.value })
          .in('id', idsToResolve);
        if (updErr) throw updErr;
        autoResolved = toResolve.length;
      }
    }
  } else {
    log.info('reconcile: skipping auto-resolve for delta snapshot', {
      tableName: descriptor.table_name,
      reason: 'snapshotScope=delta — extractor sees only a partial view; auto-resolve would falsely resolve unseen real rows',
    });
  }

  return {
    ok: true,
    tableName,
    inserted: rows.length,
    updated: 0,
    autoResolved,
    rejected,
    errors: [],
  };
}
