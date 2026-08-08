import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const workOrdersDb = readFileSync(join(process.cwd(), 'src/lib/db/work-orders.ts'), 'utf8');
const preventiveDb = readFileSync(join(process.cwd(), 'src/lib/db/preventive.ts'), 'utf8');
const workOrdersTab = readFileSync(join(process.cwd(), 'src/app/maintenance/_components/WorkOrdersTab.tsx'), 'utf8');
const preventiveTab = readFileSync(join(process.cwd(), 'src/app/maintenance/_components/PreventiveTab.tsx'), 'utf8');
const equipmentTab = readFileSync(join(process.cwd(), 'src/app/maintenance/_components/EquipmentTab.tsx'), 'utf8');

test('work orders query the live board first and load settled history on demand', () => {
  assert.match(workOrdersDb, /status\.is\.null,status\.not\.in\.\(resolved,closed\)/);
  assert.match(workOrdersDb, /export async function listWorkOrderHistory/);
  assert.match(workOrdersDb, /\.in\('status', \['resolved', 'closed'\]\)/);
  assert.match(workOrdersTab, /listWorkOrderHistory\(user\.uid, propertyId\)/);
  assert.match(workOrdersTab, /historyStatus === 'ready' \? history\.length : null/);
  assert.match(workOrdersTab, /status === 'loading'/);
  assert.match(workOrdersTab, /status === 'error'/);
  assert.match(workOrdersTab, /const \[historyReload, setHistoryReload\] = useState\(0\)/);
  assert.match(workOrdersTab, /setHistoryReload\(\(revision\) => revision \+ 1\)/);
  assert.doesNotMatch(workOrdersTab, /const retryHistory[\s\S]*?setTimeout/);
});

test('maintenance initial fetch errors reach the visible tabs immediately', () => {
  assert.match(workOrdersDb, /onError\?: \(error: unknown\) => void/);
  assert.match(preventiveDb, /onError\?: \(error: unknown\) => void/);
  assert.match(workOrdersTab, /setLoadError\(true\)/);
  assert.match(preventiveTab, /setLoadError\(true\)/);
  assert.match(equipmentTab, /setLoadError\(true\)/);
  assert.match(workOrdersTab, /loadError \|\| gate\.status === 'error'/);
  assert.match(preventiveTab, /loadError \|\| gate\.status === 'error'/);
  assert.match(equipmentTab, /loadError \|\| gate\.status === 'error'/);
  for (const tab of [workOrdersTab, preventiveTab, equipmentTab]) {
    assert.match(tab, /const boardReady = loaded && !loadError/);
    assert.match(tab, /const boardUnavailable = loadError \|\| gate\.status === 'error'/);
    assert.match(tab, /lead=\{boardUnavailable \?\s*'Unavailable' : boardReady\s*\?/);
    assert.match(tab, /rest=\{boardUnavailable \? '[^']+ unavailable' : boardReady\s*\?/);
  }
});

test('maintenance board keeps property and realtime cleanup guards', () => {
  assert.match(workOrdersTab, /setOrders\(\[\]\)/);
  assert.match(workOrdersTab, /activePropertyId !== propertyId/);
  assert.match(workOrdersTab, /return \(\) => unsub\(\)/);
  assert.match(workOrdersDb, /`work_orders:\$\{pid\}`/);
});
