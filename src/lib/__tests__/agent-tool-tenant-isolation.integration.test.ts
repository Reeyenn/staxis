/**
 * PROOF, not assertion: every registered agent tool, run on behalf of hotel A
 * against a REAL Postgres holding both hotels' rows, must not read, return, or
 * write anything belonging to hotel B.
 *
 * WHY THIS FILE EXISTS
 * `agent-tool-tenant-isolation.test.ts` walks the same catalog against a
 * hand-written FAKE client. That fake can show a query CARRIED a hotel filter;
 * it cannot show the filter WORKS, because the fake — not the query planner —
 * decides which rows come back. INVARIANTS.md called this out under DINV-1 as
 * the highest-value gap in the whole doc:
 *
 *     "the per-handler .eq('property_id', …) filter is NOT covered by the
 *      hermetic bank … that check needs a database."
 *
 * This is that database. Production migrations are applied to PGlite, two
 * hotels are seeded from the resulting catalog, and the REAL handlers run
 * through the REAL `scopedDb` accessor against it.
 *
 * HOW A LEAK WOULD SHOW UP
 * Hotel B's rows are deliberately reachable. Lookup columns (`room_number`,
 * `name`, `username`) hold the SAME value on both sides, so a handler that
 * filters `.eq('room_number','101')` and forgets the hotel filter MATCHES
 * hotel B's row and hands it back. Every uuid on those rows starts
 * `bbbbbbbb-` and every free-text column carries `ZZLEAKB`, so the leak is
 * visible in the tool's own output.
 *
 * WHAT THIS PROVES, PRECISELY
 *   1. no tool RESULT carries a hotel-B value;
 *   2. no STATEMENT any tool ran returned a hotel-B row — a leak is caught at
 *      the database boundary even when the handler drops the row on the floor;
 *   3. no tool CHANGED any hotel-B row (fingerprint before/after), which is
 *      the unfiltered-UPDATE case a read-only test cannot see;
 *   4. every statement against a hotel-scoped table carried the hotel filter.
 *
 * WHAT IT DOES NOT PROVE
 *   • Nothing about RLS. PGlite runs as the table owner, exactly as the
 *     service-role key bypasses policies in production. The boundary under
 *     test is app code.
 *   • Only what the fixture reaches: a tool whose arguments never get past its
 *     own validation proves nothing, so the suite FAILS on that rather than
 *     counting it as covered.
 *   • Only tables the seeder could fill. UNSEEDABLE_TABLES is the declared
 *     list, and the suite fails if it grows.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

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

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
  type RecordedStatement,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  fingerprintHotelB,
  seedTwoHotels,
  LEAK_MARKER,
  PID_A,
  PID_B,
  localToday,
  type SeedResult,
} from '../../../tests/fixtures/pglite-two-hotel-seed';

// ─── What counts as hotel B ─────────────────────────────────────────────────

/** Any of these appearing on hotel A's side of the wall is a leak. */
const LEAK_NEEDLES = ['bbbbbbbb-', LEAK_MARKER, PID_B];

function leaksIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  return LEAK_NEEDLES.filter((needle) => text.includes(needle));
}

// ─── Declared exemptions ────────────────────────────────────────────────────

/**
 * Tables no generated row can satisfy, so they hold no hotel-B row and a query
 * against them proves nothing about leaks (the scope-filter check below still
 * covers them). Every entry is a real constraint the seeder cannot infer.
 *
 * The suite fails if this set grows OR shrinks: growing means coverage was
 * lost, shrinking means an entry is stale.
 */
