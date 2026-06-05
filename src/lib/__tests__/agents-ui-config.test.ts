// Agent Builder UI — wizard <-> config mapping (pure), incl. a round-trip
// through the server's validateAgentConfig to catch perAction drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentConfig, configToWizard, isCoreComplete, requiredPayloadsMet, validTime,
  type ActionFloors,
} from '@/app/settings/agents/_lib/config';
import { emptyWizardState, type WizardState } from '@/app/settings/agents/_lib/wizardState';
import { validateAgentConfig } from '@/lib/agents/config-validate';
import { makeAgent, makeConfig } from './agents-fixtures';

const floors: ActionFloors = {
  notify_manager: 'suggest',
  assign_rooms: 'suggest',
  send_staff_sms: 'approve_first', // spendsMoney
};

function customState(over: Partial<WizardState> = {}): WizardState {
  return {
    ...emptyWizardState(),
    templateKey: 'custom',
    name: 'Front desk check',
    triggerKind: 'schedule',
    atLocalTime: '08:00',
    daysOfWeek: [1, 3, 5],
    actions: ['notify_manager'],
    modes: { notify_manager: 'approve_first' },
    payloads: { notify_manager: { message: 'check the lobby' } },
    ...over,
  };
}

test('buildAgentConfig keeps actions and perAction in lockstep', () => {
  const c = buildAgentConfig(
    customState({ actions: ['notify_manager', 'assign_rooms'], modes: { notify_manager: 'suggest', assign_rooms: 'suggest' }, payloads: { notify_manager: { message: 'hi' } } }),
    floors,
  );
  assert.deepEqual(c.actions, ['notify_manager', 'assign_rooms']);
  assert.deepEqual(Object.keys(c.approvalRules.perAction).sort(), ['assign_rooms', 'notify_manager']);
});

test('buildAgentConfig clamps auto to approve_first for a money/guest action and hardcodes the guardrail', () => {
  const c = buildAgentConfig(customState({ actions: ['send_staff_sms'], modes: { send_staff_sms: 'auto' }, payloads: { send_staff_sms: {} } }), floors);
  assert.equal(c.approvalRules.perAction['send_staff_sms'], 'approve_first');
  assert.equal(c.approvalRules.moneyOrGuestRequiresApproval, true);
});

test('buildAgentConfig output passes the server validator and survives a round-trip', () => {
  const c = buildAgentConfig(customState(), floors);
  const v = validateAgentConfig(c);
  assert.equal(v.error, undefined);
  assert.ok(v.value);
  assert.deepEqual(v.value!.actions, c.actions);
  assert.equal(v.value!.approvalRules.perAction['notify_manager'], 'approve_first');
  // templateParams (payloads) must survive the write path so the custom planner can read them.
  assert.deepEqual((v.value!.templateParams as { payloads?: unknown })?.payloads, { notify_manager: { message: 'check the lobby' } });
});

test('configToWizard clamps a forbidden stored auto on read (edit mode can never surface it)', () => {
  const agent = makeAgent({
    templateKey: 'custom',
    config: makeConfig({ actions: ['send_staff_sms'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'suggest', perAction: { send_staff_sms: 'auto' } } }),
  });
  const w = configToWizard(agent, floors);
  assert.equal(w.modes['send_staff_sms'], 'approve_first');
});

test('isCoreComplete gates name + trigger + actions', () => {
  assert.equal(isCoreComplete(customState()), true);
  assert.equal(isCoreComplete(customState({ name: '   ' })), false);
  assert.equal(isCoreComplete(customState({ actions: [] })), false);
  assert.equal(isCoreComplete(customState({ triggerKind: 'event', eventName: '' })), false);
  assert.equal(isCoreComplete(customState({ triggerKind: 'event', eventName: 'room.issue_reported' })), true);
});

test('requiredPayloadsMet enforces required fields', () => {
  assert.equal(requiredPayloadsMet(customState(), { notify_manager: ['message'] }), true);
  assert.equal(requiredPayloadsMet(customState({ payloads: { notify_manager: {} } }), { notify_manager: ['message'] }), false);
  assert.equal(requiredPayloadsMet(customState({ payloads: { notify_manager: { message: '   ' } } }), { notify_manager: ['message'] }), false);
});

test('validTime accepts HH:MM 24h only', () => {
  assert.equal(validTime('08:00'), true);
  assert.equal(validTime('23:59'), true);
  assert.equal(validTime('8:00'), false);
  assert.equal(validTime('25:00'), false);
});
