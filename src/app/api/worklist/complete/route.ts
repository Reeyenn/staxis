// ═══════════════════════════════════════════════════════════════════════════
// POST /api/worklist/complete
//
// Complete an open worklist item from the unified To-do view, routing the write
// back to the item's real module. A dispatcher: switch on sourceType, re-read
// the target row scoped by BOTH id AND property_id (a foreign-hotel id 404s,
// never acts), then write — all through supabaseAdmin.
//
//   task        comms_tasks      → status='done'        (setTaskStatus)
//                                → status='blocked' + the reason, on "Can't do this"
//   complaint   complaints       → status='resolved', resolved_at=now
//   workorder   work_orders      → status='resolved', resolved_at=now, completed_by_name
//   pm          preventive_tasks → last_completed_at=now (recurs — non-terminal)
//   reminder    agent_reminders  → canceled_at=now (it is handled; do not also DM me)
//   inspection  → 400: must be passed/failed in the inspect flow (deep-link)
//   approval    → 400: a decision is made on its own screen, with its own facts
//
// ─── the situations a maintenance row is actually in ───────────────────────
//
// Done was the ONLY button on a preventive schedule and on a work order, and
// real life has more answers than that. Each of the four below writes a fact
// that already had a home in the maintenance core; none of them is a new kind
// of state invented for a menu.
//
//   pm         called        preventive_tasks.called_at/called_by (0366). The
//                            same column the due card's "Somebody's been
//                            called" writes, so the card and the row rest
//                            together instead of one silencing the other.
//   pm         skip          preventive_tasks.skipped_at/skipped_by (0462).
//                            THIS occurrence, put down without the work being
//                            done. last_completed_at is deliberately untouched:
//                            moving it would write a service into this hotel's
//                            record that nobody performed.
//   workorder  waiting       status='deferred' + the reason in `notes`. The row
//                            STAYS on the list, sunk rather than removed.
//   workorder  not_an_issue  status='closed'. Off the board, and recorded as a
//                            non-issue rather than as a repair — which is the
//                            entire reason 'closed' and 'resolved' are two
//                            words (WORK_ORDER_SETTLED_STATUSES).
//
// All four are COMPARE-AND-SET on the ticket's current status. A settled work
// order refuses every one of them, and a ticket somebody else answered while
// this screen was open refuses too — see the note on the workorder branch.
//
// ─── "Can't do this" ───────────────────────────────────────────────────────
// `outcome: 'cant'` needs a one-line reason and REFUSES without one. The whole
// value of the state is the sentence that comes with it: an assigner who learns
// only that the work did not happen has to go and ask, which is the round trip
// the receipt exists to replace. The database says the same thing
// (comms_tasks_blocked_needs_reason, 0410) so a second caller cannot skip it.
//
// ─── the two endings an overdue to-do used to be missing (0453) ────────────
//
//   done_on_due   "Did it yesterday." completed_at stays the true instant of
//                 the tap; completed_for_date carries the day the work actually
//                 happened. Both facts, neither invented. This is the whole
//                 point: every pattern the product learns about when work gets
//                 done was previously being taught the date of the TAP, so work
//                 done on Tuesday and reported Thursday went in as Thursday's.
//                 The day is taken from the ROW, never from the caller — a
//                 browser with a wrong clock must not be able to backdate
//                 anything, and a body that could name its own day would be a
//                 way to write history.
//
//   skip          "Not needed." A fourth terminal state with no reason
//                 required. Before it, the only way to clear work that had
//                 stopped needing doing was to delete the row, and a deleted
//                 row tells the assigner nothing at all.
//
// ─── settling a collapsed repeat run ──────────────────────────────────────
// A repeating to-do spawns one row per day whether or not yesterday's got done,
// so the LIST collapses a missed run to one row. Answering that row therefore
// has to answer for the whole run, or the four rows hidden behind it come back
// tomorrow and the stacking never actually stopped. Every superseded instance
// is recorded as skipped: the acted-on day gets the outcome the person chose,
// and a day that has already passed without the work cannot honestly be marked
// done now. Each one is a real row with a real recorded outcome. Nothing is
// deleted, and the run is re-derived HERE from the database rather than trusted
// from the body.
//
// NOT gated on the Communications section. See ONE_LIST_CTX.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { validateUuid, validateEnum, validateString } from '@/lib/api-validate';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { setTaskStatus } from '@/lib/comms/core';
import { workOrderIsSettled } from '@/lib/db-mappers';
import { worklistSeesAllSources, mayActOnItem, propertyTimezoneOf } from '@/lib/worklist/core';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body { pid?: string; sourceType?: string; sourceId?: string; outcome?: string; reason?: string }

