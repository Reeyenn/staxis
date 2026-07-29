import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_PORTFOLIO_HOTEL_CARDS,
  PORTFOLIO_UI_ROUTE_PATHS,
  buildPortfolioHotelLabels,
  buildPortfolioHotelSecondaryLabels,
  buildPortfolioUiUrl,
  contextForAuthorizedOption,
  decidePortfolioUiEntry,
  filterPortfolioHotelCards,
  isPortfolioUiUuid,
  listPortfolioHotelRegions,
  mapPortfolioUiRoute,
  normalizeSameOriginAppPath,
  paginatePortfolioHotelCards,
  parsePortfolioUiContext,
  queryPortfolioHotelCards,
  sortPortfolioHotelCards,
  type AuthorizedHotelOption,
  type AuthorizedPortfolioOption,
  type AuthorizedRegionOption,
  type AuthorizedSelectedHotelsOption,
  type PortfolioHotelCard,
  type PortfolioUiContextParseErrorCode,
  type PortfolioUiRoute,
} from '@/lib/portfolio-ui/context';

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const HOTEL_A = '11111111-0000-4000-8000-000000000001';
const HOTEL_B = '22222222-0000-4000-8000-000000000002';
const HOTEL_C = '33333333-0000-4000-8000-000000000003';
const HOTEL_D = '44444444-0000-4000-8000-000000000004';
const REGION_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const PORTFOLIO_A = 'aaaaaaaa-2222-4000-8000-000000000001';
const DESCRIPTOR_A = 'aaaaaaaa-3333-4000-8000-000000000001';

function portfolio(
  organizationId = ORG_A,
  companyName = 'Gulf Coast Hotels',
): AuthorizedPortfolioOption {
  return { scope: 'portfolio', organizationId, companyName };
}

function hotel(
  propertyId = HOTEL_A,
  hotelName = 'Beaumont Suites',
): AuthorizedHotelOption {
  return { scope: 'hotel', propertyId, hotelName, city: 'Beaumont', region: 'Texas' };
}

function region(
  portfolioId = REGION_A,
  regionName = 'North Texas',
): AuthorizedRegionOption {
  return {
    scope: 'region',
    organizationId: ORG_A,
    portfolioId,
    companyName: 'Gulf Coast Hotels',
    regionName,
  };
}

function selectedHotels(
  descriptorId = DESCRIPTOR_A,
  descriptorName = 'Selected hotels (3)',
): AuthorizedSelectedHotelsOption {
  return {
    scope: 'selected_hotels',
    organizationId: ORG_A,
    descriptorId,
    companyName: 'Gulf Coast Hotels',
    descriptorName,
  };
}

function card(
  propertyId: string,
  name: string,
  overrides: Partial<PortfolioHotelCard> = {},
): PortfolioHotelCard {
  return {
    propertyId,
    name,
    city: 'Beaumont',
    region: 'Texas',
    status: 'active',
    ...overrides,
  };
}

