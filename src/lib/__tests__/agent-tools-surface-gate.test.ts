/**
 * Regression test for the per-surface tool gate in `executeTool` +
 * `getToolsForRole`.
 *
 * Run via: npx tsx --test src/lib/__tests__/agent-tools-surface-gate.test.ts
 *
 * Closes Codex 2026-05-16 P0 (Pattern E): the voice path used to call
 * `getToolsForRole(role)` with the default surface='chat', silently
 * exposing the full chat tool catalog. Now `surface` is required at the
 * type level + the executor itself refuses any tool whose `surfaces`
 * field doesn't include the caller's surface. These tests pin both
 * halves of the gate so a future refactor can't quietly remove either.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTool,
  executeTool,
  getToolsForRole,
  type ToolContext,
  type ToolResult,
} from '../agent/tools';

// Use unique tool names so the registry isn't polluted across test runs
// when files share the same import graph (registry is module-scoped).
const NAME_CHAT_ONLY = '__test_surface_chat_only';
const NAME_VOICE_OPT_IN = '__test_surface_voice_opt_in';
const NAME_NO_SURFACES_FIELD = '__test_surface_no_surfaces_field';

// Register three test tools with distinct surface postures.
registerTool({
  name: NAME_CHAT_ONLY,
  description: 'chat-only tool for tests',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'general_manager'],
  surfaces: ['chat'],
  handler: async (): Promise<ToolResult> => ({ ok: true, data: 'chat-only ran' }),
});

registerTool({
  name: NAME_VOICE_OPT_IN,
  description: 'tool that has explicitly opted into voice',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'general_manager'],
  surfaces: ['chat', 'voice'],
  handler: async (): Promise<ToolResult> => ({ ok: true, data: 'voice-opt-in ran' }),
});

registerTool({
  name: NAME_NO_SURFACES_FIELD,
  description: 'tool with no surfaces field at all',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'general_manager'],
  // Intentionally no `surfaces` field — default must be chat-only.
  handler: async (): Promise<ToolResult> => ({ ok: true, data: 'no-surfaces ran' }),
});

function makeCtx(surface: 'chat' | 'voice' | 'walkthrough', role: 'admin' | 'general_manager' = 'general_manager'): ToolContext {
  return {
    user: {
      uid: 'test-uid',
      accountId: 'test-account',
      username: 'tester',
      displayName: 'Tester',
      role,
      propertyAccess: ['test-property'],
    },
    propertyId: 'test-property',
    staffId: null,
    requestId: 'test-request',
    surface,
  };
}

describe('executeTool — surface gate (Codex 2026-05-16 P0 fix, Pattern E)', () => {
  test('chat surface: chat-only tool runs', async () => {
    const r = await executeTool(NAME_CHAT_ONLY, {}, makeCtx('chat'));
    assert.equal(r.ok, true);
    assert.equal(r.data, 'chat-only ran');
  });

  test('voice surface: chat-only tool is REJECTED (closes the P0)', async () => {
    const r = await executeTool(NAME_CHAT_ONLY, {}, makeCtx('voice'));
    assert.equal(r.ok, false);
    assert.match(
      r.error ?? '',
      /not available on the voice surface/,
      'voice-surface call to a chat-only tool must be refused with the surface-mismatch error',
    );
  });

  test('voice surface: tool that opted into voice is allowed', async () => {
    const r = await executeTool(NAME_VOICE_OPT_IN, {}, makeCtx('voice'));
    assert.equal(r.ok, true);
    assert.equal(r.data, 'voice-opt-in ran');
  });

  test('walkthrough surface: chat-only tool is REJECTED', async () => {
    const r = await executeTool(NAME_CHAT_ONLY, {}, makeCtx('walkthrough'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not available on the walkthrough surface/);
  });

  test('tool with no `surfaces` field defaults to chat-only (refused on voice)', async () => {
    const chatResult = await executeTool(NAME_NO_SURFACES_FIELD, {}, makeCtx('chat'));
    assert.equal(chatResult.ok, true, 'no-surfaces field implies chat-only — chat must work');

    const voiceResult = await executeTool(NAME_NO_SURFACES_FIELD, {}, makeCtx('voice'));
    assert.equal(voiceResult.ok, false, 'no-surfaces field implies chat-only — voice must be refused');
    assert.match(voiceResult.error ?? '', /not available on the voice surface/);
  });

  test('surface gate runs BEFORE the role gate (refuses surface mismatch even if role would also fail)', async () => {
    // A 'housekeeping' caller on a chat-only tool: BOTH gates would refuse.
    // We want the message to be the surface one when surface is wrong,
    // so the failure is attributable to the security boundary the operator
    // cares about. (We register on admin/general_manager only, so a
    // housekeeping role on voice would hit the surface gate first.)
    const ctx: ToolContext = {
      ...makeCtx('voice'),
      user: { ...makeCtx('voice').user, role: 'housekeeping' as ToolContext['user']['role'] },
    };
    const r = await executeTool(NAME_CHAT_ONLY, {}, ctx);
    assert.equal(r.ok, false);
    assert.match(
      r.error ?? '',
      /not available on the voice surface/,
      'surface check must short-circuit before the role check so the message is unambiguous',
    );
  });
});

describe('getToolsForRole — surface filter', () => {
  test('asking for voice tools returns ONLY voice-opted-in tools (closes the P0 catalog leak)', () => {
    const voiceTools = getToolsForRole('general_manager', 'voice');
    const names = voiceTools.map(t => t.name);
    assert.equal(
      names.includes(NAME_VOICE_OPT_IN),
      true,
      'tool with surfaces: [chat, voice] must appear in the voice catalog',
    );
    assert.equal(
      names.includes(NAME_CHAT_ONLY),
      false,
      'tool with surfaces: [chat] must NOT appear in the voice catalog',
    );
    assert.equal(
      names.includes(NAME_NO_SURFACES_FIELD),
      false,
      'tool with no surfaces field defaults to chat-only and must NOT appear in voice',
    );
  });

  test('asking for chat tools includes chat-only tools', () => {
    const chatTools = getToolsForRole('general_manager', 'chat');
    const names = chatTools.map(t => t.name);
    assert.equal(names.includes(NAME_CHAT_ONLY), true);
    assert.equal(names.includes(NAME_VOICE_OPT_IN), true);
    assert.equal(names.includes(NAME_NO_SURFACES_FIELD), true);
  });
});
