import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anySectionOn,
  appScopeKey,
  companyEntryDestination,
  companyScopeHref,
  isLegacyPortfolioWorldPath,
  localAppHref,
  resolveActingScopeRequest,
  resolveCompanyAppScope,
  resolveHomeEntry,
  sameAppScope,
  sectionsForScope,
  UNRESOLVED_LOADING,
  type ActingScopeRequest,
  type AppScope,
} from '@/lib/portfolio-ui/acting-scope';
import {
  activeScopeSwitcherKey,
  buildScopeSwitcherRows,
  companyRowLabel,
  scopeSwitcherRowForKey,
} from '@/lib/portfolio-ui/scope-switcher';
import { resolveHotelActingRequest } from '@/lib/portfolio-ui/hotel-acting-request';
import {
  resolveViewerCompanyStanding,
  resolveViewerHotelStanding,
  type ViewerHotelStanding,
} from '@/lib/authorization/domain';
import { can } from '@/lib/capabilities/can';
import { APP_SECTIONS } from '@/lib/sections/registry';
import type { PortfolioUiCompanyContext, PortfolioUiSelection } from '@/lib/portfolio-ui/contracts';

const GULF_COAST = '11111111-1111-4111-8111-111111111111';
const SUNBELT = '33333333-3333-4333-8333-333333333333';
const HOTEL_A = '22222222-2222-4222-8222-222222222222';
const HOTEL_B = '44444444-4444-4444-8444-444444444444';
const HOTEL_C = '55555555-5555-4555-8555-555555555555';

function companyContext(
  overrides: Partial<PortfolioUiCompanyContext> = {},
): PortfolioUiCompanyContext {
  return {
    organizationId: GULF_COAST,
    organizationName: 'Gulf Coast Hotels',
    companyRole: 'regional_manager',
    hotelIds: [HOTEL_A, HOTEL_B],
    hotelCount: 2,
    queueAvailable: true,
    capabilities: {
      canReadPortfolio: true,
      canActOnFindings: true,
      canManageStaff: true,
      canViewFinancials: true,
      canAskStaxis: true,
    },
    chat: { state: 'available', reason: null },
    ...overrides,
  };
}

function standing(
  propertyId: string,
  overrides: Partial<ViewerHotelStanding> = {},
): ViewerHotelStanding {
  return {
    propertyId,
    operationalRole: 'front_desk',
    seesFinancials: true,
    hotelMutationAllowed: false,
    portfolioIntelligenceRead: true,
    ...overrides,
  };
}

function companyScopeRequest(
  organizationId = GULF_COAST,
): Extract<ActingScopeRequest, { kind: 'company' }> {
  const resolved = resolveActingScopeRequest({
    request: resolveHotelActingRequest({
      pathname: '/home',
      search: `scope=portfolio&organizationId=${organizationId}`,
    }),
    status: 'inactive',
  });
  assert.equal(resolved.kind, 'company');
  return resolved as Extract<ActingScopeRequest, { kind: 'company' }>;
}

function resolvedCompanyScope(
  contexts: readonly PortfolioUiCompanyContext[] = [companyContext()],
): AppScope {
  return resolveCompanyAppScope(companyScopeRequest(), contexts);
}

