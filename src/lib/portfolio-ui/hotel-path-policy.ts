import type { HotelActingContextV1 } from './hotel-acting-contract';
import type { PortfolioUiSection } from './contracts';

export type PortfolioHotelSurface =
  | { mode: 'local' }
  | { mode: 'restricted_home' }
  | { mode: 'readonly_financials' }
  | { mode: 'restricted_section'; section: Exclude<PortfolioUiSection, 'financials'> }
  | { mode: 'my_portfolio' }
  | { mode: 'portfolio_feed' }
  | {
      mode: 'denied';
      reason: 'private_hotel_detail' | 'financials_forbidden' | 'section_disabled' | 'queue_unavailable';
    };

const RESTRICTED_SECTION_BY_PATH = new Map<string, Exclude<PortfolioUiSection, 'financials'>>([
  ['/dashboard', 'dashboard'],
  ['/housekeeping', 'housekeeping'],
  ['/communications', 'communications'],
  ['/maintenance', 'maintenance'],
  ['/inventory', 'inventory'],
  ['/staff', 'staff'],
]);

function canonicalPathname(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return null;
  }
  const withoutQuery = pathname.split(/[?#]/, 1)[0];
  if (withoutQuery.includes('\\') || withoutQuery.includes('..')) return null;
  return withoutQuery.length > 1 && withoutQuery.endsWith('/')
    ? withoutQuery.slice(0, -1)
    : withoutQuery;
}

/**
 * Decide which component family may mount after hotel authority is verified.
 * A portfolio drill-down never mounts hotel-local pages; even an allowed
 * destination maps to a separate restricted/read-only implementation.
 */
export function portfolioHotelSurfacePolicy(
  context: HotelActingContextV1,
  pathname: string,
): PortfolioHotelSurface {
  if (context.source === 'local') return { mode: 'local' };
  const path = canonicalPathname(pathname);
  if (!path) return { mode: 'denied', reason: 'private_hotel_detail' };

  if (path === '/home') return { mode: 'restricted_home' };
  if (path === '/company') return { mode: 'my_portfolio' };
  if (path === '/financials') {
    if (!context.sectionAvailability.financials) {
      return { mode: 'denied', reason: 'section_disabled' };
    }
    return context.standing.seesFinancials
      ? { mode: 'readonly_financials' }
      : { mode: 'denied', reason: 'financials_forbidden' };
  }
  if (path === '/feed') {
    if (!context.sectionAvailability.staxis) {
      return { mode: 'denied', reason: 'section_disabled' };
    }
    return context.portfolioFeatures.queueAvailable
      ? { mode: 'portfolio_feed' }
      : { mode: 'denied', reason: 'queue_unavailable' };
  }

  const section = RESTRICTED_SECTION_BY_PATH.get(path);
  if (section) {
    return context.sectionAvailability[section]
      ? { mode: 'restricted_section', section }
      : { mode: 'denied', reason: 'section_disabled' };
  }
  return { mode: 'denied', reason: 'private_hotel_detail' };
}
