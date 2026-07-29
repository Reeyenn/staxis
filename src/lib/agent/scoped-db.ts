// ─── ScopedDb — the AI layer's single database door ─────────────────────────
//
// WHAT THIS IS
// Every database call that originates inside `src/lib/agent/**` should go
// through `scopedDb(propertyId)`. The accessor pre-applies the hotel filter
// (or injects the hotel column on a write) BEFORE handing the PostgREST
// builder back to the caller, so a tool author cannot forget the filter —
// there is no un-filtered builder to forget it on.
//
// WHAT THIS IS *NOT* (read this before quoting it in a security doc)
// This is a BUILD GATE plus a runtime throw inside one module. It is NOT
// row-level security. The database itself still happily serves any row to a
// service-role key held anywhere else in the repo. The real DB-enforced
// guarantee for the AI layer today is INV-28 (agent_messages.property_id is
// derived by a trigger). Everything else here is app-code discipline with a
// machine-checked boundary — see INVARIANTS.md INV-25 … INV-30.
//
// WHY THE CLIENT IS RESOLVED LAZILY
// Every method calls `supabaseAdmin.from(...)` / `.rpc(...)` at CALL time and
// never captures the method at module load. Six existing test files
// monkey-patch the singleton's `.from` / `.rpc` between tests
// (agent-new-action-tools, agent-comms-action-tools, agent-pending-actions,
// agent-activity, agent-inventory-monthly-accounting, …). Capturing at import
// time would silently bypass every one of those fakes.
//
// ESCAPE HATCH
// `unscopedBecause(reason)` returns the raw service-role client for the small
// set of calls that genuinely have no single hotel. `UnscopedReason` is a
// CLOSED union, and `scripts/audit-service-role-imports.mjs` pins how many
// call sites exist — adding one is a deliberate, reviewable act.

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Errors ─────────────────────────────────────────────────────────────────

/** Thrown when a caller tries to read/write a hotel other than the one the
 *  accessor was constructed for. Never caught inside this module — a tenant
 *  mismatch is a bug, not a runtime condition to recover from. */
export class ScopedDbTenantMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopedDbTenantMismatch';
  }
}

/** Thrown when `.from()` names a table that has no hotel column, so the
 *  accessor cannot scope it. Use `unscopedBecause(...)` for those. */
export class ScopedDbUnscopableTable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopedDbUnscopableTable';
  }
}

// ─── Maps ───────────────────────────────────────────────────────────────────

/** Tables whose hotel column is NOT the default `property_id`. */
export const SCOPE_COLUMN_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  properties: 'id',
});

/** The default hotel column. */
export const DEFAULT_SCOPE_COLUMN = 'property_id';

/** Resolve the hotel column for a table. */
export function scopeColumnFor(table: string): string {
  return SCOPE_COLUMN_OVERRIDES[table] ?? DEFAULT_SCOPE_COLUMN;
}

/**
 * Tables that genuinely have no hotel column, so scoping them is impossible.
 * `.from()` on one of these throws — the caller must reach for
 * `unscopedBecause()` with an enumerated reason, which is countable.
 *
 * `agent_messages` used to be on this list. Migration 0336 gave it a
 * `property_id` derived by a BEFORE trigger from its parent conversation, so
 * it is scopable now (INV-28). NOTE: that migration must be APPLIED before
 * any code path reads `agent_messages` through this accessor.
 */
export const UNSCOPABLE_TABLES: ReadonlySet<string> = new Set([
  'accounts',            // global identity table — an account spans hotels
  'agent_prompts',       // global agent config, one row per role
  'agent_eval_baselines', // eval harness bookkeeping, not tenant data
]);

/**
 * RPCs that carry an explicit hotel argument. Calling one through the
 * accessor asserts `args.p_property_id === propertyId`.
 *
 * Any RPC NOT on this list is refused: five of the agent layer's RPCs
 * (staxis_record_assistant_turn, staxis_restore_conversation,
 * staxis_archive_conversation, staxis_finalize_agent_spend,
 * staxis_cancel_agent_spend) are conversation- or reservation-keyed and take
 * no hotel argument at all. The accessor cannot protect those, so they must
 * go through `unscopedBecause('conversation-keyed-rpc')` where the lack of
 * protection is visible and counted rather than implied.
 */
