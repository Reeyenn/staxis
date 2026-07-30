import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const popover = source('src/app/admin/_components/AccessPopover.tsx');
const surface = source('src/app/admin/_components/studio/surfaces/AccessSurface.tsx');
const css = source('src/app/admin/_components/AccessModal.module.css');
const matrixRoute = source('src/app/api/admin/access/matrix/route.ts');
const toggleRoute = source('src/app/api/admin/access/toggle/route.ts');
const applyRoute = source('src/app/api/admin/access/apply-to-all/route.ts');
const organizationRoute = source('src/app/api/admin/organizations/route.ts');

describe('Admin Access modal contract', () => {
  test('is an opaque viewport-contained dialog with one internal scroll owner', () => {
    assert.match(popover, /role="dialog"/);
    assert.match(popover, /aria-modal="true"/);
    assert.match(popover, /aria-labelledby="access-modal-title"/);
    assert.match(popover, /data-access-modal-backdrop/);
    assert.match(popover, /document\.body\.style\.overflow = 'hidden'/);
    assert.match(popover, /document\.documentElement\.style\.overflow = 'hidden'/);
    assert.match(popover, /window\.scrollTo\(scrollX, scrollY\)/);
    assert.match(popover, /returnTarget\.focus\(\{ preventScroll: true \}\)/);
    assert.match(css, /background: var\(--access-ink\)/);
    assert.match(css, /max-width: calc\(100vw - 48px\)/);
    assert.match(css, /max-height: calc\(100dvh - 48px\)/);
    assert.match(css, /\.body[\s\S]*overflow-y: auto/);
    assert.match(css, /\.dialog[\s\S]*overflow: hidden/);
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*width: 100vw;[\s\S]*height: 100dvh/);
  });

  test('keeps the header fixed, uses accessible tabs, and contains wide matrices', () => {
    assert.match(surface, /data-access-modal-header/);
    assert.match(surface, /role="tablist"/);
    assert.match(surface, /role="tab"/);
    assert.match(surface, /aria-selected=\{selected\}/);
    assert.match(surface, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
    assert.match(surface, /role="tabpanel"/);
    assert.match(surface, /role="region"[\s\S]*aria-label="Hotel role and capability matrix"/);
    assert.match(surface, /role="region"[\s\S]*aria-label="Organization role and capability matrix"/);
    assert.match(css, /\.matrixScroller[\s\S]*overflow-x: auto/);
    assert.match(css, /\.closeButton[\s\S]*min-height: 44px/);
    assert.match(css, /\.switchButton[\s\S]*height: 44px/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  test('shows every authoritative organization profile/capability without inventing mutable policy', () => {
    assert.match(surface, /ACCESS_PROFILES\.map/);
    assert.match(surface, /ORGANIZATION_CAPABILITIES\.length/);
    assert.match(surface, /ACCESS_PROFILE_CAPABILITIES\[profile\]\.includes\(capability\)/);
    assert.match(surface, /COMPANY_SCOPE_ROLES\.map/);
    assert.match(surface, /Portfolio manager/);
    assert.match(surface, /Platform Admin can inspect this policy but cannot rewrite/);
    assert.doesNotMatch(surface, /AdminEffectiveAccess/);
    assert.doesNotMatch(surface, /Remove .* access/);
  });

  test('uses current admin routes and leaves authorization at read and commit boundaries', () => {
    assert.match(surface, /\/api\/admin\/organizations/);
    assert.match(surface, /\/api\/admin\/access\/matrix/);
    assert.match(surface, /\/api\/admin\/access\/toggle/);
    assert.match(surface, /\/api\/admin\/access\/apply-to-all/);
    for (const route of [matrixRoute, toggleRoute, applyRoute, organizationRoute]) {
      assert.match(route, /requireAdmin\(req\)/);
    }
    assert.match(toggleRoute, /isAdminOnlyCapability/);
    assert.match(toggleRoute, /isLiveCapability/);
  });

  test('derives truthful counts and has explicit loading, error, saving, disabled, and clear-all states', () => {
    assert.match(surface, /configurableCount/);
    assert.match(surface, /ORGANIZATION_CAPABILITIES\.length/);
    assert.doesNotMatch(surface, /0\s*[–-]\s*100 of/);
    assert.match(surface, /Loading hotel access settings/);
    assert.match(surface, /role="alert"/);
    assert.match(surface, /Saving hotel access change/);
    assert.match(surface, /disabled=\{disabled\}/);
    assert.match(surface, /confirmClearAll: true/);
    assert.match(surface, /Confirm clear on other hotels/);
  });
});
