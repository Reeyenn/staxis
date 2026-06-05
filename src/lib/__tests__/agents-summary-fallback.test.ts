// Engine — a run ALWAYS gets a summary, even with no LLM budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '@/lib/agents/engine';
import { makeAgent, makeConfig, makeSpyAction, makeTemplate, makeDeps, newStore } from './agents-fixtures';

function base(reason?: (p: string) => Promise<string | null>) {
  const spy = makeSpyAction('spy');
  const agent = makeAgent({
    config: makeConfig({ actions: ['spy'], approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'auto', perAction: {} } }),
  });
  const store = newStore([agent]);
  const deps = makeDeps({ store, actions: [spy.def], template: makeTemplate([{ actionKey: 'spy', payload: {} }]), reason });
  return deps;
}

test('no LLM budget (reason returns null) still yields a deterministic summary', async () => {
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, base(async () => null));
  assert.ok(out.summary && out.summary.length > 0);
  assert.match(out.summary, /carried out|Run complete|nothing to do/);
});

test('when the LLM returns text, that text is used as the summary', async () => {
  const out = await runAgent('agent-1', { mode: 'live', triggerSource: 'manual' }, base(async () => 'Cleaned 12 rooms.'));
  assert.equal(out.summary, 'Cleaned 12 rooms.');
});