function numberedUuid(index: number): string {
  return `90000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function numberedCards(count: number): PortfolioHotelCard[] {
  return Array.from({ length: count }, (_, index) => card(
    numberedUuid(index + 1),
    `Hotel ${String(index + 1).padStart(2, '0')}`,
    {
      city: `City ${index + 1}`,
      region: index % 2 === 0 ? 'North' : 'South',
      status: index % 2 === 0 ? 'active' : 'inactive',
    },
  ));
}

function expectParseError(
  input: string | URLSearchParams,
  error: PortfolioUiContextParseErrorCode,
  key?: string,
): void {
  const result = parsePortfolioUiContext(input);
  assert.equal(result.ok, false, `expected ${error} for ${String(input)}`);
  if (result.ok) return;
  assert.equal(result.error, error);
  assert.equal(result.key, key);
}

describe('portfolio entry decision', () => {
  test('zero authorized contexts is explicitly unavailable', () => {
    assert.deepEqual(decidePortfolioUiEntry([]), { kind: 'unavailable' });
  });

  test('exactly one portfolio and no hotel-only scope enters the portfolio', () => {
    assert.deepEqual(decidePortfolioUiEntry([portfolio()]), {
      kind: 'portfolio',
      option: portfolio(),
    });
  });

  test('duplicate grants for the same portfolio do not manufacture a chooser', () => {
    const decision = decidePortfolioUiEntry([
      portfolio(ORG_A.toUpperCase(), ' Gulf Coast Hotels '),
      portfolio(ORG_A, 'Duplicate grant label'),
    ]);
    assert.deepEqual(decision, {
      kind: 'portfolio',
      option: portfolio(),
    });
  });

  test('multiple companies require the context chooser', () => {
    const decision = decidePortfolioUiEntry([
      portfolio(ORG_A, 'Gulf Coast Hotels'),
      portfolio(ORG_B, 'Piney Woods Group'),
    ]);
    assert.equal(decision.kind, 'chooser');
    if (decision.kind !== 'chooser') return;
    assert.equal(decision.chooser, 'context');
    assert.equal(decision.options.length, 2);
  });

  test('a portfolio plus any legitimate hotel-only scope requires the context chooser', () => {
    const decision = decidePortfolioUiEntry([portfolio(), hotel()]);
    assert.equal(decision.kind, 'chooser');
    if (decision.kind !== 'chooser') return;
    assert.equal(decision.chooser, 'context');
    assert.deepEqual(decision.options.map((option) => option.scope), ['portfolio', 'hotel']);
  });

  test('one hotel with no portfolio enters that hotel', () => {
    assert.deepEqual(decidePortfolioUiEntry([hotel()]), {
      kind: 'hotel',
      option: hotel(),
    });
  });

  test('one authoritative region scope enters that region', () => {
    assert.deepEqual(decidePortfolioUiEntry([region()]), {
      kind: 'region',
      option: region(),
    });
  });

  test('one authoritative selected-hotels scope enters that exact scope', () => {
    assert.deepEqual(decidePortfolioUiEntry([selectedHotels()]), {
      kind: 'selected_hotels',
      option: selectedHotels(),
    });
  });

  test('a selected-hotels descriptor plus another hat requires a context choice', () => {
    const decision = decidePortfolioUiEntry([selectedHotels(), hotel()]);
    assert.equal(decision.kind, 'chooser');
    if (decision.kind !== 'chooser') return;
    assert.equal(decision.chooser, 'context');
  });

  test('company and region scopes stay visibly distinct', () => {
    const decision = decidePortfolioUiEntry([portfolio(), region()]);
    assert.equal(decision.kind, 'chooser');
    if (decision.kind !== 'chooser') return;
    assert.equal(decision.chooser, 'context');
    assert.deepEqual(decision.options.map((option) => option.scope), ['portfolio', 'region']);
  });

  test('several hotels with no portfolio require the hotel chooser', () => {
    const decision = decidePortfolioUiEntry([
      hotel(HOTEL_A, 'Beaumont Suites'),
      hotel(HOTEL_B, 'Lufkin Inn'),
    ]);
    assert.equal(decision.kind, 'chooser');
    if (decision.kind !== 'chooser') return;
    assert.equal(decision.chooser, 'hotel');
    assert.equal(decision.options.length, 2);
  });

  test('duplicate hotel grants collapse before the one-hotel decision', () => {
    const decision = decidePortfolioUiEntry([
      hotel(HOTEL_A.toUpperCase(), ' Beaumont Suites '),
      hotel(HOTEL_A, 'Duplicate label'),
    ]);
    assert.deepEqual(decision, { kind: 'hotel', option: hotel() });
  });

  test('authorized option ids and labels are validated at the boundary', () => {
    assert.throws(
      () => decidePortfolioUiEntry([portfolio('not-a-uuid')]),
      /organizationId must be a valid UUID/,
    );
    assert.throws(
      () => decidePortfolioUiEntry([hotel('00000000-0000-0000-0000-000000000000')]),
      /propertyId must be a valid UUID/,
    );
    assert.throws(
      () => decidePortfolioUiEntry([portfolio(ORG_A, '   ')]),
      /companyName must be a non-empty string/,
    );
  });

  test('authorized options map to the minimal URL context', () => {
    assert.deepEqual(contextForAuthorizedOption(portfolio()), {
      scope: 'portfolio',
      organizationId: ORG_A,
    });
    assert.deepEqual(contextForAuthorizedOption(hotel()), {
      scope: 'hotel',
      propertyId: HOTEL_A,
    });
    assert.deepEqual(contextForAuthorizedOption(region()), {
      scope: 'region',
      organizationId: ORG_A,
      portfolioId: REGION_A,
    });
    assert.deepEqual(contextForAuthorizedOption(selectedHotels()), {
      scope: 'selected_hotels',
      organizationId: ORG_A,
      descriptorId: DESCRIPTOR_A,
    });
    assert.deepEqual(contextForAuthorizedOption({
      ...portfolio(),
      portfolioId: PORTFOLIO_A,
      portfolioName: 'Operations portfolio',
    }), {
      scope: 'portfolio',
      organizationId: ORG_A,
      portfolioId: PORTFOLIO_A,
    });
  });
});

describe('strict context URL parsing and building', () => {
  test('recognizes well-formed RFC-style UUIDs and rejects malformed shapes', () => {
    assert.equal(isPortfolioUiUuid(ORG_A), true);
    assert.equal(isPortfolioUiUuid(ORG_A.toUpperCase()), true);
    for (const value of [
      null,
      '',
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000',
      'aaaaaaaa-0000-4000-7000-000000000001',
      'aaaaaaaa000040008000000000000001',
    ]) {
      assert.equal(isPortfolioUiUuid(value), false, String(value));
    }
  });

  test('portfolio URLs round-trip, normalize ids, and preserve duplicate filters', () => {
    const built = buildPortfolioUiUrl(
      '/feed',
      { scope: 'portfolio', organizationId: ORG_A.toUpperCase() },
      {
        existing: '?view=queue&tag=urgent&tag=aging',
        returnTo: '/home?view=brief#morning',
      },
    );
    assert.equal(
      built,
      `/feed?view=queue&tag=urgent&tag=aging&scope=portfolio&organizationId=${ORG_A}`
        + '&returnTo=%2Fhome%3Fview%3Dbrief%23morning',
    );

    const parsed = parsePortfolioUiContext(built);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.context, { scope: 'portfolio', organizationId: ORG_A });
    assert.equal(parsed.value.returnTo, '/home?view=brief#morning');
    assert.deepEqual(parsed.value.filters, [
      ['view', 'queue'],
      ['tag', 'urgent'],
      ['tag', 'aging'],
    ]);
  });

  test('named portfolio URLs retain the native portfolio selector', () => {
    const built = buildPortfolioUiUrl('/dashboard', {
      scope: 'portfolio',
      organizationId: ORG_A,
      portfolioId: PORTFOLIO_A,
    });
    assert.equal(
      built,
      `/dashboard?scope=portfolio&organizationId=${ORG_A}&portfolioId=${PORTFOLIO_A}`,
    );
    const parsed = parsePortfolioUiContext(built);
    assert.deepEqual(parsed, {
      ok: true,
      value: {
        context: {
          scope: 'portfolio',
          organizationId: ORG_A,
          portfolioId: PORTFOLIO_A,
        },
        returnTo: null,
        filters: [],
      },
    });
  });

  test('selected-hotel URLs carry only the opaque descriptor id', () => {
    const built = buildPortfolioUiUrl('/maintenance', {
      scope: 'selected_hotels',
      organizationId: ORG_A,
      descriptorId: DESCRIPTOR_A,
    });
    assert.equal(
      built,
      `/maintenance?scope=selected_hotels&organizationId=${ORG_A}&descriptorId=${DESCRIPTOR_A}`,
    );
    assert.doesNotMatch(built, /propertyId/);
    const parsed = parsePortfolioUiContext(built);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.context, {
      scope: 'selected_hotels',
      organizationId: ORG_A,
      descriptorId: DESCRIPTOR_A,
    });
  });

  test('selected-hotel parsing rejects stale client-carried hotel ids and duplicate descriptors', () => {
    expectParseError(
      `?scope=selected_hotels&organizationId=${ORG_A}&descriptorId=${DESCRIPTOR_A}&propertyId=${HOTEL_A}`,
      'unexpected_property_id',
      'propertyId',
    );
    expectParseError(
      `?scope=selected_hotels&organizationId=${ORG_A}&descriptorId=${DESCRIPTOR_A}&descriptorId=${REGION_A}`,
      'duplicate_reserved_key',
      'descriptorId',
    );
  });

  test('hotel URLs round-trip from URLSearchParams', () => {
    const existing = new URLSearchParams([['tab', 'today'], ['q', 'room 101']]);
    const built = buildPortfolioUiUrl(
      '/housekeeping',
      { scope: 'hotel', propertyId: HOTEL_A, organizationId: ORG_A },
      { existing },
    );
    assert.equal(
      built,
      `/housekeeping?tab=today&q=room+101&scope=hotel&propertyId=${HOTEL_A}&organizationId=${ORG_A}`,
    );
    const parsed = parsePortfolioUiContext(built);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.context, {
      scope: 'hotel', propertyId: HOTEL_A, organizationId: ORG_A,
    });
    assert.equal(parsed.value.returnTo, null);
    assert.deepEqual(parsed.value.filters, [['tab', 'today'], ['q', 'room 101']]);
  });

  test('portfolio-origin hotel URLs preserve one opaque narrowed-parent selector', () => {
    const namedPortfolio = buildPortfolioUiUrl('/financials', {
      scope: 'hotel',
      propertyId: HOTEL_A,
      organizationId: ORG_A,
      portfolioId: PORTFOLIO_A,
    });
    assert.equal(
      namedPortfolio,
      `/financials?scope=hotel&propertyId=${HOTEL_A}&organizationId=${ORG_A}`
        + `&portfolioId=${PORTFOLIO_A}`,
    );
    const selected = buildPortfolioUiUrl('/home', {
      scope: 'hotel',
      propertyId: HOTEL_A,
      organizationId: ORG_A,
      descriptorId: DESCRIPTOR_A,
    });
    const parsed = parsePortfolioUiContext(selected);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.context, {
      scope: 'hotel',
      propertyId: HOTEL_A,
      organizationId: ORG_A,
      descriptorId: DESCRIPTOR_A,
    });
  });

  test('region URLs round-trip with an authoritative descriptor id', () => {
    const built = buildPortfolioUiUrl(
      '/maintenance',
      { scope: 'region', organizationId: ORG_A, portfolioId: REGION_A },
      { existing: '?status=open&sort=aging' },
    );
    assert.equal(
      built,
      `/maintenance?status=open&sort=aging&scope=region&organizationId=${ORG_A}&portfolioId=${REGION_A}`,
    );
    const parsed = parsePortfolioUiContext(built);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.context, {
      scope: 'region',
      organizationId: ORG_A,
      portfolioId: REGION_A,
    });
  });

  test('building replaces every stale reserved key but preserves unrelated state and hash', () => {
    const built = buildPortfolioUiUrl(
      '/financials',
      { scope: 'portfolio', organizationId: ORG_B },
      {
        existing:
          `/company?tab=people&scope=hotel&propertyId=${HOTEL_A}`
          + `&organizationId=${ORG_A}&returnTo=%2Fold&tag=a&tag=b#members`,
      },
    );
    const url = new URL(built, 'https://example.test');
    assert.equal(url.pathname, '/financials');
    assert.equal(url.hash, '#members');
    assert.equal(url.searchParams.get('tab'), 'people');
    assert.deepEqual(url.searchParams.getAll('tag'), ['a', 'b']);
    assert.equal(url.searchParams.get('scope'), 'portfolio');
    assert.equal(url.searchParams.get('organizationId'), ORG_B);
    assert.equal(url.searchParams.has('propertyId'), false);
    assert.equal(url.searchParams.has('returnTo'), false);
  });

  test('all supported routes map to their canonical path and retain filters', () => {
    for (const [route, pathname] of Object.entries(PORTFOLIO_UI_ROUTE_PATHS)) {
      const built = mapPortfolioUiRoute(
        route as PortfolioUiRoute,
        { scope: 'hotel', propertyId: HOTEL_B },
        { existing: '?view=calendar&status=open&page=3' },
      );
      const url = new URL(built, 'https://example.test');
      assert.equal(url.pathname, pathname, route);
      assert.equal(url.searchParams.get('view'), 'calendar', route);
      assert.equal(url.searchParams.get('status'), 'open', route);
      assert.equal(url.searchParams.get('page'), '3', route);
      assert.equal(url.searchParams.get('scope'), 'hotel', route);
      assert.equal(url.searchParams.get('propertyId'), HOTEL_B, route);
    }
  });

  test('parse rejects every incomplete, conflicting, or duplicated context shape', () => {
    expectParseError('?organizationId=' + ORG_A, 'missing_scope', 'scope');
    expectParseError('?scope=company&organizationId=' + ORG_A, 'invalid_scope', 'scope');
    expectParseError('?scope=portfolio', 'missing_organization_id', 'organizationId');
    expectParseError(
      '?scope=portfolio&organizationId=bad',
      'invalid_organization_id',
      'organizationId',
    );
    expectParseError(
      `?scope=portfolio&organizationId=${ORG_A}&propertyId=${HOTEL_A}`,
      'unexpected_property_id',
      'propertyId',
    );
    expectParseError(
      `?scope=portfolio&organizationId=${ORG_A}&portfolioId=bad`,
      'invalid_portfolio_id',
      'portfolioId',
    );
    expectParseError('?scope=region', 'missing_organization_id', 'organizationId');
    expectParseError(
      `?scope=region&organizationId=${ORG_A}`,
      'missing_portfolio_id',
      'portfolioId',
    );
    expectParseError(
      `?scope=region&organizationId=${ORG_A}&portfolioId=bad`,
      'invalid_portfolio_id',
      'portfolioId',
    );
    expectParseError(
      `?scope=region&organizationId=${ORG_A}&portfolioId=${REGION_A}&propertyId=${HOTEL_A}`,
      'unexpected_property_id',
      'propertyId',
    );
    expectParseError('?scope=hotel', 'missing_property_id', 'propertyId');
    expectParseError('?scope=hotel&propertyId=bad', 'invalid_property_id', 'propertyId');
    expectParseError(
      `?scope=hotel&propertyId=${HOTEL_A}&organizationId=bad`,
      'invalid_organization_id',
      'organizationId',
    );
    expectParseError(
      `?scope=hotel&propertyId=${HOTEL_A}&portfolioId=${REGION_A}`,
      'missing_organization_id',
      'organizationId',
    );
    expectParseError(
      `?scope=hotel&propertyId=${HOTEL_A}&organizationId=${ORG_A}`
        + `&portfolioId=${REGION_A}&descriptorId=${DESCRIPTOR_A}`,
      'unexpected_descriptor_id',
      'descriptorId',
    );
    expectParseError(
      `?scope=hotel&scope=hotel&propertyId=${HOTEL_A}`,
      'duplicate_reserved_key',
      'scope',
    );
    expectParseError(
      `?scope=hotel&propertyId=${HOTEL_A}&propertyId=${HOTEL_B}`,
      'duplicate_reserved_key',
      'propertyId',
    );
    expectParseError(
      `?scope=hotel&propertyId=${HOTEL_A}&returnTo=%2Fhome&returnTo=%2Ffeed`,
      'duplicate_reserved_key',
      'returnTo',
    );
  });

  test('return targets are rooted same-origin app paths only', () => {
    assert.equal(
      normalizeSameOriginAppPath('/communications?view=calendar#today'),
      '/communications?view=calendar#today',
    );
    assert.equal(normalizeSameOriginAppPath('/one/../home?x=1'), '/home?x=1');

    for (const unsafe of [
      '',
      'home',
      'https://evil.example/home',
      'https://staxis-app.invalid/home',
      '//evil.example/home',
      'javascript:alert(1)',
      '/\\evil.example/home',
      '/%2f%2fevil.example/home',
      '/%5cevil.example/home',
      '/bad%',
      ' /home',
      '/home\n',
    ]) {
      assert.equal(normalizeSameOriginAppPath(unsafe), null, unsafe);
    }
  });

  test('parse rejects external, relative, empty, and encoded redirect targets', () => {
    for (const returnTo of [
      'https://evil.example/home',
      '//evil.example/home',
      'home',
      '',
      '/%2f%2fevil.example/home',
    ]) {
      const params = new URLSearchParams({
        scope: 'portfolio',
        organizationId: ORG_A,
        returnTo,
      });
      expectParseError(params, 'invalid_return_to', 'returnTo');
    }
  });

  test('builders reject malformed ids, unsafe targets, unsafe existing URLs, and bad returns', () => {
    assert.throws(
      () => buildPortfolioUiUrl('/home', { scope: 'portfolio', organizationId: 'bad' }),
      /organizationId must be a valid UUID/,
    );
    assert.throws(
      () => buildPortfolioUiUrl('/home?x=1', { scope: 'portfolio', organizationId: ORG_A }),
      /must not contain query parameters/,
    );
    assert.throws(
      () => buildPortfolioUiUrl('//evil.example', { scope: 'portfolio', organizationId: ORG_A }),
      /same-origin app path/,
    );
    assert.throws(
      () => buildPortfolioUiUrl('/home', { scope: 'hotel', propertyId: HOTEL_A }, {
        existing: 'https://evil.example/?x=1',
      }),
      /existing location must be an app URL/,
    );
    assert.throws(
      () => buildPortfolioUiUrl('/home', { scope: 'hotel', propertyId: HOTEL_A }, {
        returnTo: '//evil.example',
      }),
      /returnTo must be a same-origin app path/,
    );
    assert.throws(
      () => buildPortfolioUiUrl('/home', {
        scope: 'hotel', propertyId: HOTEL_A, portfolioId: PORTFOLIO_A,
      }),
      /parent selector requires organizationId/,
    );
    assert.throws(
      () => buildPortfolioUiUrl('/home', {
        scope: 'hotel', propertyId: HOTEL_A, organizationId: ORG_A,
        portfolioId: PORTFOLIO_A, descriptorId: DESCRIPTOR_A,
      }),
      /only one parent selector/,
    );
    assert.throws(
      () => mapPortfolioUiRoute(
        'unknown' as PortfolioUiRoute,
        { scope: 'hotel', propertyId: HOTEL_A },
      ),
      /unknown portfolio UI route/,
    );
  });

  test('parse rejects an external location before reading a plausible query', () => {
    expectParseError(
      `https://evil.example/?scope=hotel&propertyId=${HOTEL_A}`,
      'invalid_location',
    );
  });
});

