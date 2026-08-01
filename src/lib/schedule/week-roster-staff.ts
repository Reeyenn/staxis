import type { StaffMember } from '@/types';

/**
 * Active people always belong on the planning roster. Archived people appear
 * only when the displayed week still contains one of their preserved assigned
 * shifts, so history stays attributable without putting them back in pickers.
 */
export function staffVisibleInWeekRoster(
  staff: readonly StaffMember[],
  assignedStaffIds: ReadonlySet<string>,
): StaffMember[] {
  return staff.filter((member) => (
    member.isActive !== false || assignedStaffIds.has(member.id)
  ));
}
