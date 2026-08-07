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
  /**
   * Any signed-in app route that can OFFER a company. Company view is a mode of
   * the ordinary app now, so the switcher has to be able to show the company row
   * on /dashboard and /housekeeping too, not only on the two entry doors. An
   * explicit hotel drilldown is deliberately not one of these.
   */
  companyModeRoute?: boolean;
}

/**
 * Entry and in-app routes may discover portfolio access only from the fresh
 * authoritative standing projection. Explicit portfolio URLs still reach the
 * server gate so it can return their existing authorization result.
 */
export function shouldLoadPortfolioBootstrap(input: PortfolioBootstrapDecision): boolean {
  if (!input.signedIn || input.authLoading || input.browserRoleIsAdmin) return false;
  if (input.platformAdmin) return false;
  if (input.explicitPortfolioContext) return true;
  return (input.entryRoute || input.companyModeRoute === true)
    && input.authorizationChecked
    && input.propertyStandings.some((standing) => standing.portfolioIntelligenceRead);
}

export function shouldWaitForPortfolioEntry(input: {
  hotelDrilldown: boolean;
  portfolioLoading: boolean;
}): boolean {
  return !input.hotelDrilldown && input.portfolioLoading;
}

/**
 * An entry surface waits for a terminal portfolio bootstrap only when that
 * request was actually enabled. Hotel-only users deliberately do not issue the
 * request, so their permanent null result must never become a permanent
 * property-selector spinner.
 */
export function shouldWaitForPortfolioBootstrapResult(input: {
  enabled: boolean;
  loading: boolean;
  hasData: boolean;
  hasError: boolean;
}): boolean {
  return input.enabled && !input.hasError && (input.loading || !input.hasData);
}
