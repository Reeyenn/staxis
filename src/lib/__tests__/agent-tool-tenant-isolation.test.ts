/**
 * Catalog conformance: EVERY registered agent tool, run on behalf of hotel A
 * against a dataset that also contains hotel B, must not read, return, or
 * write anything belonging to B (INV-29).
 *
 * This is the workstream's "no failure that does not become a test" mechanism.
 * It walks `listAllTools()` rather than a hand-written list, so a newly
 * registered tool is covered the moment it is added — and a tool that reaches
 * NO database at all FAILS unless it is declared on NO_DB_TOOLS, which forces
 * whoever adds it to state that it is genuinely DB-free rather than silently
 * uncovered.
 *
 * It is also the only machine check that covers the INDIRECT path: nine tool
 * files reach the database through shared `src/lib/**` modules
 * (lost-and-found/store, financials/db, knowledge/core, comms/core,
 * complaints-create, reminders/*, …) that the ESLint boundary does not cover.
 * Those modules' queries are recorded here too, because the fake is installed
 * on the client singletons rather than on the accessor.
 *
 * How a missing hotel filter is detected:
 *   • the fake HONORS the filters a query applies, and serves hotel B's row
 *     FIRST — so a query that forgot the filter gets B's row back, and B's
 *     rows are poisoned with values that must never appear in a tool result;
 *   • every table read/written is checked for the scope filter directly, so a
 *     missing filter is caught even when the table happens to be empty.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeTool,
  listAllTools,
  type AgentSurface,
  type ToolContext,
  type ToolDefinition,
} from '@/lib/agent/tools';
import { lensAllowsTool } from '@/lib/agent/lenses';
import '@/lib/agent/tools/index';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { supabase as supabaseAnon } from '@/lib/supabase';
import { scopeColumnFor } from '@/lib/agent/scoped-db';
import { installAgentToolAuthorityTestStore } from './helpers/agent-tool-authority';

// ─── The two hotels ─────────────────────────────────────────────────────────

const PID_A = '00000000-0000-0000-0000-00000000aaa1';
const PID_B = '00000000-0000-0000-0000-0000000bbbb1';
const ACC_A = '00000000-0000-0000-0000-00000000aaa0';
const ACC_B = '00000000-0000-0000-0000-0000000bbbb0';
const STAFF_A = '00000000-0000-0000-0000-00000000aaa2';
const STAFF_B = '00000000-0000-0000-0000-0000000bbbb2';
const ROW_A = '00000000-0000-0000-0000-00000000aaa3';
const ROW_B = '00000000-0000-0000-0000-0000000bbbb3';
let currentAuthorityRole: ToolContext['user']['role'] = 'general_manager';

/** Every string field on a hotel-B row carries this. Seeing it in a tool
 *  result, a write payload, or a query filter means B leaked. */
const MARKER = 'HOTEL-B-LEAK';
const B_ROOM = 'B01';

/** Anything that must never surface on hotel A's side. */
const POISON = [PID_B, ACC_B, STAFF_B, ROW_B, MARKER, B_ROOM];

const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Tables with no hotel column — a query against one legitimately carries no
 * scope filter. Mirrors UNSCOPABLE_TABLES in scoped-db.ts plus the global AI
 * configuration tables the complaint classifier reads.
 */
const GLOBAL_TABLES = new Set([
  'accounts',                   // an account spans hotels
  'agent_prompts',              // one row per role, shared by every hotel
  'agent_eval_baselines',       // eval bookkeeping
  'ai_feature_config_versions', // which model runs which AI feature, fleet-wide
  'ai_model_catalog',           // the model catalogue itself
  'pms_knowledge_files',        // versioned per-PMS-FAMILY, deliberately shared
                                // across every hotel on that family (0201)
]);

/**
 * Follow-up writes/reads keyed on a row this same call path just created or
 * just read inside a hotel-scoped flow. They carry a primary/foreign key
 * instead of the hotel column, which is correct — but the exemption is
 * declared here, per table+verb, rather than assumed, and the call must still
 * be genuinely row-keyed (an unfiltered UPDATE still fails).
 *
 * All four would need a property predicate the day the AI layer moves behind
 * real row-level enforcement (INV-31); that is the point of listing them.
 */
