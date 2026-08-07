// ─── Who may be handed a to-do ──────────────────────────────────────────────
//
// ONE rule, in ONE place, read by BOTH the list and every write.
//
// The founder's standing rule is that nothing may ADD a step to a housekeeper's
// job. They work from the housekeeping board and never open the to-do list, so
// a to-do assigned to a housekeeper is not "a task they might get to late" —
// it is a task with no surface, seen by nobody, forever. Routing work onto
// their board is a real and separate feature.
//
// Until now that rule lived only in `listAssignees`, which fills a dropdown.
// That made it a UI convention rather than a rule: any request that named a
// housekeeper's id directly (a crafted call, a stale page, an AI tool
// resolving a name, a recurring template made before the dropdown existed) was
// accepted, and the work vanished silently. A guard that only runs on the read
// path is not a guard.
//
// A LEAF MODULE ON PURPOSE. This is imported by worklist/core.ts, by two API
// routes, by two agent tools and by the two low-level insert helpers in
// comms/core.ts and recurring-tasks/store.ts. Keeping it free of domain
// imports is what lets all of them share it without an import cycle.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

/** Staff in this department are never handed a to-do. */
export const NON_ASSIGNABLE_DEPARTMENT = 'housekeeping';

/** The shape both `staff` selects in this codebase already produce. */
export interface AssignableStaffRow {
  department?: string | null;
  is_active?: boolean | null;
}

/**
 * Why this person cannot be handed a to-do, or null if they can.
 *
 * The string is shown to a manager, so it says what to do instead rather than
 * just refusing.
 */
export function assigneeBlockedReason(staff: AssignableStaffRow | null | undefined): string | null {
  if (!staff) return 'That person is not on this hotel staff list.';
  if (staff.is_active === false) {
    return 'That person is no longer active at this hotel, so nothing can be handed to them.';
  }
  if ((staff.department ?? null) === NON_ASSIGNABLE_DEPARTMENT) {
    return 'Housekeepers work from the housekeeping board and never see the to-do list, so this would never reach them. Put it on their board instead.';
  }
  return null;
}

/** True when this row may receive a to-do. The predicate `listAssignees` filters on. */
export function isAssignable(staff: AssignableStaffRow | null | undefined): boolean {
  return assigneeBlockedReason(staff) === null;
}

/**
 * Why a to-do cannot be routed to this DEPARTMENT, or null if it can.
 *
 * The same rule as `assigneeBlockedReason`, one level up. Naming a person was
 * already guarded; naming their whole department was not, and it is the worse
 * half of the two: a department row is delivered to every viewer IN that
 * department (worklist/core.ts) and to nobody else, and it is held out of the
 * author's own drawer until somebody else settles it. Route one at housekeeping
 * and it exists on exactly zero screens, forever, under a success receipt.
 *
 * The composer never offered housekeeping as a target (COMPOSER_ROLES), so this
 * closes the doors that bypass it: the AI's create_todo and its recurring
 * sibling, which spawns a fresh invisible row every day it is due.
 *
 * Says what to do instead, because the caller relays this to a person.
 */
export function departmentBlockedReason(department: string | null | undefined): string | null {
  if ((department ?? null) !== NON_ASSIGNABLE_DEPARTMENT) return null;
  return 'Housekeepers work from the housekeeping board and never open the to-do list, '
    + 'so a to-do routed to the housekeeping department would reach nobody. '
    + 'Hand it to a named person instead, or leave it unassigned so it sits on the shared list.';
}

/**
 * The write-seam guard, for callers holding only an id.
 *
 * Returns null when the assignment is allowed, including when there is no
 * assignee at all (an unassigned to-do sits on the shared list, which is a
 * real place people look).
 *
 * FAILS CLOSED. If the staff row cannot be read, this refuses rather than
 * waving the write through: the whole point of the rule is that a bad
 * assignment is invisible afterwards, so there is no later chance to catch it.
 */
export async function assignmentBlockedReason(
  pid: string,
  staffId: string | null | undefined,
): Promise<string | null> {
  if (!staffId) return null;
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, department, is_active')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (error) {
    log.error('[worklist] assignee check failed', { pid, staffId, err: error.message });
    return 'Could not check who that is right now. Try again.';
  }
  return assigneeBlockedReason(data as AssignableStaffRow | null);
}
