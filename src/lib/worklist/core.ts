// ═══════════════════════════════════════════════════════════════════════════
// Unified Worklist aggregator.
//
// gatherWorklist(pid) fans out to every source's open items, all via
// supabaseAdmin (uniform server-side reads, every query property-scoped),
// normalizes each row to a WorklistItem, then merges + sorts (overdue first,
// then by due date, then newest). Mirrors gatherOperationalSignals
// (src/lib/agent/operational-signals.ts) — bounded Promise.all + per-source
// error logging so a single failed query degrades to "fewer items", never a
// silent empty list.
//
// Source matrix (build to this, sources are NOT uniform):
//   task        comms_tasks       status='open'                 complete ✓  assign(staff) ✓
//   complaint   complaints        status in (open,in_progress)  complete ✓  assign(staff) ✓
//   workorder   work_orders       DB status not settled         complete ✓  assign(staff|lane) ✓
//   inspection  buildInspectionQueue(today)                     deep-link   (no assign)
//   pm          preventive_tasks  overdue/soon, not resting      complete ✓  (no assign)
//   reminder    agent_reminders   pending + due by end of today  complete ✓  (no assign)
//   approval    join_requests + time_off_requests, status='pending'
//                                                                deep-link   (no assign)
//
// ─── who sees what ─────────────────────────────────────────────────────────
// Two independent narrowings, and they answer different questions:
//
//   worklistSeesAllSources(role)  — WHICH SOURCES a role may read at all. The
//     security boundary: complaints carry guest PII and are management-gated
//     everywhere else in the product.
//
//   taskVisibleToViewer(task, viewer) — WHOSE LIST a to-do belongs on. Not a
//     security boundary (a manager could read the row through a dozen other
//     surfaces); a product rule. The founder's: a task you handed to somebody
//     else lives on THEIR page and nowhere else. What you handed out is
//     answered by the Assigned-by-me drawer, which is a different question and
//     gets a different screen.
//
// Passing no viewer keeps the old whole-property behaviour, which is what the
// agent-side readers want: they are answering "what is open at this hotel",
// not "what is on my screen".
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { APP_TIMEZONE } from '@/lib/utils';
import { endOfLocalDay, localDaysBetween, propertyLocalToday } from '@/lib/schedule/local-date';
import { validPropertyTimezone } from '@/lib/property-timezone';
import { log } from '@/lib/log';
import { buildInspectionQueue } from '@/lib/housekeeping/inspection-queue';
import { COMPLAINT_OVERDUE_HOURS, COMPLAINT_OVERDUE_HOURS_HIGH } from '@/lib/complaints-shared';
import { workOrderIsSettled } from '@/lib/db-mappers';
import { preventiveRestOf } from '@/lib/maintenance/preventive-rest';
import { isAssignable, type AssignableStaffRow } from './assignable';
import { NEW_ON_LIST_FLOOR_DAYS } from '@/lib/feed/one-list';
import type { AssignedByMeItem, WorklistItem, WorklistPriority, WorklistViewer } from './types';

/** Deep-link targets per source (the page + the tab query param it now reads). */
export const WORKLIST_DEEPLINK: Record<WorklistItem['sourceType'], string> = {
  // To-dos and reminders now live on the Staxis list itself. The link exists so
  // a row opened from anywhere else in the app lands somewhere real; it is not
  // a "go somewhere to do this", because the doing happens on the row.
  task: '/feed',
  complaint: '/feed',
  reminder: '/feed',
  workorder: '/maintenance?tab=work',
  inspection: '/housekeeping?tab=quality',
  pm: '/maintenance?tab=preventive',
  // Decisions keep their own screens: approving somebody onto the payroll or
  // granting a day off needs the fields that screen has, and a one-tap yes on a
  // list row would be a decision made with less than the facts.
  approval: '/company',
};

const QUERY_ROW_CAP = 500;

/**
 * Roles that see the FULL cross-department worklist (complaints, work orders,
 * inspections, preventive). Everyone else (housekeeping / maintenance / staff)
 * sees only their manual to-dos — complaints in particular are management-gated
 * everywhere else and must not leak into a floor-staff To-do view.
 */
export function worklistSeesAllSources(role: string): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager' || role === 'front_desk';
}

/**
 * Roles that see decisions waiting on a manager (join requests, time off).
 * Deliberately NARROWER than worklistSeesAllSources: the front desk sees the
 * hotel's work, not its personnel decisions.
 */
export function worklistSeesApprovals(role: string): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

/** The department a viewer counts as, for department-targeted to-dos. */
export function viewerDepartment(viewer: Pick<WorklistViewer, 'dept' | 'role'>): string | null {
  if (viewer.dept) return viewer.dept;
  if (viewer.role === 'housekeeping' || viewer.role === 'maintenance' || viewer.role === 'front_desk') {
    return viewer.role;
  }
  return null;
}

/**
 * Is this to-do on THIS person's list?
 *
 * Pure and exported because it is the whole of the founder's assignment rule,
 * and the rule is only worth anything if it holds in both directions: the
 * assignee sees it, and the assigner does not. A test that only checks the
 * first half would pass on the bug that matters.
 *
 * `viewer === null` means "no particular person is asking" — the agent tools
 * and any cross-hotel reader. They get the whole property, unchanged.
 */
