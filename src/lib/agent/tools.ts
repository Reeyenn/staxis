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
import { scopedDb, type ScopedDb } from './scoped-db';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { freshnessAgeMinutes, freshnessTier } from '@/lib/pms/feed-status';
import {
  isSectionEnabled,
  type AppSection,
  type EnabledSections,
} from '@/lib/sections/registry';

// VoiceMode used to live in the ElevenLabs voice-session module (removed
// 2026-07-15 when the "Talk to Staxis" voice feature + ElevenLabs were torn
// out). The dedicated voice surface no longer has a live entry point, but the
// tool registry's generic surface/voiceMode plumbing is still referenced by
// chat/walkthrough provenance logic, so the type stays here as its home.
export type VoiceMode = 'general' | 'housekeeper_issue' | 'compliance';

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The company a portfolio turn is answering for, and the hotels the spine said
 * it covers. Carried on ToolContext, resolved at the route boundary, and
 * re-verified inside every portfolio tool.
 */
export interface PortfolioToolScope {
  organizationId: string;
  organizationName: string | null;
  /** Sorted, from `resolvePortfolioAccess`. Never from a request body. */
  propertyIds: string[];
}

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
  /** Voice-session id — the server-minted identifier for a voice session,
   *  used as a stable idempotency key so a retried model call can't file the
   *  same ticket twice. Voice-only, and INERT: the voice surface was removed
   *  (a500fa02), and migration 0352 dropped its backing table plus the
   *  pms_work_orders_v2 columns that stored it. Nothing assigns or reads this
   *  today; it is kept as the seam a future voice surface would plug into.
   *  Codex 2026-05-25 (MAJOR fix). */
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
  /**
   * Cross-hotel chat (2026-07-26). Present ONLY on a portfolio-surface turn,
   * and set ONLY by the portfolio route after the whole gate stack passed:
   * requireSession → loadManagerCaller → a company-scope hat at this company
   * → that company's `cross_hotel_ai_chat` setting is on.
   *
   * A tool declaring `surfaces: ['portfolio']` is REFUSED by executeTool when
   * this is absent, so a portfolio tool cannot execute on a context that never
   * went through the company gate — including the per-hotel chat route's
   * context, the approval-resolve route's, and the eval harness's.
   *
   * The tools do NOT trust it. Each one re-resolves the caller's coverage
   * through the spine before reading anything (see tools/portfolio.ts): this
   * field decides WHICH company is being asked about, not what the answer is
   * allowed to include.
   */
  portfolio?: PortfolioToolScope;
  /** When true, mutation tools should run their pre-write validation
   *  (lookups, role checks, etc.) but SKIP the actual DB mutation —
   *  return synthetic success at the would-have-mutated boundary.
   *  Used by the eval runner so test-bank cases hit real lookup paths
   *  (e.g. findRoomByNumber for "made up room 99999") but don't touch
   *  prod data. Codex post-merge review 2026-05-13 (F2). */
  dryRun?: boolean;
}

/**
 * What a tool handler actually receives: the ToolContext the route built, plus
 * `db` — a database accessor that can only reach `ctx.propertyId` (see
 * `scoped-db.ts`). Handlers use `ctx.db.from(...)` instead of importing the
 * service-role client, so the hotel filter cannot be forgotten.
 *
 * `ToolContext` itself is deliberately UNCHANGED: every caller that builds a
 * context (llm.ts, the resolve-action route, the eval harness, every test)
 * keeps compiling untouched. `db` is attached here, at the one place that runs
 * a handler.
 *
 * It is a lazy getter on purpose — a tool that never touches the database
 * (surface-gate stubs, walkthrough tools) must not be forced to have a
 * well-formed property UUID.
 */
