import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const inviteRoute = source('src/app/api/auth/invites/route.ts');
const joinCodeRoute = source('src/app/api/auth/join-codes/route.ts');

describe('hotel account invitation route contract', () => {
  test('preserves MFA, capability, hotel scope, and role gates', () => {
    assert.match(inviteRoute, /verifyTeamManager\(req, \{ capability: 'manage_team' \}\)/);
    assert.match(inviteRoute, /callerCapabilityDecision\(caller, 'manage_team', hotelId\)/);
    assert.match(inviteRoute, /capabilityDecision === 'unavailable'[\s\S]*capabilityUnavailableResponse/);
    assert.match(inviteRoute, /capabilityDecision === 'denied'/);
    assert.match(inviteRoute, /isAssignableRole\(role\)/);
  });

  test('sends through the real email path and returns a truthful fallback', () => {
    assert.match(inviteRoute, /sendHotelAccountInvite\(/);
    assert.match(inviteRoute, /accountInviteDelivery\(inviteLink, emailResult\)/);
    assert.match(inviteRoute, /NEXT_PUBLIC_APP_URL/);
    assert.doesNotMatch(inviteRoute, /auth\.admin\.generateLink/);
  });

  test('keeps expired unaccepted invitations visible and explicitly labeled', () => {
    assert.match(inviteRoute, /\.is\('accepted_at', null\)/);
    assert.match(inviteRoute, /const status = accountInviteStatus/);
    assert.match(inviteRoute, /isExpired: status === 'expired'/);
  });

  test('revoke resolves hotel scope before deletion and records the action', () => {
    const deletion = inviteRoute.indexOf("from('account_invites')\n    .delete()");
    const scopeCheck = inviteRoute.lastIndexOf(
      "callerCapabilityDecision(caller, 'manage_team', row.hotel_id)",
      deletion,
    );
    const unavailable = inviteRoute.indexOf("capabilityDecision === 'unavailable'", scopeCheck);
    const denied = inviteRoute.indexOf("capabilityDecision === 'denied'", unavailable);
    assert.ok(
      scopeCheck >= 0 && unavailable > scopeCheck && denied > unavailable && deletion > denied,
      'retryable outage and hotel denial must both precede deletion',
    );
    assert.match(inviteRoute, /\.is\('accepted_at', null\)[\s\S]*Invite is no longer pending/);
    assert.match(inviteRoute, /action: 'invite\.revoke'/);
  });
});

describe('join-code get-or-create route contract', () => {
  test('preserves MFA, capability, and hotel scope gates', () => {
    assert.match(joinCodeRoute, /verifyTeamManager\(req, \{ capability: 'manage_team' \}\)/);
    assert.match(joinCodeRoute, /callerCapabilityDecision\(caller, 'manage_team', hotelId\)/);
    assert.match(joinCodeRoute, /capabilityDecision === 'unavailable'[\s\S]*capabilityUnavailableResponse/);
    assert.match(joinCodeRoute, /capabilityDecision === 'denied'/);
  });

  test('reuses a usable code before inserting and serializes same-hotel requests', () => {
    assert.match(joinCodeRoute, /withJoinCodeHotelLock\(hotelId/);
    const lookup = joinCodeRoute.indexOf('const existingResult = await usableCodesForHotel(hotelId)');
    const insert = joinCodeRoute.indexOf("from('hotel_join_codes').insert(");
    assert.ok(lookup >= 0 && insert > lookup, 'usable-code lookup must precede insertion');
    assert.match(joinCodeRoute, /joinCode: reconciliation\.canonical, created: false/);
  });

  test('reconciles cross-instance race losers to one deterministic code', () => {
    assert.match(joinCodeRoute, /const canonicalResult = await usableCodesForHotel\(hotelId\)/);
    assert.match(joinCodeRoute, /reconcileUsableCodesForHotel\(hotelId, canonicalResult\.codes\)/);
    assert.match(joinCodeRoute, /verification\.codes\.length !== 1/);
    assert.match(joinCodeRoute, /canonical\.id !== inserted\.id/);
    assert.match(joinCodeRoute, /update\(\{ revoked_at:/);
    assert.match(joinCodeRoute, /join_code\.concurrent_duplicate_revoke/);
    assert.match(joinCodeRoute, /duplicate reconciliation failed[\s\S]*return err\(/);
    assert.match(joinCodeRoute, /post-insert reconciliation lookup failed[\s\S]*return err\(/);
    assert.match(joinCodeRoute, /codes: codes\.slice\(0, 1\)/);
  });
});
