import {
  parsePortfolioUiContext,
  type PortfolioUiContext,
  type PortfolioUiContextParseErrorCode,
} from './context';
import type { HotelActingContextV1 } from './hotel-acting-contract';

export type HotelActingRequest =
  | {
      kind: 'local_app';
      requestKey: string;
    }
  | {
      kind: 'portfolio_scope';
      requestKey: string;
      context: Exclude<PortfolioUiContext, { scope: 'hotel' }> | null;
    }
  | {
      kind: 'hotel';
      requestKey: string;
      context: Extract<PortfolioUiContext, { scope: 'hotel' }>;
      endpoint: string;
      returnTo: string | null;
    }
  | {
      kind: 'invalid';
      requestKey: string;
      error: PortfolioUiContextParseErrorCode;
    };

function canonicalPathname(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return null;
  }
  const path = pathname.split(/[?#]/, 1)[0];
  if (path.includes('\\') || path.includes('..')) return null;
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function queryString(input: string | URLSearchParams): string {
  if (input instanceof URLSearchParams) return input.toString();
  const value = input.startsWith('?') ? input.slice(1) : input;
  return value.split('#', 1)[0];
}

function hotelEndpoint(context: Extract<PortfolioUiContext, { scope: 'hotel' }>): string {
  const params = new URLSearchParams({
    scope: 'hotel',
    propertyId: context.propertyId,
  });
  if (context.organizationId) params.set('organizationId', context.organizationId);
  if (context.portfolioId) params.set('portfolioId', context.portfolioId);
  if (context.descriptorId) params.set('descriptorId', context.descriptorId);
  return `/api/portfolio/v1/hotel-context?${params.toString()}`;
}

/**
 * Turn the current browser location into the smallest acting-context request.
 *
 * The endpoint receives only opaque selectors from the URL. In particular, a
 * selected-hotels origin never carries a client-supplied hotel set. The server
 * must freshly resolve the descriptor and mint the narrowed receipt.
 */
export function resolveHotelActingRequest(input: {
  pathname: string;
  search: string | URLSearchParams;
}): HotelActingRequest {
  const pathname = canonicalPathname(input.pathname);
  if (!pathname) {
    return { kind: 'invalid', requestKey: 'invalid:path', error: 'invalid_location' };
  }

  const rawQuery = queryString(input.search);
  const params = new URLSearchParams(rawQuery);
  const hasScope = params.has('scope');
  const portfolioRoute = pathname === '/portfolio' || pathname.startsWith('/portfolio/');

  // /portfolio owns its selected company through the authoritative bootstrap.
  // Its ordinary organizationId query is not a hotel acting-context request.
  if (!hasScope) {
    return portfolioRoute
      ? { kind: 'portfolio_scope', requestKey: `portfolio:${pathname}:${rawQuery}`, context: null }
      : { kind: 'local_app', requestKey: `local:${pathname}` };
  }

  const parsed = parsePortfolioUiContext(params);
  if (!parsed.ok) {
    return {
      kind: 'invalid',
      requestKey: `invalid:${pathname}:${rawQuery}`,
      error: parsed.error,
    };
  }

  if (parsed.value.context.scope !== 'hotel') {
    return {
      kind: 'portfolio_scope',
      requestKey: `portfolio:${pathname}:${rawQuery}`,
      context: parsed.value.context,
    };
  }

  const endpoint = hotelEndpoint(parsed.value.context);
  return {
    kind: 'hotel',
    // Include the destination path. A route transition clears the entire
    // hotel-sensitive subtree and reauthorizes before a new surface mounts.
    requestKey: `hotel:${pathname}:${endpoint}`,
    context: parsed.value.context,
    endpoint,
    returnTo: parsed.value.returnTo,
  };
}

/** A valid DTO must also be bound to the exact opaque selectors requested. */
export function hotelActingContextMatchesRequest(
  request: Extract<HotelActingRequest, { kind: 'hotel' }>,
  context: HotelActingContextV1,
): boolean {
  if (context.property.id !== request.context.propertyId) return false;
  const organizationId = request.context.organizationId;
  if (!organizationId) {
    return context.source === 'local'
      && context.organization === null
      && context.parentScope === null;
  }
  if (
    context.source !== 'portfolio'
    || context.organization?.id !== organizationId
    || context.parentScope === null
  ) return false;

  if (request.context.portfolioId) {
    return (context.parentScope.kind === 'portfolio' || context.parentScope.kind === 'region')
      && context.parentScope.id === request.context.portfolioId;
  }
  if (request.context.descriptorId) {
    return context.parentScope.kind === 'selected_hotels'
      && context.parentScope.id === request.context.descriptorId;
  }
  return context.parentScope.kind === 'company'
    && context.parentScope.id === organizationId;
}
