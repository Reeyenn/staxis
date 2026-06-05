// Engine — live mode + approval gating + money/guest clamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '@/lib/agents/engine';
import { makeAgent, makeConfig, makeSpyAction, makeTemplate, makeDeps, newStore } from './agents-fixtures';

function setup(opts: { defaultMode: 'suggest' | 'approve_first' | 'auto'; spendsMoney?: boolean; guard?: boolean }) {
  const spy = makeSpyAction('spy', { spendsMoney: opts.spendsMoney });
  const agent = makeAgent({
    config: makeConfig({
      actions: ['spy'],
      approvalRules: { moneyOrGuestRequiresApproval: opts.guard ?? true, defaultMode: opts.defaultMode, perAction: {} },
    }),
  });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [spy.def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]) });
  return { spy, store, deps };
}

test('auto mode executes the action and the run succeeds', async () => {
  const { spy, deps } = setup({ defaultMode: 'auto' });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].status, 'executed');
  assert.equal(spy.calls.execute, 1);
  assert.equal(out.status, 'success');
});

test('suggest mode records the action but does NOT execute it', async () => {
  const { spy, deps } = setup({ defaultMode: 'suggest' });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  assert.equal(out.steps[0].status, 'proposed');
  assert.equal(spy.calls.execute, 0);
  assert.equal(out.status, 'success');
});

test('approve_first queues the action and the run awaits approval', async () => {
  const { spy, deps } = setup({ defaultMode: 'approve_first' });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  assert.equal(out.steps[0].status, 'pending_approval');
  assert.equal(spy.calls.execute, 0);
  assert.equal(out.status, 'awaiting_approval');
});

test('money/guest clamp forces approve_first even when config says auto', async () => {
  const { spy, deps } = setup({ defaultMode: 'auto', spendsMoney: true, guard: true });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  assert.equal(out.steps[0].status, 'pending_approval', 'a money action must never silently auto-execute');
  assert.equal(spy.calls.execute, 0);
});

test('a failed auto execution rolls the run up to failed', async () => {
  const spy = makeSpyAction('spy', { executeResult: { ok: false, error: 'boom' } });
  const agent = makeAgent({
    config: makeConfig({ actions: ['spy'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'auto', perAction: {} } }),
  });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [spy.def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]) });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  assert.equal(out.steps[0].status, 'executed');
  assert.equal(out.status, 'failed');
});

test('an action not in config.actions is skipped, not executed', async () => {
  const spy = makeSpyAction('spy');
  const agent = makeAgent({ config: makeConfig({ actions: [], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'auto', perAction: {} } }) });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [spy.def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]) });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  assert.equal(out.steps[0].status, 'skipped');
  assert.equal(spy.calls.execute, 0);
});
