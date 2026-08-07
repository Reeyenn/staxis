/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCOPE THE WHOLE APP IS POINTED AT.
 *
 * Company view is a MODE of this app, not a separate world. A VP picks
 * "Gulf Coast Hotels · All hotels" in the same switcher everyone uses and the
 * ordinary pages re-render company-wide. That means one question has to have
 * one answer everywhere: what is this browser currently scoped to?
 *
 * TWO UNIONS, TWO JOBS — do not collapse them.
 *
 *   ActingScopeRequest   what the LOCATION asks for. Derived purely from the
 *                        acting-context request plus its authorization verdict.
 *                        Says nothing about whether the viewer may have it.
 *
 *   AppScope             what the app RESOLVED. A hotel that exists in this
 *                        viewer's coverage, or a company scope minted by the
 *                        authoritative algebra in ./scope-selection, or an
 *                        explicit `unresolved` with a reason.
 *
 * THE `unresolved` STATE IS THE POINT. The old contract was
 * `setActivePropertyId(id: string)` plus `properties.find(...) ?? null`, so an
 * id the viewer no longer covers became a null that every consumer read as
 * "no hotel yet" and every gate answered differently. `unresolved` carries the
 * reason instead, and both gates below refuse it identically.
 *
 * This module is PURE. No React, no fetch, no storage. Keep it that way: the
 * gate agreement between capabilities and sections is tested by calling these
 * functions directly.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  buildPortfolioUiUrl,
  PORTFOLIO_UI_QUERY_KEYS,
  type PortfolioUiContext,
} from './context';
import {
  selectAuthoritativePortfolioUiScope,
  type PortfolioUiScopeDescriptorKind,
  type ResolvedPortfolioUiScope,
} from './scope-selection';
import type { PortfolioUiCompanyContext, PortfolioUiSelection } from './contracts';
import type { HotelActingRequest } from './hotel-acting-request';
import {
  APP_SECTIONS,
  isSectionEnabled,
  resolveSections,
  type AppSection,
  type EnabledSections,
} from '@/lib/sections/registry';

/** Verdict vocabulary for one hotel acting-context request. */
export type ActingAuthorizationStatus =
  | 'inactive'
  | 'checking'
  | 'allowed'
  | 'denied'
  | 'error';

export type ActingScopeRequest =
  | { kind: 'unresolved' }
  /** The classic app: no scope in the URL, so the browser's own selection wins. */
  | { kind: 'local_hotel' }
  /** One hotel the server has verified for this exact viewer. */
  | { kind: 'hotel'; propertyId: string }
  | {
      kind: 'company';
      organizationId: string;
      descriptorKind: PortfolioUiScopeDescriptorKind;
      /** Whole-company scope uses the organization id; a slice uses its own. */
      descriptorId: string;
      /** Handed back to the pure algebra, which re-checks it against a receipt. */
      context: Exclude<PortfolioUiContext, { scope: 'hotel' }>;
    };

export type AppScopeUnresolvedReason =
  /** Still deciding. Nothing is known to be wrong. */
  | 'loading'
  /** Nothing has been chosen yet. */
  | 'no_selection'
  /** Something WAS chosen and this viewer does not cover it. Never a silent null. */
  | 'selection_unavailable';

export type AppScope =
  | { kind: 'unresolved'; reason: AppScopeUnresolvedReason }
  | { kind: 'hotel'; propertyId: string }
  | { kind: 'company'; scope: ResolvedPortfolioUiScope };

/** What a caller may ask the app to point at. Company scope is a value, not a magic id. */
export type AppScopeSelection =
  | { kind: 'hotel'; propertyId: string }
  | { kind: 'company'; organizationId: string };

export type AppScopeChangeResult =
  | { ok: true }
  /** An open workflow cancelled the change, or the acting context pins the hotel. */
  | { ok: false; reason: 'blocked' };

export const UNRESOLVED_LOADING: AppScope = { kind: 'unresolved', reason: 'loading' };
export const UNRESOLVED_NO_SELECTION: AppScope = { kind: 'unresolved', reason: 'no_selection' };
export const UNRESOLVED_UNAVAILABLE: AppScope = {
  kind: 'unresolved',
  reason: 'selection_unavailable',
};

/**
 * The standalone portfolio world. Those routes still render from the portfolio
 * bootstrap and deliberately never load the hotel roster, so company MODE stops
 * at their door. They stay mounted as a fallback; nothing routes into them by
 * default any more.
 */
