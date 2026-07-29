import {
  portfolioQueryPlanSchema,
  type PlannedQuestion,
  type PlannerScopeCatalog,
  type PortfolioKnowledgeCategory,
  type PortfolioKnowledgeQuery,
  type PortfolioMetricId,
  type PortfolioScopeSelector,
} from './schemas';
import {
  MAX_EXACT_PORTFOLIO_PROPERTIES,
  PORTFOLIO_MAX_DETAIL_ROWS,
  PORTFOLIO_QUERY_PLAN_VERSION,
} from './versions';

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function displayHotel(hotel: PlannerScopeCatalog['hotels'][number]): string {
  const qualifier = [hotel.city, hotel.region, hotel.propertyCode].find((value) => value?.trim());
  return qualifier ? `${hotel.name} — ${qualifier}` : `${hotel.name} — ${hotel.propertyId.slice(0, 8)}`;
}

const KNOWLEDGE_STOP_WORDS = new Set([
  'about', 'across', 'all', 'approved', 'are', 'at', 'authorized', 'company', 'current', 'do',
  'does', 'for', 'hotel', 'hotels', 'in', 'is', 'local', 'my', 'notes', 'our',
  'portfolio', 'preferred', 'properties', 'property', 'rulebook', 'should', 'the',
  'their', 'this', 'use', 'uses', 'using', 'we', 'what', 'which', 'who', 'with',
]);

/** Closed, deterministic intent recognition for current company/property
 * reference knowledge. It never asks a model to select tenant ids or facts. */
function knowledgeQueryFor(question: string): PortfolioKnowledgeQuery | null {
  const q = normalized(question);
  const signalsKnowledge = /\b(?:vendor|vendors|supplier|suppliers|policy|policies|standard|standards|guideline|guidelines|procedure|procedures|rulebook|terminology|org chart|organization structure|organisational structure|reporting line|company notes|hotel notes|property notes|preferred vendor|approved vendor)\b/.test(q);
  if (!signalsKnowledge) return null;

  const categories = new Set<PortfolioKnowledgeCategory>();
  if (/\b(?:vendor|vendors|supplier|suppliers)\b/.test(q)) categories.add('vendors');
  if (/\b(?:policy|policies|standard|standards|guideline|guidelines|procedure|procedures|rulebook|terminology)\b/.test(q)) categories.add('standards');
  if (/\b(?:people|person|team|role|roles|org chart|organization structure|organisational structure|reporting line)\b/.test(q)) categories.add('people');
  if (/\b(?:guest|guests)\b/.test(q)) categories.add('guests');
  if (/\b(?:money|financial|finance|budget|budgets)\b/.test(q)) categories.add('money');
  if (/\b(?:room|rooms)\b/.test(q)) categories.add('rooms');
  if (/\b(?:rhythm|cadence|routine|routines)\b/.test(q)) categories.add('rhythm');

  const categoryWords = new Set([
    'vendor', 'vendors', 'supplier', 'suppliers', 'policy', 'policies', 'standard',
    'standards', 'guideline', 'guidelines', 'procedure', 'procedures', 'terminology',
    'people', 'person', 'team', 'role', 'roles', 'organization', 'organisational',
    'structure', 'reporting', 'line', 'guest', 'guests', 'money', 'financial',
    'finance', 'budget', 'budgets', 'room', 'rooms', 'rhythm', 'cadence', 'routine',
    'routines', 'chart',
  ]);
  const terms = [...new Set(q.split(' ')
    .filter((token) => token.length >= 2
      && token.length <= 48
      && !KNOWLEDGE_STOP_WORDS.has(token)
      && !categoryWords.has(token)))]
    .slice(0, 12);

  return { categories: [...categories].sort(), terms };
}

