// ─── Tool-args validation for approved-with-edits actions ──────────────────
//
// When a user taps "Adjust" on an action card and edits a field (e.g. the
// message text before it's sent), the edited args must be validated against the
// tool's own `inputSchema` BEFORE we execute — a client could POST anything.
// This is a small, focused JSON-Schema-subset validator (no zod — matches the
// codebase's hand-rolled api-validate.ts convention).
//
// We validate ONLY what the agent tool schemas actually use:
//   - top-level `type: 'object'` with `properties` + `required`
//   - per-property `type` ∈ string | number | boolean
//   - per-property `enum` (closed set)
//
// Nested objects/arrays aren't used by any current tool schema, so a property
// whose schema we don't understand is passed through untouched (fail-open on
// shape we can't reason about, fail-closed on the checks we CAN do). Unknown
// extra keys are dropped so a client can't smuggle fields the handler forwards.

import type { ToolDefinition } from './tools';

export interface ValidateResult {
  ok: boolean;
  args: Record<string, unknown>;
  error: string;
}

interface PropSchema {
  type?: string;
  enum?: unknown[];
}

export function validateToolArgs(
  tool: ToolDefinition,
  candidate: unknown,
): ValidateResult {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, args: {}, error: 'Edited fields must be an object.' };
  }
  const input = candidate as Record<string, unknown>;
  const props = (tool.inputSchema.properties ?? {}) as Record<string, PropSchema>;
  const required = tool.inputSchema.required ?? [];

  const out: Record<string, unknown> = {};

  for (const [key, rawSchema] of Object.entries(props)) {
    if (!(key in input)) continue;
    const value = input[key];
    // Undefined/null: drop it (treated as "not provided"); required check below
    // catches a missing required field.
    if (value === undefined || value === null) continue;

    const schema = rawSchema ?? {};
    const t = schema.type;

    // Enum membership (closed set) takes precedence — a value must be one of
    // the allowed options exactly.
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.includes(value)) {
        return { ok: false, args: {}, error: `"${key}" must be one of: ${schema.enum.map(String).join(', ')}.` };
      }
      out[key] = value;
      continue;
    }

    if (t === 'string') {
      if (typeof value !== 'string') {
        return { ok: false, args: {}, error: `"${key}" must be text.` };
      }
      out[key] = value;
    } else if (t === 'number') {
      // Accept a numeric string from a form input; coerce.
      const n = typeof value === 'number' ? value : (typeof value === 'string' ? Number(value) : NaN);
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, args: {}, error: `"${key}" must be a number.` };
      }
      out[key] = n;
    } else if (t === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      else if (value === 'true') out[key] = true;
      else if (value === 'false') out[key] = false;
      else return { ok: false, args: {}, error: `"${key}" must be true or false.` };
    } else {
      // Unknown/unsupported schema shape — pass the value through untouched.
      out[key] = value;
    }
  }

  // Required fields must be present + non-empty (empty string counts as missing
  // for a required string, so "clear the message and approve" is refused).
  for (const key of required) {
    const v = out[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      return { ok: false, args: {}, error: `"${key}" is required.` };
    }
  }

  return { ok: true, args: out, error: '' };
}