const LEGACY_PORTFOLIO_WORLD_PREFIXES = ['/portfolio', '/company'] as const;

export function isLegacyPortfolioWorldPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false;
  return LEGACY_PORTFOLIO_WORLD_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function descriptorKindFor(
  context: Exclude<PortfolioUiContext, { scope: 'hotel' }>,
): PortfolioUiScopeDescriptorKind {
  if (context.scope === 'region') return 'region';
  if (context.scope === 'selected_hotels') return 'selected_hotels';
  return context.portfolioId ? 'portfolio' : 'company';
}

function descriptorIdFor(
  context: Exclude<PortfolioUiContext, { scope: 'hotel' }>,
): string {
  if (context.scope === 'selected_hotels') return context.descriptorId;
  if (context.scope === 'region') return context.portfolioId;
  return context.portfolioId ?? context.organizationId;
}

/**
 * What the current location asks for. A hotel request only becomes hotel scope
 * once the server has said `allowed`: a checking/denied/error verdict is
 * unresolved, which both gates below read as closed.
 */
export function resolveActingScopeRequest(input: {
  request: HotelActingRequest | null | undefined;
  status: ActingAuthorizationStatus;
}): ActingScopeRequest {
  const request = input.request;
  if (!request) return { kind: 'local_hotel' };
  if (request.kind === 'invalid') return { kind: 'unresolved' };
  if (request.kind === 'local_app') return { kind: 'local_hotel' };
  if (request.kind === 'hotel') {
    return input.status === 'allowed'
      ? { kind: 'hotel', propertyId: request.context.propertyId }
      : { kind: 'unresolved' };
  }
  // A bare /portfolio URL carries no context: that world picks its own company
  // through the bootstrap and this seam has nothing to resolve.
  if (!request.context) return { kind: 'unresolved' };
  return {
    kind: 'company',
    organizationId: request.context.organizationId,
    descriptorKind: descriptorKindFor(request.context),
    descriptorId: descriptorIdFor(request.context),
    context: request.context,
  };
}

/**
 * Mint the resolved company scope through the SAME pure algebra the portfolio
 * receipts use. The authoritative input is the bootstrap's own company context,
 * so a company the viewer no longer holds, or one with no hotels, resolves to
 * `selection_unavailable` rather than to an empty-but-plausible scope.
 *
 * `descriptors` is deliberately empty: this crew ships the whole-company row
 * only, so a region / portfolio / selected-hotels URL fails closed here until a
 * later crew supplies real descriptors from the receipt.
 */
export function resolveCompanyAppScope(
  request: Extract<ActingScopeRequest, { kind: 'company' }>,
  contexts: readonly PortfolioUiCompanyContext[] | null | undefined,
): AppScope {
  const wanted = request.organizationId.toLowerCase();
  const company = (contexts ?? []).find(
    (candidate) => typeof candidate?.organizationId === 'string'
      && candidate.organizationId.toLowerCase() === wanted,
  );
  if (!company) return UNRESOLVED_UNAVAILABLE;
  const selected = selectAuthoritativePortfolioUiScope(
    {
      organizationId: company.organizationId,
      organizationName: company.organizationName,
      propertyIds: company.hotelIds,
      descriptors: [],
    },
    request.context,
  );
  return selected.ok ? { kind: 'company', scope: selected.scope } : UNRESOLVED_UNAVAILABLE;
}

/** Stable identity for React dependencies and equality checks. */
export function appScopeKey(scope: AppScope): string {
  if (scope.kind === 'unresolved') return `unresolved:${scope.reason}`;
  if (scope.kind === 'hotel') return `hotel:${scope.propertyId}`;
  return `company:${scope.scope.organizationId}:${scope.scope.kind}:${scope.scope.id}:${scope.scope.propertyIds.join(',')}`;
}

export function sameAppScope(left: AppScope, right: AppScope): boolean {
  return appScopeKey(left) === appScopeKey(right);
}

// ── The section gate, per scope ─────────────────────────────────────────────

const ALL_SECTIONS_OFF: Record<AppSection, boolean> = Object.fromEntries(
  APP_SECTIONS.map((section) => [section, false]),
) as Record<AppSection, boolean>;

export interface ScopeSectionInput {
  /** The active hotel's stored map. Read only at hotel scope. */
  hotel: EnabledSections | undefined;
  /** Stored maps for the hotels a company scope covers. Read only at company scope. */
  company: readonly (EnabledSections | undefined)[];
}

