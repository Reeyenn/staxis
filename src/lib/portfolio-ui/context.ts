/**
 * Pure portfolio-context contract shared by entry, navigation, and chooser UIs.
 *
 * This module deliberately knows nothing about React, browser storage, auth
 * sessions, or API response shapes. Callers must hand it the context options
 * the server has already authorized. It then makes the ambiguous parts
 * deterministic: where to enter, what survives a refresh, and how a bounded
 * hotel chooser is labelled and ordered.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_PATH_ORIGIN = 'https://staxis-app.invalid';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Maximum rows rendered on one page, not a cap on an authorized portfolio. */
export const MAX_PORTFOLIO_HOTEL_CARDS = 50;

export interface AuthorizedPortfolioOption {
  scope: 'portfolio';
  /** The company/organization whose whole portfolio this option represents. */
  organizationId: string;
  /** Present for a receipt-backed named portfolio; absent for all authorized hotels. */
  portfolioId?: string;
  companyName: string;
  portfolioName?: string;
  region?: string | null;
}

export interface AuthorizedRegionOption {
  scope: 'region';
  /** Company that owns the authoritative portfolio/region descriptor. */
  organizationId: string;
  /** Stable descriptor id from the authoritative access receipt. */
  portfolioId: string;
  companyName: string;
  regionName: string;
}

export interface AuthorizedHotelOption {
  scope: 'hotel';
  /** A direct property/hotel scope, independent of any portfolio option. */
  propertyId: string;
  hotelName: string;
  city?: string | null;
  region?: string | null;
}

export interface AuthorizedSelectedHotelsOption {
  scope: 'selected_hotels';
  organizationId: string;
  /** Opaque authoritative descriptor id. Hotel ids are deliberately not URL state. */
  descriptorId: string;
  companyName: string;
  descriptorName: string;
}

export type AuthorizedPortfolioUiOption =
  | AuthorizedPortfolioOption
  | AuthorizedRegionOption
  | AuthorizedSelectedHotelsOption
  | AuthorizedHotelOption;

export type PortfolioUiEntryDecision =
  | { kind: 'portfolio'; option: AuthorizedPortfolioOption }
  | { kind: 'region'; option: AuthorizedRegionOption }
  | { kind: 'selected_hotels'; option: AuthorizedSelectedHotelsOption }
  | { kind: 'hotel'; option: AuthorizedHotelOption }
  | {
      kind: 'chooser';
      chooser: 'context' | 'hotel';
      options: readonly AuthorizedPortfolioUiOption[];
    }
  | { kind: 'unavailable' };

export type PortfolioUiContext =
  | { scope: 'portfolio'; organizationId: string; portfolioId?: string }
  | { scope: 'region'; organizationId: string; portfolioId: string }
  | { scope: 'selected_hotels'; organizationId: string; descriptorId: string }
  | {
      scope: 'hotel';
      propertyId: string;
      /** Present when the hotel was opened from an explicit company context. */
      organizationId?: string;
      /** Exactly one parent selector may preserve a narrowed portfolio origin. */
      portfolioId?: string;
      descriptorId?: string;
    };

export const PORTFOLIO_UI_ROUTE_PATHS = {
  home: '/home',
  feed: '/feed',
  dashboard: '/dashboard',
  housekeeping: '/housekeeping',
  communications: '/communications',
  maintenance: '/maintenance',
  inventory: '/inventory',
  staff: '/staff',
  financials: '/financials',
  company: '/company',
} as const;

export type PortfolioUiRoute = keyof typeof PORTFOLIO_UI_ROUTE_PATHS;

export const PORTFOLIO_UI_QUERY_KEYS = {
  scope: 'scope',
  organizationId: 'organizationId',
  portfolioId: 'portfolioId',
  descriptorId: 'descriptorId',
  propertyId: 'propertyId',
  returnTo: 'returnTo',
} as const;

const RESERVED_QUERY_KEYS = new Set<string>(Object.values(PORTFOLIO_UI_QUERY_KEYS));

export type PortfolioUiContextParseErrorCode =
  | 'invalid_location'
  | 'duplicate_reserved_key'
  | 'missing_scope'
  | 'invalid_scope'
  | 'missing_organization_id'
  | 'invalid_organization_id'
  | 'unexpected_organization_id'
  | 'missing_portfolio_id'
  | 'invalid_portfolio_id'
  | 'unexpected_portfolio_id'
  | 'missing_descriptor_id'
  | 'invalid_descriptor_id'
  | 'unexpected_descriptor_id'
  | 'missing_property_id'
  | 'invalid_property_id'
  | 'unexpected_property_id'
  | 'invalid_return_to';

