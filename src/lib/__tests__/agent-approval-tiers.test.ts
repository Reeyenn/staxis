/**
 * Completeness of the AI-assistant approval tier map.
 *
 * The approval gate is only safe if EVERY mutation tool carries an approval
 * tier + a summary builder — otherwise a new mutation would either execute
 * without a card (if the gate somehow skipped it) or render a blank card. And
 * a read-only tool must NOT carry a tier (it runs inline, no approval).
 *
 * This test walks the live registry and asserts:
 *   1. every `mutates: true` tool has `approval` ∈ {quick, card}
 *   2. every `mutates: true` tool has a NON-generic summary in EN + ES
 *   3. no read-only tool has an `approval` tier
 *   4. approvalTierFor() (registry metadata) agrees with APPROVAL_TIERS (the
 *      approval.ts map) for every tool
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { listAllTools, approvalTierFor } from '@/lib/agent/tools';
import '@/lib/agent/tools/index'; // register everything
import { approvalTierForTool, buildActionSummary } from '@/lib/agent/approval';

describe('approval tier completeness', () => {
  test('every mutation tool has an approval tier', () => {
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

  test('registry tier agrees with the approval.ts map', () => {
    for (const t of listAllTools()) {
      if (t.mutates !== true) continue;
      assert.equal(
        approvalTierFor(t.name),
        approvalTierForTool(t.name),
        `tier mismatch for ${t.name}: registry=${approvalTierFor(t.name)} map=${approvalTierForTool(t.name)}`,
      );
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
});
