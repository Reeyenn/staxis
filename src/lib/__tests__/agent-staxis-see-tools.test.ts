/**
 * The six SEE tools — what Staxis itself has noticed, made answerable in chat.
 *
 * Before them the assistant could read every operational table in the hotel and
 * still answer "what has Staxis noticed?" with nothing. These tests are about
 * the two ways that fix could go wrong:
 *
 *   ROUTING — the tool returns the wrong rows, or the wrong shape, so the model
 *   quotes a number that is not the hotel's.
 *
 *   HONESTY — the tool returns a technically-correct empty result and the model
 *   turns it into "everything looks fine". Every one of these tools has a state
 *   where silence means "we did not look", and each of those states is asserted
 *   here as its own case, because that is the failure that costs a customer.
 *
 * Tenant isolation is NOT re-proved here; `agent-tool-tenant-isolation.test.ts`
 * walks `listAllTools()` and therefore already covers all six by construction —
 * that is the point of the sweep walking the registry rather than a list.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeTool,
  getTool,
  listAllTools,
  type ToolContext,
  type ToolResult,
} from '@/lib/agent/tools';
import { scopedDb } from '@/lib/agent/scoped-db';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import '@/lib/agent/tools/index';

const PID = '00000000-0000-0000-0000-00000000f001';
const ACCOUNT = '00000000-0000-0000-0000-00000000f000';

const SEE_TOOLS = [
  'staxis_findings',
  'staxis_explain_finding',
  'staxis_pending_decisions',
  'staxis_preventive',
  'staxis_equipment',
  'staxis_checked_last_night',
] as const;

function ctxFor(role: AppRole = 'general_manager'): ToolContext & { db: ReturnType<typeof scopedDb> } {
  return {
    user: {
      uid: ACCOUNT,
      accountId: ACCOUNT,
      username: 'gm',
      displayName: 'GM',
      role,
      propertyAccess: [PID],
    },
    propertyId: PID,
    staffId: null,
    requestId: 'req-see',
    surface: 'chat',
    db: scopedDb(PID),
  };
}

// ─── The stub ───────────────────────────────────────────────────────────────
//
// Honours `.eq` and `.in` so a handler that forgets a filter gets rows it did
// not ask for, and answers an UNKNOWN relation as 42P01 so a handler reaching
// for a table that does not exist fails loudly rather than reading as empty.

let tables: Record<string, Array<Record<string, unknown>>> = {};
let asked: string[] = [];
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function makeBuilder(table: string) {
  const known = Object.prototype.hasOwnProperty.call(tables, table);
  let rows = [...(tables[table] ?? [])];
  const err = known ? null : { code: '42P01', message: `relation "${table}" does not exist` };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      rows = rows.filter((r) => String(r[col]) === String(val));
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      const set = new Set(vals.map(String));
      rows = rows.filter((r) => set.has(String(r[col])));
      return api;
    },
    gte: () => api,
    lte: () => api,
    is: () => api,
    not: () => api,
    order: () => api,
    limit: () => api,
    maybeSingle: async () => ({ data: known ? (rows[0] ?? null) : null, error: err }),
    single: async () => ({ data: known ? (rows[0] ?? null) : null, error: err }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: known ? rows : null, error: err }).then(resolve),
  };
  return api;
}

beforeEach(() => {
  tables = {};
  asked = [];
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    asked.push(table);
    return makeBuilder(table);
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

/** A findings row in the shape `store.rowToFinding` reads. */
function findingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-1',
    property_id: PID,
    detector_id: 'preventive_due',
    dedupe_key: 'k1',
    summary: 'The boiler service is 12 days past due.',
    severity: 'warn',
    disposition: 'tell',
    status: 'open',
    receipt_query_id: 'preventive.overdue.v1',
    evidence: {
      queryId: 'preventive.overdue.v1',
      params: { taskId: 'pt-1', windowDays: 30 },
      values: { daysOverdue: 12 },
      basis: 'The schedule says every 90 days; the last recorded service was 102 days ago.',
      target: { kind: 'preventive_task', value: 'pt-1' },
    },
    as_of: '2026-07-26T06:00:00.000Z',
    weakest_input_age_days: 0,
    magnitude: 12,
    price_low_cents: 20_000,
    price_high_cents: 40_000,
    price_currency: 'USD',
    price_basis: 'Typical boiler service in this market.',
    first_seen_at: '2026-07-20T06:00:00.000Z',
    last_seen_at: '2026-07-26T06:00:00.000Z',
    occurrence_count: 6,
    status_changed_at: '2026-07-20T06:00:00.000Z',
    resolved_at: null,
    silenced_at_magnitude: null,
    escalated_at: null,
    shown_count: 4,
    acted_count: 0,
    ignored_count: 0,
    judged_disposition: null,
    judged_summary_en: null,
    judged_summary_es: null,
    judged_rationale: null,
    judged_rank: null,
    judged_source: null,
    judged_at: null,
    judged_model: null,
    judged_guard_rejected: null,
    ...over,
  };
}