describe('company-mode scope union', () => {
  test('a plain app URL is local hotel scope and a verified hotel is hotel scope', () => {
    assert.deepEqual(
      resolveActingScopeRequest({
        request: resolveHotelActingRequest({ pathname: '/dashboard', search: '' }),
        status: 'inactive',
      }),
      { kind: 'local_hotel' },
    );

    const hotelRequest = resolveHotelActingRequest({
      pathname: '/dashboard',
      search: `scope=hotel&propertyId=${HOTEL_A}`,
    });
    assert.deepEqual(
      resolveActingScopeRequest({ request: hotelRequest, status: 'allowed' }),
      { kind: 'hotel', propertyId: HOTEL_A },
    );
  });

  test('an unverified hotel request is unresolved, never hotel scope', () => {
    const hotelRequest = resolveHotelActingRequest({
      pathname: '/dashboard',
      search: `scope=hotel&propertyId=${HOTEL_A}`,
    });
    for (const status of ['checking', 'denied', 'error', 'inactive'] as const) {
      assert.deepEqual(
        resolveActingScopeRequest({ request: hotelRequest, status }),
        { kind: 'unresolved' },
        status,
      );
    }
  });

  test('a malformed scope URL is unresolved rather than a guessed hotel', () => {
    const broken = resolveHotelActingRequest({
      pathname: '/dashboard',
      search: 'scope=hotel&propertyId=not-a-uuid',
    });
    assert.deepEqual(
      resolveActingScopeRequest({ request: broken, status: 'inactive' }),
      { kind: 'unresolved' },
    );
  });

  test('the company scope round-trips from the switcher link back through the provider', () => {
    const href = companyScopeHref('/home', GULF_COAST);
    const [pathname, search] = href.split('?');
    assert.equal(pathname, '/home');

    const request = resolveActingScopeRequest({
      request: resolveHotelActingRequest({ pathname, search }),
      status: 'inactive',
    });
    assert.equal(request.kind, 'company');
    assert.equal(
      request.kind === 'company' ? request.organizationId : null,
      GULF_COAST,
    );
    assert.equal(
      request.kind === 'company' ? request.descriptorKind : null,
      'company',
      'the whole-company row must select the company descriptor, not a slice',
    );

    const scope = resolveCompanyAppScope(
      request as Extract<ActingScopeRequest, { kind: 'company' }>,
      [companyContext()],
    );
    assert.equal(scope.kind, 'company');
    assert.deepEqual(
      scope.kind === 'company' ? scope.scope.propertyIds : null,
      [HOTEL_A, HOTEL_B].map((id) => id.toLowerCase()).sort(),
    );
    assert.equal(scope.kind === 'company' ? scope.scope.name : null, 'Gulf Coast Hotels');
  });

  test('a company this viewer does not hold never resolves to an empty-but-plausible scope', () => {
    assert.deepEqual(
      resolveCompanyAppScope(companyScopeRequest(SUNBELT), [companyContext()]),
      { kind: 'unresolved', reason: 'selection_unavailable' },
    );
    assert.deepEqual(
      resolveCompanyAppScope(companyScopeRequest(), []),
      { kind: 'unresolved', reason: 'selection_unavailable' },
    );
    assert.deepEqual(
      resolveCompanyAppScope(companyScopeRequest(), [companyContext({ hotelIds: [] })]),
      { kind: 'unresolved', reason: 'selection_unavailable' },
      'a company with no hotels is not a company scope',
    );
  });

  test('scope identity distinguishes the three unresolved reasons', () => {
    assert.equal(appScopeKey(UNRESOLVED_LOADING), 'unresolved:loading');
    assert.equal(
      sameAppScope(
        { kind: 'unresolved', reason: 'loading' },
        { kind: 'unresolved', reason: 'selection_unavailable' },
      ),
      false,
      'a hotel that vanished from coverage must not read as still loading',
    );
    assert.equal(
      sameAppScope({ kind: 'hotel', propertyId: HOTEL_A }, { kind: 'hotel', propertyId: HOTEL_A }),
      true,
    );
  });

  test('company mode stops at the standalone portfolio world', () => {
    assert.equal(isLegacyPortfolioWorldPath('/portfolio'), true);
    assert.equal(isLegacyPortfolioWorldPath('/portfolio/choose'), true);
    assert.equal(isLegacyPortfolioWorldPath('/company'), true);
    assert.equal(isLegacyPortfolioWorldPath('/home'), false);
    assert.equal(isLegacyPortfolioWorldPath('/dashboard'), false);
    assert.equal(isLegacyPortfolioWorldPath('/companion'), false);
  });
});

