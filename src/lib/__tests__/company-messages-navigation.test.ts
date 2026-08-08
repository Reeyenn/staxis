import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const appLayout = source('src', 'components', 'layout', 'AppLayout.tsx');
const legacyRoute = source('src', 'app', '(portfolio)', 'portfolio', '[section]', 'page.tsx');

describe('personal Messages navigation in company scope', () => {
  test('keeps the company selector but never targets the portfolio Communications module', () => {
    const messagesBranchStart = concourse.indexOf("if (key === 'communications')");
    const messagesBranchEnd = concourse.indexOf("if (purePortfolioContext)", messagesBranchStart);
    assert.ok(messagesBranchStart >= 0 && messagesBranchEnd > messagesBranchStart);
    const messagesBranch = concourse.slice(messagesBranchStart, messagesBranchEnd);

    assert.match(messagesBranch, /companyScopeHref\('\/communications', organizationId\)/);
    assert.match(messagesBranch, /return organizationId[\s\S]*'\/communications'/);
    assert.doesNotMatch(messagesBranch, /`\/portfolio\/\$\{key\}/);
  });

  test('lets personal company-scoped Messages render through the shared shell', () => {
    assert.match(
      appLayout,
      /const companySectionPending = activeScope\.kind === 'company'[\s\S]*?currentSection !== 'communications'/,
    );
  });

  test('redirects the retired portfolio Communications route to personal Messages', () => {
    const communicationsBranchStart = legacyRoute.indexOf("if (section === 'communications')");
    const communicationsBranchEnd = legacyRoute.indexOf("if (section !== 'staxis'", communicationsBranchStart);
    assert.ok(communicationsBranchStart >= 0 && communicationsBranchEnd > communicationsBranchStart);
    const communicationsBranch = legacyRoute.slice(communicationsBranchStart, communicationsBranchEnd);

    assert.match(communicationsBranch, /redirect\(/);
    assert.match(communicationsBranch, /companyScopeHref\('\/communications', organizationId\)/);
    assert.match(communicationsBranch, /: '\/communications'/);
    assert.match(communicationsBranch, /isPortfolioUiUuid\(query\.organizationId\)/);
    assert.doesNotMatch(communicationsBranch, /PortfolioSectionClient/);
  });
});
