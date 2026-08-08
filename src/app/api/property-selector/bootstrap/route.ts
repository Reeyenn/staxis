/**
 * GET /api/property-selector/bootstrap
 *   → { ok, data: { hotels, company, chat, signedInAs } }
 *
 * EVERYTHING the hotel picker draws, in ONE read. It serves two people from one
 * payload:
 *
 *   • a hotel person (a GM with one hotel, a housekeeper who covers two) gets
 *     their hotels, named, with room counts and nothing else. `company` is
 *     null and no chip is computed for them — a picker is a door, not a
 *     dashboard.
 *   • a company-scope person (owner / VP / finance, resolved from their hats)
 *     gets the same list PLUS a health chip per hotel, their company's name,
 *     and whether cross-hotel chat is open to them.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL: THE STALE-SNAPSHOT FIX ─────────────────
 * The picker used to render `accounts.property_access` — the array stamped onto
 * an account when its invitation was accepted. That array is a SNAPSHOT. A
 * hotel the company bought last week is covered by every company hat the moment
 * the relationship row exists, and it was still missing from the picker, so the
 * only way to see it was to re-invite the person. This route resolves coverage
 * through `listAuthoritativePropertyAccess` — the exclusive authority mode
 * selected in PostgreSQL. A normalized company entitlement expands over current
 * governing topology, so the new hotel appears without unioning stale legacy
 * ids back into the result.
 *
 * ─── WHY NOT /api/company/queue ───────────────────────────────────────────
 * That route builds the whole portfolio: it runs the company's daily checks,
 * loads the approver directory, resolves sign-off per proposal, reads judged
 * phrasing and assembles the brief. It is the right cost for the screen a VP
 * opens to WORK. This one is on the critical path of every sign-in, and a chip
 * is three words — see `hotelHealthChips` for exactly which of the queue's
 * reads are shared (all the ones that decide what a finding means) and which
 * are skipped (all the ones that turn a finding into a sentence).
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────
 * requireSession, then `loadSessionAccount` — NOT `loadManagerCaller`. The
 * manager gate refuses front_desk, maintenance and housekeeping, and a
 * company's finance lead carries a legacy role of `front_desk`; gating here
 * would have shown a whole class of real users an empty picker. The tenant wall
 * is not the role anyway: it is the authoritative resolver, which can only
 * return hotels from the account's current active authority mode.
 *
 * loadSessionAccount is the shared, schema-pinned account lookup. Do not
 * hand-roll another one: the last three times a route did, it selected a column
 * that does not exist (`accounts.name` most recently), PostgREST errored, the
 * route read the error as "no such account", and the feature was silently dead
 * for every user with a green build and a green suite.
 */

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { loadSessionAccount } from '@/lib/team-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { hotelHealthChips } from '@/lib/company/vp-queue-server';
import { propertySelectorRateLimitKey } from '@/lib/company/property-selector-rate-limit';
import {
  listPortfolioCompaniesUncached,
  type PortfolioCompanyCatalogEntry,
} from '@/lib/company/portfolio';
import { accountHasCompanyHat } from '@/lib/company/access';
import { rankHotels, type HotelChip } from '@/lib/company/vp-queue';
import { isUuid } from '@/lib/authorization';
import {
  assertAuthorizationScopeReceipt,
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import {
  readCompleteCompanyIdChunks,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  Vary: 'Authorization, Cookie',
});

/**
 * The most hotels the unscoped Staxis-admin picker will draw. An exact company
 * receipt is never shortened by this bound; management selectors return every
 * authorized hotel and make any health-chip omissions honest with null chips.
 */
const MAX_HOTELS = 60;

export interface PickerHotel {
  propertyId: string;
  name: string;
  totalRooms: number;
  /** Null for hotel people (never computed) and for hotels we cannot vouch for. */
  chip: HotelChip | null;
  /** Carried so the client can resume a half-finished setup without a second read. */
  onboardingCompletedAt: string | null;
  onboardingState: string | null;
  onboardingPromptShownAt: string | null;
}

interface PropertyRow {
  id: string;
  name: string | null;
  total_rooms: number | string | null;
  onboarding_completed_at: string | null;
  onboarding_state: string | null;
  onboarding_prompt_shown_at: string | null;
}