/** The most a refusal reason can be. Long enough for the real sentence, short
 *  enough that nobody pastes an essay into a list row. */
export const MAX_BLOCKED_REASON = 400;

/**
 * Every ending a row on the Staxis list can be given.
 *
 * ONE enum rather than a per-source union, because the gate below is a switch
 * on sourceType anyway and a second enum would be a second place for the two
 * lists to disagree about what a work order may be told. Which outcomes each
 * source actually accepts is stated once, in OUTCOME_SOURCES.
 */
const OUTCOMES = [
  'done', 'cant', 'done_on_due', 'skip', 'called', 'waiting', 'not_an_issue',
] as const;
type Outcome = typeof OUTCOMES[number];

/**
 * Which sources may be given which ending, and the refusal when they may not.
 *
 * Stated as data so the answer to "can a work order be marked 'did it
 * yesterday'?" is one line to read rather than four `if`s to follow, and so the
 * per-type option sets the menu renders can be checked against the same table
 * in a test. A row type that never offers an ending must also be REFUSED it:
 * a menu is not a guard, and these ids arrive over HTTP.
 */
export const OUTCOME_SOURCES: Readonly<Record<Outcome, { sources: readonly string[]; refusal: string }>> = {
  done: { sources: ['task', 'complaint', 'workorder', 'pm', 'reminder'], refusal: 'this one cannot be completed from the list' },
  // The three follow-through endings are all about a to-do specifically. A work
  // order has no assigner waiting on a receipt and no per-day instance to credit.
  cant: { sources: ['task'], refusal: 'only a to-do can be marked as one you could not do' },
  done_on_due: { sources: ['task'], refusal: 'only a to-do can be recorded this way' },
  // Skip belongs to both: a to-do that stopped needing doing, and an upkeep
  // occurrence a manager is deliberately not doing this cycle. They write to
  // different tables and mean the same sentence.
  skip: { sources: ['task', 'pm'], refusal: 'only a to-do or an upkeep schedule can be skipped' },
  called: { sources: ['pm'], refusal: 'only an upkeep schedule records that somebody has been called' },
  waiting: { sources: ['workorder'], refusal: 'only a work order can be marked as waiting on parts' },
  not_an_issue: { sources: ['workorder'], refusal: 'only a work order can be closed as not a problem' },
};

/** The most a "waiting on parts" note can be. Same bar as a refusal reason:
 *  one line somebody reads on a list row, not a paragraph. */
