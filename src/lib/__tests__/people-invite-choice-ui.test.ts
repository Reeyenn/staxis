import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function section(sourceText: string, startMarker: string, endMarker: string, label: string): string {
  const start = sourceText.indexOf(startMarker);
  const end = sourceText.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `${label} should have a start marker`);
  assert.ok(end > start, `${label} should have an end marker`);
  return sourceText.slice(start, end);
}

const panel = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const dialogs = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const addStaff = source('src', 'app', 'company', '_components', 'AddStaffDialog.tsx');
const companyPage = source('src', 'app', 'company', 'page.tsx');
const css = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

const normalActionArea = section(
  panel,
  '{!needsFirstPerson && !locked && inviteEntryAvailable ? (',
  '<div className={styles.kpiStrip}>',
  'authorized People action area',
);
const earlyBranch = section(
  panel,
  'if (!canManageTeam) {',
  'const editAccount =',
  'invite-only HotelTeamPanel branch',
);
const earlyActionArea = section(
  earlyBranch,
  '{canInviteAccounts && !locked ? (',
  '</section>',
  'invite-only People action area',
);
const normalActionEnd = panel.indexOf('<div className={styles.kpiStrip}>', panel.indexOf('{!needsFirstPerson && !locked && inviteEntryAvailable ? ('));
const normalDialogStart = panel.indexOf('<React.Suspense fallback={(', normalActionEnd);
const normalDialogEnd = panel.indexOf('</React.Suspense>', normalDialogStart);
assert.ok(normalDialogStart > normalActionEnd, 'authorized dialog handoffs should follow the People action area');
assert.ok(normalDialogEnd > normalDialogStart, 'authorized dialog handoffs should close');
const normalDialogArea = panel.slice(normalDialogStart, normalDialogEnd);
const loadingComponent = section(
  panel,
  'type DialogLoadingVariant =',
  'function DialogLoadingSection',
  'dialog loading component',
);
const loadingBodyStart = loadingComponent.indexOf("{variant === 'invite' ? (");
const loadingBodyEnd = loadingComponent.indexOf('        </div>', loadingBodyStart);
assert.ok(loadingBodyStart >= 0 && loadingBodyEnd > loadingBodyStart, 'dialog loading body should be present');
const loadingBody = loadingComponent.slice(loadingBodyStart, loadingBodyEnd);
const chooser = section(
  dialogs,
  'export function PeopleInviteChooserDialog',
  'export function HotelInviteDialog',
  'invite chooser component',
);
const pagePeoplePanel = section(
  companyPage,
  'function PeoplePanel(',
  'function AccessPanel(',
  'People page panel',
);

