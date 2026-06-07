/**
 * remember / forget tool registration, surface+voice-mode gating, and handler
 * authorization guards. The guard tests exercise REJECTION paths only — they
 * return before any DB write, so this needs no database. The success/DB paths
 * are covered by agent-memory.integration.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Side-effect import populates the registry, exactly like the agent routes.
import '@/lib/agent/tools/index';
import { listAllTools, getToolsForRole, executeTool, type ToolContext } from '@/lib/agent/tools';
import type { AppRole } from '@/lib/roles';

const PID = '00000000-0000-0000-0000-0000000000aa';

function ctx(role: AppRole, surface: 'chat' | 'voice' = 'chat'): ToolContext {
  return {
    user: {
      uid: 'u', accountId: '00000000-0000-0000-0000-000000000001',
      username: 'u', displayName: 'U', role, propertyAccess: [PID],
    },
    propertyId: PID,
    staffId: null,
    requestId: 'r',
    surface,
  };
}

describe('memory tools — registration shape', () => {
  test('remember is a mutating tool requiring scope/topic/content', () => {
    const t = listAllTools().find((x) => x.name === 'remember');
    assert.ok(t, 'remember should be registered');
    assert.equal(t!.mutates, true);
    assert.deepEqual([...(t!.surfaces ?? [])].sort(), ['chat', 'voice']);
    assert.deepEqual([...(t!.voiceModes ?? [])], ['general']);
    for (const req of ['scope', 'topic', 'content']) {
      assert.ok(t!.inputSchema.required?.includes(req), `remember must require ${req}`);
    }
  });

  test('forget is a mutating tool requiring scope/topic', () => {
    const t = listAllTools().find((x) => x.name === 'forget');
    assert.ok(t, 'forget should be registered');
    assert.equal(t!.mutates, true);
    assert.deepEqual([...(t!.voiceModes ?? [])], ['general']);
  });
});

describe('memory tools — surface + voice-mode gating', () => {
  test('reachable on chat for floor + manager roles', () => {
    for (const role of ['housekeeping', 'front_desk', 'general_manager', 'owner', 'admin'] as const) {
      const names = getToolsForRole(role, 'chat').map((t) => t.name);
      assert.ok(names.includes('remember') && names.includes('forget'), `chat/${role} should see memory tools`);
    }
  });

  test('reachable in GENERAL voice mode', () => {
    const names = getToolsForRole('housekeeping', 'voice', 'general').map((t) => t.name);
    assert.ok(names.includes('remember') && names.includes('forget'));
  });

  test('NOT reachable in the locked housekeeper_issue voice mode (no leak)', () => {
    const names = getToolsForRole('housekeeping', 'voice', 'housekeeper_issue').map((t) => t.name);
    assert.equal(names.includes('remember'), false);
    assert.equal(names.includes('forget'), false);
  });
});

describe('memory tools — handler authorization guards (no DB)', () => {
  test('remember rejects an invalid scope', async () => {
    const r = await executeTool('remember', { scope: 'everyone', topic: 't', content: 'c' }, ctx('owner'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /scope/i);
  });

  test('remember hotel-scope is refused for a floor role (management-only)', async () => {
    const r = await executeTool('remember', { scope: 'hotel', topic: 'x', content: 'shared fact' }, ctx('housekeeping'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /manager|owner/i);
  });

  test('forget hotel-scope is refused for a floor role', async () => {
    const r = await executeTool('forget', { scope: 'hotel', topic: 'x' }, ctx('maintenance'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /manager|owner/i);
  });

  test('remember rejects an empty topic', async () => {
    const r = await executeTool('remember', { scope: 'me', topic: '   ', content: 'c' }, ctx('housekeeping'));
    assert.equal(r.ok, false);
  });

  test('remember rejects content over 500 chars', async () => {
    const r = await executeTool('remember', { scope: 'me', topic: 't', content: 'x'.repeat(501) }, ctx('housekeeping'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /500|long/i);
  });
});
