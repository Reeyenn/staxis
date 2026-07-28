// ═══════════════════════════════════════════════════════════════════════════
// Communications — shared helpers for the AUTHENTICATED /api/comms/* routes.
//
// One call resolves: a valid Supabase session (2FA-enforced), property access,
// the caller's staff identity in that property, and their role/department.
// Floor-staff (housekeeper) routes use gateHousekeeperRequest instead.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import type { AppSection } from '@/lib/sections/registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { resolveAccount, resolveStaffIdForAccount, getStaffRow, isManagerRole } from './core';
import type { CommsLang } from './types';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommsCtx {
  ok: true;
  pid: string;
  userId: string;
  accountId: string;
  role: string;
  staffId: string;
  displayName: string;
  isManager: boolean;
  dept: string | null;
  lang: CommsLang;
  /** The caller's property scope (UUIDs, or '*' wildcard). Drives org-wide reach. */
  propertyAccess: string[];
  requestId: string;
  headers: Record<string, string>;
}

/**
 * The full set of property ids a manager may broadcast an org-wide campaign to.
 * Admins / '*' wildcard → every property; otherwise the explicit property_access
 * list (UUIDs only). Deriving the target set FROM property_access is itself the
 * access check — a caller can never target a hotel they aren't scoped to.
 */
export async function listAccessiblePropertyIds(role: string, propertyAccess: string[]): Promise<string[]> {
  if (role === 'admin' || propertyAccess.includes('*')) {
    const { data } = await supabaseAdmin.from('properties').select('id').limit(1000);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }
  return propertyAccess.filter((p) => UUID_RX.test(p));
}

/**
 * Which section toggle, if any, this call is gated on.
 *
 * Defaults to 'communications' — correct for /api/comms/* and /api/worklist/*,
 * whose UI lives in that section and should disappear with it.
 *
 * `null` skips the section gate entirely. The /api/knowledge/* routes pass it,
 * because knowledge is no longer owned by one section: SOPs, uploaded
 * documents, folders and the contact directory render on the Staxis/Knows tab
 * as well as in Communications. Gating them on 'communications' meant a hotel
 * that switched off a near-empty Communications section silently lost its
 * documents, SOPs and emergency contacts from a screen that was still on-
 * screen and still said it worked — a data blackout dressed up as a load error.
 *
 * Dropping the gate costs nothing in access terms: commsContext still enforces
 * requireSession + userHasPropertyAccess above, and every /api/knowledge/*
 * route runs its own capabilityDecisionForUserId check per verb. Section
 * toggles govern what a hotel SEES, never what it may reach — and a section
 * that is off has no UI to reach these from in the first place.
 */
export interface CommsContextOptions {
  sectionGate?: AppSection | null;
}

/**
 * The options every /api/knowledge/* route passes. Named rather than inlined so
 * the reason lives in one place and a new knowledge route copies the intent
 * instead of re-deriving it — or worse, silently inheriting the
 * 'communications' default and reintroducing the blackout.
 */
export const KNOWLEDGE_CTX: CommsContextOptions = { sectionGate: null };

/**
 * Which section a call is gated on: an AppSection, or null for "don't gate".
 *
 * Extracted so it can be tested, because the obvious one-liner is wrong in a
 * way that reads fine: `opts?.sectionGate ?? 'communications'` treats an
 * EXPLICIT null as nullish and silently re-gates the knowledge routes on
 * Communications — restoring the exact blackout this exists to prevent, with
 * no type error and no failing build. Only `!== undefined` distinguishes
 * "asked for no gate" from "didn't ask".
 */
export function resolveSectionGate(opts?: CommsContextOptions): AppSection | null {
  return opts?.sectionGate !== undefined ? opts.sectionGate : 'communications';
}

/**
 * Authenticate + resolve the caller's messaging context for a property.
 * `pid` is read from the query string (GET) or must be passed explicitly.
 */
export async function commsContext(
  req: NextRequest,
  pidRaw: string | null,
  opts?: CommsContextOptions,
): Promise<CommsCtx | { ok: false; response: NextResponse }> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const pidV = validateUuid(pidRaw, 'pid');
  if (pidV.error) {
    return { ok: false, response: err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers }) };
  }
  const pid = pidV.value!;

  const session = await requireSession(req, { requestId });
  if (!session.ok) return { ok: false, response: session.response };

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return { ok: false, response: err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  // Central policy boundary for every authenticated /api/comms route. Keep it
  // before account/staff resolution because that resolution can create a
  // caller-bound staff identity on first use.
  //
  // `sectionGate: null` opts out — see CommsContextOptions. Only the
  // /api/knowledge/* routes do that; every /api/comms/* and /api/worklist/*
  // caller keeps the default and stays gated on 'communications'.
  const gatedSection = resolveSectionGate(opts);
  if (gatedSection !== null) {
    const sectionGate = await requireSectionEnabled(req, pid, gatedSection);
    if (!sectionGate.ok) return { ok: false, response: sectionGate.response };
  }

  const account = await resolveAccount(session.userId);
  if (!account) {
    return { ok: false, response: err('no account', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  const staffId = await resolveStaffIdForAccount(pid, account);
  const staffRow = await getStaffRow(pid, staffId);

  return {
    ok: true,
    pid,
    userId: session.userId,
    accountId: account.accountId,
    role: account.role,
    staffId,
    displayName: account.displayName,
    isManager: isManagerRole(account.role),
    dept: staffRow?.department ?? null,
    lang: account.preferredLanguage,
    propertyAccess: account.propertyAccess,
    requestId,
    headers,
  };
}
