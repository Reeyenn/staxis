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

import type { NextRequest, NextResponse } from 'next/server';
import {
  callerCapabilityDecision,
  canManageHotel,
  verifyTeamManager,
  type TeamCaller,
} from '@/lib/team-auth';
import { err, ApiErrorCode } from '@/lib/api-response';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';

export type ChecklistGate =
  | { ok: true; caller: TeamCaller }
  | { ok: false; response: NextResponse };

export async function gateChecklistAccess(
  req: NextRequest,
  propertyId: string,
  requestId: string,
): Promise<ChecklistGate> {
  // Resolve the authenticated caller first without a property lookup, then use
  // the tri-state property decision below. This preserves the existing
  // capability and scope rules while keeping an override-store outage distinct
  // from a real authorization denial.
  const caller = await verifyTeamManager(req, { capability: 'manage_checklists' });
  if (!caller) {
    return {
      ok: false,
      response: err('Checklists are restricted for your role at this property.', {
        requestId,
        status: 403,
        code: ApiErrorCode.Forbidden,
      }),
    };
  }
  if (!canManageHotel(caller, propertyId)) {
    return {
      ok: false,
      response: err('You do not have access to that property.', {
        requestId,
        status: 403,
        code: 'property_access_denied',
      }),
    };
  }

  const capabilityDecision = await callerCapabilityDecision(
    caller,
    'manage_checklists',
    propertyId,
  );
  if (capabilityDecision === 'unavailable') {
    return { ok: false, response: capabilityUnavailableResponse(requestId) };
  }
  if (capabilityDecision === 'denied') {
    return {
      ok: false,
      response: err('Checklists are restricted for your role at this property.', {
        requestId,
        status: 403,
        code: ApiErrorCode.Forbidden,
      }),
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
