import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

test('fresh per-hotel seesFinancials standing drives Financials discovery without granting mutation', () => {
  const route = source('src/app/api/auth/session-authorization/route.ts');
  assert.match(route, /propertyStandings = authority\.propertyStandings\.map/);
  assert.match(route, /seesFinancials: standing\.seesFinancials/);
  assert.match(route, /hotelMutationAllowed: standing\.hotelMutationAllowed/);

  const auth = source('src/contexts/AuthContext.tsx');
  assert.match(auth, /parseSessionPropertyStandings/);
  assert.match(auth, /setPropertyStandings\(snapshot\.propertyStandings\)/);
  assert.match(auth, /setPropertyStandings\(\[\]\)/);

  const shell = source('src/components/concourse/ConcourseBar.tsx');
  assert.match(shell, /activePropertyStanding\.seesFinancials/);
  assert.doesNotMatch(
    shell,
    /activePropertyStanding\.hotelMutationAllowed[\s\S]{0,120}financials/,
    'read-only finance discovery must not be coupled to hotel mutation',
  );

  const page = source('src/app/financials/page.tsx');
  assert.match(page, /activePropertyStanding\.seesFinancials/);
  assert.match(page, /!activePropertyStanding\.hotelMutationAllowed/);
  assert.match(page, /readOnly=\{readOnly\}/g);

  for (const component of [
    'src/app/financials/_components/CheckbookTab.tsx',
    'src/app/financials/_components/BudgetTab.tsx',
    'src/app/financials/_components/CapexTab.tsx',
    'src/app/financials/_components/CapexDetailModal.tsx',
  ]) {
    assert.match(source(component), /readOnly/);
  }

  const financialGate = source('src/lib/financials/api-gate.ts');
  assert.match(financialGate, /standing\.seesFinancials/);
  assert.match(
    financialGate,
    /!readOnly && \(!standing\.hotelMutationAllowed \|\| !canViewFinancials\(role\)\)/,
    'financial reads use seesFinancials, while every write also requires explicit hotel mutation authority',
  );
});
