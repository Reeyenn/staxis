// Engine — dry_run never executes; records "would do X"; honors asOfDate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '@/lib/agents/engine';
import { makeAgent, makeConfig, makeSpyAction, makeTemplate, makeDeps, newStore } from './agents-fixtures';

test('dry_run simulates every action and calls execute() ZERO times', async () => {
  const spy = makeSpyAction('spy', { spendsMoney: true }); // even a money action only simulates
  const agent = makeAgent({
    config: makeConfig({ actions: ['spy'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'auto', perAction: {} } }),
  });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [spy.def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]) });

  const out = await runAgent('agent-1', { mode: 'dry_run', triggerSource: 'backtest', asOfDate: '2026-06-01' }, deps);

  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].status, 'simulated');
  assert.equal(spy.calls.execute, 0, 'dry_run must NEVER execute a real action');
  assert.ok(spy.calls.describe >= 1, 'dry_run uses describe()');
  const result = out.steps[0].result as { wouldDo?: { en: string } };
  assert.ok(result?.wouldDo?.en?.includes('would spy'));
});

test('dry_run never calls the LLM — a backtest is free and deterministic', async () => {
  let llmCalls = 0;
  const spy = makeSpyAction('spy');
  const agent = makeAgent({ config: makeConfig({ actions: ['spy'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'auto', perAction: {} } }) });
  const store = newStore([agent]);
  const deps = makeDeps({
    store,
    actions: [spy.def],
    template: makeTemplate([{ actionKey: 'spy', payload: {} }]),
    reason: async () => { llmCalls += 1; return 'should not be called'; },
  });
  const out = await runAgent('agent-1', { mode: 'dry_run', triggerSource: 'backtest', asOfDate: '2026-06-01' }, deps);
  assert.equal(llmCalls, 0, 'a dry-run/backtest must not spend money on an LLM summary');
  assert.ok(out.summary.length > 0, 'still produces a deterministic summary');
});

test('dry_run resolves the run against the requested asOfDate', async () => {
  let seenAsOf = '';
  const spy = makeSpyAction('spy');
  // capture asOfDate through describe via ctx
  const def = {
    ...spy.def,
    describe: (_p: Record<string, unknown>, ctx: { asOfDate: string }) => {
      seenAsOf = ctx.asOfDate;
      return { params: {}, en: 'x', es: 'x' };
    },
  };
  const agent = makeAgent({ config: makeConfig({ actions: ['spy'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'auto', perAction: {} } }) });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]) });
  await runAgent('agent-1', { mode: 'dry_run', triggerSource: 'backtest', asOfDate: '2026-05-20' }, deps);
  assert.equal(seenAsOf, '2026-05-20');
});
