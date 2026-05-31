/**
 * Shared access gate for /api/settings/reports/*.
 *
 * Reports are management-only (like the activity log): admin / owner /
 * general_manager, AND the caller must have access to the requested property.
 * Mirrors gateActivityLogAccess — verifyTeamManager runs requireSession +
 * the role check; canManageHotel enforces property scoping (admins bypass).
 */

import type { NextRequest } from 'next/server';
import { canManageHotel, verifyTeamManager, type TeamCaller } from '@/lib/team-auth';

export type ReportsGate =
  | { ok: true; caller: TeamCaller }
  | { ok: false; status: number; code: string; error: string };

export async function gateReportsAccess(req: NextRequest, propertyId: string): Promise<ReportsGate> {
  const caller = await verifyTeamManager(req);
  if (!caller) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      error: 'Reports are restricted to managers, owners, and admins.',
    };
  }
  if (!canManageHotel(caller, propertyId)) {
    return {
      ok: false,
      status: 403,
      code: 'property_access_denied',
      error: 'You do not have access to that property.',
    };
  }
  return { ok: true, caller };
}
