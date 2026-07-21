import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const coverage = source('src', 'app', 'admin', '_components', 'studio', 'CoveragePickerModal.tsx');
const coverageCss = source('src', 'app', 'admin', '_components', 'studio', 'CoveragePickerModal.module.css');
const maps = source('src', 'app', 'admin', '_components', 'MapsManager.tsx');
const mapsCss = source('src', 'app', 'admin', '_components', 'MapsManager.module.css');
const activity = source('src', 'components', 'agent', 'AiActivityButton.tsx');
const activityCss = source('src', 'components', 'agent', 'AiActivityButton.module.css');
const hotelInvites = source('src', 'app', 'company', '_components', 'HotelTeamDialogs.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

describe('app-wide async modal layout stability', () => {
  test('coverage picker reserves its option viewport before effects run', () => {
    assert.match(coverage, /const initialLoading = rows === null && loadError === null/);
    assert.match(coverage, /className=\{styles\.optionRegion\} aria-busy=\{initialLoading\}/);
    assert.match(coverage, /className=\{styles\.loadingVisual\} aria-hidden="true"/);
    assert.match(coverageCss, /\.optionRegion\s*\{[\s\S]*?min-height:\s*248px/);
    assert.match(coverageCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  });

  test('maps manager opens at one height and keeps last-good rows during refresh', () => {
    assert.match(maps, /const \[loadedOnce, setLoadedOnce\] = useState\(false\)/);
    assert.match(maps, /const initialLoading = !loadedOnce && totalMaps === 0 && error === null/);
    assert.match(maps, /className=\{`admin-studio \$\{styles\.modalCard\}`\}/);
    assert.match(maps, /aria-busy=\{loading \|\| initialLoading\}/);
    assert.match(mapsCss, /\.modalCard\s*\{[\s\S]*?height:\s*min\(720px, 88vh\)/);
    assert.match(mapsCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  });

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
    assert.match(hotelInvites, /className=\{styles\.inviteBody\} aria-busy=\{codeLoading \|\| invitesLoading\}/);
    assert.equal((hotelInvites.match(/<InviteSectionSkeleton/g) ?? []).length, 2);
    assert.match(hotelInvites, /className=\{styles\.inviteSkeletonVisual\} aria-hidden="true"/);
    assert.match(hotelTeamCss, /\.inviteBody\s*\{[\s\S]*?min-height:\s*min\(610px, calc\(100dvh - 190px\)\)/);
    assert.match(hotelTeamCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.inviteSkeletonLine::after[\s\S]*?animation:\s*none/);
  });
});