async function run(name: string, args: unknown = {}, role: AppRole = 'general_manager'): Promise<ToolResult> {
  return executeTool(name, args, ctxFor(role));
}

function dataOf(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, `expected ok, got: ${r.error}`);
  return r.data as Record<string, unknown>;
}

// ─── Registration + gates ───────────────────────────────────────────────────

describe('the SEE tools — registration and gates', () => {
  it('all six are registered, read-only, and carry no approval tier', () => {
    for (const name of SEE_TOOLS) {
      const tool = getTool(name);
      assert.ok(tool, `${name} is not registered`);
      // READ-ONLY is the design constraint, not an accident: approving a Staxis
      // proposal from chat is a separate piece of work with its own gate. A
      // `mutates: true` appearing here means somebody wired execution into the
      // reporting tools.
      assert.notEqual(tool!.mutates, true, `${name} must be read-only`);
      assert.equal(tool!.approval, undefined);
      assert.equal(tool!.pmsFreshness, 'independent', `${name} answers from Staxis's own tables, not the PMS`);
    }
  });

  it('they are per-hotel tools, swept by the tenant-isolation suite', () => {
    // The sweep walks listAllTools() minus the portfolio surface. A SEE tool
    // that declared `surfaces: ['portfolio']` would silently drop out of the
    // only machine check that proves its hotel filter.
    for (const name of SEE_TOOLS) {
      const tool = listAllTools().find((t) => t.name === name);
      assert.ok(tool);
      assert.equal((tool!.surfaces ?? ['chat']).includes('portfolio'), false, `${name} must not be portfolio-scoped`);
    }
  });

  it('the front desk, housekeeping and legacy staff cannot reach any of them', async () => {
    // They mirror manager-tier surfaces (the findings routes all gate on
    // loadManagerCaller). A front-desk agent reading the hotel's money-ranged
    // findings list would be a role escalation through the chat.
    for (const name of SEE_TOOLS) {
      for (const role of ['housekeeping', 'front_desk', 'staff'] as AppRole[]) {
        const res = await run(name, {}, role);
        assert.equal(res.ok, false, `${name} answered a ${role}`);
      }
    }
  });

  it('the maintenance hat reaches five of the six — but never the approval queue', async () => {
    // WHO LENSES (2026-07-27). The person holding the wrench could not ask what
    // Staxis had noticed about the room they were standing in; that was
    // STAXIS_ROLES being the only constant in the file, not a decision. What is
    // a decision: `staxis_pending_decisions` stays manager-only, because an
    // approval queue is not floor work.
    for (const name of SEE_TOOLS) {
      const res = await run(name, {}, 'maintenance' as AppRole);
      if (name === 'staxis_pending_decisions') {
        assert.equal(res.ok, false, 'the approval queue must stay manager-only');
      } else {
        assert.notEqual(
          /is not allowed to use|not part of what you can do/.test(res.error ?? ''),
          true,
          `${name} refused the maintenance hat on role/lens grounds`,
        );
      }
    }
  });

  it('the section gates match the surfaces they mirror', () => {
    for (const name of ['staxis_findings', 'staxis_explain_finding', 'staxis_pending_decisions', 'staxis_checked_last_night']) {
      assert.equal(getTool(name)?.section, 'staxis');
    }
    // Preventive + equipment are the Maintenance section's own data; a hotel
    // that runs Staxis without Maintenance must not get them through the chat.
    for (const name of ['staxis_preventive', 'staxis_equipment']) {
      assert.equal(getTool(name)?.section, 'maintenance');
    }
  });
});

