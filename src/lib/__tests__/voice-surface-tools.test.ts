/**
 * Snapshot of the voice-surface tool catalog.
 *
 * Plan v2 F-AI-15: tools must explicitly opt into the voice surface via
 * `surfaces: ['voice']`. The DEFAULT (no surfaces field) is chat-only.
 *
 * Feature #11 (2026-05-24): introduced the `housekeeper_issue` voice mode
 * and the createMaintenanceWorkOrder tool that opts into it. The general
 * voice mode (passed when the housekeeper-issue button isn't the entry
 * point) still gets an empty tool catalog — the new tool declares
 * `voiceModes: ['housekeeper_issue']` so it's hidden from any other mode.
 *
 * This test exists to make sure any future tool that opts into voice
 * triggers an explicit security review. If you're hitting a regression
 * here, the right path is to:
 *   1. Confirm the new tool actually needs voice (most don't — voice
 *      is for spoken Q&A, not destructive operations).
 *   2. Audit its arg validation + property scope.
 *   3. Update the appropriate snapshot list below.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getToolsForRole } from '@/lib/agent/tools';
// Side-effect import: register all tools against the catalog.
import '@/lib/agent/tools/index';

const ROLES = ['owner', 'admin', 'general_manager', 'housekeeping', 'maintenance', 'staff'] as const;

describe('voice surface tool catalog — general mode (Plan v2 F-AI-15)', () => {
  for (const role of ROLES) {
    test(`role=${role} sees zero tools in general voice mode`, () => {
      const tools = getToolsForRole(role as never, 'voice', 'general');
      // EXPECTED EMPTY. createMaintenanceWorkOrder declares
      // `voiceModes: ['housekeeper_issue']` so it does NOT appear here —
      // it's only callable from a session minted with mode='housekeeper_issue'.
      assert.deepEqual(
        tools.map((t) => t.name),
        [],
        `General voice mode gained a tool for role=${role}. ` +
          'Stop and audit before updating this snapshot — see comment in voice-surface-tools.test.ts.',
      );
    });
  }
});

describe('voice surface tool catalog — housekeeper_issue mode (feature #11)', () => {
  // Roles that the createMaintenanceWorkOrder tool allows.
  const ALLOWED_ROLES = ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk', 'maintenance'] as const;
  for (const role of ALLOWED_ROLES) {
    test(`role=${role} sees exactly the maintenance-ticket tool in housekeeper_issue mode`, () => {
      const tools = getToolsForRole(role as never, 'voice', 'housekeeper_issue');
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['createMaintenanceWorkOrder'],
        `housekeeper_issue mode for role=${role} surfaced a tool list other than ['createMaintenanceWorkOrder']. ` +
          'If you intentionally exposed more tools to this mode, audit them and update the snapshot.',
      );
    });
  }

  test('role=staff is NOT allowed to use the maintenance-ticket tool', () => {
    const tools = getToolsForRole('staff' as never, 'voice', 'housekeeper_issue');
    assert.deepEqual(tools.map((t) => t.name), [], "'staff' role must not see createMaintenanceWorkOrder");
  });
});

describe('voice surface tool catalog — surface omitted (no-mode call)', () => {
  // When the caller doesn't pass a mode (e.g. tests / a third-party caller),
  // the mode-filter no-ops, so voice-opted-in tools come through regardless
  // of their voiceModes declaration. This is documented behaviour — the
  // belt-and-braces gate is in executeTool() which DOES receive ctx.voiceMode
  // and will refuse a mismatched call there. This test pins the shape so a
  // refactor that flips the default doesn't silently expose tools.
  test('no-mode lookup sees the voice-mode-gated tool (executor still refuses)', () => {
    const tools = getToolsForRole('housekeeping' as never, 'voice');
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['createMaintenanceWorkOrder'],
      'No-mode getToolsForRole bypasses voiceModes filter — this is fine because executeTool re-checks mode.',
    );
  });
});
