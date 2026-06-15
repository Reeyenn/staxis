/**
 * Shared helpers for the activity-log API routes.
 *
 * Three routes (list / event detail / export) share:
 *   - The role gate (admin / owner / general_manager only)
 *   - The property-access check (caller must have this property in their
 *     property_access array, unless they're admin)
 *   - Filter parsing from query string
 *
 * Lifting these into one module keeps the route handlers focused on
 * shape + I/O.
 */

import type { NextRequest } from 'next/server';
import { verifyTeamManager, canManageHotel, type TeamCaller } from '@/lib/team-auth';

// Filter parsing lives in ./filters so unit tests can exercise it
// without booting the supabase-admin / api-auth import chain.
export { parseActivityFilters } from './filters';

export type GateResult =
  | { ok: true; caller: TeamCaller }
  | { ok: false; status: number; code: string; error: string };

/**
 * Verify the caller is a manager-or-up AND has access to `propertyId`.
 * Admins bypass the property-access check.
 */
export async function gateActivityLogAccess(
  req: NextRequest,
  propertyId: string,
): Promise<GateResult> {
  const caller = await verifyTeamManager(req, { capability: 'view_activity_log', propertyId });
  if (!caller) {
    return { ok: false, status: 403, code: 'forbidden', error: 'Activity log access is restricted for your role at this property.' };
  }
  if (!canManageHotel(caller, propertyId)) {
    return { ok: false, status: 403, code: 'property_access_denied', error: 'You do not have access to that property.' };
  }
  return { ok: true, caller };
}