export function taskVisibleToViewer(
  task: {
    assignedStaffId: string | null;
    assignedDepartment: string | null;
    createdByStaffId: string | null;
  },
  viewer: WorklistViewer | null,
): boolean {
  if (!viewer) return true;

  // Handed to a person: theirs, and only theirs. This is the line the whole
  // assignment loop rests on — if a manager's own list kept a copy of
  // everything they delegated, the list would grow with every hand-off and stop
  // being a list of what THEY have to do.
  if (task.assignedStaffId) return task.assignedStaffId === viewer.staffId;

  // Handed to a role: everyone in that role, plus the two catch-alls.
  //
  // AND THEN IT FALLS THROUGH, which is the part that was missing. A department
  // is not a person, so nobody was handed anything and nothing left anybody's
  // plate — but this used to `return` the department match, which took the row
  // off the author's list and off every manager's list at the same moment.
  //
  // What that produced: a GM types "Fix the ice machine" for Maintenance, the
  // row saves, and it is on no screen the GM can reach. Not the list (this
  // function had already refused it), not the Assigned-by-me panel
  // (keepForAssigner drops a waiting department row on the stated grounds that
  // "listing it as outstanding would just be the author's own list a second
  // time" — a sentence that is only true if it IS on the author's list). At a
  // hotel with nobody in that department, which is most limited-service hotels
  // for maintenance, it reached zero screens in the product. The chat door does
  // the same thing on its own: log_complaint's "Also add to the to-do list"
  // files the follow-up to `maintenance` and says so out loud.
  //
  // So the department match is now one WAY IN rather than the only one, and the
  // two clauses below apply to a department row exactly as they always did to
  // an unassigned one. Handing work to a PERSON is untouched: that branch still
  // returns above, so a delegated to-do still leaves the assigner's list, which
  // is the founder's rule and the whole reason the drawer exists.
  if (task.assignedDepartment) {
    if (task.assignedDepartment === 'all_staff' || task.assignedDepartment === 'general') return true;
    if (task.assignedDepartment === viewerDepartment(viewer)) return true;
  }

  // Handed to nobody, or to a department this person is not in. It is the
  // house's, so it is the manager's — and always the author's, so a to-do
  // somebody typed for themselves through the chat door can never end up on
  // nobody's screen.
  if (task.createdByStaffId && task.createdByStaffId === viewer.staffId) return true;
  return worklistSeesApprovals(viewer.role);
}

/**
 * May this person ACT on this item — check it off, or say they could not do it?
 *
 * The write-seam twin of taskVisibleToViewer, and it exists because filtering a
 * read has never stopped a request that named an id directly. The list narrowed
 * to "what is on my screen" while the complete handler still accepted any id in
 * the property, so a line cook who had an id could close the general manager's
 * private to-do, and any one person could cancel a reminder aimed at somebody
 * else. Read and write must not be able to drift apart.
 *
 * Deliberately WIDER than taskVisibleToViewer, because closing work is not the
 * same question as being shown it:
 *   - it is on your list          → yours to finish
 *   - you asked for it            → yours to call off
 *   - you manage the hotel        → yours to close, whoever is holding it
 *
 * That last line is why this is not simply taskVisibleToViewer: a delegated
 * to-do deliberately leaves the manager's list, and a manager who can no longer
 * close out something they handed over would be worse off than before.
 */
export function mayActOnItem(
  item: {
    assignedStaffId: string | null;
    assignedDepartment: string | null;
    createdByStaffId: string | null;
  },
  viewer: WorklistViewer | null,
): boolean {
  if (!viewer) return true;
  if (taskVisibleToViewer(item, viewer)) return true;
  if (item.createdByStaffId && item.createdByStaffId === viewer.staffId) return true;
  return worklistSeesApprovals(viewer.role);
}

// ═══════════════════════════════════════════════════════════════════════════
// Repeating to-dos never stack
//
// The recurrence engine spawns one comms_tasks row per template per local day,
// and it does that whether or not yesterday's row got done — deliberately, so
// each day keeps its own done/undone history (see 0303). The cost is that a
// daily to-do nobody did for five days is FIVE OPEN ROWS saying the same
// sentence, and a list that says one thing five times is not a list any more.
//
// So the read collapses the run to ONE row and the write settles the whole run
// behind it. Which row survives is not arbitrary: it is the NEWEST instance,
// because that is the one that is genuinely owed now. The days behind it are
// carried on that row as `missedSince`, which is what turns five copies into
// one row reading "missed since Monday".
//
// Nothing is deleted and nothing is hidden from the database. Settling the
// survivor records a real, separate outcome on every instance it stood for.
// ═══════════════════════════════════════════════════════════════════════════

/** One spawned instance, reduced to the three things the collapse needs. */
export interface RepeatInstance {
  id: string;
  /** Null for a to-do that does not repeat. Those are never collapsed. */
  templateId: string | null;
  /** The local day this instance was spawned for, YYYY-MM-DD, or null. */
  day: string | null;
}

/** What survived, and what it now speaks for. */
export interface RepeatRun {
  /** Oldest first. Every one of these is settled with the survivor. */
  supersededIds: string[];
  /** The oldest day in the run, when there is more than one. */
  missedSince: string | null;
}

/**
 * Decide, for a set of open instances, which rows survive and what each speaks
 * for.
 *
 * Returns an entry for every row that SURVIVES, keyed by its id. A row absent
 * from the map is either not a repeat (callers check the template id) or a
 * superseded instance the caller should drop.
 *
 * Pure, and separately exported, because "does a missed daily to-do show up
 * once or five times" is the question this whole function exists to answer and
 * it must be answerable without a database.
 */
export function collapseRepeatInstances(
  instances: readonly RepeatInstance[],
): Map<string, RepeatRun> {
  const byTemplate = new Map<string, RepeatInstance[]>();
  const out = new Map<string, RepeatRun>();

  for (const instance of instances) {
    if (!instance.templateId) continue;
    const bucket = byTemplate.get(instance.templateId);
    if (bucket) bucket.push(instance);
    else byTemplate.set(instance.templateId, [instance]);
  }

  for (const bucket of byTemplate.values()) {
    // Oldest first. An instance with no day sorts oldest: it cannot be shown to
    // be today's, and treating an unknown as the newest would let it win the
    // run and take today's real row off the screen.
    const ordered = [...bucket].sort((a, b) => {
      if (a.day === b.day) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (!a.day) return -1;
      if (!b.day) return 1;
      return a.day < b.day ? -1 : 1;
    });
    const survivor = ordered[ordered.length - 1];
    const superseded = ordered.slice(0, -1);
    out.set(survivor.id, {
      supersededIds: superseded.map((i) => i.id),
      // The oldest day still open. Null when this is the only instance, which
      // is the ordinary case: one row, nothing missed, nothing to say.
      missedSince: superseded.length > 0 ? (superseded[0].day ?? null) : null,
    });
  }

  return out;
}

