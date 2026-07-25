/**
 * Opening an ingest run for the CUA (robot) read path.
 *
 * Migration 0341 made `ingest_run_id` NOT NULL on every pms_* table, and
 * saveGenericTable() now refuses a write without one. That rule exists so any
 * number in the app can be traced back to the thing that produced it — the
 * report-email path gets its run from the ingest ledger, and this module is
 * the equivalent for the robot.
 *
 * Grain: ONE run per poll cycle, not per table. A single sweep of the PMS is
 * one observation of the hotel, and the tables it writes are facets of that
 * observation — giving each table its own run would make a cross-feed
 * reconciliation impossible to line up afterwards.
 *
 * `sourceCapturedAt` is the moment the ROBOT LOOKED, not the moment we wrote.
 * It is passed to every saveGenericTable call in the cycle so the monotonic
 * write guard (0341) can reject a slow poll whose data is older than what is
 * already stored — the same rule that stops a delayed 11am report clobbering
 * a 2pm restatement.
 *
 * Failure is soft on purpose: if the ledger insert fails we return null and
 * the caller skips the cycle. A poll that cannot be attributed is a poll that
 * must not be written — silently unattributed rows are exactly the "number
 * with no receipt" this whole layer exists to prevent.
 *
 * NOTE: the robot has been off since ~2026-07-06 and the product's intake is
 * moving to scheduled report emails. This keeps the legacy path honest and
 * compiling; it is deliberately minimal.
 */

import { supabase } from '../supabase.js';
import { log } from '../log.js';

/** Identifies which code produced a row; stored on the run for lineage. */
const PARSER_NAME = 'cua-generic-writer';

/**
 * Version of the CUA write path. Bump when extraction or normalization
 * changes shape, so rows written before and after are distinguishable
 * without guessing from timestamps.
 */
const PARSER_VERSION = 'cua-v4';

export interface OpenIngestRun {
  ingestRunId: string;
  /** ISO-8601. The instant the robot observed the PMS. */
  sourceCapturedAt: string;
}

/**
 * Open a 'running' ingest run for one poll cycle.
 *
 * @param propertyId      hotel being polled
 * @param knowledgeFileId active knowledge file driving extraction, when known —
 *                        recorded so a bad extraction can be traced to the
 *                        exact playbook version that caused it.
 * @param capturedAt      when the robot looked; defaults to now.
 * @returns the run, or null when the ledger write failed (caller must skip).
 */
export async function openCuaIngestRun(
  propertyId: string,
  knowledgeFileId: string | null,
  capturedAt: Date = new Date(),
): Promise<OpenIngestRun | null> {
  const sourceCapturedAt = capturedAt.toISOString();

  const { data, error } = await supabase
    .from('pms_ingest_runs')
    .insert({
      property_id: propertyId,
      source_kind: 'cua',
      mode: 'live',
      parser_name: PARSER_NAME,
      parser_version: PARSER_VERSION,
      knowledge_file_id: knowledgeFileId,
      source_captured_at: sourceCapturedAt,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    log.error('[ingest-run] could not open CUA run — skipping cycle', {
      propertyId,
      err: error?.message ?? 'no id returned',
    });
    return null;
  }

  return { ingestRunId: data.id as string, sourceCapturedAt };
}

/**
 * Close a run. Best-effort: a run left 'running' is visibly stale in the
 * ledger, which is a better failure mode than throwing away a cycle's rows
 * because the bookkeeping update failed after the data landed.
 */
export async function closeCuaIngestRun(
  ingestRunId: string,
  outcome: { rowsWritten: number; rowsRejected: number; error?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('pms_ingest_runs')
    .update({
      status: outcome.error ? 'failed' : 'succeeded',
      finished_at: new Date().toISOString(),
      rows_written: outcome.rowsWritten,
      rows_rejected: outcome.rowsRejected,
      error: outcome.error ?? null,
    })
    .eq('id', ingestRunId);

  if (error) {
    log.warn('[ingest-run] could not close run (rows already committed)', {
      ingestRunId,
      err: error.message,
    });
  }
}