const ROW_KEYED_FOLLOWUPS = new Map<string, { keys: string[]; why: string }>([
  ['complaints:update', { keys: ['id'], why: 'links the work order onto the complaint this call just inserted (complaints-create.ts)' }],
  ['complaints:select', { keys: ['id'], why: 're-reads the complaint this call just inserted (complaints-create.ts)' }],
  ['comms_conversations:update', { keys: ['id'], why: 'stamps last_message_at on the conversation resolved by a hotel-scoped read (comms/core.ts)' }],
  ['comms_members:update', { keys: ['conversation_id'], why: 'marks the sender read on the conversation it just posted to (comms/core.ts)' }],
]);

/**
 * Tools that genuinely reach no database at all. Every entry must say WHY.
 * A tool that records zero database calls and is NOT on this list fails the
 * suite — that is the coverage gate. Do not add an entry to silence a tool
 * whose fixture merely failed to reach its handler; fix the fixture instead
 * (a pre-handler refusal is reported as its own, different failure).
 */
const NO_DB_TOOLS = new Map<string, string>([
  // compare_properties / get_revenue / get_financial_report lived here until
  // the 2026-07-27 catalog rebuild deleted them. They were the ONLY reason this
  // list needed a "stub" category at all: three tools that answered a manager's
  // real question with "not yet integrated" and touched nothing. Their absence
  // is now asserted below rather than assumed — a dead entry here is a slot a
  // future tool could quietly inherit.
  ['walk_user_through', 'returns UI walkthrough steps from an in-memory registry'],
  ['staxis_show_pattern', 'resolves against the trace patterns the browser already holds; the server has nothing to read'],
]);

/**
 * The PER-HOTEL catalog — everything this suite is about.
 *
 * The portfolio route is deterministic and does not mount agent tools. The
 * filter remains explicit so a future portfolio-surface tool cannot silently
 * disappear from this per-hotel isolation sweep without a deliberate test
 * change.
 */
function perHotelTools(): ReturnType<typeof listAllTools> {
  return listAllTools().filter((t) => !(t.surfaces ?? ['chat']).includes('portfolio'));
}

// ─── Recording fake ─────────────────────────────────────────────────────────

type Filter = { op: string; column: string; value: unknown };
type DbCall = {
  table: string;
  verb: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  filters: Filter[];
  payload?: unknown;
};
type RpcCall = { fn: string; args: unknown };

let dbCalls: DbCall[] = [];
let rpcCalls: RpcCall[] = [];
/** Filter operators the fake cannot evaluate; recorded so an unhandled one
 *  shows up as a named failure instead of a silently-passing test. */
let unevaluatedOps: string[] = [];