/**
 * A Postgres `time` as the one shape the rest of the product reads: "HH:MM".
 *
 * PostgREST hands back "15:00:00", and a client that string-compared that
 * against a parser's "15:00" would quietly decide the two were different times.
 * Anything unrecognisable becomes null rather than travelling on as a value
 * nothing downstream can read.
 */
export function normalizeClock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${`${hour}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`;
}

export interface GatherOptions {
  tasksOnly?: boolean;
  /** Who is looking. Omit for the whole-property view. */
  viewer?: WorklistViewer | null;
}

/** Gather every open actionable item for one property, normalized + sorted. */
export async function gatherWorklist(pid: string, opts: GatherOptions = {}): Promise<WorklistItem[]> {
  const now = Date.now();
  const tasksOnly = !!opts.tasksOnly;
  const viewer = opts.viewer ?? null;
  const wantsApprovals = !tasksOnly && (!viewer || worklistSeesApprovals(viewer.role));
  const emptyRes = () => Promise.resolve({ data: [] as Record<string, unknown>[], error: null as { message: string } | null });

  // ── the hotel's clock, not the server's ──────────────────────────────────
  // "End of today" used to be `setHours(23,59,59)` on the SERVER's clock, and
  // the server runs in UTC — so end-of-today was 6:59pm in Texas. A reminder
  // set for tonight did not reach tonight's list, and a preventive task due
  // this evening was filed as tomorrow's. One read of the hotel's timezone
  // fixes every date on this list at once.
  const tz = await propertyTimezoneOf(pid);
  const today = propertyLocalToday(new Date(now), tz);
  const endOfTodayMs = endOfLocalDay(today, tz).getTime();
  const endOfTodayIso = new Date(endOfTodayMs).toISOString();

  const [
    taskRes, complaintRes, workorderRes, pmRes, inspectionQueue,
    reminderRes, joinRes, timeOffRes,
  ] = await Promise.all([
    supabaseAdmin
      .from('comms_tasks')
      .select('id, title, assigned_staff_id, assigned_department, due_at, due_time, status, priority, created_at, created_by_staff_id, recurring_template_id, recurring_instance_date')
      .eq('property_id', pid)
      .eq('status', 'open')
      .limit(QUERY_ROW_CAP),
    tasksOnly ? emptyRes() : supabaseAdmin
      .from('complaints')
      .select('id, room_number, category, severity, description, status, assigned_to, assigned_name, assigned_dept, created_at')
      .eq('property_id', pid)
      .in('status', ['open', 'in_progress'])
      .limit(QUERY_ROW_CAP),
    tasksOnly ? emptyRes() : supabaseAdmin
      .from('work_orders')
      .select('id, room_number, description, severity, status, notes, assigned_to, assigned_name, created_at')
      .eq('property_id', pid)
      // `resolved` is filtered in the query because it is the overwhelming bulk
      // of the table at a hotel that has been running a while. The second ending
      // (`closed`, from "Not actually a problem") is filtered in JS below: it is
      // rare, and a two-value NOT IN written as a PostgREST expression is a
      // string nobody can read and one typo away from filtering nothing.
      .neq('status', 'resolved')
      .limit(QUERY_ROW_CAP),
    tasksOnly ? emptyRes() : supabaseAdmin
      .from('preventive_tasks')
      .select('id, name, area, frequency_days, last_completed_at, called_at, skipped_at, created_at')
      .eq('property_id', pid)
      .limit(QUERY_ROW_CAP),
    // Inspection queue is derived (rooms clean-but-uninspected / failed-re-cleaned).
    tasksOnly ? Promise.resolve([] as Awaited<ReturnType<typeof buildInspectionQueue>>) : buildInspectionQueue(pid, today).catch((e) => {
      log.error('[worklist] inspection queue failed', { pid, err: e instanceof Error ? e.message : String(e) });
      return [];
    }),
    // A reminder somebody set is a thing that needs a person the moment it comes
    // due, so it belongs on the list rather than only arriving as a message.
    // Only ones due by tonight: a reminder set for next month is not today's work.
    supabaseAdmin
      .from('agent_reminders')
      .select('id, body, fire_at, target_staff_id, target_department, created_by_staff_id, created_at')
      .eq('property_id', pid)
      .is('fired_at', null)
      .is('canceled_at', null)
      .lte('fire_at', endOfTodayIso)
      .limit(QUERY_ROW_CAP),
    wantsApprovals ? supabaseAdmin
      .from('join_requests')
      .select('id, name, department, status, created_at')
      .eq('property_id', pid)
      .eq('status', 'pending')
      .limit(QUERY_ROW_CAP) : emptyRes(),
    wantsApprovals ? supabaseAdmin
      .from('time_off_requests')
      .select('id, staff_id, request_date, reason, status, submitted_at, created_at')
      .eq('property_id', pid)
      .eq('status', 'pending')
      .limit(QUERY_ROW_CAP) : emptyRes(),
  ]);

  for (const [label, res] of [
    ['comms_tasks', taskRes], ['complaints', complaintRes],
    ['work_orders', workorderRes], ['preventive_tasks', pmRes],
    ['agent_reminders', reminderRes], ['join_requests', joinRes],
    ['time_off_requests', timeOffRes],
  ] as const) {
    if (res.error) log.error(`[worklist] ${label} query failed`, { pid, err: res.error.message });
  }

  const items: WorklistItem[] = [];

  // ── Manual to-dos ──────────────────────────────────────────────────────────
  const taskRows = ((taskRes.data ?? []) as Record<string, unknown>[]).filter((r) =>
    taskVisibleToViewer({
      assignedStaffId: (r.assigned_staff_id as string | null) ?? null,
      assignedDepartment: (r.assigned_department as string | null) ?? null,
      createdByStaffId: (r.created_by_staff_id as string | null) ?? null,
    }, viewer),
  );
  // Resolve display names for the tasks that name a person — the assignee for
  // the row itself, and the author for the "Marcus asked you to" half of the
  // sentence. One staff read covers both.
  const nameMap = await staffNameMap(pid, [
    ...taskRows.map((r) => r.assigned_staff_id as string | null),
    ...taskRows.map((r) => r.created_by_staff_id as string | null),
    ...((reminderRes.data ?? []) as Record<string, unknown>[]).map((r) => r.created_by_staff_id as string | null),
    ...((reminderRes.data ?? []) as Record<string, unknown>[]).map((r) => r.target_staff_id as string | null),
    ...((timeOffRes.data ?? []) as Record<string, unknown>[]).map((r) => r.staff_id as string | null),
  ].filter((x): x is string => !!x));

  // ── which instances of a repeating to-do are standing in for which ───────
  // A template spawns one row per day whether or not yesterday's got done, so a
  // daily to-do nobody did for five days was five identical rows. Decided once,
  // here, over the rows this viewer can actually see: a run they only half see
  // must not be collapsed onto a row that is not on their screen.
  const runs = collapseRepeatInstances(taskRows.map((r) => ({
    id: String(r.id),
    templateId: (r.recurring_template_id as string | null) ?? null,
    day: (r.recurring_instance_date as string | null) ?? null,
  })));

  for (const r of taskRows) {
    const id = String(r.id);
    const run = runs.get(id);
    // A superseded instance is not dropped from the world, it is spoken for by
    // the row that survived. It has no run entry of its own.
    if (run === undefined && (r.recurring_template_id as string | null)) continue;
    const instanceDay = (r.recurring_instance_date as string | null) ?? null;
    // A spawned instance carries no due_at at all: its day IS the day it was
    // spawned for. Without this, yesterday's missed instance was never overdue,
    // never climbed, and sat below this morning's work forever.
    const due = (r.due_at as string | null)
      ?? (instanceDay ? endOfLocalDay(instanceDay, tz).toISOString() : null);
    const assignedStaffId = (r.assigned_staff_id as string | null) ?? null;
    const authorId = (r.created_by_staff_id as string | null) ?? null;
    const dueDay = instanceDay ?? (due ? propertyLocalToday(new Date(Date.parse(due)), tz) : null);
    // The first day this was owed and not done. For a collapsed run it is the
    // oldest open instance; for a plain to-do it is its own day, once past.
    const missedSince = run?.missedSince
      ?? (dueDay && due && Date.parse(due) < now ? dueDay : null);
    items.push({
      id: `task:${r.id}`,
      sourceType: 'task',
      sourceId: id,
      title: String(r.title ?? ''),
      location: null,
      assigneeStaffId: assignedStaffId,
      assigneeName: assignedStaffId ? nameMap.get(assignedStaffId) ?? null : null,
      dept: (r.assigned_department as string | null) ?? null,
      dueDate: due,
      // Already worked out above, in the hotel's own calendar. Carried so the
      // month grid and the week strip do not have to re-derive it from the
      // instant in the reader's timezone. See WorklistItem.dueDay.
      dueDay,
      status: 'open',
      priority: normalizePriority((r.priority as string | null) ?? 'normal'),
      propertyId: pid,
      // A run with a missed day behind it is overdue even when the surviving
      // instance is today's: the work is late, and which row is carrying that
      // fact is an implementation detail nobody on the floor should feel.
      overdue: (!!due && Date.parse(due) < now) || !!run?.missedSince,
      canComplete: true,
      canAssign: true,
      deepLink: WORKLIST_DEEPLINK.task,
      createdAt: (r.created_at as string | null) ?? null,
      // Only somebody ELSE gets named. "You asked you to" is not a sentence, and
      // a to-do you typed for yourself does not need to be introduced.
      fromLabel: authorId && authorId !== viewer?.staffId
        ? (nameMap.get(authorId) ?? null)
        : null,
      amountCents: null,
      createdByStaffId: authorId,
      dueTime: normalizeClock(r.due_time),
      recurringTemplateId: (r.recurring_template_id as string | null) ?? null,
      missedSince,
      supersededIds: run?.supersededIds ?? [],
    });
  }

  // ── Complaints ───────────────────────────────────────────────────────────────
  for (const r of (complaintRes.data ?? []) as Record<string, unknown>[]) {
    const created = (r.created_at as string | null) ?? null;
    const severity = String(r.severity ?? 'medium');
    const room = (r.room_number as string | null) ?? null;
    items.push({
      id: `complaint:${r.id}`,
      sourceType: 'complaint',
      sourceId: String(r.id),
      title: String(r.description ?? '') || 'Complaint',
      location: room ? `Room ${room}` : null,
      assigneeStaffId: (r.assigned_to as string | null) ?? null,
      assigneeName: (r.assigned_name as string | null) ?? null,
      dept: (r.assigned_dept as string | null) ?? null,
      dueDate: null,
      status: String(r.status ?? 'open'),
      priority: severity === 'high' ? 'high' : severity === 'low' ? 'low' : 'normal',
      propertyId: pid,
      overdue: complaintOverdue(severity, created, now),
      canComplete: true,
      canAssign: true,
      deepLink: WORKLIST_DEEPLINK.complaint,
      createdAt: created,
      fromLabel: 'A guest',
      amountCents: null,
      // A guest complaint has no author on staff. Null is the honest answer,
      // and it is what keeps "just mine" from claiming it for anybody.
      createdByStaffId: null,
    });
  }

  // ── Work orders (legacy work_orders — the Maintenance UI's) ──────────────────
  for (const r of (workorderRes.data ?? []) as Record<string, unknown>[]) {
    // The second ending. See the note on the query above.
    if (workOrderIsSettled(r.status)) continue;
    const sev = r.severity;
    const room = (r.room_number as string | null) ?? null;
    // "Waiting on parts": somebody has said out loud why this is not moving.
    // The row STAYS — a defer that took the ticket off the list would turn a
    // stalled job into a forgotten one — but it stops competing with live work.
    const waiting = r.status === 'deferred';
    const waitingReason = waiting
      ? (typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null)
      : null;
    const priority: WorklistPriority = waiting
      ? 'low'
      : sev === 'urgent' ? 'urgent' : sev === 'low' ? 'low' : 'normal';
    const assignedStaffId = (r.assigned_to as string | null) ?? null;
    items.push({
      id: `workorder:${r.id}`,
      sourceType: 'workorder',
      sourceId: String(r.id),
      title: String(r.description ?? '') || 'Work order',
      location: room,
      // Who is holding it, once somebody has been given it. The columns have
      // existed since 0001 and nothing wrote them until "Give it to someone
      // else"; the NAME is the one stored on the row rather than a second staff
      // lookup, because it is what the assign seam derived server-side at the
      // moment of the hand-off.
      assigneeStaffId: assignedStaffId,
      assigneeName: (r.assigned_name as string | null) ?? null,
      dept: 'maintenance',
      dueDate: null,
      status: waiting ? 'waiting' : 'open',
      priority,
      propertyId: pid,
      overdue: false,
      canComplete: true,
      canAssign: true,
      deepLink: WORKLIST_DEEPLINK.workorder,
      createdAt: (r.created_at as string | null) ?? null,
      fromLabel: null,
      amountCents: null,
      createdByStaffId: null,
      waitingReason,
    });
  }

  // ── Inspection-due rooms (computed queue; deep-link only) ─────────────────────
  for (const room of inspectionQueue) {
    const recheck = room.reason === 'pending_recheck';
    items.push({
      id: `inspection:${room.roomId}`,
      sourceType: 'inspection',
      sourceId: room.roomId,
      title: recheck ? `Re-inspect Room ${room.roomNumber}` : `Inspect Room ${room.roomNumber}`,
      location: `Room ${room.roomNumber}`,
      assigneeStaffId: room.housekeeperStaffId,
      assigneeName: room.housekeeperName,
      dept: 'housekeeping',
      dueDate: room.completedAt,
      status: room.reason,
      priority: recheck ? 'high' : 'normal',
      propertyId: pid,
      overdue: false,
      canComplete: false,   // pass/fail decision must go through the inspect flow
      canAssign: false,
      deepLink: WORKLIST_DEEPLINK.inspection,
      createdAt: room.completedAt,
      fromLabel: null,
      amountCents: null,
      createdByStaffId: null,
    });
  }

  // ── Preventive maintenance (overdue / due today; derived, recurring) ─────────
  // Surface a PM only when it's overdue or due by end of today. Completing one
  // stamps last_completed_at=now, pushing next-due to now+frequency — so even a
  // daily PM drops off the list the moment it's done (no "I tapped done but it's
  // still here" confusion), then returns tomorrow.
  for (const r of (pmRes.data ?? []) as Record<string, unknown>[]) {
    const freqDays = Number(r.frequency_days ?? 1);
    const lastCompleted = (r.last_completed_at as string | null) ?? null;
    // Never completed → due now. Otherwise next-due = last + frequency.
    const nextDueMs = lastCompleted ? Date.parse(lastCompleted) + freqDays * 86_400_000 : now;
    if (nextDueMs > endOfTodayMs) continue;   // not due yet
    // ── the two rests ────────────────────────────────────────────────────
    // A schedule somebody has called about, or whose occurrence they have
    // skipped, is quiet. This list used to ignore both: "Somebody's been
    // called" silenced the card and left this row sitting there saying the
    // same thing, which is the bug that made the button feel like it did
    // nothing. Checked AFTER the due gate, so a stale flag on a schedule that
    // is not due cannot resurrect a row about nothing.
    if (preventiveRestOf({
      calledAt: (r.called_at as string | null) ?? null,
      skippedAt: (r.skipped_at as string | null) ?? null,
      frequencyDays: freqDays,
      nowMs: now,
    }) !== null) continue;
    const overdue = nextDueMs < now;
    items.push({
      id: `pm:${r.id}`,
      sourceType: 'pm',
      sourceId: String(r.id),
      title: String(r.name ?? '') || 'Preventive task',
      location: (r.area as string | null) ?? null,
      assigneeStaffId: null,
      assigneeName: null,
      dept: null,
      dueDate: new Date(nextDueMs).toISOString(),
      dueDay: propertyLocalToday(new Date(nextDueMs), tz),
      status: overdue ? 'overdue' : 'due_soon',
      priority: overdue ? 'high' : 'normal',
      propertyId: pid,
      overdue,
      canComplete: true,
      canAssign: false,   // preventive_tasks has no department/assignee column
      deepLink: WORKLIST_DEEPLINK.pm,
      createdAt: (r.created_at as string | null) ?? null,
      fromLabel: null,
      amountCents: null,
      createdByStaffId: null,
      cadenceDays: Number.isFinite(freqDays) && freqDays >= 1 ? Math.round(freqDays) : null,
    });
  }

  // ── Due reminders ────────────────────────────────────────────────────────────
  for (const r of (reminderRes.data ?? []) as Record<string, unknown>[]) {
    const targetStaffId = (r.target_staff_id as string | null) ?? null;
    const targetDept = (r.target_department as string | null) ?? null;
    const authorId = (r.created_by_staff_id as string | null) ?? null;
    // Same rule as a to-do: a reminder aimed at one person is that person's.
    if (!taskVisibleToViewer(
      { assignedStaffId: targetStaffId, assignedDepartment: targetDept, createdByStaffId: authorId },
      viewer,
    )) continue;
    const fireAt = (r.fire_at as string | null) ?? null;
    items.push({
      id: `reminder:${r.id}`,
      sourceType: 'reminder',
      sourceId: String(r.id),
      title: String(r.body ?? '') || 'Reminder',
      location: null,
      assigneeStaffId: targetStaffId,
      assigneeName: targetStaffId ? nameMap.get(targetStaffId) ?? null : null,
      dept: targetDept,
      dueDate: fireAt,
      dueDay: fireAt && Number.isFinite(Date.parse(fireAt))
        ? propertyLocalToday(new Date(Date.parse(fireAt)), tz)
        : null,
      status: 'pending',
      priority: 'normal',
      propertyId: pid,
      overdue: !!fireAt && Date.parse(fireAt) < now,
      canComplete: true,   // "Done" cancels the pending reminder
      canAssign: false,
      deepLink: WORKLIST_DEEPLINK.reminder,
      createdAt: (r.created_at as string | null) ?? null,
      fromLabel: authorId && authorId !== viewer?.staffId ? (nameMap.get(authorId) ?? null) : null,
      amountCents: null,
      // A reminder you set for yourself is yours twice over. Carried so it does
      // not vanish the moment somebody narrows their list to their own work.
      createdByStaffId: authorId,
    });
  }

  // ── Decisions waiting on a manager ──────────────────────────────────────────
  for (const r of (joinRes.data ?? []) as Record<string, unknown>[]) {
    const created = (r.created_at as string | null) ?? null;
    items.push({
      id: `approval:join_${r.id}`,
      sourceType: 'approval',
      sourceId: `join_${r.id}`,
      title: `${String(r.name ?? 'Somebody')} wants to join the team`,
      location: null,
      assigneeStaffId: null,
      assigneeName: null,
      dept: (r.department as string | null) ?? null,
      dueDate: null,
      status: 'pending',
      priority: 'high',
      propertyId: pid,
      // A person waiting to be let in is waiting on you from the moment they
      // ask. Two days is where it stops being "I'll get to it".
      overdue: !!created && now - Date.parse(created) > 2 * 86_400_000,
      canComplete: false,
      canAssign: false,
      deepLink: '/company',
      createdAt: created,
      fromLabel: String(r.name ?? '') || null,
      amountCents: null,
      createdByStaffId: null,
    });
  }
  for (const r of (timeOffRes.data ?? []) as Record<string, unknown>[]) {
    const staffId = (r.staff_id as string | null) ?? null;
    const who = staffId ? nameMap.get(staffId) ?? null : null;
    const created = (r.submitted_at as string | null) ?? (r.created_at as string | null) ?? null;
    const day = (r.request_date as string | null) ?? null;
    items.push({
      id: `approval:timeoff_${r.id}`,
      sourceType: 'approval',
      sourceId: `timeoff_${r.id}`,
      title: `${who ?? 'Somebody'} asked for ${day ?? 'a day'} off`,
      location: null,
      assigneeStaffId: null,
      assigneeName: null,
      dept: null,
      // END of the requested day, IN THE HOTEL'S OWN ZONE. UTC midnight is the
      // PREVIOUS local day everywhere in the US, so `${day}T00:00:00.000Z`
      // put the request one square early on the calendar and made the "due
      // today" line contradict the row's own text ("Ana asked for the 14th
      // off" filed under the 13th). `T23:59:59.999Z` fixed the calendar square
      // but still ended the day at 6:59pm in Texas, so a request for today went
      // red over dinner. endOfLocalDay ends it when the hotel's day ends.
      dueDate: day ? endOfLocalDay(day, tz).toISOString() : null,
      // The day the request NAMES, straight off the row. The instant above is
      // the end of that day at the hotel, and reading it back in the reader's
      // own timezone is what put "Ana asked for the 14th off" on the 15th for
      // anybody east of the hotel.
      dueDay: day,
      status: 'pending',
      priority: 'normal',
      propertyId: pid,
      // Overdue the moment the day itself is over: an unanswered request for
      // today is a person who does not know whether to come in.
      overdue: !!day && endOfLocalDay(day, tz).getTime() < now,
      canComplete: false,
      canAssign: false,
      deepLink: '/staff',
      createdAt: created,
      fromLabel: who,
      amountCents: null,
      createdByStaffId: null,
    });
  }

  return sortWorklist(items);
}

