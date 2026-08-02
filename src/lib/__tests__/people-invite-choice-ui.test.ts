import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const panel = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const dialogs = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const css = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

const actionAreaStart = panel.indexOf('{!needsFirstPerson && inviteEntryAvailable ? (');
const actionAreaEnd = panel.indexOf('<div className={styles.kpiStrip}>', actionAreaStart);
const actionArea = panel.slice(actionAreaStart, actionAreaEnd);

describe('People invite entry choice', () => {
  test('keeps one permission-gated entry action with the approved distinction copy', () => {
    assert.ok(actionAreaStart >= 0, 'People action area should remain in the hotel panel');
    assert.ok(actionAreaEnd > actionAreaStart, 'People action area should end before the KPI strip');
    assert.equal(
      (actionArea.match(/<button/g) ?? []).length,
      1,
      'the People action area must expose exactly one button',
    );
    assert.match(actionArea, /onClick=\{openPeopleInviteChooser\}/);
    assert.match(actionArea, /<strong>\{'Invite people'\}<\/strong>/);
    assert.match(
      actionArea,
      /Add someone to the schedule, or invite them to create a Staxis account\./,
    );
    assert.doesNotMatch(actionArea, /Add staff member|CalendarPlus|LogIn/);
    assert.match(panel, /const inviteEntryAvailable = canAddStaff \|\| canInviteToStaxis/);
    assert.match(panel, /const canInviteToStaxis = canManageTeam \|\| canInviteAccounts/);
  });

  test('asks about login access first and renders only allowed choices', () => {
    assert.match(dialogs, /export function PeopleInviteChooserDialog/);
    assert.match(dialogs, /description=\{'Does this person need a Staxis login\?'\}/);
    assert.match(dialogs, /role="group" aria-label="Choose whether this person needs a Staxis login"/);
    assert.match(dialogs, /canAddStaff \? \([\s\S]*?\{'Add staff member'\}/);
    assert.match(dialogs, /Add them to this hotel's roster and schedule\. No Staxis account\./);
    assert.match(dialogs, /canInviteToStaxis \? \([\s\S]*?\{'Invite to Staxis'\}/);
    assert.match(dialogs, /Send an email invite or share a link, QR code, or invite code\./);
    assert.match(panel, /canAddStaff=\{canAddStaff && !locked\}/);
    assert.match(panel, /canInviteToStaxis=\{canInviteToStaxis\}/);
    assert.match(panel, /canSendEmailInvite=\{canInviteAccounts\}/);
    assert.match(dialogs, /const inviteDescription = canSendEmailInvite[\s\S]*Share a link, QR code, or invite code\./);
  });

  test('hands off to the existing roster and Staxis-account flows', () => {
    assert.match(panel, /const chooseAddStaff = React\.useCallback/);
    assert.match(panel, /setAddDepartment\(['"]housekeeping['"]\)/);
    assert.match(panel, /const chooseInviteToStaxis = React\.useCallback/);
    assert.match(panel, /onInviteDialogOpenChange\(true\)/);
    assert.match(panel, /if \(inviteChoiceOpen\) \{[\s\S]*setInviteChoiceOpen\(false\)/);
    assert.match(panel, /<LazyAddStaffDialog[\s\S]*pendingAttempt=\{pendingAddAttempt\}/);
    assert.match(panel, /<LazyInviteDialog[\s\S]*canInviteManager=\{canInviteAccounts\}/);
    assert.match(panel, /canManageHotelRoster/);
    assert.match(panel, /unlinkedRosterProfiles=\{unlinkedRosterProfiles\}/);
  });

  test('keeps the chooser keyboard and mobile affordances aligned with dialog patterns', () => {
    assert.match(css, /\.peopleInviteChoice:focus-visible[\s\S]*outline: 2px solid var\(--team-sage\)/);
    assert.match(css, /\.peopleInviteChoice \{[\s\S]*min-height: 76px;/);
    assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.dialogLayer \{/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.peopleInviteChoice/);
  });
});
