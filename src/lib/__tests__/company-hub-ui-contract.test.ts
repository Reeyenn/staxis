import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const home = source('src', 'app', 'home', 'page.tsx');
const liveSurface = source('src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx');
const invitation = source('src', 'app', 'company-invite', '[token]', 'page.tsx');
const authShell = source('src', 'components', 'AuthShell.tsx');
const company = source('src', 'app', 'company', 'page.tsx');
const companyCss = source('src', 'app', 'company', 'CompanyAccess.module.css');

describe('company-only shell routing', () => {
  test('does not expose hotel sections without an active hotel', () => {
    assert.match(concourse, /propertyLoading \|\| !activeProperty \? \[\] : SECTION_LIST/);
    assert.match(concourse, /const companyOnly = !propertyLoading && !!user && properties\.length === 0/);
    assert.match(concourse, /const homeHref = companyOnly \? ['"]\/company['"] : ['"]\/home['"]/);
  });

  test('distinguishes an unselected portfolio from a truly zero-property company user', () => {
    assert.match(home, /user\.role === ['"]admin['"] \|\| properties\.length > 0/);
    assert.match(home, /body\.data\?\.organizations\?\.some/);
    assert.match(home, /organization\.type !== ['"]single_hotel['"]/);
  });
});

describe('admin hotel directory safeguards', () => {
  test('only active organizations can receive hotel assignments', () => {
    assert.match(liveSurface, /organization\.status === ['"]active['"] && hasIndependentHotels/);
    assert.match(liveSurface, /organizations\.filter\(\(organization\) => organization\.status === ['"]active['"]\)/);
    assert.match(liveSurface, /No active organizations available/);
  });
});

describe('company invitation accessibility', () => {
  test('registration controls have explicit labels and announced errors', () => {
    assert.match(invitation, /htmlFor="company-invite-display-name"/);
    assert.match(invitation, /id="company-invite-display-name"/);
    assert.match(invitation, /htmlFor="company-invite-password"/);
    assert.match(invitation, /htmlFor="company-invite-confirm-password"/);
    assert.match(invitation, /aria-describedby=\{error \? ['"]company-invite-error['"]/);
    assert.match(authShell, /role="alert" aria-live="assertive"/);
  });
});

describe('truthful Company Hub filters', () => {
  test('hotels use not-active semantics instead of calling every non-active row pending', () => {
    assert.match(company, /type HotelStatusFilter = ['"]all['"] \| ['"]active['"] \| ['"]not_active['"]/);
    assert.match(company, /property\.status === ['"]active['"] : property\.status !== ['"]active['"]/);
    assert.match(company, /value: ['"]not_active['"], label: localized\(lang, ['"]Not active['"]/);
  });

  test('the invited People filter includes actual pending invitations', () => {
    assert.match(company, /type PeopleStatusFilter = ['"]all['"] \| ['"]active['"] \| ['"]invited['"] \| ['"]not_active['"]/);
    assert.match(company, /statusFilter === ['"]invited['"] && invitation\.status === ['"]pending['"]/);
    assert.match(company, /visibleInvitations\.map/);
  });
});

describe('mobile Company Hub touch targets', () => {
  test('small interactive controls reach the 44px mobile minimum', () => {
    const mobile = companyCss.slice(companyCss.indexOf('@media (max-width: 600px)'));
    assert.match(mobile, /\.reviewButton,[\s\S]*\.actionMenu summary,[\s\S]*\.actionMenu button \{\s*min-height: 44px;/);
    assert.match(mobile, /\.searchField > button,[\s\S]*\.iconButton \{\s*width: 44px;\s*height: 44px;/);
    assert.match(mobile, /\.filterChips button \{[\s\S]*min-height: 44px;/);
  });
});
