import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const barView = source('src', 'components', 'concourse', 'ConcourseBarView.tsx');
const mobile = source('src', 'components', 'concourse', 'MobileConcourseNav.tsx');
const concourseCss = source('src', 'components', 'concourse', 'concourse-css.tsx');
const mobileCss = source('src', 'components', 'concourse', 'MobileConcourseNav.module.css');
const company = source('src', 'app', 'company', 'page.tsx');
const companyCss = source('src', 'app', 'company', 'CompanyAccess.module.css');
const hotelTeam = source('src', 'app', 'company', '_components', 'HotelTeamPanel.tsx');
const hotelTeamCss = source('src', 'app', 'company', '_components', 'HotelTeamPanel.module.css');

describe('in-place admin hotel view', () => {
  test('removes the admin destination action from desktop and phone navigation', () => {
    assert.doesNotMatch(concourse, /const viewSwitch|viewSwitch=|Switch to Admin View|\/admin\/properties#live['"]\)/);
    assert.doesNotMatch(barView, /ViewSwitchAction|viewSwitch|cx-view-switch|cx-utility-pill/);
    assert.doesNotMatch(mobile, /ViewSwitchAction|viewSwitch|selectView|viewSectionLabel|viewSwitchRow/);
    assert.doesNotMatch(concourseCss, /cx-view-switch|cx-utility-pill/);
    assert.doesNotMatch(mobileCss, /viewSwitchRow/);
  });

  test('keeps the switch inside My Hotel and changes local state without routing', () => {
    const heroIndex = company.indexOf('<header className={styles.hero}>');
    const switchIndex = company.indexOf('<label className={styles.adminViewSwitch}>', heroIndex);
    const heroEnd = company.indexOf('</header>', switchIndex);
    const switchMarkup = company.slice(switchIndex, heroEnd);

    assert.ok(heroIndex >= 0 && switchIndex > heroIndex && heroEnd > switchIndex);
    assert.match(switchMarkup, /type="checkbox"/);
    assert.match(switchMarkup, /role="switch"/);
    assert.match(switchMarkup, /checked=\{adminToolsActive\}/);
    assert.match(switchMarkup, /aria-checked=\{adminToolsActive\}/);
    assert.match(switchMarkup, /onChange=\{\(event\) => setAdminToolsEnabled\(event\.target\.checked\)\}/);
    assert.doesNotMatch(switchMarkup, /router\.(push|replace)|\/admin\/properties/);
    assert.match(company, /setAdminToolsEnabled\(false\);\s*\}, \[activePropertyId, userRole\]\)/);
  });

  test('unlocks only independently authorized hotel-team tools and remounts dialogs on mode changes', () => {
    assert.match(company, /\/api\/admin\/company-access-preview\?pid=/);
    assert.match(company, /normalized\.viewerContext\?\.kind !== ['"]staxis_admin_preview['"]/);
    assert.match(company, /normalized\.viewerContext\.readOnly !== true/);
    assert.match(company, /key=\{`\$\{activeProperty\.id\}:\$\{adminToolsEnabled \? ['"]admin['"] : ['"]preview['"]\}`\}/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) && !adminToolsEnabled\}/);
    assert.match(company, /allowAdminActions=\{adminToolsEnabled\}/);
    assert.match(hotelTeam, /const locked = readOnly \|\| \(adminPreview && !allowAdminActions\)/);
    assert.match(hotelTeam, /const nextTeam = \(adminPreview \|\| readOnly\)[\s\S]*?!member\.isPlatformAdmin/);
  });

  test('removes both duplicate admin-only status banners without weakening read-only mode', () => {
    assert.doesNotMatch(company, /styles\.adminPreviewNotice|styles\.adminToolsNotice/);
    assert.doesNotMatch(company, /Hotel view · Read-only|Reviewing the hotel workspace/);
    assert.doesNotMatch(companyCss, /\.adminPreviewNotice|\.adminToolsNotice/);
    assert.doesNotMatch(hotelTeam, /styles\.readOnlyNotice|Read-only preview|You can review this hotel/);
    assert.doesNotMatch(hotelTeamCss, /\.readOnlyNotice/);
    assert.match(company, /readOnly=\{Boolean\(data\.viewerContext\?\.readOnly\) && !adminToolsEnabled\}/);
    assert.match(hotelTeam, /const locked = readOnly \|\| \(adminPreview && !allowAdminActions\)/);
  });

  test('is admin-only, compact, keyboard visible, mobile safe, and reduced-motion safe', () => {
    assert.match(company, /\{adminPreview \? \(\s*<label className=\{styles\.adminViewSwitch\}>/);
    assert.match(companyCss, /\.adminViewSwitch \{[\s\S]*?min-height: 48px;/);
    assert.match(companyCss, /\.adminViewSwitchTrack \{[\s\S]*?width: 48px;[\s\S]*?height: 28px;/);
    assert.match(companyCss, /\.adminViewSwitch input:focus-visible \+ \.adminViewSwitchTrack \{[\s\S]*?outline:/);
    const mobileRules = companyCss.slice(companyCss.indexOf('@media (max-width: 800px)'));
    assert.match(mobileRules, /\.heroActions \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?justify-content: space-between;/);
    const reducedMotion = companyCss.slice(companyCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reducedMotion, /\.adminViewSwitchTrack,[\s\S]*?\.adminViewSwitchHandle,/);
  });
});
