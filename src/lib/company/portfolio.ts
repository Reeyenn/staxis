import 'server-only';

// ─── The portfolio door ─────────────────────────────────────────────────────
//
// WHAT THIS IS
// The ONE function that answers "may this person ask the copilot about a whole
// company, and which hotels does that mean". Everything about cross-hotel chat
// — the route's gate, every portfolio tool's re-verification, the prompt's
// hotel list — comes through here and nowhere else.
//
// THREE QUESTIONS, IN THIS ORDER, AND THE ORDER IS THE DESIGN
//   1. Does the authoritative receipt contain a company/portfolio entitlement,
//      or a manager scope spanning more than one hotel? A one-hotel GM remains
//      in hotel mode; explicit region/portfolio grants enter this surface.
//   2. Has that company TURNED CROSS-HOTEL CHAT ON? Default off (0365's
//      `cross_hotel_ai_chat`), and the default is respected absolutely: asking
//      the copilot about twenty hotels at once is a decision a company makes,
//      not something we switch on for them.
//   3. Which hotels does the company operate right now?
//
// WALL B, RESTATED FOR THIS SURFACE
// Coverage comes from the immutable authorization receipt, whose PostgreSQL
// resolver expands only governing relationships in the caller's own active
// entitlements. A supplied organization id can only narrow that resolver.

import {
  listAuthoritativePropertyAccess,
  resolveAuthorizationScope,
} from '@/lib/authorization/server';
import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import { companyAccessSetting } from '@/lib/company/rulebook-access';
import type { CompanyScopeRole } from '@/lib/company/roles';
import {
  companyRoleFromAuthorizationReceipt,
  queueAvailableFromAuthorizationReceipt,
  resolveManagementCompanyScopeUncached,
} from '@/lib/company/authoritative-scope';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounds the uncached per-company receipt/settings fan-out for one bootstrap. */
const MAX_PORTFOLIO_COMPANIES_PER_ACCOUNT = 50;

/**
 * Why the door was closed. Each one is a DIFFERENT sentence to the user, which
 * is why they are not collapsed into a boolean: "you don't have a company job"
 * and "your company has this switched off" send a person to two different
 * places.
 */
export type PortfolioRefusal =
  /** No company-scope hat anywhere — a property-scope job, or no job at all. */
  | 'no_company_job'
  /** They hold company jobs at more than one company and named none of them. */
  | 'ambiguous_company'
  /** The company has not turned `cross_hotel_ai_chat` on (the default). */
  | 'cross_hotel_chat_off'
  /** The company operates no hotels right now, so there is no portfolio. */
  | 'no_hotels'
  /** Exact scope exceeds the deliberately bounded interactive surface. */
  | 'scope_too_large'
  /** Authorization storage/version checks could not produce a current receipt. */
  | 'authorization_unavailable';

export interface PortfolioAccess {
  organizationId: string;
  organizationName: string | null;
  /** The strongest company-scope job this person holds at that company. */
  companyRole: CompanyScopeRole;
  /** Every hotel the company operates right now. Sorted, de-duplicated. */
  propertyIds: string[];
  /** Immutable exact scope; downstream tools must assert it again. */
  authorizationReceipt: AuthorizationScopeReceipt;
}

export type PortfolioAccessResult =
  | { ok: true; access: PortfolioAccess }
  | { ok: false; reason: PortfolioRefusal };

export interface PortfolioCompanyCatalogEntry {
  organizationId: string;
  organizationName: string | null;
  companyRole: CompanyScopeRole;
  /** Exact, untruncated current portfolio reach for this account + company. */
  propertyIds: string[];
  chatAvailable: boolean;
  /** Fresh receipt contains an org-wide company/organization entitlement. */
  queueAvailable: boolean;
  /**
   * Server-only proof behind this catalog row. Transport callers must project
   * the public fields explicitly and reassert this receipt before egress.
   */
  authorizationReceipt: AuthorizationScopeReceipt;
}

export type PortfolioCompanyCatalogResult =
  | { ok: true; companies: PortfolioCompanyCatalogEntry[] }
  | { ok: false; reason: 'authorization_unavailable' | 'scope_too_large' };

/** Plain-English refusal, for the route AND for a tool that re-verified. */
export const PORTFOLIO_REFUSAL_TEXT: Record<PortfolioRefusal, string> = {
  no_company_job:
    'Portfolio questions are for people with a company-wide job (owner, oversight or finance). '
    + 'Ask about one hotel at a time instead.',
  ambiguous_company:
    'You hold a company job at more than one company. Say which company you mean.',
  cross_hotel_chat_off:
    'This company has not turned on asking about all its hotels at once. '
    + 'A company owner or VP can switch it on in the company settings.',
  no_hotels:
    'This company does not operate any hotels right now, so there is nothing to compare.',
  scope_too_large:
    'This portfolio is larger than the interactive query limit. Narrow the question to a region or named hotels.',
  authorization_unavailable:
    'Your current hotel access could not be verified. Try again; no portfolio data was read.',
};