const EVALUATED_OPS = new Set(['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'not']);

type Row = Record<string, unknown>;

/** One row per hotel for any table a tool asks for. Broad on purpose: the
 *  point is to have SOMETHING to leak, not to model each table faithfully. */
function makeRow(side: 'A' | 'B'): Row {
  const a = side === 'A';
  const s = (v: string) => (a ? v : MARKER);
  return {
    id: a ? ROW_A : ROW_B,
    property_id: a ? PID_A : PID_B,
    // identity-ish text — poisoned on the B side
    name: s('Maria Garcia'),
    display_name: s('Maria Garcia'),
    username: s('maria'),
    title: s('Test title'),
    content: s('test content'),
    body: s('test body'),
    notes: s('test notes'),
    reason: s('test reason'),
    summary: s('test summary'),
    description: s('test description'),
    staff_name: s('Maria Garcia'),
    guest_name: s('Guest One'),
    company: s('Acme Plumbing'),
    address: s('1 Main St'),
    local_category: s('plumber'),
    channel_name: s('booking.com'),
    item_description: s('a black wallet'),
    location: s('lobby'),
    paused_reason: s('none'),
    // references
    staff_id: a ? STAFF_A : STAFF_B,
    user_id: a ? ACC_A : ACC_B,
    account_id: a ? ACC_A : ACC_B,
    assigned_staff_id: a ? STAFF_A : STAFF_B,
    conversation_id: a ? ROW_A : ROW_B,
    item_id: a ? ROW_A : ROW_B,
    property_access: [a ? PID_A : PID_B],
    // rooms
    room_number: a ? '101' : B_ROOM,
    number: a ? '101' : B_ROOM,
    room_inventory: [a ? '101' : B_ROOM],
    // enums / flags kept realistic so branches behave
    role: 'general_manager',
    department: 'housekeeping',
    category: 'housekeeping',
    status: 'pending',
    kind: 'shift',
    channel_key: 'announcements',
    priority: 'normal',
    cadence: 'weekly',
    is_active: true,
    active: true,
    archived_at: null,
    fired_at: null,
    canceled_at: null,
    claimed_at: null,
    deleted_at: null,
    // numbers
    total_rooms: 10,
    current_stock: 5,
    par_level: 10,
    reorder_at: 3,
    unit_cost: 100,
    quantity: 1,
    duration_minutes: 30,
    balance_cents: 100,
    deposit_cents: 0,
    cash_collected_cents: 100,
    card_collected_cents: 100,
    deposits_collected_cents: 0,
    total_collected_cents: 200,
    rate_per_night_cents: 100,
    total_amount_cents: 100,
    cancellation_fee_cents: 0,
    amount_cents: 100,
    weekday: 1,
    // dates
    timezone: 'America/Chicago',
    date: TODAY,
    business_date: TODAY,
    shift_date: TODAY,
    request_date: TODAY,
    arrival_date: TODAY,
    departure_date: TODAY,
    cancelled_date: TODAY,
    no_show_date: TODAY,
    expense_date: TODAY,
    month_start: `${TODAY.slice(0, 7)}-01`,
    start_time: '08:00',
    end_time: '16:00',
    created_at: `${TODAY}T08:00:00.000Z`,
    updated_at: `${TODAY}T08:00:00.000Z`,
    submitted_at: `${TODAY}T08:00:00.000Z`,
    last_poll_at: `${TODAY}T08:00:00.000Z`,
    captured_at: `${TODAY}T08:00:00.000Z`,
    fire_at: `${TODAY}T23:00:00.000Z`,
  };
}

/** Hotel B FIRST — a query that forgot its filter gets B's row back, and any
 *  `.maybeSingle()` that forgot it reads B. */
function seedRows(): Row[] {
  return [makeRow('B'), makeRow('A')];
}

/** Ordering comparison over the seeded scalars (numbers, ISO date strings). */
function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(row: Row, f: Filter): boolean {
  const actual = row[f.column];
  switch (f.op) {
    case 'eq': return String(actual) === String(f.value);
    case 'neq': return String(actual) !== String(f.value);
    case 'in': return Array.isArray(f.value) && f.value.some(v => String(v) === String(actual));
    case 'is': return f.value === null ? actual === null || actual === undefined : actual === f.value;
    case 'gt': return cmp(actual, f.value) > 0;
    case 'gte': return cmp(actual, f.value) >= 0;
    case 'lt': return cmp(actual, f.value) < 0;
    case 'lte': return cmp(actual, f.value) <= 0;
    case 'ilike':
    case 'like': {
      const needle = String(f.value).replace(/%/g, '').toLowerCase();
      return String(actual ?? '').toLowerCase().includes(needle);
    }
    // .not(column, op, value) negates an inner operator, so it carries a
    // nested filter rather than a bare value. Evaluated (not just recorded)
    // because a `.not` the fake ignored would leave a tool's rows unnarrowed
    // and this suite would pass on a leak it never actually tested.
    case 'not': {
      const inner = f.value as { op: string; value: unknown };
      return !matches(row, { op: inner.op, column: f.column, value: inner.value });
    }
    default:
      return true; // recorded in unevaluatedOps
  }
}

function resolve(call: DbCall): Row[] {
  if (call.verb === 'insert' || call.verb === 'upsert') {
    const list = Array.isArray(call.payload) ? call.payload : [call.payload];
    return list.map((r, i) => ({ ...(r as Row), id: `${call.table}-new-${i}` }));
  }
  let rows = seedRows();
  for (const f of call.filters) {
    if (!EVALUATED_OPS.has(f.op)) unevaluatedOps.push(`${call.table}.${f.op}`);
    rows = rows.filter(r => matches(r, f));
  }
  return rows;
}

function builder(call: DbCall): Record<string, unknown> {
  let limit: number | null = null;
  const rows = () => {
    const r = resolve(call);
    return limit === null ? r : r.slice(0, limit);
  };
  const api: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null, count: rows().length }).then(res, rej),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => {
      const r = rows()[0];
      return r ? { data: r, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    },
    csv: async () => ({ data: '', error: null }),
  };
  for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike',
    'contains', 'containedBy', 'overlaps', 'filter', 'match', 'or', 'textSearch']) {
    api[op] = (column: unknown, value: unknown) => {
      call.filters.push({ op, column: String(column), value });
      return api;
    };
  }
  // .not takes THREE arguments — .not('staff_id', 'is', null) — so it cannot
  // share the two-argument shape above; the operator would land in `value` and
  // the real value would be dropped on the floor.
  api.not = (column: unknown, op: unknown, value: unknown) => {
    call.filters.push({ op: 'not', column: String(column), value: { op: String(op), value } });
    return api;
  };
  api.select = () => api;
  api.order = () => api;
  api.range = () => api;
  api.abortSignal = () => api;
  api.returns = () => api;
  api.throwOnError = () => api;
  api.limit = (n: number) => { limit = n; return api; };
  return api;
}

