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
const hotelTeam = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const hotelTeamDialogs = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');
const settings = source('src', 'app', 'settings', 'page.tsx');
const legacyAccounts = source('src', 'app', 'settings', 'accounts', 'page.tsx');
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
  test('renders below the department board without a divider heading or subtitle', () => {
    const boardIndex = homeHub.indexOf('className={`cx-board');
    const managementIndex = homeHub.indexOf('className="cx-management"');
    assert.ok(boardIndex >= 0 && managementIndex > boardIndex);
    assert.doesNotMatch(homeHub, /cx-management-head/);
    assert.doesNotMatch(homeHub, /cx-management-description/);
    assert.match(homeHub, /<Link href=\{management\.href\} className="cx-management-link">/);
    assert.match(homeHub, /<CxIcon name="company"/);
    assert.doesNotMatch(home, /Review the hotel team and access/);
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

  test('uses a compact content-width target with strong section separation and accessible states', () => {
    assert.match(concourseCss, /\.cx-management\{margin-top:120px/);
    assert.match(concourseCss, /\.cx-management-link\{[^}]*width:fit-content;[^}]*min-height:52px/);
    assert.doesNotMatch(concourseCss, /\.cx-management-head/);
    assert.doesNotMatch(concourseCss, /\.cx-management-description/);
    assert.match(concourseCss, /\.cx-management-link:focus-visible\{outline:2px solid #3E5C48/);
    const mobile = concourseCss.slice(concourseCss.indexOf('@media (max-width:760px)'));
    assert.match(mobile, /\.cx-management\{margin-top:80px/);
    assert.match(mobile, /\.cx-management-link\{min-height:48px/);
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

  test('People keeps the operational roster separate from hotel accounts and company access', () => {
    assert.match(company, /type PeopleStatusFilter = ['"]all['"] \| ['"]active['"] \| ['"]not_active['"]/);
    assert.match(company, /<HotelTeamPanel/);
    assert.match(company, /Staff without a linked login/);
    assert.match(company, /linkedStaffIdSet\.has\(member\.id\)/);
    assert.doesNotMatch(company, /statusFilter === ['"]invited['"]/);
    assert.match(company, /Organization access/);
    assert.match(company, /data\.invitations\.map/);
  });

  test('admin previews merge the exact hotel roster without crossing viewer contexts', () => {
    assert.match(propertyContext, /staffViewerKey/);
    assert.match(propertyContext, /setStaffViewerKey\(subscriptionViewerKey\)/);
    assert.match(propertyContext, /setStaffLoadFailed\(true\)/);
    assert.match(company, /staffViewerKey === `\$\{user\.uid\}:\$\{activePropertyId\}`/);
    assert.match(company, /['"]Hotel roster unavailable['"]/);
    assert.match(company, /hotelId=\{activeProperty\.id\}/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) && !adminToolsEnabled\}/);
    assert.match(company, /data\.viewerContext\?\.kind === ['"]staxis_admin_preview['"]/);
    assert.match(company, /allowAdminActions=\{adminToolsEnabled\}/);
    assert.match(company, /statusLabel\(membership\.status, lang\)/);
    assert.match(hotelTeam, /responseTeam\.filter\(\(member\) => !member\.isPlatformAdmin && member\.role !== ['"]admin['"]\)/);
  });
});

describe('My Hotel account and team integration', () => {
  test('moves the hotel-facing entry out of Settings and preserves old bookmarks', () => {
    assert.doesNotMatch(settings, /href:\s*['"]\/settings\/accounts['"]/);
    assert.match(legacyAccounts, /router\.replace\(['"]\/company\?tab=people['"]\)/);
    assert.match(legacyAccounts, /\/admin\/properties\/\$\{encodeURIComponent\(activePropertyId\)\}/);
  });

  test('keeps the selected tab in the URL and selects an exact hotel', () => {
    assert.match(company, /useSearchParams\(\)/);
    assert.match(company, /params\.set\(['"]tab['"], next\)/);
    assert.match(company, /value=\{activeProperty\?\.id \?\? ['"]['"]\}/);
    assert.match(company, /onChange=\{\(event\) => setActivePropertyId\(event\.target\.value\)\}/);
    assert.match(company, /contextProperties\.map\(\(hotel\) => <option key=\{hotel\.id\}/);
  });

  test('starts My Team with the account tools instead of a redundant intro block', () => {
    assert.doesNotMatch(company, /People and team access|Personas y acceso del equipo/);
    assert.doesNotMatch(company, /Manage hotel logins, invitations, approvals|Administra accesos, invitaciones, aprobaciones/);
  });

  test('replaces Activity with one compact hotel selector in the navigation', () => {
    const tabsIndex = company.indexOf('<div className={styles.tabs}>');
    const tabListIndex = company.indexOf('className={styles.tabList}', tabsIndex);
    const switcherIndex = company.indexOf('<label className={styles.hotelSwitcher}>', tabListIndex);
    const panelIndex = company.indexOf('<section', switcherIndex);

    assert.ok(tabsIndex >= 0 && tabListIndex > tabsIndex && switcherIndex > tabListIndex && panelIndex > switcherIndex);
    assert.match(company, /className=\{styles\.visuallyHidden\}[\s\S]*Choose hotel to manage/);
    assert.doesNotMatch(company, /Hotel being managed|Hotel administrado/);
    assert.doesNotMatch(company, /id:\s*['"]activity['"]/);
    assert.doesNotMatch(company, /function ActivityPanel/);
    assert.match(company, /requested !== null && !isTabId\(requested\)[\s\S]*params\.set\(['"]tab['"], ['"]overview['"]\)[\s\S]*router\.replace/);
    assert.match(companyCss, /\.hotelSwitcher select \{[\s\S]*min-height: 42px;/);
  });

  test('includes member editing, removal, staff approvals, and both invitation paths', () => {
    assert.match(hotelTeam, /\/api\/auth\/team\?hotelId=/);
    assert.match(hotelTeam, /\/api\/staff\/join-requests\?hotelId=/);
    const accountList = hotelTeam.indexOf('className={styles.teamList}');
    const accountRows = hotelTeam.indexOf('team.map((member)', accountList);
    const approvalRows = hotelTeam.indexOf('requests.map((request)', accountList);
    assert.ok(accountList >= 0 && accountRows > accountList && approvalRows > accountRows);
    assert.match(hotelTeam, /Pending approval/);
    assert.match(hotelTeam, /copy\(lang, ['"]Approve['"]/);
    assert.match(hotelTeam, /copy\(lang, ['"]Deny['"]/);
    assert.match(hotelTeam, /aria-label=\{copy\(lang, `Approve \$\{request\.name\}`/);
    assert.match(hotelTeam, /aria-label=\{copy\(lang, `Deny \$\{request\.name\}`/);
    assert.doesNotMatch(hotelTeam, /Pending staff approvals|pending-approvals-title|No one is waiting for approval|Waiting room/);
    assert.match(hotelTeam, /LazyMemberDialog/);
    assert.match(hotelTeam, /LazyRemoveDialog/);
    assert.match(hotelTeam, /LazyInviteDialog/);
    assert.match(hotelTeamDialogs, /Staff signup link/);
    assert.match(hotelTeamDialogs, /Invite a General Manager/);
    assert.match(hotelTeamDialogs, /deliveryStatus === ['"]sent['"]/);
    assert.match(hotelTeamDialogs, /Copy and send the link directly/);
  });

  test('keeps account-wide effects honest and dialogs usable above the app shell', () => {
    assert.match(hotelTeamDialogs, /createPortal\(/);
    assert.match(hotelTeamDialogs, /document\.body/);
    assert.match(hotelTeamDialogs, /AbortSignal\.timeout\(15_000\)/);
    assert.match(hotelTeamDialogs, /This display name appears at every hotel/);
    assert.match(hotelTeamDialogs, /member\.email \|\| copy\(lang, ['"]Email unavailable['"]/);
    assert.match(hotelTeam, /createPortal\(/);
    assert.doesNotMatch(hotelTeamCss, /font:\s*[^;]*\binherit\s*;/);
    assert.doesNotMatch(hotelTeamCss, /min-height:\s*40px/);
  });
});

describe('mobile Company Hub touch targets', () => {
  test('small interactive controls reach the 44px mobile minimum', () => {
    const mobile = companyCss.slice(companyCss.indexOf('@media (max-width: 600px)'));
    assert.match(mobile, /\.reviewButton,[\s\S]*\.actionMenu summary,[\s\S]*\.actionMenu button \{\s*min-height: 44px;/);
    assert.match(mobile, /\.searchField > button,[\s\S]*\.iconButton \{\s*width: 44px;\s*height: 44px;/);
    assert.match(mobile, /\.filterChips button \{[\s\S]*min-height: 44px;/);
    assert.match(mobile, /\.hotelSwitcher,[\s\S]*\.hotelSwitcher select \{\s*min-height: 44px;/);
    const hotelTeamMobile = hotelTeamCss.slice(hotelTeamCss.indexOf('@media (max-width: 560px)'));
    assert.match(hotelTeamMobile, /\.editButton,[\s\S]*\.approveButton,[\s\S]*\.denyButton \{\s*min-height: 44px;/);
  });
});
