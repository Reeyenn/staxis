/**
 * remember / forget tool registration, surface gating, and handler
 * authorization guards. The guard tests exercise REJECTION paths only — they
 * return before any DB write, so this needs no database. The success/DB paths
 * are covered by agent-memory.integration.test.ts.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Side-effect import populates the registry, exactly like the agent routes.
import '@/lib/agent/tools/index';
import { listAllTools, getToolsForRole, executeTool, type ToolContext } from '@/lib/agent/tools';
import type { AppRole } from '@/lib/roles';
import {
  agentToolAuthorityIdentity,
  installAgentToolAuthorityTestStore,
} from './helpers/agent-tool-authority';

const PID = '00000000-0000-0000-0000-0000000000aa';
const AUTHORIZED_ROLES = ['owner', 'maintenance'] as const;
let restoreAuthority: (() => void) | null = null;

before(() => {
  restoreAuthority = installAgentToolAuthorityTestStore(() => AUTHORIZED_ROLES.map((role) => ({
    ...agentToolAuthorityIdentity(role),
    role,
    propertyIds: [PID],
  })));
});

after(() => restoreAuthority?.());

function ctx(role: AppRole): ToolContext {
  const identity = agentToolAuthorityIdentity(role);
  return {
    user: {
      uid: identity.authUserId, accountId: identity.accountId,
      username: 'u', displayName: 'U', role, propertyAccess: [PID],
      hotelMutationAllowed: true,
      capabilitySnapshot: {
        view_financials: true,
        view_wages: true,
        manage_inventory_orders: true,
      },
    },
    propertyId: PID,
    staffId: null,
    requestId: 'r',
    surface: 'chat',
    enabledSections: null,
  };
}

describe('memory tools — registration shape', () => {
  test('remember is a mutating tool requiring scope/topic/content', () => {
    const t = listAllTools().find((x) => x.name === 'remember');
    assert.ok(t, 'remember should be registered');
    assert.equal(t!.mutates, true);
    assert.deepEqual([...(t!.surfaces ?? [])], ['chat']);
    for (const req of ['scope', 'topic', 'content']) {
      assert.ok(t!.inputSchema.required?.includes(req), `remember must require ${req}`);
    }
  });

  test('forget is a mutating tool requiring scope/topic', () => {
    const t = listAllTools().find((x) => x.name === 'forget');
    assert.ok(t, 'forget should be registered');
    assert.equal(t!.mutates, true);
  });
});

describe('memory tools — surface gating', () => {
  test('reachable on chat for every hat that has a chat', () => {
    // Housekeeping dropped off this list on 2026-07-27 (WHO LENSES): that hat
    // has no chat surface at all now.
    for (const role of ['maintenance', 'front_desk', 'general_manager', 'owner', 'admin'] as const) {
      const names = getToolsForRole(role, 'chat').map((t) => t.name);
      assert.ok(names.includes('remember') && names.includes('forget'), `chat/${role} should see memory tools`);
    }
  });
});

describe('memory tools — handler authorization guards (no DB)', () => {
  test('remember rejects an invalid scope', async () => {
    const r = await executeTool('remember', { scope: 'everyone', topic: 't', content: 'c' }, ctx('owner'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /scope/i);
  });

  test('remember hotel-scope is refused for a floor role (management-only)', async () => {
    const r = await executeTool('remember', { scope: 'hotel', topic: 'x', content: 'shared fact' }, ctx('maintenance'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /manager|owner/i);
  });

  test('forget hotel-scope is refused for a floor role', async () => {
    const r = await executeTool('forget', { scope: 'hotel', topic: 'x' }, ctx('maintenance'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /manager|owner/i);
  });

  test('remember rejects an empty topic', async () => {
    const r = await executeTool('remember', { scope: 'me', topic: '   ', content: 'c' }, ctx('maintenance'));
    assert.equal(r.ok, false);
  });

  test('remember rejects content over 500 chars', async () => {
    const r = await executeTool('remember', { scope: 'me', topic: 't', content: 'x'.repeat(501) }, ctx('maintenance'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /500|long/i);
  });
});
