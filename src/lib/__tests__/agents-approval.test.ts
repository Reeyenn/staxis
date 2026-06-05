// Engine — approval state machine: approve→execute, reject, idempotency, mode guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, executeApprovedStep, rejectStep } from '@/lib/agents/engine';
import { makeAgent, makeConfig, makeSpyAction, makeTemplate, makeDeps, newStore, FIXED_NOW } from './agents-fixtures';
import type { AgentActionStep, AgentRun } from '@/lib/agents/types';

function queuedSetup() {
  const spy = makeSpyAction('spy');
  const agent = makeAgent({
    config: makeConfig({ actions: ['spy'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'approve_first', perAction: {} } }),
  });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [spy.def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]) });
  return { spy, store, deps };
}

test('approve executes the queued step and the run becomes success', async () => {
  const { spy, deps } = queuedSetup();
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  const stepId = out.steps[0].id;
  const res = await executeApprovedStep(stepId, 'acct-9', deps);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'success');
  assert.equal(spy.calls.execute, 1);
});

test('double-approve is idempotent — the action runs exactly once', async () => {
  const { spy, deps } = queuedSetup();
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  const stepId = out.steps[0].id;
  await executeApprovedStep(stepId, 'acct-9', deps);
  const second = await executeApprovedStep(stepId, 'acct-9', deps);
  assert.equal(second.ok, true);
  assert.equal(spy.calls.execute, 1, 'a retried approval must not double-execute');
});

test('reject moves the step to rejected and does not execute', async () => {
  const { spy, deps } = queuedSetup();
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  const stepId = out.steps[0].id;
  const res = await rejectStep(stepId, 'acct-9', deps);
  assert.equal(res.ok, true);
  assert.equal(spy.calls.execute, 0);
});

test('approval resolves the operating day at EXECUTION time (not run-creation)', async () => {
  // Queue a step in the evening, approve "the next morning": execute() must see
  // today (resolved now), not the day the run was created.
  let seenAsOf = '';
  const capture = makeSpyAction('cap');
  const def = {
    ...capture.def,
    execute: async (_p: Record<string, unknown>, ctx: { asOfDate: string }) => {
      seenAsOf = ctx.asOfDate;
      return { ok: true };
    },
  };
  const agent = makeAgent({
    config: makeConfig({ actions: ['cap'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'approve_first', perAction: {} } }),
  });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [def], template: makeTemplate([{ actionKey: 'cap', payload: {} }]) });
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, deps);
  await executeApprovedStep(out.steps[0].id, 'acct-9', deps);
  // deps.now is fixed and deps.propertyTimezone is America/Chicago → 2026-06-04.
  assert.equal(seenAsOf, '2026-06-04');
});

test('a step whose run is not live cannot be executed', async () => {
  const spy = makeSpyAction('spy');
  const store = newStore([makeAgent()]);
  // Seed a dry_run run with a (hand-crafted) pending step.
  const run: AgentRun = {
    id: 'run-x', agentId: 'agent-1', agentName: 'T', propertyId: 'prop-1',
    triggerSource: 'backtest', triggeredBy: null, mode: 'dry_run', status: 'awaiting_approval',
    asOfDate: '2026-06-01', runLocalDate: '2026-06-04', inputsSnapshot: {},
    summary: null, summaryKey: null, summaryParams: {}, approximations: [], error: null,
    startedAt: new Date(FIXED_NOW).toISOString(), finishedAt: null,
  };
  const step: AgentActionStep = {
    id: 'step-x', runId: 'run-x', agentId: 'agent-1', propertyId: 'prop-1', actionKey: 'spy',
    payload: {}, status: 'pending_approval', result: null, describeKey: null, describeParams: {},
    describeEn: '', describeEs: '', spendsMoney: false, contactsGuest: false,
    decidedBy: null, decidedAt: null, createdAt: new Date(FIXED_NOW).toISOString(),
  };
  store.runs.set('run-x', run);
  store.steps.push(step);
  const deps = makeDeps({ store, actions: [spy.def] });
  const res = await executeApprovedStep('step-x', 'acct-9', deps);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /non-live/);
  assert.equal(spy.calls.execute, 0);
});
