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

import { canViewFinancials, type AppRole } from '@/lib/roles';
import type { CapabilityKey } from '@/lib/capabilities/registry';
import { capabilityDecisionForPropertyFresh } from '@/lib/capabilities/server';
import type { AuthoritativePropertyStanding } from '@/lib/authorization/server';
import { isUuid } from '@/lib/authorization/domain';
import { loadSessionAccount } from '@/lib/team-auth';
import { scopedDb, type ScopedDb } from './scoped-db';
import { lensFor, lensAllowsTool } from './lenses';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { freshnessAgeMinutes, freshnessTier } from '@/lib/pms/feed-status';
import {
  isSectionEnabled,
  type AppSection,
  type EnabledSections,
} from '@/lib/sections/registry';
import { getEnabledSectionsFresh } from '@/lib/sections/server';

// VoiceMode used to live in the ElevenLabs voice-session module (removed
// 2026-07-15 when the "Talk to Staxis" voice feature + ElevenLabs were torn
// out). The dedicated voice surface no longer has a live entry point, but the
// tool registry's generic surface/voiceMode plumbing is still referenced by
// chat/walkthrough provenance logic, so the type stays here as its home.
export type VoiceMode = 'general' | 'housekeeper_issue' | 'compliance';

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The company a portfolio turn is answering for, and the hotels the spine said
 * it covers. Carried on ToolContext after the portfolio route's authorization
 * receipt has been resolved.
 */
export interface PortfolioToolScope {
  organizationId: string;
  organizationName: string | null;
  /** Sorted, from `resolvePortfolioAccess`. Never from a request body. */
  propertyIds: string[];
}

export type AgentToolCapabilitySnapshot = Readonly<
  Partial<Record<CapabilityKey, boolean>>
>;

