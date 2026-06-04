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
import { getValidator } from '../validators-phase2.js';
import { RECONCILE_ON_MISSING, type OnMissingBehavior } from './reconcile-config.js';
import { notifyHighPriorityChange } from '../rules-engine-pinger.js';

// Re-export for backward compatibility with any external importer.
export { RECONCILE_ON_MISSING };
export type { OnMissingBehavior };

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

// RECONCILE_ON_MISSING + OnMissingBehavior moved to ./reconcile-config.ts
// (re-exported above) so the test suite can pin the configuration without
// transitively constructing the Supabase client.

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

    // Layer 2 — per-table validator (cross-field invariants).
    // Looked up by tableName from validators-phase2.VALIDATOR_REGISTRY.
    // Tables without a registered validator skip this layer (layer-1
    // type checks above are sufficient).
    const validator = getValidator(descriptor.table_name);
    if (validator) {
      const result = validator(row);
      if (!result.ok) {
        rejected.push({ rowIndex, row, reason: `layer-2: ${result.reason}` });
        return;
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
}

export interface SaveGenericTableResult {
  ok: boolean;
  tableName: string;
  inserted: number;
  updated: number;
  /** For reconcile-mode tables: rows auto-resolved because they
   *  disappeared from the snapshot. */
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
  // Plan v7 sole-path (2026-05-24): shadow tables retired. Always
  // write to authoritative.
  const targetTable = tableName;

  // Phase 3 echo-suppression: when the 30s reader sees a room status equal to
  // what the write-back robot JUST pushed (recorded in pms_sync_echo), drop
  // that 'cua' row so the robot's own write can't masquerade as a fresh
  // external change and wrongly cancel a newer pending manual write (Codex P1-5).
  let effectiveRows = rows;
  if (tableName === 'pms_room_status_log') {
    effectiveRows = await suppressEchoedRows(propertyId, rows);
    if (rows.length > 0 && effectiveRows.length === 0) {
      return { ok: true, tableName, inserted: 0, updated: 0, autoResolved: 0, rejected: 0, errors: [] };
    }
  }

  // ── Validate ──
  // Stamp property_id on every row before validation so the required-field
  // check sees it.
  //
  // Also auto-stamp synthetic required timestamps the extractor can't
  // produce. Columns like captured_at / changed_at are marked required in
  // the descriptor but the DB normally fills them via a `default now()`.
  // The validator runs BEFORE the insert, so without this every
  // in_house_snapshot / room_status_log / activity_log row would be
  // rejected for a "required field missing" it never had to supply. For
  // any descriptor column that is required + timestamptz + absent on the
  // row, stamp the current time as an ISO-8601 string — equivalent to
  // what the DB default now() would store. Never overwrite an extracted
  // value (only fill when undefined).
  const nowIso = new Date().toISOString();
  const syntheticTsCols = descriptor.columns.filter(
    (c) => c.required && c.type === 'timestamptz',
  );
  const stamped = effectiveRows.map((r) => {
    const row: Record<string, unknown> = { ...r, property_id: propertyId };
    for (const col of syntheticTsCols) {
      if (row[col.name] === undefined) row[col.name] = nowIso;
    }
    return row;
  });
  const validation = validateRows(stamped, descriptor);

  if (validation.rejected.length > 0) {
    // Surface dropped rows as a structured read-health signal the doctor /
    // parity cron can alert on. An all-reject cycle (rejected === rows.length)
    // otherwise looks identical to a healthy empty poll — the snapshot "wrote
    // 0 rows" — and would silently mask a broken extraction. Emitting this
    // warn (table + rejected count + total + allRejected flag) makes the drop
    // visible as a read problem. We do NOT touch property_sessions here;
    // session-driver owns the read_failure_streak counter.
    log.warn('generic-table-writer: rows rejected by validation', {
      tableName,
      rejected: validation.rejected.length,
      total: stamped.length,
      allRejected: stamped.length > 0 && validation.rejected.length === stamped.length,
    });

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
  let result: SaveGenericTableResult;
  try {
    switch (descriptor.write_strategy) {
      case 'append':
        result = await writeAppend(targetTable, validation.valid, validation.rejected.length);
        break;
      case 'upsert':
        result = await writeUpsert(targetTable, validation.valid, descriptor, validation.rejected.length);
        break;
      case 'reconcile':
        result = await writeReconcile(
          targetTable, validation.valid, descriptor, snapshotScope,
          propertyId, validation.rejected.length,
        );
        break;
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

  // After a successful write, notify the rules-engine pinger so high-
  // priority PMS changes (departures, arrivals, OOO flips, etc.) get a
  // sub-30s response from the rules engine instead of waiting up to 5
  // minutes for the next cron tick. Fire-and-forget: any pinger error
  // is logged + swallowed inside notifyHighPriorityChange — it must NOT
  // propagate into the write path.
  //
  // tableName (logical) is what the pinger's predicate map is keyed on,
  // not targetTable.
  if (result.ok && (result.inserted > 0 || result.updated > 0 || result.autoResolved > 0)) {
    notifyHighPriorityChange(propertyId, tableName, validation.valid);
  }
  return result;
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

/**
 * Phase 3 echo-suppression (Codex P1-5). Drop incoming reader-origin ('cua')
 * room-status rows whose (room_number, status) equals a value the write-back
 * robot pushed within the last ~45s (covers the 30s±10s jittered poll), and
 * consume those echo entries one-shot — so a LATER genuine same-value external
 * change still logs. Returns the rows to actually write.
 *
 * Intervening-change guard: a matching (room, status) is NOT necessarily our
 * own echo. A human could have flipped vacant_clean → vacant_dirty →
 * vacant_clean inside the 45s window; the final read legitimately matches the
 * pushed value but is a genuine new change. Before suppressing, we check the
 * status log for any manual/cua row for that room with changed_at AFTER the
 * echo's pushed_at — if one exists there was a real intervening change, so we
 * keep the row and leave the echo un-consumed.
 */
async function suppressEchoedRows(
  propertyId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const cutoff = new Date(Date.now() - 45_000).toISOString();
  const { data: echoes, error } = await supabase
    .from('pms_sync_echo')
    .select('room_number, pushed_value, pushed_at')
    .eq('property_id', propertyId)
    .gte('pushed_at', cutoff);
  if (error || !echoes || echoes.length === 0) return rows;

  const echoMap = new Map<string, { value: string; pushedAt: string }>();
  for (const e of echoes) {
    echoMap.set(String(e.room_number), {
      value: String(e.pushed_value),
      pushedAt: String(e.pushed_at),
    });
  }

  const consumed = new Set<string>();
  const kept: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const room = String(r.room_number ?? '');
    const status = String(r.status ?? '');
    const src = r.source ? String(r.source) : 'cua';
    const echo = echoMap.get(room);
    if (src === 'cua' && echo && echo.value === status) {
      // Looks like our own write echoed back. But only suppress if there is
      // NO genuine human/CUA status change logged AFTER we pushed — otherwise
      // a real flip back to the same status would be silently swallowed.
      const intervening = await hasInterveningChange(propertyId, room, echo.pushedAt);
      if (!intervening) {
        consumed.add(room);
        continue; // our own write echoed back — don't re-log it as 'cua'
      }
      // Genuine later change to the same value — keep it, leave echo intact.
    }
    kept.push(r);
  }

  if (consumed.size > 0) {
    const { error: delErr } = await supabase
      .from('pms_sync_echo')
      .delete()
      .eq('property_id', propertyId)
      .in('room_number', [...consumed]);
    if (delErr) {
      log.warn('generic-table-writer: echo consume (delete) failed', { propertyId, msg: delErr.message });
    }
    log.info('generic-table-writer: suppressed echoed cua room-status rows', {
      propertyId, count: consumed.size,
    });
  }
  return kept;
}

/**
 * Is there a genuine status change logged for this room AFTER the robot's
 * push? A manual/cua row in pms_room_status_log with changed_at > pushedAt
 * means a human (or a later CUA read of a real external change) touched the
 * room since we pushed — so the current poll's matching value is NOT just our
 * echo and must not be suppressed. We deliberately scope to source in
 * ('manual','cua'); 'scheduled'/'workflow' rows are not human-driven echoes
 * of concern here. Fail-open on query error (treat as "no intervening
 * change") so a transient read blip can't permanently wedge suppression.
 */
async function hasInterveningChange(
  propertyId: string,
  roomNumber: string,
  pushedAt: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('pms_room_status_log')
    .select('id')
    .eq('property_id', propertyId)
    .eq('room_number', roomNumber)
    .in('source', ['manual', 'cua'])
    .gt('changed_at', pushedAt)
    .limit(1);
  if (error) {
    log.warn('generic-table-writer: intervening-change check failed', {
      propertyId, roomNumber, msg: error.message,
    });
    return false;
  }
  return (data?.length ?? 0) > 0;
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
  propertyId: string,
  rejected: number,
): Promise<SaveGenericTableResult> {
  if (!descriptor.reconcile_key_field) {
    throw new Error(`reconcile strategy on ${tableName} requires reconcile_key_field in descriptor`);
  }

  // Detect rows whose reconcile/natural key is NULL (e.g. pms_lost_and_found
  // with a null pms_item_id when the PMS row carries no stable id). A null
  // key is poison for reconcile two ways: (a) it never lands in incomingKeys,
  // so the auto-resolve pass would see it as "disappeared" and dispose
  // everything; (b) ON CONFLICT can't match a null, so upsert re-INSERTs the
  // same null-key rows on every poll → unbounded duplicates. When any null
  // key is present we degrade safely: plain append (no upsert) for this batch
  // and skip auto-resolve entirely.
  const reconcileKeyField = descriptor.reconcile_key_field;
  const hasNullReconcileKey = rows.some((r) => {
    const k = r[reconcileKeyField];
    return k === undefined || k === null;
  });

  // Step 1: write all incoming rows. Normally an upsert on the natural key;
  // but when any reconcile key is null, upsert-on-null re-inserts duplicates
  // every poll, so fall back to a plain append for this batch.
  const onConflict = descriptor.natural_key.join(',');
  if (hasNullReconcileKey) {
    log.warn('reconcile: incoming row(s) have a null reconcile key — appending instead of upserting', {
      tableName: descriptor.table_name,
      reconcileKeyField,
      reason: 'upsert on a null key cannot match ON CONFLICT and would duplicate every poll',
    });
    const { error: insertErr } = await supabase.from(tableName).insert(rows);
    if (insertErr) throw insertErr;
  } else {
    const { error: upsertErr } = await supabase.from(tableName).upsert(rows, { onConflict });
    if (upsertErr) throw upsertErr;
  }

  // Step 2: auto-resolve disappeared rows. ONLY for full snapshots (Codex
  // v2 P1-RECONCILE — auto-resolve on a delta would falsely resolve real
  // rows that the partial view just didn't include).
  let autoResolved = 0;
  if (snapshotScope === 'full' && rejected > 0) {
    // A "full" snapshot that had ANY rejected rows is not actually complete:
    // some rows the PMS reported were dropped by validation, so their natural
    // keys are missing from `rows`. Treating it as a full snapshot would
    // auto-resolve genuinely-present rows that just failed to parse this poll.
    // Skip the destructive step until a clean full snapshot lands (Codex
    // P1 partial-extraction false auto-resolve).
    log.warn('reconcile: skipping auto-resolve for partially-rejected full snapshot', {
      tableName: descriptor.table_name,
      rejected,
      reason: 'rejected>0 — batch is incomplete; auto-resolve could falsely resolve rows dropped by validation',
    });
  } else if (snapshotScope === 'full' && hasNullReconcileKey) {
    // A null reconcile key never lands in incomingKeys, so the disappeared-row
    // diff below would treat EVERY existing open row as missing and dispose it.
    // Skip auto-resolve when the batch can't be keyed reliably (Codex P1
    // pms_lost_and_found null pms_item_id case).
    log.warn('reconcile: skipping auto-resolve — incoming batch has a null reconcile key', {
      tableName: descriptor.table_name,
      reconcileKeyField,
      reason: 'null key → empty incomingKeys → would falsely resolve all existing open rows',
    });
  } else if (snapshotScope === 'full') {
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
      let selectBuilder = supabase
        .from(tableName)
        .select(selectCols)
        .eq('property_id', propertyId)
        .neq(onMissing.column, onMissing.value);  // skip already-resolved rows

      // Migration 0225 / feature #11 follow-up: scope auto-resolve to rows
      // produced by the PMS feed. Without this, a voice-issue ticket
      // (source='housekeeper_voice') with no PMS counterpart gets resolved
      // 30s after creation. The filter is applied on BOTH the SELECT here
      // and the UPDATE below — belt-and-braces against a future code path
      // that forgets one of the two.
      if (onMissing.sourceFilter) {
        selectBuilder = selectBuilder.eq(onMissing.sourceFilter.column, onMissing.sourceFilter.value);
      }

      const { data: existingRaw, error: selErr } = await selectBuilder;
      if (selErr) throw selErr;

      const existing = (existingRaw ?? []) as unknown as Array<Record<string, unknown>>;
      const toResolve = existing.filter((row) => !incomingKeys.has(row[reconcileKey] as string));

      if (toResolve.length === 0) {
        autoResolved = 0;
      } else {
        const idsToResolve = toResolve.map((r) => r.id);
        let updateBuilder = supabase
          .from(tableName)
          .update({ [onMissing.column]: onMissing.value })
          .in('id', idsToResolve);
        if (onMissing.sourceFilter) {
          updateBuilder = updateBuilder.eq(onMissing.sourceFilter.column, onMissing.sourceFilter.value);
        }
        const { error: updErr } = await updateBuilder;
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
