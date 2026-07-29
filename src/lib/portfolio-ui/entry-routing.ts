interface PortfolioEntryStanding {
  portfolioIntelligenceRead: boolean;
}

interface PortfolioBootstrapDecision {
  signedIn: boolean;
  authLoading: boolean;
  browserRoleIsAdmin: boolean;
  authorizationChecked: boolean;
  platformAdmin: boolean;
  propertyStandings: readonly PortfolioEntryStanding[];
  explicitPortfolioContext: boolean;
  entryRoute: boolean;
}

/**
 * Entry routes may discover portfolio access only from the fresh authoritative
 * standing projection. Explicit portfolio URLs still reach the server gate so
 * it can return their existing authorization result.
 */
export function shouldLoadPortfolioBootstrap(input: PortfolioBootstrapDecision): boolean {
  if (!input.signedIn || input.authLoading || input.browserRoleIsAdmin) return false;
  if (input.platformAdmin) return false;
  if (input.explicitPortfolioContext) return true;
  return input.entryRoute
    && input.authorizationChecked
    && input.propertyStandings.some((standing) => standing.portfolioIntelligenceRead);
}

export function shouldWaitForPortfolioEntry(input: {
  hotelDrilldown: boolean;
  portfolioLoading: boolean;
}): boolean {
  return !input.hotelDrilldown && input.portfolioLoading;
}