function explicitHotelMatch(question: string, catalog: PlannerScopeCatalog): PlannedQuestion | null {
  const q = normalized(question);
  let matches = catalog.hotels.filter((hotel) => {
    const name = normalized(hotel.name);
    return name.length >= 3 && (` ${q} `).includes(` ${name} `);
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const qualified = matches.filter((hotel) => [
      hotel.city,
      hotel.region,
      hotel.propertyCode,
      hotel.propertyId.slice(0, 8),
    ].some((value) => {
      const qualifier = normalized(value ?? '');
      return qualifier.length >= 2 && (` ${q} `).includes(` ${qualifier} `);
    }));
    if (qualified.length === 1) matches = qualified;
  }
  if (matches.length > 1) {
    return {
      ok: false,
      kind: 'clarification',
      message: 'More than one authorized hotel matches that name. Which one do you mean?',
      candidates: matches.map((hotel) => ({ propertyId: hotel.propertyId, label: displayHotel(hotel) })),
    };
  }
  return {
    ok: true,
    plan: portfolioQueryPlanSchema.parse({
      version: PORTFOLIO_QUERY_PLAN_VERSION,
      intent: 'property_drilldown',
      selector: { kind: 'hotel', propertyId: matches[0].propertyId },
      metricIds: [],
      window: { kind: 'hotel_business_today' },
      groupBy: 'property',
      comparison: 'none',
      detailLimit: 1,
      defaultedScope: false,
    }),
  };
}

/** Resolve a terse reply to a duplicate-name clarification without retaining
 * an invisible hotel id in conversation state. The reply must be an exact
 * authorized qualifier (for example, "the Austin one" or "DFW-02"), and it
 * must identify exactly one hotel in the caller's freshly resolved catalog. */
function qualifierOnlyHotelMatch(
  question: string,
  catalog: PlannerScopeCatalog,
): PlannedQuestion | null {
  const q = normalized(question);
  const qualifierForms = (value: string | null): string[] => {
    const qualifier = normalized(value ?? '');
    if (qualifier.length < 2) return [];
    return [qualifier, `${qualifier} one`, `the ${qualifier} one`, `in ${qualifier}`];
  };
  const matches = catalog.hotels.filter((hotel) => [
    hotel.city,
    hotel.region,
    hotel.propertyCode,
    hotel.propertyId.slice(0, 8),
  ].some((value) => qualifierForms(value).includes(q)));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return {
      ok: false,
      kind: 'clarification',
      message: 'That qualifier still matches more than one authorized hotel. Please use the hotel name and city, region, or property code.',
      candidates: matches.map((hotel) => ({ propertyId: hotel.propertyId, label: displayHotel(hotel) })),
    };
  }
  return {
    ok: true,
    plan: portfolioQueryPlanSchema.parse({
      version: PORTFOLIO_QUERY_PLAN_VERSION,
      intent: 'property_drilldown',
      selector: { kind: 'hotel', propertyId: matches[0].propertyId },
      metricIds: [],
      window: { kind: 'hotel_business_today' },
      groupBy: 'property',
      comparison: 'none',
      detailLimit: 1,
      defaultedScope: false,
    }),
  };
}

function explicitPortfolioMatch(
  question: string,
  catalog: PlannerScopeCatalog,
): { selector: PortfolioScopeSelector | null; ambiguousNames: string[] } {
  const q = normalized(question);
  const matches = catalog.portfolios.filter((portfolio) => {
    const name = normalized(portfolio.name);
    return name.length >= 3 && (` ${q} `).includes(` ${name} `);
  });
  return matches.length === 1
    ? { selector: { kind: 'portfolio', portfolioId: matches[0].portfolioId }, ambiguousNames: [] }
    : {
        selector: null,
        ambiguousNames: matches
          .map((item) => `${item.name} (${item.type}, ${item.portfolioId.slice(0, 8)})`)
          .sort(),
      };
}

/**
 * Deterministic, bounded first-pass planner. It recognizes the high-value
 * portfolio intents without asking a model to choose tenant IDs. Unrecognized
 * questions still go through the existing portfolio tool loop, but its tools
 * receive the same strict scope receipt and schemas.
 */
