// Additive custom planner — proposes the manager's configured actions with the
// payloads the wizard collected, and self-registers so the engine can run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customTemplate, CUSTOM_TEMPLATE_KEY } from '@/lib/agents/templates/custom';
import { listTemplateMeta, getTemplate } from '@/lib/agents/templates/registry';
import { makeConfig } from './agents-fixtures';

test('custom planner maps config.actions + templateParams.payloads to proposed actions', () => {
  const config = makeConfig({
    actions: ['notify_manager', 'assign_rooms'],
    templateParams: { payloads: { notify_manager: { message: 'check lobby' }, assign_rooms: { floors: [2, 3] } } },
  });
  const proposed = customTemplate.plan({ scopes: {}, config, asOfDate: '2026-06-04' });
  assert.equal(proposed.length, 2);
  assert.deepEqual(proposed.map((p) => p.actionKey), ['notify_manager', 'assign_rooms']);
  assert.deepEqual(proposed[0].payload, { message: 'check lobby' });
  assert.deepEqual(proposed[1].payload, { floors: [2, 3] });
});

test('custom planner yields an empty payload when none was configured', () => {
  const config = makeConfig({ actions: ['notify_manager'] });
  const proposed = customTemplate.plan({ scopes: {}, config, asOfDate: '2026-06-04' });
  assert.deepEqual(proposed, [{ actionKey: 'notify_manager', payload: {}, reason: proposed[0].reason }]);
});

test('importing the module registers the custom template so the engine can resolve it', () => {
  assert.ok(listTemplateMeta().some((t) => t.key === CUSTOM_TEMPLATE_KEY));
  assert.equal(getTemplate(CUSTOM_TEMPLATE_KEY)?.key, CUSTOM_TEMPLATE_KEY);
});
