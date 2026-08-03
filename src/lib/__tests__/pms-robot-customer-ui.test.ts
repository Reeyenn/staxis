import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';

function source(...segments: string[]): string {
  return readFileSync(resolve(process.cwd(), ...segments), 'utf8');
}

describe('retired PMS robot customer UI', () => {
  test('the shared robot flag remains off for surviving report-era gates', () => {
    assert.equal(PMS_ROBOT_ENABLED, false);
  });

  test('the active onboarding wizard has no PMS robot calls or mapping steps', () => {
    const onboarding = source('src', 'app', '(public)', 'onboard', 'page.tsx');

    assert.doesNotMatch(onboarding, /\/api\/pms\//);
    assert.doesNotMatch(onboarding, /mapping-status|save-credentials|job-status/);
    assert.match(
      onboarding,
      /const STEP_LABELS = \[\s*'Welcome', 'Account', 'Verify email', 'About hotel', 'Your hotel', 'Done',\s*\]/,
    );
  });

  test('the marketing preview cannot run the retired ticking robot experience', () => {
    const marketing = source('src', 'app', '_components', 'MarketingLanding.tsx');
    const landing = source('src', 'app', '(public)', 'page.tsx');

    assert.match(marketing, /if \(!PMS_ROBOT_ENABLED \|\| reduced\) return;/);
    assert.match(marketing, /PMS_ROBOT_ENABLED \? 'LATEST PMS PULL ⚙' : 'LATEST PMS DATA'/);
    assert.match(marketing, /PMS_ROBOT_ENABLED \? 'ALWAYS WATCHING' : 'LATEST DAILY VIEW'/);
    assert.match(marketing, /PMS_ROBOT_ENABLED \? 'WATCHING · 24\/7' : 'LATEST OPERATIONS DATA'/);
    assert.doesNotMatch(landing, /watches your property systems around the clock/i);
  });

  test('operational surfaces use report-neutral data availability copy', () => {
    const operationalCopy = [
      source('src', 'app', '(hotel)', 'dashboard', 'page.tsx'),
      source('src', 'app', 'housekeeping', '_components', 'ScheduleTab.tsx'),
      source('src', 'app', 'housekeeping', '_components', 'QualityTab.tsx'),
      source('src', 'app', '(staff-link)', 'housekeeper', '[id]', 'page.tsx'),
      source('src', 'app', '(staff-link)', 'laundry', '[id]', 'page.tsx'),
    ].join('\n');

    assert.doesNotMatch(
      operationalCopy,
      /Latest PMS pull|next PMS pull|Connecting to your PMS|learning from your PMS|Still learning your PMS|finishes syncing|still syncing/i,
    );
    assert.match(operationalCopy, /Latest PMS data/);
    assert.match(operationalCopy, /waiting for PMS data/i);
    assert.match(operationalCopy, /PMS data is available/i);
  });

  test('the data-availability status dot is static, not an active-sync pulse', () => {
    const banner = source('src', 'components', 'FeedLearningBanner.tsx');

    assert.doesNotMatch(banner, /feedLearningPulse|@keyframes/);
    assert.match(banner, /function StatusDot/);
  });
});
