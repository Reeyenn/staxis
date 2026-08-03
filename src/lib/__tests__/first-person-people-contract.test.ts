import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

const companyPage = read('src', 'app', 'company', 'page.tsx');
const hotelTeam = read('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const dialogs = read('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const setupCopy = read('src', 'app', 'company', '_components', 'hotel-team-setup.ts');
const route = read(
  'src', 'app', 'api', 'admin', 'properties', 'invite-first-person', 'route.ts',
);
const firstPersonDialog = dialogs.slice(
  dialogs.indexOf('export function FirstPersonInviteDialog'),
  dialogs.indexOf('export function HotelInviteDialog'),
);

describe('hotel-scoped first-person People flow', () => {
  test('resolves the exact hotel from the Admin Hotels People deep link', () => {
    assert.match(companyPage, /searchParams\.get\(['"]pid['"]\)/);
    assert.match(companyPage, /property\.id === requestedAdminHotelId/);
    assert.match(companyPage, /setActivePropertyId\(requestedAdminHotelId\)/);
    assert.match(companyPage, /requestedAdminHotelId === activePropertyId/);
    assert.match(companyPage, /const adminTargetIsCurrent = adminLinkTargetIsCurrent/);
    assert.match(companyPage, /<HotelTeamPanel[\s\S]*hotelId=\{activeProperty\.id\}/);
  });

  test('ignores organization-inherited reach when deciding whether a direct first person exists', () => {
    assert.match(hotelTeam, /managementSurface: ['"]legacy_hotel['"] \| ['"]company_access['"]/);
    assert.match(hotelTeam, /directHotelAccount\?: boolean \| null/);
    assert.match(hotelTeam, /deriveHotelTeamSetupState\(/);
    assert.doesNotMatch(hotelTeam, /managementSurface === ['"]legacy_hotel['"]/);
    assert.match(hotelTeam, /const setupMode = setupState\.setupMode/);
    assert.match(setupCopy, /['"]Add first person['"]/);
    assert.match(setupCopy, /['"]Add hotel owner or GM['"]/);
    assert.match(hotelTeam, /['"]Invite people['"]/);
    assert.match(hotelTeam, /firstPersonDialogVisible[\s\S]*LazyFirstPersonInviteDialog/);
    assert.match(hotelTeam, /: inviteDialogVisible \? \([\s\S]*<LazyInviteDialog/);
  });

  test('requires the inviter to assign Owner or General Manager', () => {
    assert.match(dialogs, /<option value="owner">\{'Owner'\}<\/option>/);
    assert.match(dialogs, /<option value="general_manager">\{'General Manager'\}<\/option>/);
    assert.match(dialogs, /body: JSON\.stringify\(\{ hotelId, email: normalizedEmail, role \}\)/);
    assert.match(setupCopy, /The invitee cannot change it during signup/);
    assert.doesNotMatch(firstPersonDialog, /front_desk|housekeeping|maintenance/);
  });

  test('uses the existing guarded onboarding invitation and never creates the hotel', () => {
    assert.match(route, /requireAdmin\(req\)/);
    assert.match(route, /staxis_mint_first_person_onboarding_invite/);
    assert.match(route, /body\.role === ['"]owner['"] \|\| body\.role === ['"]general_manager['"]/);
    assert.match(route, /sendOnboardingInvite/);
    assert.match(route, /\/onboard\?code=/);
    assert.doesNotMatch(route, /\.from\(['"]properties['"]\)[\s\S]*?\.insert\(/);
    assert.doesNotMatch(route, /\.from\(['"]accounts['"]\)[\s\S]*?\.insert\(/);
  });
});
