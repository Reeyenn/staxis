import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');
const between = (source: string, start: string, end: string) => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
};

const customerPage = read('src', 'app', 'onboard', 'page.tsx');
const adminJourney = read(
  'src', 'app', 'admin', '_components', 'studio', 'surfaces', 'OnboardingSurface.tsx',
);
const hotelCreate = read('src', 'app', 'api', 'admin', 'properties', 'create', 'route.ts');
const onboardingDetail = read('src', 'app', 'api', 'admin', 'onboarding-detail', 'route.ts');
const wizardRoute = read('src', 'app', 'api', 'onboard', 'wizard', 'route.ts');
const resumeRoute = read('src', 'app', 'api', 'onboard', 'resume', 'route.ts');

describe('shortened first-person onboarding UI contract', () => {
  test('customer wizard renders the exact six requested stages', () => {
    assert.match(
      customerPage,
      /const STEP_LABELS = \[\s*'Welcome', 'Account', 'Verify email', 'About hotel', 'Your hotel', 'Done',?\s*\]/,
    );
    assert.match(
      customerPage,
      /displayStep === 1[\s\S]*displayStep === 2[\s\S]*displayStep === 3[\s\S]*displayStep === 4[\s\S]*displayStep === 5[\s\S]*displayStep === 6/,
    );
    assert.doesNotMatch(customerPage, /Step(?:7|8|9|10)|Connect PMS|mapping-status|Add team/i);
    assert.doesNotMatch(
      customerPage,
      /pmsCredentialsAt|pmsJobId|mappingCompletedAt|pmsSkippedAt|staffAt/,
    );
  });

  test('assigned role and invited email are display-only account inputs', () => {
    const accountStep = between(customerPage, 'function Step2CreateAccount', 'function Step2AccountReview');
    assert.match(accountStep, /<Field label="Assigned role">/);
    assert.match(accountStep, /wizard\.inviteRole === 'general_manager' \? 'General Manager' : 'Owner'/);
    assert.match(accountStep, /wizard\.invitedEmail\?\.trim\(\)\.toLowerCase\(\)/);
    assert.match(accountStep, /type="email" value=\{email\} readOnly aria-readonly="true"/);
    assert.match(
      accountStep,
      /JSON\.stringify\(\{ code, email, displayName, password, phone \}\)/,
    );
    assert.doesNotMatch(accountStep, /JSON\.stringify\([^)]*role/);
  });

  test('reopened email verification requires a fresh tab-scoped OTP context', () => {
    const verifyStep = between(customerPage, 'function Step3VerifyEmail', '// ─── Step 4: Hotel details');
    assert.match(verifyStep, /const invitedEmail = wizard\.invitedEmail\?\.trim\(\)\.toLowerCase\(\) \?\? ''/);
    assert.match(
      verifyStep,
      /sessionStorage\.getItem\('onboard:pendingEmail'\)\?\.trim\(\)\.toLowerCase\(\) \?\? ''/,
    );
    assert.doesNotMatch(verifyStep, /getItem\('onboard:pendingEmail'\)[^;]*wizard\.invitedEmail/);
    assert.match(verifyStep, /const recovered = !pendingEmail/);
    assert.match(verifyStep, /verifyOtp\(\{ email: pendingEmail/);
  });

  test('completion and resume stay bound to durable six-stage server state', () => {
    const finalizeGuard = wizardRoute.indexOf(
      'body.finalize === true && mergedState.step !== 6',
    );
    const propertyWrite = wizardRoute.indexOf(".update(update)", finalizeGuard);
    assert.notEqual(finalizeGuard, -1);
    assert.notEqual(propertyWrite, -1);
    assert.ok(finalizeGuard < propertyWrite, 'premature completion must fail before the property write');

    assert.match(
      resumeRoute,
      /state\?\.firstPersonAccountId\s*\?\s*state\.firstPersonAccountId === accountId/,
    );
    assert.match(
      resumeRoute,
      /stampQuery = stampQuery\.eq\('onboarding_state->>firstPersonAccountId', accountId\)/,
    );
  });
});

describe('Admin Live Journey stays synchronized with the customer wizard', () => {
  test('uses the matching six stages without the removed launcher or stage dependencies', () => {
    assert.match(
      adminJourney,
      /const STEP_LABELS = \['Welcome', 'Account', 'Verify email', 'About hotel', 'Your hotel', 'Done'\] as const/,
    );
    assert.doesNotMatch(adminJourney, /CreateHotelModal/);

    const propertyShape = between(adminJourney, 'interface PropertyRow', 'type ProspectStatus');
    assert.doesNotMatch(propertyShape, /session|pms|mapping|team|job/i);

    const stageLogic = between(adminJourney, 'function journeyOf', '// Timeline row layout');
    assert.match(stageLogic, /accountCreatedAt/);
    assert.match(stageLogic, /emailVerifiedAt/);
    assert.match(stageLogic, /hotelDetailsAt/);
    assert.match(stageLogic, /hotelContextAt/);
    assert.doesNotMatch(stageLogic, /session|pms|mapping|team|job/i);
  });

  test('new shells start at Welcome while only exact markerless legacy rows are live', () => {
    assert.match(hotelCreate, /onboarding_state:\s*\{\s*step:\s*1\s*\}/);
    const liveLogic = between(adminJourney, 'function isLive', '// Position the hotel');
    assert.match(liveLogic, /if \(p\.onboardingCompletedAt\) return true/);
    assert.match(liveLogic, /Object\.keys\(p\.onboardingState\)\.length === 0/);
    assert.doesNotMatch(liveLogic, /session|pms|mapping|team|job/i);
  });

  test('expanded detail resolves the exact bound first person, not a hotel session or team roster', () => {
    assert.match(onboardingDetail, /onboardingState\?\.firstPersonAccountId/);
    assert.match(onboardingDetail, /\.eq\('id', firstPersonAccountId\)/);
    assert.match(
      onboardingDetail,
      /!firstPersonAccountId && onboardingState\?\.accountCreatedAt[\s\S]*\? prop\.owner_id/,
    );
    assert.doesNotMatch(
      onboardingDetail,
      /property_sessions|workflow_jobs|pms_mapping|staff|team_members|property_services/,
    );
  });
});