/**
 * How many to-dos arrived on this person's list since they last looked.
 *
 * ONE narrow query, and narrow on the axis that matters: `created_at` after the
 * cursor is highly selective, so this reads a handful of rows on a busy hotel
 * and none at all on a quiet one. That is what lets the nav bar ask for it on a
 * shell mount without turning every page load in the app into a worklist read.
 *
 * The visibility rule is the SAME rule the list uses, applied in JS to those
 * few rows rather than re-expressed as a filter chain. Two spellings of "whose
 * list is this on" would drift, and the version that drifted would be the one
 * deciding whether somebody is told about work waiting for them.
 *
 * Floored at NEW_ON_LIST_FLOOR_DAYS so a person opening their list for the
 * first time is told about this week, not about the hotel's whole history.
 * Fails soft to 0: a badge is the least important thing on the screen, and a
 * count nobody could read is not worth failing a page for.
 */
export async function countNewOnList(
  pid: string,
  viewer: WorklistViewer | null,
  seenAt: string | null,
  now: Date = new Date(),
): Promise<number> {
  const floor = new Date(now.getTime() - NEW_ON_LIST_FLOOR_DAYS * 86_400_000).toISOString();
  const since = seenAt && Date.parse(seenAt) > Date.parse(floor) ? seenAt : floor;
  const { data, error } = await supabaseAdmin
    .from('comms_tasks')
    .select('assigned_staff_id, assigned_department, created_by_staff_id')
    .eq('property_id', pid)
    .eq('status', 'open')
    .gt('created_at', since)
    .limit(QUERY_ROW_CAP);
  if (error) {
    log.warn('[worklist] new-on-list count failed', { pid, err: error.message });
    return 0;
  }
  return ((data ?? []) as Record<string, unknown>[]).filter((r) => taskVisibleToViewer({
    assignedStaffId: (r.assigned_staff_id as string | null) ?? null,
    assignedDepartment: (r.assigned_department as string | null) ?? null,
    createdByStaffId: (r.created_by_staff_id as string | null) ?? null,
  }, viewer)).length;
}

