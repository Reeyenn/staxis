/**
 * Completeness of the AI-assistant approval tier map.
 *
 * The approval gate is only safe if EVERY mutation tool carries an approval
 * tier + a summary builder — otherwise a new mutation would either execute
 * without a card (if the gate somehow skipped it) or render a blank card. And
 * a read-only tool must NOT carry a tier (it runs inline, no approval).
 *
 * This test walks the live registry and asserts:
 *   1. every `mutates: true` tool has `approval` ∈ {quick, card} via the REGISTRY
 *      (the tool's own `approval:` field — the single source of truth)
 *   2. every `mutates: true` tool has a NON-generic summary in EN + ES
 *   3. no read-only tool has an `approval` tier
 *   4. approvalTierFor() reads the tier straight off the registry definition
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { listAllTools, approvalTierFor, getToolsForRole } from '@/lib/agent/tools';
import type { AppRole } from '@/lib/roles';
import '@/lib/agent/tools/index'; // register everything
import { buildActionSummary } from '@/lib/agent/approval';

describe('approval tier completeness', () => {
  test('every mutation tool has an approval tier (via the registry)', () => {
    const missing = listAllTools()
      .filter((t) => t.mutates === true && (t.approval !== 'quick' && t.approval !== 'card'))
      .map((t) => t.name);
    assert.deepEqual(missing, [], `mutation tools missing an approval tier: ${missing.join(', ')}`);
  });

  test('no read-only tool carries an approval tier', () => {
    const stray = listAllTools()
      .filter((t) => t.mutates !== true && t.approval !== undefined)
      .map((t) => t.name);
    assert.deepEqual(stray, [], `read-only tools should not have a tier: ${stray.join(', ')}`);
  });

  test('approvalTierFor() returns the registry tier for every mutation tool', () => {
    for (const t of listAllTools()) {
      if (t.mutates !== true) continue;
      // The registry `approval:` field IS the single source of truth; the
      // lookup helper must return exactly it (and never null for a mutation).
      assert.equal(
        approvalTierFor(t.name),
        t.approval,
        `approvalTierFor(${t.name})=${approvalTierFor(t.name)} but registry says ${t.approval}`,
      );
      assert.ok(approvalTierFor(t.name) !== null, `${t.name} has a null tier`);
    }
  });

  test('every mutation tool has a bespoke bilingual summary', () => {
    for (const t of listAllTools()) {
      if (t.mutates !== true) continue;
      // Pass representative args so builders that interpolate don't blow up.
      const args = {
        roomNumber: '101', room_number: '101', on: true, note: 'x', metric: 'pH', value: 7,
        equipment: 'AED', itemDescription: 'glasses', content: 'note', topic: 'x',
        staffName: 'Maria', decision: 'approve', description: 'AC broken', action: 'REPAIR',
        item: 'sink', recipient: 'Maria', message: 'hi', title: 'task', assignee: 'Ana',
        // Schedule / inventory / reminder / recurring-todo tool args.
        date: '2026-07-08', startTime: '08:00', endTime: '16:00',
        itemName: 'towels', newCount: 40, markOrdered: true,
        body: 'check the pool', fireAt: '2026-07-08T08:00:00-05:00',
        department: 'housekeeping', cadence: 'weekly', weekday: 1, priority: 'high',
      };
      const en = buildActionSummary(t.name, args, 'en');
      const es = buildActionSummary(t.name, args, 'es');
      assert.ok(en && en.length > 0, `${t.name} has an empty EN summary`);
      assert.ok(es && es.length > 0, `${t.name} has an empty ES summary`);
      // No bespoke builder → generic "Run <tool>" fallback. Fail those so a new
      // mutation tool forces the author to add a real summary.
      assert.notEqual(en, `Run ${t.name}`, `${t.name} has no bespoke EN summary (generic fallback)`);
      assert.notEqual(es, `Ejecutar ${t.name}`, `${t.name} has no bespoke ES summary (generic fallback)`);
      // EN and ES must differ (otherwise the ES branch was forgotten).
      assert.notEqual(en, es, `${t.name} EN and ES summaries are identical — ES translation missing`);
    }
  });

  test('the 4 new comms tools are registered as card-tier mutations', () => {
    const byName = new Map(listAllTools().map((t) => [t.name, t]));
    for (const name of ['send_message', 'create_todo', 'add_logbook_entry', 'post_announcement']) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is not registered`);
      assert.equal(tool!.mutates, true, `${name} should be a mutation`);
      assert.equal(tool!.approval, 'card', `${name} should be card-tier`);
    }
  });

  // ── Voice-surface safety (regression, item i) ──────────────────────────────
  // The approval gate ONLY runs on the chat surface (streamAgent with
  // approvalMode). The voice surface runs streamAgent WITHOUT approvalMode, so a
  // tiered mutation reachable from voice fires UN-GATED — no card.
  //
  // The 4 comms tools this feature adds (send_message / create_todo /
  // add_logbook_entry / post_announcement) are card-tier mutations that MUST NOT
  // leak onto voice, or they'd send messages / post announcements with no
  // confirmation. They declare no `surfaces` → default chat-only; this pins that
  // so a future edit can't accidentally add 'voice' and bypass the gate.
  //
  // NOTE: the voice-side gap this note used to describe is now CLOSED by the
  // voice approval gate (feature/voice-approval): card-tier voice mutations
  // (createMaintenanceWorkOrder, log_complaint) are HELD by streamAgent's
  // voiceApprovalMode and read back for a spoken "yes" before running; quick-
  // tier voice mutations still run inline. See the confirm/cancel control-tool
  // assertions below and agent-voice-approval-gate.test.ts.
  test('the new comms mutation tools are NOT exposed on the voice surface (un-gated bypass)', () => {
    const roles: AppRole[] = ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance', 'staff'];
    const NEW_COMMS = new Set(['send_message', 'create_todo', 'add_logbook_entry', 'post_announcement']);
    const leaked = new Set<string>();
    for (const role of roles) {
      for (const t of getToolsForRole(role, 'voice')) {
        if (NEW_COMMS.has(t.name)) leaked.add(t.name);
      }
    }
    assert.deepEqual(
      [...leaked],
      [],
      `these new card-tier comms tools are reachable UN-GATED on the voice surface: ${[...leaked].join(', ')}`,
    );
    // Belt-and-braces: they carry a tier AND are chat-only in the registry.
    for (const name of NEW_COMMS) {
      assert.equal(approvalTierFor(name), 'card', `${name} must be card-tier`);
    }
  });

  // ── New feature tools (schedules / inventory / reminders / recurring) ───────
  test('the new schedule + inventory + reminder + recurring mutation tools carry the expected tiers', () => {
    const byName = new Map(listAllTools().map((t) => [t.name, t]));
    const expected: Record<string, 'quick' | 'card'> = {
      // Schedules
      remove_from_shift: 'card',
      assign_shift: 'card',
      // Inventory
      adjust_stock: 'card',
      // Reminders
      create_reminder: 'card',
      cancel_reminder: 'quick',
      // Recurring to-dos
      create_recurring_todo: 'card',
      stop_recurring_todo: 'card',
    };
    for (const [name, tier] of Object.entries(expected)) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is not registered`);
      assert.equal(tool!.mutates, true, `${name} should be a mutation`);
      assert.equal(tool!.approval, tier, `${name} should be ${tier}-tier`);
    }
  });

  test('the new READ tools are registered and carry NO approval tier', () => {
    const byName = new Map(listAllTools().map((t) => [t.name, t]));
    for (const name of ['get_schedule', 'get_low_stock', 'list_reminders', 'list_recurring_todos', 'search_lost_found']) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is not registered`);
      assert.notEqual(tool!.mutates, true, `${name} should be read-only`);
      assert.equal(approvalTierFor(name), null, `${name} should have no approval tier`);
    }
  });

  // The new card/quick MUTATION tools must not leak onto the voice surface (the
  // approval gate only runs on chat) — same class of bug the comms guard covers.
  test('the new mutation tools are NOT exposed on the voice surface (un-gated bypass)', () => {
    const roles: AppRole[] = ['admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance', 'staff'];
    const NEW_MUTATIONS = new Set([
      'remove_from_shift', 'assign_shift', 'adjust_stock',
      'create_reminder', 'cancel_reminder', 'create_recurring_todo', 'stop_recurring_todo',
    ]);
    const leaked = new Set<string>();
    for (const role of roles) {
      for (const t of getToolsForRole(role, 'voice')) {
        if (NEW_MUTATIONS.has(t.name)) leaked.add(t.name);
      }
    }
    assert.deepEqual(
      [...leaked], [],
      `these new mutation tools are reachable UN-GATED on the voice surface: ${[...leaked].join(', ')}`,
    );
  });
});
