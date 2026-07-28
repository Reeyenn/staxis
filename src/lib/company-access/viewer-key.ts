export interface CompanyAccessViewerIdentity {
  uid: string;
  accountId: string;
  role: string;
  propertyAccess: readonly string[];
  resolvedPropertyKey: string;
  adminTargetPropertyId: string | null;
}

/**
 * Stamps company data to the complete client authorization identity that was
 * used to request it. Array order is not authorization state, so legacy grants
 * are sorted before encoding. JSON avoids delimiter collisions in opaque ids.
 */
export function buildCompanyAccessViewerKey(identity: CompanyAccessViewerIdentity): string {
  const normalizedRole = identity.role.trim().toLowerCase();
  const explicitPropertyGrants = [...new Set(identity.propertyAccess)].sort();
  return JSON.stringify([
    identity.uid,
    identity.accountId,
    normalizedRole,
    explicitPropertyGrants,
    identity.resolvedPropertyKey,
    normalizedRole === 'admin' ? identity.adminTargetPropertyId : null,
  ]);
}