export const PROPERTY_SCOPED_RPCS: ReadonlySet<string> = new Set([
  'staxis_store_memory',
  'staxis_forget_memory',
  'staxis_reserve_agent_spend',
  'staxis_record_inventory_order_intent',
  'staxis_save_inventory_count_for_actor',
  'staxis_lock_load_and_record_user_turn',
  // The hands (0363). Both take the hotel as an argument and refuse to touch a
  // finding_actions row belonging to any other one, so the accessor's assertion
  // and the function's own WHERE clause say the same thing twice.
  'staxis_execute_finding_action',
  'staxis_undo_finding_action',
  // The atomic half of proposing (0369): retire the standing offer and freeze
  // the next one, or neither. Takes the hotel as an argument and filters on it,
  // exactly like the two above.
  'staxis_replace_finding_action',
  // Portfolio Intelligence reads one bounded, receipt-backed current booked-
  // room point plus exact lead-zero baseline points for this hotel.
  'staxis_portfolio_booked_room_points',
]);

/** The hotel-argument name every PROPERTY_SCOPED_RPCS member uses. */
export const RPC_PROPERTY_ARG = 'p_property_id';

// ─── Escape hatch ───────────────────────────────────────────────────────────

/**
 * The complete, closed set of reasons a call inside `src/lib/agent/**` may
 * bypass the accessor. Adding a member is a design decision, not a shortcut —
 * the compiler refuses an ad-hoc string, and the pinned count in
 * `scripts/audit-service-role-imports.mjs` refuses a new call site until the
 * number is bumped.
 */
export type UnscopedReason =
  /** The row belongs to a person, not a hotel (`accounts`). */
  | 'global-identity-table'
  /** Agent configuration shared by every hotel (`agent_prompts`). */
  | 'global-agent-config'
  /** A SECURITY DEFINER RPC keyed on a conversation/reservation, not a hotel. */
  | 'conversation-keyed-rpc'
  /** A cron sweep that deliberately runs across every hotel. */
  | 'cross-property-cron-sweep'
  /** The eval harness, which fabricates its own contexts. */
  | 'eval-harness'
  /** A shared `src/lib/**` helper that takes the raw client plus its own
   *  `pid` argument (e.g. getInventoryAccountingSummary). The helper does its
   *  own scoping; the accessor has nothing to wrap. */
  | 'shared-lib-client-param'
  /** A bounded SECURITY DEFINER portfolio RPC whose exact hotel set and
   *  governing organization are validated atomically inside the database.
   *  It cannot use a one-hotel accessor because its contract is deliberately
   *  multi-hotel. */
  | 'portfolio-exact-set-rpc';

/**
 * Deliberately step outside the hotel boundary. The `reason` argument exists
 * to be read by a human in review — it is not used at runtime.
 */
export function unscopedBecause(reason: UnscopedReason): SupabaseClient {
  void reason;
  return supabaseAdmin;
}

// ─── Builder types ──────────────────────────────────────────────────────────
// The wrapper reuses the CLIENT'S OWN method types verbatim, so a caller gets
// byte-identical inference to `supabaseAdmin.from(t).select(...)` — including
// the literal-column result typing that the rest of the agent layer relies on.
// Re-declaring the signatures by hand collapses `Query extends string` to the
// `string` constraint and turns every `data` row into GenericStringError.

type AdminTable = ReturnType<SupabaseClient['from']>;

type Row = Record<string, unknown>;

export interface ScopedTable {
  /** SELECT with the hotel filter already applied. */
  select: AdminTable['select'];
  /** INSERT with the hotel column injected into every row. */
  insert: AdminTable['insert'];
  /** UPSERT with the hotel column injected into every row. */
  upsert: AdminTable['upsert'];
  /** UPDATE with the hotel filter already applied. */
  update: AdminTable['update'];
  /** DELETE with the hotel filter already applied. */
  delete: AdminTable['delete'];
}

export interface ScopedDb {
  /** The one hotel this accessor can reach. */
  readonly propertyId: string;
  from(table: string): ScopedTable;
  /** RPC, refused unless the function is declared hotel-scoped AND the
   *  supplied `p_property_id` matches this accessor. */
  rpc: SupabaseClient['rpc'];
}