describe('duplicate-safe hotel labels', () => {
  test('unique hotel names remain plain', () => {
    const labels = buildPortfolioHotelLabels([
      card(HOTEL_A, 'Beaumont Suites'),
      card(HOTEL_B, 'Lufkin Inn'),
    ]);
    assert.equal(labels[HOTEL_A], 'Beaumont Suites');
    assert.equal(labels[HOTEL_B], 'Lufkin Inn');
  });

  test('duplicate names use city and region when those distinguish them', () => {
    const labels = buildPortfolioHotelLabels([
      card(HOTEL_A, 'Springfield Suites', { city: 'Springfield', region: 'Illinois' }),
      card(HOTEL_B, 'Springfield Suites', { city: 'Springfield', region: 'Missouri' }),
    ]);
    assert.equal(labels[HOTEL_A], 'Springfield Suites — Springfield, Illinois');
    assert.equal(labels[HOTEL_B], 'Springfield Suites — Springfield, Missouri');
  });

  test('same-name same-location hotels append a collision-safe short id', () => {
    const labels = buildPortfolioHotelLabels([
      card(HOTEL_A, 'Airport Inn', { city: 'Austin', region: 'Texas' }),
      card(HOTEL_B, 'Airport Inn', { city: 'Austin', region: 'Texas' }),
    ]);
    assert.equal(labels[HOTEL_A], 'Airport Inn — Austin, Texas · 11111111');
    assert.equal(labels[HOTEL_B], 'Airport Inn — Austin, Texas · 22222222');
    assert.notEqual(labels[HOTEL_A], labels[HOTEL_B]);
  });

  test('shared secondary labels disambiguate identical name and hint everywhere', () => {
    const labels = buildPortfolioHotelSecondaryLabels([
      { propertyId: HOTEL_A, name: 'Airport Inn', city: 'Austin', region: 'Texas' },
      { propertyId: HOTEL_B, name: 'Airport Inn', city: 'Austin', region: 'Texas' },
      { propertyId: HOTEL_C, name: 'Harbor Hotel' },
    ]);
    assert.equal(labels[HOTEL_A], 'Austin, Texas · 11111111');
    assert.equal(labels[HOTEL_B], 'Austin, Texas · 22222222');
    assert.equal(labels[HOTEL_C], 'Hotel 33333333');
  });

  test('missing locations fall back to ids, with case and whitespace names deduplicated', () => {
    const labels = buildPortfolioHotelLabels([
      card(HOTEL_C, '  Harbor Hotel ', { city: null, region: null }),
      card(HOTEL_D, 'harbor   hotel', { city: '', region: '' }),
    ]);
    assert.equal(labels[HOTEL_C], 'Harbor Hotel — 33333333');
    assert.equal(labels[HOTEL_D], 'harbor   hotel — 44444444');
  });
});

