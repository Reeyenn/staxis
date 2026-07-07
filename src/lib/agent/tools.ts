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
import type { CapabilityKey } from '@/lib/capabilities/registry';
import { canForProperty } from '@/lib/capabilities/server';
import {
  isSectionEnabled,
  type AppSection,
  type EnabledSections,
} from '@/lib/sections/registry';
import type { VoiceMode } from './voice-session';

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
    /** The caller's own department (staff.department) on this property, or null.
     *  Optional so background/eval constructors can omit it; absent → most-
     *  restrictive for non-managers. Gates 'dept'-scoped knowledge documents. */
    dept?: string | null;
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
  /** agent_conversations.id for this turn — lets memory writes record which
   *  conversation taught a fact (source_conversation_id). Optional; threaded
   *  from both the chat and voice routes. */
  conversationId?: string;
  /** Which surface is invoking this tool. REQUIRED so executeTool() can
   *  enforce per-tool surface opt-in (a tool without `surfaces: ['voice']`
   *  refuses a voice-surface call, etc.). Codex 2026-05-16 P0 fix
   *  (Pattern E — surface required at the type level so the compiler
   *  catches any caller that forgets). */
  surface: AgentSurface;
  /** Voice operating mode (only meaningful when surface === 'voice'). Tools
   *  may opt into specific voice modes via `voiceModes`; an unmatched mode
   *  causes executeTool to refuse. Feature #11 (housekeeper voice issue
   *  reporting) — a tool that only makes sense inside the housekeeper-issue
   *  mode declares `voiceModes: ['housekeeper_issue']` so it cannot be
   *  reached from a general voice session. */
  voiceMode?: VoiceMode;
  /** Room number hint forwarded from the UI on session mint. Tools that
   *  default a room argument (e.g. createMaintenanceWorkOrder) consult this
   *  when the user doesn't restate the room. Voice-only. */
  currentRoomNumber?: string | null;
  /** Voice-session id (agent_voice_sessions.id) — the canonical, server-
   *  minted identifier for this voice session. Tools use it as a stable
   *  idempotency key: createMaintenanceWorkOrder, for example, persists it
   *  on the new row and a unique partial index refuses a duplicate insert
   *  from a retried model call. Voice-only. Codex 2026-05-25 (MAJOR fix). */
  voiceSessionId?: string;
  /** The active hotel's resolved section on/off map, loaded once at the route
   *  boundary (getEnabledSections(propertyId)). executeTool consults it to
   *  refuse a tool whose `section` is turned off for this hotel — the
   *  defense-in-depth twin of the getToolsForRole section filter, mirroring how
   *  requiresCapability is double-enforced. FAIL-OPEN: undefined/null ⇒ treat
   *  every section as ON (a read hiccup never hides a live section). */
  enabledSections?: EnabledSections;
  /** The caller's spoken language ('en' | 'es'), resolved server-side from the
   *  staff row at the voice-brain boundary. Used ONLY for deterministic spoken
   *  copy in the voice control tools (confirm/cancel read-backs) — never for
   *  authorization. Absent → treat as 'en'. Voice-only. */
  voiceLang?: string | null;
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

/**
 * Surface types that can invoke tools. Each agent surface (chat UI,
 * voice agent, Clicky walkthrough) declares its surface when fetching
 * tools, and individual tools can opt in/out per surface.
 *
 * Longevity fix L3, 2026-05-13: future-proofs the registry for voice
 * and walkthrough surfaces. Default is 'chat' only — tools must
 * explicitly opt into other surfaces. Stops a voice-specific tool
 * (e.g. play_alert_sound) from being callable from the chat agent.
 */
