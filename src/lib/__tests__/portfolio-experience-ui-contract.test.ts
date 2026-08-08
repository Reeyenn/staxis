import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const portfolioProvider = source('src', 'contexts', 'PortfolioContext.tsx');
const portfolioServer = source('src', 'lib', 'portfolio-ui', 'server.ts');
const portfolioTypes = source('src', 'components', 'portfolio', 'types.ts');
const portfolioCss = source('src', 'components', 'portfolio', 'PortfolioUI.module.css');
const portfolioHome = source('src', 'app', 'portfolio', 'PortfolioHomeClient.tsx');
const portfolioLayout = source('src', 'app', '(portfolio)', 'layout.tsx');
const portfolioHomeView = source(
  'src',
  'components',
  'portfolio',
  'PortfolioHomeView.tsx',
);
const portfolioSection = source(
  'src',
  'app',
  'portfolio',
  '[section]',
  'PortfolioSectionClient.tsx',
);
const portfolioChooser = source(
  'src',
  'app',
  'portfolio',
  'choose',
  'PortfolioChooserClient.tsx',
);
const scopeChooser = source('src', 'components', 'portfolio', 'ScopeChooser.tsx');
const portfolioPrimitives = source(
  'src',
  'components',
  'portfolio',
  'PortfolioPrimitives.tsx',
);
const hotelCard = source('src', 'components', 'portfolio', 'PortfolioHotelCard.tsx');
const appLayout = source('src', 'components', 'layout', 'AppLayout.tsx');
const rootLayout = source('src', 'app', 'layout.tsx');
const actingBoundary = source('src', 'components', 'layout', 'ActingContextBoundary.tsx');
const hotelActingProvider = source('src', 'contexts', 'HotelActingContext.tsx');
const hotelActingRequest = source('src', 'lib', 'portfolio-ui', 'hotel-acting-request.ts');
const portfolioContextParser = source('src', 'lib', 'portfolio-ui', 'context.ts');
const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const mobileConcourseCss = source(
  'src',
  'components',
  'concourse',
  'MobileConcourseNav.module.css',
);
const concourseCss = source('src', 'components', 'concourse', 'concourse-css.tsx');
const portfolioQueue = source(
  'src',
  'components',
  'concourse',
  'PortfolioQueueView.tsx',
);
const home = source('src', 'app', '(hotel)', 'home', 'page.tsx');
const propertySelector = source('src', 'app', '(hotel)', 'property-selector', 'page.tsx');
const company = source('src', 'app', '(hotel)', 'company', 'page.tsx');
const companyRulebook = source('src', 'components', 'concourse', 'CompanyRulebookPanel.tsx');
const globals = source('src', 'app', 'globals.css');

