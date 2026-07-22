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
const operationalStaff = source('src', 'app', 'company', '_components', 'OperationalStaffSection.tsx');
const operationalStaffCss = source('src', 'app', 'company', '_components', 'OperationalStaffSection.module.css');
const operationalStaffRoute = source('src', 'app', 'api', 'staff', 'operational', 'route.ts');
const staffWriteGate = source('supabase', 'migrations', '0330_staff_management_write_gate.sql');
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
    assert.doesNotMatch(company, /PeopleStatusFilter|peopleStatusFilter/);
    assert.match(company, /<HotelTeamPanel/);
    assert.match(company, /<OperationalStaffSection/);
    assert.match(company, /<PeoplePanel\s+key=\{activeProperty\?\.id \?\? ['"]no-hotel['"]\}/);
    assert.match(operationalStaff, /Staff without a linked login/);
    assert.match(operationalStaff, /linkedIds\.has\(member\.id\)/);
    assert.doesNotMatch(operationalStaff, /Search operational staff|FilterBar|statusOptions/);
    assert.doesNotMatch(company, /statusFilter === ['"]invited['"]/);
    assert.match(company, /Organization access/);
    assert.match(company, /data\.invitations\.map/);
  });

  test('admin previews merge the exact hotel roster without crossing viewer contexts', () => {
    assert.match(propertyContext, /staffViewerKey/);
    assert.match(propertyContext, /setStaffViewerKey\(subscriptionViewerKey\)/);
    assert.match(propertyContext, /setStaffLoadFailed\(true\)/);
    assert.match(company, /staffViewerKey === `\$\{user\.uid\}:\$\{activePropertyId\}`/);
    assert.match(company, /rosterUnavailable=\{hotelRosterUnavailable\}/);
    assert.match(operationalStaff, /schedule roster is temporarily unavailable/);
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

  test('centers hotel switching in the hero and uses the freed toolbar slot for inviting staff', () => {
    const heroIndex = company.indexOf('<header className={styles.hero}>');
    const hotelSlotIndex = company.indexOf('<div className={styles.heroHotelSlot}>', heroIndex);
    const switcherIndex = company.indexOf('<HotelSwitcher', hotelSlotIndex);
    const heroEnd = company.indexOf('</header>', switcherIndex);
    const tabsIndex = company.indexOf('<div className={styles.tabs}>');
    const tabListIndex = company.indexOf('className={styles.tabList}', tabsIndex);
    const tabListEnd = company.indexOf('</nav>', tabListIndex);
    const inviteIndex = company.indexOf('className={styles.teamInviteButton}', tabListEnd);
    const panelIndex = company.indexOf('<section', inviteIndex);

    assert.ok(heroIndex >= 0 && hotelSlotIndex > heroIndex && switcherIndex > hotelSlotIndex && heroEnd > switcherIndex);
    assert.ok(tabsIndex > heroEnd && tabListIndex > tabsIndex && tabListEnd > tabListIndex && inviteIndex > tabListEnd && panelIndex > inviteIndex);
    assert.match(company.slice(switcherIndex, heroEnd), /label=\{localized\(lang, ['"]Choose hotel to manage['"]/);
    assert.match(company, /tab === ['"]people['"] && activeProperty && canManageTeam/);
    assert.match(company, /onClick=\{\(\) => setTeamInviteHotelId\(activeProperty\.id\)\}/);
    assert.match(company, /disabled=\{hotelTeamLocked\}/);
    assert.match(company, /aria-haspopup="dialog"/);
    assert.match(company, /inviteDialogOpen=\{teamInviteHotelId === activeProperty\?\.id\}/);
    assert.doesNotMatch(company, /styles\.hotelSwitcher/);
    assert.doesNotMatch(company, /Hotel being managed|Hotel administrado/);
    assert.doesNotMatch(company, /id:\s*['"]activity['"]/);
    assert.doesNotMatch(company, /function ActivityPanel/);
    assert.match(company, /requested !== null && !isTabId\(requested\)[\s\S]*params\.set\(['"]tab['"], ['"]overview['"]\)[\s\S]*router\.replace/);
    assert.match(companyCss, /\.hero \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
    assert.match(hotelSwitcherCss, /\.trigger \{[\s\S]*min-height: 44px;[\s\S]*grid-template-columns: 24px minmax\(0, 1fr\) 24px;/);
    assert.doesNotMatch(hotelSwitcherCss, /\.root \{[^}]*\n\s*width:/);
    assert.match(companyCss, /\.tabs \.teamInviteButton \{[\s\S]*min-height: 42px;[\s\S]*background: var\(--company-sage\);/);
  });

  test('waits for the exact hotel capability snapshot before showing team controls', () => {
    assert.match(company, /capabilityOverridesPropertyId === activePropertyId/);
    assert.match(company, /capabilityOverridesViewerKey === capabilityViewerKey/);
    assert.match(company, /const canManageTeam = hotelCapabilitiesReady && can\(['"]manage_team['"]\)/);
    assert.match(company, /tab === ['"]people['"] && hotelCapabilitiesLoading/);
    assert.match(company, /tab === ['"]people['"] && activeProperty && canManageTeam/);
    assert.match(company, /canManageTeam=\{canManageTeam\}/);
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
    assert.match(hotelTeam, /\{inviteDialogOpen \? \(/);
    assert.match(hotelTeam, /onClose=\{\(\) => onInviteDialogOpenChange\(false\)\}/);
    assert.match(hotelTeamDialogs, /Staff signup link/);
    assert.match(hotelTeamDialogs, /Invite a General Manager/);
    assert.match(hotelTeamDialogs, /deliveryStatus === ['"]sent['"]/);
    assert.match(hotelTeamDialogs, /Copy and send the link directly/);
  });

  test('keeps schedule-only staff compact and supports adding them without a login', () => {
    assert.match(operationalStaff, /aria-haspopup="dialog"/);
    assert.match(operationalStaff, /copy\(lang, ['"]Add['"], ['"]Agregar['"]\)/);
    assert.match(operationalStaff, /createPortal\(/);
    assert.match(operationalStaff, /role="dialog"/);
    assert.match(operationalStaff, /aria-modal="true"/);
    assert.match(operationalStaff, /event\.key === ['"]Escape['"]/);
    assert.match(operationalStaff, /event\.key !== ['"]Tab['"]/);
    assert.doesNotMatch(operationalStaff, /addStaffMember|@\/lib\/db\/staff/);
    assert.match(operationalStaff, /fetchWithAuth\(['"]\/api\/staff\/operational['"]/);
    assert.match(operationalStaff, /['"]Idempotency-Key['"]: attempt\.key/);
    assert.match(operationalStaff, /AbortSignal\.timeout\(15_000\)/);
    assert.match(operationalStaff, /body\.code !== ['"]IdempotencyInProgress['"]/);
    assert.match(operationalStaff, /if \(busyRef\.current\) return;/);
    assert.match(operationalStaff, /busyRef\.current = true;\s*setBusy\(true\)/);
    assert.match(operationalStaff, /const \[pendingAttempt, setPendingAttempt\] = React\.useState<OperationalStaffAttempt \| null>\(null\)/);
    assert.match(operationalStaff, /const attempt = pendingAttempt \?\? \{[\s\S]*payload:/);
    assert.match(operationalStaff, /onPendingAttemptChange\(attempt\)/);
    assert.match(operationalStaff, /pendingAttempt=\{pendingAttempt\}/);
    assert.match(operationalStaff, /body: JSON\.stringify\(attempt\.payload\)/);
    assert.match(operationalStaff, /disabled=\{busy \|\| retryLocked\}/);
    assert.match(operationalStaff, /That save is still processing\. Wait a moment, then try again\./);
    assert.doesNotMatch(operationalStaff, /will not create a duplicate|duplicate-safe/);
    assert.match(operationalStaff, /onAdded\(\{/);
    assert.match(operationalStaff, /optimisticStaff\.filter/);
    assert.match(operationalStaff, /setOptimisticStaff\(\(current\) => \{[\s\S]*!loadedIds\.has\(member\.id\)/);
    assert.match(operationalStaff, /loadedStaffIdsRef\.current\.has\(member\.id\)/);
    assert.match(operationalStaff, /document\.addEventListener\(['"]focusin['"]/);
    assert.match(operationalStaff, /element\.inert = true/);
    assert.match(operationalStaffRoute, /verifyTeamManager\(req\)/);
    assert.match(operationalStaffRoute, /\.from\(['"]accounts['"]\)[\s\S]*\.select\(['"]active, role, property_access['"]\)/);
    assert.match(operationalStaffRoute, /currentRole !== ['"]owner['"] && currentRole !== ['"]general_manager['"]/);
    assert.match(operationalStaffRoute, /currentHotelAccess\.includes\(hotelId\)/);
    assert.match(operationalStaffRoute, /\.from\(['"]capability_overrides['"]\)[\s\S]*\.eq\(['"]property_id['"], hotelId\)[\s\S]*\.eq\(['"]capability['"], ['"]manage_team['"]\)/);
    assert.match(operationalStaffRoute, /if \(overrideError\) return ['"]unavailable['"]/);
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
    assert.match(operationalStaff, /does not create a Staxis login or send an invitation/);
    assert.doesNotMatch(operationalStaff, /type="search"|All.*Active.*Not active/);
    assert.match(operationalStaffCss, /\.headingCopy h2 \{[\s\S]*font-size: 14\.5px;/);
    assert.match(operationalStaffCss, /\.staffRow \{[\s\S]*min-height: 58px;/);
    assert.match(operationalStaffCss, /\.stateRow \{[\s\S]*min-height: 64px;/);
    assert.match(operationalStaffCss, /\.addButton,[\s\S]*min-height: 44px;/);
    assert.match(operationalStaffCss, /\.field input,[\s\S]*min-height: 48px;/);
    assert.match(operationalStaffCss, /@media \(prefers-reduced-motion: reduce\)/);
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
    assert.match(mobile, /\.heroHotelSwitcher,[\s\S]*\.tabs \.teamInviteButton \{\s*min-height: 44px;/);
    assert.match(hotelSwitcherCss, /\.option \{[\s\S]*min-height: 44px;/);
    const hotelTeamMobile = hotelTeamCss.slice(hotelTeamCss.indexOf('@media (max-width: 560px)'));
    assert.match(hotelTeamMobile, /\.editButton,[\s\S]*\.approveButton,[\s\S]*\.denyButton \{\s*min-height: 44px;/);
  });
});