describe('company-scope capability gate', () => {
  const OVERSIGHT_STANDINGS = [standing(HOTEL_A), standing(HOTEL_B)];

  test("a regional manager's company scope reads the company hat's capabilities", () => {
    const resolved = resolveViewerCompanyStanding({
      platformAdmin: false,
      standings: OVERSIGHT_STANDINGS,
      organizationId: GULF_COAST,
      propertyIds: [HOTEL_A, HOTEL_B],
      // legacyRoleForHat('regional_manager')
      companyRole: 'front_desk',
    });
    assert.ok(resolved);
    assert.equal(resolved.operationalRole, 'front_desk');
    assert.equal(resolved.seesFinancials, true);
    assert.equal(resolved.portfolioIntelligenceRead, true);
    assert.deepEqual(resolved.propertyIds, [HOTEL_A, HOTEL_B].sort());
    assert.equal(
      can({ role: resolved.operationalRole }, 'post_announcements', {}),
      true,
    );
    assert.equal(
      can({ role: resolved.operationalRole }, 'manage_users', {}),
      false,
      'the manager floor still holds at company scope',
    );
  });

  test('hotel mutation is off at company scope for every role, owners included', () => {
    for (const companyRole of ['owner', 'front_desk'] as const) {
      const resolved = resolveViewerCompanyStanding({
        platformAdmin: false,
        standings: [
          standing(HOTEL_A, { hotelMutationAllowed: true, operationalRole: 'owner' }),
          standing(HOTEL_B, { hotelMutationAllowed: true, operationalRole: 'owner' }),
        ],
        organizationId: GULF_COAST,
        propertyIds: [HOTEL_A, HOTEL_B],
        companyRole,
      });
      assert.ok(resolved);
      assert.equal(resolved.hotelMutationAllowed, false, companyRole);
    }
  });

  test('a GM at one hotel gains nothing by arriving at a company URL', () => {
    // The only standing this person holds is their own building.
    const gmStandings = [standing(HOTEL_A, {
      operationalRole: 'general_manager',
      hotelMutationAllowed: true,
    })];

    // No company hat at all: refused outright.
    assert.equal(
      resolveViewerCompanyStanding({
        platformAdmin: false,
        standings: gmStandings,
        organizationId: GULF_COAST,
        propertyIds: [HOTEL_A, HOTEL_B],
        companyRole: null,
      }),
      null,
    );

    // Even if a company hat were claimed, the hotels they do not hold refuse.
    assert.equal(
      resolveViewerCompanyStanding({
        platformAdmin: false,
        standings: gmStandings,
        organizationId: GULF_COAST,
        propertyIds: [HOTEL_A, HOTEL_B],
        companyRole: 'owner',
      }),
      null,
      'a standing at one hotel may never speak for the hotels beside it',
    );
  });

  test('company financials require the money door at every hotel the scope rolls up', () => {
    const resolved = resolveViewerCompanyStanding({
      platformAdmin: false,
      standings: [standing(HOTEL_A), standing(HOTEL_B, { seesFinancials: false })],
      organizationId: GULF_COAST,
      propertyIds: [HOTEL_A, HOTEL_B],
      companyRole: 'front_desk',
    });
    assert.ok(resolved);
    assert.equal(
      resolved.seesFinancials,
      false,
      'one hotel the viewer may not see money at closes the company roll-up',
    );
  });

  test('a platform admin holds the company scope its hotels would give them', () => {
    const resolved = resolveViewerCompanyStanding({
      platformAdmin: true,
      standings: [],
      organizationId: GULF_COAST,
      propertyIds: [HOTEL_A, HOTEL_B],
      companyRole: null,
    });
    assert.ok(resolved);
    assert.equal(resolved.operationalRole, 'admin');
    assert.equal(resolved.seesFinancials, true);
    assert.equal(resolved.hotelMutationAllowed, false);
  });
});