// ─── staxis_findings ────────────────────────────────────────────────────────

describe('staxis_findings', () => {
  it('returns open findings with a money RANGE, never a point estimate', async () => {
    tables.findings = [findingRow()];
    const d = dataOf(await run('staxis_findings'));

    assert.equal(d.count, 1);
    const rows = d.findings as Array<Record<string, unknown>>;
    assert.equal(rows[0].id, 'f-1');
    assert.equal(rows[0].timesSeen, 6);
    // A range, formatted by the findings money layer. A GM repeats a point
    // estimate to an owner as if it were a quote, which is why the schema
    // itself enforces range-or-nothing.
    assert.match(String(rows[0].price), /\$200\s*[–-]\s*\$?400/);
    assert.equal(String(rows[0].price).includes('$300'), false, 'a midpoint leaked out as a figure');
  });

  it('an unpriced finding says so rather than being given a number', async () => {
    tables.findings = [findingRow({ price_low_cents: null, price_high_cents: null, price_basis: null })];
    const rows = dataOf(await run('staxis_findings')).findings as Array<Record<string, unknown>>;
    assert.equal(rows[0].price, null);
  });

  it('an empty list carries the "this is not an all-clear" warning', async () => {
    // THE failure this tool exists to avoid: nothing open reads as "the hotel
    // is fine", when it may mean muted findings, or checks that never ran.
    tables.findings = [];
    const d = dataOf(await run('staxis_findings'));
    assert.equal(d.count, 0);
    assert.match(String(d.note), /not the same as/i);
    assert.match(String(d.note), /staxis_checked_last_night/);
  });

  it('narrowing to a target uses the same matcher the on-the-thing chips use', async () => {
    tables.findings = [
      findingRow({ id: 'f-boiler', evidence: { target: { kind: 'equipment', value: 'eq-1' } } }),
      findingRow({ id: 'f-room', dedupe_key: 'k2', evidence: { target: { kind: 'room', value: '214' } } }),
    ];
    const d = dataOf(await run('staxis_findings', { targetKind: 'room', targetValue: '214' }));
    const rows = d.findings as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'f-room');
  });

  it('refuses a target kind Staxis does not track', async () => {
    tables.findings = [];
    const res = await run('staxis_findings', { targetKind: 'guest', targetValue: 'Smith' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /room|equipment/i);
  });

  it('the limit is clamped in code, not taken on trust from the model', async () => {
    tables.findings = Array.from({ length: 8 }, (_, i) =>
      findingRow({ id: `f-${i}`, dedupe_key: `k${i}` }));
    assert.equal(dataOf(await run('staxis_findings', { limit: 3 })).count, 3);
    // A negative / absurd limit must not become a negative slice or an unbounded read.
    assert.equal(dataOf(await run('staxis_findings', { limit: -5 })).count, 1);
    assert.equal(dataOf(await run('staxis_findings', { limit: 9_999 })).count, 8);
  });
});

// ─── staxis_explain_finding ─────────────────────────────────────────────────

