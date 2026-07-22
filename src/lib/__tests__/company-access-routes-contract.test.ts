import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const getRoute = source('src/app/api/company-access/route.ts');
const inviteRoute = source('src/app/api/company-access/invitations/route.ts');
const requestRoute = source('src/app/api/company-access/requests/route.ts');
const reviewRoute = source('src/app/api/company-access/requests/review/route.ts');
const authAcceptRoute = source('src/app/api/company-access/invitations/accept/route.ts');
const registerRoute = source('src/app/api/company-access/invitations/register/route.ts');
const registrationRollback = source('src/lib/company-access/registration-identity-rollback.ts');
const revokeGrantRoute = source('src/app/api/company-access/grants/revoke/route.ts');
const cancelInvitationRoute = source('src/app/api/company-access/invitations/cancel/route.ts');
const membershipStatusRoute = source('src/app/api/company-access/memberships/status/route.ts');
const adminPreviewRoute = source('src/app/api/admin/company-access-preview/route.ts');
const adminPreviewHelpers = source('src/lib/company-access/admin-preview.ts');
const dialog = source('src/app/company/_components/AccessWorkflowDialogs.tsx');
const page = source('src/app/company/page.tsx');
const signIn = source('src/app/signin/page.tsx');

describe('company access read/delegation boundary', () => {
  test('derives tenant membership from the authenticated account and projects per-org policies', () => {
    assert.match(getRoute, /requireSession\(req/);
    assert.match(getRoute, /\.eq\(['"]account_id['"], actorAccountId\)/);
    assert.match(getRoute, /const delegationPolicies:[\s\S]*canDelegateAccess/);
    assert.match(getRoute, /organizationId, profiles/);
    assert.match(getRoute, /organization\.organization_type !== ['"]single_hotel['"]/);
  });

  test('keeps customer access closed to admins and uses a separate read-only preview boundary', () => {
    assert.match(getRoute, /account\.role === ['"]admin['"][\s\S]*Admin Hotels workspace[\s\S]*status: 403/);
    assert.match(adminPreviewRoute, /requireAdmin\(req\)/);
    assert.match(adminPreviewRoute, /validateUuid\(new URL\(req\.url\)\.searchParams\.get\(['"]pid['"]\), ['"]pid['"]\)/);
    assert.match(page, /\/api\/admin\/company-access-preview\?pid=/);
    assert.match(page, /normalized\.viewerContext\?\.kind !== ['"]staxis_admin_preview['"]/);
    assert.match(page, /normalized\.viewerContext\.requestedPropertyId !== requestedPropertyId/);
    assert.doesNotMatch(page, /user\?\.role === ['"]admin['"]\) router\.replace/);

    const adminFailure = page.indexOf("if (user.role === 'admin')", page.indexOf('} catch (error)'));
    const legacyFallback = page.indexOf('setData(buildLegacyProjection(user, contextProperties))');
    assert.ok(adminFailure >= 0 && legacyFallback > adminFailure, 'admin preview failure must be handled before customer fallback');
    assert.match(page.slice(adminFailure, legacyFallback), /setData\(null\)/);

    assert.match(adminPreviewHelpers, /effectiveAccess: \[\]/);
    assert.match(adminPreviewHelpers, /managePeople: false/);
    assert.match(adminPreviewHelpers, /manageInvitations: false/);
    assert.match(adminPreviewHelpers, /manageAccess: false/);
    assert.match(adminPreviewHelpers, /requestAccess: false/);
    assert.match(adminPreviewHelpers, /canRevoke: false/);
    assert.match(adminPreviewHelpers, /canCancel: false/);
    assert.match(adminPreviewHelpers, /canReview: false/);
  });

  test('fails closed when the account is inactive, including immediately before legacy fallback', () => {
    assert.match(getRoute, /const account = accountData as AccountRow;[\s\S]*account\.active !== true[\s\S]*Account not found/);
    const fallbackCheck = getRoute.indexOf(".select('active')", getRoute.indexOf('fallbackAccount'));
    const legacyProjection = getRoute.lastIndexOf('legacyProjection(account)');
    assert.ok(fallbackCheck >= 0 && legacyProjection > fallbackCheck, 'active account must be re-checked before legacy fallback');
    assert.match(getRoute, /fallbackAccount\?\.active !== true[\s\S]*Account not found/);
  });

  test('invite dialog consumes server policies rather than globally combining receipts', () => {
    assert.match(dialog, /data\.permissions\.delegationPolicies/);
    assert.match(dialog, /delegationSelectionAllowed/);
    assert.doesNotMatch(dialog, /function permittedScopeTargets/);
  });

  test('people and activity scopes are derived from only grants carrying that capability', () => {
    assert.match(getRoute, /const viewPeopleGrants = item\.actorGrants\.filter[\s\S]*includes\(['"]view_people['"]\)/);
    assert.match(getRoute, /viewPeoplePropertyIds/);
    assert.match(getRoute, /const activityGrants = item\.actorGrants\.filter[\s\S]*includes\(['"]view_activity['"]\)/);
    assert.match(getRoute, /activityPropertyIds/);
    assert.match(getRoute, /activeWindow\(String\(grant\.startsAt\), grant\.expiresAt \? String\(grant\.expiresAt\) : null, nowMs\)/);
    assert.match(getRoute, /const activePortfolio = facts\.portfolios\.some[\s\S]*portfolio\.status === ['"]active['"][\s\S]*if \(!activePortfolio\) return \[\]/);
  });

  test('loads workflow and activity through one bounded tenant-scoped database feed', () => {
    assert.match(getRoute, /rpc\(\s*['"]staxis_company_access_feed['"]/);
    assert.match(getRoute, /p_actor_account_id: actorAccountId/);
    assert.match(getRoute, /p_limit: COMPANY_PROJECTION_PAGE_SIZE/);
    assert.doesNotMatch(getRoute, /const invitationResults|requestQueryForScope|eventQueryPlans/);
    assert.match(getRoute, /feed\.invitations\.filter[\s\S]*canDelegateAccess/);
    assert.match(getRoute, /feed\.requests\.filter[\s\S]*requestCanBeManaged\(request\) \|\| requestIsOwn\(request\)/);
    assert.match(getRoute, /feed\.activity\.filter[\s\S]*allowedTargetIds/);
    assert.match(getRoute, /event\.full_organization_scope === true/);
    assert.match(getRoute, /event\.authorized_property_ids\.some/);
  });

  test('loads normalized authorization facts completely with bounded id filters', () => {
    assert.match(getRoute, /readCompleteCompanyPages<MembershipRow>/);
    assert.match(getRoute, /readCompleteCompanyIdChunks<OrganizationRow>/);
    assert.match(getRoute, /select\([^\n]+\{ count: ['"]exact['"] \}\)/);
    assert.doesNotMatch(getRoute, /Promise\.all\(organizationIds\.map/);
    assert.doesNotMatch(getRoute, /\.in\(['"]organization_id['"], organizationIds\)/);
  });
});

describe('company access mutations', () => {
  test('invitation creation double-checks authority, separates expiry semantics, and sends real email', () => {
    assert.match(inviteRoute, /requireSession\(req/);
    assert.match(inviteRoute, /canDelegateAccess/);
    assert.match(inviteRoute, /staxis_create_organization_invitation/);
    assert.match(inviteRoute, /p_expires_at: invitationExpiresAt/);
    assert.match(inviteRoute, /p_grant_expires_at: input\.grantExpiresAt/);
    assert.match(inviteRoute, /sendOrganizationAccessInvite/);
    assert.match(inviteRoute, /emailSent: emailResult\.ok/);
    assert.match(inviteRoute, /\/company-invite\//);
  });

  test('request creation resolves membership server-side and uses the transactional RPC', () => {
    assert.match(requestRoute, /activeMembershipsForActor/);
    assert.doesNotMatch(requestRoute, /body\.membershipId/);
    assert.match(requestRoute, /staxis_create_organization_access_request/);
  });

  test('review loads the request tuple, checks delegation, then uses the transactional review RPC', () => {
    assert.match(reviewRoute, /organization_access_requests/);
    assert.match(reviewRoute, /canDelegateAccess/);
    assert.match(reviewRoute, /staxis_review_organization_access_request/);
  });

  test('lifecycle routes accept opaque row ids and delegate exact authority to transactional RPCs', () => {
    for (const route of [revokeGrantRoute, cancelInvitationRoute, membershipStatusRoute]) {
      assert.match(route, /requireSession\(req/);
      assert.match(route, /loadOrganizationActor/);
      assert.match(route, /isCompanyAccessUnavailable\(error\)/);
      assert.match(route, /isCompanyAccessUnavailable\(caught\)[\s\S]*status: 503/);
      assert.doesNotMatch(route, /body\.organizationId|body\.propertyId|body\.portfolioId/);
    }
    assert.match(revokeGrantRoute, /staxis_revoke_organization_access/);
    assert.match(cancelInvitationRoute, /staxis_cancel_organization_invitation/);
    assert.match(membershipStatusRoute, /staxis_change_organization_membership_status/);
  });

  test('the read DTO exposes only exact server-authorized lifecycle actions', () => {
    assert.match(getRoute, /canRevoke:[\s\S]*canDelegateAccess/);
    assert.match(getRoute, /canSuspend: canManageMembership/);
    assert.match(getRoute, /canResume: canManageMembership/);
    assert.match(getRoute, /canRemove: canManageMembership/);
    assert.match(getRoute, /canCancel: true/);
    assert.match(page, /CompanyLifecycleDialog/);
    assert.match(page, /membership\.grants[\s\S]*grant\.canRevoke/);
  });
});

describe('organization invitation acceptance', () => {
  test('existing-account acceptance is authenticated and email-bound by the acceptance RPC', () => {
    assert.match(authAcceptRoute, /requireSession\(req/);
    assert.match(authAcceptRoute, /loadOrganizationActor/);
    assert.match(authAcceptRoute, /staxis_accept_organization_invitation/);
    assert.match(authAcceptRoute, /acceptedAccountId: actor\.accountId/);
    assert.match(authAcceptRoute, /existingData\.acceptedAccountId === actor\.accountId/);
    assert.match(authAcceptRoute, /existingData\?\.claimMode === ['"]authenticated_accept['"]/);
  });

  test('public registration claims atomically before auth side effects and creates least privilege', () => {
    const claim = registerRoute.indexOf("claim_idempotency_key");
    const create = registerRoute.indexOf('createOrReclaimAuthUser({');
    assert.ok(claim >= 0 && create > claim, 'atomic token-derived claim must precede auth creation');
    assert.match(registerRoute, /claimKey = `orginvite_\$\{tokenHash\}`/);
    assert.match(registerRoute, /role: ['"]staff['"]/);
    assert.match(registerRoute, /property_access: \[\]/);
    assert.match(registerRoute, /allowOrphanReclaim: false/);
    assert.match(registerRoute, /if \(authResult\.unlinkedIdentity\)[\s\S]*status: 503/);
    assert.match(registerRoute, /accountId = randomUUID\(\)[\s\S]*id: accountId/);
    assert.match(registerRoute, /deleteCreatedIdentity/);
    assert.match(registerRoute, /releasePendingClaim/);
    assert.match(registerRoute, /\.eq\(['"]status_code['"], 0\)[\s\S]*\.contains\(['"]response['"], \{ __pending__: true \}\)/);
    assert.match(registerRoute, /if \(!acceptError\.code\)[\s\S]*status: 503/);
    const rolloutClassification = registerRoute.indexOf('isCompanyAccessUnavailable(acceptError)');
    const terminalInvitationError = registerRoute.indexOf("Invitation is invalid, expired, or no longer authorized");
    assert.ok(
      rolloutClassification >= 0 && terminalInvitationError > rolloutClassification,
      'schema rollout errors must be classified before terminal invitation errors',
    );
    assert.match(registerRoute, /if \(deploymentUnavailable\)[\s\S]*status: 503[\s\S]*ApiErrorCode\.UpstreamFailure/);
    assert.match(registerRoute, /if \(!acceptanceStarted\)[\s\S]*releasePendingClaim/);
    assert.match(registerRoute, /recordIdempotency/);
    assert.match(registrationRollback, /if \(error\)[\s\S]*auth identity preserved[\s\S]*return preserved/);
    assert.match(registrationRollback, /catch \(caught\)[\s\S]*account rollback threw; auth identity preserved[\s\S]*return preserved/);
    const accountDelete = registrationRollback.indexOf("from('accounts').delete().eq('id', accountId)");
    const authDelete = registrationRollback.indexOf('auth.admin.deleteUser(authUserId)');
    assert.ok(accountDelete >= 0 && authDelete > accountDelete, 'account rollback must gate Auth rollback');
  });

  test('sign-in bypasses property selection only for Company targets', () => {
    assert.match(signIn, /requestedTarget === ['"]\/company['"]/);
    assert.match(signIn, /requestedTarget\.startsWith\(['"]\/company-invite\/['"]\)/);
    assert.match(signIn, /user && !isPropertyIndependentCompanyTarget/);
  });
});

describe('normalized-only operational-link safety', () => {
  test('hotel rows are informational and legacy settings require an actually active legacy hotel', () => {
    assert.match(page, /canOpenLegacyRoleSettings=\{Boolean\([\s\S]*activeProperty[\s\S]*resolved\.properties\.some/);
    assert.match(page, /data\.permissions\.manageAccess && canOpenLegacyRoleSettings/);
    const propertyRow = page.match(/function PropertyRow[\s\S]*?\n\}/)?.[0] ?? '';
    assert.doesNotMatch(propertyRow, /<Link|href=|router\.push/);
  });

  test('read-only and workflow dialogs restore focus to their opener', () => {
    assert.match(page, /const returnFocusElement = document\.activeElement instanceof HTMLElement/);
    assert.match(page, /returnFocusElement\.focus\(\{ preventScroll: true \}\)/);
    assert.match(dialog, /const returnFocusElement = document\.activeElement instanceof HTMLElement/);
    assert.match(dialog, /returnFocusElement\.focus\(\{ preventScroll: true \}\)/);
    assert.match(dialog, /if \(!busyRef\.current\) onCloseRef\.current\(\)/);
    assert.match(dialog, /!dialogRef\.current\.contains\(document\.activeElement\)/);
    assert.match(dialog, /\(event\.shiftKey \? last : first\)\.focus\(\)/);
    assert.match(dialog, /tabIndex=\{-1\}/);
  });
});
