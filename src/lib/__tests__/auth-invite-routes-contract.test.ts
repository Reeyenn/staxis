import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const inviteRoute = source('src/app/api/auth/invites/route.ts');
const acceptInviteRoute = source('src/app/api/auth/accept-invite/route.ts');
const hatRoute = source('src/app/api/auth/team/hats/route.ts');
const inviteAuthority = source('src/lib/company/account-invite-authority.ts');
const joinCodeRoute = source('src/app/api/auth/join-codes/route.ts');
const transactionalInviteMigration = source(
  'supabase/migrations/0393_transactional_invite_and_join_acceptance.sql',
);
const peopleLifecycleMigration = source(
  'supabase/migrations/0395_authoritative_people_lifecycle.sql',
);
const guardedJoinCodeMigration = source(
  'supabase/migrations/0398_privileged_onboarding_join_codes.sql',
);

describe('hotel account invitation route contract', () => {
  test('preserves MFA, capability, hotel scope, and role gates', () => {
    assert.match(inviteRoute, /requireSession\(req, \{ requestId \}\)/);
    assert.match(inviteRoute, /loadOrganizationActor\(session\.userId, session\.email\)/);
    assert.match(inviteRoute, /loadFreshCompanyInviteAuthorityContext\(/);
    assert.match(inviteRoute, /resolveLocalHotelInviteAuthority\(/);
    assert.match(inviteRoute, /companyContext\.kind === 'unavailable'[\s\S]*capabilityUnavailableResponse/);
    assert.match(inviteRoute, /isAssignableRole\(role\)/);
    assert.doesNotMatch(inviteRoute, /verifyTeamManager|callerCapabilityDecision/);
    assert.match(inviteAuthority, /capabilityDecisionForProperty/);
    assert.match(inviteAuthority, /capabilityDecisionForPropertyFresh/);
    assert.match(inviteAuthority, /freshCapability[\s\S]*'manage_team'/);
    assert.match(inviteRoute, /freshCapability: true/);
    assert.match(inviteAuthority, /!standing\.hotelMutationAllowed/);
  });

  test('sends through the real email path and returns a truthful fallback', () => {
    assert.match(inviteRoute, /sendHotelAccountInvite\(/);
    assert.match(inviteRoute, /accountInviteDelivery\(inviteLink, emailResult\)/);
    assert.match(inviteRoute, /NEXT_PUBLIC_APP_URL/);
    assert.doesNotMatch(inviteRoute, /auth\.admin\.generateLink/);
  });

  test('persists and audits through an actor-bound guarded create before email', () => {
    const guardedCreate = inviteRoute.indexOf("'staxis_create_account_invite_guarded'");
    const send = inviteRoute.indexOf('sendHotelAccountInvite(', guardedCreate);
    assert.ok(guardedCreate >= 0 && send > guardedCreate);
    assert.doesNotMatch(inviteRoute, /\.from\('account_invites'\)\.insert/);
    assert.match(
      peopleLifecycleMigration,
      /create or replace function public\.staxis_create_account_invite_guarded[\s\S]*for share nowait[\s\S]*_staxis_can_control_account_invite[\s\S]*insert into public\.account_invites[\s\S]*'invite\.create'/i,
    );
    assert.match(
      inviteRoute,
      /const inviteAnchorHotelId = targetStaffId\s*\? hotelId\s*:\s*hat\?\.scope === 'property'[\s\S]*p_hotel_id: inviteAnchorHotelId/,
    );
    assert.match(inviteAuthority, /!coveredPropertyIds\.includes\(invite\.hotelId\)/);
    assert.match(peopleLifecycleMigration, /p_hotel_id = any\(p_covered_property_ids\)/);
    assert.match(transactionalInviteMigration, /account_invites_property_anchor_check[\s\S]*hotel_id = any\(covered_property_ids\)/);
    assert.match(transactionalInviteMigration, /v_invite\.hotel_id = any\(v_coverage\)/);
  });

  test('keeps expired unaccepted invitations visible and explicitly labeled', () => {
    assert.match(inviteRoute, /\.is\('accepted_at', null\)/);
    assert.match(
      inviteRoute,
      /readCompleteCompanyPages<StoredInviteRow>[\s\S]*count: 'exact'[\s\S]*\.range\(from, to\)[\s\S]*maxRows: MAX_VISIBLE_PENDING_INVITES/,
    );
    assert.match(inviteRoute, /const status = accountInviteStatus/);
    assert.match(inviteRoute, /isExpired: status === 'expired'/);
  });

  test('projects exact selected-hotel scope and separates visibility from revoke authority', () => {
    assert.match(inviteRoute, /\.eq\('organization_id', companyContext\.value\.organizationId\)/);
    assert.match(inviteRoute, /\.eq\('hotel_id', hotelId\)[\s\S]*\.is\('organization_id', null\)/);
    assert.match(inviteRoute, /projectStoredInviteForCompanyContext\([\s\S]*hotelId/);
    assert.match(inviteRoute, /propertyNames: propertyIds\.map/);
    assert.match(inviteRoute, /canRevoke/);
    assert.doesNotMatch(inviteRoute, /coverageRedacted|hiddenPropertyCount/);
    assert.match(inviteAuthority, /const propertyIds = targetPropertyIds\.filter\(canViewAt\)\.sort\(\)/);
    assert.match(inviteAuthority, /canRevoke: fullAuthority\.kind === 'allowed'/);
  });

  test('returns per-role hotel choices and server-derived local options', () => {
    assert.match(inviteRoute, /allowedPropertyIds/);
    assert.match(inviteRoute, /jobs\.flatMap\(\(job\) => job\.allowedPropertyIds\)/);
    assert.match(inviteRoute, /ASSIGNABLE_ROLES[\s\S]*canGrantHotelRole\(roleAtHotel, role\)/);
  });

  test('revoke is one actor-bound database mutation with anti-enumerating refusal', () => {
    const revoke = inviteRoute.indexOf('export async function DELETE');
    const rpc = inviteRoute.indexOf("'staxis_revoke_account_invite_guarded'", revoke);
    assert.ok(revoke >= 0 && rpc > revoke);
    assert.doesNotMatch(inviteRoute.slice(revoke), /\.from\('account_invites'\)/);
    assert.match(inviteRoute.slice(rpc), /reason === 'not_pending'[\s\S]*Not found/);
    assert.match(
      peopleLifecycleMigration,
      /create or replace function public\.staxis_revoke_account_invite_guarded[\s\S]*for update[\s\S]*for share nowait[\s\S]*_staxis_can_control_account_invite[\s\S]*accepted_at is not null[\s\S]*delete from public\.account_invites[\s\S]*'invite\.revoke'/i,
    );
  });

  test('acceptance uses fresh standing, exact reservation, and transactional finalization', () => {
    assert.match(inviteAuthority, /listAuthoritativePropertyAccess\(accountId\)/);
    assert.match(inviteAuthority, /authoritativeStandingForProperty\(authority, hotelId\)/);
    assert.match(inviteAuthority, /loadActiveAccountInviteActor\(input\.accountId\)/);
    assert.doesNotMatch(acceptInviteRoute, /\.select\([^\n]*property_access/);

    const authorityStart = acceptInviteRoute.indexOf('const invitedScope');
    const firstNormalized = acceptInviteRoute.indexOf(
      'await resolveStoredNormalizedInviteAuthority(',
      authorityStart,
    );
    const commitNormalized = acceptInviteRoute.indexOf(
      'await resolveStoredNormalizedInviteAuthority(',
      firstNormalized + 1,
    );
    const firstLocal = acceptInviteRoute.indexOf(
      'await resolveLocalHotelInviteAuthority(',
      authorityStart,
    );
    const commitLocal = acceptInviteRoute.indexOf(
      'await resolveLocalHotelInviteAuthority(',
      firstLocal + 1,
    );
    const claim = acceptInviteRoute.indexOf(
      "'staxis_claim_account_invite_acceptance'",
      Math.max(commitNormalized, commitLocal),
    );
    const authCreate = acceptInviteRoute.indexOf('createOrReclaimAuthUser({', claim);
    const finalize = acceptInviteRoute.indexOf("'staxis_accept_account_invite'", authCreate);
    const recovery = acceptInviteRoute.indexOf('recoverAcceptanceCommit(', finalize);
    const rollback = acceptInviteRoute.indexOf('await rollbackAuthUser()', recovery);
    assert.ok(firstNormalized >= 0 && commitNormalized > firstNormalized);
    assert.ok(firstLocal >= 0 && commitLocal > firstLocal && claim > commitLocal);
    assert.ok(authCreate > claim && finalize > authCreate && recovery > finalize && rollback > recovery);
    assert.match(
      acceptInviteRoute.slice(commitLocal, claim),
      /canGrantHotelRole\(commitAuthority\.value\.roleAtHotel, invite\.role\)/,
    );
    assert.match(acceptInviteRoute.slice(commitNormalized, claim), /sameNormalizedAuthority\(/);
    assert.match(acceptInviteRoute, /staxis_release_account_invite_acceptance/);
    assert.match(
      transactionalInviteMigration,
      /_staxis_lock_organization[\s\S]*lock table public\.capability_overrides in share mode nowait[\s\S]*from public\.accounts inviter[\s\S]*for share nowait/i,
    );
    assert.match(
      acceptInviteRoute.slice(recovery, rollback),
      /recovery === 'committed'[\s\S]*return ok/,
    );
    assert.doesNotMatch(acceptInviteRoute, /property_access:/);
  });
});

describe('company People hat route contract', () => {
  test('intersects direct-id reads and reasserts the full receipt before egress', () => {
    assert.match(hatRoute, /if \(callerReach !== null && named\.length === 0\) return \[\]/);
    assert.doesNotMatch(hatRoute, /coverageRedacted/);
    assert.doesNotMatch(hatRoute, /otherHotelCount: hidden/);
    const assemble = hatRoute.indexOf('const disclosedHats');
    const reassert = hatRoute.indexOf('const finalContext', assemble);
    const response = hatRoute.indexOf('return ok({', reassert);
    assert.ok(assemble >= 0 && reassert > assemble && response > reassert);
    assert.match(
      hatRoute.slice(reassert, response),
      /companyInviteAuthorityUnchanged[\s\S]*resolveAuthoritativeInviteScope/,
    );
  });

  test('uses actor-bound transactional hat writers and no best-effort route audit', () => {
    assert.match(hatRoute, /'staxis_set_membership_hat_guarded'/);
    assert.match(hatRoute, /'staxis_end_membership_hat_guarded'/);
    assert.doesNotMatch(hatRoute, /writeAudit/);
    assert.match(
      peopleLifecycleMigration,
      /staxis_set_membership_hat_guarded[\s\S]*staxis\.actor_account_id[\s\S]*staxis\.request_id[\s\S]*staxis_set_membership_hat\(/i,
    );
    assert.match(
      peopleLifecycleMigration,
      /staxis_end_membership_hat_guarded[\s\S]*staxis\.actor_account_id[\s\S]*staxis\.request_id[\s\S]*staxis_end_membership_hat\(/i,
    );
  });
});

describe('join-code get-or-create route contract', () => {
  test('preserves MFA, capability, and hotel scope gates', () => {
    assert.match(joinCodeRoute, /verifyTeamManager\(req, \{ capability: 'manage_team' \}\)/);
    assert.match(joinCodeRoute, /callerCapabilityDecision\(caller, 'manage_team', hotelId\)/);
    assert.match(joinCodeRoute, /capabilityDecision === 'unavailable'[\s\S]*capabilityUnavailableResponse/);
    assert.match(joinCodeRoute, /capabilityDecision === 'denied'/);
  });

  test('returns the bearer code only from a fresh actor-bound database read', () => {
    assert.match(joinCodeRoute, /'staxis_read_staff_join_code_guarded'/);
    assert.doesNotMatch(joinCodeRoute, /from\(['"]hotel_join_codes['"]\)/);
    assert.match(joinCodeRoute, /parseReadReceipt\(data, hotelId\)/);
    assert.match(joinCodeRoute, /hasExactKeys/);
    assert.match(
      guardedJoinCodeMigration,
      /staxis_read_staff_join_code_guarded[\s\S]*_staxis_staff_join_code_authority_context[\s\S]*for share/i,
    );
  });

  test('commits ordinary create/reconcile/revoke and audit under live authority locks', () => {
    assert.match(joinCodeRoute, /'staxis_get_or_create_staff_join_code_guarded'/);
    assert.match(joinCodeRoute, /'staxis_revoke_staff_join_code_guarded'/);
    assert.doesNotMatch(joinCodeRoute, /writeAudit|withJoinCodeHotelLock/);
    assert.match(
      guardedJoinCodeMigration,
      /_staxis_staff_join_code_authority_context[\s\S]*pg_advisory_xact_lock[\s\S]*lock table public\.capability_overrides[\s\S]*_staxis_manage_team_context/i,
    );
    assert.match(
      guardedJoinCodeMigration,
      /staxis_get_or_create_staff_join_code_guarded[\s\S]*for update[\s\S]*insert into public\.hotel_join_codes[\s\S]*join_code\.create/i,
    );
    assert.match(
      guardedJoinCodeMigration,
      /staxis_revoke_staff_join_code_guarded[\s\S]*for update[\s\S]*update public\.hotel_join_codes[\s\S]*join_code\.revoke/i,
    );
    assert.match(guardedJoinCodeMigration, /code_kind = 'staff_signup'/);
    assert.match(guardedJoinCodeMigration, /hotelMutationAllowed=true/);
  });

  test('fails closed across rolling deploys and never falls back to direct service writes', () => {
    assert.match(joinCodeRoute, /PGRST202/);
    assert.match(joinCodeRoute, /42883/);
    assert.match(joinCodeRoute, /capabilityUnavailableResponse\(requestId\)/);
    assert.doesNotMatch(joinCodeRoute, /\.from\(['"]hotel_join_codes['"]\)/);
    for (const fn of [
      'staxis_read_staff_join_code_guarded',
      'staxis_get_or_create_staff_join_code_guarded',
      'staxis_revoke_staff_join_code_guarded',
    ]) {
      assert.match(
        guardedJoinCodeMigration,
        new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?\\) to service_role`),
      );
    }
  });
});
