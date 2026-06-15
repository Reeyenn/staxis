/**
 * Shared access gate + authorization helpers for /api/settings/checklists/*.
 *
 * The checklist editor is management-only (admin / owner / general_manager),
 * exactly like Reports and the Activity Log. `gateChecklistAccess` mirrors
 * `gateReportsAccess`: verifyTeamManager runs requireSession + the role check,
 * canManageHotel enforces per-property scoping (admins bypass).
 *
 * `partitionTargets` is the pure decision used by the copy-to-properties route
 * to make sure a manager can only write a checklist onto properties they
 * actually have access to — no cross-tenant writes. Pulled out as a pure
 * function so the isolation rule is unit-testable without a request or DB.
 */

import type { NextRequest } from 'next/server';
import { canManageHotel, verifyTeamManager, type TeamCaller } from '@/lib/team-auth';

export type ChecklistGate =
  | { ok: true; caller: TeamCaller }
  | { ok: false; status: number; code: string; error: string };

export async function gateChecklistAccess(req: NextRequest, propertyId: string): Promise<ChecklistGate> {
  const caller = await verifyTeamManager(req, { capability: 'manage_checklists', propertyId });
  if (!caller) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      error: 'Checklists are restricted for your role at this property.',
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

/**
 * Split a set of requested target property ids into the ones the caller may
 * write to and the ones they may not. Deduplicates and drops blank ids.
 *
 * Admins manage every hotel, so every (non-blank) target is authorized.
 * Everyone else is held to their explicit `propertyAccess` list.
 */
export function partitionTargets(
  caller: TeamCaller,
  targetIds: string[],
): { authorized: string[]; denied: string[] } {
  const seen = new Set<string>();
  const authorized: string[] = [];
  const denied: string[] = [];
  for (const raw of targetIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (canManageHotel(caller, id)) authorized.push(id);
    else denied.push(id);
  }
  return { authorized, denied };
}
