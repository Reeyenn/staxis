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
//   workorder   work_orders       DB status != 'resolved'       complete ✓  assign(lane)  ✓
//   inspection  buildInspectionQueue(today)                     deep-link   (no assign)
//   pm          preventive_tasks  overdue/soon (derived)         complete ✓  (no assign)
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { todayStr } from '@/lib/utils';
import { log } from '@/lib/log';
import { buildInspectionQueue } from '@/lib/housekeeping/inspection-queue';
import { COMPLAINT_OVERDUE_HOURS, COMPLAINT_OVERDUE_HOURS_HIGH } from '@/lib/complaints-shared';
import type { WorklistItem, WorklistPriority } from './types';

/** Deep-link targets per source (the page + the tab query param it now reads). */
export const WORKLIST_DEEPLINK: Record<WorklistItem['sourceType'], string> = {
  task: '/communications',
  complaint: '/front-desk?tab=complaints',
  workorder: '/maintenance?tab=work',
  inspection: '/housekeeping?tab=quality',
  pm: '/maintenance?tab=preventive',
};

/** A preventive task counts as worklist-worthy once it's overdue or due within this window. */
const PM_SOON_MS = 2 * 86_400_000;

const QUERY_ROW_CAP = 500;

/** Gather every open actionable item for one property, normalized + sorted. */
export async function gatherWorklist(pid: string): Promise<WorklistItem[]> {
  const now = Date.now();
  const today = todayStr();

  const [taskRes, complaintRes, workorderRes, pmRes, inspectionQueue] = await Promise.all([
    supabaseAdmin
      .from('comms_tasks')
      .select('id, title, assigned_staff_id, assigned_department, due_at, status, priority, created_at')
      .eq('property_id', pid)
      .eq('status', 'open')
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('complaints')
      .select('id, room_number, category, severity, description, status, assigned_to, assigned_name, assigned_dept, created_at')
      .eq('property_id', pid)
      .in('status', ['open', 'in_progress'])
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('work_orders')
      .select('id, room_number, description, severity, status, created_at')
      .eq('property_id', pid)
      .neq('status', 'resolved')
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('preventive_tasks')
      .select('id, name, area, frequency_days, last_completed_at, created_at')
      .eq('property_id', pid)
      .limit(QUERY_ROW_CAP),
    // Inspection queue is derived (rooms clean-but-uninspected / failed-re-cleaned).
    buildInspectionQueue(pid, today).catch((e) => {
      log.error('[worklist] inspection queue failed', { pid, err: e instanceof Error ? e.message : String(e) });
      return [];
    }),
  ]);

  for (const [label, res] of [
    ['comms_tasks', taskRes], ['complaints', complaintRes],
    ['work_orders', workorderRes], ['preventive_tasks', pmRes],
  ] as const) {
    if (res.error) log.error(`[worklist] ${label} query failed`, { pid, err: res.error.message });
  }

  const items: WorklistItem[] = [];

  // ── Manual to-dos ──────────────────────────────────────────────────────────
  const taskRows = (taskRes.data ?? []) as Record<string, unknown>[];
  // Resolve assignee display names for the tasks that have one (one staff read).
  const taskAssigneeIds = taskRows
    .map((r) => r.assigned_staff_id as string | null)
    .filter((x): x is string => !!x);
  const nameMap = await staffNameMap(pid, taskAssigneeIds);
  for (const r of taskRows) {
    const due = (r.due_at as string | null) ?? null;
    const assignedStaffId = (r.assigned_staff_id as string | null) ?? null;
    items.push({
      id: `task:${r.id}`,
      sourceType: 'task',
      sourceId: String(r.id),
      title: String(r.title ?? ''),
      location: null,
      assigneeStaffId: assignedStaffId,
      assigneeName: assignedStaffId ? nameMap.get(assignedStaffId) ?? null : null,
      dept: (r.assigned_department as string | null) ?? null,
      dueDate: due,
      status: 'open',
      priority: normalizePriority((r.priority as string | null) ?? 'normal'),
      propertyId: pid,
      overdue: !!due && Date.parse(due) < now,
      canComplete: true,
      canAssign: true,
      deepLink: WORKLIST_DEEPLINK.task,
      createdAt: (r.created_at as string | null) ?? null,
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
    });
  }

  // ── Work orders (legacy work_orders — the Maintenance UI's) ──────────────────
  for (const r of (workorderRes.data ?? []) as Record<string, unknown>[]) {
    const sev = r.severity;
    const priority: WorklistPriority = sev === 'urgent' ? 'urgent' : sev === 'low' ? 'low' : 'normal';
    const room = (r.room_number as string | null) ?? null;
    items.push({
      id: `workorder:${r.id}`,
      sourceType: 'workorder',
      sourceId: String(r.id),
      title: String(r.description ?? '') || 'Work order',
      location: room,
      assigneeStaffId: null,
      assigneeName: null,
      dept: 'maintenance',
      dueDate: null,
      status: 'open',
      priority,
      propertyId: pid,
      overdue: false,
      canComplete: true,
      canAssign: true,   // priority lane (no per-staff column on work_orders)
      deepLink: WORKLIST_DEEPLINK.workorder,
      createdAt: (r.created_at as string | null) ?? null,
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
    });
  }

  // ── Preventive maintenance (overdue / due-soon; derived, recurring) ──────────
  for (const r of (pmRes.data ?? []) as Record<string, unknown>[]) {
    const freqDays = Number(r.frequency_days ?? 1);
    const lastCompleted = (r.last_completed_at as string | null) ?? null;
    // Never completed → due now. Otherwise next-due = last + frequency.
    const nextDueMs = lastCompleted ? Date.parse(lastCompleted) + freqDays * 86_400_000 : now;
    if (nextDueMs > now + PM_SOON_MS) continue;   // not yet worth chasing
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
      status: overdue ? 'overdue' : 'due_soon',
      priority: overdue ? 'high' : 'normal',
      propertyId: pid,
      overdue,
      canComplete: true,
      canAssign: false,   // preventive_tasks has no department/assignee column
      deepLink: WORKLIST_DEEPLINK.pm,
      createdAt: (r.created_at as string | null) ?? null,
    });
  }

  return sortWorklist(items);
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