const UNSEEDABLE_TABLES = new Set([
  'account_access_cutover_repair_dispositions', // service-only cutover evidence, never seeded as hotel data
  'account_access_cutover_repair_manifests', // service-only exact-incident evidence, never seeded as hotel data
  'account_access_cutover_repair_receipts', // service-only cutover evidence, never seeded as hotel data
  'account_access_cutover_normal_legacy_manifests', // service-only normal-legacy conversion evidence, never seeded as hotel data
  'admin_hotel_relationship_mutation_requests', // actor/relationship lifecycle request shape
  'company_structure_mutation_requests', // actor/company structure request shape
  // 0417. rule_text carries a CHECK requiring 8 to 400 characters and no trust
  // marker, which the generated value cannot satisfy. The scope-filter check
  // below still covers it, and the renderer's own fence is proven in
  // companion-rules-tier.test.ts.
  'hotel_standing_rules',
  'inventory_delivery_reentries',  // NOT NULL key onto a replacement-request row
  // 0452. A CHECK requires either a percentage or a rooms-sold count, and a
  // second requires month_start to be the first of its month. A generated row
  // satisfies neither. The scope-filter check below still covers the table, and
  // its own tenancy is proven in inventory-import-occupancy.test.ts.
  'inventory_import_occupancy_months',
  'management_pattern_candidate_local_instances', // immutable candidate/run lineage
  'management_pattern_candidate_properties', // immutable candidate/run lineage
  'management_pattern_cohort_members', // immutable cohort/run lineage
  'management_pattern_metric_observations', // immutable run/query/source lineage
  'management_pattern_property_profiles', // immutable run/profile lineage
  'management_pattern_run_properties', // immutable run/topology snapshot lineage
  'organization_access_grants',    // NOT NULL key onto an unseedable membership
  'organization_access_requests',  // NOT NULL key onto an unseedable membership
  'organization_invitations',      // scope-shape XOR over four nullable columns
  'portfolio_knowledge_request_artifacts', // request artifact requires portfolio receipt lineage
  'portfolio_metric_snapshots',    // snapshot requires a canonical metric/source receipt
  'portfolio_model_request_artifacts', // request artifact requires portfolio receipt lineage
  'portfolio_properties',          // NOT NULL key onto an unseedable portfolio scope
  'portfolio_query_receipts',      // receipt requires an authorized portfolio query lease
  'staxis_support_sessions',       // scope-shape XOR over hotel/org columns
]);

/**
 * Tables with no hotel column at all — a query against one legitimately
 * carries no scope filter. Mirrors UNSCOPABLE_TABLES in scoped-db.ts plus the
 * fleet-wide AI configuration and per-PMS-family knowledge tables.
 */
const GLOBAL_TABLES = new Set([
  'accounts',                   // an account spans hotels
  'agent_prompts',              // one row per role, shared by every hotel
  'agent_eval_baselines',       // eval bookkeeping
  'ai_feature_config_versions', // which model runs which AI feature, fleet-wide
  'ai_model_catalog',           // the model catalogue itself
  'pms_knowledge_files',        // versioned per PMS FAMILY, shared by design (0201)
  'pms_feed_catalog',           // the list of feed TYPES that exist
  'catalog_items',              // the shared product catalogue
]);

/**
 * Follow-up reads/writes keyed on a row the same call path just created or
 * just read inside a hotel-scoped flow. Declared per table+verb rather than
 * assumed, and the call must still be genuinely row-keyed.
 */
const ROW_KEYED_FOLLOWUPS = new Map<string, { keys: string[]; why: string }>([
  ['complaints:update', { keys: ['id'], why: 'links the work order onto the complaint this call just inserted' }],
  ['complaints:select', { keys: ['id'], why: 're-reads the complaint this call just inserted' }],
  ['comms_conversations:update', { keys: ['id'], why: 'stamps last_message_at on a conversation resolved by a hotel-scoped read' }],
  ['comms_members:update', { keys: ['conversation_id'], why: 'marks the sender read on the conversation it just posted to' }],
]);

/**
 * Every tool execution now performs a fresh active-account + authoritative
 * property-standing read before its handler. A handler may remain in-memory
 * (for example `walk_user_through`), but its execution is deliberately not
 * DB-free: immediate revocation must stop it before any result is returned.
 * Keep the exact-set assertion below so a future zero-read path fails loudly.
 */
