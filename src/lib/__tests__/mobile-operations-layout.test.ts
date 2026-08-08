import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

test('phone operations keep the assistant clear and contain dense hotel boards', () => {
  const layout = source('src', 'components', 'layout', 'AppLayout.tsx');
  const ask = source('src', 'components', 'agent', 'AskStaxisBar.tsx');
  const mobileNav = source('src', 'components', 'concourse', 'MobileConcourseNav.tsx');
  const mobileNavCss = source('src', 'components', 'concourse', 'MobileConcourseNav.module.css');
  const css = source('src', 'app', 'globals.css');
  const housekeepingBoard = source('src', 'app', 'housekeeping', '_components', 'ScheduleBoard.tsx');
  const quality = source('src', 'app', 'housekeeping', '_components', 'QualityTab.tsx');
  const dayBoard = source('src', 'app', 'staff', '_components', 'schedule', 'DayBoard.tsx');
  const weekRoster = source('src', 'app', 'staff', '_components', 'schedule', 'WeekRoster.tsx');
  const schedule = source('src', 'app', 'staff', '_components', 'schedule', 'index.tsx');
  const shiftEditor = source('src', 'app', 'staff', '_components', 'schedule', 'ShiftEditorModal.tsx');
  const staffDialogCss = source('src', 'app', 'staff', '_components', 'StaffDialog.module.css');

  assert.match(layout, /<main className="cx-swap"/);
  assert.doesNotMatch(layout, /data-staxis-main/);
  assert.match(ask, /className=\{`asx-mobile-fab asx-mobile-fab-docked[\s\S]*?asx-mobile-fab-open/);
  assert.match(ask, /createPortal\([\s\S]*?mobileAskSlot/);
  assert.match(ask, /\.asx-mobile-fab\.asx-mobile-fab-docked\{position:static;top:auto;right:auto;bottom:auto;/);
  assert.match(ask, /\.asx-mobile-fab\.asx-mobile-fab-docked\.asx-mobile-fab-open\{visibility:hidden;/);
  assert.match(mobileNav, /data-staxis-mobile-ask-slot/);
  assert.match(mobileNavCss, /grid-template-columns: 40px minmax\(0, 1fr\) 44px 40px/);

  assert.match(housekeepingBoard, /className="hk-schedule-board-row"/);
  assert.match(housekeepingBoard, /className="hk-schedule-board-chip"/);
  assert.match(css, /\.hk-schedule-board-row[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.hk-schedule-board-row \.hk-chiprow[\s\S]*?touch-action: pan-x/);

  assert.match(quality, /className="hk-quality-board"/);
  assert.match(quality, /className="hk-quality-range-option"/);
  assert.match(quality, /className="hk-quality-severity-group"/);
  assert.match(quality, /className="hk-quality-severity-button"/);
  assert.match(css, /\.hk-quality-board[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.hk-quality-filter[\s\S]*?min-height: 44px/);
  assert.match(css, /\.hk-quality-severity-group[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.hk-quality-severity-button[\s\S]*?min-width: 44px[\s\S]*?height: 44px/);
  assert.match(css, /\.hk-quality-photo-label[\s\S]*?min-height: 44px/);

  assert.match(dayBoard, /className="staff-day-board-scroll"/);
  assert.match(weekRoster, /className="staff-week-roster-scroll"/);
  assert.match(schedule, /className="staff-schedule-view-toggle"/);
  assert.match(css, /\.staff-day-board-scroll[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.staff-week-roster-scroll[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.staff-day-board-shift-block,[\s\S]*?min-width: 44px !important/);
  assert.match(css, /\.staff-schedule-shell \.stx-ui-button[\s\S]*?min-height: 44px/);
  assert.match(css, /\.stx-snow-button[\s\S]*?min-width: 44px/);
  assert.match(shiftEditor, /from '\.\.\/StaffDialog\.module\.css'/);
  assert.match(staffDialogCss, /:is\(button, \[role='button'\], a\[href\]\)[\s\S]*?min-height: 44px !important/);
});