/**
 * Work you handed out that has come back since you last looked.
 *
 * The closing half of the assignment loop. A delegated task is deliberately not
 * on the assigner's list, so without this the only way to learn it got done is
 * to remember to open a drawer, and nobody opens a drawer for news they do not
 * know is there.
 *
 * Pure, and derived rather than stored: there is no notification table, no
 * unread counter and nothing to mark read. "Since you last looked" is one
 * timestamp on one preference row, so a notice cannot get stuck, cannot be
 * delivered twice, and cannot outlive the thing it is about.
 *
 * A NULL stamp means the drawer has never been opened, and everything recent
 * counts. That is on purpose: the first thing that comes back is what teaches
 * somebody the drawer exists.
 */
export function assignerNotices(
  assigned: readonly AssignedByMeItem[],
  seenAt: string | null,
  now: Date,
  windowDays = 7,
): AssignedByMeItem[] {
  const since = seenAt ? Date.parse(seenAt) : Number.NEGATIVE_INFINITY;
  const floor = now.getTime() - windowDays * 86_400_000;
  return assigned.filter((entry) => {
    if (entry.state === 'waiting') return false;
    if (!entry.settledAt) return false;
    const settled = Date.parse(entry.settledAt);
    if (Number.isNaN(settled)) return false;
    // Stale news is not news. A task settled three weeks ago by somebody who
    // never opened the drawer is history, not a notice.
    if (settled < floor) return false;
    return !Number.isFinite(since) || settled > since;
  });
}

