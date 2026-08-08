import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

test('phone operations keep the assistant clear and contain dense hotel boards', () => {
  const layout = source('src', 'components', 'layout', 'AppLayout.tsx');
  const ask = source('src', 'components', 'agent', 'AskStaxisBar.tsx');
  const css = source('src', 'app', 'globals.css');
  const housekeepingBoard = source('src', 'app', 'housekeeping', '_components', 'ScheduleBoard.tsx');
  const quality = source('src', 'app', 'housekeeping', '_components', 'QualityTab.tsx');
  const dayBoard = source('src', 'app', 'staff', '_components', 'schedule', 'DayBoard.tsx');
  const weekRoster = source('src', 'app', 'staff', '_components', 'schedule', 'WeekRoster.tsx');
  const schedule = source('src', 'app', 'staff', '_components', 'schedule', 'index.tsx');

  assert.match(layout, /<main className="cx-swap"/);
  assert.doesNotMatch(layout, /data-staxis-main/);
  assert.match(ask, /className=\{`asx-mobile-fab asx-mobile-fab-docked[\s\S]*?asx-mobile-fab-open/);
  assert.match(ask, /\.asx-mobile-fab\.asx-mobile-fab-docked\{top:max\(6px,env\(safe-area-inset-top/);
  assert.match(ask, /\.asx-mobile-fab\.asx-mobile-fab-docked\.asx-mobile-fab-open\{visibility:hidden;/);

  assert.match(housekeepingBoard, /className="hk-schedule-board-row"/);
  assert.match(housekeepingBoard, /className="hk-schedule-board-chip"/);
  assert.match(css, /\.hk-schedule-board-row[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.hk-schedule-board-row \.hk-chiprow[\s\S]*?touch-action: pan-x/);

  assert.match(quality, /className="hk-quality-board"/);
  assert.match(quality, /className="hk-quality-range-option"/);
  assert.match(css, /\.hk-quality-board[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.hk-quality-filter[\s\S]*?min-height: 44px/);

  assert.match(dayBoard, /className="staff-day-board-scroll"/);
  assert.match(weekRoster, /className="staff-week-roster-scroll"/);
  assert.match(schedule, /className="staff-schedule-view-toggle"/);
  assert.match(css, /\.staff-day-board-scroll[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.staff-week-roster-scroll[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.staff-schedule-shell \.stx-ui-button[\s\S]*?min-height: 44px/);
  assert.match(css, /\.stx-snow-button[\s\S]*?min-width: 44px/);
});
