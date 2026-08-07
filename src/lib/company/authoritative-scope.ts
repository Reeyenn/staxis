import 'server-only';

/**
 * Feature-independent management-company scope.
 *
 * This is the shared tenant door for portfolio chat, the company queue, and
 * other read-only management surfaces. It resolves one fresh, exact
 * all-authorized receipt and derives only a presentation role from that same
 * receipt. It deliberately does not read `cross_hotel_ai_chat`: that setting
 * controls model access, not whether an authorized manager may open /feed.
 */

import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import { resolveAuthorizationScope } from '@/lib/authorization/server';
import {
  accessProfileForHat,
  type CompanyScopeRole,
} from '@/lib/company/roles';
import {
  ACCESS_PROFILE_CAPABILITIES,
  ORGANIZATION_CAPABILITIES,
  type AccessProfile,
  type OrganizationCapability,
} from '@/lib/organization-access/domain';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ManagementCompanyScopeRefusal =
  | 'no_company_job'
  | 'ambiguous_company'
  | 'no_hotels'
  | 'scope_too_large'
  | 'authorization_unavailable';

export interface ManagementCompanyScopeAccess {
  organizationId: string;
  organizationName: string | null;
  /** Backward-compatible UI role; permissions remain receipt/capability based. */
  companyRole: CompanyScopeRole;
  propertyIds: string[];
  /**
   * UI-safe explanation of the validated grants that produced reach. This is
   * presentation metadata, never an alternative authorization source.
   */
  scopeDescriptors: ManagementCompanyScopeDescriptor[];
  /** Least-privilege display hints; mutations still use capability RPCs. */
  presentationCapabilities: OrganizationCapability[];
  /** Org-wide Finding queue visibility. Derived from fresh receipt provenance,
   * never from the presentation role or a card. Portfolio/property grants do
   * not authorize opaque company-wide findings. */
  queueAvailable: boolean;
  /** Exact per-hotel UI standing derived only from this fresh receipt. */
  propertyStandings: ManagementCompanyPropertyStanding[];
  /** Strict hub-label hint; a one-hotel property-only GM never reaches success. */
  isPortfolioActor: true;
  authorizationReceipt: AuthorizationScopeReceipt;
}

export type ManagementCompanyScopeKind = 'company' | 'region' | 'portfolio' | 'selected_hotels';

export interface ManagementCompanyScopeDescriptor {
  kind: ManagementCompanyScopeKind;
  /** Organization, portfolio, membership, or access-grant id by kind. */
  id: string;
  name: string;
  propertyIds: string[];
}

export interface ManagementCompanyPropertyStanding {
  propertyId: string;
  /** Legacy-compatible presentation role, never an independent authority. */
  operationalRole: 'general_manager' | 'front_desk';
  /** True only for explicit property-scope operational management. */
  canManageHotel: boolean;
  /** Financial reads are separate from hotel mutation authority. */
  seesFinancials: boolean;
  /** Every standing in a successful management receipt has this read grant. */
  portfolioIntelligenceRead: true;
}

export type ManagementCompanyScopeResult =
  | { ok: true; access: ManagementCompanyScopeAccess }
  | { ok: false; reason: ManagementCompanyScopeRefusal };

function profileForEntitlement(
  entitlement: AuthorizationScopeReceipt['provenance']['entitlements'][number],
): AccessProfile {
  if (entitlement.entitlementKind === 'access_grant') {
    return entitlement.accessProfile!;
  }
  return accessProfileForHat(
    entitlement.scopeType as 'company' | 'property',
    entitlement.staxisRole!,
  );
}

/** Presentation-only capability hints derived from validated provenance. */
export function presentationCapabilitiesFromAuthorizationReceipt(
  receipt: AuthorizationScopeReceipt,
): OrganizationCapability[] {
  const capabilities = new Set<OrganizationCapability>();
  for (const entitlement of receipt.provenance.entitlements) {
    for (const capability of ACCESS_PROFILE_CAPABILITIES[profileForEntitlement(entitlement)]) {
      capabilities.add(capability);
    }
  }
  return ORGANIZATION_CAPABILITIES.filter((capability) => capabilities.has(capability));
}

/**
 * Queue/feed findings are organization-wide. A region, portfolio or selected-
 * hotel entitlement may use portfolio intelligence at its exact scope, but it
 * must not reveal opaque company cards. This mirrors the queue route's own
 * receipt gate and is exported for catalog/UI consistency only.
 */