describe('People invite entry choice', () => {
  test('authorized hotel managers get exactly one entry with the approved distinction copy', () => {
    assert.equal((normalActionArea.match(/<button/g) ?? []).length, 1);
    assert.match(normalActionArea, /ref=\{inviteEntryRef\}/);
    assert.match(normalActionArea, /onClick=\{openPeopleInviteChooser\}/);
    assert.match(normalActionArea, /<strong>\{'Invite people'\}<\/strong>/);
    assert.match(
      normalActionArea,
      /Add someone to the schedule, or invite them to create a Staxis account\./,
    );
    assert.doesNotMatch(normalActionArea, /Add staff member|CalendarPlus|LogIn/);
    assert.match(panel, /const inviteEntryAvailable = canAddStaff \|\| canInviteToStaxis/);
    assert.match(panel, /const canInviteToStaxis = canManageTeam \|\| canInviteAccounts/);
  });

  test('account-invite-only authority gets one unified entry and no roster path', () => {
    assert.equal((earlyActionArea.match(/<button/g) ?? []).length, 1);
    assert.match(earlyActionArea, /ref=\{inviteEntryRef\}/);
    assert.match(earlyActionArea, /<strong>\{'Invite people'\}<\/strong>/);
    assert.doesNotMatch(earlyActionArea, /Add staff member|CalendarPlus|staffProfiles|rosterStaff/);

    assert.match(earlyBranch, /inviteChoiceOpen && canInviteAccounts && !locked/);
    assert.match(earlyBranch, /canAddStaff=\{false\}/);
    assert.match(earlyBranch, /canInviteToStaxis\s+canSendEmailInvite\s+canShareHotelInvite=\{false\}/);
    assert.match(earlyBranch, /inviteDialogOpen && canInviteAccounts && !locked/);
    assert.match(earlyBranch, /canInviteManager\s+canManageHotelRoster=\{false\}/);
    assert.match(earlyBranch, /returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.doesNotMatch(earlyBranch, /<LazyAddStaffDialog/);
  });

  test('the old page-level account invite is suppressed when a hotel entry exists', () => {
    assert.match(
      pagePeoplePanel,
      /!adminPreview && !activeProperty && !canManageTeam && canInviteAccounts[\s\S]*Invite company member/,
    );
    assert.match(
      pagePeoplePanel,
      /<HotelTeamPanel[\s\S]*canInviteAccounts=\{canInviteAccounts\}/,
    );
  });

  test('the chooser exposes only the permissions passed to it', () => {
    assert.match(chooser, /description=\{'Does this person need a Staxis login\?'\}/);
    assert.match(chooser, /role="group" aria-label="Choose whether this person needs a Staxis login"/);
    assert.match(chooser, /canAddStaff \? \([\s\S]*?\{'Add staff member'\}/);
    assert.match(chooser, /Add them to this hotel's roster and schedule\. No Staxis account\./);
    assert.match(chooser, /canInviteToStaxis \? \([\s\S]*?\{'Invite to Staxis'\}/);
    assert.match(chooser, /const inviteDescription = canShareHotelInvite[\s\S]*canSendEmailInvite[\s\S]*Share a link, QR code, or invite code\./);
    assert.match(normalDialogArea, /canAddStaff=\{canAddStaff && !locked\}/);
    assert.match(normalDialogArea, /canInviteToStaxis=\{canInviteToStaxis\}/);
    assert.match(normalDialogArea, /canSendEmailInvite=\{canInviteAccounts\}/);
    assert.match(normalDialogArea, /canShareHotelInvite=\{canManageTeam\}/);
    assert.match(chooser, /canShareHotelInvite ?/);
  });

  test('preserves the shared-link-only manager path and the email-only account path', () => {
    assert.match(normalDialogArea, /canInviteManager=\{canInviteAccounts\}/);
    assert.match(normalDialogArea, /canManageHotelRoster/);
    assert.match(normalDialogArea, /unlinkedRosterProfiles=\{unlinkedRosterProfiles\}/);
    assert.match(earlyBranch, /canInviteManager\s+canManageHotelRoster=\{false\}/);
    assert.match(chooser, /Share a link, QR code, or invite code\./);
    assert.match(chooser, /: 'Send an email invite\.'/);
    assert.match(dialogs, /QRCode\.toDataURL\(signupLinkFor\(code\.code\)/);
    assert.match(dialogs, /\{'Link'\}/);
    assert.match(dialogs, /\{'QR code'\}/);
    assert.match(dialogs, /\{'Signup code'\}/);
    assert.match(dialogs, /canInviteManager && inviteMode === 'email'/);
  });

  test('permission and read-only gates keep the entry closed', () => {
    assert.match(panel, /const inviteEntryAvailable = canAddStaff \|\| canInviteToStaxis/);
    assert.match(panel, /if \(inviteActionDisabled \|\| !inviteEntryAvailable\) return;/);
    assert.match(normalActionArea, /\{!needsFirstPerson && !locked && inviteEntryAvailable \?/);
    assert.match(normalActionArea, /disabled=\{inviteActionDisabled\}/);
    assert.match(earlyBranch, /\{canInviteAccounts && !locked \?/);
    assert.match(panel, /if \(!canAddStaff \|\| locked\) return;/);
    assert.match(panel, /if \(!canInviteToStaxis \|\| inviteActionDisabled\) return;/);
  });

  test('both handoffs retain the original visible trigger through lazy loading and close', () => {
    assert.match(panel, /const inviteEntryRef = React\.useRef<HTMLButtonElement \| null>\(null\)/);
    assert.match(panel, /const inviteEntryReturnFocusRef = React\.useRef<HTMLElement \| null>\(null\)/);
    assert.match(panel, /inviteEntryReturnFocusRef\.current = inviteEntryRef\.current/);
    assert.match(normalDialogArea, /returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(normalDialogArea, /<LazyAddStaffDialog[\s\S]*returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(normalDialogArea, /<LazyInviteDialog[\s\S]*returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(normalDialogArea, /<DialogLoading[\s\S]*returnFocusRef=\{needsFirstPerson \? undefined : inviteEntryReturnFocusRef\}/);
    assert.match(earlyBranch, /<DialogLoading[\s\S]*returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(dialogs, /returnFocusRef\?\.current[\s\S]*document\.activeElement/);
    assert.match(dialogs, /if \(returnFocusElement\?\.isConnected\) returnFocusElement\.focus/);
    assert.match(addStaff, /returnFocusRef\?\.current[\s\S]*document\.activeElement/);
    assert.match(addStaff, /if \(returnFocusElement\?\.isConnected\) returnFocusElement\.focus/);
  });

  test('loading states match their destination and close the correct state', () => {
    assert.match(loadingComponent, /'invite' \| 'invite-choice' \| 'add-staff' \| 'member'/);
    assert.match(loadingComponent, /variant === 'invite-choice'[\s\S]*\? 'Invite people'/);
    assert.match(loadingComponent, /variant === 'add-staff'[\s\S]*\? 'Add staff member'/);
    assert.match(loadingComponent, /variant === 'invite-choice'[\s\S]*<DialogLoadingChoices count=\{choiceCount\}/);
    assert.match(loadingComponent, /variant === 'add-staff'[\s\S]*<DialogLoadingFields rows=\{4\}/);
    assert.match(loadingComponent, /styles\.dialogLoadingInviteChoice/);
    assert.match(loadingComponent, /styles\.dialogLoadingAddStaff/);
    assert.match(panel, /inviteChoiceOpen[\s\S]*'invite-choice'[\s\S]*addDepartment[\s\S]*'add-staff'[\s\S]*'decision'/);
    assert.match(panel, /if \(addDepartment\) \{[\s\S]*setAddDepartment\(null\)/);
    assert.match(earlyBranch, /variant=\{loadingDialogVariant\}[\s\S]*onClose=\{closeLoadingDialog\}/);
    assert.match(
      loadingBody,
      /variant === 'invite-choice'[\s\S]*DialogLoadingChoices count=\{choiceCount\}[\s\S]*variant === 'add-staff'[\s\S]*DialogLoadingFields rows=\{4\}/,
    );
    const choiceAndAddBranches = loadingBody.slice(
      loadingBody.indexOf("variant === 'invite-choice'"),
      loadingBody.indexOf("variant === 'member'"),
    );
    assert.doesNotMatch(choiceAndAddBranches, /DialogLoadingFields rows=\{2\} compact/);
  });

  test('chooser focus, keyboard targets, and mobile loading shapes remain accessible', () => {
    assert.match(css, /\.peopleInviteChoice:focus-visible[\s\S]*outline: 2px solid var\(--team-sage\)/);
    assert.match(css, /\.peopleInviteChoice \{[\s\S]*min-height: 76px;/);
    assert.match(css, /\.dialogLoadingInviteChoice\s*\{[\s\S]*height:/);
    assert.match(css, /\.dialogLoadingAddStaff\s*\{[\s\S]*height:/);
    assert.match(css, /\.dialogLoadingChoices\s*\{[\s\S]*gap: 12px/);
    assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.dialogLayer \{/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.peopleInviteChoice/);
  });
});
