/**
 * The hermetic half of the agent eval bank, wired into `npm test` (and so into
 * the Tests workflow) by nothing more than living in this directory.
 *
 * Each case drives a REAL agent turn — real prompt assembly, real tool
 * dispatch, real approval gate — against a scripted model. No Anthropic call,
 * no network, no database, so it is free to run on every commit.
 *
 * What this gates: our runtime's behaviour given a fixed model output.
 * What it does NOT gate: whether the model still picks the right tool. That is
 * the live bank (`npm run agent:evals`). Do not report "evals are gated" as if
 * both halves were covered — see src/lib/agent/evals/hermetic-runner.ts.
 *
 * Alongside the cases, this file holds the registry-DERIVED invariants: rules
 * expressed over every registered tool, so a NEW tool is covered the moment it
 * is added rather than when somebody remembers to write a case for it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { EVAL_CASES } from '@/lib/agent/evals/test-bank';
import {
  HERMETIC_ACCOUNT_ID,
  HERMETIC_PROPERTY_ID,
  hermeticMemoryRow,
  runHermetic,
} from '@/lib/agent/evals/hermetic-runner';
import { createFakeModel } from '@/lib/agent/evals/fake-model';
import { getToolsForRole, listAllTools } from '@/lib/agent/tools';
import { validateToolArgs } from '@/lib/agent/validate-tool-args';
import { formatMemoryForPrompt, MAX_MEMORY_ENTRIES } from '@/lib/agent/memory-context';
import type { AppRole } from '@/lib/roles';
import { installAgentToolAuthorityTestStore } from './helpers/agent-tool-authority';
import '@/lib/agent/tools/index';

const HERMETIC = EVAL_CASES.filter(c => c.mode === 'hermetic');
const LIVE = EVAL_CASES.filter(c => c.mode === 'live');

describe('agent eval bank — hermetic cases', () => {
  // "Hermetic" has to be enforced, not asserted in a comment. Any outbound
  // fetch during a case — an Anthropic call the fake failed to intercept, a
  // Supabase read from an unstubbed handler — throws and fails that case.
  // Without this, the bank could quietly start costing money and needing a
  // database, which is exactly how a CI gate becomes a CI liability.
  const realFetch = globalThis.fetch;
  let activeRole: AppRole = 'general_manager';
  let restoreAuthority: (() => void) | null = null;
  before(() => {
    globalThis.fetch = (async (input: unknown) => {
      throw new Error(`hermetic eval attempted network I/O: ${String(input)}`);
    }) as typeof globalThis.fetch;
    restoreAuthority = installAgentToolAuthorityTestStore(() => [{
      accountId: HERMETIC_ACCOUNT_ID,
      authUserId: HERMETIC_ACCOUNT_ID,
      role: activeRole,
      propertyIds: [HERMETIC_PROPERTY_ID],
      portfolioIntelligenceRead: true,
    }]);
  });
  after(() => {
    restoreAuthority?.();
    restoreAuthority = null;
    globalThis.fetch = realFetch;
  });

  test('the bank actually contains hermetic cases', () => {
    assert.ok(HERMETIC.length >= 10, `expected ≥10 hermetic cases, found ${HERMETIC.length}`);
  });

  for (const c of HERMETIC) {
    test(`[${c.category}] ${c.name}`, async () => {
      assert.ok(c.hermetic, `case ${c.name} is mode:'hermetic' but carries no hermetic spec`);
      activeRole = c.role;
      const result = await runHermetic({
        role: c.role,
        input: c.input,
        script: c.hermetic!.script,
        fixture: c.hermetic!.fixture,
        approvalMode: c.hermetic!.approvalMode,
        history: c.hermetic!.history,
        newUserMessage: c.hermetic!.newUserMessage,
      });
      assert.equal(
        result.errorMessage,
        null,
        `stream errored: ${result.errorMessage ?? ''}`,
      );
      const failure = c.hermetic!.assert(result);
      assert.equal(failure, null, failure ?? '');
    });
  }
});

describe('agent eval bank — structural rules', () => {
  test('case names are unique (origin/provenance depends on it)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const c of EVAL_CASES) {
      if (seen.has(c.name)) dupes.push(c.name);
      seen.add(c.name);
    }
    assert.deepEqual(dupes, [], `duplicate eval case name(s): ${dupes.join(', ')}`);
  });

  test('every case declares a mode and an origin', () => {
    for (const c of EVAL_CASES) {
      assert.ok(c.mode === 'hermetic' || c.mode === 'live', `${c.name}: bad mode`);
      assert.ok(c.origin, `${c.name}: missing origin`);
    }
  });

  test('every live case carries exactly one expectation', () => {
    for (const c of LIVE) {
      const set = [c.expectedTool, c.expectedRefusal, c.expectedKeywords].filter(
        v => v !== undefined,
      );
      assert.ok(set.length >= 1, `${c.name}: live case with no expectation asserts nothing`);
    }
  });

  test('no live case was silently reclassified as hermetic', () => {
    // The bank had 18 live cases when the split landed (12 tool_routing +
    // 3 language + 2 role_enforcement + 1 safety). Reclassifying one to dodge
    // API spend would quietly delete model-judgment coverage.
    assert.ok(
      LIVE.length >= 18,
      `live bank shrank to ${LIVE.length} cases — model-judgment coverage was removed`,
    );
  });
});

describe('tool registry — invariants that auto-cover new tools', () => {
  test('no tool takes the property as a MODEL-supplied argument (DINV-1)', () => {
    // Tenancy comes from the server-side ToolContext, never from the model or
    // from an edited approval card. A tool whose schema declared propertyId
    // would make "which hotel" attacker-influenceable, and validateToolArgs
    // would then happily pass it through to the handler.
    const offenders: string[] = [];
    for (const tool of listAllTools()) {
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
        if (/^property(_?id)?$/i.test(key) || /^hotel(_?id)?$/i.test(key)) {
          offenders.push(`${tool.name}.${key}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `tool schema(s) accept a model-supplied property: ${offenders.join(', ')}`,
    );
  });

  test('edited approval args cannot smuggle a property key into a handler', () => {
    const tool = listAllTools().find(t => t.name === 'mark_room_clean');
    assert.ok(tool, 'mark_room_clean is not registered');
    const v = validateToolArgs(tool!, {
      roomNumber: '302',
      propertyId: '22222222-2222-4222-8222-222222222222',
      property_id: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(v.ok, true, v.error);
    assert.equal('propertyId' in v.args, false, 'propertyId survived validation');
    assert.equal('property_id' in v.args, false, 'property_id survived validation');
  });

  test('every mutating tool a housekeeper can reach is explicitly classified', () => {
    // Floor staff SHOULD be able to mark their own rooms. The point is that a
    // NEW mutation tool reachable by housekeeping fails this test until someone
    // consciously adds it here — the classification cannot be forgotten.
    //
    // Snapshot of the CURRENT classification (2026-07-24). Each entry is a
    // deliberate product decision, not an accident:
    //   floor work        — mark_room_clean, reset_room, toggle_dnd, flag_issue,
    //                       request_help, createMaintenanceWorkOrder
    //   own-shift logging — log_found_item, add_logbook_entry, create_todo,
    //                       log_complaint, report_lost_item
    //   copilot memory    — remember, forget (scoped to the caller)
    //   staff-to-staff    — send_message (sends AS the housekeeper to a
    //                       colleague on the same property; card-tier approval)
    const HOUSEKEEPING_MUTATIONS_ALLOWED = new Set([
      'mark_room_clean',
      'reset_room',
      'toggle_dnd',
      'flag_issue',
      'request_help',
      'remember',
      'forget',
      'report_lost_item',
      'log_found_item',
      'log_complaint',
      'add_logbook_entry',
      'create_todo',
      'send_message',
      'createMaintenanceWorkOrder',
    ]);
    const reachable = getToolsForRole('housekeeping', 'chat')
      .filter(t => t.mutates === true)
      .map(t => t.name);
    const unclassified = reachable.filter(n => !HOUSEKEEPING_MUTATIONS_ALLOWED.has(n));
    assert.deepEqual(
      unclassified,
      [],
      `mutation tool(s) newly reachable by housekeeping: ${unclassified.join(', ')}. ` +
      'Add each to the allowlist above (and say why) or restrict allowedRoles.',
    );
  });

  test('every mutating tool declares how a human approves it', () => {
    // Two shapes, and every mutation must be one of them:
    //   a card    `approval` tier — the gate holds the call, a person taps it;
    //   in chat   `confirmInChat` — the tool proposes, reads back, and writes
    //             only after the route records a message from the person since
    //             (src/lib/agent/chat-confirm.ts).
    // A mutation that is NEITHER would execute the moment the model asks for it.
    const missing = listAllTools()
      .filter(t => t.mutates === true && !t.approval && t.confirmInChat !== true)
      .map(t => t.name);
    assert.deepEqual(missing, [], `mutating tool(s) a human never has to approve: ${missing.join(', ')}`);
    // And the two are mutually exclusive — a tier on a chat-confirming tool
    // describes a card that is never drawn.
    const both = listAllTools()
      .filter(t => t.confirmInChat === true && !!t.approval)
      .map(t => t.name);
    assert.deepEqual(both, [], `these claim both gates: ${both.join(', ')}`);
  });
});

describe('prompt assembly determinism', () => {
  test('memory truncation is deterministic for the same input', () => {
    // A nondeterministic truncation makes every downstream prompt assertion
    // flaky, and flaky evals get deleted rather than fixed.
    const rows = Array.from({ length: MAX_MEMORY_ENTRIES + 15 }, (_, i) =>
      hermeticMemoryRow({
        id: `5555555${i % 10}-5555-4555-8555-5555555555${String(i).padStart(2, '0')}`,
        topic: `t-${i}`,
        content: `note ${i}`,
        updatedAt: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
      }),
    );
    const a = formatMemoryForPrompt(rows);
    const b = formatMemoryForPrompt([...rows].reverse());
    assert.equal(a, b, 'memory block changed when the input rows were reordered');
  });
});

describe('fake model harness', () => {
  test('under-scripting throws instead of passing vacuously', async () => {
    const fake = createFakeModel([]);
    await assert.rejects(
      async () =>
        fake.client.messages.create(
          { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
          {},
        ),
      /script has only 0/,
    );
  });

  test('records what the model was shown', async () => {
    const fake = createFakeModel([{ blocks: [{ type: 'text', text: 'ok' }] }]);
    await fake.client.messages.create(
      {
        model: 'x',
        max_tokens: 10,
        system: [{ type: 'text', text: 'SYSTEM-FIXTURE' }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      {},
    );
    assert.equal(fake.requests.length, 1);
    assert.match(fake.requests[0].systemText, /SYSTEM-FIXTURE/);
  });
});
