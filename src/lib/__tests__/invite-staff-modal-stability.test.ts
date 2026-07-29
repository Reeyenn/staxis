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

// There is exactly ONE invite surface now. Staff → Directory used to render a
// second copy (InviteStaffPanel, in its own modal) against the same
// /api/auth/join-codes and /api/auth/invites routes; both it and its stylesheet
// were deleted with the Directory on 2026-07-27, so the assertions about that
// component's markup went with them — there is no component left to break.
// What that test actually protected — invite staff can reach a join code, a
// shareable link, a QR image and a manager email invite — is asserted here
// against the copy that survived.
describe('Invite Staff popup layout stability', () => {
  test('the surviving invite dialog still offers code, link, QR and email invite', () => {
    assert.match(hotelTeamDialogs, /\/api\/auth\/join-codes/);
    assert.match(hotelTeamDialogs, /\/api\/auth\/invites/);
    assert.match(hotelTeamDialogs, /QRCode\.toDataURL\(signupLinkFor\(code\.code\)/);
    assert.match(hotelTeamDialogs, /<img src=\{qrDataUrl\}/);
    assert.match(hotelTeamDialogs, /copyToClipboard\(/);
    assert.match(hotelTeamDialogs, /Staff signup link/);
    // The email surface now projects the caller's current server-authorized
    // jobs and hotel scopes instead of hard-coding a GM-only invitation.
    assert.match(hotelTeamDialogs, /Invite by email/);
    assert.match(hotelTeamDialogs, /inviteOptions\.jobs\.map/);
    assert.match(hotelTeamDialogs, /allowedInviteHotels\.map/);
    // Replacing a link must say the old link and QR stop working.
    assert.match(hotelTeamDialogs, /The current link and QR code will stop working/);
  });

  test('Company Suspense fallback uses the destination dialog shape instead of a tiny spinner', () => {
    assert.match(hotelTeam, /type DialogLoadingVariant = 'invite' \| 'member' \| 'remove' \| 'decision'/);
    assert.match(hotelTeam, /className=\{`\$\{styles\.dialog\} \$\{styles\.dialogLoadingShell\} \$\{shellClass\}`\}/);
    assert.match(hotelTeam, /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-busy="true"/);
    assert.match(hotelTeam, /variant === 'invite'[\s\S]*?<DialogLoadingSection rows=\{4\} tall \/>/);
    assert.match(hotelTeam, /<React\.Suspense fallback=\{\([\s\S]*?<DialogLoading[\s\S]*?variant=\{loadingDialogVariant\}/);
    assert.doesNotMatch(hotelTeam, /className=\{styles\.dialogLoading\} role="status"/);
    assert.match(hotelTeamCss, /\.dialogLoadingInvite\s*\{[\s\S]*?height:\s*min\(800px, calc\(100dvh - 40px\)\)/);
    assert.match(hotelTeamCss, /\.dialogLoadingMember\s*\{[\s\S]*?height:\s*min\(680px, calc\(100dvh - 40px\)\)/);
    assert.match(hotelTeamCss, /\.dialogLoadingConfirmation\s*\{[\s\S]*?height:\s*min\(420px, calc\(100dvh - 40px\)\)/);
    assert.match(hotelTeamCss, /@media \(max-width: 560px\)[\s\S]*?\.dialogLoadingInvite\s*\{[\s\S]*?height:\s*calc\(100dvh - 24px\)/);
    assert.match(hotelTeamCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dialogLoadingIcon::after[\s\S]*?animation:\s*none/);
  });
});