export type ToolHandlerContext = ToolContext & { readonly db: ScopedDb };

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
 *
 * 'portfolio' (2026-07-26, cross-hotel chat) is why this mechanism was worth
 * having. Every one of the ~70 existing tools declares no `surfaces` and is
 * therefore chat-only, so the portfolio catalog is EMPTY of them by
 * construction — not by a filter someone has to maintain. The two catalogs are
 * disjoint in both directions: `getToolsForRole` never offers a hotel tool on
 * the portfolio surface, and `executeTool` refuses one even if a stale tool
 * list leaked it. That disjointness is the wall, and it is the reason this
 * surface did NOT need a second tool registry or a second tool loop.
 */
export type AgentSurface = 'chat' | 'voice' | 'walkthrough' | 'portfolio';

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
   * This tool runs its OWN confirmation inside the conversation, so the
   * approval-card gate must not hold it (`partitionGatedCalls`).
   *
   * It is not an exemption from confirming — it is a different confirm. A
   * `confirmInChat` tool is two calls: the first validates, writes nothing, and
   * returns a structured read-back plus a server-minted token; the second
   * writes, and only when `takeConfirmation` (src/lib/agent/chat-confirm.ts)
   * finds a `role='user'` message recorded AFTER the read-back. The human's own
   * message is the trigger in both designs; here it is typed rather than
   * tapped, which is the point — "set up the water heater flush every six
   * months" and "yes, that's right" is a conversation, and a card in the middle
   * of it is a different product.
   *
   * The tools still declare `mutates: true`, because they do mutate: the eval
   * refusal bank derives its destructive-tool set from that flag, and a DO tool
   * missing from it would be untested exactly where it matters.
   *
   * Do NOT set this on a tool that writes on its first call. The card gate is
   * the default for a reason, and this flag turns it off.
   */
  confirmInChat?: true;
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
  /**
   * A2 (data-age honesty) — does this tool's answer describe PMS data that
   * arrives in scheduled reports rather than live?
   *
   *   'stamped'     — yes. executeTool merges `asOf` / `asOfSource` /
   *                   `dataAgeMinutes` / `dataFreshness` into the payload after
   *                   the handler returns, so the model can quote the as-of
   *                   time. Read-only tools only.
   *   'independent' — no. The answer comes from Staxis's own tables (inventory,
   *                   cleaning events, time-off, knowledge), which ARE live.
   *
   * REQUIRED on every read-only tool in a file that reads a `pms_*` table
   * (directly or through mergePmsRoomsForDate / fetchTodayPropertyCounts) —
   * enforced by `agent-pms-freshness-completeness.test.ts`. Declaring
   * 'independent' explicitly is what makes "this tool doesn't need it" a
   * recorded decision instead of a forgotten one. MUST be absent on
   * `mutates: true` tools (a proposal card has no data age).
   */
  pmsFreshness?: 'stamped' | 'independent';
  /** Implementation — typically wraps an existing API handler. Receives the
   *  hotel-scoped database accessor as `ctx.db`. */
  handler: (args: TArgs, ctx: ToolHandlerContext) => Promise<ToolResult>;
}

// ─── Registry ──────────────────────────────────────────────────────────────
// Map-based, populated by tool modules at import time. Idempotent so HMR
// double-imports during dev don't throw.

const registry = new Map<string, ToolDefinition<unknown>>();

export function registerTool<TArgs>(tool: ToolDefinition<TArgs>): void {
  registry.set(tool.name, tool as ToolDefinition<unknown>);
}

