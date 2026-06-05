// Config — migrateConfig normalizes + drops unknown action keys, never throws;
// validateAgentConfig is strict for the API write path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig, validateAgentConfig } from '@/lib/agents/config-validate';

test('migrateConfig on empty input returns a structurally valid, never-firing default', () => {
  const c = migrateConfig({});
  assert.equal(c.version, 1);
  assert.equal(c.trigger.type, 'schedule');
  assert.deepEqual(c.actions, []);
  assert.deepEqual(c.scopes, []);
  assert.equal(c.approvalRules.moneyOrGuestRequiresApproval, true);
  assert.equal(c.approvalRules.defaultMode, 'suggest');
});

test('migrateConfig drops unknown action + scope keys, keeps real ones', () => {
  const c = migrateConfig({
    trigger: { type: 'schedule', atLocalTime: '08:00' },
    actions: ['notify_manager', 'frobnicate'],
    scopes: ['rooms', 'bogus'],
  });
  assert.deepEqual(c.actions, ['notify_manager']);
  assert.deepEqual(c.scopes, ['rooms']);
});

test('migrateConfig never throws on garbage', () => {
  assert.doesNotThrow(() => migrateConfig(null));
  assert.doesNotThrow(() => migrateConfig('garbage'));
  assert.doesNotThrow(() => migrateConfig(42));
  assert.doesNotThrow(() => migrateConfig({ trigger: { type: 'nonsense' } }));
});

test('validateAgentConfig rejects an unknown action', () => {
  const v = validateAgentConfig({
    trigger: { type: 'schedule', atLocalTime: '08:00' },
    scopes: ['rooms'],
    actions: ['frobnicate'],
    approvalRules: {},
  });
  assert.ok(v.error);
});

test('validateAgentConfig accepts a valid config and normalizes it', () => {
  const v = validateAgentConfig({
    trigger: { type: 'schedule', atLocalTime: '08:00' },
    scopes: ['rooms', 'staff'],
    actions: ['assign_rooms', 'notify_manager'],
    approvalRules: { defaultMode: 'auto', moneyOrGuestRequiresApproval: true },
  });
  assert.ok(v.value, v.error);
  assert.equal(v.value!.version, 1);
  assert.equal(v.value!.approvalRules.defaultMode, 'auto');
});

test('validateAgentConfig rejects a bad schedule time and a bad trigger type', () => {
  assert.ok(validateAgentConfig({ trigger: { type: 'schedule', atLocalTime: '25:99' }, scopes: [], actions: [], approvalRules: {} }).error);
  assert.ok(validateAgentConfig({ trigger: { type: 'nope' }, scopes: [], actions: [], approvalRules: {} }).error);
});
