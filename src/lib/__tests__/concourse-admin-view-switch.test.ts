import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const barView = source('src', 'components', 'concourse', 'ConcourseBarView.tsx');
const mobile = source('src', 'components', 'concourse', 'MobileConcourseNav.tsx');
const concourseCss = source('src', 'components', 'concourse', 'concourse-css.tsx');
const mobileCss = source('src', 'components', 'concourse', 'MobileConcourseNav.module.css');
const authContext = source('src', 'contexts', 'AuthContext.tsx');
const authorizationRoute = source('src', 'app', 'api', 'auth', 'session-authorization', 'route.ts');
const authorizationInvalidation = source('src', 'lib', 'auth', 'session-authorization-invalidation.ts');
const authorizationNotificationMigration = source('supabase', 'migrations', '0387_account_authorization_notifications.sql');
const company = source('src', 'app', 'company', 'page.tsx');
const companyCss = source('src', 'app', 'company', 'CompanyAccess.module.css');
const hotelTeam = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

/**
 * Regression cause: 057f0f67 correctly moved hotel-level Admin tools into the
 * `/company` page, but it deleted the unrelated Staxis platform-admin
 * destination from both shared navigation surfaces and changed this test to
 * require that deletion. These assertions keep the two concepts independent.
 */
describe('platform Admin destination and default in-place hotel Admin tools', () => {
  test('restores one distinct, exact Admin destination on desktop and phone', () => {
    assert.match(concourse, /onClick: \(\) => go\(['"]\/admin\/properties#live['"]\)/);
    assert.match(concourse, /adminDestination=\{adminDestination\}/g);
    assert.match(barView, /interface AdminDestinationAction/);
    assert.match(barView, /cx-admin-destination/);
    assert.match(barView, /aria-current=\{adminDestination\.active \? ['"]page['"] : undefined\}/);
    assert.match(mobile, /adminDestination\?: AdminDestinationAction/);
    assert.match(mobile, /styles\.adminDestinationRow/);
    assert.match(mobile, /<CxIcon name="admin" size=\{17\} \/>/);
    assert.match(concourseCss, /\.cx-pill\.cx-admin-destination:not\(\.cx-active\)/);
    assert.match(mobileCss, /\.adminDestinationRow \{/);
    assert.doesNotMatch(concourse, /items\.push\(\{[\s\S]*?key: ['"]admin['"]/);
  });

  test('shows the destination only after a fresh platform-admin verdict', () => {
    assert.match(concourse, /authorizationChecked && platformAdmin && user\?\.role === ['"]admin['"]/);
    assert.match(concourse, /const adminDestination:[\s\S]*?= verifiedPlatformAdmin[\s\S]*?\? \{/);
    assert.match(concourse, /if \(!authorizationChecked \|\| verifiedPlatformAdmin \|\| !adminWorkspaceActive\) return;[\s\S]*?replace\(['"]\/home['"]\)/);
    assert.doesNotMatch(concourse, /user\?\.role === ['"]admin['"] \? \{[\s\S]*?\/admin\/properties#live/);
  });

  test('keeps verified platform-admin preview data visible without customer mutations or a local toggle', () => {
    const heroIndex = company.indexOf('<header className={styles.hero}>');
    const heroEnd = company.indexOf('</header>', heroIndex);
    const heroMarkup = company.slice(heroIndex, heroEnd);

    assert.ok(heroIndex >= 0 && heroEnd > heroIndex);
    assert.match(company, /const adminPreview = Boolean\(\s*authorizationChecked && platformAdmin && userRole === ['"]admin['"]/);
    assert.match(company, /if \(!user \|\| authLoading \|\| propertyLoading \|\| !authorizationChecked\) return/);
    assert.doesNotMatch(company, /const adminPreview = userRole === ['"]admin['"]/);
    assert.match(company, /const adminActionsAvailable = Boolean\(\s*adminPreview[\s\S]*?adminViewerContext[\s\S]*?adminDataMatchesSelection/);
    assert.match(company, /const hotelMutationAuthorized = authorizationChecked && !adminPreview && Boolean\([\s\S]*activePropertyStanding\?\.hotelMutationAllowed/);
    assert.match(company, /const canViewHotelTeam = hotelCapabilitiesReady[\s\S]*adminPreview \|\| hotelMutationAuthorized/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) \|\| adminPreview\}/);
    assert.doesNotMatch(heroMarkup, /adminViewSwitch|type="checkbox"|role="switch"|Admin view|setAdminToolsEnabled/);
    assert.doesNotMatch(company, /adminToolsEnabled|adminToolsActive|setAdminToolsEnabled/);
    assert.doesNotMatch(company, /Review this hotel in read-only mode/);
    assert.match(company, /\{ id: ['"]hotels['"][\s\S]*?\{ id: ['"]people['"][\s\S]*?\{ id: ['"]access['"]/);
  });

  test('revalidates open sessions on authorization events, with focus and interval recovery', () => {
    assert.match(authContext, /fetchWithAuth\(['"]\/api\/auth\/session-authorization['"]/);
    assert.match(authContext, /subscribeToSessionAuthorizationInvalidations\(\{/);
    assert.match(authContext, /onInvalidate: \(\) => \{ void revalidateAuthorization\(\); \}/);
    assert.match(authContext, /if \(inFlight\) \{[\s\S]*?rerunRequested = true/);
    assert.match(authContext, /if \(active && rerunRequested\)[\s\S]*?void revalidateAuthorization\(\)/);
    assert.match(authorizationInvalidation, /table: ['"]account_authorization_notifications['"]/);
    assert.match(authorizationInvalidation, /filter: `data_user_id=eq\.\$\{input\.authUid\}`/);
    assert.match(authorizationInvalidation, /input\.onInvalidate/);
    assert.match(authorizationInvalidation, /status === ['"]SUBSCRIBED['"][\s\S]*?input\.onInvalidate\(\)/);
    assert.match(authorizationNotificationMigration, /after insert or update of authority_version[\s\S]*?account_authorization_state/);
    assert.match(authorizationNotificationMigration, /account_authorization_notifications_self_select/);
    assert.match(authContext, /window\.addEventListener\(['"]focus['"], revalidateWhenVisible\)/);
    assert.match(authContext, /document\.addEventListener\(['"]visibilitychange['"], revalidateWhenVisible\)/);
    assert.match(authContext, /AUTHORIZATION_REVALIDATE_INTERVAL_MS = 60_000/);
    assert.match(authContext, /window\.setInterval\([\s\S]*?AUTHORIZATION_REVALIDATE_INTERVAL_MS/);
    assert.match(authContext, /setAuthorizationChecked\(true\);\s*setPlatformAdmin\(snapshot\.platformAdmin\)/);
    assert.match(authContext, /catch \{[\s\S]*?Transient by contract[\s\S]*?\}/);
    const transientCatch = authContext.slice(
      authContext.indexOf('} catch {', authContext.indexOf('revalidateAuthorization = async')),
      authContext.indexOf('} finally {', authContext.indexOf('revalidateAuthorization = async')),
    );
    assert.doesNotMatch(transientCatch, /setAuthorizationChecked|setPlatformAdmin|setUser/);
  });

  test('uses a fresh self-session account lookup and forbids caching its verdict', () => {
    assert.match(authorizationRoute, /requireSession\(req, \{ requestId \}\)/);
    assert.match(authorizationRoute, /\.from\(['"]accounts['"]\)[\s\S]*?\.select\(['"]id, role, active['"]\)[\s\S]*?\.eq\(['"]data_user_id['"], session\.userId\)/);
    assert.match(authorizationRoute, /listAuthoritativePropertyAccess\(account\.id as string\)/);
    assert.doesNotMatch(authorizationRoute, /\.select\(['"][^'"]*property_access/);
    assert.match(authorizationRoute, /account\.active === true/);
    assert.match(authorizationRoute, /platformAdmin = active && account\.role === ['"]admin['"]/);
    assert.match(authorizationRoute, /private, no-store, max-age=0, must-revalidate/);
    assert.match(authorizationRoute, /Vary: ['"]Cookie, Authorization['"]/);
    assert.match(authorizationRoute, /if \(error\)[\s\S]*?status: 503[\s\S]*?ApiErrorCode\.UpstreamFailure/);
    assert.match(authorizationRoute, /if \(!account\)[\s\S]*?active: false[\s\S]*?platformAdmin: false/);
  });

  test('renders independently authorized hotel-team tools for the verified admin preview', () => {
    assert.match(company, /\/api\/admin\/company-access-preview\?pid=/);
    assert.match(company, /normalized\.viewerContext\?\.kind !== ['"]staxis_admin_preview['"]/);
    assert.match(company, /normalized\.viewerContext\.readOnly !== true/);
    assert.match(company, /key=\{`\$\{activeProperty\.id\}:\$\{adminPreview \? ['"]admin['"] : ['"]customer['"]\}:\$\{canManageTeam \? ['"]hotel-authorized['"] : ['"]invite-only['"]\}:\$\{hotelTeamVisible \? ['"]team-visible['"] : ['"]team-hidden['"]\}`\}/);
    assert.match(company, /canViewTeam=\{canViewHotelTeam\}/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) \|\| adminPreview\}/);
    assert.match(company, /canInviteAccounts=\{adminPreview \? false : canInviteAccounts\}/);
    assert.match(company, /canAddStaff=\{adminPreview \? false : canAddOperationalStaff\}/);
    assert.doesNotMatch(company, /allowAdminActions|onRequestAdminActions|setAdminToolsEnabled/);
    assert.match(company, /const hotelTeamLocked = Boolean\([\s\S]*?adminPreview[\s\S]*?resolved\.viewerContext\?\.readOnly === true && !adminActionsAvailable/);
    assert.match(hotelTeam, /const locked = readOnly \|\| adminPreview;/);
    assert.match(hotelTeam, /styles\.headingInviteButton[\s\S]*?onClick=\{\(\) => onInviteDialogOpenChange\(true\)\}[\s\S]*?disabled=\{inviteActionDisabled\}/);
    assert.match(company, /inviteDialogOpen=\{teamInviteHotelId === activeProperty\?\.id\}/);
    assert.match(hotelTeam, /const nextTeam = \(adminPreview \|\| readOnly\)[\s\S]*?!member\.isPlatformAdmin/);
  });

  test('removes the obsolete admin-only toggle copy without weakening customer read-only mode', () => {
    assert.doesNotMatch(company, /styles\.adminPreviewNotice|styles\.adminToolsNotice/);
    assert.doesNotMatch(company, /Hotel view · Read-only|Reviewing the hotel workspace/);
    assert.doesNotMatch(companyCss, /\.adminPreviewNotice|\.adminToolsNotice/);
    assert.doesNotMatch(hotelTeam, /styles\.readOnlyNotice|Read-only preview|You can review this hotel/);
    assert.doesNotMatch(hotelTeamCss, /\.readOnlyNotice/);
    assert.doesNotMatch(company, /Admin view|adminToolsEnabled|adminToolsActive/);
    assert.doesNotMatch(hotelTeam, /allowAdminActions|onRequestAdminActions|Turn on Admin view/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) \|\| adminPreview\}/);
    assert.match(hotelTeam, /const locked = readOnly \|\| adminPreview;/);
  });

  test('removes the obsolete switch styling while keeping the responsive hero layout', () => {
    assert.doesNotMatch(company, /adminViewSwitch|type="checkbox"|role="switch"/);
    assert.doesNotMatch(companyCss, /\.adminViewSwitch|\.heroActions/);
    const mobileRules = companyCss.slice(companyCss.indexOf('@media (max-width: 800px)'));
    assert.match(mobileRules, /\.hero \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
    assert.match(mobileRules, /\.heroHotelSlot \{[\s\S]*?grid-column: 2;[\s\S]*?width: min\(240px, 100%\);[\s\S]*?justify-self: center;/);
    const phoneRules = companyCss.slice(companyCss.indexOf('@media (max-width: 600px)'));
    assert.match(phoneRules, /\.heroIdentity,[\s\S]*?\.heroHotelSlot \{\s*grid-column: 1;/);
    const reducedMotion = companyCss.slice(companyCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.doesNotMatch(reducedMotion, /adminViewSwitch|heroActions/);
  });
});