describe('staxis_explain_finding — the receipt', () => {
  it('returns the query, the parameters, the values and the basis', async () => {
    tables.findings = [findingRow()];
    const d = dataOf(await run('staxis_explain_finding', { findingId: 'f-1' }));

    const ev = d.evidence as Record<string, unknown>;
    assert.equal(ev.query, 'preventive.overdue.v1');
    // The window is where explanations most often go wrong — quoting "last 30
    // days" when the detector looked at 90.
    assert.deepEqual(ev.params, { taskId: 'pt-1', windowDays: 30 });
    assert.deepEqual(ev.values, { daysOverdue: 12 });
    assert.match(String(ev.basis), /90 days/);
  });

  it('says plainly when Staxis could not price it, instead of leaving a gap to fill', async () => {
    tables.findings = [findingRow({ price_low_cents: null, price_high_cents: null, price_basis: null })];
    const price = dataOf(await run('staxis_explain_finding', { findingId: 'f-1' })).price as Record<string, unknown>;
    assert.equal(price.range, null);
    assert.match(String(price.unpricedReason), /do not estimate/i);
  });

  it('flags stale inputs so the receipt is not read as current', async () => {
    tables.findings = [findingRow({ weakest_input_age_days: 6 })];
    const age = dataOf(await run('staxis_explain_finding', { findingId: 'f-1' })).dataAge as Record<string, unknown>;
    assert.equal(age.weakestInputAgeDays, 6);
    assert.match(String(age.note), /out of date|stale/i);

    tables.findings = [findingRow({ weakest_input_age_days: 0 })];
    const fresh = dataOf(await run('staxis_explain_finding', { findingId: 'f-1' })).dataAge as Record<string, unknown>;
    assert.equal(fresh.note, null);
  });

  it('refuses an id that is not a finding at this hotel, and refuses an empty one', async () => {
    tables.findings = [findingRow()];
    const missing = await run('staxis_explain_finding', { findingId: 'f-nope' });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /no finding/i);

    const blank = await run('staxis_explain_finding', { findingId: '  ' });
    assert.equal(blank.ok, false);
  });
});

// ─── staxis_pending_decisions ───────────────────────────────────────────────

describe('staxis_pending_decisions', () => {
  it('lists only findings whose EFFECTIVE disposition is propose', async () => {
    tables.findings = [
      findingRow({ id: 'f-tell', disposition: 'tell' }),
      findingRow({ id: 'f-propose', dedupe_key: 'k2', disposition: 'propose' }),
    ];
    tables.finding_actions = [];
    const d = dataOf(await run('staxis_pending_decisions'));
    const rows = d.decisions as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r.findingId), ['f-propose']);
  });

  it('never acts itself — it hands the decision to the tool that asks first', async () => {
    // The tool is deliberately half of the pair. It used to say "you cannot act
    // from this conversation", which stopped being true when the DO wires
    // landed; what must never change is that LISTING is not DECIDING, so the
    // sentence has to send the model somewhere else to act.
    tables.findings = [findingRow({ disposition: 'propose' })];
    tables.finding_actions = [];
    const d = dataOf(await run('staxis_pending_decisions'));
    assert.match(String(d.howToAct), /only lists/i);
    assert.match(String(d.howToAct), /staxis_decide_pending_action/);
    // The tool itself still writes nothing.
    const tool = listAllTools().find((t) => t.name === 'staxis_pending_decisions')!;
    assert.notEqual(tool.mutates, true);
  });

  it('a finding with no live offer is reported as needing hands, not as pending', async () => {
    tables.findings = [findingRow({ disposition: 'propose' })];
    tables.finding_actions = [];
    const rows = dataOf(await run('staxis_pending_decisions')).decisions as Array<Record<string, unknown>>;
    assert.equal(rows[0].offer, null);
    assert.match(String(rows[0].offerState), /by hand/i);
  });

  it('an unreadable company is reported, not silently treated as "no approval needed"', async () => {
    // The whole reason this tool calls resolveSignOffStrict rather than
    // resolveSignOff: a CARD may fold "we could not read the rulebook" into
    // "nothing governs this" because the execute gate catches it later. A
    // SENTENCE has no second gate — the model would say "nothing is blocking
    // this" about a decision that may need the owner's signature.
    tables.findings = [findingRow({ disposition: 'propose' })];
    tables.finding_actions = [];
    // organization_* is left UNKNOWN to the stub, so the company read fails.
    const d = dataOf(await run('staxis_pending_decisions'));
    assert.ok(d.companyNote, 'an unreadable company resolution went unreported');
    assert.match(String(d.companyNote), /could not read|more than one company/i);
  });

  it('says nothing is waiting when nothing is', async () => {
    tables.findings = [];
    tables.finding_actions = [];
    const d = dataOf(await run('staxis_pending_decisions'));
    assert.equal(d.count, 0);
    assert.match(String(d.note), /nothing is waiting/i);
  });
});

