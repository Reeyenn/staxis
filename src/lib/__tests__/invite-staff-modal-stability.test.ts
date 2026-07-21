import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const staffDirectory = source('src', 'app', 'staff', '_components', 'ManagerDirectory.tsx');
const invitePanel = source('src', 'components', 'team', 'InviteStaffPanel.tsx');
const invitePanelCss = source('src', 'components', 'team', 'InviteStaffPanel.module.css');
const hotelTeam = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

describe('Invite Staff popup layout stability', () => {
  test('Staff opens one viewport-capped dialog and reserves the loaded invite geometry', () => {
    assert.match(staffDirectory, /className=\{invitePanelStyles\.modalLayer\}/);
    assert.match(staffDirectory, /className=\{invitePanelStyles\.modalDialog\}[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/);
    assert.match(invitePanelCss, /\.modalDialog\s*\{[\s\S]*?height:\s*min\(760px, calc\(100dvh - 32px\)\)/);
    assert.match(invitePanelCss, /\.modalDialog\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 32px\)/);
    assert.match(invitePanel, /className=\{styles\.panelBody\}[\s\S]*?aria-busy=\{codeLoading \|\| regenerating \|\| inviteSubmitting\}/);
    assert.match(invitePanel, /className=\{styles\.primarySkeleton\} role="status" aria-live="polite"/);
    assert.match(invitePanel, /styles\.skeletonLink/);
    assert.match(invitePanel, /styles\.skeletonQr/);
    assert.match(invitePanel, /styles\.skeletonCode/);
    assert.doesNotMatch(invitePanel, /codeLoading \? \([\s\S]{0,220}className="spinner"/);
    assert.match(invitePanel, /type="button"\s+className=\{styles\.closeButton\}/);
    assert.match(invitePanelCss, /\.closeButton\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
    assert.match(invitePanelCss, /@media \(max-width: 600px\)[\s\S]*?height:\s*calc\(100dvh - 12px\)/);
    assert.match(invitePanelCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
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
