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
import type { ReportCatalogEntry, ReportDefinition } from './types';

export type ReportsGate =
  | { ok: true; caller: TeamCaller }
  | { ok: false; status: number; code: string; error: string };

/**
 * Second gate, on top of `run_reports`: a money-bearing report also needs
 * `view_financials` at this hotel.
 *
 * The two are genuinely independent. `run_reports` is manager-floor, so line
 * staff never reach the hub at all. `view_financials` is the per-hotel money
 * switch an admin flips on the Access tab, and flipping it off for one manager
 * at one hotel used to leave that manager able to download the same hotel's
 * budgets, purchases and usage dollars from /settings/reports as a CSV. Report
 * data has exactly one producer path (resolveRunContext, shared by /run and
 * /export), so the check lives on that path and this stays a pure decision.
 */
export function reportAccessDecision(
  def: Pick<ReportDefinition, 'requiresFinancials'>,
  viewer: { canViewFinancials: boolean },
): 'allowed' | 'financials_required' {
  return def.requiresFinancials === true && !viewer.canViewFinancials
    ? 'financials_required'
    : 'allowed';
}

/** Hide what the caller could not run anyway, so the hub never offers a report
 * that answers 403. Same decision as `reportAccessDecision`, one place. */
export function visibleReportCatalog(
  entries: readonly ReportCatalogEntry[],
  viewer: { canViewFinancials: boolean },
): ReportCatalogEntry[] {
  return entries.filter((entry) => reportAccessDecision(entry, viewer) === 'allowed');
}

export async function gateReportsAccess(req: NextRequest, propertyId: string): Promise<ReportsGate> {
  const caller = await verifyTeamManager(req, { capability: 'run_reports', propertyId });
  if (!caller) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      error: 'Reports are restricted for your role at this property.',
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
