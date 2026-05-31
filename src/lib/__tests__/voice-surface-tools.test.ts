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
  // General voice mode (2026-05-30): TWO tools opt in here —
  //   • log_complaint  (Complaints / Service Recovery)
  //   • log_found_item (Lost & Found)
  // Both declare voiceModes:['general'] with the SAME allowedRoles set
  // (owner / admin / general_manager / housekeeping / maintenance — never
  // 'staff'). This snapshot is their UNION. (Resolved from the inherited
  // origin/main merge 9825952, which had pinned only one tool on each
  // conflict side; reality registers both.) Audited per this file's checklist:
  // both are property-scoped (ctx.propertyId), role-gated, validated/capped
  // server-side, and non-destructive. createMaintenanceWorkOrder stays hidden
  // here (voiceModes: ['housekeeper_issue']).
  const GENERAL_VOICE_ROLES = new Set(['owner', 'admin', 'general_manager', 'housekeeping', 'maintenance']);
  for (const role of ROLES) {
    test(`role=${role} general voice mode catalog`, () => {
      const tools = getToolsForRole(role as never, 'voice', 'general');
      const expected = GENERAL_VOICE_ROLES.has(role) ? ['log_complaint', 'log_found_item'] : [];
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        expected,
        `General voice mode catalog changed for role=${role}. ` +
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
  test('no-mode lookup sees the voice-mode-gated tools (executor still refuses)', () => {
    const tools = getToolsForRole('housekeeping' as never, 'voice');
    // housekeeping is in allowedRoles for the maintenance-ticket tool
    // (voiceModes: ['housekeeper_issue']) AND both general-mode tools
    // log_complaint + log_found_item (voiceModes: ['general']); with no mode
    // the voiceModes filter no-ops so all three surface.
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['createMaintenanceWorkOrder', 'log_complaint', 'log_found_item'],
      'No-mode getToolsForRole bypasses voiceModes filter — this is fine because executeTool re-checks mode.',
    );
  });
});