export const MAX_WAITING_REASON = 200;

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;
  const { pid, requestId, headers } = ctx;

  const typeV = validateEnum(body.sourceType, WORKLIST_SOURCE_TYPES, 'sourceType');
  if (typeV.error) return err(typeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const idV = validateUuid(body.sourceId, 'sourceId');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const sourceType = typeV.value!;
  const sourceId = idV.value!;

  const outcomeV = validateEnum(body.outcome ?? 'done', OUTCOMES, 'outcome');
  if (outcomeV.error) return err(outcomeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const outcome = outcomeV.value!;

  // One table, checked once. A row type that never offers an ending must also
  // be refused it: the menu is not the guard.
  const allowed = OUTCOME_SOURCES[outcome];
  if (!allowed.sources.includes(sourceType)) {
    return err(allowed.refusal, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  let reason: string | null = null;
  if (outcome === 'cant') {
    const reasonV = validateString(body.reason, { max: MAX_BLOCKED_REASON, label: 'reason' });
    if (reasonV.error || !reasonV.value!.trim()) {
      return err('say in one line why you could not do it', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
      });
    }
    reason = reasonV.value!.trim();
  }
  // "Waiting on parts" without the sentence is just a row that went quiet. The
  // reason IS the feature: it is what stops the next person having to go and
  // ask, and it is the only thing the deferred row will say for itself.
  if (outcome === 'waiting') {
    const reasonV = validateString(body.reason, { max: MAX_WAITING_REASON, label: 'reason' });
    if (reasonV.error || !reasonV.value!.trim()) {
      return err('say in one line what it is waiting on', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
      });
    }
    reason = reasonV.value!.trim();
  }

  // Floor staff may only complete manual to-dos (same property-wide scope as the
  // existing /api/comms/tasks PATCH). The cross-department sources
  // (complaint/workorder/pm/inspection) are management + front-desk only.
  // Checked before any row read, so it never leaks whether an id exists.
  // A reminder joins 'task' on the floor-staff side: it is a note somebody left
  // for themselves or for one person, and dismissing your own reminder is not a
  // cross-department action.
  if (sourceType !== 'task' && sourceType !== 'reminder' && !worklistSeesAllSources(ctx.role)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
  }

  const rl = await checkAndIncrementRateLimit('worklist-complete', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // ── whose item is this? ──────────────────────────────────────────────────
  // The list narrowed to "what is on my screen" but this handler still took any
  // id in the property, so the two drifted: a to-do handed to one person could
  // be closed by anybody who had its id, and a reminder aimed at one person
  // could be cancelled by somebody it was never for. The read rule and the
  // write rule are now the same rule. Management and the author keep their
  // override — see mayActOnItem.
  const viewer = { staffId: ctx.staffId, accountId: ctx.accountId, role: ctx.role, dept: ctx.dept };
  if (sourceType === 'task' || sourceType === 'reminder') {
    const owner = await itemOwnership(sourceType, sourceId, pid);
    if (!owner) return notFound(requestId, headers);
    if (!mayActOnItem(owner, viewer)) {
      return err('this one is not yours to close', {
        requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
      });
    }
  }

  try {
    switch (sourceType) {
      case 'task': {
        if (outcome === 'skip') {
          // No reason required, and that is the whole difference from 'cant'.
          // Only from 'open', so a stale screen cannot rewrite a completion.
          const { data, error } = await supabaseAdmin
            .from('comms_tasks')
            .update({
              status: 'skipped',
              skipped_at: new Date().toISOString(),
              skipped_by_staff_id: ctx.staffId,
              updated_at: new Date().toISOString(),
            })
            .eq('id', sourceId).eq('property_id', pid).eq('status', 'open')
            .select('id').maybeSingle();
          if (error) return fail(requestId, headers, error.message);
          if (!data) return notFound(requestId, headers);
          await settleSupersededRun(sourceId, pid, ctx.staffId);
          break;
        }
        if (outcome === 'done_on_due') {
          // The credited day comes from the ROW, never from the caller. A body
          // that could name its own date would be a way to write history, and a
          // browser with a wrong clock would do it by accident.
          const day = await creditableDay(sourceId, pid);
          if (!day) return notFound(requestId, headers);
          const nowIso = new Date().toISOString();
          const { data, error } = await supabaseAdmin
            .from('comms_tasks')
            .update({
              status: 'done',
              // The true instant of the tap. Not backdated: when somebody told
              // us is a fact, and it is a different fact from when the work
              // happened. Both are kept, so neither has to be guessed later.
              completed_at: nowIso,
              completed_by_staff_id: ctx.staffId,
              completed_for_date: day,
              updated_at: nowIso,
            })
            .eq('id', sourceId).eq('property_id', pid).eq('status', 'open')
            .select('id').maybeSingle();
          if (error) return fail(requestId, headers, error.message);
          if (!data) return notFound(requestId, headers);
          await settleSupersededRun(sourceId, pid, ctx.staffId);
          break;
        }
        if (outcome === 'cant') {
          // Scoped by id AND property_id, and only from 'open' — so a second tap
          // on a stale screen cannot overwrite a completion with a refusal.
          const { data, error } = await supabaseAdmin
            .from('comms_tasks')
            .update({
              status: 'blocked',
              blocked_at: new Date().toISOString(),
              blocked_by_staff_id: ctx.staffId,
              blocked_reason: reason,
              updated_at: new Date().toISOString(),
            })
            .eq('id', sourceId).eq('property_id', pid).eq('status', 'open')
            .select('id').maybeSingle();
          if (error) return fail(requestId, headers, error.message);
          if (!data) return notFound(requestId, headers);
          await settleSupersededRun(sourceId, pid, ctx.staffId);
          break;
        }
        // setTaskStatus is itself scoped by id + property_id; false = not found.
        const done = await setTaskStatus(pid, sourceId, 'done', ctx.staffId);
        if (!done) return notFound(requestId, headers);
        await settleSupersededRun(sourceId, pid, ctx.staffId);
        break;
      }
      case 'complaint': {
        if (!(await existsScoped('complaints', sourceId, pid))) return notFound(requestId, headers);
        const { error } = await supabaseAdmin
          .from('complaints')
          .update({ status: 'resolved', resolved_at: new Date().toISOString() })
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'workorder': {
        // ── a settled ticket is not a ticket any more ────────────────────────
        // The three endings below used to be written with nothing but "does
        // this id exist at this hotel", so a Staxis list drawn two minutes ago
        // could rewrite a settlement it had never seen. Each direction is a
        // real loss:
        //   closed  → waiting   puts a ticket somebody judged a non issue BACK
        //                       on every screen as live work, and wipes the
        //                       note that explained it.
        //   closed  → done      files a repair nobody performed, and — when the
        //                       ticket came from an upkeep schedule — stamps
        //                       that schedule serviced through the 0366 trigger,
        //                       after which Staxis goes quiet about the job for
        //                       a full cadence.
        //   resolved→ not_an_issue rewrites a repair that DID happen as a thing
        //                       that never needed doing, over the top of the
        //                       name of whoever actually did it.
        // So the row's CURRENT status is read first, and then carried into the
        // update as a condition: the write lands only if the ticket is still in
        // the exact state this request was validated against. The gap between
        // the two reads is not a way through.
        const current = await workOrderStatus(sourceId, pid);
        if (current === null) return notFound(requestId, headers);
        if (workOrderIsSettled(current)) return alreadyAnswered(requestId, headers);
        const nowIso = new Date().toISOString();
        // Three endings, and the difference between them is a fact about the
        // building rather than a shade of the same one.
        const patch: Record<string, unknown> = outcome === 'waiting'
          // NOT an ending at all: the ticket is still live work and still on the
          // list. `notes` carries the sentence, which is the only thing the
          // deferred row has to say for itself.
          ? { status: 'deferred', notes: reason }
          : outcome === 'not_an_issue'
            // Off the board, recorded as a non-issue. `resolved_at` is stamped
            // because it is when the ticket was settled, and the STATUS is what
            // says it was not a repair. `completed_by_name` is who made that
            // call, which is the one thing an auditor would want to know.
            ? { status: 'closed', resolved_at: nowIso, completed_by_name: ctx.displayName }
            : { status: 'resolved', resolved_at: nowIso, completed_by_name: ctx.displayName };
        const { data, error } = await supabaseAdmin
          .from('work_orders')
          .update(patch)
          .eq('id', sourceId).eq('property_id', pid)
          // The state this request was validated against, and the whole of the
          // race guard. Somebody else answering the same ticket in the
          // meantime — settling it, or deferring it — takes this write out.
          .eq('status', current)
          .select('id').maybeSingle();
        if (error) return fail(requestId, headers, error.message);
        if (!data) return alreadyAnswered(requestId, headers);
        break;
      }
      case 'pm': {
        if (!(await existsScoped('preventive_tasks', sourceId, pid))) return notFound(requestId, headers);
        const nowIso = new Date().toISOString();
        // Three answers about a job out in the building, and only one of them
        // is a completion. The other two deliberately leave `last_completed_at`
        // alone: recording either as a completion would restart the clock on a
        // job nobody performed and then stay silent for a full cadence about it.
        //
        // Each rest CLEARS THE OTHER. Somebody who skips this occurrence is no
        // longer waiting on a call, and somebody who says a vendor is coming has
        // stopped skipping it. Leaving both set would be a schedule resting for
        // two different reasons at once, which is not a thing that can be true.
        const patch: Record<string, unknown> = outcome === 'called'
          ? { called_at: nowIso, called_by: ctx.displayName, skipped_at: null, skipped_by: null }
          : outcome === 'skip'
            ? { skipped_at: nowIso, skipped_by: ctx.displayName, called_at: null, called_by: null }
            // Recurring: stamping last_completed_at resets the cycle (not
            // terminal). The database trigger from 0366 clears called_at on the
            // way through, and a stale skipped_at is inert by construction
            // (see lib/maintenance/preventive-rest.ts).
            : { last_completed_at: nowIso, last_completed_by: ctx.displayName };
        const { error } = await supabaseAdmin
          .from('preventive_tasks')
          .update(patch)
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'reminder': {
        // Handled means stop reminding me. Cancel rather than delete so the row
        // stays auditable, and only from still-pending so a reminder that fired
        // a second ago is not retroactively rewritten as cancelled.
        const { data, error } = await supabaseAdmin
          .from('agent_reminders')
          .update({ canceled_at: new Date().toISOString() })
          .eq('id', sourceId).eq('property_id', pid)
          .is('fired_at', null).is('canceled_at', null)
          .select('id').maybeSingle();
        if (error) return fail(requestId, headers, error.message);
        if (!data) return notFound(requestId, headers);
        break;
      }
      case 'inspection':
        return err('inspections are passed or failed in the inspect flow', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
      case 'approval':
        // Deliberate: a one-tap yes on a list row is a decision made with less
        // than the facts. Letting somebody onto the payroll or granting a day
        // off happens on the screen that shows the rest of the picture.
        return err('open this one to decide it', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
    }
    // `recorded`, not `completed`. Four of the seven endings do not complete
    // anything — a deferral, a rest and a refusal are all things that happened
    // to the row without the work being done, and a field that called them
    // completions would be the same small lie the endings exist to avoid.
    return ok({ recorded: true, sourceType, outcome }, { requestId, headers });
  } catch (e) {
    log.error('[worklist] complete failed', { requestId, pid, sourceType, err: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
}

/**
 * Who a to-do or reminder belongs to, scoped by id AND property_id.
 *
 * Returns null when the row is not this hotel's — a foreign id is
 * indistinguishable from a missing one, so it 404s rather than 403s and never
 * reveals that the id exists somewhere.
 */
async function itemOwnership(
  sourceType: 'task' | 'reminder',
  id: string,
  pid: string,
): Promise<{ assignedStaffId: string | null; assignedDepartment: string | null; createdByStaffId: string | null } | null> {
  const [table, assignee, dept] = sourceType === 'task'
    ? ['comms_tasks', 'assigned_staff_id', 'assigned_department'] as const
    : ['agent_reminders', 'target_staff_id', 'target_department'] as const;
  const { data } = await supabaseAdmin
    .from(table)
    .select(`${assignee}, ${dept}, created_by_staff_id`)
    .eq('id', id).eq('property_id', pid)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    assignedStaffId: (row[assignee] as string | null) ?? null,
    assignedDepartment: (row[dept] as string | null) ?? null,
    createdByStaffId: (row.created_by_staff_id as string | null) ?? null,
  };
}

/**
 * Which day a "Did it yesterday" completion is credited to.
 *
 * Read off the ROW, in this order:
 *   1. the instance day, for a to-do spawned by a repeating template — the
 *      spawner writes no due_at at all, so this is the only day it has;
 *   2. otherwise the local day its due_at falls on, in the HOTEL's timezone.
 *      The server's own clock is UTC, and reading the day off it would credit
 *      work done on Tuesday evening in Texas to Wednesday.
 *
 * Null when the row has no day to credit, which is not an error state to paper
 * over: a to-do with no due date was never late, so there is nothing to
 * backdate, and the caller 404s rather than inventing one.
 */
async function creditableDay(id: string, pid: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('comms_tasks')
    .select('due_at, recurring_instance_date')
    .eq('id', id).eq('property_id', pid).eq('status', 'open')
    .maybeSingle();
  if (!data) return null;
  const row = data as { due_at?: string | null; recurring_instance_date?: string | null };
  if (row.recurring_instance_date) return row.recurring_instance_date;
  if (!row.due_at) return null;
  const ms = Date.parse(row.due_at);
  if (!Number.isFinite(ms)) return null;
  return propertyLocalToday(new Date(ms), await propertyTimezoneOf(pid));
}

/**
 * Close the older instances the answered row was standing in for.
 *
 * The list shows a missed repeating to-do ONCE. Answering that one row has to
 * answer for the run behind it, or the rows it was hiding come back tomorrow
 * and nothing was actually collapsed.
 *
 * They are recorded as SKIPPED rather than given the same outcome, and that is
 * the honest reading: a person tapping Done on today's row is saying they did
 * it today, not that they also did Monday's and Tuesday's. A day that has gone
 * by without the work cannot be marked done now without writing a fiction into
 * the same history this whole change exists to keep true.
 *
 * The run is derived HERE from the database. The browser sends only the id of
 * the row somebody actually pressed: a body that could list ids to close would
 * be a way to close arbitrary to-dos, and the ownership check above only ever
 * examined the one.
 *
 * Best effort by design. The row the person pressed is already settled and
 * their tap has landed; a failure here means one stale sibling reappears, which
 * the next collapse folds away again. Failing the request would undo work that
 * genuinely happened.
 */
async function settleSupersededRun(id: string, pid: string, byStaffId: string | null): Promise<void> {
  try {
    const { data: self } = await supabaseAdmin
      .from('comms_tasks')
      .select('recurring_template_id, recurring_instance_date')
      .eq('id', id).eq('property_id', pid)
      .maybeSingle();
    const row = self as { recurring_template_id?: string | null; recurring_instance_date?: string | null } | null;
    if (!row?.recurring_template_id || !row.recurring_instance_date) return;

    const nowIso = new Date().toISOString();
    // Strictly OLDER instances only, and only ones still open. A future
    // instance is not something anybody has missed, and an already-settled one
    // keeps whatever it was settled as.
    const { error } = await supabaseAdmin
      .from('comms_tasks')
      .update({
        status: 'skipped',
        skipped_at: nowIso,
        skipped_by_staff_id: byStaffId,
        updated_at: nowIso,
      })
      .eq('property_id', pid)
      .eq('recurring_template_id', row.recurring_template_id)
      .eq('status', 'open')
      .lt('recurring_instance_date', row.recurring_instance_date);
    if (error) log.warn('[worklist] superseded run not settled', { pid, err: error.message });
  } catch (e) {
    log.warn('[worklist] superseded run not settled', { pid, err: errToString(e) });
  }
}

/**
 * A work order's stored status, scoped by BOTH id AND property_id.
 *
 * Null for a row that is not this hotel's, exactly like `existsScoped` — a
 * foreign id has to stay indistinguishable from a missing one. Returns the raw
 * legacy enum value ('submitted' / 'assigned' / 'in_progress' / 'deferred' /
 * 'resolved' / 'closed') rather than the two-word UI status, because it is used
 * as the compare-and-set condition on the update and has to be the same string
 * the column holds.
 */
async function workOrderStatus(id: string, pid: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('work_orders')
    .select('status')
    .eq('id', id).eq('property_id', pid)
    .maybeSingle();
  if (!data) return null;
  const status = (data as { status?: unknown }).status;
  // An absent status reads as an open ticket everywhere else on the board
  // (db-mappers.ts's own fallback); it must read the same here, or a legacy row
  // with a null status would be unanswerable.
  return typeof status === 'string' ? status : 'submitted';
}

/**
 * Somebody got to this row first.
 *
 * 409 rather than 404: the ticket is real and the caller is entitled to it, the
 * screen they tapped from is simply out of date. Deliberately NOT a silent
 * success — a write that reports as recorded and changed nothing is the failure
 * the whole endings vocabulary exists to avoid.
 */
function alreadyAnswered(requestId: string, headers: Record<string, string>) {
  return err('Somebody already answered this one. Refresh the list to see where it got to.', {
    requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers,
  });
}

/**
 * Re-read a row scoped by BOTH id AND property_id — a foreign id is
 * indistinguishable from a missing one.
 *
 * WORK ORDERS ARE DELIBERATELY NOT IN THIS UNION. "It exists" is not enough for
 * a table with two settled statuses; that branch reads the status and writes
 * against it (workOrderStatus above), and a mere existence check there is the
 * bug this note exists to stop somebody re-introducing.
 */
async function existsScoped(table: 'complaints' | 'preventive_tasks', id: string, pid: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from(table).select('id').eq('id', id).eq('property_id', pid).maybeSingle();
  return !!data;
}

function notFound(requestId: string, headers: Record<string, string>) {
  return err('item not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });
}
function fail(requestId: string, headers: Record<string, string>, msg: string) {
  log.error('[worklist] complete write failed', { requestId, err: msg });
  return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
}
