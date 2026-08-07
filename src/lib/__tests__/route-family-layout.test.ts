import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const routeFiles = {
  public: [
    'page.tsx',
    'consent/page.tsx',
    'privacy/page.tsx',
    'terms/page.tsx',
    'signup/page.tsx',
    'join/page.tsx',
    'onboard/page.tsx',
    'phone-signin/page.tsx',
    'invite/[token]/page.tsx',
    'signin/page.tsx',
    'signin/forgot/page.tsx',
    'signin/reset/page.tsx',
    'signin/verify/page.tsx',
  ],
  hotel: [
    'communications/page.tsx',
    'dashboard/page.tsx',
    'feed/page.tsx',
    'financials/page.tsx',
    'home/page.tsx',
    'housekeeping/page.tsx',
    'inventory/page.tsx',
    'inventory/ai/page.tsx',
    'maintenance/page.tsx',
    'property-selector/page.tsx',
    'settings/page.tsx',
    'settings/accounts/page.tsx',
    'settings/activity-log/page.tsx',
    'settings/checklists/page.tsx',
    'settings/clean-times/page.tsx',
    'settings/notifications/page.tsx',
    'settings/reports/page.tsx',
    'settings/shifts/page.tsx',
    'settings/users/page.tsx',
    'settings/wages/page.tsx',
    'staff/page.tsx',
    'company/page.tsx',
  ],
  portfolio: [
    'portfolio/page.tsx',
    'portfolio/choose/page.tsx',
    'portfolio/[section]/page.tsx',
  ],
  admin: [
    'admin/page.tsx',
    'admin/ai-staff/page.tsx',
    'admin/data-atlas/page.tsx',
    'admin/properties/page.tsx',
    'admin/properties/[id]/page.tsx',
  ],
  staffLink: [
    'housekeeper/page.tsx',
    'housekeeper/[id]/page.tsx',
    'laundry/page.tsx',
    'laundry/[id]/page.tsx',
  ],
} as const;

const groupRoots = {
  public: ['src', 'app', '(public)'],
  hotel: ['src', 'app', '(hotel)'],
  portfolio: ['src', 'app', '(portfolio)'],
  admin: ['src', 'app', '(admin)'],
  staffLink: ['src', 'app', '(staff-link)'],
} as const;

const pageShellPattern = /import\s+(?:\{[^}]*\bAppLayout\b[^}]*\}|AppLayout)\s+from\s+['"]@\/components\/layout\/AppLayout['"]|<\/?AppLayout\b/;

describe('route-family filesystem architecture', () => {
  test('keeps every owned URL represented without adding a URL segment', () => {
    for (const [family, files] of Object.entries(routeFiles)) {
      const root = groupRoots[family as keyof typeof groupRoots];
      for (const file of files) {
        assert.equal(
          existsSync(join(process.cwd(), ...root, ...file.split('/'))),
          true,
          `missing ${family} route entry: ${file}`,
        );
      }
    }

    // Route groups are filesystem-only. The mixed acting-context Company Hub
    // owns the hotel route group while preserving its /company URL.
    assert.equal(existsSync(join(process.cwd(), 'src', 'app', '(hotel)', 'company', 'page.tsx')), true);
    assert.equal(existsSync(join(process.cwd(), 'src', 'app', 'company', 'page.tsx')), false);
    assert.equal(existsSync(join(process.cwd(), 'src', 'app', 'home', 'page.tsx')), false);
    assert.equal(existsSync(join(process.cwd(), 'src', 'app', 'portfolio', 'page.tsx')), false);
    assert.equal(existsSync(join(process.cwd(), 'src', 'app', 'admin', 'page.tsx')), false);
  });

  test('gives each shell-bearing family one layout owner and preserves shell-free exceptions', () => {
    const hotelLayout = source('src', 'app', '(hotel)', 'layout.tsx');
    const portfolioLayout = source('src', 'app', '(portfolio)', 'layout.tsx');
    const publicLayout = source('src', 'app', '(public)', 'layout.tsx');
    const staffLinkLayout = source('src', 'app', '(staff-link)', 'layout.tsx');
    const adminLayout = source('src', 'app', '(admin)', 'layout.tsx');

    assert.match(hotelLayout, /<AppLayout>\{children\}<\/AppLayout>/);
    assert.match(hotelLayout, /new Set\(\['\/property-selector', '\/inventory\/ai'\]\)/);
    assert.match(hotelLayout, /if \(SHELL_FREE_HOTEL_DESTINATIONS\.has\(pathname\)\) return children/);
    assert.match(portfolioLayout, /<AppLayout hideGlobalAsk>\{children\}<\/AppLayout>/);
    assert.match(portfolioLayout, /if \(pathname === '\/portfolio\/choose'\) return children/);
    assert.doesNotMatch(publicLayout, /AppLayout/);
    assert.doesNotMatch(staffLinkLayout, /AppLayout/);

    const userCheck = adminLayout.indexOf('await supabase.auth.getUser()');
    const roleCheck = adminLayout.indexOf("account.role as string");
    const twoFactorCheck = adminLayout.indexOf('await isTwoFactorEnabled()');
    const shell = adminLayout.indexOf('return <AppLayout>{children}</AppLayout>');
    assert.ok(userCheck >= 0 && roleCheck > userCheck && twoFactorCheck > roleCheck && shell > twoFactorCheck);
  });

  test('removes page-level shell ownership from moved routes and portfolio clients', () => {
    const movedPages = Object.entries(routeFiles).flatMap(([family, files]) => (
      files.map((file) => source(...groupRoots[family as keyof typeof groupRoots], ...file.split('/')))
    ));
    const portfolioClients = [
      source('src', 'app', 'portfolio', 'PortfolioHomeClient.tsx'),
      source('src', 'app', 'portfolio', '[section]', 'PortfolioSectionClient.tsx'),
    ];

    for (const page of [...movedPages, ...portfolioClients]) {
      assert.doesNotMatch(page, pageShellPattern);
    }
  });

  test('keeps root provider order and explicit staff-link runtime policy stable', () => {
    const rootLayout = source('src', 'app', 'layout.tsx');
    const runtimeBoundary = source(
      'src',
      'components',
      'layout',
      'AuthenticatedRuntimeBoundary.tsx',
    );
    const providers = [
      '<InstallStaxisProvider>',
      '<SyncProvider>',
      '<AuthProvider>',
      '<LanguageProvider>',
      '<ReliableNavigationProvider>',
      '<HotelActingProvider>',
      '<ActingContextBoundary>',
      '<PortfolioProvider>',
      '<PropertyProvider>',
      '<AuthenticatedRuntimeBoundary>',
      '<WalkthroughOverlay />',
    ];
    let previous = -1;
    for (const provider of providers) {
      const current = rootLayout.indexOf(provider);
      assert.ok(current > previous, `provider order changed around ${provider}`);
      previous = current;
    }

    assert.match(runtimeBoundary, /SHELL_FREE_STAFF_LINK_PREFIXES = \['\/housekeeper', '\/laundry'\]/);
    assert.match(runtimeBoundary, /export function isAuthenticatedRoutePath/);
    assert.match(runtimeBoundary, /const protectedRoute = isAuthenticatedRoutePath\(pathname\)/);
  });
});
