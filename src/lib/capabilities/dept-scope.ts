// ═══════════════════════════════════════════════════════════════════════════
// Department-scope checker. Single source of truth for "can this person reach
// content scoped to a given department?" — managers reach every department;
// other staff reach only their own. Comms channel visibility is re-expressed on
// top of this (see comms/core.ts), and future per-department Documents access
// plugs in here.
//
// PURE + standalone (no import from comms) so it stays isomorphic and avoids an
// import cycle. comms/core.ts imports FROM this file, not the other way round.
// ═══════════════════════════════════════════════════════════════════════════

/** The three real departments that own scoped content. */
export type Dept = 'front_desk' | 'housekeeping' | 'maintenance';

const MANAGER_ROLES: ReadonlySet<string> = new Set(['admin', 'owner', 'general_manager']);

/** Managers (admin / owner / general_manager) reach every department. */
export function isManagerRole(role: string | null | undefined): boolean {
  return !!role && MANAGER_ROLES.has(role);
}

/**
 * Normalize a free-form `staff.department` (or a department-channel key) to one
 * of the three real departments, or null for all-staff / unknown / 'other'.
 * This is the canonical mapping that comms `deptChannel` reuses.
 */
export function normalizeDept(dept: string | null | undefined): Dept | null {
  switch ((dept ?? '').toLowerCase()) {
    case 'front_desk': return 'front_desk';
    case 'maintenance': return 'maintenance';
    case 'housekeeping': return 'housekeeping';
    default: return null; // 'other' / 'all_staff' / unknown → no single dept
  }
}

export interface DeptActor {
  /** The actor's role — manager status is derived from it. */
  role?: string | null;
  /** Pre-computed manager flag (bridges callers that only have a boolean). */
  isManager?: boolean;
  /** The actor's own department (staff.department). */
  staffDept?: string | null;
}

/**
 * Can `actor` reach content scoped to `targetDept`?
 *   1. Manager  → true for every department (short-circuit FIRST).
 *   2. Otherwise → only their own department (normalized equality).
 * A `targetDept` that isn't a real department (all-staff / unknown) → false for
 * non-managers; callers handle the all-staff case outside this checker.
 */
export function canReachDeptContent(actor: DeptActor, targetDept: string | null | undefined): boolean {
  const manager = actor.isManager === true || isManagerRole(actor.role);
  if (manager) return true;
  const target = normalizeDept(targetDept);
  if (!target) return false;
  return normalizeDept(actor.staffDept) === target;
}
