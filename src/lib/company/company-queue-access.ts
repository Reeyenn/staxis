import 'server-only';

/** Minimal structural view of a validated all-authorized company receipt. */
export interface CompanyQueueAuthorizationAccess {
  readonly propertyIds: readonly string[];
  readonly authorizationReceipt: Readonly<{
    provenance: Readonly<{
      entitlements: readonly Readonly<{
        propertyId: string;
        scopeType: string | null;
      }>[];
    }>;
  }>;
}

/**
 * Whether opaque organization-wide queue cards are safe for this exact scope.
 *
 * Call only with the authoritative resolver's already validated receipt. A
 * company/organization entitlement must cover every selected property. Mere
 * presence of one whole-company row is insufficient because a mixed receipt
 * may also contain narrower portfolio/property reach.
 */
export function companyQueueAvailableFromAuthorization(
  access: CompanyQueueAuthorizationAccess,
): boolean {
  if (access.propertyIds.length === 0) return false;
  const companyCovered = new Set(
    access.authorizationReceipt.provenance.entitlements
      .filter((entitlement) => (
        entitlement.scopeType === 'company' || entitlement.scopeType === 'organization'
      ))
      .map((entitlement) => entitlement.propertyId),
  );
  return access.propertyIds.every((propertyId) => companyCovered.has(propertyId));
}
