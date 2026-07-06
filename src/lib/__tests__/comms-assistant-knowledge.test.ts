// The @Staxis thread assistant (Communications) can now answer from THIS hotel's
// Knowledge hub (SOPs · documents · contacts · calendar), reusing the exact same
// searchKnowledge / getDocumentSection functions the main bottom-right agent uses.
//
// This proves the wiring WITHOUT booting the model or a DB — the repo's seams are
// the exported tool catalog (ASSISTANT_TOOLS), the pure system-prompt builder
// (buildAssistantSystemPrompt), and the fail-closed role resolver
// (resolveAssistantRole) that feeds searchKnowledge. Role gating itself
// (manager-only content hidden from floor staff) is proven end-to-end here by
// composing resolveAssistantRole with canRoleSeeManagerOnly — the single decision
// searchKnowledge keys its visibility filter off (see knowledge-search-permissions).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSISTANT_TOOLS,
  buildAssistantSystemPrompt,
  resolveAssistantRole,
} from '@/lib/comms/assistant';
import { canRoleSeeManagerOnly } from '@/lib/knowledge/search-helpers';
import { ALL_ROLES, type AppRole } from '@/lib/roles';

// ── Tool catalog: model sees exactly the 3 actions + 2 read-only Knowledge tools ──

test('the assistant exposes both Knowledge-hub tools to the model', () => {
  const names = ASSISTANT_TOOLS.map((t) => t.name);
  assert.ok(names.includes('search_knowledge'), 'search_knowledge must be offered to the model');
  assert.ok(names.includes('fetch_document_section'), 'fetch_document_section must be offered to the model');
});

test('search_knowledge requires a query; fetch_document_section requires sourceType + sourceId', () => {
  const search = ASSISTANT_TOOLS.find((t) => t.name === 'search_knowledge')!;
  const fetch = ASSISTANT_TOOLS.find((t) => t.name === 'fetch_document_section')!;
  assert.deepEqual(search.input_schema.required, ['query']);
  assert.ok(fetch.input_schema.required?.includes('sourceType'));
  assert.ok(fetch.input_schema.required?.includes('sourceId'));
});

test('the 3 existing action tools are untouched (still present, same required fields)', () => {
  const byName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));
  // All three still there.
  for (const n of ['get_room_status', 'create_work_order', 'create_complaint']) {
    assert.ok(byName.has(n), `${n} must remain registered`);
  }
  // And their contracts are unchanged.
  assert.deepEqual(byName.get('get_room_status')!.input_schema.required, ['roomNumber']);
  assert.deepEqual(byName.get('create_work_order')!.input_schema.required, ['description']);
  assert.deepEqual(byName.get('create_complaint')!.input_schema.required, ['description']);
  // Exactly five tools total — nothing extra, nothing dropped.
  assert.equal(ASSISTANT_TOOLS.length, 5);
});

// ── System prompt: knowledge capability + citation + reply-language ──────────────

test('the system prompt tells the model it can answer from the Knowledge hub and MUST cite the source', () => {
  const sys = buildAssistantSystemPrompt({ threadText: '', langName: 'English' });
  assert.match(sys, /Knowledge hub/i, 'prompt should describe the Knowledge hub capability');
  assert.match(sys, /search_knowledge/, 'prompt should tell the model to use search_knowledge');
  // The citation instruction — quote the source by name.
  assert.match(sys, /cite the source by name/i, 'prompt must instruct the model to cite the source by name');
});

test('the system prompt instructs the model to reply in the asker language', () => {
  const en = buildAssistantSystemPrompt({ threadText: '', langName: 'English' });
  const es = buildAssistantSystemPrompt({ threadText: '', langName: 'Latin American Spanish' });
  assert.match(en, /reply in English/i);
  assert.match(es, /reply in Latin American Spanish/i);
});

test('the untrusted conversation is still wrapped as data in the prompt (injection guard intact)', () => {
  const sys = buildAssistantSystemPrompt({ threadText: 'Maria: hola', langName: 'English' });
  assert.match(sys, /<conversation>\nMaria: hola\n<\/conversation>/);
  assert.match(sys, /UNTRUSTED DATA/);
});

// ── Role gating flows through — a non-manager can NEVER retrieve manager-only ─────
//    content through this path. resolveAssistantRole is the value handed to
//    searchKnowledge; searchKnowledge keys manager-only visibility off
//    canRoleSeeManagerOnly(role). Compose the two to prove the property.

const FLOOR: AppRole[] = ['housekeeping', 'front_desk', 'maintenance'];
const MANAGEMENT: AppRole[] = ['admin', 'owner', 'general_manager'];

test('resolveAssistantRole passes a real role through unchanged', () => {
  for (const r of ALL_ROLES) {
    assert.equal(resolveAssistantRole(r), r, `${r} should pass through as itself`);
  }
});

test('resolveAssistantRole FAILS CLOSED on a missing/unknown role → floor role', () => {
  for (const bad of [undefined, '', 'superadmin', 'gm', 'MANAGER', 'admin ', null as unknown as string]) {
    const resolved = resolveAssistantRole(bad as string | undefined);
    assert.equal(
      canRoleSeeManagerOnly(resolved),
      false,
      `an invalid role (${JSON.stringify(bad)}) must resolve to a role that CANNOT see manager-only content`,
    );
  }
});

test('a housekeeping asker in a thread cannot reach manager-only Knowledge; a GM can', () => {
  // This is the value runStaxisAssistant hands to searchKnowledge for each caller.
  for (const r of FLOOR) {
    assert.equal(
      canRoleSeeManagerOnly(resolveAssistantRole(r)),
      false,
      `${r} asking in a thread must NOT retrieve managers-only documents`,
    );
  }
  for (const r of MANAGEMENT) {
    assert.equal(
      canRoleSeeManagerOnly(resolveAssistantRole(r)),
      true,
      `${r} asking in a thread may retrieve managers-only documents`,
    );
  }
});
