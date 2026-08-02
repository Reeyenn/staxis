import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const activity = source('src', 'components', 'agent', 'AiActivityButton.tsx');
const activityCss = source('src', 'components', 'agent', 'AiActivityButton.module.css');
const hotelInvites = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

describe('app-wide async modal layout stability', () => {
  test('AI activity cache is property-scoped and its loading feed matches final geometry', () => {
    assert.match(activity, /activityCache\?\.propertyId === activePropertyId/);
    assert.match(activity, /key=\{activePropertyId\}/);
    assert.match(activity, /initialData=\{scopedCache\}/);
    assert.match(activity, /const initialLoading = loading && !loadedOnce/);
    assert.match(activity, /className=\{styles\.loadingVisual\} aria-hidden="true"/);
    assert.match(activityCss, /\.activityCard\s*\{[\s\S]*?height:\s*min\(620px, 82vh\)/);
    assert.match(activityCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  });

  test('hotel invitation loading sections cannot collapse the wide dialog', () => {
    // Join-code loading exists only for managers of the selected hotel; email
    // invitation loading applies to every authorized invite surface.
    assert.match(hotelInvites, /className=\{styles\.inviteBody\} aria-busy=\{\(canManageHotelRoster && codeLoading\) \|\| invitesLoading\}/);
    assert.equal((hotelInvites.match(/<InviteSectionSkeleton/g) ?? []).length, 2);
    assert.match(hotelInvites, /className=\{styles\.inviteSkeletonVisual\} aria-hidden="true"/);
    assert.match(hotelTeamCss, /\.inviteBody\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(hotelTeamCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.inviteSkeletonLine::after[\s\S]*?animation:\s*none/);
  });
});