// ─── Implementation ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertPropertyId(propertyId: string): void {
  if (typeof propertyId !== 'string' || !UUID_RE.test(propertyId)) {
    throw new ScopedDbTenantMismatch(
      `scopedDb() needs a property UUID; got ${JSON.stringify(propertyId)}. ` +
      'A tool context without a property must not reach the database.',
    );
  }
}

/**
 * Inject the hotel column into each row, refusing a row that already names a
 * DIFFERENT hotel. Preserves single-vs-array shape so the PostgREST request
 * body is byte-identical to the hand-written version it replaces.
 */
function injectScope(
  table: string,
  column: string,
  propertyId: string,
  values: Row | Row[],
): Row | Row[] {
  const stamp = (row: Row): Row => {
    const supplied = row[column];
    if (supplied !== undefined && supplied !== null && supplied !== propertyId) {
      throw new ScopedDbTenantMismatch(
        `Refusing to write ${table}.${column}=${String(supplied)} through an accessor ` +
        `scoped to ${propertyId}.`,
      );
    }
    return { ...row, [column]: propertyId };
  };
  return Array.isArray(values) ? values.map(stamp) : stamp(values);
}

/**
 * Build the one-hotel database accessor.
 *
 * @param propertyId the ONLY hotel every call through this accessor can touch.
 */
export function scopedDb(propertyId: string): ScopedDb {
  assertPropertyId(propertyId);

  const from = (table: string): ScopedTable => {
    if (UNSCOPABLE_TABLES.has(table)) {
      throw new ScopedDbUnscopableTable(
        `Table "${table}" has no hotel column, so scopedDb cannot scope it. ` +
        'If the read is genuinely global, use unscopedBecause(<reason>) from ' +
        '@/lib/agent/scoped-db and add the call site to the pinned count in ' +
        'scripts/audit-service-role-imports.mjs.',
      );
    }
    const column = scopeColumnFor(table);
    // NOTE: `supabaseAdmin.from(...)` is resolved inside each method, never
    // hoisted — the test suite monkey-patches the singleton between tests.
    // The `as unknown as` casts exist only to re-attach the client's own
    // generic signatures (see the ScopedTable comment); the runtime shape is
    // exactly what supabase-js returns.
    const select = ((columns?: string, options?: never) =>
      supabaseAdmin.from(table).select(columns ?? '*', options).eq(column, propertyId)
    ) as unknown as AdminTable['select'];

    const insert = ((values: Row | Row[], options?: never) =>
      supabaseAdmin.from(table).insert(injectScope(table, column, propertyId, values), options)
    ) as unknown as AdminTable['insert'];

    const upsert = ((values: Row | Row[], options?: never) =>
      supabaseAdmin.from(table).upsert(injectScope(table, column, propertyId, values), options)
    ) as unknown as AdminTable['upsert'];

    const update = ((values: Row, options?: never) =>
      supabaseAdmin.from(table).update(values, options).eq(column, propertyId)
    ) as unknown as AdminTable['update'];

    const del = ((options?: never) =>
      supabaseAdmin.from(table).delete(options).eq(column, propertyId)
    ) as unknown as AdminTable['delete'];

    return { select, insert, upsert, update, delete: del };
  };

  const rpc = ((fn: string, args?: Row) => {
    if (!PROPERTY_SCOPED_RPCS.has(fn)) {
      throw new ScopedDbTenantMismatch(
        `RPC "${fn}" is not declared as hotel-scoped. Either add it to ` +
        'PROPERTY_SCOPED_RPCS in @/lib/agent/scoped-db (it must take ' +
        `${RPC_PROPERTY_ARG}) or call it through ` +
        "unscopedBecause('conversation-keyed-rpc').",
      );
    }
    const supplied = args?.[RPC_PROPERTY_ARG];
    if (supplied !== propertyId) {
      throw new ScopedDbTenantMismatch(
        `RPC "${fn}" was called with ${RPC_PROPERTY_ARG}=${String(supplied)} through an ` +
        `accessor scoped to ${propertyId}.`,
      );
    }
    return supabaseAdmin.rpc(fn, args);
  }) as unknown as SupabaseClient['rpc'];

  return { propertyId, from, rpc };
}