export function queueAvailableFromAuthorizationReceipt(
  receipt: AuthorizationScopeReceipt,
): boolean {
  if (receipt.propertyIds.length === 0) return false;
  // Finding Patterns' final `companyQueueAvailableFromAuthorization` seam uses
  // this exact all-properties rule. Keeping it here until that branch is
  // integrated avoids a permissive temporary state: one broad entitlement may
  // not launder additional portfolio/property-only hotels into org-wide cards.
  return receipt.propertyIds.every((propertyId) =>
    receipt.provenance.entitlements.some((entitlement) => (
      entitlement.propertyId === propertyId
      && (entitlement.scopeType === 'company' || entitlement.scopeType === 'organization')
    )),
  );
}

function entitlementCanManageHotel(
  entitlement: AuthorizationScopeReceipt['provenance']['entitlements'][number],
): boolean {
  return (entitlement.entitlementKind === 'membership_hat'
      && entitlement.scopeType === 'property'
      && entitlement.staxisRole === 'general_manager')
    || (entitlement.entitlementKind === 'access_grant'
      && entitlement.scopeType === 'property'
      && entitlement.accessProfile === 'property_manager');
}

function entitlementSeesFinancials(
  entitlement: AuthorizationScopeReceipt['provenance']['entitlements'][number],
): boolean {
  return entitlement.entitlementKind === 'membership_hat'
    ? entitlement.staxisRole === 'owner'
      || entitlement.staxisRole === 'regional_manager'
      || entitlement.staxisRole === 'general_manager'
    : entitlement.accessProfile === 'organization_owner'
      || entitlement.accessProfile === 'property_manager';
}

/**
 * Exact per-hotel presentation standing from validated receipt provenance.
 * Cards may render this DTO, but server writes still re-resolve at commit.
 */
export function propertyStandingsFromAuthorizationReceipt(
  receipt: AuthorizationScopeReceipt,
): ManagementCompanyPropertyStanding[] {
  const byProperty = new Map<
    string,
    AuthorizationScopeReceipt['provenance']['entitlements']
  >();
  for (const propertyId of receipt.propertyIds) byProperty.set(propertyId, []);
  for (const entitlement of receipt.provenance.entitlements) {
    byProperty.get(entitlement.propertyId)?.push(entitlement);
  }
  return receipt.propertyIds.map((propertyId) => {
    const entitlements = byProperty.get(propertyId) ?? [];
    const canManageHotel = entitlements.some(entitlementCanManageHotel);
    return {
      propertyId,
      operationalRole: canManageHotel ? 'general_manager' : 'front_desk',
      canManageHotel,
      seesFinancials: entitlements.some(entitlementSeesFinancials),
      portfolioIntelligenceRead: true,
    };
  });
}

/** Mirrors the database rule that keeps a one-hotel property-only GM in hotel mode. */
export function receiptRepresentsPortfolioActor(receipt: AuthorizationScopeReceipt): boolean {
  return receipt.authorizedPropertyCount > 1
    || receipt.provenance.entitlements.some((entitlement) => (
      entitlement.scopeType === 'company'
        || entitlement.scopeType === 'organization'
        || entitlement.scopeType === 'portfolio'
    ));
}

/**
 * Group per-hotel provenance into stable, human-legible grant scopes. The
 * receipt remains the authority and each descriptor carries only hotels that
 * appear in that exact current receipt.
 */
export function scopeDescriptorsFromAuthorizationReceipt(
  receipt: AuthorizationScopeReceipt,
): ManagementCompanyScopeDescriptor[] {
  const catalog = new Map(receipt.portfolioCatalog.map((entry) => [entry.portfolioId, entry]));
  const grouped = new Map<string, {
    kind: ManagementCompanyScopeKind;
    id: string;
    baseName: string;
    propertyIds: Set<string>;
  }>();
  for (const entitlement of receipt.provenance.entitlements) {
    let kind: ManagementCompanyScopeKind;
    let id: string;
    let baseName: string;
    if (entitlement.scopeType === 'company' || entitlement.scopeType === 'organization') {
      kind = 'company';
      id = receipt.organizationId;
      baseName = receipt.organizationName;
    } else if (entitlement.scopeType === 'portfolio') {
      const portfolio = catalog.get(entitlement.portfolioId!);
      kind = portfolio?.portfolioType === 'region' ? 'region' : 'portfolio';
      id = entitlement.portfolioId!;
      baseName = portfolio?.name ?? 'Authorized portfolio';
    } else {
      kind = 'selected_hotels';
      id = entitlement.entitlementId;
      baseName = 'Selected hotels';
    }
    const key = `${kind}\0${id}`;
    const bucket = grouped.get(key) ?? { kind, id, baseName, propertyIds: new Set<string>() };
    bucket.propertyIds.add(entitlement.propertyId);
    grouped.set(key, bucket);
  }
  return [...grouped.values()]
    .map((item): ManagementCompanyScopeDescriptor => {
      const propertyIds = [...item.propertyIds].sort();
      return {
        kind: item.kind,
        id: item.id,
        name: item.kind === 'selected_hotels'
          ? `${item.baseName} (${propertyIds.length})`
          : item.baseName,
        propertyIds,
      };
    })
    .sort((left, right) => (
      left.kind.localeCompare(right.kind)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
    ));
}