/**
 * Who a to-do can be handed to at this hotel.
 *
 * HOUSEKEEPERS ARE EXCLUDED, and the exclusion is HERE rather than only in the
 * composer's dropdown, so it holds however the list is reached. They work from
 * the housekeeping board; a to-do assigned to them would sit on a page they
 * never open, and the founder's standing rule is that nothing may ADD a step to
 * a housekeeper's job. Routing this work onto their board is a real feature and
 * a separate one: it means touching the housekeeper page flows, which is
 * exactly what the rule forbids doing casually.
 *
 * The rule itself lives in `assignable.ts` and is shared with every WRITE seam,
 * because filtering the dropdown never stopped a request that named an id
 * directly. Read and write must not be able to drift apart.
 */
export async function listAssignees(
  pid: string,
  limit = 200,
): Promise<Array<{ staffId: string; name: string; department: string | null }>> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name, department, is_active')
    .eq('property_id', pid)
    .order('name', { ascending: true })
    .limit(limit);
  if (error) {
    log.error('[worklist] assignee query failed', { pid, err: error.message });
    throw new Error(error.message);
  }
  return ((data ?? []) as Record<string, unknown>[])
    .filter((r) => isAssignable(r as AssignableStaffRow))
    .map((r) => ({
      staffId: String(r.id),
      name: String(r.name ?? ''),
      department: (r.department as string | null) ?? null,
    }))
    .filter((r) => !!r.name);
}