export function planPortfolioQuestion(
  question: string,
  catalog: PlannerScopeCatalog,
  requestedSelector?: PortfolioScopeSelector | null,
): PlannedQuestion {
  const q = normalized(question);
  const explicitAllScope = /\b(?:all my hotels|all authorized hotels|all hotels|across all|whole portfolio|entire portfolio|companywide|company wide)\b/.test(q);
  let namedHotel = explicitHotelMatch(question, catalog);
  if (namedHotel && !namedHotel.ok) return namedHotel;
  if (explicitAllScope && namedHotel?.ok) {
    return {
      ok: false,
      kind: 'clarification',
      message:
        'That question names both all authorized hotels and one hotel. Should I answer for the whole authorized portfolio or only the named hotel? I did not silently narrow “all hotels” to one property.',
    };
  }
  const namedPortfolio = explicitPortfolioMatch(question, catalog);
  if (!namedHotel && !namedPortfolio.selector && !explicitAllScope) {
    namedHotel = qualifierOnlyHotelMatch(question, catalog);
    if (namedHotel && !namedHotel.ok) return namedHotel;
  }
  if (!namedHotel) {
    const looksLikeUnmatchedSingleHotel = (
      /\b(?:at|for)\s+(?:the\s+)?(?!all\b)(?!my\s+hotels\b)(?!the\s+portfolio\b)[a-z0-9][a-z0-9 ]{2,}/.test(q)
      || /\bhotel\s+[a-z0-9][a-z0-9 ]{1,}/.test(q)
    ) && !/\b(?:hotels|properties)\b/.test(q);
    if (looksLikeUnmatchedSingleHotel) {
      return {
        ok: false,
        kind: 'clarification',
        message:
          'I could not match that name to exactly one hotel in your current authorized scope. '
          + 'Use the hotel name with its city, region, or property code. I did not substitute another hotel or the whole portfolio.',
      };
    }
  }

  let selector: PortfolioScopeSelector;
  let defaultedScope = false;
  if (namedPortfolio.ambiguousNames.length > 1) {
    return {
      ok: false,
      kind: 'clarification',
      message: `More than one authorized portfolio or region matches that name. Which one do you mean: ${namedPortfolio.ambiguousNames.join('; ')}?`,
    };
  }
  // Explicit natural-language scope always wins over a UI/conversation hint.
  // A stale or tampered selector must never turn "all my hotels" into one
  // hotel, or redirect a named-hotel question to a different property.
  if (namedHotel?.ok) {
    selector = namedHotel.plan.selector;
  } else if (namedPortfolio.selector) {
    selector = namedPortfolio.selector;
  } else if (explicitAllScope) {
    selector = { kind: 'all_authorized' };
  } else if (requestedSelector) {
    selector = requestedSelector;
  } else {
    selector = { kind: 'all_authorized' };
    defaultedScope = selector.kind === 'all_authorized'
      && !/\b(all|across|portfolio|company|hotels|properties)\b/.test(q);
  }

  let selectedCount = catalog.hotels.length;
  if (selector.kind === 'hotel') selectedCount = 1;
  if (selector.kind === 'explicit_subset') selectedCount = selector.propertyIds.length;
  if (selector.kind === 'portfolio') {
    selectedCount = catalog.portfolios.find((item) => item.portfolioId === selector.portfolioId)?.propertyIds.length ?? 0;
  }
  if (selectedCount > MAX_EXACT_PORTFOLIO_PROPERTIES) {
    return {
      ok: false,
      kind: 'budget_exceeded',
      message:
        `That exact scope contains ${selectedCount} hotels, above the current ${MAX_EXACT_PORTFOLIO_PROPERTIES}-hotel query budget. `
        + 'No hotels were silently omitted; narrow to a region or selected hotels.',
    };
  }

  const asksForChange = /\b(?:what changed|changes?|change over time|delta|deltas|since (?:yesterday|last|prior|previous)|different (?:from|than))\b/.test(q);
  if (asksForChange) {
    return {
      ok: false,
      kind: 'unsupported',
      message:
        'I do not yet have a canonical prior-window change metric or an active validated pattern package for that scope. '
        + 'I did not substitute today\'s snapshot and call it a change. Ask for the current portfolio status, or specify a supported current metric.',
    };
  }

  const bookedRooms = /\b(booked|bookings|on the books|otb)\b/.test(q)
    && /\b(room|rooms|occupancy|hotel|hotels)\b/.test(q);
  const finalRoomsSold = /\b(?:rooms? sold|sold rooms?)\b/.test(q) && !bookedRooms;
  const liveInHouse = /\b(in house|in-house|occupied now|live occupancy)\b/.test(q);
  const housekeeping = /\b(housekeeping|cleaning|rooms cleaned|clean time|cleaning time)\b/.test(q);
  let broad = /\b(how are|how is|what is happening|what s happening|need attention|doing|portfolio summary)\b/.test(q);
  const compare = /\b(compare|above|below|normal|versus|vs\.?|ranking|rank)\b/.test(q);
  const knowledgeQuery = knowledgeQueryFor(question);

  const metricIds: PortfolioMetricId[] = [];
  if (bookedRooms) metricIds.push('rooms_booked_otb');
  if (finalRoomsSold) metricIds.push('final_rooms_sold');
  if (liveInHouse) metricIds.push('live_in_house_rooms');
  if (housekeeping) metricIds.push('housekeeping_rooms_cleaned', 'housekeeping_active_minutes');
  const explicitlyChangedScope = Boolean(
    namedHotel?.ok
    || namedPortfolio.selector
    || explicitAllScope,
  );
  // A scope-only turn such as "Now show North Region" is a request for the
  // default current summary at that newly stated scope. It never inherits a
  // hidden metric or hotel from the previous turn.
  if (metricIds.length === 0 && explicitlyChangedScope) broad = true;
  if (broad) {
    if (!metricIds.includes('rooms_booked_otb')) metricIds.push('rooms_booked_otb');
    metricIds.push('housekeeping_rooms_cleaned', 'work_orders_open');
  }

  const intent = knowledgeQuery
    ? 'knowledge_lookup'
    : selector.kind === 'hotel'
    ? 'property_drilldown'
    : broad
      ? 'portfolio_summary'
      : compare
        ? 'metric_comparison'
        : metricIds.length > 0
          ? 'metric_total'
          : 'generic_tools';

  return {
    ok: true,
    plan: portfolioQueryPlanSchema.parse({
      version: PORTFOLIO_QUERY_PLAN_VERSION,
      intent,
      selector,
      metricIds: knowledgeQuery ? [] : metricIds,
      ...(knowledgeQuery ? { knowledgeQuery } : {}),
      window: finalRoomsSold
        ? { kind: 'trailing_complete_days', days: 1 }
        : { kind: 'hotel_business_today' },
      groupBy: selector.kind === 'hotel' ? 'property' : 'property',
      comparison: bookedRooms && compare ? 'own_same_weekday_normal' : 'none',
      detailLimit: Math.min(PORTFOLIO_MAX_DETAIL_ROWS, Math.max(1, selectedCount)),
      defaultedScope,
    }),
  };
}
