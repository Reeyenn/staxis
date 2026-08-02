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
const hotelSwitcher = source('src', 'app', 'company', '_components', 'HotelSwitcher.tsx');
const hotelSwitcherCss = source('src', 'app', 'company', '_components', 'HotelSwitcher.module.css');
const hotelTeam = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const hotelTeamDialogs = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');
const addStaffDialog = source('src', 'app', 'company', '_components', 'AddStaffDialog.tsx');
const employmentForm = source('src', 'app', 'company', '_components', 'PersonEmploymentForm.tsx');
const operationalStaffRoute = source('src', 'app', 'api', 'staff', 'operational', 'route.ts');
const staffWriteGate = source('supabase', 'migrations', '0330_staff_management_write_gate.sql');
const settings = source('src', 'app', 'settings', 'page.tsx');
const legacyAccounts = source('src', 'app', 'settings', 'accounts', 'page.tsx');
const legacyUsers = source('src', 'app', 'settings', 'users', 'page.tsx');
const propertyContext = source('src', 'contexts', 'PropertyContext.tsx');

describe('company-only shell routing', () => {
  test('changes the familiar section shell by explicit portfolio context', () => {
    assert.match(concourse, /const portfolioScoped = purePortfolioContext \|\| Boolean\(portfolioHotelContext\)/);
    assert.match(
      concourse,
      /portfolioScoped[\s\S]*?\? SECTION_LIST[\s\S]*?: propertyLoading \|\| !activeProperty[\s\S]*?\? \[\][\s\S]*?: SECTION_LIST/,
    );
    assert.match(concourse, /const companyOnly = !portfolioScoped[\s\S]*?properties\.length === 0/);
    assert.match(
      concourse,
      /const homeHref = portfolioScoped[\s\S]*?\? portfolioHomeHref[\s\S]*?: companyOnly[\s\S]*?\? '\/company'[\s\S]*?: '\/home'/,
    );
    assert.match(concourse, /if \(m\.key === 'staxis'\) return portfolioQueueAvailable/);
  });

  test('distinguishes an unselected portfolio from a truly zero-property company user', () => {
    assert.match(home, /const portfolio = usePortfolio\(\)/);
    assert.match(home, /portfolio\.data\.selection\.state === 'selected'/);
    assert.match(home, /portfolio\.data\.selection\.state === 'needs_selection'/);
    assert.match(home, /const portfolioEntryPending = shouldWaitForPortfolioEntry\(\{[\s\S]{0,100}?hotelDrilldown,[\s\S]{0,100}?portfolioLoading: portfolio\.loading/);
    assert.match(home, /user\.role === ['"]admin['"] \|\| properties\.length > 0/);
    assert.match(home, /replaceNavigation\('\/property-selector'\)/);
  });

  test('a two-company My Portfolio link reaches a terminal company chooser', () => {
    assert.match(company, /portfolioNeedsSelection[\s\S]{0,220}?router\.replace\('\/portfolio\/choose'\)/);
    assert.match(company, /title=\{'Choose a management company'\}/);
    assert.match(company, /&& !portfolioNeedsSelection/);
  });
});

describe('Home management entry', () => {
  test('renders below the department board without a divider heading or subtitle', () => {
    const boardIndex = homeHub.indexOf('className={`cx-board');
    const managementIndex = homeHub.indexOf('className="cx-management"');
    assert.ok(boardIndex >= 0 && managementIndex > boardIndex);
    assert.doesNotMatch(homeHub, /cx-management-head/);
    assert.doesNotMatch(homeHub, /cx-management-description/);
    assert.match(
      homeHub,
      /<Link[\s\S]*?href=\{management\.href\}[\s\S]*?className="cx-management-link"[\s\S]*?onClick=\{\(event\) =>/,
    );
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

  test('uses English adaptive labels and always opens the Company Hub route', () => {
    assert.match(home, /['"]Company Hub['"]/);
    assert.match(home, /['"]My Hotel['"]/);
    assert.doesNotMatch(home, /['"]Centro de empresa['"]/);
    assert.doesNotMatch(home, /['"]Mi hotel['"]/);
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
    assert.match(invitation, /aria-describedby=\{visibleError \? ['"]company-invite-error['"]/);
    assert.match(authShell, /role="alert" aria-live="assertive"/);
  });
});

describe('truthful Company Hub filters', () => {
  test('hotels use not-active semantics instead of calling every non-active row pending', () => {
    assert.match(company, /type HotelStatusFilter = ['"]all['"] \| ['"]active['"] \| ['"]not_active['"]/);
    assert.match(company, /property\.status === ['"]active['"] : property\.status !== ['"]active['"]/);
    assert.match(company, /value: ['"]not_active['"], label: ['"]Not active['"]/);
  });

  test('People is ONE list of everyone at the hotel, not logins stacked on leftovers', () => {
    assert.doesNotMatch(company, /PeopleStatusFilter|peopleStatusFilter/);
    assert.match(company, /<HotelTeamPanel/);
    // The second stacked list is gone: one person is one card now.
    assert.doesNotMatch(company, /OperationalStaffSection/);
    assert.match(company, /<PeoplePanel\s+key=\{activeProperty\?\.id \?\? ['"]no-hotel['"]\}/);
    assert.match(hotelTeam, /buildHotelRoster\(team, rosterStaff\)/);
    assert.match(hotelTeam, /const rosterStaff = React\.useMemo/);
    assert.match(company, /staffProfiles=\{staff\}/);
    assert.doesNotMatch(company, /statusFilter === ['"]invited['"]/);
    assert.match(company, /Roles and scopes by person/);
    assert.match(company, /data\.invitations\.map/);
  });

  test('admin previews merge the exact hotel roster without crossing viewer contexts', () => {
    assert.match(propertyContext, /staffViewerKey/);
    assert.match(propertyContext, /setStaffViewerKey\(subscriptionViewerKey\)/);
    assert.match(propertyContext, /setStaffLoadFailed\(true\)/);
    assert.match(company, /staffViewerKey === activePropertyViewerKey/);
    assert.match(company, /rosterUnavailable=\{hotelRosterUnavailable\}/);
    assert.match(hotelTeam, /schedule roster is temporarily unavailable/);
    assert.match(company, /hotelId=\{activeProperty\.id\}/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) && !adminPreview\}/);
    assert.match(company, /data\.viewerContext\?\.kind === ['"]staxis_admin_preview['"]/);
    assert.doesNotMatch(company, /allowAdminActions|onRequestAdminActions|adminToolsEnabled|adminToolsActive/);
    assert.match(company, /statusLabel\(membership\.status, lang\)/);
    assert.match(hotelTeam, /responseTeam\.filter\(\(member\) => !member\.isPlatformAdmin && member\.role !== ['"]admin['"]\)/);
  });
});

describe('My Hotel account and team integration', () => {
  test('moves the hotel-facing entry out of Settings and preserves old bookmarks', () => {
    assert.doesNotMatch(settings, /href:\s*['"]\/settings\/accounts['"]/);
    assert.doesNotMatch(settings, /href:\s*['"]\/settings\/users['"]/);
    assert.match(legacyAccounts, /replace\(['"]\/company\?tab=people['"]\)/);
    assert.match(legacyAccounts, /\/admin\/properties\/\$\{encodeURIComponent\(activePropertyId\)\}/);
    assert.match(legacyUsers, /redirect\(['"]\/company\?tab=access['"]\)/);
  });

  test('keeps the selected tab in the URL and selects an exact hotel', () => {
    assert.match(company, /useSearchParams\(\)/);
    assert.match(company, /params\.set\(['"]tab['"], next\)/);
    assert.match(company, /activeHotelId=\{activeProperty\?\.id \?\? null\}/);
    assert.match(company, /onSelect=\{\(hotelId\) => \{\s*setTeamInviteHotelId\(null\);\s*setActivePropertyId\(hotelId\);\s*\}\}/);
    assert.match(company, /hotels=\{contextProperties\}/);
  });

  test('starts My Team with the account tools instead of a redundant intro block', () => {
    assert.doesNotMatch(company, /People and team access|Personas y acceso del equipo/);
    assert.doesNotMatch(company, /Manage hotel logins, invitations, approvals|Administra accesos, invitaciones, aprobaciones/);
    assert.doesNotMatch(hotelTeam, /['"]Hotel accounts['"]|['"]Cuentas del hotel['"]/);
    assert.doesNotMatch(hotelTeam, /Team logins and invitations|Accesos e invitaciones del equipo/);
    assert.doesNotMatch(hotelTeam, /Manage only the accounts connected|Administra solo las cuentas conectadas/);
    assert.doesNotMatch(hotelTeamCss, /\.headingRow|\.headingCopy/);
    assert.match(hotelTeam, /<div className=\{styles\.root\}>\s*<section className=\{styles\.subsection\} aria-labelledby="team-members-title">/);
    assert.match(hotelTeam, /<h2 id="team-members-title">/);
  });

  test('keeps three connected tabs and moves the team count and invite action into the roster header', () => {
    const heroIndex = company.indexOf('<header className={styles.hero}>');
    const hotelSlotIndex = company.indexOf('<div className={styles.heroHotelSlot}>', heroIndex);
    const switcherIndex = company.indexOf('<HotelSwitcher', hotelSlotIndex);
    const heroEnd = company.indexOf('</header>', switcherIndex);
    const tabsIndex = company.indexOf('<div className={styles.tabs}>');
    const tabListIndex = company.indexOf('className={styles.tabList}', tabsIndex);
    const tabListEnd = company.indexOf('</nav>', tabListIndex);
    const tabsEnd = company.indexOf('</div>', tabListEnd);
    const panelIndex = company.indexOf('<section', tabsEnd);
    const subheadingIndex = hotelTeam.indexOf('<div className={styles.subheading}>');
    const titleRowIndex = hotelTeam.indexOf('<div className={styles.subheadingTitleRow}>', subheadingIndex);
    const countIndex = hotelTeam.indexOf('<strong aria-label=', titleRowIndex);
    const inviteIndex = hotelTeam.indexOf('styles.headingInviteButton', countIndex);
    const teamListIndex = hotelTeam.indexOf('className={styles.teamList}', inviteIndex);

    assert.ok(heroIndex >= 0 && hotelSlotIndex > heroIndex && switcherIndex > hotelSlotIndex && heroEnd > switcherIndex);
    assert.ok(tabsIndex > heroEnd && tabListIndex > tabsIndex && tabListEnd > tabListIndex && tabsEnd > tabListEnd);
    assert.ok(panelIndex > tabsEnd);
    assert.ok(subheadingIndex >= 0 && titleRowIndex > subheadingIndex && countIndex > titleRowIndex && inviteIndex > countIndex && teamListIndex > inviteIndex);
    assert.match(company.slice(switcherIndex, heroEnd), /label=\{['"]Choose hotel to manage['"]\}/);
    assert.doesNotMatch(company, /styles\.teamInviteRow|styles\.teamInviteButton/);
    assert.match(hotelTeam, /onClick=\{\(\) => onInviteDialogOpenChange\(true\)\}/);
    assert.match(hotelTeam, /disabled=\{inviteActionDisabled\}/);
    assert.match(hotelTeam, /aria-haspopup="dialog"/);
    assert.match(company, /inviteDialogOpen=\{teamInviteHotelId === activeProperty\?\.id\}/);
    assert.doesNotMatch(company, /styles\.hotelSwitcher/);
    assert.doesNotMatch(company, /Hotel being managed|Hotel administrado/);
    assert.doesNotMatch(company, /id:\s*['"]activity['"]/);
    assert.doesNotMatch(company, /function ActivityPanel/);
    assert.match(company, /\{ id: ['"]hotels['"][\s\S]*?\{ id: ['"]people['"][\s\S]*?\{ id: ['"]access['"]/);
    assert.doesNotMatch(company, /\{ id: ['"]overview['"]/);
    assert.match(company, /requested === ['"]overview['"] \|\| \(requested !== null && !isTabId\(requested\)\)[\s\S]*params\.set\(['"]tab['"], ['"]hotels['"]\)[\s\S]*router\.replace/);
    assert.match(companyCss, /\.hero \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
    assert.match(hotelSwitcherCss, /\.trigger \{[\s\S]*min-height: 44px;[\s\S]*grid-template-columns: 24px minmax\(0, 1fr\) 24px;/);
    assert.doesNotMatch(hotelSwitcherCss, /\.root \{[^}]*\n\s*width:/);
    assert.match(companyCss, /\.tabList \{[\s\S]*flex: 1 0 448px;/);
    assert.doesNotMatch(companyCss, /\.teamInviteRow|\.teamInviteButton/);
    assert.match(hotelTeamCss, /\.subheadingTitleRow \{[\s\S]*display: flex;[\s\S]*gap: 8px;/);
    assert.match(hotelTeamCss, /\.headingInviteButton \{[\s\S]*width: calc\(\(100% - 12px\) \/ 4\);[\s\S]*min-width: 172px;/);
  });

  test('defaults legacy and invalid URLs to Hotels and removes Overview-only copy', () => {
    assert.match(company, /return isTabId\(requested\) \? requested : ['"]hotels['"]/);
    assert.match(company, /const next = isTabId\(requested\) \? requested : ['"]hotels['"]/);
    assert.doesNotMatch(company, /OverviewPanel|SummaryCard|CompanyStructureOverview|CompanyRulebookPanel/);
    assert.doesNotMatch(company, /Staxis admin view|Portfolio workspace|Company workspace|See your hotels, team, and exactly why you have access/);
    assert.doesNotMatch(company, /Property scope|Hotels you can access|Grouped by organization, portfolio, or region\./);
    assert.doesNotMatch(company, /Company people|Effective access|Access records|Access is managed/);
    assert.match(company, /<FilterBar[\s\S]*<OrganizationHierarchy/);
    assert.match(company, /data\.viewerContext\?\.kind === ['"]staxis_admin_preview['"][\s\S]*<AdminHotelRelationshipManager/);
    assert.match(company, /title=\{['"]Memberships and invitations['"]\}/);
    assert.match(company, /title=\{adminPreview[\s\S]*['"]Customer grants['"][\s\S]*['"]Access grants['"]/);
    assert.doesNotMatch(hotelTeam, /<span>\{'Hotel roster'\}<\/span>/);
  });

  test('keeps property roster loading local to People and uses a neutral surface skeleton', () => {
    const loadingExpression = company.slice(
      company.indexOf('const showLoading'),
      company.indexOf('const adminPreviewFailed'),
    );
    assert.match(company, /const peopleRosterLoading = tab === ['"]people['"][\s\S]*currentData\?\.viewerContext\?\.scope === ['"]property['"]/);
    assert.doesNotMatch(company, /const propertyRosterLoading/);
    assert.match(loadingExpression, /\|\| peopleRosterLoading/);
    assert.doesNotMatch(loadingExpression, /propertyRosterLoading/);
    assert.match(company, /function CompanyHubSkeleton\(\)/);
    assert.match(company, /className=\{styles\.skeletonSurface\}/);
    assert.doesNotMatch(company, /skeletonStack|skeletonGrid|skeletonCard|skeletonPanel/);
  });

  test('waits for the exact hotel capability snapshot before showing team controls', () => {
    assert.match(company, /capabilityOverridesPropertyId === activePropertyId/);
    assert.match(company, /capabilityOverridesViewerKey === capabilityViewerKey/);
    assert.match(company, /propertyStandings\.filter\(\(standing\) => standing\.propertyId === activePropertyId\)/);
    assert.match(company, /matchingPropertyStandings\.length === 1/);
    assert.match(company, /activePropertyStanding\?\.hotelMutationAllowed === true/);
    assert.match(company, /canForStanding\([\s\S]*hotelPresentationRole[\s\S]*['"]manage_team['"][\s\S]*capabilityOverrides/);
    assert.match(company, /const adminPreview = Boolean\(\s*authorizationChecked && platformAdmin && userRole === 'admin',?\s*\)/);
    assert.match(company, /if \(!user \|\| authLoading \|\| propertyLoading \|\| !authorizationChecked\) return/);
    // Every value that changes the authoritative viewer, hotel, or fetched
    // projection must invalidate this request; language-only renders must not.
    assert.match(company, /\[authLoading, currentViewerKey, propertyLoading, retryKey\]/);
    assert.match(company, /const requestedViewerKey = currentViewerKey/);
    assert.match(company, /currentViewerKey[\s\S]*authorizationFingerprint \?\? ['"]unverified['"]/);
    assert.match(company, /hotel-authorized['"] : ['"]invite-only/);
    assert.match(company, /tab === ['"]people['"] && hotelCapabilitiesLoading/);
    assert.match(company, /canManageTeam=\{canManageTeam\}/);
    assert.match(hotelTeam, /if \(!canManageTeam\) \{[\s\S]*Hotel account settings are private/);
    assert.match(hotelTeam, /if \(canManageTeam\) return;[\s\S]*setTeam\(\[\]\);[\s\S]*setContactSnapshot\(null\);[\s\S]*setWageSnapshot\(null\)/);
  });

  test('keeps company invitations in People while private hotel roster access stays explicit', () => {
    assert.match(company, /resolved\.permissions\.accountInvitePropertyIds\?\.includes\(activeProperty\.id\)/);
    assert.match(company, /canInviteAccounts=\{Boolean\([\s\S]*adminActionsAvailable[\s\S]*accountInvitePropertyIds/);
    assert.match(company, /canInviteAccounts=\{canInviteAccounts\}/);
    assert.match(company, /!adminPreview && !activeProperty && !canManageTeam && canInviteAccounts/);
    assert.doesNotMatch(company, /<InvitePersonDialog/);
    assert.match(hotelTeam, /inviteDialogOpen && canInviteAccounts[\s\S]*canManageHotelRoster=\{false\}/);
    assert.match(hotelTeamDialogs, /if \(!canManageHotelRoster\)[\s\S]*setCodeLoading\(false\)/);
    assert.match(hotelTeamDialogs, /\{canManageHotelRoster && inviteMode === 'shared' \? \([\s\S]*staff-invite-heading/);
    assert.match(hotelTeamDialogs, /fetchWithAuth\(`\/api\/auth\/invites\?hotelId=/);
  });

  test('uses a styled accessible hotel menu instead of a browser-native select', () => {
    assert.doesNotMatch(hotelSwitcher, /<select|<option/);
    assert.match(hotelSwitcher, /role="combobox"/);
    assert.match(hotelSwitcher, /aria-haspopup="listbox"/);
    assert.match(hotelSwitcher, /aria-expanded=\{open\}/);
    assert.match(hotelSwitcher, /aria-controls=\{open \? listboxId : undefined\}/);
    assert.match(hotelSwitcher, /aria-activedescendant=/);
    assert.match(hotelSwitcher, /role="listbox"/);
    assert.match(hotelSwitcher, /role="option"/);
    assert.match(hotelSwitcher, /aria-selected=\{selected\}/);
    assert.match(hotelSwitcher, /const selected = hotel\.id === activeHotelId/);
    assert.match(hotelSwitcher, /aria-activedescendant=\{open && hotels\[highlightedIndex\] \? `\$\{listboxId\}-option-\$\{highlightedIndex\}`/);
    assert.match(hotelSwitcher, /id=\{`\$\{listboxId\}-option-\$\{index\}`\}/);
    assert.match(hotelSwitcher, /tabIndex=\{-1\}/);
    assert.match(hotelSwitcher, /event\.key === ['"]ArrowDown['"] \|\| event\.key === ['"]ArrowUp['"]/);
    assert.match(hotelSwitcher, /event\.key === ['"]Escape['"] && open/);
    assert.match(hotelSwitcher, /event\.stopPropagation\(\)/);
    assert.match(hotelSwitcher, /event\.key === ['"]Tab['"][\s\S]*if \(open\) chooseHotel\(highlightedIndex\)/);
    assert.match(hotelSwitcher, /event\.key === ['"]Home['"][\s\S]*openMenu\(0\)/);
    assert.match(hotelSwitcher, /cyclingOneLetter/);
    assert.match(hotelSwitcher, /else typeaheadValueRef\.current = ['"]['"]/);
    assert.match(hotelSwitcher, /document\.addEventListener\(['"]pointerdown['"], closeWhenOutside, true\)/);
    assert.match(hotelSwitcherCss, /\.menu \{[\s\S]*z-index: 120;[\s\S]*max-height:[\s\S]*overflow-y: auto;[\s\S]*background: rgba\(255, 255, 255, 0\.98\);[\s\S]*box-shadow:/);
    assert.match(hotelSwitcherCss, /\.option \{[\s\S]*min-height: 44px;/);
    assert.match(hotelSwitcherCss, /\.option\[aria-selected='true'\]/);
    assert.match(hotelSwitcherCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.menu \{\s*animation: none;/);
    assert.match(companyCss, /\.hero \{[\s\S]*z-index: 2;/);
    assert.match(companyCss, /\.tabs \{[\s\S]*z-index: 1;/);
  });

  test('includes member editing, removal, staff approvals, and both invitation paths', () => {
    assert.match(hotelTeam, /\/api\/auth\/team\?hotelId=/);
    assert.match(hotelTeam, /\/api\/staff\/join-requests\?hotelId=/);
    const approvalList = hotelTeam.indexOf('className={styles.teamList}');
    const approvalRows = hotelTeam.indexOf('requests.map((request)', approvalList);
    const peopleGrid = hotelTeam.indexOf('className={styles.departmentGrid}', approvalRows);
    // Approvals sit above the roster: somebody waiting to be let in is the
    // only thing on this page that needs an answer today.
    assert.ok(approvalList >= 0 && approvalRows > approvalList && peopleGrid > approvalRows);
    assert.match(hotelTeam, /Pending approval/);
    assert.match(hotelTeam, /\{'Approve'\}/);
    assert.match(hotelTeam, /\{'Deny'\}/);
    assert.match(hotelTeam, /aria-label=\{`Approve \$\{request\.name\}`\}/);
    assert.match(hotelTeam, /aria-label=\{`Deny \$\{request\.name\}`\}/);
    assert.doesNotMatch(hotelTeam, /Pending staff approvals|pending-approvals-title|No one is waiting for approval|Waiting room/);
    assert.match(hotelTeam, /LazyMemberDialog/);
    assert.match(hotelTeam, /LazyRemoveDialog/);
    assert.match(hotelTeam, /LazyFirstPersonInviteDialog/);
    assert.match(hotelTeam, /LazyInviteDialog/);
    assert.match(hotelTeam, /\{inviteDialogOpen && needsFirstPerson \? \([\s\S]*: inviteDialogOpen \? \(/);
    assert.match(hotelTeam, /onClose=\{\(\) => onInviteDialogOpenChange\(false\)\}/);
    assert.match(hotelTeamDialogs, /PeopleInviteChooserDialog/);
    assert.match(hotelTeamDialogs, /Add staff member/);
    assert.match(hotelTeamDialogs, /Add them to this hotel's roster and schedule\. No Staxis account\./);
    assert.match(hotelTeam, /Invite people/);
    assert.match(hotelTeam, /Add someone to the schedule, or invite them to create a Staxis account\./);
    assert.match(hotelTeamDialogs, /Invite to Staxis/);
    assert.match(hotelTeamDialogs, /Send an email invite or share a link, QR code, or invite code\./);
    assert.match(hotelTeam, /Use Invite people when they need Staxis login access/);
    assert.match(hotelTeamDialogs, /Shared hotel invite/);
    assert.match(hotelTeamDialogs, /Email one person/);
    assert.match(hotelTeamDialogs, /role="tablist"/);
    assert.match(hotelTeamDialogs, /role="tab"/);
    assert.match(hotelTeamDialogs, /role=\{hasInviteModeChoice \? 'tabpanel' : undefined\}/);
    assert.match(hotelTeamDialogs, /deliveryStatus === ['"]sent['"]/);
    assert.match(hotelTeamDialogs, /Copy and send the link directly/);
    assert.match(hotelTeam, /member\.isActive !== false && !linkedStaffIds\.has\(member\.id\)/);
    assert.match(hotelTeam, /unlinkedRosterProfiles=\{unlinkedRosterProfiles\}/);
    assert.match(hotelTeamDialogs, /const OPERATIONAL_INVITE_JOBS[\s\S]*'housekeeping'[\s\S]*'front_desk'[\s\S]*'maintenance'/);
    assert.match(hotelTeamDialogs, /profile\.department === selectedOperationalJob/);
    assert.match(
      hotelTeamDialogs,
      /const currentHotelCoveredByInvite[\s\S]*selectedInviteJob\?\.scope === 'property'[\s\S]*allowedInviteHotelIds\.has\(hotelId\)[\s\S]*inviteHotelIds\.includes\(hotelId\)/,
    );
    assert.match(hotelTeamDialogs, /linkableRosterProfiles\.length > 0/);
    assert.match(hotelTeamDialogs, /Link to roster profile/);
    assert.match(hotelTeamDialogs, /staffId: selectedRosterProfile\.id/);
    assert.match(hotelTeamDialogs, /data\.accessGranted === true/);
    assert.match(hotelTeamDialogs, /Access granted — no email sent/);
    assert.match(hotelTeamDialogs, /Their login is now linked to/);
    assert.match(hotelTeamDialogs, /reuses one clear matching roster profile or creates a new one/);
    assert.match(hotelTeamCss, /\.rosterLinkField \{[\s\S]*grid-column: 1 \/ -1;/);
  });

  test('keeps one Add that creates a schedule profile and no login', () => {
    assert.match(hotelTeam, /aria-haspopup="dialog"/);
    assert.match(hotelTeam, /setAddDepartment\(group\.key as StaffDepartment\)/);
    assert.match(addStaffDialog, /createPortal\(/);
    assert.match(addStaffDialog, /role="dialog"/);
    assert.match(addStaffDialog, /aria-modal="true"/);
    assert.match(addStaffDialog, /event\.key === ['"]Escape['"]/);
    assert.match(addStaffDialog, /event\.key !== ['"]Tab['"]/);
    assert.doesNotMatch(addStaffDialog, /addStaffMember|@\/lib\/db\/staff/);
    assert.match(addStaffDialog, /fetchWithAuth\(['"]\/api\/staff\/operational['"]/);
    assert.match(addStaffDialog, /['"]Idempotency-Key['"]: attempt\.key/);
    assert.match(addStaffDialog, /AbortSignal\.timeout\(15_000\)/);
    assert.match(addStaffDialog, /body\.code !== ['"]IdempotencyInProgress['"]/);
    assert.match(addStaffDialog, /if \(busyRef\.current\) return;/);
    assert.match(addStaffDialog, /busyRef\.current = true;\s*setBusy\(true\)/);
    assert.match(hotelTeam, /const \[pendingAddAttempt, setPendingAddAttempt\] = React\.useState<AddStaffAttempt \| null>\(null\)/);
    assert.match(addStaffDialog, /const attempt = pendingAttempt \?\? \{[\s\S]*payload:/);
    assert.match(addStaffDialog, /onPendingAttemptChange\(attempt\)/);
    assert.match(hotelTeam, /pendingAttempt=\{pendingAddAttempt\}/);
    assert.match(addStaffDialog, /body: JSON\.stringify\(attempt\.payload\)/);
    assert.match(addStaffDialog, /disabled=\{busy \|\| retryLocked\}/);
    assert.match(addStaffDialog, /That save is still processing\. Wait a moment, then try again\./);
    assert.doesNotMatch(addStaffDialog, /will not create a duplicate|duplicate-safe/);
    assert.match(addStaffDialog, /onAdded\(\{/);
    assert.match(hotelTeam, /optimisticStaff\.filter/);
    assert.match(addStaffDialog, /document\.addEventListener\(['"]focusin['"]/);
    assert.match(addStaffDialog, /element\.inert = true/);
    assert.match(addStaffDialog, /No Staxis account will be created/);
    assert.match(addStaffDialog, /Add without login/);
    assert.match(operationalStaffRoute, /verifyTeamManager\(req\)/);
    assert.match(operationalStaffRoute, /accountCapabilityDecisionForProperty\(/);
    assert.match(operationalStaffRoute, /caller\.authUserId,[\s\S]*['"]manage_team['"],[\s\S]*hotelId,[\s\S]*\{ requireMutation: true \}/);
    assert.doesNotMatch(operationalStaffRoute, /\.select\(['"]active, role, property_access['"]\)/);
    assert.match(operationalStaffRoute, /authorization === ['"]unavailable['"][\s\S]*status: 503[\s\S]*ApiErrorCode\.UpstreamFailure/);
    assert.match(operationalStaffRoute, /validateUuid\(body\.hotelId, ['"]hotelId['"]\)/);
    assert.match(operationalStaffRoute, /checkIdempotency\(req, routeKey\)/);
    assert.match(operationalStaffRoute, /staff-operational-create:\$\{hotelId\}:\$\{caller\.accountId\}/);
    assert.match(operationalStaffRoute, /supabaseAdmin\s*\.from\(['"]staff['"]\)\s*\.insert\(staffRow\)/);
    assert.match(operationalStaffRoute, /property_id: hotelId/);
    assert.match(operationalStaffRoute, /scheduledToday: false/);
    assert.match(operationalStaffRoute, /weeklyHours: 0/);
    assert.match(operationalStaffRoute, /schedulePriority: ['"]normal['"]/);
    assert.match(staffWriteGate, /create or replace function public\.staxis_user_can_manage_staff/);
    assert.match(staffWriteGate, /a\.role in \(['"]owner['"], ['"]general_manager['"]\)/);
    assert.match(staffWriteGate, /o\.capability = ['"]manage_team['"]/);
    assert.match(staffWriteGate, /drop policy if exists ['"]owner rw staff['"] on public\.staff/);
    assert.match(staffWriteGate, /create policy staff_property_roster_select[\s\S]*for select/);
    assert.match(staffWriteGate, /create policy staff_manage_insert[\s\S]*for insert/);
    assert.match(staffWriteGate, /create policy staff_manage_update[\s\S]*for update/);
    assert.match(staffWriteGate, /create policy staff_manage_delete[\s\S]*for delete/);
    assert.match(staffWriteGate, /public\.mfa_verified_or_grace\(\)/);
    assert.match(addStaffDialog, /No Staxis account will be created, and they will not be able to log in/);
    assert.doesNotMatch(addStaffDialog, /type="search"|All.*Active.*Not active/);
    assert.match(hotelTeamCss, /\.departmentAdd \{[\s\S]*min-height: 44px;/);
    assert.match(hotelTeamCss, /@media \(prefers-reduced-motion: reduce\)/);
  });

  test('the wage field and its write stay behind the manager-floor capability', () => {
    // view_wages is in MANAGER_FLOOR_CAPABILITIES: it can never fall to line
    // staff, and the route re-checks it. The merged panel must not become a
    // way around either half of that.
    assert.match(company, /activePropertyStanding\?\.seesFinancials === true/);
    assert.match(company, /canForStanding\([\s\S]*hotelPresentationRole[\s\S]*['"]view_wages['"][\s\S]*capabilityOverrides/);
    assert.match(company, /canViewWages=\{canViewWages\}/);
    assert.match(hotelTeam, /if \(!hotelId \|\| !canManageTeam \|\| !canViewWages\) return;/);
    assert.match(employmentForm, /\{canViewWages \? \(/);
    assert.match(employmentForm, /if \(canViewWages && wageTouched\) \{/);
  });

  test('keeps account-wide effects honest and dialogs usable above the app shell', () => {
    assert.match(hotelTeamDialogs, /createPortal\(/);
    assert.match(hotelTeamDialogs, /document\.body/);
    assert.match(hotelTeamDialogs, /AbortSignal\.timeout\(15_000\)/);
    assert.match(hotelTeamDialogs, /This display name appears at every hotel/);
    assert.match(hotelTeamDialogs, /member\.email \|\| ['"]Email unavailable['"]/);
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
    assert.match(mobile, /\.heroHotelSwitcher \{\s*min-height: 44px;/);
    assert.match(hotelSwitcherCss, /\.option \{[\s\S]*min-height: 44px;/);
    const hotelTeamMobile = hotelTeamCss.slice(hotelTeamCss.indexOf('@media (max-width: 560px)'));
    assert.match(hotelTeamMobile, /\.headingInviteButton \{\s*width: 100%;/);
    assert.match(hotelTeamMobile, /\.editButton,[\s\S]*\.approveButton,[\s\S]*\.denyButton \{\s*min-height: 44px;/);
  });
});
