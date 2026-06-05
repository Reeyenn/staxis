// ─── AI Agent Builder · stable contract surface ────────────────────────────
//
// THE single source of truth for the Agent Builder. Chat 2 (wizard / approval
// queue / run-history UI) and Chat 3 (templates + backtest UI) IMPORT from
// here and never redefine these types. If a downstream chat needs a new field,
// it is added HERE first.
//
// Foundation = engine + data + these contracts. No UI, no concrete templates.

// ═══ Config (persisted as agents.config jsonb — single source of truth) ═════

/** Bump when the AgentConfig shape changes; the engine's migrateConfig()
 *  normalizes any older stored config to the current version on read. */
export const AGENT_CONFIG_VERSION = 1;

export type AgentStatus = 'draft' | 'active' | 'paused' | 'archived';

/** Read-domains an agent may SEE. Each maps to a service-role scope reader. */
export type ScopeKey =
  | 'rooms' | 'staff' | 'schedule' | 'pms' | 'work_orders' | 'inventory' | 'complaints';

/** The Safety Dial per action. money/guest actions are clamped to >= approve_first. */
export type ActionApprovalMode = 'suggest' | 'approve_first' | 'auto';

/** Operational events an event-triggered agent can listen for. The `(string & {})`
 *  keeps the union open for events Chat 3 wires later. */
export type AgentEventName =
  | 'room.issue_reported'
  | 'inventory.low_stock'
  | 'complaint.created'
  | 'staff.callout'
  | (string & {});

export interface ScheduleTriggerConfig {
  type: 'schedule';
  /** Property-local time of day, 24h "HH:MM" (e.g. "08:00"). */
  atLocalTime: string;
  /** Days it runs, 0=Sun..6=Sat. Omitted = every day. */
  daysOfWeek?: number[];
}
export interface EventTriggerConfig {
  type: 'event';
  eventName: AgentEventName;
  /** Declarative match against the event payload, interpreted by the template. */
  filter?: Record<string, unknown>;
}
export type TriggerConfig = ScheduleTriggerConfig | EventTriggerConfig;

export interface AgentApprovalRules {
  /** Global guardrail (default true): force any money- or guest-touching action
   *  to >= approve_first even if its per-action mode says 'auto'. */
  moneyOrGuestRequiresApproval: boolean;
  /** Mode for actions not in `perAction` (default 'suggest'). */
  defaultMode: ActionApprovalMode;
  /** Per-action mode override, keyed by action key. */
  perAction: Record<string, ActionApprovalMode>;
}

export interface AgentConfig {
  version: number;                 // = AGENT_CONFIG_VERSION
  trigger: TriggerConfig;
  scopes: ScopeKey[];              // read-domains the agent may gather
  actions: string[];              // allowed action keys
  approvalRules: AgentApprovalRules;
  templateParams?: Record<string, unknown>;  // template-specific tuning (validated by the template)
}

export interface Agent {
  id: string;
  propertyId: string;
  name: string;
  description: string | null;
  templateKey: string | null;
  config: AgentConfig;
  status: AgentStatus;
  createdBy: string | null;
  createdAt: string;               // ISO
  updatedAt: string;               // ISO
  lastRunAt: string | null;        // ISO
  lastRunLocalDate: string | null; // YYYY-MM-DD (display hint)
}

// ═══ Runs / steps ══════════════════════════════════════════════════════════

export type RunMode = 'live' | 'dry_run';
export type TriggerSource = 'scheduled' | 'event' | 'manual' | 'backtest';
export type RunStatus = 'running' | 'success' | 'failed' | 'awaiting_approval';

/** Fixed by spec. A live `executed` step whose result.ok===false is a soft
 *  failure (see isActionFailed) — there is intentionally no 'failed' state. */
export type ActionStatus =
  | 'proposed' | 'pending_approval' | 'approved' | 'rejected'
  | 'executed' | 'skipped' | 'simulated';