/**
 * What this person handed to somebody else, and where each one got to.
 *
 * The other half of the assignment rule. Because a delegated task is not on the
 * assigner's list, "did that ever happen" would otherwise have no answer at all
 * — and an assigner who cannot check stops delegating.
 *
 * WAITING is only ever about a to-do handed to a PERSON: one left for a
 * department was never handed to anybody in particular, so there is nobody to
 * be waiting on, and listing it as outstanding would just be the author's own
 * list a second time.
 *
 * SETTLED is different, and this is the hole that was here. "Can't do this"
 * flips the single shared row to blocked, so a department to-do that one
 * housekeeper refuses leaves every housekeeper's list at once — and because it
 * named no person, it reached no drawer either. The refusal reason, which is
 * the entire justification for the blocked state, was written somewhere nobody
 * would ever read it. So a department or unassigned to-do the author created
 * appears here ONCE SOMEBODY ELSE HAS SETTLED IT: not as work outstanding, as
 * news that it is over.
 */
export async function gatherAssignedByMe(
  pid: string,
  staffId: string,
  now: Date = new Date(),
  limit = 200,
  /** The hotel's zone, when the caller already read it. Omit and it is read
   *  here: "waiting 2 days" is counted on the hotel's calendar, not the
   *  server's, and no caller should have to remember that to get it right. */
  timezone?: string | null,
): Promise<AssignedByMeItem[]> {
  const tz = timezone === undefined ? await propertyTimezoneOf(pid) : timezone;
  const { data, error } = await supabaseAdmin
    .from('comms_tasks')
    .select('id, title, assigned_staff_id, assigned_department, due_at, status, created_at, completed_at, completed_by_staff_id, completed_for_date, blocked_at, blocked_by_staff_id, blocked_reason, skipped_at, skipped_by_staff_id')
    .eq('property_id', pid)
    .eq('created_by_staff_id', staffId)
    // Everything this person wrote. Which of them belong in the drawer is
    // decided by keepForAssigner below rather than in the filter: the rule now
    // spans three columns and two states, and "unassigned OR not mine" cannot
    // be said in a filter chain without an interpolated PostgREST expression.
    // The limit is doubled to cover the self-assigned rows the query used to
    // drop and now carries.
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    log.error('[worklist] assigned-by-me query failed', { pid, err: error.message });
    throw new Error(error.message);
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  const nameMap = await staffNameMap(pid, rows.flatMap((r) => [
    r.assigned_staff_id as string | null,
    r.completed_by_staff_id as string | null,
    r.blocked_by_staff_id as string | null,
    r.skipped_by_staff_id as string | null,
  ]).filter((x): x is string => !!x));

  return rows
    .map((r) => mapAssignedRow(r, nameMap, now, tz))
    .filter((item) => keepForAssigner(item, staffId));
}