const PROPERTY_COLUMNS =
  'id, name, total_rooms, onboarding_completed_at, onboarding_state, onboarding_prompt_shown_at';

function roomCount(value: number | string | null): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((propertyId, index) => propertyId === right[index]);
}

function samePropertyStandings(
  left: AuthoritativePropertyAccess['propertyStandings'],
  right: AuthoritativePropertyAccess['propertyStandings'],
): boolean {
  return left.length === right.length && left.every((standing, index) => {
    const other = right[index];
    return other !== undefined
      && standing.propertyId === other.propertyId
      && standing.operationalRole === other.operationalRole
      && standing.seesFinancials === other.seesFinancials
      && standing.hotelMutationAllowed === other.hotelMutationAllowed
      && standing.portfolioIntelligenceRead === other.portfolioIntelligenceRead
      && standing.entitlements.length === other.entitlements.length
      && standing.entitlements.every((entitlement, entitlementIndex) => {
        const otherEntitlement = other.entitlements[entitlementIndex];
        return otherEntitlement !== undefined
          && entitlement.kind === otherEntitlement.kind
          && entitlement.entitlementId === otherEntitlement.entitlementId
          && entitlement.organizationId === otherEntitlement.organizationId
          && entitlement.membershipId === otherEntitlement.membershipId
          && entitlement.accessProfile === otherEntitlement.accessProfile
          && entitlement.staxisRole === otherEntitlement.staxisRole
          && entitlement.scopeType === otherEntitlement.scopeType
          && entitlement.portfolioId === otherEntitlement.portfolioId;
      });
  });
}

function sameAuthorityFingerprint(
  left: AuthoritativePropertyAccess,
  right: AuthoritativePropertyAccess,
): boolean {
  return left.all === right.all
    && left.authorityMode === right.authorityMode
    && left.authorityVersion === right.authorityVersion
    && left.effectiveAccessHash === right.effectiveAccessHash
    && sameIds(left.propertyIds, right.propertyIds)
    && sameIds(left.legacyPropertyIds, right.legacyPropertyIds)
    && sameIds(left.membershipPropertyIds, right.membershipPropertyIds)
    && samePropertyStandings(left.propertyStandings, right.propertyStandings);
}

/**
 * Reassert every private receipt that contributed a company catalog row, with
 * the selected company last, then compare the account's complete reach hash.
 * The latter also closes hotel-only and platform-admin responses, which have
 * no management-company receipt. None of these proofs crosses the DTO boundary.
 */
async function bootstrapAuthorizationStillCurrent(input: {
  accountId: string;
  initialAuthority: AuthoritativePropertyAccess;
  companies: readonly PortfolioCompanyCatalogEntry[];
  selectedOrganizationId: string | null;
}): Promise<boolean> {
  const receipts = [...input.companies]
    .sort((left, right) => {
      const leftSelected = left.organizationId === input.selectedOrganizationId;
      const rightSelected = right.organizationId === input.selectedOrganizationId;
      if (leftSelected !== rightSelected) return leftSelected ? 1 : -1;
      return left.organizationId.localeCompare(right.organizationId);
    })
    .map((company) => company.authorizationReceipt);

  for (const receipt of receipts) {
    const asserted = await assertAuthorizationScopeReceipt({
      receiptId: receipt.id,
      accountId: input.accountId,
    });
    if (!asserted.ok
      || asserted.receipt.accountId !== receipt.accountId
      || asserted.receipt.organizationId !== receipt.organizationId
      || asserted.receipt.authorizationHash !== receipt.authorizationHash
      || asserted.receipt.scopeHash !== receipt.scopeHash
      || !sameIds(asserted.receipt.authorizedPropertyIds, receipt.authorizedPropertyIds)
      || !sameIds(asserted.receipt.propertyIds, receipt.propertyIds)) return false;
  }

  const finalAuthority = await listAuthoritativePropertyAccess(input.accountId);
  return finalAuthority !== null
    && sameAuthorityFingerprint(input.initialAuthority, finalAuthority);
}

function authorizationUnavailable(requestId: string): Response {
  return err('Could not verify your current hotel access', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
  });
}