describe('bounded hotel-card search, filters, regions, and sorting', () => {
  const cards: readonly PortfolioHotelCard[] = [
    card(HOTEL_A, 'São Paulo South', {
      city: 'São Paulo', region: 'Brazil', status: 'active',
    }),
    card(HOTEL_B, 'Austin Central', {
      city: 'Austin', region: 'Texas', status: 'pending',
    }),
    card(HOTEL_C, 'Dallas North', {
      city: 'Dallas', region: 'texas', status: 'inactive',
    }),
    card(HOTEL_D, 'Mountain Lodge', {
      city: 'Denver', region: null, status: 'suspended',
    }),
  ];

  test('search is accent-insensitive, tokenized, and includes location and ids', () => {
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { search: 'sao south' }).map((item) => item.propertyId),
      [HOTEL_A],
    );
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { search: 'texas austin' }).map((item) => item.propertyId),
      [HOTEL_B],
    );
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { search: '33333333' }).map((item) => item.propertyId),
      [HOTEL_C],
    );
  });

  test('status supports exact and truthful not-active filtering', () => {
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { status: 'active' }).map((item) => item.propertyId),
      [HOTEL_A],
    );
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { status: 'not_active' }).map((item) => item.propertyId),
      [HOTEL_B, HOTEL_C, HOTEL_D],
    );
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { status: 'pending' }).map((item) => item.propertyId),
      [HOTEL_B],
    );
  });

  test('region matching and region options are case-insensitive and stable', () => {
    assert.deepEqual(
      filterPortfolioHotelCards(cards, { region: 'TEXAS' }).map((item) => item.propertyId),
      [HOTEL_B, HOTEL_C],
    );
    assert.deepEqual(listPortfolioHotelRegions(cards), ['Brazil', 'Texas']);
  });

  test('name sorting is deterministic and does not mutate the source array', () => {
    const sourceOrder = cards.map((item) => item.propertyId);
    assert.deepEqual(
      sortPortfolioHotelCards(cards, 'name_asc').map((item) => item.name),
      ['Austin Central', 'Dallas North', 'Mountain Lodge', 'São Paulo South'],
    );
    assert.deepEqual(
      sortPortfolioHotelCards(cards, 'name_desc').map((item) => item.name),
      ['São Paulo South', 'Mountain Lodge', 'Dallas North', 'Austin Central'],
    );
    assert.deepEqual(cards.map((item) => item.propertyId), sourceOrder);
  });

  test('region sorting keeps missing regions last in both directions', () => {
    assert.deepEqual(
      sortPortfolioHotelCards(cards, 'region_asc').map((item) => item.propertyId),
      [HOTEL_A, HOTEL_B, HOTEL_C, HOTEL_D],
    );
    assert.deepEqual(
      sortPortfolioHotelCards(cards, 'region_desc').map((item) => item.propertyId),
      [HOTEL_B, HOTEL_C, HOTEL_A, HOTEL_D],
    );
  });

  test('status sorting follows the published operational order', () => {
    assert.deepEqual(
      sortPortfolioHotelCards(cards, 'status_asc').map((item) => item.status),
      ['active', 'pending', 'inactive', 'suspended'],
    );
    assert.deepEqual(
      sortPortfolioHotelCards(cards, 'status_desc').map((item) => item.status),
      ['suspended', 'inactive', 'pending', 'active'],
    );
  });

  test('unknown runtime filter and sort values fail loudly', () => {
    assert.throws(
      () => filterPortfolioHotelCards(cards, { status: 'closed' as 'active' }),
      /unknown hotel status filter/,
    );
    assert.throws(
      () => sortPortfolioHotelCards(cards, 'distance_asc' as 'name_asc'),
      /unknown hotel sort/,
    );
  });
});

