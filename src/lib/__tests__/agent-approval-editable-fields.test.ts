/**
 * Drift guard: the ApprovalOverlay "Adjust" panel's EDITABLE_FIELDS must only
 * reference arg keys that ACTUALLY exist on each tool's inputSchema.properties.
 *
 * If a tool's schema is renamed (e.g. `message` → `body`) but EDITABLE_FIELDS
 * isn't updated, the Adjust panel would edit a phantom field — validateToolArgs
 * would drop it and the edit would silently no-op. This test binds the two so a
 * rename can't ship half-done. It also asserts every tool that has editable
 * fields is a real, tiered mutation tool (a stray entry is dead UI).
 *
 * EDITABLE_FIELDS lives in the plain approval-types module (not the .tsx) so
 * this test needs no React.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getTool, approvalTierFor } from '@/lib/agent/tools';
import '@/lib/agent/tools/index'; // register everything
import { EDITABLE_FIELDS } from '@/components/agent/approval-types';

describe('ApprovalOverlay EDITABLE_FIELDS ↔ tool inputSchema', () => {
  test('every editable field key is a real inputSchema property of its tool', () => {
    const problems: string[] = [];
    for (const [toolName, fields] of Object.entries(EDITABLE_FIELDS)) {
      const tool = getTool(toolName);
      if (!tool) {
        problems.push(`${toolName}: not a registered tool`);
        continue;
      }
      // Only gated (tiered) mutation tools get a card + Adjust panel.
      if (approvalTierFor(toolName) === null) {
        problems.push(`${toolName}: has editable fields but no approval tier`);
      }
      const props = tool.inputSchema.properties ?? {};
      for (const f of fields) {
        if (!(f.key in props)) {
          problems.push(`${toolName}.${f.key}: not in inputSchema.properties`);
        }
      }
    }
    assert.deepEqual(problems, [], `EDITABLE_FIELDS drift:\n  ${problems.join('\n  ')}`);
  });

  test('enum editable fields match the tool schema enum (when the schema declares one)', () => {
    for (const [toolName, fields] of Object.entries(EDITABLE_FIELDS)) {
      const tool = getTool(toolName);
      if (!tool) continue;
      const props = tool.inputSchema.properties as Record<string, { enum?: unknown[] }>;
      for (const f of fields) {
        if (f.kind !== 'enum') continue;
        const schemaEnum = props[f.key]?.enum;
        if (!Array.isArray(schemaEnum)) continue; // schema doesn't constrain it
        const optionSet = new Set(f.options ?? []);
        const missing = schemaEnum.filter((v) => !optionSet.has(String(v)));
        assert.deepEqual(
          missing, [],
          `${toolName}.${f.key} enum options miss schema values: ${missing.join(', ')}`,
        );
      }
    }
  });
});