// ─── Retired names (aliases) ────────────────────────────────────────────────
// The 2026-07-27 catalog rebuild merged overlapping tools and deleted dead
// stubs. Those wire-names did not simply vanish: they are recorded in three
// places that outlive the code — `agent_messages.tool_name` (every past turn),
// the decision corpus, and pinned eval cases. A name that resolves to nothing
// turns all of that history into "Tool not found", which is how a merge
// quietly destroys the record of what the assistant used to do.
//
// So a retired name stays CALLABLE, mapped to whichever surviving tool now
// answers that question. Aliases are deliberately NOT in `registry`, so:
//   • `listAllTools()` returns only live tools — the tenant-isolation sweep
//     walks the real catalog, not a doubled one;
//   • `toAnthropicTools()` never offers a retired name to the model, so the
//     catalog the model reads keeps shrinking even though history keeps
//     resolving.
//
// Every entry states what it was and why it went. `agent-tool-catalog-audit`
// fails the build if an alias points at a name that is not registered, or
// collides with a live tool.
export const TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  // ── Dead stubs: no data source ever existed behind them ──
  // Both returned a fixed "not yet integrated" note and no figures. The
  // checkbook summary is the tool that actually reports revenue (from the PMS
  // when it exposes it) plus expenses, profit and budgets.
  ['get_revenue', 'get_finance_summary'],
  ['get_financial_report', 'get_finance_summary'],
  // Returned "multi-property comparison is not enabled". It IS enabled now —
  // on the portfolio surface. Pointing here makes a per-hotel call fail with
  // the portfolio refusal ("ask this from the company view"), which is the
  // true answer rather than the stale one.
  ['compare_properties', 'portfolio_compare'],

  // ── Merged: two tools that read the same rows and answered the same question ──
  // Read `inventory` with `reorder_at` as the threshold; the Inventory tab and
  // get_low_stock both classify against `par_level`. Same table, one correct.
  ['get_inventory', 'get_low_stock'],
  // Both filtered today's merged rooms to the caller's own assignments;
  // get_my_rooms keeps the code-computed "next" behind `nextOnly`.
  ['list_my_rooms', 'get_my_rooms'],
  ['get_my_next_room', 'get_my_rooms'],
  // get_today_summary already returned occupancy; get_occupancy was the same
  // counts read with a second never-shrink total. The total logic moved over.
  ['get_occupancy', 'get_today_summary'],
  // Both read pms_reservations filtered to one terminal status over a lookback
  // window — the same query twice. One tool, `kind` selects (or returns both).
  ['get_recent_no_shows', 'get_lost_reservations'],
  ['get_recent_cancellations', 'get_lost_reservations'],
  // "What's scheduled?" had two candidate tools and the model had to guess
  // which kind the user meant before it had seen either list.
  ['list_reminders', 'list_scheduled_items'],
  ['list_recurring_todos', 'list_scheduled_items'],
  // budgetVsActual already returns actualCents, so get_department_spend was
  // re-deriving a subset of check_budget_status's own read. Both now fold into
  // the one month-of-money tool.
  ['check_budget_status', 'get_finance_summary'],
  ['get_department_spend', 'get_finance_summary'],
  // Renamed, not merged: it never generated anything. It reports which
  // housekeeper holds which rooms today, and the old name invited the model to
  // promise the manager a schedule it cannot build.
  ['generate_schedule', 'get_room_assignments'],
]);

/** Resolve a possibly-retired wire name to the tool that answers it now. */
export function resolveToolName(name: string): string {
  return TOOL_ALIASES.get(name) ?? name;
}

/**
 * All registered tools, regardless of role. Mostly for introspection /
 * monitoring — and the spine of the tenant-isolation sweep, which walks this
 * rather than a hand-written list so a new tool is covered the moment it is
 * registered. Retired aliases are deliberately absent (see TOOL_ALIASES).
 */
export function listAllTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

/** Look up a registered tool by name, following a retired name (or undefined). */
export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(resolveToolName(name));
}

/**
 * True when the named tool MUTATES data. Drives the approval gate — a mutation
 * tool_use is proposed (pending row + card), not executed inline. Unknown tools
 * are treated as non-mutating (the executor's own not-found guard handles them).
 */
export function isMutationTool(name: string): boolean {
  return registry.get(resolveToolName(name))?.mutates === true;
}

/** The approval tier a mutation tool carries ('quick' | 'card'), or null. */
export function approvalTierFor(name: string): 'quick' | 'card' | null {
  return registry.get(resolveToolName(name))?.approval ?? null;
}