/**
 * WHICH TABS EXIST AT THIS SCOPE.
 *
 * FAIL CLOSED under an unresolved scope. This used to fail OPEN ("every section
 * ON while the property loads") while the capability gate failed CLOSED, so an
 * unresolved scope rendered the whole navigation with every button dead. The
 * two gates now answer the same way, and `sections on + capabilities unknown`
 * is not a reachable state.
 *
 * At company scope a section is on when it is on at ANY hotel in the scope:
 * company pages roll the hotels up, so one hotel that still runs housekeeping
 * is reason enough for the company to have a housekeeping view.
 */
export function sectionsForScope(
  scope: AppScope,
  input: ScopeSectionInput,
): Record<AppSection, boolean> {
  if (scope.kind === 'unresolved') return { ...ALL_SECTIONS_OFF };
  if (scope.kind === 'hotel') return resolveSections(input.hotel);
  if (input.company.length === 0) return { ...ALL_SECTIONS_OFF };
  const out = {} as Record<AppSection, boolean>;
  for (const section of APP_SECTIONS) {
    out[section] = input.company.some((flags) => isSectionEnabled(flags, section));
  }
  return out;
}

export function anySectionOn(sections: Record<AppSection, boolean>): boolean {
  return APP_SECTIONS.some((section) => sections[section]);
}

// ── Company-mode links ──────────────────────────────────────────────────────

/**
 * The in-app company URL for a destination. Company mode is expressed in the
 * location, so every link the bar builds while a company is selected carries it
 * and a refresh lands back in the same scope.
 */
export function companyScopeHref(targetPath: string, organizationId: string): string {
  try {
    return buildPortfolioUiUrl(targetPath, { scope: 'portfolio', organizationId });
  } catch {
    return targetPath;
  }
}

/** The same destination with every scope selector stripped: back to one hotel. */
export function localAppHref(
  targetPath: string,
  existing?: string | URLSearchParams,
): string {
  const params = new URLSearchParams(
    existing instanceof URLSearchParams ? existing.toString() : (existing ?? ''),
  );
  for (const key of Object.values(PORTFOLIO_UI_QUERY_KEYS)) params.delete(key);
  const query = params.toString();
  return query ? `${targetPath}?${query}` : targetPath;
}

/**
 * WHERE A COMPANY LEADER ENTERS THE APP.
 *
 * Never the standalone portfolio world. A leader with one authorized company
 * lands on Home in that company's scope; a leader with several lands on Home
 * and picks from the switcher, which is what /portfolio/choose used to do.
 * Returns null when this account has no company entry to make.
 */
export function companyEntryDestination(
  selection: PortfolioUiSelection | null | undefined,
): string | null {
  if (!selection) return null;
  if (selection.state === 'selected' && selection.selectedOrganizationId) {
    return companyScopeHref('/home', selection.selectedOrganizationId);
  }
  if (selection.state === 'needs_selection') return '/home';
  return null;
}

// ── What Home does with a scope ─────────────────────────────────────────────

export type HomeEntryDecision =
  /** Nothing decided yet. Hold the loading surface; never redirect. */
  | { kind: 'wait' }
  | { kind: 'signin' }
  /** Render the interim company surface. */
  | { kind: 'company' }
  /** Render the hotel hub. */
  | { kind: 'hotel' }
  /** Several places to work and none chosen: pick here, not in another world. */
  | { kind: 'choose_scope' }
  /** Hotel-only account with no selection: the hotel picker is still their door. */
  | { kind: 'property_selector' };

/**
 * Home's own routing decision, as data.
 *
 * The /portfolio redirect that used to live here is GONE, and this vocabulary
 * is why it cannot come back: there is no outcome that names another world.
 */
export function resolveHomeEntry(input: {
  authLoading: boolean;
  propertyLoading: boolean;
  portfolioEntryPending: boolean;
  signedIn: boolean;
  scope: AppScope;
  companyOptionCount: number;
}): HomeEntryDecision {
  if (input.authLoading) return { kind: 'wait' };
  if (!input.signedIn) return { kind: 'signin' };
  if (input.scope.kind === 'company') return { kind: 'company' };
  if (input.propertyLoading || input.portfolioEntryPending) return { kind: 'wait' };
  if (input.scope.kind === 'hotel') return { kind: 'hotel' };
  if (input.scope.reason === 'loading') return { kind: 'wait' };
  if (input.companyOptionCount > 0) return { kind: 'choose_scope' };
  return { kind: 'property_selector' };
}
