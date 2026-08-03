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
import { requirePropertySectionEnabled } from '@/lib/sections/server';
import type { AppSection } from '@/lib/sections/registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  ARCHIVED_AT_PROPERTY,
  resolveAccount,
  resolveStaffIdForAccount,
  getStaffRow,
  isManagerRole,
} from './core';
import type { CommsLang } from './types';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';

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
  hotelMutationAllowed: boolean;
  requestId: string;
  headers: Record<string, string>;
}

/**
 * The full set of property ids a manager may broadcast an org-wide campaign to.
 * The account id is resolved again on every call. `null` means authorization
 * could not be proven and callers must fail closed; it never means an empty
 * portfolio. This is retained for read-only historical campaign status only —
 * new cross-hotel writes require a separate preview/confirmation contract.
 */
interface AccessiblePropertyDependencies {
  loadAuthority: (accountId: string) => Promise<AuthoritativePropertyAccess | null>;
  loadAllPropertyIds: () => Promise<string[] | null>;
}

const ACCESSIBLE_PROPERTY_DEPENDENCIES: AccessiblePropertyDependencies = {
  loadAuthority: listAuthoritativePropertyAccess,
  loadAllPropertyIds: async () => {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('id')
      .order('id', { ascending: true })
      .limit(5_001);
    if (error || !Array.isArray(data) || data.length > 5_000) return null;
    return (data as { id: string }[]).map((row) => row.id);
  },
};

export async function listAccessiblePropertyIds(
  accountId: string,
  overrides: Partial<AccessiblePropertyDependencies> = {},
): Promise<string[] | null> {
  const dependencies = { ...ACCESSIBLE_PROPERTY_DEPENDENCIES, ...overrides };
  const authority = await dependencies.loadAuthority(accountId);
  if (!authority) return null;
  if (authority.all) {
    return dependencies.loadAllPropertyIds();
  }
  return authority.propertyIds;
}

/**
 * Keep the private-local communications boundary independently testable. The
 * callback can create a staff identity, so it is never invoked until current
 * authoritative local operational standing has been proven.
 */
export async function resolvePrivateHotelCommsStaffId(
  standing: Pick<AuthoritativePropertyStanding, 'hotelMutationAllowed'> | null,
  resolve: () => Promise<string>,
): Promise<string | null> {
  if (!standing || standing.hotelMutationAllowed !== true) return null;
  return resolve();
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
 * The options every route behind the Staxis LIST passes: to-dos, the worklist,
 * and the log book.
 *
 * Same precedent, same reason, one section later. Those three surfaces MOVED
 * off the Communications tab and onto the Staxis tab: the list of everything
 * that needs a person is the Staxis page, and the log book is a button on it.
 * Communications keeps Messages and nothing else.
 *
 * Left on the default gate they would have kept dying with a section they are
 * no longer part of — a hotel that switched off a Communications tab now
 * holding only messages would lose its whole to-do list and its log book from a
 * screen that was still on the nav, still loading, and still saying it worked.
 * That is the knowledge blackout again, with different tables.
 *
 * Gating them on 'staxis' instead was the other option and it is worse: a
 * recurring to-do would then stop spawning, and a shift note would fail to
 * save, because of a nav toggle. Section toggles govern what a hotel SEES,
 * never what it may reach. commsContext still enforces requireSession +
 * userHasPropertyAccess above this, and every route keeps its own per-verb
 * capability check.
 */
export const ONE_LIST_CTX: CommsContextOptions = { sectionGate: null };

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
    // Session and tenant reach were already proven above. Use the section-only
    // gate so this helper validates the session exactly once, then keep the
    // gate before staff resolution because that callback may create identity.
    const sectionGate = await requirePropertySectionEnabled(
      pid,
      gatedSection,
      { requestId, headers },
    );
    if (!sectionGate.ok) return { ok: false, response: sectionGate.response };
  }

  const account = await resolveAccount(session.userId);
  if (!account) {
    return { ok: false, response: err('no account', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  const standing = authoritativeStandingForProperty(account.authority, pid);
  // Private hotel communications are an operational-local surface: channel
  // rosters, DMs, presence and first-use staff identity creation must not be
  // exposed merely because a company actor can read portfolio/hotel facts.
  // The authoritative projection marks company-only owner/VP/finance and
  // read-only grants as non-mutating; require the explicit local operational
  // standing before resolving (and potentially creating) a staff identity.
  const hotelAccount = standing ? { ...account, role: standing.operationalRole } : null;
  let staffId: string | null;
  try {
    staffId = await resolvePrivateHotelCommsStaffId(
      standing,
      async () => resolveStaffIdForAccount(pid, hotelAccount!),
    );
  } catch (error) {
    if (error instanceof Error && error.message === ARCHIVED_AT_PROPERTY) {
      return { ok: false, response: err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
    }
    throw error;
  }
  if (!standing || !hotelAccount || !staffId) {
    return { ok: false, response: err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  const staffRow = await getStaffRow(pid, staffId);

  return {
    ok: true,
    pid,
    userId: session.userId,
    accountId: account.accountId,
    role: standing.operationalRole,
    staffId,
    displayName: account.displayName,
    isManager: isManagerRole(standing.operationalRole),
    dept: staffRow?.department ?? null,
    lang: account.preferredLanguage,
    propertyAccess: account.propertyAccess,
    hotelMutationAllowed: standing.hotelMutationAllowed,
    requestId,
    headers,
  };
}