/**
 * True when this tool confirms in the conversation rather than on a card — so
 * the approval gate must let it run and its own two-phase confirm is what
 * stands between the model and the hotel's data. See `confirmInChat` on
 * ToolDefinition.
 */
export function confirmsInChat(name: string): boolean {
  return registry.get(resolveToolName(name))?.confirmInChat === true;
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
  // A retired wire-name resolves to whichever tool answers that question now,
  // so a replayed history row / pinned eval case still executes. Everything
  // below gates on the SURVIVING tool's own declarations — an alias grants no
  // role, surface, section or capability its target does not already have.
  const resolved = resolveToolName(name);
  const tool = registry.get(resolved);
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
  // Cross-hotel chat gate. A tool that opts into the portfolio surface may only
  // run on a context the portfolio route built — the one place the company-scope
  // hat and the `cross_hotel_ai_chat` setting are checked. Without this, a
  // portfolio tool reached from any other execution path (the per-hotel chat
  // route, the approval-resolve route, the eval harness) would fall through to
  // its handler with no company scope at all.
  //
  // Stated as "portfolio tool needs portfolio scope" rather than "portfolio
  // surface needs it", so a tool that ever opts into BOTH surfaces still cannot
  // read across hotels from a per-hotel turn.
  if (allowedSurfaces.includes('portfolio') && !ctx.portfolio) {
    return {
      ok: false,
      error: `Tool ${name} answers about a whole management company and can only run in a portfolio conversation. Tell the user this question has to be asked from the company view.`,
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
    // Attach the one-hotel database accessor. Built here rather than at the
    // route boundary so EVERY execution path (chat, voice, walkthrough,
    // approval resolve, evals) gets it without a single call site changing.
    let db: ScopedDb | null = null;
    const handlerCtx: ToolHandlerContext = {
      ...ctx,
      get db(): ScopedDb {
        return (db ??= scopedDb(ctx.propertyId));
      },
    };
    const result = await tool.handler(args, handlerCtx);
    return await stampFreshness(tool, result, ctx);
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Data-age stamp (A2) ────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge the data-age fields into a `pmsFreshness: 'stamped'` tool's payload.
 *
 * ONE dispatcher rule instead of a copy-pasted block per tool: a new PMS tool
 * cannot forget to stamp, it can only forget the flag — and the completeness
 * test catches that. Mirrors the section / capability double-enforcement in
 * executeTool above.
 *
 * Precision: when the handler already returned its own `asOf` (its table
 * stamps every row with `captured_at`, e.g. pms_guest_balances), that value
 * WINS over the property-level signal and the age/tier are computed from it.
 *
 * `dataAgeMinutes` is computed here from the raw ISO rather than read off a
 * cached number, so the 30s feed-status cache can't serve a frozen age.
 *
 * Gated on `mode === 'live'`: a manual hotel's numbers are live by definition,
 * so stamping an age on them would invent staleness that doesn't exist.
 * Fail-safe: any error leaves the result exactly as the handler returned it.
 */
async function stampFreshness(
  tool: ToolDefinition<unknown>,
  result: ToolResult,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (tool.pmsFreshness !== 'stamped') return result;
  if (!result.ok || !isPlainObject(result.data)) return result;
  try {
    const status = await getPropertyFeedStatus(ctx.propertyId);
    if (status.mode !== 'live') return result;

    const data = result.data;
    const handlerAsOf = typeof data.asOf === 'string' ? data.asOf : null;
    const capturedAt = handlerAsOf ?? status.freshness?.capturedAt ?? null;
    const source = handlerAsOf ? 'feed_capture' : (status.freshness?.source ?? 'none');
    const now = new Date();
    return {
      ...result,
      data: {
        ...data,
        asOf: capturedAt,
        asOfSource: source,
        dataAgeMinutes: freshnessAgeMinutes(capturedAt, now),
        dataFreshness: freshnessTier(capturedAt, source, now),
      },
    };
  } catch {
    return result;
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
