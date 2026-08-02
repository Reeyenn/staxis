import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executeTool,
  getTool,
  getToolsForRole,
  listAllTools,
  resolveToolName,
} from '@/lib/agent/tools';
import '@/lib/agent/tools/index';

test('retired portfolio tool history resolves to a safe My Portfolio refusal', async () => {
  const compatibility = getTool('compare_properties');
  assert.ok(compatibility);
  assert.equal(compatibility.name, 'compare_properties');
  assert.equal(resolveToolName('compare_properties'), 'portfolio_route');
  assert.equal(listAllTools().some(tool => tool.name === 'compare_properties'), false);
  assert.equal(
    getToolsForRole('owner', 'chat').some(tool => tool.name === 'compare_properties'),
    false,
  );

  const viaHistory = await compatibility.handler({}, {} as never);
  assert.deepEqual(viaHistory, {
    ok: false,
    error: 'This comparison moved to My Portfolio. Ask there to compare multiple hotels. Nothing was read or changed.',
  });
  const viaExecutor = await executeTool('compare_properties', {}, {} as never);
  assert.deepEqual(viaExecutor, viaHistory);
});