describe('section gate agreement', () => {
  const HOTEL_A_SECTIONS = { financials: false } as const;
  const HOTEL_B_SECTIONS = { housekeeping: false } as const;

  test('an unresolved scope turns every section off, in every reason', () => {
    for (const reason of ['loading', 'no_selection', 'selection_unavailable'] as const) {
      const sections = sectionsForScope({ kind: 'unresolved', reason }, {
        hotel: HOTEL_A_SECTIONS,
        company: [HOTEL_A_SECTIONS, HOTEL_B_SECTIONS],
      });
      assert.equal(anySectionOn(sections), false, reason);
    }
  });

  test('hotel scope keeps the default-ON per-hotel contract', () => {
    const sections = sectionsForScope({ kind: 'hotel', propertyId: HOTEL_A }, {
      hotel: HOTEL_A_SECTIONS,
      company: [],
    });
    assert.equal(sections.financials, false);
    assert.equal(sections.housekeeping, true);
    assert.equal(sections.staxis, true);
  });

  test('company scope unions the hotels it covers', () => {
    const scope = resolvedCompanyScope();
    const sections = sectionsForScope(scope, {
      hotel: undefined,
      company: [HOTEL_A_SECTIONS, HOTEL_B_SECTIONS],
    });
    assert.equal(sections.financials, true, 'hotel B still runs financials');
    assert.equal(sections.housekeeping, true, 'hotel A still runs housekeeping');

    const bothOff = sectionsForScope(scope, {
      hotel: undefined,
      company: [{ financials: false }, { financials: false }],
    });
    assert.equal(bothOff.financials, false, 'no hotel runs it, so the company has no view');
  });

  test('a company scope whose hotels have not loaded turns every section off', () => {
    const sections = sectionsForScope(resolvedCompanyScope(), { hotel: undefined, company: [] });
    assert.equal(anySectionOn(sections), false);
  });

  test('THE INVARIANT: no scope leaves every tab on with every button dead', () => {
    const standings = [standing(HOTEL_A), standing(HOTEL_B)];
    const cases: Array<{
      label: string;
      scope: AppScope;
      company: Array<Partial<Record<string, boolean>> | null>;
    }> = [
      { label: 'loading', scope: { kind: 'unresolved', reason: 'loading' }, company: [] },
      { label: 'no selection', scope: { kind: 'unresolved', reason: 'no_selection' }, company: [] },
      { label: 'gone', scope: { kind: 'unresolved', reason: 'selection_unavailable' }, company: [] },
      { label: 'hotel', scope: { kind: 'hotel', propertyId: HOTEL_A }, company: [] },
      { label: 'company', scope: resolvedCompanyScope(), company: [null, null] },
    ];

    for (const { label, scope, company } of cases) {
      const sections = sectionsForScope(scope, { hotel: null, company });
      const capabilityGateReady = scope.kind === 'hotel'
        ? resolveViewerHotelStanding({
          platformAdmin: false,
          standings,
          propertyId: scope.propertyId,
        }) !== null
        : scope.kind === 'company'
          ? resolveViewerCompanyStanding({
            platformAdmin: false,
            standings,
            organizationId: scope.scope.organizationId,
            propertyIds: scope.scope.propertyIds,
            companyRole: 'front_desk',
          }) !== null
          : false;

      if (anySectionOn(sections)) {
        assert.equal(
          capabilityGateReady,
          true,
          `${label}: sections were offered where capabilities cannot be resolved`,
        );
      }
      if (!capabilityGateReady) {
        assert.equal(
          anySectionOn(sections),
          false,
          `${label}: the all-tabs-on, all-buttons-dead state is reachable again`,
        );
      }
    }
  });

  test('every registered section is answered, never silently missing', () => {
    const sections = sectionsForScope({ kind: 'hotel', propertyId: HOTEL_A }, {
      hotel: null,
      company: [],
    });
    for (const section of APP_SECTIONS) {
      assert.equal(typeof sections[section], 'boolean', section);
    }
  });
});