export type AgentSurface = 'chat' | 'voice' | 'walkthrough';

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
   * Surfaces this tool is callable from. Defaults to `['chat']` — every
   * existing tool registered before L3 is implicitly chat-only.
   * Voice + walkthrough tools must opt in explicitly. Longevity L3.
   */
  surfaces?: readonly AgentSurface[];
  /**
   * Voice modes the tool opts into. Only consulted when `surface === 'voice'`.
   * Undefined means "all voice modes" (the standard voice catalog), matching
   * pre-feature-#11 behaviour. A list restricts the tool to those modes — e.g.
   * `voiceModes: ['housekeeper_issue']` makes the tool unreachable from a
   * general voice session, which is what we want for createMaintenanceWorkOrder.
   */
  voiceModes?: readonly VoiceMode[];
  /**
   * True when this tool MUTATES data (writes to DB, sends SMS, sends nudges).
   * False/undefined for read-only queries. Eval refusal checks derive the
   * "destructive tools" set from this flag at runtime, so adding a new
   * mutation tool automatically gets caught in refusal evals without
   * having to update a separate hardcoded list. Codex review fix D3.
   */
  mutates?: boolean;
  /**
   * Approval tier for the AI-assistant approval flow. REQUIRED on every
   * `mutates: true` tool (enforced by a completeness unit test) and MUST be
   * absent on read-only tools.
   *
   *   'quick' — a one-tap compact card ("Do it" / "Cancel"). For low-stakes,
   *             reversible, single-target floor actions (mark clean, DND, …).
   *   'card'  — a full centered card with editable fields + add-on checkboxes.
   *             For higher-consequence actions (send a message, log a
   *             complaint, post an announcement, …).
   *
   * The tier is read SERVER-SIDE when the pending-action row is written, so a
   * client can never downgrade a 'card' action to 'quick'. Both tiers go
   * through the same pending → resolve gate; only READ-ONLY tools execute
   * inline without approval. See src/lib/agent/approval.ts for the tier map +
   * per-tool summary builders.
   */
  approval?: 'quick' | 'card';
  /**
   * Per-hotel capability this tool requires (e.g. 'view_financials',
   * 'run_reports', 'view_wages'). When set, executeTool() enforces the SAME
   * Access-tab capability gate the HTTP layer uses (canForProperty), honoring
   * the manager-floor AND any per-hotel override an admin has set. Without
   * this the agent surface ignored the per-hotel restrictions the rest of the
   * app honors, so a manager an admin had switched OFF for financials could
   * still ask the copilot for revenue/budgets/wages. Security audit 2026-06-26.
   */
  requiresCapability?: CapabilityKey;
  /**
   * The app section this tool belongs to (one of the 8 per-hotel sections).
   * When a hotel has this section turned OFF, the tool is dropped from the
   * catalog handed to Claude (getToolsForRole) AND refused inside executeTool
   * as defense-in-depth — a back-door parallel to requiresCapability. Absent on
   * cross-cutting tools (memory, knowledge, reminders, PMS reads, walkthrough,
   * complaints, lost-and-found) which are NEVER section-gated. FAIL-OPEN: when
   * the hotel's section map is unavailable, every section is treated as ON.
   */
  section?: AppSection;
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

/** Look up a registered tool by name (or undefined). */
export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

/**
 * True when the named tool MUTATES data. Drives the approval gate — a mutation
 * tool_use is proposed (pending row + card), not executed inline. Unknown tools
 * are treated as non-mutating (the executor's own not-found guard handles them).
 */
export function isMutationTool(name: string): boolean {
  return registry.get(name)?.mutates === true;
}

/** The approval tier a mutation tool carries ('quick' | 'card'), or null. */
export function approvalTierFor(name: string): 'quick' | 'card' | null {
  return registry.get(name)?.approval ?? null;
}

/** Tools the given role is allowed to invoke on a given surface. This is
 *  what we hand to Claude.
 *
 *  Codex 2026-05-16 P0 fix (Pattern E): `surface` is REQUIRED — no default.
 *  The compiler now refuses any caller that forgets to declare its surface,
 *  closing the gap that let `/api/agent/voice-brain` silently inherit the
 *  full chat tool catalog. A tool without an explicit `surfaces` field
 *  defaults to chat-only (matching pre-L3 behaviour) so voice + walkthrough
 *  remain toolless until tools deliberately opt in.
 *
 *  Feature #11 (2026-05-24): when `surface === 'voice'` and a `voiceMode`
 *  is supplied, tools also filter on `voiceModes` — a tool with an explicit
 *  voiceModes list is hidden from any session whose mode isn't on it. The
 *  default (no `voiceModes` declared) means "all voice modes" so the
 *  existing voice catalog is unaffected.
 *
 *  Sections (WP7): when the caller passes the active hotel's `enabledSections`
 *  map, any tool tagged with a `section` that the hotel has turned OFF is
 *  dropped from the catalog so the copilot can't offer an action for a section
 *  that isn't live. FAIL-OPEN: when `enabledSections` is undefined/null (a read
 *  hiccup, or a caller that doesn't thread it) every section resolves to ON via
 *  isSectionEnabled, so the tool set is unchanged. */
