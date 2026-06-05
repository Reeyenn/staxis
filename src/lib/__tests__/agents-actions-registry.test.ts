// Action registry — built-ins register; flags + approval floors correct;
// tree-shaking guard (importing the index actually populates the registry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@/lib/agents/actions'; // populate the registry
import { getAction, listActionMeta, actionApprovalFloor } from '@/lib/agents/actions/registry';

test('the two v1 actions and the declared stubs are registered', () => {
  for (const key of ['assign_rooms', 'notify_manager', 'send_staff_sms', 'create_work_order', 'create_complaint', 'draft_purchase_order', 'message_guest']) {
    assert.ok(getAction(key), `action ${key} should be registered`);
  }
});

test('importing the catalog populates the registry (tree-shaking guard)', () => {
  assert.ok(getAction('assign_rooms'), 'assign_rooms must survive bundling');
});

test('flags + approval floors are correct', () => {
  assert.equal(getAction('notify_manager')!.spendsMoney, false);
  assert.equal(getAction('notify_manager')!.contactsGuest, false);
  assert.equal(actionApprovalFloor(getAction('notify_manager')!), 'suggest');

  assert.equal(getAction('send_staff_sms')!.spendsMoney, true);
  assert.equal(actionApprovalFloor(getAction('send_staff_sms')!), 'approve_first');

  assert.equal(getAction('message_guest')!.contactsGuest, true);
  assert.equal(actionApprovalFloor(getAction('message_guest')!), 'approve_first');

  assert.equal(getAction('draft_purchase_order')!.spendsMoney, true);
  assert.equal(actionApprovalFloor(getAction('draft_purchase_order')!), 'approve_first');
});

test('listActionMeta exposes a stable shape for the wizard', () => {
  const meta = listActionMeta();
  const notify = meta.find((m) => m.key === 'notify_manager');
  assert.ok(notify);
  assert.ok(notify!.label.en && notify!.label.es, 'bilingual label');
  assert.ok(notify!.inputSchema);
  assert.ok(['suggest', 'approve_first', 'auto'].includes(notify!.approvalFloor));
});

test('notify_manager validates its payload', () => {
  const def = getAction('notify_manager')!;
  assert.ok(def.validate({ message: 'hi' }).value);
  assert.ok(def.validate({}).error, 'message is required');
});
