import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

const shell = source('src', 'app', 'admin', '_components', 'studio', 'StudioShell.tsx');
const onboarding = source('src', 'app', 'admin', '_components', 'studio', 'surfaces', 'OnboardingSurface.tsx');
const mission = source('src', 'app', 'admin', '_components', 'studio', 'surfaces', 'MissionControlSurface.tsx');
const hotels = source('src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx');
const property = source('src', 'app', 'admin', 'properties', '[id]', 'page.tsx');

describe('retired PMS robot is absent from reachable Admin UI', () => {
  test('does not pre-mount hidden Admin surfaces or show the robot jobs stat', () => {
    assert.doesNotMatch(
      shell,
      /setMounted\(new Set<StudioTab>\(\['onboarding', 'live', 'system', 'money', 'ml'\]\)\)/,
    );
    assert.match(shell, /PMS_ROBOT_ENABLED[\s\S]*label: 'Jobs'/);
  });

  test('does not fetch or render PMS mapping controls during normal onboarding', () => {
    assert.match(
      onboarding,
      /PMS_ROBOT_ENABLED \? fetchWithAuth\('\/api\/admin\/pms-coverage'\) : Promise\.resolve\(null\)/,
    );
    assert.match(onboarding, /\{PMS_ROBOT_ENABLED && <div>[\s\S]*PMS maps/);
    assert.match(onboarding, /PMS_ROBOT_ENABLED && <MapsManagerModal/);
    assert.match(
      onboarding,
      /CHECKLIST\.filter\(\(c\) => PMS_ROBOT_ENABLED \|\| c\.key !== 'pmsCredsCollected'\)/,
    );
  });

  test('does not fetch or expose robot sessions and actions in Mission Control', () => {
    assert.match(
      mission,
      /PMS_ROBOT_ENABLED \? fetchWithAuth\('\/api\/admin\/cua-sessions'\) : Promise\.resolve\(null\)/,
    );
    assert.match(
      mission,
      /PMS_ROBOT_ENABLED \? fetchWithAuth\('\/api\/admin\/mission\/inbox'\) : Promise\.resolve\(null\)/,
    );
    assert.match(mission, /if \(!PMS_ROBOT_ENABLED \|\| busyKey\) return/);
    assert.match(mission, /\{PMS_ROBOT_ENABLED && <HealthLight[^>]*label="Robots"/);
    assert.match(mission, /groups\.filter\(\(group\) => !isRetiredRobotError\(group\)\)/);
  });

  test('keeps hotel administration while hiding robot connection and recipe controls', () => {
    assert.match(hotels, /const STATUS_OPTS:[\s\S]*PMS_ROBOT_ENABLED/);
    assert.match(hotels, /\{PMS_ROBOT_ENABLED && <span className="mono" style=\{\{ color: syncColor\(h\) \}\}>/);
    assert.match(hotels, /\{PMS_ROBOT_ENABLED && pickerHotel && \(/);
    assert.match(property, /\{PMS_ROBOT_ENABLED && <DetailCard title="PMS">/);
    assert.match(property, /if \(!PMS_ROBOT_ENABLED\) return/);
  });
});

describe('retired robot-only Admin routes fail closed', () => {
  for (const route of [
    ['properties', 'mapper'],
    ['properties', 'coverage'],
    ['mfa-resume'],
    ['pms-inbox'],
  ]) {
    test(`gates /admin/${route.join('/')}`, () => {
      const layout = source('src', 'app', 'admin', ...route, 'layout.tsx');
      assert.match(layout, /if \(!PMS_ROBOT_ENABLED\) notFound\(\)/);
    });
  }
});