// Deliberately empty, and it is not the same list as the unit twin's. There,
// the fake records only the queries a HANDLER makes, so a handler that reads
// nothing (walk_user_through, staxis_show_pattern) has to declare itself. Here
// the database is real and every tool reaches it through the re-authorization
// preamble before its handler runs, so "declared DB-free" would be false of
// everything.
const NO_DB_TOOLS = new Map<string, string>();

/**
 * The PER-HOTEL catalog — the subject of this file.
 *
 * Cross-hotel chat (2026-07-26) added a disjoint second catalog: tools that
 * declare `surfaces: ['portfolio']` and answer for a whole management company.
 * This fixture is TWO HOTELS with no companies at all, and it builds a
 * one-hotel context with no `portfolio` scope — which `executeTool` refuses
 * before the handler. Walking them here would record a pre-handler refusal for
 * every one and prove nothing about their wall.
 *
 * That wall is a different question anyway ("was the SET of hotels right", not
 * "did this query carry a hotel filter") and it is proved against a real
 * Postgres holding TWO COMPANIES in `portfolio-chat-leak.integration.test.ts`,
 * including the same statement-level leak audit this file performs.
 *
 * The split is asserted below, so a per-hotel tool cannot be hidden from this
 * suite by tagging it `portfolio`. The current portfolio route is
 * deterministic and mounts no generic tools, so an empty excluded set is
 * expected until a future company-scope tool receives its own proof.
 */
function perHotelTools(): ReturnType<typeof listAllTools> {
  return listAllTools().filter((t) => !(t.surfaces ?? ['chat']).includes('portfolio'));
}

// ─── Argument synthesis ─────────────────────────────────────────────────────
// Derived from each tool's OWN inputSchema, with named overrides chosen to
// match the seeded hotel-A row so handlers reach their queries.

const TODAY = localToday();

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
  newCount: 5,
  nights: 1,
  days: 7,
  limit: 5,
};

/** Handlers whose schema offers mutually exclusive options. */
const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  create_reminder: { department: undefined },
};

