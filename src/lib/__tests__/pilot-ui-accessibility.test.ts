import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

test('Staff pilot dialogs share a real focus trap with Escape and focus restoration', () => {
  const hook = source('src/app/staff/_components/useStaffDialog.ts');
  assert.match(hook, /event\.key === 'Escape'/);
  assert.match(hook, /event\.key !== 'Tab'/);
  assert.match(hook, /returnTarget/);
  assert.match(hook, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(hook, /data-dialog-initial-focus/);
  assert.match(hook, /document\.addEventListener\('keydown', onKeyDown, true\)/);

  for (const path of [
    'src/app/staff/_components/MyShifts.tsx',
    'src/app/staff/_components/schedule/AddStaffModal.tsx',
    'src/app/staff/_components/schedule/ShiftEditorModal.tsx',
    'src/app/staff/_components/schedule/TimeOffModal.tsx',
    'src/app/staff/_components/schedule/FillModal.tsx',
  ]) {
    const ui = source(path);
    assert.match(ui, /useStaffDialog\(/, `${path} must use the shared dialog behavior`);
    assert.match(ui, /aria-modal="true"/, `${path} must expose modal semantics`);
    assert.match(ui, /aria-labelledby=/, `${path} must expose an accessible title`);
  }
});

test('Staff pilot modal controls keep labels, live feedback, and touch targets', () => {
  const shiftEditor = source('src/app/staff/_components/schedule/ShiftEditorModal.tsx');
  const timeOff = source('src/app/staff/_components/MyShifts.tsx');
  const dialogCss = source('src/app/staff/_components/StaffDialog.module.css');
  const schedule = source('src/app/staff/_components/schedule/index.tsx');
  // The person editor moved from Staff → Directory to My Hotel → People on
  // 2026-07-27. The linked-login picker is the control an hourly worker's
  // My Shifts page depends on, so its described-by hint has to survive the move.
  const employmentForm = source('src/app/company/_components/PersonEmploymentForm.tsx');

  assert.match(employmentForm, /<label className=\{styles\.field\} htmlFor=\{loginId\}>/);
  assert.match(employmentForm, /aria-describedby=\{loginHintId\}/);
  assert.match(employmentForm, /<small id=\{loginHintId\}>/);
  assert.match(shiftEditor, /aria-invalid=\{errorMsg \? true : undefined\}/);
  assert.match(timeOff, /aria-busy=\{busy\}/);
  assert.match(dialogCss, /min-width: 44px !important/);
  assert.match(dialogCss, /min-height: 44px !important/);
  assert.match(schedule, /role="status" aria-live="polite" aria-atomic="true"/);
});

// Staff lost its sub-tab bar when the Directory was folded into My Hotel —
// Schedule is the only manager surface there now, so a one-item tablist would
// be noise. The keyboard tab-pattern invariant this used to guard still matters;
// it just lives on the tab bar that survived, in My Hotel.
test('My Hotel tabs support the complete keyboard tab pattern', () => {
  const page = source('src/app/company/page.tsx');
  assert.match(page, /role="tablist"/);
  assert.match(page, /event\.key === 'ArrowRight'/);
  assert.match(page, /event\.key === 'ArrowLeft'/);
  assert.match(page, /event\.key === 'Home'/);
  assert.match(page, /event\.key === 'End'/);
  assert.match(page, /aria-controls=\{`company-panel-\$\{item\.id\}`\}/);
  assert.match(page, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(page, /role="tabpanel"\s*\n\s*aria-labelledby=\{`company-tab-\$\{tab\}`\}/);
});

test('Staff renders the schedule directly, with no leftover Directory tab', () => {
  const page = source('src/app/(hotel)/staff/page.tsx');
  assert.doesNotMatch(page, /SubTabBar|ManagerDirectory|staxis-staff-tab/);
  assert.doesNotMatch(page, /staff-tab-directory|staff-panel-directory/);
  assert.match(page, /<UnifiedSchedule/);
});

test('Inventory dialogs preserve cancellation and restore the opening focus target', () => {
  const confirm = source('src/app/inventory/_components/ConfirmDialog.tsx');
  const overlay = source('src/app/inventory/_components/overlays/Overlay.tsx');

  assert.doesNotMatch(confirm, /e\.key === 'Enter'/);
  assert.match(confirm, /role=\{danger \? 'alertdialog' : 'dialog'\}/);
  assert.match(confirm, /if \(!danger && e\.target === e\.currentTarget\) onCancel\(\)/);
  assert.match(overlay, /returnTarget\?\.isConnected/);
  assert.match(overlay, /requestAnimationFrame\(\(\) => returnTarget\.focus/);
  assert.match(overlay, /width: 44/);
  assert.match(overlay, /height: 44/);
});