export interface ParsedPortfolioUiContext {
  context: PortfolioUiContext;
  returnTo: string | null;
  /** Query entries the context contract does not own, including duplicates. */
  filters: ReadonlyArray<readonly [string, string]>;
}

export type PortfolioUiContextParseResult =
  | { ok: true; value: ParsedPortfolioUiContext }
  | {
      ok: false;
      error: PortfolioUiContextParseErrorCode;
      key?: string;
    };

export interface PortfolioUiUrlOptions {
  /** Existing app URL, query string, or params whose unrelated filters survive. */
  existing?: string | URLSearchParams;
  /** Omit/null to remove a stale return target. */
  returnTo?: string | null;
}

export type PortfolioHotelStatus = 'active' | 'pending' | 'inactive' | 'suspended';
export type PortfolioHotelStatusFilter = 'all' | 'not_active' | PortfolioHotelStatus;
export type PortfolioHotelSort =
  | 'name_asc'
  | 'name_desc'
  | 'region_asc'
  | 'region_desc'
  | 'status_asc'
  | 'status_desc';

export interface PortfolioHotelLabelSource {
  propertyId: string;
  name: string;
  city?: string | null;
  region?: string | null;
  brand?: string | null;
}

export interface PortfolioHotelCard extends PortfolioHotelLabelSource {
  status: PortfolioHotelStatus;
}

export interface PortfolioHotelFilter {
  search?: string;
  status?: PortfolioHotelStatusFilter;
  /** Null/empty/undefined means every region. */
  region?: string | null;
}

export interface PortfolioHotelQuery extends PortfolioHotelFilter {
  sort?: PortfolioHotelSort;
  page?: number;
  pageSize?: number;
}

