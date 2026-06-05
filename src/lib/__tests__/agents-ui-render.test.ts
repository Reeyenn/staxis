// Agent Builder UI — render-driving logic for the approval inbox + receipt,
// asserted against fabricated steps/runs (no React mount needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepDescribe, actionBadges, actionStatusLabel, actionStatusTone, runStatusLabel, runStatusTone,
} from '@/app/settings/agents/_lib/format';
import { isActionFailed } from '@/lib/agents/types';
import type { AgentActionStep, AgentApprovalQueueItem, AgentRun } from '@/lib/agents/types';

function makeStep(over: Partial<AgentActionStep> = {}): AgentActionStep {
  return {
    id: 'step-1', runId: 'run-1', agentId: 'a-1', propertyId: 'p-1', actionKey: 'notify_manager',
    payload: {}, status: 'pending_approval', result: null, describeKey: null, describeParams: {},
    describeEn: 'Would post to the team: "check lobby"', describeEs: 'Publicaría al equipo: "revisar lobby"',
    spendsMoney: false, contactsGuest: false, decidedBy: null, decidedAt: null, createdAt: '2026-06-04T12:00:00Z',
    ...over,
  };
}

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1', agentId: 'a-1', agentName: 'Front desk check', propertyId: 'p-1',
    triggerSource: 'manual', triggeredBy: 'acct-1', mode: 'live', status: 'awaiting_approval',
    asOfDate: null, runLocalDate: '2026-06-04', inputsSnapshot: {}, summary: 'Proposed 1 action.',
    summaryKey: null, summaryParams: {}, approximations: [], error: null,
    startedAt: '2026-06-04T12:00:00Z', finishedAt: null, ...over,
  };
}

test('stepDescribe renders the right language from the flat fields', () => {
  const step = makeStep();
  assert.equal(stepDescribe(step, 'en'), 'Would post to the team: "check lobby"');
  assert.equal(stepDescribe(step, 'es'), 'Publicaría al equipo: "revisar lobby"');
});

test('a pending money/guest step surfaces both badges', () => {
  const step = makeStep({ spendsMoney: true, contactsGuest: true });
  assert.deepEqual(actionBadges(step), ['money', 'guest']);
});

test('isActionFailed flags executed steps whose result.ok is false', () => {
  assert.equal(isActionFailed(makeStep({ status: 'executed', result: { ok: false, error: 'boom' } })), true);
  assert.equal(isActionFailed(makeStep({ status: 'executed', result: { ok: true } })), false);
  assert.equal(isActionFailed(makeStep({ status: 'pending_approval' })), false);
  assert.equal(isActionFailed(makeStep({ status: 'simulated', result: null })), false);
});

test('status tones/labels are defined for queue + receipt states', () => {
  assert.equal(actionStatusLabel('pending_approval', 'en'), 'Waiting');
  assert.equal(actionStatusTone('pending_approval'), 'caramel');
  assert.equal(actionStatusTone('simulated'), 'purple');
  assert.equal(runStatusLabel('awaiting_approval', 'en'), 'Awaiting approval');
  assert.equal(runStatusTone('failed'), 'red');
});

test('an approval queue item carries its run + pending steps for render', () => {
  const item: AgentApprovalQueueItem = { run: makeRun(), pendingSteps: [makeStep(), makeStep({ id: 'step-2', spendsMoney: true })] };
  assert.equal(item.run.agentName, 'Front desk check');
  assert.equal(item.pendingSteps.length, 2);
  assert.deepEqual(item.pendingSteps.map((s) => stepDescribe(s, 'es')), [
    'Publicaría al equipo: "revisar lobby"',
    'Publicaría al equipo: "revisar lobby"',
  ]);
  assert.deepEqual(actionBadges(item.pendingSteps[1]), ['money']);
});