// ─── staxis_preventive ──────────────────────────────────────────────────────

describe('staxis_preventive', () => {
  // Match the hotel-local calendar used by the tool. Using UTC here made this
  // suite fail only between Chicago midnight and UTC midnight.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const daysAgo = (n: number): string => {
    const d = new Date(`${today}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  beforeEach(() => {
    tables.properties = [{ id: PID, timezone: 'America/Chicago' }];
  });

  it('computes overdue days in code and puts the latest first', async () => {
    tables.preventive_tasks = [
      { id: 'a', property_id: PID, name: 'Boiler service', area: 'Mechanical', frequency_days: 90,
        last_completed_at: `${daysAgo(100)}T12:00:00Z`, last_completed_by: 'Ana', called_at: null, called_by: null },
      { id: 'b', property_id: PID, name: 'Filter change', area: 'HVAC', frequency_days: 30,
        last_completed_at: `${daysAgo(60)}T12:00:00Z`, last_completed_by: null, called_at: null, called_by: null },
    ];
    const d = dataOf(await run('staxis_preventive'));
    const tasks = d.tasks as Array<Record<string, unknown>>;
    // Filter change is 30 days over; boiler is 10. Heaviest lateness first.
    assert.deepEqual(tasks.map((t) => t.id), ['b', 'a']);
    assert.equal(tasks[0].daysOverdue, 30);
    assert.equal(tasks[1].daysOverdue, 10);
    assert.equal((d.counts as Record<string, number>).overdue, 2);
  });

  it('a task somebody has already called in reads as resting, not as ignored', async () => {
    // "resting" is handled work. Chasing a manager about a task they already
    // phoned a contractor for is exactly the noise that gets a product muted.
    tables.preventive_tasks = [
      { id: 'a', property_id: PID, name: 'Boiler service', area: null, frequency_days: 90,
        last_completed_at: `${daysAgo(100)}T12:00:00Z`, last_completed_by: null,
        called_at: `${daysAgo(1)}T12:00:00Z`, called_by: 'Reeyen' },
    ];
    const tasks = dataOf(await run('staxis_preventive')).tasks as Array<Record<string, unknown>>;
    assert.equal(tasks[0].state, 'resting');
    assert.equal(tasks[0].calledBy, 'Reeyen');
  });

  it('a schedule that has never been done is its own state, not "overdue"', async () => {
    tables.preventive_tasks = [
      { id: 'a', property_id: PID, name: 'Roof inspection', area: null, frequency_days: 365,
        last_completed_at: null, last_completed_by: null, called_at: null, called_by: null },
    ];
    const d = dataOf(await run('staxis_preventive'));
    const tasks = d.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks[0].state, 'never_done');
    assert.equal(tasks[0].lastDone, null);
    assert.equal((d.counts as Record<string, number>).neverDone, 1);
  });

  it('hides in-date schedules by default and includes them on request', async () => {
    tables.preventive_tasks = [
      { id: 'ok', property_id: PID, name: 'Pool test', area: null, frequency_days: 30,
        last_completed_at: `${daysAgo(1)}T12:00:00Z`, last_completed_by: null, called_at: null, called_by: null },
    ];
    const hidden = dataOf(await run('staxis_preventive'));
    assert.equal((hidden.tasks as unknown[]).length, 0);
    assert.match(String(hidden.note), /hidden|includeNotDue/i);

    const all = dataOf(await run('staxis_preventive', { includeNotDue: true }));
    assert.equal((all.tasks as unknown[]).length, 1);
    assert.equal((all.tasks as Array<Record<string, unknown>>)[0].state, 'not_due');
  });

  it('an empty register says the hotel set none up — it does not report all-clear', async () => {
    tables.preventive_tasks = [];
    const d = dataOf(await run('staxis_preventive', { includeNotDue: true }));
    assert.match(String(d.note), /no preventive maintenance schedules/i);
  });

  it('a schedule with no interval is skipped rather than treated as due daily', async () => {
    tables.preventive_tasks = [
      { id: 'bad', property_id: PID, name: 'Someday', area: null, frequency_days: 0,
        last_completed_at: null, last_completed_by: null, called_at: null, called_by: null },
    ];
    const d = dataOf(await run('staxis_preventive', { includeNotDue: true }));
    assert.equal((d.tasks as unknown[]).length, 0);
  });
});

// ─── staxis_equipment ───────────────────────────────────────────────────────

describe('staxis_equipment', () => {
  beforeEach(() => {
    tables.equipment = [
      { id: 'eq-1', property_id: PID, name: 'PTAC 214', category: 'hvac', location: 'Room 214', status: 'operational',
        manufacturer: 'Amana', model_number: 'PTH123', install_date: '2019-03-01',
        replacement_cost: 900, last_pm_at: '2026-05-01', warranty_expires_at: null, created_from: null },
      { id: 'eq-2', property_id: PID, name: 'Old boiler', category: 'plumbing', location: 'Basement', status: 'replaced',
        manufacturer: null, model_number: null, install_date: null,
        replacement_cost: null, last_pm_at: null, warranty_expires_at: null, created_from: null },
    ];
    tables.work_orders = [
      { id: 'wo-1', property_id: PID, equipment_id: 'eq-1', room_number: '214', description: 'Not cooling',
        status: 'resolved', repair_cost: 180, resolved_at: '2026-06-02', created_at: '2026-06-01' },
      { id: 'wo-2', property_id: PID, equipment_id: 'eq-1', room_number: '214', description: 'Rattling',
        status: 'submitted', repair_cost: null, resolved_at: null, created_at: '2026-07-10' },
    ];
    tables.findings = [];
  });

  it('excludes retired assets by default and includes them on request', async () => {
    const live = dataOf(await run('staxis_equipment'));
    assert.deepEqual((live.equipment as Array<Record<string, unknown>>).map((e) => e.id), ['eq-1']);

    const all = dataOf(await run('staxis_equipment', { includeRetired: true }));
    assert.equal((all.equipment as unknown[]).length, 2);
  });

  it('counts tickets in code and reports how many actually carry a cost', async () => {
    const e = (dataOf(await run('staxis_equipment')).equipment as Array<Record<string, unknown>>)[0];
    assert.equal(e.workOrders, 2);
    assert.equal(e.openWorkOrders, 1);
    // repair_cost is stored in DOLLARS on work_orders. Summing it as cents
    // would report $1.80 as $180 — or $180 as $18,000.
    assert.equal(e.recordedRepairSpend, '$180.00');
    // Without this, "$180" reads as the machine's whole lifetime cost when in
    // fact only one of its two tickets has a number on it at all.
    //
    // The regression this pins: `Number(null)` is 0 and 0 IS finite, so a naive
    // `Number.isFinite(Number(repair_cost))` counts every cost-less ticket as
    // costed. Both numbers below were wrong (2, and "$0.00" in the history)
    // until repairCostOf() started treating null as null.
    assert.equal(e.ticketsWithRecordedCost, 1);
    assert.equal(e.ticketsTotal, 2);
  });

  it('a ticket nobody costed reads as no cost, never as $0.00', async () => {
    const one = (dataOf(await run('staxis_equipment', { equipmentId: 'eq-1' })).equipment as Array<Record<string, unknown>>)[0];
    const history = one.history as Array<Record<string, unknown>>;
    const uncosted = history.find((h) => h.description === 'Rattling');
    assert.ok(uncosted);
    // "$0.00" would tell a manager the repair was free. It was not free; nobody
    // wrote the number down, and those are different facts.
    assert.equal(uncosted!.repairCost, null);
    assert.equal(history.find((h) => h.description === 'Not cooling')?.repairCost, '$180.00');
  });

  it('attaches what Staxis has open about the asset', async () => {
    tables.findings = [findingRow({ id: 'f-eq', evidence: { target: { kind: 'equipment', value: 'eq-1' } } })];
    const e = (dataOf(await run('staxis_equipment')).equipment as Array<Record<string, unknown>>)[0];
    assert.deepEqual((e.staxisFindings as Array<Record<string, unknown>>).map((f) => f.id), ['f-eq']);
  });

  it('returns ticket history only when one asset was asked about', async () => {
    const register = (dataOf(await run('staxis_equipment')).equipment as Array<Record<string, unknown>>)[0];
    assert.equal(register.history, undefined);

    const one = (dataOf(await run('staxis_equipment', { equipmentId: 'eq-1' })).equipment as Array<Record<string, unknown>>)[0];
    assert.equal((one.history as unknown[]).length, 2);
  });

  it('refuses an id that is not an asset at this hotel', async () => {
    const res = await run('staxis_equipment', { equipmentId: 'eq-nope' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /no equipment/i);
  });

  it('an empty register says nobody entered any — not that the hotel has none', async () => {
    tables.equipment = [];
    const d = dataOf(await run('staxis_equipment'));
    assert.equal(d.count, 0);
    assert.match(String(d.note), /does not mean the hotel has none/i);
  });
});

// ─── staxis_checked_last_night ──────────────────────────────────────────────

describe('staxis_checked_last_night', () => {
  it('a hotel Staxis has never checked is told exactly that', async () => {
    // The single most damaging answer in the product is "all good" on the back
    // of checks that never ran.
    tables.finding_runs = [];
    tables.findings = [];
    const d = dataOf(await run('staxis_checked_last_night'));
    assert.equal(d.neverChecked, true);
    assert.equal(d.ranAt, null);
    assert.match(String(d.note), /never/i);
    assert.match(String(d.note), /do not describe the hotel as clear/i);
  });

  it('counts "looked normal" as checks minus the DISTINCT detectors that raised something', async () => {
    const runAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    tables.finding_runs = [{ property_id: PID, run_at: runAt, detectors_checked: 34, detectors_skipped: 2, detectors_failed: 0 }];
    // Two findings, ONE detector. Five findings from one check is one check that
    // found something, not five — otherwise "looked normal" undercounts.
    tables.findings = [
      findingRow({ id: 'f-1', detector_id: 'preventive_due' }),
      findingRow({ id: 'f-2', dedupe_key: 'k2', detector_id: 'preventive_due' }),
    ];
    const d = dataOf(await run('staxis_checked_last_night'));
    assert.equal(d.neverChecked, false);
    assert.equal(d.checksRun, 34);
    assert.equal(d.checksThatRaisedSomething, 1);
    assert.equal(d.lookedNormal, 33);
    assert.equal(d.couldNotRun, 2);
    assert.equal(d.fresh, true);
    assert.ok(String(d.liveness).length > 0);
  });

  it('an old run is reported as old rather than answered as if current', async () => {
    const runAt = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();
    tables.finding_runs = [{ property_id: PID, run_at: runAt, detectors_checked: 34, detectors_skipped: 0, detectors_failed: 0 }];
    tables.findings = [];
    const d = dataOf(await run('staxis_checked_last_night'));
    assert.equal(d.fresh, false);
    assert.ok(Number(d.hoursAgo) >= 24 * 5 - 1);
    assert.match(String(d.note), /more than two days old|say when/i);
  });
});