/** The hotels this account may open, already bounded. Admins and `'*'` holders
 *  reach everything, which is the one case that is not an id list.
 *
 *  `total` is how many this account reaches BEFORE the cap, counted by the same
 *  query rather than inferred from the page: a silently truncated list is a
 *  picker that tells a Staxis administrator their fleet is 60 hotels. The count
 *  is what lets the screen say "showing 60 of 412" instead of lying by
 *  omission. `count: 'exact'` ignores `.limit()` — that is the point of it. */
async function readHotels(
  propertyIds: readonly string[] | null,
): Promise<{ rows: PropertyRow[]; total: number }> {
  if (propertyIds !== null) {
    const rows = await readCompleteCompanyIdChunks<PropertyRow>(
      propertyIds,
      (chunk, from, to) => supabaseAdmin
        .from('properties')
        .select(PROPERTY_COLUMNS, { count: 'exact' })
        .in('id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertyRow>>,
    );
    rows.sort((left, right) => (
      (left.name ?? '').localeCompare(right.name ?? '') || left.id.localeCompare(right.id)
    ));
    return { rows, total: rows.length };
  }
  const base = supabaseAdmin.from('properties').select(PROPERTY_COLUMNS, { count: 'exact' });
  const { data, error, count } = await base.order('name', { ascending: true }).limit(MAX_HOTELS);
  if (error) throw new Error(`property list failed: ${error.message}`);
  const rows = (data ?? []) as unknown as PropertyRow[];
  // A backend that does not report a count (the pglite test shim) must not make
  // the picker claim MORE hotels exist than it drew, so fall back to the page.
  return { rows, total: typeof count === 'number' ? count : rows.length };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const account = await loadSessionAccount(session.userId);
  if (!account) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    const requestedOrganizationId = new URL(req.url).searchParams.get('organizationId');
    if (requestedOrganizationId !== null && !isUuid(requestedOrganizationId)) {
      return err('organizationId must be a valid UUID', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers: PRIVATE_HEADERS,
      });
    }

    // Exact current reach from the account's selected authority mode.
    const access = await listAuthoritativePropertyAccess(account.accountId);
    if (!access) return authorizationUnavailable(requestId);
    const reachesAll = access.all;

    // Pay the limiter before the catalog. Catalog construction can mint and
    // verify receipts plus read settings for as many as 50 companies, so a 429
    // after that work would not bound the endpoint's dominant fan-out. The
    // opaque scope is derived only from the account: changing company ids or
    // selected hotels cannot rotate buckets, and platform admins are included.
    const limit = await checkAndIncrementRateLimit(
      'property-selector',
      propertySelectorRateLimitKey(account.accountId),
    );
    if (!limit.allowed) {
      return err('Too many requests, try again shortly', {
        requestId,
        status: 429,
        code: ApiErrorCode.RateLimited,
        headers: { ...PRIVATE_HEADERS, 'Retry-After': String(limit.retryAfterSec) },
      });
    }

    const catalogResult = await listPortfolioCompaniesUncached(account.accountId);
    if (!catalogResult.ok) {
      return err('Could not verify your current company access', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
      });
    }
    const companies = catalogResult.companies;
    const selectedCompany = requestedOrganizationId
      ? companies.find((company) => company.organizationId === requestedOrganizationId) ?? null
      : companies.length === 1 ? companies[0] : null;
    if (requestedOrganizationId && !selectedCompany) {
      // Do not disclose whether a pasted organization id exists.
      return err('Company access was not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
        headers: PRIVATE_HEADERS,
      });
    }

    // Never mix two companies in one picker state. A multi-company account
    // must choose one explicitly; a single company is selected automatically.
    const propertyIds = reachesAll
      ? null
      : selectedCompany
        ? selectedCompany.authorizationReceipt.propertyIds
        : companies.length > 1 ? [] : access.propertyIds;

    if (!reachesAll && (propertyIds?.length ?? 0) === 0) {
      // No hotels is a real answer, not an error — the client's join-status
      // gate is what explains it to a pending staff signup.
      if (!await bootstrapAuthorizationStillCurrent({
        accountId: account.accountId,
        initialAuthority: access,
        companies,
        selectedOrganizationId: selectedCompany?.organizationId ?? null,
      })) return authorizationUnavailable(requestId);
      return ok(
        {
          hotels: [],
          reachableHotelCount: 0,
          hasCompanyHat: accountHasCompanyHat(account.hats),
          company: null,
          companies: companies.map((company) => ({
            organizationId: company.organizationId,
            organizationName: company.organizationName,
            companyRole: company.companyRole,
            hotelCount: company.propertyIds.length,
            chatAvailable: company.chatAvailable,
            queueAvailable: company.queueAvailable,
          })),
          requiresCompanySelection: companies.length > 1 && !selectedCompany,
          chat: { available: false },
          signedInAs: account.displayName,
        },
        { requestId, headers: PRIVATE_HEADERS },
      );
    }

    const { rows, total: reachableHotelCount } = await readHotels(propertyIds);

    let chips = new Map<string, HotelChip | null>();
    if (selectedCompany) {
      // Chips ONLY for hotels this company operates. A separately authorized
      // hotel outside this selected company gets no chip, because this
      // company's watcher says nothing about it.
      //
      // The same is true past the health loader's own cost cap, and it is safe
      // for the same reason: NO CHIP IS NOT A CLAIM. The only chip that asserts
      // anything about having looked is `quiet`, and `chipForHotel` cannot
      // produce it without a fresh run. Everything a capped-out hotel renders
      // is its name — silence, which is the honest thing to say about a
      // building this read did not reach.
      const covered = rows.map((r) => r.id);
      chips = await hotelHealthChips(covered);
    }

    const hotels: PickerHotel[] = rows.map((row) => ({
      propertyId: row.id,
      name: row.name ?? 'This hotel',
      totalRooms: roomCount(row.total_rooms),
      chip: chips.get(row.id) ?? null,
      onboardingCompletedAt: row.onboarding_completed_at,
      onboardingState: row.onboarding_state,
      onboardingPromptShownAt: row.onboarding_prompt_shown_at,
    }));

    // THE CHAT DOOR, asked of the one function that owns the question. Both
    // halves are required and neither is inferred here: a company-scope job AND
    // `cross_hotel_ai_chat` switched on. Uncached, so a company that turned it
    // off five seconds ago is not offered it on their next sign-in.
    const chatAvailable = selectedCompany?.chatAvailable ?? false;

    // Metadata and health chips are service-role reads. Do not let any of them
    // cross browser egress if a hat was revoked, a hotel transferred, the
    // account changed authority mode, or the assertion store became unavailable
    // while this response was being assembled.
    if (!await bootstrapAuthorizationStillCurrent({
      accountId: account.accountId,
      initialAuthority: access,
      companies,
      selectedOrganizationId: selectedCompany?.organizationId ?? null,
    })) return authorizationUnavailable(requestId);

    return ok(
      {
        hotels: rankHotels(hotels),
        /** How many this account reaches in total. Only an unscoped platform
         *  admin can exceed `hotels.length`; exact company lists are complete. */
        reachableHotelCount,
        hasCompanyHat: accountHasCompanyHat(account.hats),
        company: selectedCompany
          ? {
            organizationId: selectedCompany.organizationId,
            organizationName: selectedCompany.organizationName,
            companyRole: selectedCompany.companyRole,
            hotelCount: selectedCompany.propertyIds.length,
            queueAvailable: selectedCompany.queueAvailable,
          }
          : null,
        companies: companies.map((company) => ({
          organizationId: company.organizationId,
          organizationName: company.organizationName,
          companyRole: company.companyRole,
          hotelCount: company.propertyIds.length,
          chatAvailable: company.chatAvailable,
          queueAvailable: company.queueAvailable,
        })),
        requiresCompanySelection: companies.length > 1 && !selectedCompany,
        chat: { available: chatAvailable },
        signedInAs: account.displayName,
      },
      { requestId, headers: PRIVATE_HEADERS },
    );
  } catch (e) {
    // Deliberately an error, not an empty list. An empty picker is a CLAIM —
    // "you have no hotels" — and a failed read has not earned the right to
    // make it. The screen says it could not load and offers a retry.
    log.error('[property-selector] bootstrap failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not load your hotels', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { ...PRIVATE_HEADERS, 'Retry-After': '5' },
    });
  }
}
