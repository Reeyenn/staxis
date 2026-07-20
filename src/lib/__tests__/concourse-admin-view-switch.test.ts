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

describe('admin workspace navigation', () => {
  test('uses one explicit destination action instead of treating Admin as a department', () => {
    assert.match(concourse, /const isAdminWorkspace = pathname\.startsWith\(['"]\/admin['"]\)/);
    assert.match(concourse, /user\?\.role === ['"]admin['"] \? \{/);
    assert.match(concourse, /isAdminWorkspace \? ['"]\/home['"] : ['"]\/admin\/properties#live['"]/);
    assert.doesNotMatch(concourse, /items\.push\(\{[\s\S]*?key: ['"]admin['"]/);
    assert.match(barView, /className="cx-pill cx-utility-pill cx-view-switch"/);
  });

  test('keeps Company Hub out of the desktop top bar while retaining the phone destination', () => {
    assert.match(concourse, /const showCompanyInMobileNavigation = Boolean\(user && !companyOnly\)/);
    assert.match(concourse, /showCompany=\{showCompanyInMobileNavigation\}/);
    assert.doesNotMatch(barView, /companyActive|onCompany|companyLabel/);
    assert.match(mobile, /onCompany/);
    assert.match(concourse, /user\?\.role === ['"]admin['"][\s\S]*?['"]Management['"]/);
  });

  test('localizes visible labels and destination announcements', () => {
    for (const label of [
      'Admin View',
      'Hotel View',
      'Vista de administrador',
      'Vista del hotel',
      'Switch to Admin View',
      'Switch to Hotel View',
      'Cambiar a la vista de administrador',
      'Cambiar a la vista del hotel',
    ]) {
      assert.match(concourse, new RegExp(label));
    }
    assert.match(barView, /aria-label=\{viewSwitch\.ariaLabel\}/);
  });
});

describe('responsive workspace navigation', () => {
  test('puts the phone action in its own View area before department sections', () => {
    const viewIndex = mobile.indexOf('{viewSwitch ? (');
    const sectionsIndex = mobile.indexOf('<div className={styles.eyebrow}>{sectionsLabel}</div>');
    assert.ok(viewIndex >= 0 && sectionsIndex > viewIndex);
    assert.match(mobile, /<nav className=\{styles\.sectionList\} aria-label=\{viewSectionLabel\}>/);
    assert.match(mobile, /className=\{`\$\{styles\.navRow\} \$\{styles\.viewSwitchRow\}`\}/);
    assert.match(mobile, /aria-label=\{viewSwitch\.ariaLabel\}/);
  });

  test('keeps the desktop workspace switch ahead of collapsible departments', () => {
    const switchIndex = barView.indexOf('className="cx-pill cx-utility-pill cx-view-switch"');
    const itemsIndex = barView.indexOf('{items.map((it) => (');
    assert.ok(switchIndex >= 0 && itemsIndex > switchIndex);
    assert.match(concourse, /showHome=\{pathname !== homeHref && !isAdminWorkspace\}/);
    assert.match(mobileCss, /\.eyebrow \{[\s\S]*?color: #687067;/);
    assert.match(concourseCss, /@media \(min-width:761px\) and \(max-width:1100px\)[\s\S]*?\.cx-pill\{height:44px;\}[\s\S]*?\.cx-gear\{width:44px;height:44px;\}/);
    assert.doesNotMatch(mobile, /<h1 className=\{styles\.pageTitle\}/);
  });

  test('has visible focus, a 52px mobile target, and reduced-motion handling', () => {
    assert.match(mobileCss, /\.navRow \{[\s\S]*?min-height: 52px;/);
    assert.match(mobileCss, /\.viewSwitchRow \{/);
    assert.match(mobileCss, /\.navRow:focus-visible,[\s\S]*?outline: 2px solid #3e5c48;/);
    assert.match(concourseCss, /\.cx-pill:focus-visible,\.cx-gear:focus-visible\{outline:2px solid #3E5C48/);
    const reducedMotion = concourseCss.slice(concourseCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reducedMotion, /\.cx-pill,\.cx-pill \.cx-labw,\.cx-gear\{transition:none;\}/);
  });
});
