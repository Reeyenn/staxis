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
 *
 * ONE CLASS OF MUTATION IS OUTSIDE ALL OF THAT, and it is asserted rather than
 * assumed: a tool declaring `confirmInChat` does not go to a card at all. It
 * proposes, reads back, and writes only once the route has recorded a message
 * from the human since that read-back (src/lib/agent/chat-confirm.ts). A tier
 * on one of those would be dead configuration describing a card nobody draws —
 * and, worse, the card's "Do it" would approve the PROPOSE call, which writes
 * nothing, leaving the real write ungated. So they must carry NO tier, and the
 * set that skips the tier rule must be exactly the set that confirms in chat.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  listAllTools,
  approvalTierFor,
  confirmsInChat,
  getToolsForRole,
  getTool,
  isMutationTool,
} from '@/lib/agent/tools';
import type { AppRole } from '@/lib/roles';
import '@/lib/agent/tools/index'; // register everything
import { buildActionSummary } from '@/lib/agent/approval';
import { partitionGatedCalls } from '@/lib/agent/llm';

describe('approval tier completeness', () => {
  test('adjust_stock order-intent approval copy disclaims delivery and purchase logging', () => {
    const args = { itemName: 'soap', markOrdered: true };
    assert.match(buildActionSummary('adjust_stock', args, 'en'), /order intent.*no delivery or purchase logged/i);
    assert.match(buildActionSummary('adjust_stock', args, 'es'), /intención.*no registra entrega ni compra/i);
  });

  test('every card-gated mutation tool has an approval tier (via the registry)', () => {
    const missing = listAllTools()
      .filter((t) => t.mutates === true && t.confirmInChat !== true)
      .filter((t) => t.approval !== 'quick' && t.approval !== 'card')
      .map((t) => t.name);
    assert.deepEqual(missing, [], `mutation tools missing an approval tier: ${missing.join(', ')}`);
  });

  test('a chat-confirming mutation carries no tier, and confirmsInChat() agrees', () => {
    const inChat = listAllTools().filter((t) => t.confirmInChat === true);
    assert.ok(inChat.length > 0, 'the chat-confirm catalog vanished — is it still registered?');
    for (const t of inChat) {
      assert.equal(t.mutates, true, `${t.name} confirms in chat but is not declared a mutation`);
      assert.equal(
        t.approval,
        undefined,
        `${t.name} carries an approval tier it will never use — the card gate does not hold it`,
      );
      assert.equal(approvalTierFor(t.name), null);
      assert.equal(confirmsInChat(t.name), true);
    }
    // And nothing else claims the exemption.
    for (const t of listAllTools()) {
      if (t.confirmInChat === true) continue;
      assert.equal(confirmsInChat(t.name), false, `${t.name} is exempt from the card gate without declaring it`);
    }
  });

  test('the chat gate holds ordinary mutations and lets the chat-confirming ones run', () => {
    // The gate decision itself, not just the registry flags. Getting this
    // backwards has two failure modes and both are bad: holding a
    // `confirmInChat` tool would put a card in front of its PROPOSE call — which
    // writes nothing — and the human's tap would then approve the wrong half,
    // leaving the real write with no gate at all. Inlining an ordinary mutation
    // would run it with no gate whatsoever.
    const inChat = listAllTools().find((t) => t.confirmInChat === true)!;
    const carded = listAllTools().find((t) => t.mutates === true && t.confirmInChat !== true)!;
    const readOnly = listAllTools().find((t) => t.mutates !== true)!;

    const calls = [inChat, carded, readOnly].map((t, i) => ({ id: `c${i}`, name: t.name, args: {} }));
    const { held, inline } = partitionGatedCalls(calls, 'chat');
    assert.deepEqual(held.map((c) => c.name), [carded.name]);
    assert.deepEqual(inline.map((c) => c.name).sort(), [inChat.name, readOnly.name].sort());
  });

  test('no read-only tool carries an approval tier', () => {
    const stray = listAllTools()
      .filter((t) => t.mutates !== true && t.approval !== undefined)
      .map((t) => t.name);
    assert.deepEqual(stray, [], `read-only tools should not have a tier: ${stray.join(', ')}`);
  });

  test('approvalTierFor() returns the registry tier for every mutation tool', () => {
    for (const t of listAllTools()) {
      if (t.mutates !== true || t.confirmInChat === true) continue;
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

  test('every card-gated mutation tool has a bespoke bilingual summary', () => {
    for (const t of listAllTools()) {
      // A chat-confirming tool never renders a card, so it has no card copy to
      // write. Its read-back sentence is built by the handler, in both
      // languages, from the values it froze — and is asserted where that
      // happens (agent-chat-do-wires.integration.test.ts).
      if (t.mutates !== true || t.confirmInChat === true) continue;
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

  // `list_reminders` and `list_recurring_todos` merged into list_scheduled_items
  // in the 2026-07-27 catalog rebuild. The assertion they carried — a listing
  // tool must never acquire an approval tier — moves to the surviving tool
  // rather than being dropped.
  test('the new READ tools are registered and carry NO approval tier', () => {
    const byName = new Map(listAllTools().map((t) => [t.name, t]));
    for (const name of ['get_schedule', 'get_low_stock', 'list_scheduled_items', 'search_lost_found']) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is not registered`);
      assert.notEqual(tool!.mutates, true, `${name} should be read-only`);
      assert.equal(approvalTierFor(name), null, `${name} should have no approval tier`);
    }
  });

  // A retired name resolving to a MUTATION would be the dangerous alias bug:
  // a replayed history row calling `list_reminders` must still land on a read,
  // and approvalTierFor must answer for whatever it now resolves to rather than
  // returning null because the old name is absent from the registry.
  test('retired listing names still resolve, and still resolve to a read', () => {
    for (const retired of ['list_reminders', 'list_recurring_todos']) {
      const tool = getTool(retired);
      assert.ok(tool, `${retired} no longer resolves — replayed history would break`);
      assert.equal(tool!.name, 'list_scheduled_items');
      assert.notEqual(tool!.mutates, true, `${retired} must not resolve to a mutation`);
      assert.equal(approvalTierFor(retired), null);
      assert.equal(isMutationTool(retired), false);
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
