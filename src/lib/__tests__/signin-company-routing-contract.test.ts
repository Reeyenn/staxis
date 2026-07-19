import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const signIn = readFileSync(join(process.cwd(), 'src/app/signin/page.tsx'), 'utf8');
const verify = readFileSync(join(process.cwd(), 'src/app/signin/verify/page.tsx'), 'utf8');
const propertySelector = readFileSync(join(process.cwd(), 'src/app/property-selector/page.tsx'), 'utf8');

describe('signin property-independent Company routing', () => {
  test('zero-property accounts may finish a company invitation or open Company Hub', () => {
    assert.match(signIn, /requestedTarget === ['"]\/company['"]/);
    assert.match(signIn, /requestedTarget\.startsWith\(['"]\/company-invite\/['"]\)/);
    assert.match(signIn, /user && !isPropertyIndependentCompanyTarget/);
    assert.match(verify, /const isPropertyIndependentCompanyTarget/);
    assert.match(verify, /requestedTarget\.startsWith\(['"]\/company-invite\/['"]\)/);
    assert.match(verify, /isPropertyIndependentCompanyTarget\s*\? requestedTarget/);
  });

  test('the bypass remains narrow and all other deep links still select a hotel', () => {
    const targetBlock = signIn.match(/const isPropertyIndependentCompanyTarget[\s\S]*?const needsPropertySelection/)?.[0] ?? '';
    assert.doesNotMatch(targetBlock, /\/settings|\/inventory|\/home|\/admin/);
    assert.match(signIn, /user\.propertyAccess\.includes\(['"]\*['"]\)/);
    assert.match(signIn, /user\.propertyAccess\.length !== 1/);
  });

  test('raw invitation tokens are handed through storage instead of copied into OTP URLs', () => {
    assert.match(signIn, /companyInvitationTokenFromPath\(ordinaryRequestedTarget\)/);
    assert.match(signIn, /storeCompanyInvitationHandoff\(legacyInvitationToken\)/);
    assert.match(signIn, /usesCompanyInvitationHandoff[\s\S]*COMPANY_INVITATION_HANDOFF_PARAM[\s\S]*: rawRedirect \? `&redirect=/);
    assert.match(verify, /companyInvitationTokenFromPath\(ordinaryRequestedTarget\)/);
    assert.match(verify, /readCompanyInvitationHandoff\(\)/);
    assert.match(verify, /COMPANY_INVITATION_SIGN_IN_HREF/);
  });

  test('later zero-hotel sign-ins route active company members back to Company Hub', () => {
    assert.match(propertySelector, /fetchWithAuth\(['"]\/api\/company-access['"]\)/);
    assert.match(propertySelector, /organization\.type !== ['"]single_hotel['"]/);
    assert.match(propertySelector, /router\.replace\(['"]\/company['"]\)/);
    assert.match(propertySelector, /companyRouteChecked/);
    assert.match(propertySelector, /JoinStatusGate/);
  });
});