export interface PortfolioHotelPage {
  items: readonly PortfolioHotelCard[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

export function isPortfolioUiUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requiredLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeAuthorizedOption(option: AuthorizedPortfolioUiOption): AuthorizedPortfolioUiOption {
  if (!option || typeof option !== 'object') {
    throw new TypeError('authorized context option must be an object');
  }

  if (option.scope === 'portfolio') {
    if (!isPortfolioUiUuid(option.organizationId)) {
      throw new TypeError('portfolio organizationId must be a valid UUID');
    }
    if (option.portfolioId != null && !isPortfolioUiUuid(option.portfolioId)) {
      throw new TypeError('portfolio portfolioId must be a valid UUID when provided');
    }
    return {
      ...option,
      organizationId: canonicalUuid(option.organizationId),
      ...(option.portfolioId ? { portfolioId: canonicalUuid(option.portfolioId) } : {}),
      companyName: requiredLabel(option.companyName, 'companyName'),
      ...(option.portfolioId
        ? { portfolioName: requiredLabel(option.portfolioName, 'portfolioName') }
        : {}),
    };
  }

  if (option.scope === 'region') {
    if (!isPortfolioUiUuid(option.organizationId)) {
      throw new TypeError('region organizationId must be a valid UUID');
    }
    if (!isPortfolioUiUuid(option.portfolioId)) {
      throw new TypeError('region portfolioId must be a valid UUID');
    }
    return {
      ...option,
      organizationId: canonicalUuid(option.organizationId),
      portfolioId: canonicalUuid(option.portfolioId),
      companyName: requiredLabel(option.companyName, 'companyName'),
      regionName: requiredLabel(option.regionName, 'regionName'),
    };
  }

  if (option.scope === 'hotel') {
    if (!isPortfolioUiUuid(option.propertyId)) {
      throw new TypeError('hotel propertyId must be a valid UUID');
    }
    return {
      ...option,
      propertyId: canonicalUuid(option.propertyId),
      hotelName: requiredLabel(option.hotelName, 'hotelName'),
    };
  }

  if (option.scope === 'selected_hotels') {
    if (!isPortfolioUiUuid(option.organizationId)) {
      throw new TypeError('selected-hotels organizationId must be a valid UUID');
    }
    if (!isPortfolioUiUuid(option.descriptorId)) {
      throw new TypeError('selected-hotels descriptorId must be a valid UUID');
    }
    return {
      ...option,
      organizationId: canonicalUuid(option.organizationId),
      descriptorId: canonicalUuid(option.descriptorId),
      companyName: requiredLabel(option.companyName, 'companyName'),
      descriptorName: requiredLabel(option.descriptorName, 'descriptorName'),
    };
  }

  throw new TypeError('authorized context option has an unknown scope');
}

/**
 * Decide the first screen from distinct, already-authorized scope options.
 * Duplicate grants for the same scope/id collapse before the decision.
 */
export function decidePortfolioUiEntry(
  options: readonly AuthorizedPortfolioUiOption[],
): PortfolioUiEntryDecision {
  const distinct: AuthorizedPortfolioUiOption[] = [];
  const seen = new Set<string>();

  for (const raw of options) {
    const option = normalizeAuthorizedOption(raw);
    const id = option.scope === 'portfolio'
      ? `${option.organizationId}:${option.portfolioId ?? 'all'}`
      : option.scope === 'region'
        ? `${option.organizationId}:${option.portfolioId}`
        : option.scope === 'selected_hotels'
          ? `${option.organizationId}:${option.descriptorId}`
        : option.propertyId;
    const key = `${option.scope}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(option);
  }

  if (distinct.length === 0) return { kind: 'unavailable' };

  const portfolios = distinct.filter(
    (option): option is AuthorizedPortfolioOption => option.scope === 'portfolio',
  );
  const regions = distinct.filter(
    (option): option is AuthorizedRegionOption => option.scope === 'region',
  );
  const hotels = distinct.filter(
    (option): option is AuthorizedHotelOption => option.scope === 'hotel',
  );
  const selectedHotelScopes = distinct.filter(
    (option): option is AuthorizedSelectedHotelsOption => option.scope === 'selected_hotels',
  );

  if (portfolios.length === 1 && hotels.length === 0 && selectedHotelScopes.length === 0) {
    if (regions.length > 0) {
      return { kind: 'chooser', chooser: 'context', options: distinct };
    }
    return { kind: 'portfolio', option: portfolios[0] };
  }

  if (portfolios.length > 0
      || regions.length > 1
      || selectedHotelScopes.length > 1
      || (regions.length > 0 && hotels.length > 0)
      || (selectedHotelScopes.length > 0 && distinct.length > 1)) {
    return { kind: 'chooser', chooser: 'context', options: distinct };
  }

  if (regions.length === 1) return { kind: 'region', option: regions[0] };

  if (selectedHotelScopes.length === 1) {
    return { kind: 'selected_hotels', option: selectedHotelScopes[0] };
  }

  if (hotels.length === 1) return { kind: 'hotel', option: hotels[0] };
  return { kind: 'chooser', chooser: 'hotel', options: hotels };
}

export function contextForAuthorizedOption(option: AuthorizedPortfolioUiOption): PortfolioUiContext {
  const normalized = normalizeAuthorizedOption(option);
  return normalized.scope === 'portfolio'
    ? {
        scope: 'portfolio',
        organizationId: normalized.organizationId,
        ...(normalized.portfolioId ? { portfolioId: normalized.portfolioId } : {}),
      }
    : normalized.scope === 'region'
      ? {
          scope: 'region',
          organizationId: normalized.organizationId,
          portfolioId: normalized.portfolioId,
        }
    : normalized.scope === 'selected_hotels'
      ? {
          scope: 'selected_hotels',
          organizationId: normalized.organizationId,
          descriptorId: normalized.descriptorId,
        }
      : { scope: 'hotel', propertyId: normalized.propertyId };
}

/**
 * Accept a rooted app path only. Absolute, protocol-relative, backslash,
 * control-character, malformed-percent, and encoded open-redirect shapes fail.
 */
export function normalizeSameOriginAppPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null;
  if (value !== value.trim()) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || CONTROL_CHARACTER_PATTERN.test(value)) return null;

  try {
    const parsed = new URL(value, APP_PATH_ORIGIN);
    if (parsed.origin !== APP_PATH_ORIGIN) return null;

    const decodedPath = decodeURIComponent(parsed.pathname);
    if (
      decodedPath.startsWith('//')
      || decodedPath.includes('\\')
      || CONTROL_CHARACTER_PATTERN.test(decodedPath)
    ) {
      return null;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

interface ParsedLocationInput {
  params: URLSearchParams;
  hash: string;
}

function parseLocationInput(input: string | URLSearchParams): ParsedLocationInput | null {
  if (input instanceof URLSearchParams) {
    return { params: new URLSearchParams(input), hash: '' };
  }
  if (typeof input !== 'string') return null;
  if (input === '') return { params: new URLSearchParams(), hash: '' };

  if (input.startsWith('/')) {
    const normalized = normalizeSameOriginAppPath(input);
    if (!normalized) return null;
    const parsed = new URL(normalized, APP_PATH_ORIGIN);
    return { params: new URLSearchParams(parsed.search), hash: parsed.hash };
  }

  if (
    input.startsWith('//')
    || input.includes('\\')
    || CONTROL_CHARACTER_PATTERN.test(input)
    || /^[a-z][a-z0-9+.-]*:/i.test(input)
  ) {
    return null;
  }

  const raw = input.startsWith('?') ? input.slice(1) : input;
  if (raw !== '' && !raw.includes('=') && !raw.includes('&')) return null;
  const hashIndex = raw.indexOf('#');
  const query = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  return { params: new URLSearchParams(query), hash };
}

function parseFailure(
  error: PortfolioUiContextParseErrorCode,
  key?: string,
): PortfolioUiContextParseResult {
  return key ? { ok: false, error, key } : { ok: false, error };
}

export function parsePortfolioUiContext(
  input: string | URLSearchParams,
): PortfolioUiContextParseResult {
  const location = parseLocationInput(input);
  if (!location) return parseFailure('invalid_location');
  const { params } = location;

  for (const key of RESERVED_QUERY_KEYS) {
    if (params.getAll(key).length > 1) {
      return parseFailure('duplicate_reserved_key', key);
    }
  }

  const scope = params.get(PORTFOLIO_UI_QUERY_KEYS.scope);
  if (scope == null || scope === '') return parseFailure('missing_scope', 'scope');
  if (scope !== 'portfolio' && scope !== 'region' && scope !== 'selected_hotels' && scope !== 'hotel') {
    return parseFailure('invalid_scope', 'scope');
  }

  const organizationId = params.get(PORTFOLIO_UI_QUERY_KEYS.organizationId);
  const portfolioId = params.get(PORTFOLIO_UI_QUERY_KEYS.portfolioId);
  const descriptorId = params.get(PORTFOLIO_UI_QUERY_KEYS.descriptorId);
  const propertyId = params.get(PORTFOLIO_UI_QUERY_KEYS.propertyId);
  let context: PortfolioUiContext;

  if (scope === 'portfolio') {
    if (organizationId == null || organizationId === '') {
      return parseFailure('missing_organization_id', 'organizationId');
    }
    if (!isPortfolioUiUuid(organizationId)) {
      return parseFailure('invalid_organization_id', 'organizationId');
    }
    if (portfolioId != null && !isPortfolioUiUuid(portfolioId)) {
      return parseFailure('invalid_portfolio_id', 'portfolioId');
    }
    if (descriptorId != null) return parseFailure('unexpected_descriptor_id', 'descriptorId');
    if (propertyId != null) return parseFailure('unexpected_property_id', 'propertyId');
    context = {
      scope,
      organizationId: canonicalUuid(organizationId),
      ...(portfolioId ? { portfolioId: canonicalUuid(portfolioId) } : {}),
    };
  } else if (scope === 'region') {
    if (organizationId == null || organizationId === '') {
      return parseFailure('missing_organization_id', 'organizationId');
    }
    if (!isPortfolioUiUuid(organizationId)) {
      return parseFailure('invalid_organization_id', 'organizationId');
    }
    if (portfolioId == null || portfolioId === '') {
      return parseFailure('missing_portfolio_id', 'portfolioId');
    }
    if (!isPortfolioUiUuid(portfolioId)) {
      return parseFailure('invalid_portfolio_id', 'portfolioId');
    }
    if (descriptorId != null) return parseFailure('unexpected_descriptor_id', 'descriptorId');
    if (propertyId != null) return parseFailure('unexpected_property_id', 'propertyId');
    context = {
      scope,
      organizationId: canonicalUuid(organizationId),
      portfolioId: canonicalUuid(portfolioId),
    };
  } else if (scope === 'selected_hotels') {
    if (organizationId == null || organizationId === '') {
      return parseFailure('missing_organization_id', 'organizationId');
    }
    if (!isPortfolioUiUuid(organizationId)) {
      return parseFailure('invalid_organization_id', 'organizationId');
    }
    if (descriptorId == null || descriptorId === '') {
      return parseFailure('missing_descriptor_id', 'descriptorId');
    }
    if (!isPortfolioUiUuid(descriptorId)) {
      return parseFailure('invalid_descriptor_id', 'descriptorId');
    }
    if (portfolioId != null) return parseFailure('unexpected_portfolio_id', 'portfolioId');
    if (propertyId != null) return parseFailure('unexpected_property_id', 'propertyId');
    context = {
      scope,
      organizationId: canonicalUuid(organizationId),
      descriptorId: canonicalUuid(descriptorId),
    };
  } else {
    if (propertyId == null || propertyId === '') {
      return parseFailure('missing_property_id', 'propertyId');
    }
    if (!isPortfolioUiUuid(propertyId)) {
      return parseFailure('invalid_property_id', 'propertyId');
    }
    if (organizationId != null && !isPortfolioUiUuid(organizationId)) {
      return parseFailure('invalid_organization_id', 'organizationId');
    }
    if (portfolioId != null && !isPortfolioUiUuid(portfolioId)) {
      return parseFailure('invalid_portfolio_id', 'portfolioId');
    }
    if (descriptorId != null && !isPortfolioUiUuid(descriptorId)) {
      return parseFailure('invalid_descriptor_id', 'descriptorId');
    }
    if (portfolioId != null && descriptorId != null) {
      return parseFailure('unexpected_descriptor_id', 'descriptorId');
    }
    if ((portfolioId != null || descriptorId != null) && !organizationId) {
      return parseFailure('missing_organization_id', 'organizationId');
    }
    context = {
      scope,
      propertyId: canonicalUuid(propertyId),
      ...(organizationId ? { organizationId: canonicalUuid(organizationId) } : {}),
      ...(portfolioId ? { portfolioId: canonicalUuid(portfolioId) } : {}),
      ...(descriptorId ? { descriptorId: canonicalUuid(descriptorId) } : {}),
    };
  }

  const rawReturnTo = params.get(PORTFOLIO_UI_QUERY_KEYS.returnTo);
  const returnTo = rawReturnTo == null ? null : normalizeSameOriginAppPath(rawReturnTo);
  if (rawReturnTo != null && returnTo == null) {
    return parseFailure('invalid_return_to', 'returnTo');
  }

  const filters: Array<readonly [string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (!RESERVED_QUERY_KEYS.has(key)) filters.push([key, value] as const);
  }

  return { ok: true, value: { context, returnTo, filters } };
}

function normalizeContext(context: PortfolioUiContext): PortfolioUiContext {
  if (!context || typeof context !== 'object') {
    throw new TypeError('portfolio UI context must be an object');
  }
  if (context.scope === 'portfolio') {
    if (!isPortfolioUiUuid(context.organizationId)) {
      throw new TypeError('portfolio organizationId must be a valid UUID');
    }
    if (context.portfolioId != null && !isPortfolioUiUuid(context.portfolioId)) {
      throw new TypeError('portfolio portfolioId must be a valid UUID when provided');
    }
    return {
      scope: 'portfolio',
      organizationId: canonicalUuid(context.organizationId),
      ...(context.portfolioId ? { portfolioId: canonicalUuid(context.portfolioId) } : {}),
    };
  }
  if (context.scope === 'region') {
    if (!isPortfolioUiUuid(context.organizationId)) {
      throw new TypeError('region organizationId must be a valid UUID');
    }
    if (!isPortfolioUiUuid(context.portfolioId)) {
      throw new TypeError('region portfolioId must be a valid UUID');
    }
    return {
      scope: 'region',
      organizationId: canonicalUuid(context.organizationId),
      portfolioId: canonicalUuid(context.portfolioId),
    };
  }
  if (context.scope === 'hotel') {
    if (!isPortfolioUiUuid(context.propertyId)) {
      throw new TypeError('hotel propertyId must be a valid UUID');
    }
    if (context.organizationId != null && !isPortfolioUiUuid(context.organizationId)) {
      throw new TypeError('hotel organizationId must be a valid UUID when provided');
    }
    if (context.portfolioId != null && !isPortfolioUiUuid(context.portfolioId)) {
      throw new TypeError('hotel portfolioId must be a valid UUID when provided');
    }
    if (context.descriptorId != null && !isPortfolioUiUuid(context.descriptorId)) {
      throw new TypeError('hotel descriptorId must be a valid UUID when provided');
    }
    if (context.portfolioId != null && context.descriptorId != null) {
      throw new TypeError('hotel context may carry only one parent selector');
    }
    if ((context.portfolioId != null || context.descriptorId != null)
        && context.organizationId == null) {
      throw new TypeError('hotel parent selector requires organizationId');
    }
    return {
      scope: 'hotel',
      propertyId: canonicalUuid(context.propertyId),
      ...(context.organizationId
        ? { organizationId: canonicalUuid(context.organizationId) }
        : {}),
      ...(context.portfolioId ? { portfolioId: canonicalUuid(context.portfolioId) } : {}),
      ...(context.descriptorId ? { descriptorId: canonicalUuid(context.descriptorId) } : {}),
    };
  }
  if (context.scope === 'selected_hotels') {
    if (!isPortfolioUiUuid(context.organizationId)) {
      throw new TypeError('selected-hotels organizationId must be a valid UUID');
    }
    if (!isPortfolioUiUuid(context.descriptorId)) {
      throw new TypeError('selected-hotels descriptorId must be a valid UUID');
    }
    return {
      scope: 'selected_hotels',
      organizationId: canonicalUuid(context.organizationId),
      descriptorId: canonicalUuid(context.descriptorId),
    };
  }
  throw new TypeError('portfolio UI context has an unknown scope');
}

/** Build a refresh-safe app URL and replace only context-owned query keys. */
export function buildPortfolioUiUrl(
  targetPath: string,
  context: PortfolioUiContext,
  options: PortfolioUiUrlOptions = {},
): string {
  const normalizedTarget = normalizeSameOriginAppPath(targetPath);
  if (!normalizedTarget) throw new TypeError('targetPath must be a same-origin app path');
  const target = new URL(normalizedTarget, APP_PATH_ORIGIN);
  if (target.search || target.hash) {
    throw new TypeError('targetPath must not contain query parameters or a fragment');
  }

  const existing = parseLocationInput(options.existing ?? '');
  if (!existing) throw new TypeError('existing location must be an app URL or query string');
  const params = existing.params;
  for (const key of RESERVED_QUERY_KEYS) params.delete(key);

  const normalizedContext = normalizeContext(context);
  params.set(PORTFOLIO_UI_QUERY_KEYS.scope, normalizedContext.scope);
  if (normalizedContext.scope === 'portfolio') {
    params.set(PORTFOLIO_UI_QUERY_KEYS.organizationId, normalizedContext.organizationId);
    if (normalizedContext.portfolioId) {
      params.set(PORTFOLIO_UI_QUERY_KEYS.portfolioId, normalizedContext.portfolioId);
    }
  } else if (normalizedContext.scope === 'region') {
    params.set(PORTFOLIO_UI_QUERY_KEYS.organizationId, normalizedContext.organizationId);
    params.set(PORTFOLIO_UI_QUERY_KEYS.portfolioId, normalizedContext.portfolioId);
  } else if (normalizedContext.scope === 'selected_hotels') {
    params.set(PORTFOLIO_UI_QUERY_KEYS.organizationId, normalizedContext.organizationId);
    params.set(PORTFOLIO_UI_QUERY_KEYS.descriptorId, normalizedContext.descriptorId);
  } else {
    params.set(PORTFOLIO_UI_QUERY_KEYS.propertyId, normalizedContext.propertyId);
    if (normalizedContext.organizationId) {
      params.set(PORTFOLIO_UI_QUERY_KEYS.organizationId, normalizedContext.organizationId);
    }
    if (normalizedContext.portfolioId) {
      params.set(PORTFOLIO_UI_QUERY_KEYS.portfolioId, normalizedContext.portfolioId);
    }
    if (normalizedContext.descriptorId) {
      params.set(PORTFOLIO_UI_QUERY_KEYS.descriptorId, normalizedContext.descriptorId);
    }
  }

  if (options.returnTo != null) {
    const returnTo = normalizeSameOriginAppPath(options.returnTo);
    if (!returnTo) throw new TypeError('returnTo must be a same-origin app path');
    params.set(PORTFOLIO_UI_QUERY_KEYS.returnTo, returnTo);
  }

  const query = params.toString();
  return `${target.pathname}${query ? `?${query}` : ''}${existing.hash}`;
}

/** Map one of the supported navigation destinations without losing filters. */
export function mapPortfolioUiRoute(
  route: PortfolioUiRoute,
  context: PortfolioUiContext,
  options: PortfolioUiUrlOptions = {},
): string {
  if (!Object.prototype.hasOwnProperty.call(PORTFOLIO_UI_ROUTE_PATHS, route)) {
    throw new TypeError('unknown portfolio UI route');
  }
  return buildPortfolioUiUrl(PORTFOLIO_UI_ROUTE_PATHS[route], context, options);
}

const HOTEL_STATUSES = new Set<PortfolioHotelStatus>([
  'active',
  'pending',
  'inactive',
  'suspended',
]);
const HOTEL_STATUS_FILTERS = new Set<PortfolioHotelStatusFilter>([
  'all',
  'not_active',
  ...HOTEL_STATUSES,
]);
const HOTEL_SORTS = new Set<PortfolioHotelSort>([
  'name_asc',
  'name_desc',
  'region_asc',
  'region_desc',
  'status_asc',
  'status_desc',
]);
const STATUS_RANK: Record<PortfolioHotelStatus, number> = {
  active: 0,
  pending: 1,
  inactive: 2,
  suspended: 3,
};

function normalizedText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function optionalText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compareText(left: string, right: string): number {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertHotelLabelSources(cards: readonly PortfolioHotelLabelSource[]): void {
  if (!Array.isArray(cards)) throw new TypeError('hotel cards must be an array');

  const ids = new Set<string>();
  for (const card of cards) {
    if (!card || typeof card !== 'object') throw new TypeError('hotel card must be an object');
    if (!isPortfolioUiUuid(card.propertyId)) {
      throw new TypeError('hotel card propertyId must be a valid UUID');
    }
    const id = canonicalUuid(card.propertyId);
    if (ids.has(id)) throw new TypeError('hotel cards must have distinct propertyIds');
    ids.add(id);
    requiredLabel(card.name, 'hotel card name');
  }
}

function assertHotelCards(cards: readonly PortfolioHotelCard[]): void {
  assertHotelLabelSources(cards);
  for (const card of cards) {
    if (!HOTEL_STATUSES.has(card.status)) throw new TypeError('hotel card has an unknown status');
  }
}

function cardLocation(card: PortfolioHotelLabelSource): string {
  const city = optionalText(card.city);
  const region = optionalText(card.region);
  if (city && region && normalizedText(city) !== normalizedText(region)) return `${city}, ${region}`;
  return city || region;
}

function cardHint(card: PortfolioHotelLabelSource): string {
  return cardLocation(card) || optionalText(card.brand);
}

function uniqueShortId(
  card: PortfolioHotelLabelSource,
  group: readonly PortfolioHotelLabelSource[],
): string {
  const compact = canonicalUuid(card.propertyId).replace(/-/g, '');
  const groupIds = group.map((item) => canonicalUuid(item.propertyId).replace(/-/g, ''));
  for (let length = 8; length < compact.length; length += 4) {
    const prefix = compact.slice(0, length);
    if (groupIds.filter((id) => id.startsWith(prefix)).length === 1) return prefix.toUpperCase();
  }
  return compact.toUpperCase();
}

/** Labels remain unique even when names and location hints are identical. */
export function buildPortfolioHotelLabels(
  cards: readonly PortfolioHotelLabelSource[],
): Readonly<Record<string, string>> {
  assertHotelLabelSources(cards);
  const byName = new Map<string, PortfolioHotelLabelSource[]>();
  for (const card of cards) {
    const key = normalizedText(card.name);
    const group = byName.get(key) ?? [];
    group.push(card);
    byName.set(key, group);
  }

  const labels: Record<string, string> = {};
  for (const card of cards) {
    const name = card.name.trim();
    const group = byName.get(normalizedText(card.name)) ?? [card];
    if (group.length === 1) {
      labels[canonicalUuid(card.propertyId)] = name;
      continue;
    }

    const hint = cardHint(card);
    const hintKey = normalizedText(hint);
    const hintIsUnique = hint.length > 0 && group.filter(
      (candidate) => normalizedText(cardHint(candidate)) === hintKey,
    ).length === 1;
    const suffix = hintIsUnique
      ? hint
      : [hint, uniqueShortId(card, group)].filter(Boolean).join(' · ');
    labels[canonicalUuid(card.propertyId)] = `${name} — ${suffix}`;
  }
  return labels;
}

/**
 * Secondary attribution for cards, rows, and chooser options. The same-name,
 * same-hint case always carries a stable short id; a missing hint uses the id
 * directly. Consumers keep the hotel name in their primary label.
 */
export function buildPortfolioHotelSecondaryLabels(
  cards: readonly PortfolioHotelLabelSource[],
): Readonly<Record<string, string>> {
  assertHotelLabelSources(cards);
  const byName = new Map<string, PortfolioHotelLabelSource[]>();
  for (const card of cards) {
    const key = normalizedText(card.name);
    const group = byName.get(key) ?? [];
    group.push(card);
    byName.set(key, group);
  }

  const labels: Record<string, string> = {};
  for (const card of cards) {
    const group = byName.get(normalizedText(card.name)) ?? [card];
    const hint = cardHint(card);
    const shortId = uniqueShortId(card, group);
    if (!hint) {
      labels[canonicalUuid(card.propertyId)] = `Hotel ${shortId}`;
      continue;
    }
    const sameHint = group.length > 1 && group.filter(
      (candidate) => normalizedText(cardHint(candidate)) === normalizedText(hint),
    ).length > 1;
    labels[canonicalUuid(card.propertyId)] = sameHint ? `${hint} · ${shortId}` : hint;
  }
  return labels;
}

export function listPortfolioHotelRegions(cards: readonly PortfolioHotelCard[]): readonly string[] {
  assertHotelCards(cards);
  const regions = new Map<string, string>();
  for (const card of cards) {
    const region = optionalText(card.region);
    if (region) regions.set(normalizedText(region), regions.get(normalizedText(region)) ?? region);
  }
  return [...regions.values()].sort(compareText);
}

export function filterPortfolioHotelCards(
  cards: readonly PortfolioHotelCard[],
  filter: PortfolioHotelFilter = {},
): readonly PortfolioHotelCard[] {
  assertHotelCards(cards);
  const status = filter.status ?? 'all';
  if (!HOTEL_STATUS_FILTERS.has(status)) throw new TypeError('unknown hotel status filter');

  const queryTokens = normalizedText(filter.search ?? '').split(' ').filter(Boolean);
  const selectedRegion = normalizedText(filter.region ?? '');
  const labels = buildPortfolioHotelLabels(cards);

  return cards.filter((card) => {
    const statusMatches = status === 'all'
      || (status === 'not_active' ? card.status !== 'active' : card.status === status);
    if (!statusMatches) return false;
    if (selectedRegion && normalizedText(card.region ?? '') !== selectedRegion) return false;
    if (queryTokens.length === 0) return true;

    const id = canonicalUuid(card.propertyId);
    const haystack = normalizedText([
      card.name,
      card.city ?? '',
      card.region ?? '',
      labels[id] ?? '',
      id,
    ].join(' '));
    return queryTokens.every((token) => haystack.includes(token));
  });
}

function compareOptionalText(left: string, right: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (a < b) return -1;
  if (a > b) return 1;
  // Region spelling/case variants are one bucket; the stable name/id
  // tie-breakers below decide their order in either direction.
  return 0;
}

export function sortPortfolioHotelCards(
  cards: readonly PortfolioHotelCard[],
  sort: PortfolioHotelSort = 'name_asc',
): readonly PortfolioHotelCard[] {
  assertHotelCards(cards);
  if (!HOTEL_SORTS.has(sort)) throw new TypeError('unknown hotel sort');
  const labels = buildPortfolioHotelLabels(cards);
  const direction = sort.endsWith('_desc') ? -1 : 1;

  return [...cards].sort((left, right) => {
    let comparison = 0;
    if (sort.startsWith('region_')) {
      comparison = compareOptionalText(optionalText(left.region), optionalText(right.region));
      // Missing regions stay last in both directions.
      if (!optionalText(left.region) || !optionalText(right.region)) {
        if (comparison !== 0) return comparison;
      } else {
        comparison *= direction;
      }
    } else if (sort.startsWith('status_')) {
      comparison = (STATUS_RANK[left.status] - STATUS_RANK[right.status]) * direction;
    } else {
      comparison = compareText(
        labels[canonicalUuid(left.propertyId)] ?? left.name,
        labels[canonicalUuid(right.propertyId)] ?? right.name,
      ) * direction;
    }

    if (comparison !== 0) return comparison;
    const nameComparison = compareText(left.name, right.name);
    if (nameComparison !== 0) return nameComparison;
    return canonicalUuid(left.propertyId).localeCompare(canonicalUuid(right.propertyId));
  });
}

export function paginatePortfolioHotelCards(
  cards: readonly PortfolioHotelCard[],
  page = 1,
  pageSize = 12,
): PortfolioHotelPage {
  assertHotelCards(cards);
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PORTFOLIO_HOTEL_CARDS) {
    throw new RangeError(`pageSize must be an integer from 1 to ${MAX_PORTFOLIO_HOTEL_CARDS}`);
  }

  const totalItems = cards.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const resolvedPage = Math.min(page, totalPages);
  const start = (resolvedPage - 1) * pageSize;
  return {
    items: cards.slice(start, start + pageSize),
    page: resolvedPage,
    pageSize,
    totalItems,
    totalPages,
    hasPreviousPage: resolvedPage > 1,
    hasNextPage: resolvedPage < totalPages,
  };
}

export function queryPortfolioHotelCards(
  cards: readonly PortfolioHotelCard[],
  query: PortfolioHotelQuery = {},
): PortfolioHotelPage {
  const filtered = filterPortfolioHotelCards(cards, query);
  const sorted = sortPortfolioHotelCards(filtered, query.sort ?? 'name_asc');
  return paginatePortfolioHotelCards(sorted, query.page ?? 1, query.pageSize ?? 12);
}
