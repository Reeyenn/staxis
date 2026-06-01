// Verifies the moat wiring: importing the agent tool catalog self-registers
// `search_knowledge`, it is read-only, and it is reachable on the chat surface
// by every role that uses the bottom-right assistant (incl. housekeepers — the
// headline "how do I set up the breakfast bar?" acceptance path). Needs no DB
// or auth; it exercises the in-memory registry only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Side-effect import: populates the tool registry exactly like the agent
// command route does at module load.
import '@/lib/agent/tools/index';
import { listAllTools, getToolsForRole } from '@/lib/agent/tools';

test('search_knowledge is registered as a read-only tool requiring a query', () => {
  const tool = listAllTools().find((t) => t.name === 'search_knowledge');
  assert.ok(tool, 'search_knowledge should be registered (import of tools/index ran its registerTool)');
  assert.notEqual(tool!.mutates, true, 'search_knowledge must be read-only (mutates !== true)');
  assert.ok(
    tool!.inputSchema.required?.includes('query'),
    'search_knowledge must require a "query" argument',
  );
});

test('search_knowledge is reachable on the chat surface for floor + manager roles', () => {
  const roles = ['housekeeping', 'maintenance', 'front_desk', 'general_manager', 'owner', 'admin'] as const;
  for (const role of roles) {
    const names = getToolsForRole(role, 'chat').map((t) => t.name);
    assert.ok(
      names.includes('search_knowledge'),
      `role "${role}" should see search_knowledge on the chat surface`,
    );
  }
});