function fakeFrom(table: string) {
  const start = (verb: DbCall['verb'], payload?: unknown): Record<string, unknown> => {
    const call: DbCall = { table, verb, filters: [], payload };
    dbCalls.push(call);
    return builder(call);
  };
  return {
    select: () => start('select'),
    insert: (payload: unknown) => start('insert', payload),
    upsert: (payload: unknown) => start('upsert', payload),
    update: (payload: unknown) => start('update', payload),
    delete: () => start('delete'),
  };
}

async function fakeRpc(fn: string, args: unknown) {
  rpcCalls.push({ fn, args });
  return { data: null, error: null };
}

// ─── Argument synthesis ─────────────────────────────────────────────────────
// Values are derived from each tool's OWN inputSchema (enum → first member,
// pattern-ish names → a matching literal, otherwise by type). The named
// overrides exist so a handler's pre-flight validation resolves against the
// seeded hotel-A dataset instead of bailing before it reaches the database.

const NAMED_ARGS: Record<string, unknown> = {
  roomNumber: '101',
  room: '101',
  staffName: 'Maria Garcia',
  recipient: 'Maria Garcia',
  assignee: 'Maria Garcia',
  itemName: 'Maria Garcia',
  query: 'test',
  message: 'test message',
  title: 'Test title',
  body: 'test body',
  notes: 'test notes',
  note: 'test note',
  summary: 'test summary',
  itemDescription: 'a black wallet',
  roomOrLocation: '101',
  topic: 'test_topic',
  content: 'test content',
  date: TODAY,
  from: TODAY,
  to: TODAY,
  startDate: TODAY,
  endDate: TODAY,
  month: TODAY.slice(0, 7),
  fireAt: '2099-01-01T10:00:00.000Z',
  startTime: '08:00',
  endTime: '16:00',
  reminderId: ROW_A,
  templateId: ROW_A,
  documentId: ROW_A,
  sectionId: '1',
  newCount: 5,
  nights: 1,
  days: 7,
  limit: 5,
};

/**
 * Per-tool argument corrections for handlers whose schema offers mutually
 * exclusive options — filling in every property would trip their "pick one"
 * guard and the tool would never reach a query. `undefined` drops the key.
 */
const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  // "Pick either one person or one department for the reminder, not both."
  create_reminder: { department: undefined },
};