describe('hotel-card pagination and the 50-card ceiling', () => {
  test('paginates deterministically with complete metadata', () => {
    const cards = numberedCards(25);
    const result = paginatePortfolioHotelCards(cards, 2, 10);
    assert.deepEqual(result.items.map((item) => item.name), [
      'Hotel 11', 'Hotel 12', 'Hotel 13', 'Hotel 14', 'Hotel 15',
      'Hotel 16', 'Hotel 17', 'Hotel 18', 'Hotel 19', 'Hotel 20',
    ]);
    assert.deepEqual({
      page: result.page,
      pageSize: result.pageSize,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
      hasPreviousPage: result.hasPreviousPage,
      hasNextPage: result.hasNextPage,
    }, {
      page: 2,
      pageSize: 10,
      totalItems: 25,
      totalPages: 3,
      hasPreviousPage: true,
      hasNextPage: true,
    });
  });

  test('an out-of-range page clamps to the last page without inventing blanks', () => {
    const result = paginatePortfolioHotelCards(numberedCards(25), 99, 10);
    assert.equal(result.page, 3);
    assert.deepEqual(result.items.map((item) => item.name), [
      'Hotel 21', 'Hotel 22', 'Hotel 23', 'Hotel 24', 'Hotel 25',
    ]);
    assert.equal(result.hasNextPage, false);
  });

  test('an empty result still has a usable first page', () => {
    assert.deepEqual(paginatePortfolioHotelCards([], 4, 12), {
      items: [],
      page: 1,
      pageSize: 12,
      totalItems: 0,
      totalPages: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    });
  });

  test('combined query filters, sorts, then paginates in that order', () => {
    const result = queryPortfolioHotelCards(numberedCards(20), {
      region: 'south',
      status: 'inactive',
      sort: 'name_desc',
      page: 2,
      pageSize: 3,
    });
    assert.equal(result.totalItems, 10);
    assert.deepEqual(result.items.map((item) => item.name), [
      'Hotel 14', 'Hotel 12', 'Hotel 10',
    ]);
  });

  test('fifty-plus cards remain queryable while one rendered page stays bounded', () => {
    const seventyFive = numberedCards(MAX_PORTFOLIO_HOTEL_CARDS + 25);
    assert.equal(filterPortfolioHotelCards(seventyFive).length, 75);
    const page = paginatePortfolioHotelCards(seventyFive, 2, MAX_PORTFOLIO_HOTEL_CARDS);
    assert.equal(page.totalItems, 75);
    assert.equal(page.totalPages, 2);
    assert.equal(page.items.length, 25);
  });

  test('invalid page controls, duplicate ids, malformed ids, and statuses fail loudly', () => {
    assert.throws(() => paginatePortfolioHotelCards(numberedCards(2), 0, 10), /positive integer/);
    assert.throws(() => paginatePortfolioHotelCards(numberedCards(2), 1.5, 10), /positive integer/);
    assert.throws(() => paginatePortfolioHotelCards(numberedCards(2), 1, 0), /from 1 to 50/);
    assert.throws(() => paginatePortfolioHotelCards(numberedCards(2), 1, 51), /from 1 to 50/);
    assert.throws(
      () => buildPortfolioHotelLabels([
        card(HOTEL_A, 'First'),
        card(HOTEL_A.toUpperCase(), 'Duplicate'),
      ]),
      /distinct propertyIds/,
    );
    assert.throws(
      () => buildPortfolioHotelLabels([card('not-a-uuid', 'Broken')]),
      /propertyId must be a valid UUID/,
    );
    assert.throws(
      () => filterPortfolioHotelCards([
        card(HOTEL_A, 'Broken', { status: 'closed' as 'active' }),
      ]),
      /unknown status/,
    );
  });
});
