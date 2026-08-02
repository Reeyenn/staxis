import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const hotelTeam = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');
const hotelTeamDialogs = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const hotelInviteDialog = hotelTeamDialogs.slice(hotelTeamDialogs.indexOf('export function HotelInviteDialog'));

// There is exactly one invite surface now. Invite staff can reach a join code,
// a shareable link, a QR image, and a manager email invite from the same page.
describe('Invite Staff popup layout stability', () => {
  test('the invite dialog shows both authorized paths on one compact page', () => {
    assert.match(hotelTeamDialogs, /\/api\/auth\/join-codes/);
    assert.match(hotelTeamDialogs, /\/api\/auth\/invites/);
    assert.match(hotelTeamDialogs, /QRCode\.toDataURL\(signupLinkFor\(code\.code\)/);
    assert.match(hotelTeamDialogs, /<img src=\{qrDataUrl\}/);
    assert.match(hotelTeamDialogs, /copyToClipboard\(/);
    assert.match(hotelInviteDialog, /title=\{'Invite people'\}/);
    assert.match(hotelInviteDialog, /description=\{''\}/);
    assert.match(hotelInviteDialog, /\{'Hotel invite'\}/);
    assert.match(hotelInviteDialog, /\{'Email one person'\}/);
    assert.match(hotelInviteDialog, /\{'Create hotel invite'\}/);
    assert.match(hotelInviteDialog, /\{'Link'\}/);
    assert.match(hotelInviteDialog, /\{'QR code'\}/);
    assert.match(hotelInviteDialog, /\{'Signup code'\}/);
    assert.match(hotelInviteDialog, /\{'Send invite'\}/);
    assert.match(hotelInviteDialog, /\{canManageHotelRoster \? \([\s\S]*?hotel-invite-heading/);
    assert.match(hotelInviteDialog, /\{canInviteManager \? \([\s\S]*?email-invite-heading/);
    assert.match(hotelInviteDialog, /onClick=\{\(\) => void createCode\(false\)\}/);
    assert.match(hotelInviteDialog, /<form className=\{styles\.managerInviteForm\} onSubmit=\{sendManagerInvite\}>/);
    assert.doesNotMatch(hotelInviteDialog, /inviteMode|hasInviteModeChoice|role="tablist"|role="tab"|role="tabpanel"/);
    assert.doesNotMatch(hotelInviteDialog, /One invitation, three ways to share it|Every option opens the same Staxis signup|For one person who needs login access/);
    assert.doesNotMatch(hotelInviteDialog, /<div className=\{styles\.dialogFooter\}>[\s\S]*?\{'Done'\}/);
    // The email surface projects the caller's current server-authorized jobs
    // and hotel scopes instead of hard-coding a GM-only invitation.
    assert.match(hotelInviteDialog, /inviteOptions\.jobs\.map/);
    assert.match(hotelInviteDialog, /allowedInviteHotels\.map/);
    assert.match(hotelInviteDialog, /linkableRosterProfiles\.map/);
    assert.match(hotelInviteDialog, /aria-describedby=\{rosterProfileHelpId\}/);
    const safeProfileResets = hotelInviteDialog.match(/setInviteStaffId\(['"]['"]\)/g) ?? [];
    assert.ok(safeProfileResets.length >= 6, 'role, scope, reload, and success paths must clear stale roster choices');
    assert.match(hotelInviteDialog, /\.\.\.\(selectedRosterProfile \? \{ staffId: selectedRosterProfile\.id \} : \{\}\)/);
    assert.match(hotelInviteDialog, /lastInvite\.kind === 'access'/);
    assert.match(hotelTeamCss, /\.fieldLabelWithMeta em \{/);
    // Replacing a link must say the old link and QR stop working.
    assert.match(hotelInviteDialog, /The current link and QR code will stop working/);
  });

  test('keeps active invite lifecycle actions and hides a loaded zero-pending list', () => {
    assert.match(hotelInviteDialog, /code \? \([\s\S]*?\{'Link'\}[\s\S]*?\{'Signup code'\}/);
    assert.match(hotelInviteDialog, /createCode\(true\)/);
    assert.match(hotelInviteDialog, /\{'Create a new link'\}/);
    assert.match(hotelInviteDialog, /invites\.length > 0 \? \([\s\S]*?Pending email invitations/);
    assert.doesNotMatch(hotelInviteDialog, /invites\.length > 0 \? \([\s\S]*?No pending or expired email invitations/);
    assert.match(hotelInviteDialog, /invitesLoading \? \([\s\S]*?InviteSectionSkeleton label=\{'Loading invitations…'\}/);
    assert.match(hotelInviteDialog, /invitesError \? \([\s\S]*?onClick=\{\(\) => void loadInvites\(\)\}/);
  });

  test('Company Suspense fallback uses the destination dialog shape instead of a tiny spinner', () => {
    assert.match(hotelTeam, /type DialogLoadingVariant = 'invite' \| 'invite-choice' \| 'add-staff' \| 'member' \| 'remove' \| 'decision'/);
    assert.match(hotelTeam, /type InviteLoadingSection = 'hotel' \| 'email'/);
    assert.match(hotelTeam, /inviteSections=\{\['email'\]\}/);
    assert.match(hotelTeam, /inviteSections=\{canInviteAccounts \? \['hotel', 'email'\] : \['hotel'\]\}/);
    assert.match(hotelTeam, /className=\{`\$\{styles\.dialog\} \$\{styles\.dialogLoadingShell\} \$\{shellClass\}`\}/);
    assert.match(hotelTeam, /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-busy="true"/);
    assert.match(hotelTeam, /variant === 'invite'[\s\S]*?visibleInviteSections\.map/);
    assert.match(hotelTeam, /section === 'hotel'[\s\S]*?DialogLoadingSection key=\{`\$\{section\}-\$\{index\}`\} rows=\{4\} tall/);
    assert.match(hotelTeam, /section === 'hotel'[\s\S]*?: \([\s\S]*?DialogLoadingFields key=\{`\$\{section\}-\$\{index\}`\} rows=\{4\}/);
    assert.match(hotelTeam, /variant === 'invite' \? null[\s\S]*?dialogFooter/);
    assert.match(hotelTeam, /<React\.Suspense fallback=\{\([\s\S]*?<DialogLoading[\s\S]*?variant=\{loadingDialogVariant\}/);
    assert.doesNotMatch(hotelTeam, /className=\{styles\.dialogLoading\} role="status"/);
    assert.match(hotelTeamCss, /\.dialogLoadingInvite\s*\{[\s\S]*?height:\s*auto;/);
    assert.match(hotelTeamCss, /\.dialogLoadingInvite \.dialogLoadingBody\s*\{[\s\S]*?padding-bottom: max\(17px, env\(safe-area-inset-bottom, 0px\)\)/);
    assert.match(hotelTeamCss, /\.dialogLoadingMember\s*\{[\s\S]*?height:\s*min\(680px, calc\(100dvh - 40px\)\)/);
    assert.match(hotelTeamCss, /\.dialogLoadingConfirmation\s*\{[\s\S]*?height:\s*min\(420px, calc\(100dvh - 40px\)\)/);
    assert.match(hotelTeamCss, /@media \(max-width: 560px\)[\s\S]*?\.dialogLoadingInvite\s*\{[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*calc\(100dvh - 24px\)/);
    assert.match(hotelTeamCss, /@media \(max-width: 560px\)[\s\S]*?\.inviteBody\s*\{[\s\S]*?padding-bottom: max\(17px, env\(safe-area-inset-bottom, 0px\)\)/);
    assert.match(hotelTeamCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dialogLoadingIcon::after[\s\S]*?animation:\s*none/);
  });

  test('malformed successful invite data stays in the bounded error states', () => {
    assert.match(hotelTeamDialogs, /function recordOf\(value: unknown\)/);
    assert.match(hotelTeamDialogs, /function isJoinCode\(value: unknown\): value is JoinCode/);
    assert.match(hotelTeamDialogs, /function isManagerInvite\(value: unknown\): value is ManagerInvite/);
    assert.match(hotelTeamDialogs, /function isInviteOptions\(value: unknown\): value is InviteOptions/);
    assert.match(hotelTeamDialogs, /!Array\.isArray\(body\.data\.codes\)/);
    assert.match(hotelTeamDialogs, /body\.data\.codes\.every\(isJoinCode\)/);
    assert.match(hotelTeamDialogs, /!Array\.isArray\(body\.data\.invites\)/);
    assert.match(hotelTeamDialogs, /body\.data\.invites\.every\(isManagerInvite\)/);
    assert.match(hotelTeamDialogs, /!isInviteOptions\(body\.data\.options\)/);
    assert.match(hotelInviteDialog, /invites\.length > 0/);
    assert.match(hotelTeamDialogs, /Couldn't load manager invitations\./);
  });

  test('clears dialog-local invite state when either effective capability is revoked', () => {
    assert.match(hotelInviteDialog, /const inviteCapabilityRef = React\.useRef\(\{ canInviteManager, canManageHotelRoster \}\)/);
    assert.match(hotelInviteDialog, /if \(!canInviteManager\)[\s\S]*setInviteEmail\(''\)[\s\S]*setLastInvite\(null\)[\s\S]*setInvitesError\(''\)/);
    assert.match(hotelInviteDialog, /if \(!canManageHotelRoster\)[\s\S]*setCode\(null\)[\s\S]*setConfirmReplace\(false\)[\s\S]*setQrDataUrl\(''\)/);
    assert.match(hotelInviteDialog, /onClose\(\);[\s\S]*\}, \[canInviteManager, canManageHotelRoster, onClose\]\)/);
  });
});
