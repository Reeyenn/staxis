import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isStaffVisibleScheduleStatus } from '../../app/staff/_components/staff-shift-visibility';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Inventory and Staff pilot hardening', () => {
  test('staff-facing shift visibility follows canonical row status', () => {
    assert.equal(isStaffVisibleScheduleStatus('published'), true);
    assert.equal(isStaffVisibleScheduleStatus('sent'), true);
    assert.equal(isStaffVisibleScheduleStatus('confirmed'), true);
    assert.equal(isStaffVisibleScheduleStatus('draft'), false);
    assert.equal(isStaffVisibleScheduleStatus('declined'), false);

    const myShifts = source('src/app/staff/_components/MyShifts.tsx');
    assert.match(myShifts, /isStaffVisibleScheduleStatus\(c\.shift\.status\)/);
    assert.doesNotMatch(myShifts, /publishedDates\.has/);
  });

  test('manager Staff surfaces wait for exact property capabilities and gate each tab', () => {
    const page = source('src/app/staff/page.tsx');
    assert.match(page, /capabilityOverridesPropertyId === activePropertyId/);
    assert.match(page, /capabilityOverridesViewerKey === capabilityViewerKey/);
    assert.match(page, /const canManageSchedule = isManager && can\('manage_shifts'\)/);
    assert.match(page, /const canManageDirectory = isManager && can\('manage_team'\)/);
    assert.match(page, /availableTabs=\{availableTabs\}/);
    assert.match(page, /onOpenDirectory=\{canManageDirectory/);
  });

  test('Staff schedule reads honor the Staff section before querying data', () => {
    for (const [path, table] of [
      ['src/app/api/staff-schedule/presets/route.ts', "from('property_shift_presets')"],
      ['src/app/api/staff-schedule/templates/route.ts', "from('schedule_templates')"],
      ['src/app/api/staff-schedule/week-done/route.ts', "from('schedule_week_signoffs')"],
    ] as const) {
      const route = source(path);
      const gate = route.indexOf("requireSectionEnabled(req,");
      const query = route.indexOf(table);
      assert.ok(gate >= 0 && query > gate, `${path} must section-gate GET before its first query`);
      assert.match(route.slice(gate, query), /'staff'/);
    }
  });

  test('both Staff realtime loaders time out instead of hanging forever', () => {
    for (const path of [
      'src/app/staff/_components/useWeekShifts.ts',
      'src/app/staff/_components/schedule/useScheduleData.ts',
    ]) {
      const hook = source(path);
      assert.match(hook, /INITIAL_SNAPSHOT_TIMEOUT_MS = 8_000/);
      assert.match(hook, /timeoutId = setTimeout\(fail, INITIAL_SNAPSHOT_TIMEOUT_MS\)/);
      assert.match(hook, /cancelled = true;[\s\S]*clearTimeout\(timeoutId\)/);
    }
  });

  test('My Shifts loads only data it renders', () => {
    const hook = source('src/app/staff/_components/useWeekShifts.ts');
    assert.doesNotMatch(hook, /subscribeToWeekPublications/);
    assert.doesNotMatch(hook, /subscribeToShiftPresets/);
    assert.match(hook, /new Set\(\['shifts', 'tor'\]\)/);
  });

  test('Inventory tab configuration failures are visible and rollback failed layouts', () => {
    const shell = source('src/app/inventory/_components/InventoryShell.tsx');
    assert.match(shell, /layoutSaveChainRef\.current\.catch\(\(\) => \{\}\)\.then\(save\)/);
    assert.match(shell, /setTabLayout\(fallback\)/);
    assert.match(shell, /The previous layout was restored/);
    assert.match(shell, /if \(!await deleteCustomCategory\(id\)\) return/);
    assert.match(shell, /\{inventoryConfigError && \([\s\S]*role="alert"/);
  });
});