describe('portfolio role entry and acting context', () => {
  test('routes from server-issued entry facts rather than the legacy VP word', () => {
    assert.match(portfolioProvider, /\/api\/portfolio\/v1\/bootstrap/);
    assert.match(
      portfolioServer,
      /authorizedPortfolioUiContexts\(options\.authoritativeCompanies \?\? options\.account\)/,
    );
    assert.match(portfolioServer, /mode: selectedCompany \? 'portfolio' : contexts\.length > 0 \? 'company_picker' : 'hotel'/);

    // Company view is a MODE of this app now. Both entry surfaces resolve the
    // destination through companyEntryDestination, whose vocabulary contains no
    // route in the standalone portfolio world at all (company-mode-scope.test.ts
    // pins that). Neither surface may reintroduce one of its own.
    assert.match(home, /resolveHomeEntry\(\{/);
    assert.match(propertySelector, /companyEntryDestination\(portfolio\.data\?\.selection\)/);
    assert.match(propertySelector, /if \(destination\) replaceNavigation\(destination\)/);
    for (const entrySurface of [home, propertySelector]) {
      assert.doesNotMatch(entrySurface, /'\/portfolio\/choose'/);
      assert.doesNotMatch(entrySurface, /`\/portfolio\?organizationId=/);
    }
    for (const entrySurface of [home, propertySelector]) {
      assert.doesNotMatch(entrySurface, /user\??\.role === ['"]vp['"]/);
    }
  });

  test('keeps portfolio navigation on the selected company and hotel lists company-scoped', () => {
    assert.match(concourse, /const purePortfolioContext = pathname === '\/portfolio'/);
    assert.match(concourse, /const selectedCompany = portfolio\?\.data\?\.selectedCompany \?\? null/);
    assert.match(concourse, /const portfolioOrganizationId = selectedCompany\?\.organizationId/);
    assert.match(concourse, /`\/portfolio\/\$\{key\}\?organizationId=/);
    assert.match(concourse, /'My Portfolio'/);
    assert.match(concourse, /mapPortfolioUiRoute\([\s\S]{0,180}?acting\.request\.context/);
    assert.match(concourse, /returnTo: acting\.request\.returnTo/);
  });
});

describe('portfolio Ask ownership', () => {
  test('renders one company Ask, suppresses the global Ask, and gives hotel cards no chat', () => {
    assert.equal((portfolioHome.match(/<PortfolioChat\b/g) ?? []).length, 1);
    assert.match(portfolioLayout, /<AppLayout hideGlobalAsk>\{children\}<\/AppLayout>/);
    assert.match(portfolioLayout, /pathname === '\/portfolio\/choose'/);
    assert.doesNotMatch(portfolioHome, /<AppLayout\b|from ['"]@\/components\/layout\/AppLayout['"]/);
    assert.match(appLayout, /!hideGlobalAsk \? <AskStaxisBar \/> : null/);
    assert.doesNotMatch(
      hotelCard,
      /PortfolioChat|AskStaxisBar|AskHero|MessageSquare|MessageCircle|useAgentChat/,
    );
    assert.doesNotMatch(hotelCard, /score\s*[=:]/i);
  });
});

describe('hotel drilldown and return contract', () => {
  test('carries exact hotel scope and a same-origin return target from both portfolio surfaces', () => {
    assert.match(portfolioHome, /new URLSearchParams\(\{ scope: 'hotel', propertyId, organizationId, returnTo \}\)/);
    assert.match(portfolioSection, /new URLSearchParams\(\{ scope: 'hotel', propertyId, organizationId, returnTo \}\)/);
    assert.match(hotelActingRequest, /parsePortfolioUiContext\(params\)/);
    assert.match(portfolioContextParser, /for \(const key of RESERVED_QUERY_KEYS\)/);
    assert.match(portfolioContextParser, /params\.getAll\(key\)\.length > 1/);
    assert.match(portfolioContextParser, /propertyId: 'propertyId'/);
    assert.match(portfolioContextParser, /organizationId: 'organizationId'/);
    assert.match(portfolioContextParser, /isPortfolioUiUuid\(propertyId\)/);
    assert.match(portfolioContextParser, /normalizeSameOriginAppPath\(rawReturnTo\)/);
    assert.match(hotelActingProvider, /fetchWithAuth\(authorizationRequest\.endpoint/);
    assert.match(hotelActingProvider, /hotelActingContextMatchesRequest\(authorizationRequest, context\)/);
    assert.match(actingBoundary, /Back to Portfolio/);
  });

  test('resolves the requested hotel before applying that hotel\'s section gate', () => {
    const hotelGateIndex = rootLayout.indexOf('<ActingContextBoundary>');
    const propertyProviderIndex = rootLayout.indexOf('<PropertyProvider>', hotelGateIndex);
    const appShellIndex = rootLayout.indexOf('<AuthenticatedRuntimeBoundary>', propertyProviderIndex);
    assert.ok(hotelGateIndex >= 0 && propertyProviderIndex > hotelGateIndex && appShellIndex > propertyProviderIndex);
    assert.ok(
      appLayout.indexOf('actingSectionEnabled') < appLayout.indexOf('sectionOff'),
      'AppLayout must apply the server-issued acting-context section policy',
    );
  });

  test('hides and freshly reauthorizes an open hotel when its tab resumes', () => {
    assert.match(hotelActingProvider, /window\.addEventListener\('focus', revalidate\)/);
    assert.match(hotelActingProvider, /document\.addEventListener\('visibilitychange', revalidate\)/);
    assert.match(hotelActingProvider, /window\.addEventListener\('pagehide', hide\)/);
    assert.match(
      hotelActingProvider,
      /const revalidate = \(\) => \{[\s\S]{0,700}?flushSync\(\(\) => invalidate\(\)\)/,
    );
    assert.match(hotelActingProvider, /HOTEL_ACTING_CONTEXT_TIMEOUT_MS = 8_000/);
  });

  test('lets an explicit hotel-scoped Home URL reach the drilldown gate', () => {
    const homePageStart = home.indexOf('export default function HomePage()');
    assert.ok(homePageStart >= 0, 'HomePage must remain an explicit portfolio-routing boundary');
    const homePage = home.slice(homePageStart);
    assert.match(homePage, /const hotelDrilldown = acting\?\.request\.kind === 'hotel'/);
    assert.match(homePage, /const portfolioEntryPending = shouldWaitForPortfolioEntry\(\{[\s\S]{0,100}?hotelDrilldown,[\s\S]{0,100}?portfolioLoading: portfolio\.loading/);
    assert.match(homePage, /const entry = resolveHomeEntry\(\{[\s\S]{0,240}?scope: activeScope/);
    assert.doesNotMatch(homePage, /portfolioDestination/);
  });
});

describe('Company Hub portfolio contract', () => {
  test('keeps exactly Hotels, People, and Access', () => {
    assert.match(company, /type TabId = 'hotels' \| 'people' \| 'access';/);
    const tabsStart = company.indexOf('const tabs = React.useMemo<TabDefinition[]>');
    const tabsEnd = company.indexOf('}, []);', tabsStart);
    assert.ok(tabsStart >= 0 && tabsEnd > tabsStart);
    const tabIds = [...company.slice(tabsStart, tabsEnd).matchAll(/\{ id: '([^']+)'/g)]
      .map((match) => match[1]);
    assert.deepEqual(tabIds, ['hotels', 'people', 'access']);
    assert.match(company, /portfolioMode[\s\S]*'My Portfolio'/);
    assert.match(company, /selectCompanyAccessContext\([\s\S]{0,140}?selectedPortfolioCompany\.organizationId/);
  });

  test('describes the My Portfolio destination with the current Company Hub tabs', () => {
    assert.match(portfolioHome, /portfolioDescription="Hotels, People, and Access"/);
    assert.doesNotMatch(portfolioHome, /portfolioDescription="Overview, Hotels, People, and Access"/);
  });

  test('does not allow a portfolio-branded Company Hub without one explicit company', () => {
    assert.match(company, /portfolio\.data\?\.selection\.state === 'selected'/);
    assert.match(
      company,
      /portfolio\.data\.selection\.selectedOrganizationId === portfolio\.requestedOrganizationId/,
    );
    assert.match(company, /const currentData = portfolioMode[\s\S]{0,300}?: null[\s\S]{0,40}?: unscopedCurrentData/);
  });

  test('keeps the Company Hub independent from rulebook placement', () => {
    assert.doesNotMatch(company, /CompanyRulebookPanel/);
    assert.doesNotMatch(company, /organizationId=\{selectedPortfolioCompany\.organizationId\}/);
    assert.doesNotMatch(company, /propertyId=\{activePropertyId\}/);
    assert.match(companyRulebook, /const activePropertyId = organizationId \? null : \(propertyId \?\? contextPropertyId\)/);
    assert.match(companyRulebook, /const selectorPayload = organizationId[\s\S]{0,160}?\{ propertyId: activePropertyId \}/);
    assert.match(companyRulebook, /identityKey: selectorQuery/);
    assert.doesNotMatch(companyRulebook, /organizationId:\s*activePropertyId/);
  });
});

describe('financial navigation authorization', () => {
  test('uses the company capability for both nav visibility and direct-route denial', () => {
    assert.match(
      concourse,
      /if \(m\.key === 'financials'\) return portfolioFinancialsAvailable/,
    );
    assert.match(
      portfolioSection,
      /section === 'financials' && company\.capabilities\.canViewFinancials !== true/,
    );
    assert.match(portfolioSection, /state="unauthorized"|\? 'unauthorized'/);
    assert.match(
      portfolioServer,
      /options\.section === 'financials' && !capabilities\.canViewFinancials/,
    );
    assert.match(portfolioServer, /resultError\(403, 'financials_forbidden'/);
  });
});

describe('theme and motion accessibility', () => {
  test('keeps the application shell light while preserving reduced-motion portfolio chrome', () => {
    assert.doesNotMatch(rootLayout, /ThemeProvider|INITIAL_THEME_SCRIPT|data-theme|colorScheme|prefers-color-scheme/);
    assert.doesNotMatch(concourse, /useTheme|toggleTheme|Use dark theme|Usar tema oscuro/);
    assert.doesNotMatch(concourseCss, /data-theme|color-scheme\s*:\s*dark/);
    assert.doesNotMatch(mobileConcourseCss, /data-theme|color-scheme\s*:\s*dark/);
    assert.match(concourseCss, /\.staxis-app-shell\{--staxis-app-background:radial-gradient/);
    assert.match(
      concourseCss,
      /@media \(max-width:760px\)\{[\s\S]{0,180}?\.staxis-app-shell\{[^}]*#FFFFFF 0%,#F0F3EF 100%/,
    );
    // Every shell wash in the file, and the thing that actually matters about
    // each one: it starts at WHITE. The count is pinned so a stray fourth
    // declaration has to be looked at, but the loop is the real guard — a dark
    // shell would slip past a count and never past this.
    //
    // Three since 2026-08-01: the base, the mobile override, and the /feed
    // page's own slightly wider wash (`.staxis-app-shell:has(.fx-page)`), which
    // is scoped so no other section's background moves with it.
    const shellWashes = concourseCss.match(/--staxis-app-background:radial-gradient\([^;]*/g) ?? [];
    assert.equal(shellWashes.length, 3, shellWashes.join(' | '));
    for (const wash of shellWashes) assert.match(wash, /#FFFFFF 0%/, wash);
    assert.doesNotMatch(portfolioCss, /data-theme|prefers-color-scheme:\s*dark|color-scheme:\s*dark/);
    assert.match(portfolioCss, /color-scheme:\s*light/);
    assert.match(portfolioCss, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(portfolioCss, /skeletonCommand::after[\s\S]*animation: none/);
    assert.match(mobileConcourseCss, /@media \(prefers-reduced-motion: reduce\)/);
    assert.equal((portfolioCss.match(/--pf-caramel: #865f28;/g) ?? []).length, 1);
    assert.doesNotMatch(portfolioCss, /--pf-caramel: #8c6a33;/);
    assert.match(portfolioCss, /padding-left: max\(var\(--pf-page-inline\), env\(safe-area-inset-left, 0px\)\)/);
    assert.match(portfolioCss, /padding-right: max\(var\(--pf-page-inline\), env\(safe-area-inset-right, 0px\)\)/);
    assert.match(portfolioCss, /--pf-toast-left: max\([^;]*safe-area-inset-left/);
    assert.match(portfolioCss, /--pf-toast-right: max\([^;]*safe-area-inset-right/);
  });

  test('keeps mobile shell controls at real 44px touch targets', () => {
    assert.match(
      mobileConcourseCss,
      /\.menuButton\s*\{[\s\S]*?width: 40px;[\s\S]*?height: 40px;/,
    );
    assert.match(
      mobileConcourseCss,
      /\.avatar\s*\{[\s\S]*?width: 40px;[\s\S]*?height: 40px;/,
    );
    assert.match(
      mobileConcourseCss,
      /\.menuButton::after[\s\S]{0,120}?inset: -2px/,
    );
    assert.match(mobileConcourseCss, /\.avatar::after[\s\S]{0,120}?inset: -2px/);
    assert.match(mobileConcourseCss, /grid-template-columns: 40px minmax\(0, 1fr\) 44px 40px;/);
    assert.match(mobileConcourseCss, /\.askSlot\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  });
});

describe('scope chooser semantics', () => {
  test('labels the chooser and contains focus for its dialog variant', () => {
    assert.match(scopeChooser, /role=\{variant === 'dialog' \? 'dialog'/);
    assert.match(scopeChooser, /aria-modal=\{variant === 'dialog' \? 'true'/);
    assert.match(scopeChooser, /aria-labelledby=\{titleId\}/);
    assert.match(scopeChooser, /role="radiogroup"/);
    assert.match(scopeChooser, /role="radio"/);
    assert.match(scopeChooser, /aria-checked=\{selected\}/);
    assert.match(scopeChooser, /event\.key === 'Escape'/);
    assert.match(scopeChooser, /event\.key !== 'Tab'/);
    assert.match(scopeChooser, /previousFocus\?\.focus/);
    assert.match(scopeChooser, /event\.key === 'ArrowDown'/);
    assert.match(scopeChooser, /event\.key === 'Home'/);
    assert.match(scopeChooser, /element\.tabIndex >= 0/);
    assert.match(scopeChooser, /const dialogOpening = variant === 'dialog' && open/);
    assert.match(scopeChooser, /target\.focus\(\)/);
  });

  test('keeps radio arrow exploration local until explicit activation', () => {
    const moveStart = scopeChooser.indexOf('const moveChoiceFocus');
    const moveEnd = scopeChooser.indexOf('const activateChoice', moveStart);
    assert.ok(moveStart >= 0 && moveEnd > moveStart);
    const moveChoice = scopeChooser.slice(moveStart, moveEnd);
    assert.match(moveChoice, /setActiveId\(nextChoice\.id\)/);
    assert.match(moveChoice, /choiceRefs\.current\.get\(nextChoice\.id\)\?\.focus/);
    assert.doesNotMatch(moveChoice, /onSelect\(/);
    assert.match(scopeChooser, /const activateChoice[\s\S]{0,180}onSelect\(choice\)/);
    assert.match(scopeChooser, /event\.key === 'Enter'[\s\S]{0,180}activateChoice\(choice\)/);
  });

  test('distinguishes loading, failed access, and a truly empty authorization set', () => {
    assert.match(portfolioChooser, /portfolio\.loading[\s\S]*\? 'loading'/);
    assert.match(portfolioChooser, /portfolio\.error[\s\S]*\? 'error'/);
    assert.match(portfolioChooser, /allChoices\.length === 0[\s\S]*\? 'empty'/);
    assert.match(portfolioChooser, /No active context is available/);
  });
});

describe('portfolio loading, partial, empty, error, and unauthorized states', () => {
  test('keeps every state explicit and gives failures assertive semantics', () => {
    for (const state of ['ready', 'partial', 'loading', 'empty', 'error', 'unauthorized']) {
      assert.match(portfolioTypes, new RegExp(`\\| '${state}'`));
    }
    assert.match(
      portfolioPrimitives,
      /role=\{state === 'error' \|\| state === 'unauthorized' \? 'alert' : 'status'\}/,
    );
    assert.match(portfolioHome, /state="loading"/);
    assert.match(portfolioHome, /state="error"/);
    assert.match(portfolioSection, /\? 'unauthorized'/);
    assert.match(portfolioSection, /\? 'loading'/);
    assert.match(portfolioSection, /\? 'error'/);
    assert.match(portfolioPrimitives, /<div className=\{styles\.partialNotice\} role="status"/);
    assert.doesNotMatch(portfolioPrimitives, /<aside className=\{styles\.partialNotice\} role="status"/);
    assert.match(portfolioHomeView, /portfolioAction\?: PortfolioAction/);
    assert.match(portfolioHomeView, /\{portfolioAction \? \(/);
    const errorBranch = portfolioHome.slice(
      portfolioHome.indexOf('if (portfolio.error || !data || !company)'),
      portfolioHome.indexOf('const filters:', portfolioHome.indexOf('if (portfolio.error || !data || !company)')),
    );
    assert.doesNotMatch(errorBranch, /portfolioAction=/);
    const loadingBranch = portfolioHome.slice(
      portfolioHome.indexOf('function loadingHome'),
      portfolioHome.indexOf('export function PortfolioHomeClient'),
    );
    assert.doesNotMatch(loadingBranch, /portfolioAction=/);
  });

  test('only calls Portfolio Home empty when authorized coverage is truly zero', () => {
    assert.match(portfolioHome, /const trueEmptyPortfolio = data\.coverage\.total === 0/);
    assert.match(
      portfolioHome,
      /state=\{trueEmptyPortfolio \? 'empty' : incompletePortfolio \? 'partial' : 'ready'\}/,
    );
    assert.match(portfolioHome, /allHotelRowsUnavailable/);
    assert.match(portfolioHome, /This is not an empty portfolio/);
  });

  test('never calls an incomplete portfolio section empty', () => {
    const sectionStateStart = portfolioSection.indexOf('const state =');
    const sectionStateEnd = portfolioSection.indexOf('const missing', sectionStateStart);
    assert.ok(sectionStateStart >= 0 && sectionStateEnd > sectionStateStart);
    const sectionState = portfolioSection.slice(sectionStateStart, sectionStateEnd);
    assert.match(portfolioSection, /const trueEmptyPortfolio = Boolean\(data && data\.coverage\.total === 0\)/);
    assert.match(portfolioSection, /const allHotelRowsUnavailable = Boolean\(data && data\.coverage\.total > 0 && data\.hotels\.length === 0\)/);
    assert.match(sectionState, /trueEmptyPortfolio[\s\S]*\? 'empty'/);
    assert.doesNotMatch(sectionState, /data\?\.hotels\.length === 0[\s\S]*\? 'empty'/);
    assert.match(
      portfolioSection,
      /collectionEmptyContent=\{noFilterMatches[\s\S]*allHotelRowsUnavailable[\s\S]*This is not an empty portfolio/,
    );
  });

  test('terminates loading when bootstrap or the initial Staxis read fails', () => {
    const sectionDataStart = portfolioSection.indexOf('const data = resource.data;');
    const preSectionData = portfolioSection.slice(0, sectionDataStart);
    assert.match(preSectionData, /portfolio\.error/);

    const requestStateIndex = portfolioQueue.indexOf('const request = portfolioRequestState');
    const errorIndex = portfolioQueue.indexOf("if (request.kind === 'error')", requestStateIndex);
    const missingScopeIndex = portfolioQueue.indexOf('if (!portfolio.scope)', errorIndex);
    assert.ok(requestStateIndex >= 0 && errorIndex > requestStateIndex);
    assert.ok(
      missingScopeIndex > errorIndex,
      'An initial queue error must terminate before a missing-scope fallback can render',
    );
    assert.match(portfolioQueue.slice(errorIndex, missingScopeIndex), /<PortfolioRequestNotice[\s\S]{0,160}?kind="error"/);
  });
});