/**
 * Exact company choices for an account. Candidate organization ids come only
 * from the authoritative per-hotel provenance DTO; every candidate is then
 * resolved through a fresh all-authorized receipt. If any candidate cannot be
 * verified, the whole catalog fails instead of returning a misleading partial
 * list that could auto-select the wrong company.
 */
export async function listPortfolioCompaniesUncached(
  accountId: string,
): Promise<PortfolioCompanyCatalogResult> {
  const authority = await listAuthoritativePropertyAccess(accountId);
  if (!authority) return { ok: false, reason: 'authorization_unavailable' };
  if (authority.all) return { ok: true, companies: [] };

  const candidateOrganizationIds = [...new Set(authority.propertyStandings
    .flatMap((standing) => standing.entitlements)
    .filter((entitlement) => (
      entitlement.kind === 'membership_hat' || entitlement.kind === 'access_grant'
    ))
    .map((entitlement) => entitlement.organizationId)
    .filter((id): id is string => id !== null))].sort();
  if (candidateOrganizationIds.length > MAX_PORTFOLIO_COMPANIES_PER_ACCOUNT) {
    return { ok: false, reason: 'scope_too_large' };
  }

  const companies: PortfolioCompanyCatalogEntry[] = [];
  for (const organizationId of candidateOrganizationIds) {
    const resolved = await resolveAuthorizationScope({
      accountId,
      organizationId,
      selector: { type: 'all_authorized' },
    });
    if (!resolved.ok) {
      if (resolved.reason === 'no_company_job' || resolved.reason === 'no_hotels') continue;
      if (resolved.reason === 'scope_too_large') {
        return { ok: false, reason: 'scope_too_large' };
      }
      return { ok: false, reason: 'authorization_unavailable' };
    }
    const companyRole = companyRoleFromAuthorizationReceipt(resolved.receipt);
    if (!companyRole) continue;
    const setting = await companyAccessSetting(organizationId, 'cross_hotel_ai_chat');
    companies.push({
      organizationId,
      organizationName: resolved.receipt.organizationName,
      companyRole,
      propertyIds: resolved.receipt.propertyIds,
      chatAvailable: setting === 'true',
      queueAvailable: queueAvailableFromAuthorizationReceipt(resolved.receipt),
      authorizationReceipt: resolved.receipt,
    });
  }

  return {
    ok: true,
    companies: companies.sort((left, right) => (
      (left.organizationName ?? '').localeCompare(right.organizationName ?? '')
        || left.organizationId.localeCompare(right.organizationId)
    )),
  };
}

/**
 * Resolve the portfolio door, hitting the database every time.
 *
 * @param accountId      the person asking.
 * @param organizationId optional NARROWING to one of the companies they already
 *                       hold a job at. Never a lookup key — see Wall B above.
 */
export async function resolvePortfolioAccessUncached(
  accountId: string,
  organizationId?: string | null,
): Promise<PortfolioAccessResult> {
  if (!UUID_RX.test(accountId ?? '')) return { ok: false, reason: 'no_company_job' };
  if (organizationId != null && !UUID_RX.test(organizationId)) {
    return { ok: false, reason: 'no_company_job' };
  }

  const companyScope = await resolveManagementCompanyScopeUncached(accountId, organizationId);
  if (!companyScope.ok) return companyScope;
  const targetId = companyScope.access.organizationId;

  // THE GATE. Default 'false' — a company that never opened the setup screen
  // does not get cross-hotel chat, and `companyAccessSetting` returns that
  // default rather than throwing when the store cannot answer.
  const setting = await companyAccessSetting(targetId, 'cross_hotel_ai_chat');
  if (setting !== 'true') return { ok: false, reason: 'cross_hotel_chat_off' };

  // A company hat's coverage IS every hotel the company operates right now
  // (access.ts), so this is already the company's portfolio — with no chance
  // of a second company's hotel in it.
  const propertyIds = companyScope.access.propertyIds;
  if (propertyIds.length === 0) return { ok: false, reason: 'no_hotels' };

  return {
    ok: true,
    access: {
      organizationId: targetId,
      organizationName: companyScope.access.organizationName,
      companyRole: companyScope.access.companyRole,
      propertyIds,
      authorizationReceipt: companyScope.access.authorizationReceipt,
    },
  };
}

/** Always mint a fresh receipt. Authorization is never accepted from TTL cache. */
export async function resolvePortfolioAccess(
  accountId: string,
  organizationId?: string | null,
): Promise<PortfolioAccessResult> {
  return resolvePortfolioAccessUncached(accountId, organizationId)
    .catch((): PortfolioAccessResult => ({ ok: false, reason: 'authorization_unavailable' }));
}

/** Backward-compatible test seam; authorization results are no longer cached. */
export function clearPortfolioAccessCache(): void {
  // Deliberately empty.
}
