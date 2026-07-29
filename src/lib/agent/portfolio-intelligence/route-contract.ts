import { z } from 'zod';

import type {
  AuthorizationScopeReceipt,
  AuthorizationScopeSelector,
} from '@/lib/authorization';
import type { AuthorizedPropertyMetadataResult } from '@/lib/authorization/server';

import {
  portfolioScopeSelectorSchema,
  type PlannerScopeCatalog,
  type PortfolioQueryPlan,
  type PortfolioScopeSelector,
  type ScopeHotelCandidate,
} from './schemas';
import { PORTFOLIO_USER_MESSAGE_MAX_CHARS } from './history-window';

export const PORTFOLIO_MESSAGE_MAX_CHARS = PORTFOLIO_USER_MESSAGE_MAX_CHARS;

export const portfolioTurnRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(PORTFOLIO_MESSAGE_MAX_CHARS),
  /** Optional UI narrowing. IDs remain untrusted until the database resolver
   * proves the whole selector is inside the current authorization universe. */
  selector: portfolioScopeSelectorSchema.optional(),
}).strict();
export type PortfolioTurnRequest = z.infer<typeof portfolioTurnRequestSchema>;

function placeholderHotel(propertyId: string): ScopeHotelCandidate {
  return {
    propertyId,
    name: `Hotel ${propertyId.slice(0, 8)}`,
    city: null,
    region: null,
    propertyCode: null,
    timezone: null,
    businessDateCutoffHour: null,
    totalRooms: null,
    portfolioIds: [],
  };
}

/** Build the planner catalog from one freshly asserted authoritative receipt.
 * Deleted/unreadable property rows remain explicit placeholders so coverage
 * stays exact instead of shrinking silently. */
export function buildPlannerScopeCatalog(input: {
  receipt: AuthorizationScopeReceipt;
  metadata: Extract<AuthorizedPropertyMetadataResult, { ok: true }>;
}): PlannerScopeCatalog {
  if (input.metadata.receipt.id !== input.receipt.id
      || input.metadata.receipt.scopeHash !== input.receipt.scopeHash
      || input.metadata.receipt.authorizationHash !== input.receipt.authorizationHash) {
    throw new Error('property metadata was not loaded under the supplied authorization receipt');
  }
  const byId = new Map(input.metadata.properties.map((property) => [property.propertyId, property]));
  const regionNameById = new Map(
    input.receipt.portfolioCatalog
      .filter((portfolio) => portfolio.portfolioType === 'region')
      .map((portfolio) => [portfolio.portfolioId, portfolio.name]),
  );
  const hotels = input.receipt.authorizedPropertyIds.map((propertyId): ScopeHotelCandidate => {
    const property = byId.get(propertyId);
    if (!property) return placeholderHotel(propertyId);
    return {
      propertyId,
      name: property.name?.trim() || `Hotel ${propertyId.slice(0, 8)}`,
      city: null,
      region: property.region?.trim()
        || property.regionIds.map((id) => regionNameById.get(id)).find(Boolean)
        || null,
      propertyCode: null,
      timezone: property.timezone,
      businessDateCutoffHour: property.businessDateCutoffHour,
      totalRooms: property.totalRooms,
      portfolioIds: property.portfolioIds,
    };
  });
  return {
    organizationId: input.receipt.organizationId,
    hotels,
    portfolios: input.receipt.portfolioCatalog.map((portfolio) => ({
      portfolioId: portfolio.portfolioId,
      name: portfolio.name,
      type: portfolio.portfolioType,
      propertyIds: portfolio.propertyIds,
    })),
  };
}

export function authorizationSelectorForPlan(
  selector: PortfolioScopeSelector,
): AuthorizationScopeSelector {
  switch (selector.kind) {
    case 'all_authorized':
      return { type: 'all_authorized' };
    case 'portfolio':
      return { type: 'portfolio', portfolioId: selector.portfolioId };
    case 'hotel':
      return { type: 'property_subset', propertyIds: [selector.propertyId] };
    case 'explicit_subset':
      return { type: 'property_subset', propertyIds: selector.propertyIds };
  }
}

function cleanLabel(value: string): string {
  return value
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function scopeLabelForPlan(
  plan: PortfolioQueryPlan,
  catalog: PlannerScopeCatalog,
): string {
  const selector = plan.selector;
  switch (selector.kind) {
    case 'all_authorized':
      return 'All authorized hotels';
    case 'hotel':
      return cleanLabel(
        catalog.hotels.find((hotel) => hotel.propertyId === selector.propertyId)?.name
          ?? 'One authorized hotel',
      );
    case 'explicit_subset':
      return `${selector.propertyIds.length} selected authorized hotels`;
    case 'portfolio': {
      const portfolio = catalog.portfolios.find(
        (candidate) => candidate.portfolioId === selector.portfolioId,
      );
      return cleanLabel(portfolio?.name ?? 'Selected portfolio or region');
    }
  }
}

export interface PortfolioActiveScopeEvent {
  type: 'active_scope';
  scope: {
    organizationId: string;
    organizationName: string | null;
    selectorLabel: string;
    selectedHotelCount: number;
    authorizedHotelCount: number;
    hotelNames: string[];
    hotelNamesOmitted: number;
    coverage: { reported: number; total: number; omitted: number };
  };
}

export function activeScopeEvent(input: {
  receipt: AuthorizationScopeReceipt;
  catalog: PlannerScopeCatalog;
  selectorLabel: string;
  reported: number;
  omitted: number;
}): PortfolioActiveScopeEvent {
  const names = new Map(input.catalog.hotels.map((hotel) => [hotel.propertyId, hotel.name]));
  return {
    type: 'active_scope',
    scope: {
      organizationId: input.receipt.organizationId,
      organizationName: input.receipt.organizationName,
      selectorLabel: cleanLabel(input.selectorLabel),
      selectedHotelCount: input.receipt.selectedPropertyCount,
      authorizedHotelCount: input.receipt.authorizedPropertyCount,
      hotelNames: input.receipt.propertyIds
        .slice(0, 25)
        .map((propertyId) => cleanLabel(names.get(propertyId) ?? `Hotel ${propertyId.slice(0, 8)}`)),
      hotelNamesOmitted: Math.max(0, input.receipt.selectedPropertyCount - 25),
      coverage: {
        reported: Math.max(0, input.reported),
        total: input.receipt.selectedPropertyCount,
        omitted: Math.max(0, input.omitted),
      },
    },
  };
}