export function getToolsForRole(
  role: AppRole,
  surface: AgentSurface,
  voiceMode?: VoiceMode,
  enabledSections?: EnabledSections,
): ToolDefinition[] {
  return Array.from(registry.values()).filter(t => {
    if (!t.allowedRoles.includes(role)) return false;
    const allowedSurfaces = t.surfaces ?? ['chat'];
    if (!allowedSurfaces.includes(surface)) return false;
    if (surface === 'voice' && t.voiceModes && voiceMode) {
      if (!t.voiceModes.includes(voiceMode)) return false;
    }
    // Section gate: drop tools whose section is turned off for this hotel.
    // isSectionEnabled treats a null/undefined map as all-ON (fail-open).
    if (t.section && !isSectionEnabled(enabledSections, t.section)) return false;
    return true;
  });
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
  // Codex 2026-05-16 P0 fix (Pattern E): the surface gate runs BEFORE the
  // role check. If the caller is `surface: 'voice'` and the tool didn't opt
  // in via `surfaces: ['voice']`, refuse. This is the safety net behind
  // `getToolsForRole`'s surface filter — even if a stale tool list leaks
  // through, the executor itself enforces the surface boundary.
  const allowedSurfaces = tool.surfaces ?? ['chat'];
  if (!allowedSurfaces.includes(ctx.surface)) {
    return {
      ok: false,
      error: `Tool ${name} is not available on the ${ctx.surface} surface.`,
    };
  }
  // Feature #11: voice-mode gate. Matches the getToolsForRole filter so
  // executeTool refuses a tool whose voiceModes list doesn't include the
  // current session mode, even if the model somehow hallucinated a call
  // for a tool it shouldn't see. Belt-and-braces against tool-list leaks.
  if (ctx.surface === 'voice' && tool.voiceModes && ctx.voiceMode) {
    if (!tool.voiceModes.includes(ctx.voiceMode)) {
      return {
        ok: false,
        error: `Tool ${name} is not available in this voice mode.`,
      };
    }
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
  // Per-hotel section gate (WP7). Defense-in-depth twin of the getToolsForRole
  // section filter, mirroring how requiresCapability is double-enforced below:
  // even if a stale tool list leaks a tool for a section this hotel has turned
  // off, the executor itself refuses it. FAIL-OPEN — isSectionEnabled treats an
  // undefined/null enabledSections (unavailable map, or a caller that doesn't
  // thread it) as every section ON, so a read hiccup never blocks a live tool.
  if (tool.section && !isSectionEnabled(ctx.enabledSections, tool.section)) {
    return {
      ok: false,
      error: `The ${tool.section} section is turned off for this hotel. Tell the user this part of the app is currently disabled here and don't try to complete the action another way.`,
    };
  }
  // Per-hotel capability gate (security audit 2026-06-26). Mirrors the HTTP
  // finance/reports gates (requireFinanceAccess → canForProperty) so the agent
  // surface can't be used to read data an admin has restricted for this role
  // at this property. Admin short-circuits to allowed inside canForProperty;
  // manager-floor caps (view_financials/view_wages/...) are refused for
  // line-staff roles regardless of overrides.
  if (tool.requiresCapability) {
    const allowed = await canForProperty(
      { role: ctx.user.role },
      tool.requiresCapability,
      ctx.propertyId,
    );
    if (!allowed) {
      return {
        ok: false,
        error: `Access to ${name} is restricted for your role at this property. Tell the user this information is limited to managers with the matching permission; do not attempt to retrieve it another way.`,
      };
    }
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
