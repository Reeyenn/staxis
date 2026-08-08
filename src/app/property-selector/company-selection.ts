const BOOTSTRAP_PATH = '/api/property-selector/bootstrap';

export interface CompanyChoiceIdentity {
  organizationId: string;
}

/**
 * The browser may only request an organization id that appeared in the latest
 * authoritative catalog. This is defense in depth (the route re-authorizes
 * every id), and also prevents a modified DOM event from becoming an ID probe.
 */
export function authorizedCompanySelection(
  companies: readonly CompanyChoiceIdentity[],
  requestedOrganizationId: string,
): string | null {
  return companies.some((company) => company.organizationId === requestedOrganizationId)
    ? requestedOrganizationId
    : null;
}

/** A source-identity change makes useApiResource discard the old company. */
export function companyBootstrapPath(organizationId: string | null): string {
  return organizationId
    ? `${BOOTSTRAP_PATH}?organizationId=${encodeURIComponent(organizationId)}`
    : BOOTSTRAP_PATH;
}

/** Hotel-only accounts may skip the door; an exact company hat never does. */
export function shouldAutoEnterSingleHotel(input: {
  exactCompanyHat: boolean;
  hotelCount: number;
  hasSelectedCompany: boolean;
  requiresCompanySelection: boolean;
}): boolean {
  return !input.exactCompanyHat
    && !input.hasSelectedCompany
    && !input.requiresCompanySelection
    && input.hotelCount === 1;
}
