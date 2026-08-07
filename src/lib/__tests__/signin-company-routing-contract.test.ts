import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const signIn = readFileSync(join(process.cwd(), 'src/app/(public)/signin/page.tsx'), 'utf8');
const verify = readFileSync(join(process.cwd(), 'src/app/(public)/signin/verify/page.tsx'), 'utf8');
const propertySelector = readFileSync(join(process.cwd(), 'src/app/(hotel)/property-selector/page.tsx'), 'utf8');
const signInNavigationPolicy = readFileSync(
  join(process.cwd(), 'src/lib/auth/signin-navigation-policy.ts'),
  'utf8',
);

describe('signin property-independent Company routing', () => {
  test('zero-property accounts may finish a company invitation or open Company Hub', () => {
    assert.match(signIn, /requestedTarget === ['"]\/company['"]/);
    assert.match(signIn, /propertyIndependent: isPropertyIndependentCompanyTarget/);
    assert.match(signInNavigationPolicy, /input\.user[\s\S]*?!input\.propertyIndependent/);
    assert.match(verify, /const isPropertyIndependentCompanyTarget/);
    assert.match(verify, /isPropertyIndependentCompanyTarget\s*\? requestedTarget/);
  });

  test('the bypass remains narrow and all other deep links still select a hotel', () => {
    const targetBlock = signIn.match(/const isPropertyIndependentCompanyTarget[\s\S]*?const redirectTarget/)?.[0] ?? '';
    assert.doesNotMatch(targetBlock, /\/settings|\/inventory|\/home|\/admin/);
    assert.match(signInNavigationPolicy, /input\.user\.propertyAccess\.includes\(['"]\*['"]\)/);
    assert.match(signInNavigationPolicy, /input\.user\.propertyAccess\.length !== 1/);
  });

  // The second invitation system is retired. Nothing parks a token in storage
  // any more, so the OTP URL carries only an ordinary redirect and must never
  // grow an invitation token back into it.
  test('the OTP URL carries only an ordinary redirect', () => {
    assert.match(signIn, /\/signin\/verify\?email=\$\{encodeURIComponent\(normalizedEmail\)\}/);
    // Name the retired machinery exactly. A blanket /invitation/i would also
    // match the comment explaining why it is gone, which is prose, not a wire.
    for (const page of [signIn, verify]) {
      assert.doesNotMatch(page, /companyInvitationTokenFromPath/);
      assert.doesNotMatch(page, /CompanyInvitationHandoff/);
      assert.doesNotMatch(page, /COMPANY_INVITATION_/);
      assert.doesNotMatch(page, /usesCompanyInvitationHandoff/);
    }
  });

  test('later zero-hotel sign-ins route active company members back to Company Hub', () => {
    assert.match(propertySelector, /fetchWithAuth\(['"]\/api\/company-access['"]\)/);
    assert.match(propertySelector, /organization\.type !== ['"]single_hotel['"]/);
    assert.match(propertySelector, /replaceNavigation\(['"]\/company['"]\)/);
    assert.match(propertySelector, /companyRouteChecked/);
    assert.match(propertySelector, /JoinStatusGate/);
  });
});