export interface ToolContext {
  /** The authenticated account making the call. */
  user: {
    uid: string;          // auth.users.id == accounts.data_user_id
    accountId: string;    // accounts.id
    username: string;
    displayName: string;
    role: AppRole;
    propertyAccess: string[];
    /** Explicit normalized-profile fence. Omitted by legacy/eval contexts. */
    hotelMutationAllowed?: boolean;
    /** Explicit per-hotel money-read entitlement. Kept separate from role so a
     *  company finance hat never has to impersonate a hotel manager. */
    seesFinancials?: boolean;
    /** Route-captured per-hotel capability floor. Production hotel chat always
     *  supplies it; omission exists only for legacy/background constructors. */
    capabilitySnapshot?: AgentToolCapabilitySnapshot;
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
   *  requiresCapability is double-enforced. `null` is the database's valid
   *  default-on policy; `undefined` means no route proof and fails closed at
   *  execution. */
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
   * The portfolio route resolves the coverage through the spine before the
   * model request: this field decides WHICH company is being asked about, not
   * what the answer is allowed to include.
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
   * cross-cutting tools (memory, knowledge, PMS reads, walkthrough, complaints,
   * lost-and-found) which are NEVER section-gated. The route map is only the
   * stale floor: executeTool performs a fresh fail-closed read before every
   * section-tagged handler.
   *
   * ─── Reminders: CREATING one is gated, managing one is not (2026-07-27) ──
   * `create_reminder` carries `section: 'communications'`; `cancel_reminder`
   * and `list_scheduled_items` deliberately do not. Reminders were originally
   * listed above as cross-cutting, and for reading and cancelling they still
   * are — but CREATION is different, because a reminder is delivered through
   * Communications and nowhere else (a DM from the creator, or a post in a
   * department channel).
   *
   * `fireDueReminders` already skips hotels with Communications off, and it
   * skips them BEFORE claiming the lease, so a reminder made at such a hotel is
   * not lost — it is paused, and resumes if the section is switched back on.
   * That is the right delivery behaviour and is unchanged. The bug it left open
   * was at the other end: the assistant would cheerfully accept "remind me
   * to…", show a confirmation card, write the row, and say it was scheduled —
   * and the user would never hear about it again, with nothing anywhere telling
   * them why.
   *
   * The gate has to be the CATALOG, not the handler. `create_reminder` is
   * `approval: 'card'`, so its handler does not run until after the user has
   * already tapped to confirm — a refusal there would promise a reminder and
   * then take it back. Dropping the tool from the catalog means the assistant
   * never offers it in the first place, and the executeTool refusal below still
   * covers the race where the section is switched off between the card being
   * shown and the user confirming it.
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
// So a retired name can stay callable, mapped to whichever surviving tool now
// answers that question. Route replacements are retained for prompt-health
// diagnostics but are deliberately not executable aliases. Aliases are
// deliberately NOT in `registry`, so:
//   • `listAllTools()` returns only live tools — the tenant-isolation sweep
//     walks the real catalog, not a doubled one;
//   • `toAnthropicTools()` never offers a retired name to the model, so the
//     catalog the model reads keeps shrinking even though history keeps
//     resolving.
//
// Every entry states what it was and why it went. The one route replacement is
// the old cross-hotel comparison name: the deterministic portfolio route now
// owns that question, so it has no generic tool target. The catalog audit
// treats that marker as intentionally non-callable and still catches every
// ordinary alias that points at a name that is not registered or collides with
// a live tool.
export const TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  // ── Dead stubs: no data source ever existed behind them ──
  // Both returned a fixed "not yet integrated" note and no figures. The
  // checkbook summary is the tool that actually reports revenue (from the PMS
  // when it exposes it) plus expenses, profit and budgets.
  ['get_revenue', 'get_finance_summary'],
  ['get_financial_report', 'get_finance_summary'],
  // Route replacement: multi-hotel comparison now belongs to the deterministic
  // /api/agent/portfolio route, not the generic per-hotel tool registry. Keep
  // the retired name so prompt-health checks can report stale rows without
  // presenting a non-existent tool to the model.
  ['compare_properties', 'portfolio_route'],
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
 *  that isn't live. At this catalog-only layer, `null` (the stored default-on
 *  policy) and `undefined` (legacy/background callers that do not mount tools)
 *  leave the catalog unchanged via `isSectionEnabled`. This is not execution
 *  authority: `executeTool` requires an explicit route proof for section-tagged
 *  tools, treats only `null` as valid default-on, and refuses `undefined`. */
export interface ToolCatalogAuthorization {
  /** Current route-bound financial read entitlement for this exact hotel. */
  seesFinancials: boolean;
  /** Current route-bound hotel mutation standing for this exact hotel. */
  hotelMutationAllowed: boolean;
  /** Route-captured capability decisions used as the old half of the
   *  old-and-current execution intersection. */
  capabilitySnapshot?: AgentToolCapabilitySnapshot;
}

/** Closed set captured by the hotel-chat route. A structural test fails when a
 * tool introduces another capability without adding it here. */
export const AGENT_TOOL_CAPABILITY_KEYS = [
  'view_financials',
  'view_wages',
  'manage_inventory_orders',
] as const satisfies readonly CapabilityKey[];

/**
 * The one capability that may widen beyond the degraded operational role.
 * A company finance/VP/owner standing intentionally projects as front_desk so
 * it cannot acquire hotel-manager powers; `seesFinancials` adds back only the
 * read-only Financials capability it was created to represent. Payroll/wages,
 * mutations and every other manager capability remain role-gated.
 */
function explicitlyAuthorizedFinanceRead(
  tool: ToolDefinition,
  surface: AgentSurface,
  seesFinancials: boolean | undefined,
): boolean {
  return surface === 'chat'
    && seesFinancials === true
    && tool.mutates !== true
    && tool.requiresCapability === 'view_financials';
}

export function getToolsForRole(
  role: AppRole,
  surface: AgentSurface,
  voiceMode?: VoiceMode,
  enabledSections?: EnabledSections,
  authorization?: ToolCatalogAuthorization,
): ToolDefinition[] {
  // WHO LENSES (2026-07-27). A hat with a lens normally gets the lens's list
  // INTERSECTED with everything below, so a name a lens mentions that the tool
  // itself refuses stays refused. The only explicit exception is the narrow,
  // independently-authorized read-only Financials grant below. A hat whose
  // lens is `mounted: false` (housekeeping) still gets nothing at all: the chat
  // is not part of their job.
  const lens = lensFor(role, surface);
  if (lens && !lens.mounted) return [];
  return Array.from(registry.values()).filter(t => {
    // Through `lensAllowsTool`, not an inlined `lens.tools.includes(...)`, so
    // catalog and executor share the same lens rule. The explicit finance-read
    // exception is expressed by the same helper in both paths as well.
    const explicitFinanceRead = explicitlyAuthorizedFinanceRead(
      t,
      surface,
      authorization?.seesFinancials,
    );
    if (!lensAllowsTool(role, surface, t.name) && !explicitFinanceRead) return false;
    if (!t.allowedRoles.includes(role) && !explicitFinanceRead) return false;
    // A read-only company standing must not be offered a mutation that would
    // become an approval card only to fail after the user approves it.
    if (t.mutates && authorization && authorization.hotelMutationAllowed !== true) return false;
    if (t.requiresCapability
      && authorization
      && authorization.capabilitySnapshot?.[t.requiresCapability] !== true) return false;
    const allowedSurfaces = t.surfaces ?? ['chat'];
    if (!allowedSurfaces.includes(surface)) return false;
    if (surface === 'voice' && t.voiceModes && voiceMode) {
      if (!t.voiceModes.includes(voiceMode)) return false;
    }
    // Catalog UX filter only: drop an explicitly disabled section. Null is the
    // valid default-on DB value; undefined leaves legacy/background catalogs
    // unchanged, but executeTool later refuses it as a missing route proof.
    if (t.section && !isSectionEnabled(enabledSections, t.section)) return false;
    return true;
  });
}

/**
 * Execute a tool by name. Centralizes the role check so a misbehaving tool
 * handler can't accidentally bypass it. Returns a structured ToolResult that
 * the agent loop feeds back to Claude as a tool_result message.
 *
 * Authorization is an intersection of two snapshots:
 *   1. the route-owned context captured before the model was called; and
 *   2. a fresh active-account + authoritative hotel standing loaded for this
 *      exact invocation.
 *
 * The first prevents a stale conversation from acquiring newly granted power;
 * the second makes revocation, hotel transfer, account deactivation and role
 * changes effective before a handler can read or mutate anything. Resolver
 * errors fail closed. The handler receives the fresh standing, never the stale
 * role/property array from the conversation context.
 */
type FreshToolAuthorization = {
  standing: AuthoritativePropertyStanding;
  user: ToolContext['user'];
};

type FreshToolAuthorizationResult =
  | { ok: true; authorization: FreshToolAuthorization }
  | { ok: false; reason: 'changed' | 'unavailable' };

/**
 * Recheck identity, account lifecycle and the one-hotel standing immediately
 * before tool execution. `loadSessionAccount` binds the auth UID to one active
 * account and calls `listAuthoritativePropertyAccess`; the latter performs the
 * active-account check and computes every hotel standing atomically in the
 * database. Reusing that loader avoids a second authorization implementation
 * inside the AI layer and keeps the service-role client behind its established
 * server boundary.
 */
async function freshToolAuthorization(
  ctx: ToolContext,
): Promise<FreshToolAuthorizationResult> {
  if (!isUuid(ctx.user.uid) || !isUuid(ctx.user.accountId) || !isUuid(ctx.propertyId)) {
    return { ok: false, reason: 'changed' };
  }

  let account: Awaited<ReturnType<typeof loadSessionAccount>>;
  try {
    account = await loadSessionAccount(ctx.user.uid);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (!account) return { ok: false, reason: 'unavailable' };
  if (account.accountId !== ctx.user.accountId) {
    return { ok: false, reason: 'changed' };
  }

  const standing = account.reachesAllProperties
    ? account.role === 'admin'
      ? {
        propertyId: ctx.propertyId,
        operationalRole: 'admin' as const,
        seesFinancials: true,
        hotelMutationAllowed: true,
        portfolioIntelligenceRead: true,
        entitlements: [],
      }
      : null
    : account.propertyStandings?.find((candidate) => (
      candidate.propertyId === ctx.propertyId
    )) ?? null;
  if (!standing) return { ok: false, reason: 'changed' };

  return {
    ok: true,
    authorization: {
      standing,
      user: {
        ...ctx.user,
        accountId: account.accountId,
        displayName: account.displayName ?? ctx.user.displayName,
        role: standing.operationalRole,
        propertyAccess: account.propertyAccess,
        hotelMutationAllowed: standing.hotelMutationAllowed,
        seesFinancials: standing.seesFinancials,
      },
    },
  };
}

function freshAuthorizationRefusal(
  name: string,
  reason: 'changed' | 'unavailable',
): ToolResult {
  if (reason === 'unavailable') {
    return {
      ok: false,
      error: `Current access could not be verified, so ${name} did not run. Nothing was read or changed. Tell the user to try again.`,
    };
  }
  return {
    ok: false,
    error: `Your account, role, or property access changed before ${name} could run. Nothing was read or changed. Restart from a property you currently have access to.`,
  };
}

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
  const staleFinanceRead = explicitlyAuthorizedFinanceRead(
    tool,
    ctx.surface,
    ctx.user.seesFinancials,
  );
  if (!tool.allowedRoles.includes(ctx.user.role) && !staleFinanceRead) {
    return {
      ok: false,
      error: `Your role (${ctx.user.role}) is not allowed to use ${name}. Explain to the user that this action requires a different role.`,
    };
  }
  if (tool.mutates && ctx.user.hotelMutationAllowed !== true) {
    return {
      ok: false,
      error: `Your current company access is read-only at this hotel. ${name} cannot make changes.`,
    };
  }
  // WHO LENSES — the executor's half of the mount, enforced the way every other
  // gate in this file is: twice. `getToolsForRole` already left this tool out of
  // the catalog the model was handed, so reaching here means a stale tool list,
  // a replayed conversation from before the lens existed, or a hallucinated
  // name. The refusal is worded for the model to relay, not to argue with.
  if (!lensAllowsTool(ctx.user.role, ctx.surface, tool.name) && !staleFinanceRead) {
    return {
      ok: false,
      error: `${name} is not part of what you can do in this conversation. Tell the user plainly that this one is a manager question and offer to help with something you can actually answer — do not try to get the same information another way.`,
    };
  }
  // A tool that survives the role/lens mount still needs an explicit
  // route-captured capability floor. Keeping the role/lens refusal first
  // preserves the stable least-privilege explanation for a tool that was
  // never part of this person's job; omission here remains fail-closed for
  // every capability-gated tool that their job could otherwise use.
  if (tool.requiresCapability
    && ctx.user.capabilitySnapshot?.[tool.requiresCapability] !== true) {
    return {
      ok: false,
      error: `Access to ${name} was restricted when this turn started. Ask again after your current permissions are reloaded.`,
    };
  }
  // Defense-in-depth on the route-captured authoritative property set. Admins
  // bypass via their global standing; every other role (including owner) must
  // have this exact property in the captured set before fresh reauthorization.
  if (
    ctx.user.role !== 'admin' &&
    !ctx.user.propertyAccess.includes(ctx.propertyId)
  ) {
    return {
      ok: false,
      error: 'Property access for this conversation is not in your account. The user must restart the conversation from a property they currently have access to.',
    };
  }

  // TOCTOU boundary: the route/context checks above are intentionally retained
  // as a stale-snapshot floor, then intersected with this fresh authoritative
  // read. A handler is never reached on revocation, transfer, deactivation,
  // role loss, malformed authority output or store outage.
  const fresh = await freshToolAuthorization(ctx);
  if (!fresh.ok) return freshAuthorizationRefusal(name, fresh.reason);
  const { standing, user: freshUser } = fresh.authorization;
  const freshFinanceRead = explicitlyAuthorizedFinanceRead(
    tool,
    ctx.surface,
    standing.seesFinancials,
  );

  if (!tool.allowedRoles.includes(freshUser.role) && !freshFinanceRead) {
    return freshAuthorizationRefusal(name, 'changed');
  }
  if (!lensAllowsTool(freshUser.role, ctx.surface, tool.name) && !freshFinanceRead) {
    return freshAuthorizationRefusal(name, 'changed');
  }
  if (tool.mutates && standing.hotelMutationAllowed !== true) {
    return freshAuthorizationRefusal(name, 'changed');
  }
  if (ctx.surface === 'portfolio' && standing.portfolioIntelligenceRead !== true) {
    return freshAuthorizationRefusal(name, 'changed');
  }
  if ((tool.requiresCapability === 'view_financials'
      || tool.requiresCapability === 'view_wages')
    && standing.seesFinancials !== true) {
    return freshAuthorizationRefusal(name, 'changed');
  }

  const freshCtx: ToolContext = { ...ctx, user: freshUser };
  // Per-hotel section gate. The route-captured map is the stale floor and can
  // deny immediately; a newly enabled section therefore never expands an
  // in-flight turn. If that floor allowed the tool, perform a fresh uncached
  // read so same-turn disablement (or lookup failure) stops before the handler.
  if (tool.section) {
    if (ctx.enabledSections === undefined) {
      return freshAuthorizationRefusal(name, 'unavailable');
    }
    if (!isSectionEnabled(ctx.enabledSections, tool.section)) {
      return {
        ok: false,
        error: `The ${tool.section} section was turned off when this conversation turn started. Ask again after the current hotel setup is reloaded.`,
      };
    }
    let currentSections: EnabledSections;
    try {
      currentSections = await getEnabledSectionsFresh(ctx.propertyId);
    } catch {
      return freshAuthorizationRefusal(name, 'unavailable');
    }
    if (!isSectionEnabled(currentSections, tool.section)) {
      return {
        ok: false,
        error: `The ${tool.section} section was turned off before ${name} could run. Nothing was read or changed.`,
      };
    }
  }
  // Per-hotel capability gate (security audit 2026-06-26). Mirrors the HTTP
  // finance/reports gates (requireFinanceAccess → canForProperty) so the agent
  // surface can't be used to read data an admin has restricted for this role
  // at this property. Admin short-circuits to allowed inside canForProperty;
  // manager-floor caps (view_financials/view_wages/...) are refused for
  // line-staff roles regardless of overrides.
  if (tool.requiresCapability) {
    let allowed = false;
    // Mirror requireFinanceAccess: a finance hat's explicit read bit is the
    // grant, because its least-privilege front_desk role deliberately fails the
    // manager-floor capability resolver. True hotel managers still go through
    // that resolver and therefore continue honoring Access-tab overrides.
    if (freshFinanceRead && !canViewFinancials(freshUser.role)) {
      allowed = true;
    } else {
      try {
        const decision = await capabilityDecisionForPropertyFresh(
          { role: freshUser.role },
          tool.requiresCapability,
          ctx.propertyId,
        );
        if (decision === 'unavailable') {
          return freshAuthorizationRefusal(name, 'unavailable');
        }
        allowed = decision === 'allowed';
      } catch {
        return freshAuthorizationRefusal(name, 'unavailable');
      }
    }
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
      ...freshCtx,
      get db(): ScopedDb {
        return (db ??= scopedDb(ctx.propertyId));
      },
    };
    const result = await tool.handler(args, handlerCtx);
    return await stampFreshness(tool, result, freshCtx);
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