function synthesizeArgs(
  name: string,
  schema: ToolDefinition['inputSchema'],
  rowIdA: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, rawSpec] of Object.entries(schema.properties ?? {})) {
    const spec = (rawSpec ?? {}) as { type?: string; enum?: unknown[] };
    if (Array.isArray(spec.enum) && spec.enum.length > 0) { out[key] = spec.enum[0]; continue; }
    if (key in NAMED_ARGS) { out[key] = NAMED_ARGS[key]; continue; }
    if (/Id$/.test(key) && spec.type !== 'number') { out[key] = rowIdA; continue; }
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

// ─── The walk ───────────────────────────────────────────────────────────────

type ToolRun = {
  tool: ToolDefinition;
  result: { ok: boolean; data?: unknown; error?: string };
  statements: RecordedStatement[];
};

let pg: PGlite;
let catalog: Catalog;
let seed: SeedResult;
let shim: PglitePostgrest;
let fingerprintBefore: Map<string, string>;
let fingerprintAfter: Map<string, string>;
const runs = new Map<string, ToolRun>();

const originalAdminFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalAdminRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalAnonFrom = supabaseAnon.from.bind(supabaseAnon);
const originalAnonRpc = supabaseAnon.rpc.bind(supabaseAnon);
const originalFetch = globalThis.fetch;

function contextFor(tool: ToolDefinition): ToolContext {
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
  return {
    user: {
      uid: seed.ids.get('auth.users:A') ?? PID_A,
      accountId: seed.ids.get('accounts:A') ?? PID_A,
      username: 'maria-a',
      displayName: 'Maria Garcia',
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
    staffId: seed.ids.get('staff:A') ?? null,
    requestId: 'pglite-tenant-isolation',
    surface,
    enabledSections: null,
  };
}

describe('every agent tool is confined to one hotel, proven against a real database', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    catalog = await loadCatalog(pg);
    seed = await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);
    fingerprintBefore = await fingerprintHotelB(pg, catalog);

    // Both singletons: nine tool files reach the database through shared
    // `src/lib/**` modules, and one shared read goes through the browser client
    // even on the server.
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAnon.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAnon.rpc = shim.rpc;
    globalThis.fetch = (async () => {
      throw new Error('network disabled in agent-tool-tenant-isolation.integration');
    }) as typeof fetch;

    const rowIdA = seed.ids.get('staff:A') ?? PID_A;
    for (const tool of perHotelTools()) {
      shim.reset();
      let result: ToolRun['result'];
      try {
        result = await executeTool(
          tool.name,
          synthesizeArgs(tool.name, tool.inputSchema, rowIdA),
          contextFor(tool),
        );
      } catch (err) {
        result = { ok: false, error: `threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      runs.set(tool.name, { tool, result, statements: [...shim.statements] });
    }

    fingerprintAfter = await fingerprintHotelB(pg, catalog);
  });

  after(async () => {
    supabaseAdmin.from = originalAdminFrom;
    supabaseAdmin.rpc = originalAdminRpc;
    supabaseAnon.from = originalAnonFrom;
    supabaseAnon.rpc = originalAnonRpc;
    globalThis.fetch = originalFetch;
    // The WASM backend exits the process with status 100 if it is still open
    // when the event loop drains, which turns a green run red.
    await pg?.close();
  });

  // ── the fixture is actually a two-hotel database ────────────────────────

  test('both hotels exist, and hotel B has rows in the tables tools read', async () => {
    const counts = await pg.query<{ n: number }>(
      'select count(*)::int as n from properties where id in ($1, $2)', [PID_A, PID_B],
    );
    assert.equal(counts.rows[0]?.n, 2, 'both hotels must be in the database');

    const tenantTables = [...catalog.tables.values()]
      .filter((t) => t.kind === 'r' && t.byName.has('property_id'))
      .map((t) => t.name);
    assert.ok(tenantTables.length > 100, `expected the real schema, saw ${tenantTables.length} hotel tables`);

    const withoutB: string[] = [];
    for (const table of tenantTables) {
      const r = await pg.query<{ n: number }>(
        `select count(*)::int as n from "${table}" where property_id = $1`, [PID_B],
      );
      if ((r.rows[0]?.n ?? 0) === 0) withoutB.push(table);
    }
    assert.deepEqual(
      withoutB.sort(),
      [...UNSEEDABLE_TABLES].sort(),
      'the set of tables with no hotel-B row must match the declared list exactly — ' +
      'a new name means coverage was silently lost, a missing one means the entry is stale.',
    );
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

  test('no tool is refused before its handler runs', () => {
    const refused = [...runs.values()]
      .map((r) => ({ name: r.tool.name, gate: refusalGate(r.result) }))
      .filter((r) => r.gate !== null);
    assert.deepEqual(refused, [],
      'these tools never reached their handler, so this suite proves nothing about them.');
  });

  test('every tool either reaches the database or is declared DB-free', () => {
    const silent = [...runs.values()].filter((r) => r.statements.length === 0).map((r) => r.tool.name);
    const undeclared = silent.filter((n) => !NO_DB_TOOLS.has(n));
    const stale = [...NO_DB_TOOLS.keys()].filter((n) => runs.has(n) && !silent.includes(n));
    assert.deepEqual(undeclared, [],
      'these tools ran no statement, so nothing about their hotel scoping was proven.');
    assert.deepEqual(stale, [], 'these tools are declared DB-free but did query.');
  });

  test('every query the shim could not compile is reported rather than silently passing', () => {
    assert.deepEqual([...new Set(shim.unsupported)], [],
      'the shim could not compile these, so those queries never actually ran. ' +
      'Teach tests/fixtures/postgrest-pglite.ts the syntax before trusting this suite on them.');
  });

  // ── the actual proof ────────────────────────────────────────────────────

  test('no tool result carries anything belonging to the other hotel', () => {
    const leaks: string[] = [];
    for (const run of runs.values()) {
      for (const needle of leaksIn(run.result)) {
        leaks.push(`${run.tool.name} → returned ${needle}`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  test('no statement any tool ran returned a row belonging to the other hotel', () => {
    const leaks: string[] = [];
    for (const run of runs.values()) {
      for (const statement of run.statements) {
        for (const row of statement.rows) {
          for (const needle of leaksIn(row)) {
            leaks.push(`${run.tool.name} → ${statement.verb} ${statement.target} read ${needle}`);
          }
        }
      }
    }
    assert.deepEqual([...new Set(leaks)], [],
      'these statements crossed the hotel boundary at the database. Even where the handler ' +
      'discarded the row, the query itself was not confined to one hotel.');
  });

  test('no write payload or query filter names the other hotel', () => {
    const leaks: string[] = [];
    for (const run of runs.values()) {
      for (const statement of run.statements) {
        const named = leaksIn({ payload: statement.payload ?? null, filters: statement.filters });
        for (const needle of named) {
          leaks.push(`${run.tool.name} → ${statement.verb} ${statement.target} referenced ${needle}`);
        }
      }
    }
    assert.deepEqual([...new Set(leaks)], []);
  });

  test('not one hotel-B row was changed by the whole walk', () => {
    const changed: string[] = [];
    for (const [table, before] of fingerprintBefore) {
      const now = fingerprintAfter.get(table);
      if (now !== before) changed.push(`${table}: ${before} → ${now}`);
    }
    assert.deepEqual(changed, [],
      'a tool wrote across the hotel boundary — an UPDATE or DELETE that lost its filter.');
  });

  test('every statement on a hotel-scoped table carries the hotel filter', () => {
    const unscoped: string[] = [];
    for (const run of runs.values()) {
      for (const statement of run.statements) {
        if (statement.kind !== 'table') continue;
        if (GLOBAL_TABLES.has(statement.target)) continue;
        const meta = catalog.tables.get(statement.target);
        if (meta && !meta.byName.has('property_id') && statement.target !== 'properties') continue;
        const column = scopeColumnFor(statement.target);
        if (statement.verb === 'insert' || statement.verb === 'upsert') {
          const list = (Array.isArray(statement.payload) ? statement.payload : [statement.payload]) as Array<Record<string, unknown>>;
          const stamped = list.every((r) => r && String(r[column]) === PID_A);
          if (!stamped) unscoped.push(`${run.tool.name} → ${statement.verb} ${statement.target} without ${column}=<this hotel>`);
          continue;
        }
        const scoped = statement.filters.some(
          (f) => f.op === 'eq' && f.column === column && f.value === PID_A,
        );
        if (scoped) continue;
        const followUp = ROW_KEYED_FOLLOWUPS.get(`${statement.target}:${statement.verb}`);
        const rowKeyed = !!followUp
          && followUp.keys.some((k) => statement.filters.some((f) => f.op === 'eq' && f.column === k));
        if (!rowKeyed) {
          unscoped.push(`${run.tool.name} → ${statement.verb} ${statement.target} without ${column}=<this hotel>`);
        }
      }
    }
    assert.deepEqual([...new Set(unscoped)], [],
      'each of these reached a hotel table with no hotel filter.');
  });

  test('every hotel-scoped RPC is called with this hotel', () => {
    const bad: string[] = [];
    for (const run of runs.values()) {
      for (const statement of run.statements) {
        if (statement.kind !== 'rpc') continue;
        const args = (statement.payload ?? {}) as Record<string, unknown>;
        const key = Object.keys(args).find((k) => /property_id$/.test(k));
        if (!key) continue;
        if (args[key] !== PID_A) bad.push(`${run.tool.name} → ${statement.target} passed ${key}=${String(args[key])}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});
