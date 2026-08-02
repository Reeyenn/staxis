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
const focusUtility = source('src', 'app', 'company', '_components', 'dialog-focus.ts');
const companyPage = source('src', 'app', 'company', 'page.tsx');
const css = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

const normalActionArea = section(
  panel,
  '{!needsFirstPerson && !locked && inviteEntryAvailable ? (',
  '<div className={styles.rosterList}',
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
const normalActionEnd = panel.indexOf('<div className={styles.rosterList}', panel.indexOf('{!needsFirstPerson && !locked && inviteEntryAvailable ? ('));
const normalDialogStart = panel.indexOf('<React.Suspense fallback={(', normalActionEnd);
const normalDialogEnd = panel.indexOf('</React.Suspense>', normalDialogStart);
assert.ok(normalDialogStart > normalActionEnd, 'authorized dialog handoffs should follow the People action area');
assert.ok(normalDialogEnd > normalDialogStart, 'authorized dialog handoffs should close');
const normalDialogArea = panel.slice(normalDialogStart, normalDialogEnd);
const normalLoadingFallback = section(
  normalDialogArea,
  '<DialogLoading',
  'onClose={closeLoadingDialog}',
  'normal dialog loading fallback',
);
const loadingFocusSelection = section(
  panel,
  'const loadingReturnFocusRef =',
  'if (!hotelId) {',
  'dialog loading focus selection',
);
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
    assert.equal((normalActionArea.match(/<strong>\{'Invite people'\}<\/strong>/g) ?? []).length, 1);
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
    assert.match(earlyActionArea, /Send an email invite so they can create a Staxis account\./);
    assert.doesNotMatch(earlyActionArea, /Add someone to the schedule/);
    assert.doesNotMatch(earlyActionArea, /Add staff member|CalendarPlus|staffProfiles|rosterStaff/);

    assert.match(earlyBranch, /inviteChoiceOpen && canInviteAccounts && !locked && !inviteActionDisabled/);
    assert.match(earlyBranch, /canAddStaff=\{false\}/);
    assert.match(earlyBranch, /canInviteToStaxis=\{!inviteActionDisabled\}/);
    assert.match(earlyBranch, /canSendEmailInvite=\{canInviteAccounts && !inviteActionDisabled\}/);
    assert.match(earlyBranch, /canShareHotelInvite=\{false\}/);
    assert.match(earlyBranch, /inviteDialogOpen && canInviteAccounts && !locked && !inviteActionDisabled/);
    assert.match(earlyBranch, /canInviteManager\s+canManageHotelRoster=\{false\}/);
    assert.match(earlyBranch, /returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(earlyBranch, /fallbackFocusRef=\{peopleHeadingRef\}/);
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
    assert.match(chooser, /description=\{'What does this person need\?'\}/);
    assert.match(chooser, /role="group" aria-label="Choose what this person needs"/);
    assert.match(chooser, /peopleInviteChoiceBadgeNoLogin[\s\S]*?\{'NO LOGIN'\}/);
    assert.match(chooser, /canAddStaff \? \([\s\S]*?\{'Add to schedule only'\}/);
    assert.match(chooser, /Add them to the hotel roster and schedule\. They cannot sign in to Staxis\./);
    assert.match(chooser, /peopleInviteChoiceBadge[\s\S]*?\{'STAXIS LOGIN'\}/);
    assert.match(chooser, /canInviteToStaxis \? \([\s\S]*?\{'Invite to create an account'\}/);
    assert.match(chooser, /They create a login and can sign in to Staxis\./);
    assert.match(chooser, /const inviteDescription = 'They create a login and can sign in to Staxis\.'/);
    assert.match(normalDialogArea, /canAddStaff=\{canAddStaff && !locked && !inviteActionDisabled\}/);
    assert.match(normalDialogArea, /canInviteToStaxis=\{canInviteToStaxis && !inviteActionDisabled\}/);
    assert.match(normalDialogArea, /canSendEmailInvite=\{canInviteAccounts && !inviteActionDisabled\}/);
    assert.match(normalDialogArea, /canShareHotelInvite=\{canManageTeam && !inviteActionDisabled\}/);
    assert.match(chooser, /canShareHotelInvite ?/);
  });

  test('preserves the shared-link-only manager path and the email-only account path', () => {
    assert.match(normalDialogArea, /canInviteManager=\{canInviteAccounts\}/);
    assert.match(normalDialogArea, /canManageHotelRoster/);
    assert.match(normalDialogArea, /unlinkedRosterProfiles=\{unlinkedRosterProfiles\}/);
    assert.match(earlyBranch, /canInviteManager\s+canManageHotelRoster=\{false\}/);
    assert.doesNotMatch(dialogs, /Share one hotel invitation as a link, QR code, or signup code\./);
    assert.doesNotMatch(dialogs, /Send a private invitation, then choose the job and exact company or hotel access\./);
    assert.match(dialogs, /QRCode\.toDataURL\(signupLinkFor\(code\.code\)/);
    assert.match(dialogs, /\{'Link'\}/);
    assert.match(dialogs, /\{'QR code'\}/);
    assert.match(dialogs, /\{'Signup code'\}/);
    assert.match(dialogs, /\{canManageHotelRoster \? \([\s\S]*?\{'Hotel invite'\}/);
    assert.match(dialogs, /\{canInviteManager \? \([\s\S]*?\{'Email one person'\}/);
    assert.doesNotMatch(dialogs, /inviteMode|hasInviteModeChoice|role="tablist"|role="tabpanel"/);
  });

  test('permission and read-only gates keep the entry closed', () => {
    assert.match(panel, /const inviteEntryAvailable = canAddStaff \|\| canInviteToStaxis/);
    assert.match(panel, /if \(inviteActionDisabled \|\| !inviteEntryAvailable\) return;/);
    assert.match(normalActionArea, /\{!needsFirstPerson && !locked && inviteEntryAvailable \?/);
    assert.match(normalActionArea, /disabled=\{inviteActionDisabled\}/);
    assert.match(earlyBranch, /\{canInviteAccounts && !locked \?/);
    assert.match(panel, /if \(!canAddStaff \|\| locked \|\| inviteActionDisabled\) return;/);
    assert.match(panel, /if \(!canInviteToStaxis \|\| inviteActionDisabled\) return;/);
  });

  test('an open chooser fails closed during read-only and admin-preview loading transitions', () => {
    assert.match(
      panel,
      /const inviteActionDisabled = locked[\s\S]*adminPreview && \(teamLoading \|\| Boolean\(teamError\)\)/,
    );
    assert.match(
      panel,
      /React\.useEffect\(\(\) => \{\s*if \(!inviteActionDisabled\) return;\s*setInviteChoiceOpen\(false\);\s*setAddDepartment\(null\);\s*if \(inviteDialogOpen\) onInviteDialogOpenChange\(false\);\s*\}, \[inviteActionDisabled, inviteDialogOpen, onInviteDialogOpenChange\]\)/,
    );

    const addStaffCallback = section(
      panel,
      'const chooseAddStaff = React.useCallback',
      'const chooseInviteToStaxis = React.useCallback',
      'Add staff chooser callback',
    );
    assert.match(addStaffCallback, /if \(!canAddStaff \|\| locked \|\| inviteActionDisabled\) return;/);
    assert.match(addStaffCallback, /\[canAddStaff, inviteActionDisabled, locked\]/);

    assert.match(normalDialogArea, /inviteChoiceOpen && !inviteActionDisabled/);
    assert.match(normalDialogArea, /canAddStaff=\{canAddStaff && !locked && !inviteActionDisabled\}/);
    assert.match(normalDialogArea, /canInviteToStaxis=\{canInviteToStaxis && !inviteActionDisabled\}/);
    assert.match(earlyBranch, /inviteChoiceOpen && canInviteAccounts && !locked && !inviteActionDisabled/);
    assert.match(earlyBranch, /canInviteToStaxis=\{!inviteActionDisabled\}/);
    assert.match(earlyBranch, /canSendEmailInvite=\{canInviteAccounts && !inviteActionDisabled\}/);
    assert.match(normalDialogArea, /addDepartment && !inviteActionDisabled/);
    assert.match(earlyBranch, /fallbackFocusRef=\{peopleHeadingRef\}/);
    assert.match(panel, /returnFocusRef=\{inviteEntryReturnFocusRef\}/);
  });

  test('both handoffs restore to the enabled trigger or the People heading fallback', () => {
    assert.match(panel, /const inviteEntryRef = React\.useRef<HTMLButtonElement \| null>\(null\)/);
    assert.match(panel, /const inviteEntryReturnFocusRef = React\.useRef<HTMLElement \| null>\(null\)/);
    assert.match(panel, /const peopleHeadingRef = React\.useRef<HTMLHeadingElement \| null>\(null\)/);
    assert.match(panel, /inviteEntryReturnFocusRef\.current = inviteEntryRef\.current/);
    assert.match(earlyBranch, /<h3 ref=\{peopleHeadingRef\} id="hotel-team-title" tabIndex=\{-1\}/);
    assert.match(panel, /<h2 ref=\{peopleHeadingRef\} id="team-members-title" tabIndex=\{-1\}/);
    assert.match(normalDialogArea, /returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(normalDialogArea, /fallbackFocusRef=\{peopleHeadingRef\}/);
    assert.match(normalDialogArea, /<LazyAddStaffDialog[\s\S]*returnFocusRef=\{addStaffReturnFocusRef\}/);
    assert.match(normalDialogArea, /<LazyAddStaffDialog[\s\S]*fallbackFocusRef=\{peopleHeadingRef\}/);
    assert.match(normalDialogArea, /<LazyInviteDialog[\s\S]*returnFocusRef=\{inviteEntryReturnFocusRef\}/);
    assert.match(normalDialogArea, /<LazyInviteDialog[\s\S]*fallbackFocusRef=\{peopleHeadingRef\}/);
    assert.match(normalDialogArea, /<DialogLoading[\s\S]*returnFocusRef=\{normalLoadingReturnFocusRef\}/);
    assert.match(normalDialogArea, /<DialogLoading[\s\S]*fallbackFocusRef=\{peopleHeadingRef\}/);
    assert.match(earlyBranch, /<DialogLoading[\s\S]*returnFocusRef=\{loadingReturnFocusRef\}/);
    assert.match(focusUtility, /isConnected[\s\S]*!element\.matches\(':disabled'\)[\s\S]*aria-disabled/);
    assert.match(
      focusUtility,
      /isUsableFocusTarget\(returnFocusElement\)[\s\S]*\? returnFocusElement[\s\S]*isUsableFocusTarget\(previousFocusElement\)[\s\S]*\? previousFocusElement[\s\S]*isUsableFocusTarget\(fallbackFocusElement\)[\s\S]*\? fallbackFocusElement/,
    );
    assert.doesNotMatch(focusUtility, /!returnFocusRef && !fallbackFocusRef/);
    assert.match(dialogs, /restoreDialogFocus\(returnFocusRef, fallbackFocusRef, previousFocusElement\)/);
    assert.match(addStaff, /restoreDialogFocus\(returnFocusRef, fallbackFocusRef, previousFocusElement\)/);

    const firstPersonHandoff = section(
      normalDialogArea,
      '{inviteDialogOpen && !inviteActionDisabled && needsFirstPerson ? (',
      ') : inviteDialogOpen && !inviteActionDisabled ? (',
      'first-person invite handoff',
    );
    assert.doesNotMatch(firstPersonHandoff, /returnFocusRef=/);
    assert.match(firstPersonHandoff, /fallbackFocusRef=\{peopleHeadingRef\}/);
  });

  test('Add staff restoration uses the chooser origin without stale Invite refs', () => {
    assert.match(panel, /const addStaffReturnFocusRef = React\.useRef<HTMLElement \| null>\(null\)/);

    const chooserAddCallback = section(
      panel,
      'const chooseAddStaff = React.useCallback',
      'const chooseInviteToStaxis = React.useCallback',
      'chooser Add staff origin callback',
    );
    assert.match(chooserAddCallback, /addStaffReturnFocusRef\.current = inviteEntryReturnFocusRef\.current/);
    assert.match(chooserAddCallback, /setAddDepartment\('housekeeping'\)/);
    assert.match(normalDialogArea, /<LazyAddStaffDialog[\s\S]*returnFocusRef=\{addStaffReturnFocusRef\}/);
    assert.match(normalLoadingFallback, /returnFocusRef=\{normalLoadingReturnFocusRef\}/);
    assert.doesNotMatch(normalLoadingFallback, /returnFocusRef=\{inviteEntryReturnFocusRef\}/);

    assert.match(
      loadingFocusSelection,
      /loadingDialogVariant === 'invite-choice'[\s\S]*inviteEntryReturnFocusRef[\s\S]*loadingDialogVariant === 'invite'[\s\S]*inviteEntryReturnFocusRef[\s\S]*loadingDialogVariant === 'add-staff'[\s\S]*addStaffReturnFocusRef[\s\S]*: undefined/,
    );
    assert.match(
      loadingFocusSelection,
      /const normalLoadingReturnFocusRef = needsFirstPerson && loadingDialogVariant === 'invite'\s*\n\s*\? undefined/,
    );
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
    assert.match(css, /\.peopleInviteChoice \{[\s\S]*min-height: 104px;/);
    assert.match(css, /\.dialogLoadingInviteChoice\s*\{[\s\S]*height:/);
    assert.match(css, /\.dialogLoadingAddStaff\s*\{[\s\S]*height:/);
    assert.match(css, /\.dialogLoadingChoices\s*\{[\s\S]*gap: 12px/);
    assert.match(css, /\.peopleInviteChoiceBadge\s*\{[\s\S]*border-radius: 999px;/);
    assert.match(css, /\.dialogLoadingChoiceBadge\s*\{[\s\S]*border-radius: 999px;/);
    assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.dialogLayer \{/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.peopleInviteChoice/);
  });
});
