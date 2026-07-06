/**
 * validateToolArgs — schema validation for approved-with-edits actions.
 *
 * When the user taps "Adjust" on a card and edits fields, the merged args are
 * validated against the tool's inputSchema before we execute. A client can POST
 * anything, so this is the security gate on edited args.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ToolDefinition } from '@/lib/agent/tools';
import { validateToolArgs } from '@/lib/agent/validate-tool-args';

function fakeTool(schema: ToolDefinition['inputSchema']): ToolDefinition {
  return {
    name: 'fake', description: '', inputSchema: schema, allowedRoles: ['admin'],
    handler: async () => ({ ok: true }),
  };
}

describe('validateToolArgs', () => {
  test('accepts a valid string + required field', () => {
    const tool = fakeTool({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'] });
    const r = validateToolArgs(tool, { message: 'hello' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { message: 'hello' });
  });

  test('rejects a missing required field', () => {
    const tool = fakeTool({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'] });
    const r = validateToolArgs(tool, { other: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /required/);
  });

  test('rejects an emptied required string (clear-and-approve)', () => {
    const tool = fakeTool({ type: 'object', properties: { message: { type: 'string' } }, required: ['message'] });
    const r = validateToolArgs(tool, { message: '   ' });
    assert.equal(r.ok, false);
  });

  test('rejects a wrong type', () => {
    const tool = fakeTool({ type: 'object', properties: { count: { type: 'number' } } });
    const r = validateToolArgs(tool, { count: 'not-a-number' });
    assert.equal(r.ok, false);
  });

  test('coerces a numeric string to a number', () => {
    const tool = fakeTool({ type: 'object', properties: { value: { type: 'number' } } });
    const r = validateToolArgs(tool, { value: '7.4' });
    assert.equal(r.ok, true);
    assert.strictEqual(r.args.value, 7.4);
  });

  test('rejects an empty / whitespace string for a number field (Number("") trap)', () => {
    const tool = fakeTool({ type: 'object', properties: { value: { type: 'number' } } });
    // Number('') and Number('  ') both coerce to 0 — must be rejected, not
    // silently passed through as zero.
    assert.equal(validateToolArgs(tool, { value: '' }).ok, false);
    assert.equal(validateToolArgs(tool, { value: '   ' }).ok, false);
    // A real zero still passes.
    assert.equal(validateToolArgs(tool, { value: 0 }).ok, true);
    assert.strictEqual(validateToolArgs(tool, { value: '0' }).args.value, 0);
  });

  test('enforces enum membership', () => {
    const tool = fakeTool({ type: 'object', properties: { priority: { type: 'string', enum: ['normal', 'high', 'urgent'] } } });
    assert.equal(validateToolArgs(tool, { priority: 'high' }).ok, true);
    assert.equal(validateToolArgs(tool, { priority: 'nope' }).ok, false);
  });

  test('drops unknown keys not in the schema (no smuggling)', () => {
    const tool = fakeTool({ type: 'object', properties: { message: { type: 'string' } } });
    const r = validateToolArgs(tool, { message: 'ok', senderStaffId: 'attacker-id', __proto__: {} });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.args), ['message']);
    assert.equal('senderStaffId' in r.args, false);
  });

  test('coerces boolean strings', () => {
    const tool = fakeTool({ type: 'object', properties: { on: { type: 'boolean' } } });
    assert.strictEqual(validateToolArgs(tool, { on: 'true' }).args.on, true);
    assert.strictEqual(validateToolArgs(tool, { on: 'false' }).args.on, false);
    assert.equal(validateToolArgs(tool, { on: 'maybe' }).ok, false);
  });

  test('rejects a non-object candidate', () => {
    const tool = fakeTool({ type: 'object', properties: {} });
    assert.equal(validateToolArgs(tool, 'string').ok, false);
    assert.equal(validateToolArgs(tool, null).ok, false);
    assert.equal(validateToolArgs(tool, [1, 2]).ok, false);
  });
});
