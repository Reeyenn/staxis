/**
 * Snapshot of the voice-surface tool catalog.
 *
 * Plan v2 F-AI-15: tools must explicitly opt into the voice surface via
 * `surfaces: ['voice']`. The DEFAULT (no surfaces field) is chat-only.
 *
 * Feature #11 (2026-05-24): introduced the `housekeeper_issue` voice mode
 * and the createMaintenanceWorkOrder tool that opts into it. The general
 * voice mode (passed when the housekeeper-issue button isn't the entry
 * point) gets the general-voice tools (log_complaint, log_found_item,
 * get_time_off_requests for managers, and remember/forget); the
 * createMaintenanceWorkOrder tool declares `voiceModes: ['housekeeper_issue']`
 * so it stays hidden from any other mode.
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

// Voice approval gate (feature/voice-approval): the two CONTROL tools
// confirm_pending_action + cancel_pending_action opt into the voice surface
// (surfaces:['voice']) with NO voiceModes, so they surface in EVERY voice mode
// for EVERY role. They are mutates:false control-flow (the real card-tier
// mutation already passed the spoken-confirmation gate), so the gate itself can
// never hold them. Audited before pinning here: they only ever touch
// agent_pending_actions rows scoped to the caller's conversationId + propertyId
// + accountId, run no mutation of their own, and are chat-excluded.
const VOICE_CONTROL_TOOLS = ['cancel_pending_action', 'confirm_pending_action'];

describe('voice surface tool catalog — general mode (Plan v2 F-AI-15)', () => {
  // Tools that opt into GENERAL voice mode (voiceModes: ['general']):
  //   • log_complaint        (Complaints)   — manager + floor roles
  //   • log_found_item       (Lost & Found) — manager + floor roles
  //   • get_time_off_requests (Staff PTO)   — MANAGER roles only
  //       "Hey Staxis, any time-off requests?"
  // get_time_off_requests audited before updating this snapshot: READ-ONLY
  // (mutates:false — it never writes), property-scoped via ctx.propertyId,
  // role-gated to admin/owner/general_manager (executeTool enforces
  // allowedRoles), and it only answers spoken Q&A. The MUTATING PTO tool
  // (decide_time_off) is deliberately chat-only — a misheard "approve" must
  // not delete a shift — so it never reaches this catalog. Engineering-
  // compliance tools declare voiceModes:['compliance'] so they stay OUT of
  // general mode; createMaintenanceWorkOrder stays hidden via
  // voiceModes:['housekeeper_issue'].
  const GENERAL_VOICE_ROLES = new Set(['owner', 'admin', 'general_manager', 'housekeeping', 'maintenance']);
  const MANAGER_VOICE_ROLES = new Set(['owner', 'admin', 'general_manager']);
  for (const role of ROLES) {
    test(`role=${role} general voice mode catalog`, () => {
      const tools = getToolsForRole(role as never, 'voice', 'general');
      // sorted: 'get_time_off_requests' < 'log_complaint' < 'log_found_item'
      // Memory tools (remember/forget) opt into general voice for ALL roles
      // (voiceModes:['general']). Audited before updating this snapshot: role-
      // gated via allowedRoles, hotel-scope writes additionally management-gated
      // in the handler, property-scoped, PII-redacted, caps-bounded — they only
      // read/write the hotel's own memory, never operational data.
      const memoryTools = ['forget', 'remember'];
      const base = GENERAL_VOICE_ROLES.has(role) ? ['log_complaint', 'log_found_item'] : [];
      // ai-approval-cards branch: the five new abilities (schedules, inventory,
      // reminders, lost&found lookup, recurring to-dos) are ALL chat-only — none
      // opt into voice, so this general-voice catalog is intentionally unchanged
      // by that branch. The mutation tools stay chat-only so their approval card
      // can never be bypassed by a misheard voice command; the read tools are
      // chat-only too (scoped to one reviewed surface for this branch).
      const expected = [
        ...(MANAGER_VOICE_ROLES.has(role) ? ['get_time_off_requests'] : []),
        ...base,
        ...memoryTools,
        // Confirm/cancel control tools are present in every voice mode + role.
        ...VOICE_CONTROL_TOOLS,
      ].sort();
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
    test(`role=${role} sees the maintenance-ticket tool + confirm/cancel in housekeeper_issue mode`, () => {
      const tools = getToolsForRole(role as never, 'voice', 'housekeeper_issue');
      // createMaintenanceWorkOrder is card-tier — it's HELD by the voice gate and
      // confirmed out loud, so the confirm/cancel control tools ride along in
      // this mode too (they carry no voiceModes → all modes).
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['createMaintenanceWorkOrder', ...VOICE_CONTROL_TOOLS].sort(),
        `housekeeper_issue mode for role=${role} surfaced an unexpected tool list. ` +
          'If you intentionally exposed more tools to this mode, audit them and update the snapshot.',
      );
    });
  }

  test('role=staff is NOT allowed to use the maintenance-ticket tool', () => {
    const tools = getToolsForRole('staff' as never, 'voice', 'housekeeper_issue');
    // staff still can't see createMaintenanceWorkOrder (not in its allowedRoles),
    // but the confirm/cancel control tools are role-open (ALL_ROLES) and appear.
    assert.ok(
      !tools.some((t) => t.name === 'createMaintenanceWorkOrder'),
      "'staff' role must not see createMaintenanceWorkOrder",
    );
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...VOICE_CONTROL_TOOLS].sort(),
      "'staff' in housekeeper_issue mode should see only the confirm/cancel control tools",
    );
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
    // housekeeping is in allowedRoles for createMaintenanceWorkOrder
    // (voiceModes:['housekeeper_issue']), log_complaint + log_found_item +
    // remember + forget (all voiceModes:['general']); with no mode the
    // voiceModes filter no-ops so all of them surface. (Compliance tools and
    // get_time_off_requests exclude the housekeeping role. The ai-approval-cards
    // branch's new tools are chat-only, so none appear here.)
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['cancel_pending_action', 'confirm_pending_action', 'createMaintenanceWorkOrder', 'forget', 'log_complaint', 'log_found_item', 'remember'],
      'No-mode getToolsForRole bypasses voiceModes filter — this is fine because executeTool re-checks mode.',
    );
  });
});