/** Derive legacy display vocabulary from the exact authoritative receipt. */
export function companyRoleFromAuthorizationReceipt(
  receipt: AuthorizationScopeReceipt,
): CompanyScopeRole | null {
  const entitlements = receipt.provenance.entitlements;
  if (entitlements.some((item) => item.staxisRole === 'owner'
    || item.accessProfile === 'organization_owner')) return 'owner';
  if (entitlements.some((item) => item.staxisRole === 'regional_manager')) {
    return 'regional_manager';
  }

  const hasExplicitPortfolioGrant = entitlements.some((item) => (
    item.accessProfile === 'organization_admin'
      || item.accessProfile === 'portfolio_manager'
  ));
  const hasMultiPropertyManagement = receipt.authorizedPropertyCount > 1
    && entitlements.some((item) => (
      item.staxisRole === 'general_manager'
        || item.accessProfile === 'property_manager'
    ));
  // Somebody holding a portfolio grant, or running more than one hotel, with no
  // company hat of their own. `regional_manager` is the read-only queue/chat
  // presentation word for them; before 0464 that word was `finance`, which was
  // always a poor description of a portfolio grant. This never grants regional
  // manager capabilities: every action checks its own capability, and WHICH
  // hotels remains whatever the receipt already proved.
  return hasExplicitPortfolioGrant || hasMultiPropertyManagement
    ? 'regional_manager'
    : null;
}

function mapRefusal(reason: string): ManagementCompanyScopeRefusal {
  if (reason === 'ambiguous_company') return 'ambiguous_company';
  if (reason === 'no_hotels') return 'no_hotels';
  if (reason === 'scope_too_large') return 'scope_too_large';
  if (reason === 'store_unavailable'
    || reason === 'scope_changed'
    || reason === 'revoked_or_changed'
    || reason === 'expired') return 'authorization_unavailable';
  return 'no_company_job';
}

/**
 * Resolve an exact current company scope without any product feature gate.
 * Supplying another tenant's organization id returns the same generic
 * no-company refusal as an invalid id; callers cannot use it as an oracle.
 */
export async function resolveManagementCompanyScopeUncached(
  accountId: string,
  organizationId?: string | null,
): Promise<ManagementCompanyScopeResult> {
  if (!UUID_RX.test(accountId ?? '')
    || (organizationId != null && !UUID_RX.test(organizationId))) {
    return { ok: false, reason: 'no_company_job' };
  }
  try {
    const resolved = await resolveAuthorizationScope({
      accountId,
      organizationId,
      selector: { type: 'all_authorized' },
    });
    if (!resolved.ok) return { ok: false, reason: mapRefusal(resolved.reason) };
    const companyRole = companyRoleFromAuthorizationReceipt(resolved.receipt);
    if (!companyRole || !receiptRepresentsPortfolioActor(resolved.receipt)) {
      return { ok: false, reason: 'no_company_job' };
    }
    if (resolved.receipt.propertyIds.length === 0) return { ok: false, reason: 'no_hotels' };
    return {
      ok: true,
      access: {
        organizationId: resolved.receipt.organizationId,
        organizationName: resolved.receipt.organizationName,
        companyRole,
        propertyIds: resolved.receipt.propertyIds,
        scopeDescriptors: scopeDescriptorsFromAuthorizationReceipt(resolved.receipt),
        presentationCapabilities: presentationCapabilitiesFromAuthorizationReceipt(resolved.receipt),
        queueAvailable: queueAvailableFromAuthorizationReceipt(resolved.receipt),
        propertyStandings: propertyStandingsFromAuthorizationReceipt(resolved.receipt),
        isPortfolioActor: true,
        authorizationReceipt: resolved.receipt,
      },
    };
  } catch {
    return { ok: false, reason: 'authorization_unavailable' };
  }
}