/**
 * Does this row belong in the author's drawer?
 *
 * Handed to a person: always, because "still waiting" is the question the
 * drawer exists to answer. Handed to a department or to nobody: only once
 * somebody ELSE has finished or refused it, because until then it is not news,
 * and an author who settles their own to-do does not need to be told.
 */
export function keepForAssigner(item: AssignedByMeItem, authorStaffId: string): boolean {
  // Kept for yourself: it is already on your own list, and showing it in both
  // places would double-count every to-do a manager writes for themselves.
  if (item.assigneeStaffId === authorStaffId) return false;
  if (item.assigneeStaffId) return true;
  if (item.state === 'waiting') return false;
  return item.settledByStaffId !== authorStaffId;
}

/**
 * Row → drawer item. Split out and exported so the three states and the
 * staleness count can be exercised without a database: "waiting 6 days" is the
 * line that makes the drawer worth opening, and off-by-one on it is invisible
 * until somebody chases a colleague a day early.
 */
export function mapAssignedRow(
  r: Record<string, unknown>,
  nameMap: Map<string, string>,
  now: Date,
  /** The hotel's zone. Null degrades to UTC, which is only ever right for a
   *  hotel that genuinely has no zone recorded. */
  timezone: string | null = null,
): AssignedByMeItem {
  const status = String(r.status ?? 'open');
  const state: AssignedByMeItem['state'] =
    status === 'done' ? 'done'
      : status === 'blocked' ? 'cant'
        : status === 'skipped' ? 'skipped'
          : 'waiting';
  const settledById = state === 'done'
    ? (r.completed_by_staff_id as string | null) ?? null
    : state === 'cant'
      ? (r.blocked_by_staff_id as string | null) ?? null
      : state === 'skipped'
        ? (r.skipped_by_staff_id as string | null) ?? null
        : null;
  const settledAt = state === 'done'
    ? (r.completed_at as string | null) ?? null
    : state === 'cant'
      ? (r.blocked_at as string | null) ?? null
      : state === 'skipped'
        ? (r.skipped_at as string | null) ?? null
        : null;
  const createdAt = (r.created_at as string | null) ?? null;
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  // Counted on the HOTEL's calendar, not the server's. A to-do handed over at
  // 9pm Monday in Texas is one day old at breakfast on Tuesday there, even
  // though UTC crossed midnight while the manager was still typing it.
  const ageDays = Number.isFinite(createdMs)
    ? Math.max(0, localDaysBetween(new Date(createdMs), now, timezone))
    : 0;
  const assigneeId = (r.assigned_staff_id as string | null) ?? null;
  return {
    taskId: String(r.id),
    title: String(r.title ?? ''),
    assigneeStaffId: assigneeId,
    assigneeName: assigneeId ? nameMap.get(assigneeId) ?? null : null,
    assignedDepartment: (r.assigned_department as string | null) ?? null,
    state,
    dueDate: (r.due_at as string | null) ?? null,
    createdAt,
    settledByName: settledById ? nameMap.get(settledById) ?? null : null,
    settledByStaffId: settledById,
    settledAt,
    reason: state === 'cant' ? ((r.blocked_reason as string | null) ?? null) : null,
    // Only meaningful on a completion, and only when the person said the work
    // happened on a different day from the day they reported it.
    completedForDate: state === 'done' ? ((r.completed_for_date as string | null) ?? null) : null,
    ageDays,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizePriority(p: string): WorklistPriority {
  return p === 'urgent' || p === 'high' || p === 'low' ? p : 'normal';
}

function complaintOverdue(severity: string, createdIso: string | null, now: number): boolean {
  if (!createdIso) return false;
  const limitH = severity === 'high' ? COMPLAINT_OVERDUE_HOURS_HIGH : COMPLAINT_OVERDUE_HOURS;
  return now - Date.parse(createdIso) > limitH * 3600_000;
}

/**
 * The hotel's own timezone, falling back to the app default rather than UTC.
 *
 * The fallback matters: this list used to date itself with todayStr(), which
 * defaults to APP_TIMEZONE, so degrading to UTC on a failed read would move
 * every date on the list for a hotel that simply has no timezone set. A failed
 * read must leave the dates where they were.
 */
export async function propertyTimezoneOf(pid: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('timezone')
    .eq('id', pid)
    .maybeSingle();
  if (error) {
    log.warn('[worklist] timezone read failed; dating the list in the app default', { pid, err: error.message });
    return APP_TIMEZONE;
  }
  return validPropertyTimezone((data as { timezone?: string | null } | null)?.timezone) ?? APP_TIMEZONE;
}

async function staffNameMap(pid: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', pid)
    .in('id', unique);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

/** Overdue first, then soonest due (nulls last), then newest created. */
function sortWorklist(items: WorklistItem[]): WorklistItem[] {
  return items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
    const ca = a.createdAt ?? '';
    const cb = b.createdAt ?? '';
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
}
