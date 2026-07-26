// ─── Telling Staxis what happened out in the building ────────────────────────
//
// The two preventive verdicts, and the only place either of them writes.
//
//   done    the flush happened. `last_completed_at` moves to now, which
//           restarts the clock: the schedule is not due again for one full
//           cadence, and the card that prompted this closes.
//   called  arranged, not finished. `called_at` is stamped, the detector goes
//           quiet, and one week later it asks once whether it happened.
//
// ═══ THE BROWSER NEVER NAMES A SCHEDULE ═══
// Both take a FINDING id and resolve the schedule from that finding's own
// evidence, server-side. The obvious alternative — let the card post the
// schedule id it already has in `evidence.target` — would have been one fewer
// read and a materially worse shape: the API would then accept "mark schedule X
// done" from anything that could guess an id, and the only thing standing
// between that and a write would be the property filter. Going through the
// finding means the caller has to name a card THIS hotel actually has, whose
// detector is this one, and the id that gets written is one Staxis put there
// itself. The property filter is still the wall; this is the wall behind it.
//
// It also keeps the two halves honest: a verdict can only ever be recorded
// against a schedule the manager was actually shown a card about.
//
// WHY `last_completed_by` IS THE MANAGER'S NAME AND NOT "Staxis"
// A person did the job, or arranged for it. Stamping the system's own name onto
// this hotel's maintenance record would make its history unreadable in exactly
// the place a history has to be readable — six months from now, "who last
// flushed this" has to answer with somebody you can ask.

import 'server-only';

import { scopedDb } from '@/lib/agent/scoped-db';

import { loadFinding } from './store';
import { resolveFindingTarget } from './targeting';

/** Which of the two things a manager told us. */
export type PreventiveOutcome = 'done' | 'called';

export interface PreventiveLogResult {
  /** The schedule's name, so the caller can say what it just recorded. */
  taskName: string;
  outcome: PreventiveOutcome;
}

/**
 * Why nothing was written. Each one is a real answer the route renders
 * differently — a missing card is a 404, a card that is not about a schedule is
 * a 400, and conflating them would make a client bug look like a stale link.
 */
export type PreventiveLogFailure =
  | 'no_such_finding'
  | 'not_a_preventive_finding'
  | 'no_such_task';

export type PreventiveLogOutcome =
  | { ok: true; result: PreventiveLogResult }
  | { ok: false; because: PreventiveLogFailure };

/** The detector whose cards may record these verdicts. */
export const PREVENTIVE_DETECTOR_ID = 'preventive_due';

export async function logPreventiveOutcome(
  propertyId: string,
  findingId: string,
  outcome: PreventiveOutcome,
  actorName: string | null,
): Promise<PreventiveLogOutcome> {
  const finding = await loadFinding(propertyId, findingId);
  if (!finding) return { ok: false, because: 'no_such_finding' };

  // The detector check is not decoration. `evidence.target` is a jsonb blob, and
  // a room finding whose target happened to carry a uuid-shaped value would
  // otherwise be able to steer a write at a preventive_tasks row.
  if (finding.detectorId !== PREVENTIVE_DETECTOR_ID) {
    return { ok: false, because: 'not_a_preventive_finding' };
  }

  const target = resolveFindingTarget(finding.evidence);
  if (!target || target.kind !== 'preventive_task') {
    return { ok: false, because: 'not_a_preventive_finding' };
  }

  const db = scopedDb(propertyId);
  const nowIso = new Date().toISOString();

  // `done` clears the called flag in the same statement. It is also cleared by a
  // database trigger (0366) so that every OTHER writer — the Preventive tab's
  // "Done today", a backfill, psql — inherits the same rule; doing it here as
  // well means this path does not depend on the trigger having been applied yet.
  const patch =
    outcome === 'done'
      ? {
          last_completed_at: nowIso,
          last_completed_by: actorName ?? 'Marked done in Staxis',
          called_at: null,
          called_by: null,
        }
      : {
          // Deliberately does NOT touch last_completed_at. "Somebody's been
          // called" is the opposite of done, and a system that recorded it as a
          // completion would restart the clock on a job nobody has performed —
          // which is the single most damaging thing this feature could get
          // wrong, because it would then stay silent for a full cadence.
          called_at: nowIso,
          called_by: actorName ?? null,
        };

  const { data, error } = await db
    .from('preventive_tasks')
    .update(patch)
    .eq('id', target.value)
    .select('id, name');

  if (error) throw new Error(`preventive task update failed: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
  // The schedule was deleted between the card being written and the tap. Not an
  // error to shout about — the manager's verdict is simply about something that
  // no longer exists, and the route closes the card anyway.
  if (rows.length === 0) return { ok: false, because: 'no_such_task' };

  return { ok: true, result: { taskName: rows[0].name ?? '', outcome } };
}