export interface AgentActionStep {
  id: string;
  runId: string;
  agentId: string;
  propertyId: string;
  actionKey: string;
  payload: unknown;
  status: ActionStatus;
  result: unknown | null;          // execute() result {ok,...} OR describe() detail on simulate
  describeKey: string | null;
  describeParams: Record<string, unknown>;
  describeEn: string;              // bilingual receipt text, carried inline (EN…
  describeEs: string;              // …and ES)
  spendsMoney: boolean;
  contactsGuest: boolean;
  decidedBy: string | null;
  decidedAt: string | null;        // ISO
  createdAt: string;               // ISO
}

/** Canonical "this live step ran but failed" check. The action-status enum is
 *  fixed by spec (no 'failed' value); a failed live execute is `executed` with
 *  result.ok===false. One import here kills the "forgot to check result.ok"
 *  bug class in every Chat 2 render path. */
export function isActionFailed(s: AgentActionStep): boolean {
  return (
    s.status === 'executed' &&
    !!s.result &&
    typeof s.result === 'object' &&
    (s.result as { ok?: boolean }).ok === false
  );
}

export interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;               // denormalized at read (no N+1 in history/queue)
  propertyId: string;
  triggerSource: TriggerSource;
  triggeredBy: string | null;      // account id for manual/backtest; null for scheduled/event
  mode: RunMode;
  status: RunStatus;
  asOfDate: string | null;         // YYYY-MM-DD for dry_run/backtest; null for live-now
  runLocalDate: string;            // YYYY-MM-DD
  inputsSnapshot: unknown;
  summary: string | null;          // rendered EN, always set on terminal status
  summaryKey: string | null;
  summaryParams: Record<string, unknown>;
  approximations: string[];        // honest dry-run caveats (Chat 3 backtest UI surfaces these)
  error: string | null;
  startedAt: string;               // ISO
  finishedAt: string | null;       // ISO
}

export interface AgentRunReceipt {
  run: AgentRun;
  steps: AgentActionStep[];
}

/** One row of the property-wide approval queue (Chat 2 headline surface). */
export interface AgentApprovalQueueItem {
  run: AgentRun;
  pendingSteps: AgentActionStep[];
}

// ═══ Bilingual ═════════════════════════════════════════════════════════════

export interface BilingualText {
  en: string;
  es: string;
  key?: string;
  params?: Record<string, unknown>;
}

// ═══ Action registry + meta ════════════════════════════════════════════════

export interface AgentActionContext {
  propertyId: string;
  agentId: string;
  runId: string;
  mode: RunMode;
  asOfDate: string;                // resolved date (today-in-tz for live)
  /** Account the agent's spend is attributed to (createdBy ?? resolveCostAccount). */
  costAccountId: string | null;
  requestId: string;
}

export interface AgentActionDescription {
  key?: string;
  params: Record<string, unknown>;
  en: string;
  es: string;
}

export interface AgentActionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** TPayload is the validated action payload type. */
export interface AgentActionDef<TPayload = unknown> {
  key: string;
  label: BilingualText;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** api-validate-style coerce/validate of a raw payload. */
  validate(raw: unknown): { error?: string; value?: TPayload };
  /** Either flag true ⇒ effective approval mode is forced >= approve_first. */
  spendsMoney: boolean;
  contactsGuest: boolean;
  /** Live side effect. Never called in dry_run. */
  execute(payload: TPayload, ctx: AgentActionContext): Promise<AgentActionResult>;
  /** Dry-run "would do X". MUST be pure (no side effects). */
  describe(payload: TPayload, ctx: AgentActionContext): AgentActionDescription;
}

/** What the wizard (Chat 2) renders to offer actions. Declared here so Chat 2
 *  binds to a contract, never to a registry implementation detail. */
export interface AgentActionMeta {
  key: string;
  label: BilingualText;
  spendsMoney: boolean;
  contactsGuest: boolean;
  inputSchema: AgentActionDef['inputSchema'];
  /** The lowest mode the Safety Dial may be set to (approve_first if flagged). */
  approvalFloor: ActionApprovalMode;
}

