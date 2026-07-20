import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const home = source('src', 'app', 'home', 'page.tsx');
const homeHub = source('src', 'components', 'concourse', 'HomeHubView.tsx');
const homeSummary = source('src', 'app', 'api', 'home', 'summary', 'route.ts');
const concourseCss = source('src', 'components', 'concourse', 'concourse-css.tsx');
const liveSurface = source('src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx');
const invitation = source('src', 'app', 'company-invite', '[token]', 'page.tsx');
const authShell = source('src', 'components', 'AuthShell.tsx');
const company = source('src', 'app', 'company', 'page.tsx');
const companyCss = source('src', 'app', 'company', 'CompanyAccess.module.css');
const propertyContext = source('src', 'contexts', 'PropertyContext.tsx');

describe('company-only shell routing', () => {
  test('does not expose hotel sections without an active hotel', () => {
    assert.match(concourse, /propertyLoading \|\| !activeProperty \? \[\] : SECTION_LIST/);
    assert.match(concourse, /const companyOnly = !propertyLoading && !!user && properties\.length === 0/);
    assert.match(concourse, /const homeHref = companyOnly \? ['"]\/company['"] : ['"]\/home['"]/);
  });

  test('distinguishes an unselected portfolio from a truly zero-property company user', () => {
    assert.match(home, /user\.role === ['"]admin['"] \|\| properties\.length > 0/);
    assert.match(home, /body\.data\?\.organizations\?\.some/);
    assert.match(home, /organization\.type !== ['"]single_hotel['"]/);
  });
});

describe('Home management entry', () => {
  test('renders below the department board as a separate management level', () => {
    const boardIndex = homeHub.indexOf('className={`cx-board');
    const managementIndex = homeHub.indexOf('className="cx-management"');
    assert.ok(boardIndex >= 0 && managementIndex > boardIndex);
    assert.match(homeHub, /<h2[^>]*className="cx-management-head"/);
    assert.match(homeHub, /<Link href=\{management\.href\} className="cx-management-link">/);
    assert.match(homeHub, /<CxIcon name="company"/);
  });

  test('uses customer membership but selected-hotel topology for the admin preview', () => {
    assert.match(homeSummary, /if \(!account \|\| account\.active !== true\) return null/);
    assert.match(homeSummary, /if \(account\.role === ['"]admin['"]\)/);
    assert.match(homeSummary, /\.from\(['"]organization_property_relationships['"]\)/);
    assert.match(homeSummary, /\.eq\(['"]property_id['"], propertyId\)/);
    assert.match(homeSummary, /\.eq\(['"]is_primary_grouping['"], true\)/);
    assert.match(homeSummary, /relationshipCount !== relationshipRows\.length/);
    assert.match(homeSummary, /resolveAdminCompanyPreviewTarget\(/);
    assert.match(homeSummary, /assertExactSingleHotelRelationshipScope\(/);
    assert.match(homeSummary, /count !== anchorRelationships\.length/);
    assert.match(homeSummary, /target\.scope === ['"]organization['"] \? ['"]company['"] : ['"]hotel['"]/);
    assert.match(homeSummary, /managementHubContext\(auth\.userId, pid, requestId\)/);
    assert.match(homeSummary, /\.from\(['"]organization_memberships['"]\)/);
    assert.match(homeSummary, /\.eq\(['"]account_id['"], account\.id as string\)/);
    assert.match(homeSummary, /\.eq\(['"]status['"], ['"]active['"]\)/);
    assert.match(homeSummary, /\.lte\(['"]starts_at['"], nowIso\)/);
    assert.match(homeSummary, /\.is\(['"]ended_at['"], null\)/);
    assert.match(homeSummary, /\.eq\(['"]organizations\.status['"], ['"]active['"]\)/);
    assert.match(homeSummary, /\.neq\(['"]organizations\.organization_type['"], ['"]single_hotel['"]\)/);
    assert.match(homeSummary, /management context failed — omitting management entry/);
    assert.match(homeSummary, /return null;/);
    assert.match(homeSummary, /ok\(\{ tiles, managementContext \}/);
    assert.doesNotMatch(home, /properties\.length > 1 \? ['"]company['"]/);
    assert.match(home, /management=\{user && managementContext/);
    assert.doesNotMatch(home, /management=\{user && user\.role !== ['"]admin['"]/);
  });

  test('localizes both adaptive labels and always opens the Company Hub route', () => {
    assert.match(home, /['"]Company Hub['"]/);
    assert.match(home, /['"]My Hotel['"]/);
    assert.match(home, /['"]Centro de empresa['"]/);
    assert.match(home, /['"]Mi hotel['"]/);
    assert.match(home, /href: ['"]\/company['"]/);
  });

  test('has a full-width mobile target, visible focus, and reduced-motion handling', () => {
    assert.match(concourseCss, /\.cx-management-link\{[^}]*width:100%;[^}]*min-height:68px/);
    assert.match(concourseCss, /\.cx-management-link:focus-visible\{outline:2px solid #3E5C48/);
    const mobile = concourseCss.slice(concourseCss.indexOf('@media (max-width:760px)'));
    assert.match(mobile, /\.cx-management-link\{min-height:72px/);
    const reducedMotion = concourseCss.slice(concourseCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reducedMotion, /\.cx-management-link,[^\n]*\.cx-management-arrow\{transition:none;/);
    assert.match(reducedMotion, /\.cx-management-link:hover,[^\n]*transform:none;/);
  });
});

describe('admin hotel directory safeguards', () => {
  test('only active organizations can receive hotel assignments', () => {
    assert.match(liveSurface, /organization\.status === ['"]active['"] && hasIndependentHotels/);
    assert.match(liveSurface, /organizations\.filter\(\(organization\) => organization\.status === ['"]active['"]\)/);
    assert.match(liveSurface, /No active organizations available/);
  });
});

describe('company invitation accessibility', () => {
  test('registration controls have explicit labels and announced errors', () => {
    assert.match(invitation, /htmlFor="company-invite-display-name"/);
    assert.match(invitation, /id="company-invite-display-name"/);
    assert.match(invitation, /htmlFor="company-invite-password"/);
    assert.match(invitation, /htmlFor="company-invite-confirm-password"/);
    assert.match(invitation, /aria-describedby=\{error \? ['"]company-invite-error['"]/);
    assert.match(authShell, /role="alert" aria-live="assertive"/);
  });
});

describe('truthful Company Hub filters', () => {
  test('hotels use not-active semantics instead of calling every non-active row pending', () => {
    assert.match(company, /type HotelStatusFilter = ['"]all['"] \| ['"]active['"] \| ['"]not_active['"]/);
    assert.match(company, /property\.status === ['"]active['"] : property\.status !== ['"]active['"]/);
    assert.match(company, /value: ['"]not_active['"], label: localized\(lang, ['"]Not active['"]/);
  });

  test('the invited People filter includes actual pending invitations', () => {
    assert.match(company, /type PeopleStatusFilter = ['"]all['"] \| ['"]active['"] \| ['"]invited['"] \| ['"]not_active['"]/);
    assert.match(company, /statusFilter === ['"]invited['"] && invitation\.status === ['"]pending['"]/);
    assert.match(company, /visibleInvitations\.map/);
  });

  test('admin previews merge hotel roster data without crossing viewer contexts', () => {
    assert.match(propertyContext, /staffViewerKey/);
    assert.match(propertyContext, /setStaffViewerKey\(subscriptionViewerKey\)/);
    assert.match(propertyContext, /setStaffLoadFailed\(true\)/);
    assert.match(company, /staffViewerKey === `\$\{user\.uid\}:\$\{activePropertyId\}`/);
    assert.match(company, /['"]Hotel roster unavailable['"]/);
    assert.match(company, /['"]Customer access members['"]/);
    assert.match(company, /['"]Operational staff['"]/);
    assert.match(company, /shown separately from access accounts/);
    assert.match(company, /data\.viewerContext\?\.kind === ['"]staxis_admin_preview['"]/);
    assert.match(company, /statusLabel\(membership\.status, lang\)/);
  });
});

describe('mobile Company Hub touch targets', () => {
  test('small interactive controls reach the 44px mobile minimum', () => {
    const mobile = companyCss.slice(companyCss.indexOf('@media (max-width: 600px)'));
    assert.match(mobile, /\.reviewButton,[\s\S]*\.actionMenu summary,[\s\S]*\.actionMenu button \{\s*min-height: 44px;/);
    assert.match(mobile, /\.searchField > button,[\s\S]*\.iconButton \{\s*width: 44px;\s*height: 44px;/);
    assert.match(mobile, /\.filterChips button \{[\s\S]*min-height: 44px;/);
  });
});
