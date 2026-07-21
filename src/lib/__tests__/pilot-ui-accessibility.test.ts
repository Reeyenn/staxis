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
    'src/app/staff/_components/ManagerDirectory.tsx',
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
  const directory = source('src/app/staff/_components/ManagerDirectory.tsx');
  const shiftEditor = source('src/app/staff/_components/schedule/ShiftEditorModal.tsx');
  const timeOff = source('src/app/staff/_components/MyShifts.tsx');
  const dialogCss = source('src/app/staff/_components/StaffDialog.module.css');
  const schedule = source('src/app/staff/_components/schedule/index.tsx');

  assert.match(directory, /<label htmlFor=\{controlId\}/);
  assert.match(directory, /aria-describedby=\{loginHintId\}/);
  assert.match(shiftEditor, /aria-invalid=\{errorMsg \? true : undefined\}/);
  assert.match(timeOff, /aria-busy=\{busy\}/);
  assert.match(dialogCss, /min-width: 44px !important/);
  assert.match(dialogCss, /min-height: 44px !important/);
  assert.match(schedule, /role="status" aria-live="polite" aria-atomic="true"/);
});

test('Staff tabs support the complete keyboard tab pattern', () => {
  const tabs = source('src/app/staff/_components/SubTabBar.tsx');
  const page = source('src/app/staff/page.tsx');
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /event\.key === 'ArrowRight'/);
  assert.match(tabs, /event\.key === 'ArrowLeft'/);
  assert.match(tabs, /aria-controls=\{`staff-panel-/);
  assert.match(tabs, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(page, /role="tabpanel" aria-labelledby="staff-tab-schedule"/);
  assert.match(page, /role="tabpanel" aria-labelledby="staff-tab-directory"/);
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