describe('the switcher row union', () => {
  test('the company row names the company and says it means all of it', () => {
    assert.equal(companyRowLabel('Gulf Coast Hotels'), 'Gulf Coast Hotels · All hotels');
    assert.equal(companyRowLabel(null), 'Your company · All hotels');
    assert.equal(companyRowLabel('   '), 'Your company · All hotels');
  });

  test('a hotel-only person gets hotel rows and no company row', () => {
    const rows = buildScopeSwitcherRows({
      companies: [],
      hotels: [{ id: HOTEL_A, name: 'Comfort Suites Beaumont' }],
      activeScope: { kind: 'hotel', propertyId: HOTEL_A },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'hotel');
    assert.equal(rows.some((row) => row.kind === 'company'), false);
  });

  test('a multi-company person gets one row per company, replacing the picker', () => {
    const rows = buildScopeSwitcherRows({
      companies: [
        { organizationId: SUNBELT, organizationName: 'Sunbelt Lodging' },
        { organizationId: GULF_COAST, organizationName: 'Gulf Coast Hotels' },
      ],
      hotels: [{ id: HOTEL_C, name: 'Hotel C' }],
      activeScope: UNRESOLVED_LOADING,
    });
    const companyRows = rows.filter((row) => row.kind === 'company');
    assert.equal(companyRows.length, 2);
    assert.deepEqual(companyRows.map((row) => row.label), [
      'Gulf Coast Hotels · All hotels',
      'Sunbelt Lodging · All hotels',
    ]);
    assert.equal(rows[rows.length - 1].kind, 'hotel', 'companies read before buildings');
    assert.equal(rows.some((row) => row.active), false, 'nothing is on until something is chosen');
  });

  test('exactly one row is on, and selection round-trips through the opaque key', () => {
    const scope = resolvedCompanyScope();
    const rows = buildScopeSwitcherRows({
      companies: [
        { organizationId: GULF_COAST, organizationName: 'Gulf Coast Hotels' },
        { organizationId: SUNBELT, organizationName: 'Sunbelt Lodging' },
      ],
      hotels: [
        { id: HOTEL_A, name: 'Hotel A' },
        { id: HOTEL_B, name: 'Hotel B' },
      ],
      activeScope: scope,
    });
    assert.equal(rows.filter((row) => row.active).length, 1);
    const key = activeScopeSwitcherKey(rows);
    assert.ok(key);
    const round = scopeSwitcherRowForKey(rows, key);
    assert.equal(round?.kind, 'company');
    assert.equal(round?.kind === 'company' ? round.organizationId : null, GULF_COAST);
    assert.equal(
      scopeSwitcherRowForKey(rows, 'company:' + SUNBELT.replace('3', '9')),
      null,
      'an unknown key is refused, never parsed into a scope',
    );
  });

  test('the active hotel row is the one the scope names', () => {
    const rows = buildScopeSwitcherRows({
      companies: [{ organizationId: GULF_COAST, organizationName: 'Gulf Coast Hotels' }],
      hotels: [{ id: HOTEL_A, name: 'Hotel A' }, { id: HOTEL_B, name: 'Hotel B' }],
      activeScope: { kind: 'hotel', propertyId: HOTEL_B },
    });
    const active = rows.filter((row) => row.active);
    assert.equal(active.length, 1);
    assert.equal(active[0].kind === 'hotel' ? active[0].propertyId : null, HOTEL_B);
  });

  test('duplicate coverage rows collapse instead of offering the same place twice', () => {
    const rows = buildScopeSwitcherRows({
      companies: [
        { organizationId: GULF_COAST, organizationName: 'Gulf Coast Hotels' },
        { organizationId: GULF_COAST.toUpperCase(), organizationName: 'Gulf Coast Hotels' },
      ],
      hotels: [{ id: HOTEL_A, name: 'Hotel A' }, { id: HOTEL_A, name: 'Hotel A' }],
      activeScope: UNRESOLVED_LOADING,
    });
    assert.equal(rows.length, 2);
  });
});

describe('entry rerouting away from the standalone portfolio world', () => {
  function selection(overrides: Partial<PortfolioUiSelection>): PortfolioUiSelection {
    return {
      requestedOrganizationId: null,
      selectedOrganizationId: null,
      state: 'hotel_only',
      ...overrides,
    };
  }

  test('one authorized company enters the app in company scope, not /portfolio', () => {
    const destination = companyEntryDestination(selection({
      state: 'selected',
      selectedOrganizationId: GULF_COAST,
    }));
    assert.equal(destination, companyScopeHref('/home', GULF_COAST));
    assert.match(destination ?? '', /^\/home\?/);
    assert.doesNotMatch(destination ?? '', /\/portfolio/);
  });

  test('several companies land on Home, where the switcher does the picking', () => {
    const destination = companyEntryDestination(selection({ state: 'needs_selection' }));
    assert.equal(destination, '/home');
    assert.doesNotMatch(destination ?? '', /choose/);
  });

  test('a hotel-only account is not rerouted at all', () => {
    assert.equal(companyEntryDestination(selection({ state: 'hotel_only' })), null);
    assert.equal(companyEntryDestination(null), null);
  });

  test('no entry destination this module can produce names the old world', () => {
    const destinations = [
      companyEntryDestination(selection({ state: 'selected', selectedOrganizationId: GULF_COAST })),
      companyEntryDestination(selection({ state: 'needs_selection' })),
      companyScopeHref('/dashboard', GULF_COAST),
      localAppHref('/dashboard'),
    ].filter((value): value is string => value !== null);
    for (const destination of destinations) {
      assert.doesNotMatch(destination, /\/portfolio/, destination);
    }
  });

  test('leaving company mode strips the scope instead of carrying it into a hotel', () => {
    const companyUrl = companyScopeHref('/dashboard', GULF_COAST);
    const [, search] = companyUrl.split('?');
    assert.equal(localAppHref('/dashboard', search), '/dashboard');
    assert.equal(
      localAppHref('/dashboard', `${search}&status=attention`),
      '/dashboard?status=attention',
      'unrelated filters survive the scope change',
    );
  });
});

describe('Home entry decision', () => {
  const base = {
    authLoading: false,
    propertyLoading: false,
    portfolioEntryPending: false,
    signedIn: true,
    scope: UNRESOLVED_LOADING,
    companyOptionCount: 0,
  };

  test('a company scope renders here and is never redirected away', () => {
    assert.deepEqual(
      resolveHomeEntry({ ...base, scope: resolvedCompanyScope() }),
      { kind: 'company' },
    );
    // Even mid-load: the scope is already known, so there is nothing to wait for.
    assert.deepEqual(
      resolveHomeEntry({
        ...base,
        propertyLoading: true,
        portfolioEntryPending: true,
        scope: resolvedCompanyScope(),
      }),
      { kind: 'company' },
    );
  });

  test('a company leader with several companies picks here, not in another world', () => {
    assert.deepEqual(
      resolveHomeEntry({
        ...base,
        scope: { kind: 'unresolved', reason: 'no_selection' },
        companyOptionCount: 2,
      }),
      { kind: 'choose_scope' },
    );
  });

  test('a hotel-only account keeps the hotel picker as its door', () => {
    assert.deepEqual(
      resolveHomeEntry({ ...base, scope: { kind: 'unresolved', reason: 'no_selection' } }),
      { kind: 'property_selector' },
    );
    assert.deepEqual(
      resolveHomeEntry({
        ...base,
        scope: { kind: 'unresolved', reason: 'selection_unavailable' },
      }),
      { kind: 'property_selector' },
    );
  });

  test('nothing is decided while the scope is still settling', () => {
    assert.deepEqual(resolveHomeEntry({ ...base, authLoading: true }), { kind: 'wait' });
    assert.deepEqual(resolveHomeEntry({ ...base, propertyLoading: true }), { kind: 'wait' });
    assert.deepEqual(resolveHomeEntry({ ...base, portfolioEntryPending: true }), { kind: 'wait' });
    assert.deepEqual(
      resolveHomeEntry({ ...base, scope: UNRESOLVED_LOADING, companyOptionCount: 3 }),
      { kind: 'wait' },
      'a loading scope must not flash the picker at somebody who already chose',
    );
  });

  test('a signed-out visitor goes to sign in', () => {
    assert.deepEqual(resolveHomeEntry({ ...base, signedIn: false }), { kind: 'signin' });
  });

  test('a resolved hotel renders the hub', () => {
    assert.deepEqual(
      resolveHomeEntry({ ...base, scope: { kind: 'hotel', propertyId: HOTEL_A } }),
      { kind: 'hotel' },
    );
  });
});