// ═══ Scope registry + meta (service-role reads only) ═══════════════════════

export interface AgentScopeContext {
  propertyId: string;
  asOfDate: string;
  mode: RunMode;
}

export interface AgentScopeDef<TData = unknown> {
  key: ScopeKey;
  label: BilingualText;
  /** Reads via supabaseAdmin server helpers — NEVER the anon browser client.
   *  May push an honest caveat string onto `approximations`. */
  read(ctx: AgentScopeContext, approximations: string[]): Promise<TData>;
}

export interface AgentScopeMeta {
  key: ScopeKey;
  label: BilingualText;
}

// ═══ Template interface (plan() is PURE + SYNC ⇒ backtest reproducible) ═════

export interface ProposedAction {
  actionKey: string;
  payload: unknown;                // must pass the action's validate()
  reason?: BilingualText;          // optional "why", shown in the receipt
}

export interface AgentEventEnvelope {
  name: AgentEventName;
  payload: Record<string, unknown>;
  eventId?: string;
}

export interface TemplatePlanInput {
  scopes: Partial<Record<ScopeKey, unknown>>;  // only requested scopes present
  config: AgentConfig;
  asOfDate: string;
  event?: AgentEventEnvelope;       // present for event-triggered runs
}

export interface AgentTemplate {
  key: string;
  defaultConfig: AgentConfig;
  requiredScopes: ScopeKey[];       // effective scopes = union(requiredScopes, config.scopes)
  /** Deterministic given (scopes, config, asOfDate, event). No LLM, no I/O —
   *  this is what makes "Test on yesterday's data" reproducible and testable. */
  plan(input: TemplatePlanInput): ProposedAction[];
}

export interface AgentTemplateMeta {
  key: string;
  name: BilingualText;
  description: BilingualText;
  defaultConfig: AgentConfig;
  requiredScopes: ScopeKey[];   // so the wizard can show what the template must SEE
}

/** Typed catalog of selectable events the wizard offers; stays in lockstep
 *  with the call-sites Chat 3 wires for dispatchAgentEvent. */
export const AGENT_EVENT_CATALOG: ReadonlyArray<{
  name: AgentEventName;
  label: BilingualText;
  payloadKeys: string[];
}> = [
  { name: 'room.issue_reported', label: { en: 'A room issue is reported', es: 'Se reporta un problema de habitación' }, payloadKeys: ['roomNumber', 'note', 'reportedBy'] },
  { name: 'inventory.low_stock', label: { en: 'Inventory runs low', es: 'El inventario está bajo' }, payloadKeys: ['itemId', 'itemName', 'onHand', 'par'] },
  { name: 'complaint.created', label: { en: 'A guest complaint is logged', es: 'Se registra una queja de huésped' }, payloadKeys: ['complaintId', 'category', 'roomNumber'] },
  { name: 'staff.callout', label: { en: 'A staff member calls out', es: 'Un miembro del personal se reporta ausente' }, payloadKeys: ['staffId', 'shiftDate', 'department'] },
];

// ═══ Engine entry + API request/response contracts ═════════════════════════

export interface RunAgentInput {
  mode: RunMode;
  triggerSource: TriggerSource;
  asOfDate?: string;               // required for dry_run/backtest; defaults today-in-tz for live
  triggeredBy?: string | null;
  event?: AgentEventEnvelope;
}

export interface RunAgentOutcome {
  runId: string;
  status: RunStatus;
  steps: AgentActionStep[];
  summary: string;
}

export interface CreateAgentRequest {
  propertyId: string;
  name: string;
  description?: string;
  templateKey?: string | null;
  config: AgentConfig;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  config?: AgentConfig;
  status?: AgentStatus;
}

export interface RunNowRequest {
  mode: RunMode;
  date?: string;                   // required when mode='dry_run'
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
