// ═══════════════════════════════════════════════════════════════════════════
// Who gets the Staxis list, and how much of it.
//
// The founder's rule is "same page, sized to the person" — one page, and what
// differs is what the reads return. This is the ONE branch that is not a read:
// whether the page renders for this person at all.
//
//   manager   owner / VP / GM / admin. The whole list: findings, money,
//             approvals, the hotel's work, their own.
//   line      front desk, maintenance, and the legacy 'staff' role. The SAME
//             page, whose list naturally contains only their world, because
//             /api/worklist narrows by role and by viewer. No findings fetch,
//             so no money and no recommendations reach the screen.
//   none      housekeepers, and anybody with no operational standing here.
//
// ─── the housekeeper exception, and why it is not an oversight ─────────────
// Housekeepers never get this page. They work from the housekeeping board,
// which is a different shape of screen for a different shape of shift, and the
// standing rule is that nothing may ADD a step to a housekeeper's job. Giving
// them a second place to check would do exactly that. They are also excluded
// from the composer's Who list (server-side, in listAssignees) so nobody can
// hand them work that would land somewhere they never look.
//
// Pure, and separate from the component, so both halves are provable: a
// housekeeper gets nothing, and a front-desk clerk gets the page.
// ═══════════════════════════════════════════════════════════════════════════

import { canManageTeam, type AppRole } from '@/lib/roles';

export type ListStanding = 'manager' | 'line' | 'none';

export function listStandingFor(
  role: AppRole | null | undefined,
  hotelMutationAllowed: boolean,
): ListStanding {
  // No operational standing at this hotel: a company-scope reader drilling in,
  // or somebody mid-load. Not a refusal, just not their screen.
  if (!role || !hotelMutationAllowed) return 'none';
  if (role === 'housekeeping') return 'none';
  if (canManageTeam(role)) return 'manager';
  return 'line';
}

/** Does this person's list include the AI's findings, prices and approvals? */
export function listShowsFindings(standing: ListStanding): boolean {
  return standing === 'manager';
}

/** Does this person get the page at all? */
export function listRendersFor(standing: ListStanding): boolean {
  return standing !== 'none';
}
