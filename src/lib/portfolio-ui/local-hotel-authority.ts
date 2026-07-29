export interface LocalHotelEntitlementInput {
  kind: 'legacy' | 'legacy_bridge' | 'membership_hat' | 'access_grant';
  scopeType: 'company' | 'organization' | 'portfolio' | 'property' | null;
  accessProfile: string | null;
  staxisRole: string | null;
}

export interface LocalHotelStandingInput {
  propertyId: string;
  entitlements: readonly LocalHotelEntitlementInput[];
}

/**
 * Deliberate local-hotel entry needs a real hotel-local winning entitlement.
 * Company/region/portfolio reach belongs to the portfolio acting context and
 * cannot be converted into a local GM-style context by removing URL params.
 */
export function standingHasLocalHotelContext(
  standing: LocalHotelStandingInput | null | undefined,
): boolean {
  if (!standing || !Array.isArray(standing.entitlements)) return false;
  return standing.entitlements.some((entitlement) => {
    if (entitlement.kind === 'legacy' || entitlement.kind === 'legacy_bridge') return true;
    if (entitlement.kind === 'membership_hat') return entitlement.scopeType === 'property';
    return entitlement.kind === 'access_grant'
      && entitlement.scopeType === 'property'
      && entitlement.accessProfile === 'property_manager';
  });
}
