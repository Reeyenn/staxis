import {
  isPortfolioUiUuid,
  type PortfolioUiContext,
} from './context';

export type PortfolioUiScopeDescriptorKind =
  | 'company'
  | 'region'
  | 'portfolio'
  | 'selected_hotels';

export interface PortfolioUiScopeDescriptorInput {
  kind: PortfolioUiScopeDescriptorKind;
  id: string;
  name: string;
  propertyIds: readonly string[];
}

export interface PortfolioUiAuthoritativeScopeInput {
  organizationId: string;
  organizationName: string | null;
  propertyIds: readonly string[];
  descriptors: readonly PortfolioUiScopeDescriptorInput[];
}

export type PortfolioUiScopeSelector =
  | { type: 'all_authorized' }
  | { type: 'portfolio'; portfolioId: string }
  | { type: 'property_subset'; propertyIds: string[] };

export interface ResolvedPortfolioUiScope {
  organizationId: string;
  organizationName: string | null;
  kind: PortfolioUiScopeDescriptorKind;
  id: string;
  name: string;
  propertyIds: string[];
  selector: PortfolioUiScopeSelector;
  /** Present only while verifying a hotel opened from this parent scope. */
  requestedHotelId: string | null;
}

export type PortfolioUiScopeSelectionError =
  | 'invalid_authoritative_scope'
  | 'organization_mismatch'
  | 'descriptor_not_found'
  | 'descriptor_ambiguous'
  | 'hotel_not_in_scope';

export type PortfolioUiScopeSelectionResult =
  | { ok: true; scope: ResolvedPortfolioUiScope }
  | { ok: false; reason: PortfolioUiScopeSelectionError };

function canonicalDistinctIds(values: readonly string[]): string[] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isPortfolioUiUuid(value)) return null;
    const id = value.toLowerCase();
    if (seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids.sort();
}

interface ValidatedScope {
  organizationId: string;
  organizationName: string | null;
  propertyIds: string[];
  descriptors: Array<PortfolioUiScopeDescriptorInput & { propertyIds: string[] }>;
}

function validateAuthoritativeScope(
  input: PortfolioUiAuthoritativeScopeInput,
): ValidatedScope | null {
  if (!input || !isPortfolioUiUuid(input.organizationId)) return null;
  if (input.organizationName !== null
      && (typeof input.organizationName !== 'string' || input.organizationName.trim() === '')) {
    return null;
  }
  const propertyIds = canonicalDistinctIds(input.propertyIds);
  if (!propertyIds || !Array.isArray(input.descriptors)) return null;
  const authorized = new Set(propertyIds);
  const descriptors: ValidatedScope['descriptors'] = [];
  const descriptorKeys = new Set<string>();
  for (const descriptor of input.descriptors) {
    if (!descriptor
        || !['company', 'region', 'portfolio', 'selected_hotels'].includes(descriptor.kind)
        || !isPortfolioUiUuid(descriptor.id)
        || typeof descriptor.name !== 'string'
        || descriptor.name.trim() === '') {
      return null;
    }
    const descriptorPropertyIds = canonicalDistinctIds(descriptor.propertyIds);
    if (!descriptorPropertyIds
        || descriptorPropertyIds.some((propertyId) => !authorized.has(propertyId))) {
      return null;
    }
    const id = descriptor.id.toLowerCase();
    const key = `${descriptor.kind}:${id}`;
    if (descriptorKeys.has(key)) return null;
    descriptorKeys.add(key);
    descriptors.push({
      ...descriptor,
      id,
      name: descriptor.name.trim(),
      propertyIds: descriptorPropertyIds,
    });
  }
  return {
    organizationId: input.organizationId.toLowerCase(),
    organizationName: input.organizationName?.trim() ?? null,
    propertyIds,
    descriptors,
  };
}

function companyScope(input: ValidatedScope): ResolvedPortfolioUiScope {
  return {
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    kind: 'company',
    id: input.organizationId,
    name: input.organizationName ?? 'Your company',
    propertyIds: input.propertyIds,
    selector: { type: 'all_authorized' },
    requestedHotelId: null,
  };
}

function descriptorScope(
  input: ValidatedScope,
  descriptors: readonly ValidatedScope['descriptors'][number][],
): PortfolioUiScopeSelectionResult {
  if (descriptors.length === 0) return { ok: false, reason: 'descriptor_not_found' };
  if (descriptors.length !== 1) return { ok: false, reason: 'descriptor_ambiguous' };
  const descriptor = descriptors[0];
  return {
    ok: true,
    scope: {
      organizationId: input.organizationId,
      organizationName: input.organizationName,
      kind: descriptor.kind,
      id: descriptor.id,
      name: descriptor.name,
      propertyIds: descriptor.propertyIds,
      selector: descriptor.kind === 'region' || descriptor.kind === 'portfolio'
        ? { type: 'portfolio', portfolioId: descriptor.id }
        : descriptor.kind === 'selected_hotels'
          ? { type: 'property_subset', propertyIds: descriptor.propertyIds }
          : { type: 'all_authorized' },
      requestedHotelId: null,
    },
  };
}

/**
 * Match browser scope state only against one current authoritative receipt.
 * Descriptor property ids always come from that receipt; URL state supplies
 * only an opaque descriptor selector and, for drill-down, one requested hotel.
 */
export function selectAuthoritativePortfolioUiScope(
  authoritativeInput: PortfolioUiAuthoritativeScopeInput,
  context: PortfolioUiContext,
): PortfolioUiScopeSelectionResult {
  const input = validateAuthoritativeScope(authoritativeInput);
  if (!input) return { ok: false, reason: 'invalid_authoritative_scope' };
  const organizationId = 'organizationId' in context
    ? context.organizationId?.toLowerCase() ?? null
    : null;
  if (organizationId !== input.organizationId) {
    return { ok: false, reason: 'organization_mismatch' };
  }

  let selected: PortfolioUiScopeSelectionResult;
  if (context.scope === 'portfolio' && !context.portfolioId) {
    selected = { ok: true, scope: companyScope(input) };
  } else if (context.scope === 'portfolio' || context.scope === 'region') {
    const id = context.portfolioId?.toLowerCase();
    const expectedKind = context.scope;
    selected = descriptorScope(input, input.descriptors.filter(
      (descriptor) => descriptor.id === id && descriptor.kind === expectedKind,
    ));
  } else if (context.scope === 'selected_hotels') {
    const id = context.descriptorId.toLowerCase();
    selected = descriptorScope(input, input.descriptors.filter(
      (descriptor) => descriptor.id === id && descriptor.kind === 'selected_hotels',
    ));
  } else {
    if (!context.portfolioId && !context.descriptorId) {
      selected = { ok: true, scope: companyScope(input) };
    } else if (context.portfolioId) {
      const id = context.portfolioId.toLowerCase();
      selected = descriptorScope(input, input.descriptors.filter(
        (descriptor) => descriptor.id === id
          && (descriptor.kind === 'region' || descriptor.kind === 'portfolio'),
      ));
    } else {
      const id = context.descriptorId?.toLowerCase();
      selected = descriptorScope(input, input.descriptors.filter(
        (descriptor) => descriptor.id === id && descriptor.kind === 'selected_hotels',
      ));
    }
    if (!selected.ok) return selected;
    const propertyId = context.propertyId.toLowerCase();
    if (!selected.scope.propertyIds.includes(propertyId)) {
      return { ok: false, reason: 'hotel_not_in_scope' };
    }
    return {
      ok: true,
      scope: { ...selected.scope, requestedHotelId: propertyId },
    };
  }
  return selected;
}