function synthesizeArgs(name: string, schema: ToolDefinition['inputSchema']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Every property, not just the required ones: an optional argument is often
  // exactly what carries the handler past its "what do you want me to do?"
  // guard and into a database call.
  for (const [key, rawSpec] of Object.entries(schema.properties ?? {})) {
    const spec = (rawSpec ?? {}) as { type?: string; enum?: unknown[] };
    if (Array.isArray(spec.enum) && spec.enum.length > 0) { out[key] = spec.enum[0]; continue; }
    if (key in NAMED_ARGS) { out[key] = NAMED_ARGS[key]; continue; }
    out[key] = spec.type === 'number' ? 1
      : spec.type === 'boolean' ? true
      : spec.type === 'array' ? []
      : 'test';
  }
  for (const [key, value] of Object.entries(ARG_OVERRIDES[name] ?? {})) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

// ─── Pre-handler refusals ───────────────────────────────────────────────────
// executeTool refuses on surface / role / property access /
// section / capability BEFORE the handler runs. A fixture that trips one of
// those never exercises the tool, so it must be reported as its own failure —
// never quietly absorbed into "this tool makes no database calls".

const PRE_HANDLER_REFUSALS: Array<{ rx: RegExp; gate: string }> = [
  { rx: /is not available on the .* surface/, gate: 'surface' },
  { rx: /is not allowed to use /, gate: 'role' },
  { rx: /Property access for this conversation/, gate: 'property access' },
  { rx: /section is turned off for this hotel/, gate: 'section' },
  { rx: /is restricted for your role at this property/, gate: 'capability' },
  { rx: /^Tool not found: /, gate: 'registry' },
];

function refusalGate(result: { ok: boolean; error?: string }): string | null {
  if (result.ok || !result.error) return null;
  for (const { rx, gate } of PRE_HANDLER_REFUSALS) if (rx.test(result.error)) return gate;
  return null;
}

function contextFor(tool: ToolDefinition): ToolContext {
  // Prefer admin: it satisfies the property-access and capability gates
  // without needing per-hotel fixture rows. Tools that exclude admin get
  // their first allowed role, and the capability gate then resolves through
  // `capability_overrides`, which the fake serves as "no overrides" so the
  // registry defaults apply.
  const surface: AgentSurface = (tool.surfaces ?? ['chat'])[0];
  // WHO LENSES (2026-07-27): the first allowed role is no longer necessarily a
  // role that can REACH the tool. `get_my_rooms` lists housekeeping first, and
  // housekeeping has no chat mount at all, so picking it silently turned this
  // sweep's proof into a refusal — the tool would reach no database and its
  // hotel scoping would go untested. Pick a role whose lens actually admits the
  // tool, so the sweep keeps exercising the handler rather than the gate.
  const role = tool.allowedRoles.includes('admin')
    ? 'admin'
    : (tool.allowedRoles.find(r => lensAllowsTool(r, surface, tool.name)) ?? tool.allowedRoles[0]);
  currentAuthorityRole = role;
  return {
    user: {
      uid: ACC_A,
      accountId: ACC_A,
      username: 'tester',
      displayName: 'Tester',
      role,
      propertyAccess: [PID_A],
      dept: null,
      hotelMutationAllowed: true,
      seesFinancials: true,
      capabilitySnapshot: {
        view_financials: true,
        view_wages: true,
        manage_inventory_orders: true,
      },
    },
    propertyId: PID_A,
    staffId: STAFF_A,
    requestId: 'tenant-isolation-test',
    surface,
    // A successful DB-null section read means the hotel's default-on policy.
    // Undefined is deliberately reserved for an unavailable route proof.
    enabledSections: null,
  };
}

// ─── The walk ───────────────────────────────────────────────────────────────

type ToolRun = {
  tool: ToolDefinition;
  result: { ok: boolean; data?: unknown; error?: string };
  calls: DbCall[];
  rpcs: RpcCall[];
  unevaluated: string[];
};

const runs = new Map<string, ToolRun>();

const originalAdminFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalAdminRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalAnonFrom = supabaseAnon.from.bind(supabaseAnon);
const originalAnonRpc = supabaseAnon.rpc.bind(supabaseAnon);
const originalFetch = globalThis.fetch;
let restoreAuthority: (() => void) | null = null;

describe('every agent tool is confined to one hotel (INV-29)', () => {
  before(async () => {
    // Both clients: nine tool files reach the database through shared modules,
    // and one shared read (today_property_counts_v1) goes through the browser
    // client even on the server.
    // @ts-expect-error installing the recording fake on the singleton
    supabaseAdmin.from = fakeFrom;
    // @ts-expect-error installing the recording fake on the singleton
    supabaseAdmin.rpc = fakeRpc;
    // @ts-expect-error installing the recording fake on the singleton
    supabaseAnon.from = fakeFrom;
    // @ts-expect-error installing the recording fake on the singleton
    supabaseAnon.rpc = fakeRpc;
    restoreAuthority = installAgentToolAuthorityTestStore(() => [{
      accountId: ACC_A,
      authUserId: ACC_A,
      role: currentAuthorityRole,
      propertyIds: [PID_A],
    }]);
    // No test may reach the network. Model classifiers and embedders are all
    // behind try/catch, so this just makes them fail fast and deterministically
    // instead of adding a live round-trip (and a flake) per run.
    globalThis.fetch = (async () => {
      throw new Error('network disabled in agent-tool-tenant-isolation');
    }) as typeof fetch;

    for (const tool of perHotelTools()) {
      dbCalls = [];
      rpcCalls = [];
      unevaluatedOps = [];
      let result: ToolRun['result'];
      try {
        result = await executeTool(tool.name, synthesizeArgs(tool.name, tool.inputSchema), contextFor(tool));
      } catch (err) {
        result = { ok: false, error: `threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      runs.set(tool.name, { tool, result, calls: dbCalls, rpcs: rpcCalls, unevaluated: unevaluatedOps });
    }
  });

  after(() => {
    restoreAuthority?.();
    supabaseAdmin.from = originalAdminFrom;
    supabaseAdmin.rpc = originalAdminRpc;
    supabaseAnon.from = originalAnonFrom;
    supabaseAnon.rpc = originalAnonRpc;
    globalThis.fetch = originalFetch;
  });

  test('the catalog is non-empty and every per-hotel tool was exercised', () => {
    const tools = perHotelTools();
    assert.ok(tools.length >= 40, `expected the full catalog, walked ${tools.length}`);
    assert.equal(runs.size, tools.length);

    // The excluded set is exactly the portfolio-surface catalog. A future
    // portfolio tool must get its own company-scope isolation coverage before
    // it is mounted here.
    const walked = new Set(tools.map((t) => t.name));
    const excluded = listAllTools()
      .filter((t) => !walked.has(t.name))
      .map((t) => t.name)
      .sort();
    const portfolio = listAllTools()
      .filter((t) => (t.surfaces ?? ['chat']).includes('portfolio'))
      .map((t) => t.name)
      .sort();
    assert.deepEqual(excluded, portfolio);
  });

  test('no tool is refused before its handler runs (the fixture satisfies every gate)', () => {
    const refused = [...runs.values()]
      .map(r => ({ name: r.tool.name, gate: refusalGate(r.result) }))
      .filter(r => r.gate !== null);
    assert.deepEqual(
      refused,
      [],
      'these tools never reached their handler, so this suite proves nothing about them. ' +
      'Fix the fixture (role / surface / capability / section) — do NOT move them to NO_DB_TOOLS.',
    );
  });

  test('every tool either touches the database or is declared DB-free', () => {
    const silent = [...runs.values()]
      .filter(r => r.calls.length === 0 && r.rpcs.length === 0)
      .map(r => r.tool.name);
    const undeclared = silent.filter(n => !NO_DB_TOOLS.has(n));
    const staleDeclarations = [...NO_DB_TOOLS.keys()].filter(n => runs.has(n) && !silent.includes(n));
    // A tool that no longer exists cannot be DB-free — it is just a name left
    // behind. Without this, a deleted tool's exemption sits here waiting for
    // someone to register that name again and inherit a free pass.
    const declaredButGone = [...NO_DB_TOOLS.keys()].filter(n => !runs.has(n));

    assert.deepEqual(
      declaredButGone,
      [],
      'these names are declared DB-free but are not registered any more — delete the entry, ' +
      'or a future tool registered under one of these names inherits an exemption nobody chose.',
    );
    assert.deepEqual(
      undeclared,
      [],
      'these tools reached no database call, so nothing about their hotel scoping was proven. ' +
      'Either give the fixture arguments that reach the handler\'s query, or declare the tool ' +
      'on NO_DB_TOOLS with a reason.',
    );
    assert.deepEqual(
      staleDeclarations,
      [],
      'these tools are declared DB-free but did query — remove them from NO_DB_TOOLS.',
    );
  });

  test('every query the fake could not evaluate is reported rather than silently passing', () => {
    const unhandled = [...new Set([...runs.values()].flatMap(r => r.unevaluated))];
    assert.deepEqual(
      unhandled,
      [],
      'the fake ignored these filter operators, so its rows were not actually narrowed by them. ' +
      'Teach `matches()` the operator before trusting this suite on those tools.',
    );
  });

  test('no tool result carries anything belonging to the other hotel', () => {
    const leaks: string[] = [];
    for (const run of runs.values()) {
      const text = JSON.stringify(run.result ?? null);
      for (const needle of POISON) {
        if (text.includes(needle)) leaks.push(`${run.tool.name} → returned ${needle}`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  test('no write payload or query filter names the other hotel', () => {
    const leaks: string[] = [];
    for (const run of runs.values()) {
      for (const call of run.calls) {
        const text = JSON.stringify({ payload: call.payload ?? null, filters: call.filters });
        for (const needle of POISON) {
          if (text.includes(needle)) leaks.push(`${run.tool.name} → ${call.verb} ${call.table} referenced ${needle}`);
        }
      }
      for (const rpc of run.rpcs) {
        const text = JSON.stringify(rpc.args ?? null);
        for (const needle of POISON) {
          if (text.includes(needle)) leaks.push(`${run.tool.name} → rpc ${rpc.fn} referenced ${needle}`);
        }
      }
    }
    assert.deepEqual(leaks, []);
  });

  test('every query on a hotel-scoped table carries the hotel filter', () => {
    const unscoped: string[] = [];
    for (const run of runs.values()) {
      for (const call of run.calls) {
        if (GLOBAL_TABLES.has(call.table)) continue;
        const column = scopeColumnFor(call.table);
        if (call.verb === 'insert' || call.verb === 'upsert') {
          const list = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
          const stamped = list.every(r => r && String(r[column]) === PID_A);
          if (!stamped) unscoped.push(`${run.tool.name} → ${call.verb} ${call.table} without ${column}=<this hotel>`);
          continue;
        }
        const scoped = call.filters.some(f => f.op === 'eq' && f.column === column && f.value === PID_A);
        if (scoped) continue;
        const followUp = ROW_KEYED_FOLLOWUPS.get(`${call.table}:${call.verb}`);
        const rowKeyed = !!followUp && followUp.keys.some(k => call.filters.some(f => f.op === 'eq' && f.column === k));
        if (!rowKeyed) unscoped.push(`${run.tool.name} → ${call.verb} ${call.table} without ${column}=<this hotel>`);
      }
    }
    assert.deepEqual(
      unscoped,
      [],
      'each of these reached a tenant table with no hotel filter. If the table is genuinely ' +
      'global, add it to GLOBAL_TABLES with a reason; otherwise scope the query.',
    );
  });

  test('every hotel-scoped RPC is called with this hotel', () => {
    const bad: string[] = [];
    for (const run of runs.values()) {
      for (const rpc of run.rpcs) {
        const args = (rpc.args ?? {}) as Record<string, unknown>;
        const key = Object.keys(args).find(k => /property_id$/.test(k));
        if (!key) continue; // conversation-/reservation-keyed RPCs carry no hotel
        if (args[key] !== PID_A) bad.push(`${run.tool.name} → ${rpc.fn} passed ${key}=${String(args[key])}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});
