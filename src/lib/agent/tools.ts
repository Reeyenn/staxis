// ─── Agent tool registry ───────────────────────────────────────────────────
// Single source of truth for every action the agent can take. Tools live
// in `src/lib/agent/tools/*` and self-register on import via registerTool().
// The LLM wrapper (llm.ts) consults this registry to build the tool catalog
// it hands to Claude.
//
// Each tool encodes ONE capability: a thin wrapper over an existing API
// handler with its own auth check. Role enforcement is centralized in
// executeTool() so a misbehaving tool can't accidentally bypass it.
//
// Extensibility note: other features (Clicky walkthrough, future AI surfaces)
// register their tools against the SAME registry — see the agent layer plan.
// Just import their module from agent/index.ts and the registration fires.

import type { AppRole } from '@/lib/roles';

// ─── Public types ──────────────────────────────────────────────────────────

export interface ToolContext {
  /** The authenticated account making the call. */
  user: {
    uid: string;          // auth.users.id == accounts.data_user_id
    accountId: string;    // accounts.id
    username: string;
    displayName: string;
    role: AppRole;
    propertyAccess: string[];
  };
  /** Property the conversation is scoped to. */
  propertyId: string;
  /** The caller's `staff.id` on this property — resolved at the route
   *  boundary from `staff.auth_user_id = user.uid`. Null when the
   *  account isn't linked to a staff row (e.g. an admin/owner who isn't
   *  on the floor). Tools that filter by `rooms.assigned_to` MUST use
   *  this, NOT `user.accountId` (they're different tables). */
  staffId: string | null;
  /** Request correlation id (echoed through to logs + API responses). */
  requestId: string;
  /** When true, mutation tools should run their pre-write validation
   *  (lookups, role checks, etc.) but SKIP the actual DB mutation —
   *  return synthetic success at the would-have-mutated boundary.
   *  Used by the eval runner so test-bank cases hit real lookup paths
   *  (e.g. findRoomByNumber for "made up room 99999") but don't touch
   *  prod data. Codex post-merge review 2026-05-13 (F2). */
  dryRun?: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Structured payload returned to the model. */
  data?: unknown;
  /** Human-readable error returned to the model (will become part of the chat). */
  error?: string;
}

export interface ToolDefinition<TArgs = unknown> {
  /** Stable identifier — what the model calls (e.g. "mark_room_clean"). */
  name: string;
  /** What the tool does, in plain English. Read by the model when picking which tool to use. */
  description: string;
  /** JSON Schema describing the args object the handler expects. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Roles allowed to invoke this tool. Anyone else gets a refusal returned to the model. */
  allowedRoles: readonly AppRole[];
  /**
   * True when this tool MUTATES data (writes to DB, sends SMS, sends nudges).
   * False/undefined for read-only queries. Eval refusal checks derive the
   * "destructive tools" set from this flag at runtime, so adding a new
   * mutation tool automatically gets caught in refusal evals without
   * having to update a separate hardcoded list. Codex review fix D3.
   */
  mutates?: boolean;
  /** Implementation — typically wraps an existing API handler. */
  handler: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}

// ─── Registry ──────────────────────────────────────────────────────────────
// Map-based, populated by tool modules at import time. Idempotent so HMR
// double-imports during dev don't throw.

const registry = new Map<string, ToolDefinition<unknown>>();

export function registerTool<TArgs>(tool: ToolDefinition<TArgs>): void {
  registry.set(tool.name, tool as ToolDefinition<unknown>);
}

/** All registered tools, regardless of role. Mostly for introspection / monitoring. */
export function listAllTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

/** Tools the given role is allowed to invoke. This is what we hand to Claude. */
export function getToolsForRole(role: AppRole): ToolDefinition[] {
  return Array.from(registry.values()).filter(t => t.allowedRoles.includes(role));
}

/**
 * Execute a tool by name. Centralizes the role check so a misbehaving tool
 * handler can't accidentally bypass it. Returns a structured ToolResult that
 * the agent loop feeds back to Claude as a tool_result message.
 *
 * Round-8 fix B3, 2026-05-13: this propertyAccess check is
 * defense-in-depth against future tool handlers that forget to filter
 * by ctx.propertyId. It does NOT defend against mid-conversation
 * revocation — the check reads ctx.user.propertyAccess captured at
 * request start, not a fresh DB row. A fresh DB read per tool call
 * would cost an extra round-trip for every tool invocation, which
 * is too expensive for the benefit. The route boundary's
 * userHasPropertyAccess runs once at request start and is sufficient
 * for the live-revocation case.
 *
 * Only `admin` bypasses — this matches userHasPropertyAccess
 * semantics. `owner` is NOT bypassed because an owner can be removed
 * from a specific property in their property_access array.
 */
export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, error: `Tool not found: ${name}. Available tools are listed in your system prompt.` };
  }
  if (!tool.allowedRoles.includes(ctx.user.role)) {
    return {
      ok: false,
      error: `Your role (${ctx.user.role}) is not allowed to use ${name}. Explain to the user that this action requires a different role.`,
    };
  }
  // Defense-in-depth on the cached propertyAccess. Admins bypass via
  // route-boundary userHasPropertyAccess; every other role (including
  // owner) is filtered by their property_access array.
  if (
    ctx.user.role !== 'admin' &&
    !ctx.user.propertyAccess.includes(ctx.propertyId)
  ) {
    return {
      ok: false,
      error: 'Property access for this conversation is not in your account. The user must restart the conversation from a property they currently have access to.',
    };
  }
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Anthropic format adapter ──────────────────────────────────────────────
// Claude's tools API expects a specific shape. Build it from our registry.

export interface AnthropicToolFormat {
  name: string;
  description: string;
  input_schema: ToolDefinition['inputSchema'];
  // The Anthropic API supports `cache_control: { type: 'ephemeral' }` on
  // the LAST tool in the array — that breakpoint caches the entire tools
  // array. ~3000 tokens of descriptions stay cached across turns.
  // Codex review fix G3.
  cache_control?: { type: 'ephemeral' };
}

export function toAnthropicTools(tools: ToolDefinition[]): AnthropicToolFormat[] {
  // Sort alphabetically by name so the cache_control breakpoint position
  // is independent of registry insertion order (which depends on import
  // order in tools/index.ts). Without this sort, adding a new `import './foo'`
  // anywhere except the end of tools/index.ts shifts the "last tool" — and
  // so the cache breakpoint hash — invalidating Anthropic's prompt cache for
  // every existing conversation's next turn. Silent 10-30% cost regression
  // until the tool list stabilizes. Round-8 fix B5, 2026-05-13.
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((t, idx) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    // Anthropic caches the prefix up to and including the marked block.
    // Marking the LAST tool with cache_control caches the entire tools
    // array for this conversation, identical to how we mark the stable
    // system block. Saves ~10–15% of input tokens on every multi-turn
    // request after the first.
    ...(idx === sorted.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}
