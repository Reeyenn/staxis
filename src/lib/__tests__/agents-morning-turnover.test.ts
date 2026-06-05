// Morning Turnover template — pure plan() tests with synthetic scope data.
// Imports stay limited to the template module + registry + types + makeConfig
// (all react-server-safe; no server-only / supabase-admin), so this loads under
// `tsx --conditions=react-server`. Count assertions target the notify_manager
// step's payload.message (the engine renders receipts from the action's
// describe(), which echoes payload.message — NOT ProposedAction.reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morningTurnoverTemplate, MORNING_TURNOVER_TEMPLATE_KEY } from '@/lib/agents/templates/morning-turnover';
import { getTemplate } from '@/lib/agents/templates/registry';
import { makeConfig } from './agents-fixtures';
import { AGENT_CONFIG_VERSION, type ActionApprovalMode, type AgentConfig, type ProposedAction } from '@/lib/agents/types';

const DATE = '2026-06-04';
const tmpl = morningTurnoverTemplate;

// A realistic "there is work" snapshot: 14 cleaning tasks, 5 dirty, 9 checkouts,
// 2 housekeepers on shift. Override any slice per test.
function workScopes(over: Record<string, unknown> = {}) {
  return {
    rooms: { date: DATE, total: 50, byStatus: { dirty: 5, in_progress: 0, clean: 45 }, dirty: [] },
    pms: { date: DATE, arrivals: 7, departures: 9 },
    schedule: { date: DATE, totalTasks: 14, byStatus: {}, unassigned: 14 },
    staff: {
      total: 8,
      workingToday: 5,
      byDepartment: { housekeeping: 4, front_desk: 3 },
      staff: [
        { id: 'h1', name: 'A', department: 'housekeeping', scheduledToday: true, isSenior: true },
        { id: 'h2', name: 'B', department: 'housekeeping', scheduledToday: true, isSenior: false },
      ],
    },
    ...over,
  };
}

function notifyStep(p: ProposedAction[]): ProposedAction | undefined {
  return p.find((a) => a.actionKey === 'notify_manager');
}
function msgEn(p: ProposedAction[]): string {
  return String((notifyStep(p)?.payload as { message?: string } | undefined)?.message ?? '');
}
function msgEs(p: ProposedAction[]): string {
  return String((notifyStep(p)?.payload as { messageEs?: string } | undefined)?.messageEs ?? '');
}
function cfgWith(mode: ActionApprovalMode): AgentConfig {
  return makeConfig({
    actions: ['assign_rooms', 'notify_manager'],
    approvalRules: { moneyOrGuestRequiresApproval: true, defaultMode: 'suggest', perAction: { assign_rooms: mode, notify_manager: 'auto' } },
  });
}

// 1 — work present → assign_rooms {} then notify_manager with computed counts.
test('work present → proposes assign_rooms {} then a notify_manager with computed counts', () => {
  const p = tmpl.plan({ scopes: workScopes(), config: tmpl.defaultConfig, asOfDate: DATE });
  assert.equal(p.length, 2);
  assert.equal(p[0].actionKey, 'assign_rooms');
  assert.deepEqual(p[0].payload, {});
  assert.equal(p[1].actionKey, 'notify_manager');
  assert.match(msgEn(p), /14 rooms to turn over/);
  assert.match(msgEn(p), /\(9 checkouts\)/);
  assert.match(msgEn(p), /approval/i); // approve_first verb (defaultConfig)
  assert.match(msgEs(p), /14 habitaciones por preparar/);
  assert.match(msgEs(p), /\(9 salidas\)/);
});

// 2 — roomsToClean = max(cleaningTasks, dirty, checkouts); shown checkouts <= shown rooms.
test('roomsToClean = max(cleaningTasks, dirty, checkouts); shown checkouts never exceed shown rooms', () => {
  // tasks dominate
  let p = tmpl.plan({
    scopes: workScopes({ schedule: { date: DATE, totalTasks: 14, byStatus: {}, unassigned: 0 }, rooms: { date: DATE, total: 50, byStatus: { dirty: 5 }, dirty: [] }, pms: { date: DATE, departures: 9 } }),
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.match(msgEn(p), /14 rooms to turn over/);
  // dirty dominates (5 + 2 in_progress = 7? no — use 18 + 2 = 20)
  p = tmpl.plan({
    scopes: workScopes({ schedule: { date: DATE, totalTasks: 0, byStatus: {}, unassigned: 0 }, rooms: { date: DATE, total: 50, byStatus: { dirty: 18, in_progress: 2 }, dirty: [] }, pms: { date: DATE, departures: 9 } }),
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.match(msgEn(p), /20 rooms to turn over/);
  assert.match(msgEn(p), /\(9 checkouts\)/);
  // checkouts dominate; the parenthetical equals the headline, never exceeds it
  p = tmpl.plan({
    scopes: workScopes({ schedule: { date: DATE, totalTasks: 0, byStatus: {}, unassigned: 0 }, rooms: { date: DATE, total: 50, byStatus: { dirty: 2 }, dirty: [] }, pms: { date: DATE, departures: 12 } }),
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.match(msgEn(p), /12 rooms to turn over/);
  assert.match(msgEn(p), /\(12 checkouts\)/);
});

// 3 — data ready + nothing flagged → exactly one notify_manager, no assign_rooms.
test('data ready + nothing flagged → exactly one notify_manager, no assign_rooms (product call)', () => {
  const p = tmpl.plan({
    scopes: workScopes({ rooms: { date: DATE, total: 50, byStatus: { clean: 50 }, dirty: [] }, pms: { date: DATE, departures: 0 }, schedule: { date: DATE, totalTasks: 0, byStatus: {}, unassigned: 0 } }),
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.equal(p.length, 1);
  assert.equal(p[0].actionKey, 'notify_manager');
  assert.equal(p.some((a) => a.actionKey === 'assign_rooms'), false);
  assert.match(msgEn(p), /no rooms flagged/i);
  assert.match(msgEs(p), /no hay habitaciones/i);
});

// 4 — data not ready → [] and never throws.
test('data not ready (errored / empty / missing scopes) → [] and never throws', () => {
  assert.deepEqual(
    tmpl.plan({ scopes: { rooms: { error: 'boom' }, schedule: { error: 'boom' }, pms: { error: 'boom' }, staff: { error: 'boom' } }, config: tmpl.defaultConfig, asOfDate: DATE }),
    [],
  );
  assert.deepEqual(
    tmpl.plan({ scopes: { rooms: { date: DATE, total: 0, byStatus: {}, dirty: [] }, schedule: { date: DATE, totalTasks: 0, byStatus: {}, unassigned: 0 } }, config: tmpl.defaultConfig, asOfDate: DATE }),
    [],
  );
  assert.deepEqual(tmpl.plan({ scopes: {}, config: tmpl.defaultConfig, asOfDate: DATE }), []);
});

// 5 — readiness honors EVERY work signal: rooms+schedule errored but PMS checkouts known → proposes work.
test('readiness honors all signals: rooms+schedule errored but PMS checkouts known → proposes work, not []', () => {
  const p = tmpl.plan({
    scopes: { rooms: { error: 'boom' }, schedule: { error: 'boom' }, pms: { date: DATE, departures: 9 }, staff: { error: 'boom' } },
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.equal(p.length, 2);
  assert.equal(p[0].actionKey, 'assign_rooms');
  assert.match(msgEn(p), /9 rooms to turn over/);
  assert.match(msgEn(p), /\(9 checkouts\)/);
});

// 6 — checkout clause omitted when PMS unavailable/errored (never "0 checkouts").
test('checkout clause omitted when PMS is unavailable or errored (no false "0 checkouts")', () => {
  let p = tmpl.plan({ scopes: workScopes({ pms: { date: DATE, departures: 0, unavailable: true } }), config: tmpl.defaultConfig, asOfDate: DATE });
  assert.match(msgEn(p), /14 rooms to turn over/);
  assert.doesNotMatch(msgEn(p), /checkout/i);
  assert.doesNotMatch(msgEs(p), /salida/i);

  p = tmpl.plan({ scopes: workScopes({ pms: { error: 'boom' } }), config: tmpl.defaultConfig, asOfDate: DATE });
  assert.match(msgEn(p), /14 rooms to turn over/);
  assert.doesNotMatch(msgEn(p), /checkout/i);
});

// 7 — determinism: same input twice → deepEqual, on both branches.
test('plan() is deterministic — same input twice → deepEqual (work + no-work)', () => {
  const work = { scopes: workScopes(), config: tmpl.defaultConfig, asOfDate: DATE };
  assert.deepEqual(tmpl.plan(work), tmpl.plan(work));
  const idle = { scopes: workScopes({ rooms: { date: DATE, total: 50, byStatus: { clean: 50 }, dirty: [] }, pms: { date: DATE, departures: 0 }, schedule: { date: DATE, totalTasks: 0, byStatus: {}, unassigned: 0 } }), config: tmpl.defaultConfig, asOfDate: DATE };
  assert.deepEqual(tmpl.plan(idle), tmpl.plan(idle));
});

// 8 — config-aware verb mirrors the configured assign_rooms mode.
test('the summary verb mirrors the configured assign_rooms mode', () => {
  assert.match(msgEn(tmpl.plan({ scopes: workScopes(), config: cfgWith('auto'), asOfDate: DATE })), /assigning across the team now/i);
  assert.match(msgEn(tmpl.plan({ scopes: workScopes(), config: cfgWith('approve_first'), asOfDate: DATE })), /ready for your approval/i);
  assert.match(msgEn(tmpl.plan({ scopes: workScopes(), config: cfgWith('suggest'), asOfDate: DATE })), /suggested assignments/i);
});

// 9 — staffing warning present when HK in roster but none scheduled; omitted when staff unreadable.
test('staffing warning fires when housekeepers exist but none are scheduled; omitted when staff unreadable', () => {
  const p1 = tmpl.plan({
    scopes: workScopes({ staff: { total: 4, workingToday: 0, byDepartment: { housekeeping: 4 }, staff: [
      { id: 'h1', name: 'A', department: 'housekeeping', scheduledToday: false, isSenior: false },
      { id: 'h2', name: 'B', department: 'housekeeping', scheduledToday: false, isSenior: false },
    ] } }),
    config: cfgWith('auto'), asOfDate: DATE,
  });
  assert.match(msgEn(p1), /no housekeepers are on shift/i);
  assert.match(msgEs(p1), /recamareras en turno/i);
  assert.doesNotMatch(msgEn(p1), /assigning across the team/i); // warning replaces the verb

  const p2 = tmpl.plan({ scopes: workScopes({ staff: { error: 'boom' } }), config: cfgWith('auto'), asOfDate: DATE });
  assert.doesNotMatch(msgEn(p2), /no housekeepers/i);
  assert.match(msgEn(p2), /assigning across the team now/i);
});

// 10 — notify message always non-empty on every proposing branch (load-bearing for validate()).
test('notify message is always non-empty (EN + ES) on every proposing branch', () => {
  const work = tmpl.plan({ scopes: workScopes(), config: tmpl.defaultConfig, asOfDate: DATE });
  assert.ok(msgEn(work).length > 0 && msgEs(work).length > 0);
  const idle = tmpl.plan({ scopes: workScopes({ rooms: { date: DATE, total: 50, byStatus: { clean: 50 }, dirty: [] }, pms: { date: DATE, departures: 0 }, schedule: { date: DATE, totalTasks: 0, byStatus: {}, unassigned: 0 } }), config: tmpl.defaultConfig, asOfDate: DATE });
  assert.ok(msgEn(idle).length > 0 && msgEs(idle).length > 0);
});

// 11 — garbage scope shapes do not throw; num() coerces non-numbers to 0.
test('garbage scope shapes do not throw; num() coerces non-numbers to 0', () => {
  // total>0 (ready) but every count is non-numeric → roomsToClean 0 → no-work notify
  const p1 = tmpl.plan({
    scopes: {
      rooms: { date: DATE, total: 50, byStatus: undefined, dirty: null },
      pms: { date: DATE, arrivals: 'x', departures: '9' },
      schedule: { date: DATE, totalTasks: null, byStatus: {}, unassigned: 'n/a' },
      staff: { total: 'lots', byDepartment: null, staff: 'nope' },
    },
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.equal(p1.length, 1);
  assert.equal(p1[0].actionKey, 'notify_manager');
  assert.match(msgEn(p1), /no rooms flagged/i);

  // work present with garbage staff/byStatus still builds a message (no throw)
  const p2 = tmpl.plan({
    scopes: {
      rooms: { date: DATE, total: 50, byStatus: { dirty: 7, in_progress: 'x' }, dirty: [] },
      pms: { date: DATE, departures: 4 },
      schedule: { date: DATE, totalTasks: 0 },
      staff: { byDepartment: { housekeeping: 'three' }, staff: [{ department: 'housekeeping' }] },
    },
    config: tmpl.defaultConfig, asOfDate: DATE,
  });
  assert.equal(p2.length, 2);
  assert.match(msgEn(p2), /7 rooms to turn over/); // dirty 7 + in_progress 'x'→0
  assert.match(msgEn(p2), /\(4 checkouts\)/);
});

// 12 — defaultConfig + requiredScopes are well-formed (what the wizard inherits).
test('defaultConfig + requiredScopes are well-formed', () => {
  const c = tmpl.defaultConfig;
  assert.equal(c.version, AGENT_CONFIG_VERSION);
  assert.equal(c.trigger.type, 'schedule');
  assert.equal((c.trigger as { atLocalTime: string }).atLocalTime, '08:00');
  assert.deepEqual(c.actions, ['assign_rooms', 'notify_manager']);
  assert.equal(c.approvalRules.perAction['assign_rooms'], 'approve_first');
  assert.equal(c.approvalRules.perAction['notify_manager'], 'auto');
  assert.equal(c.approvalRules.moneyOrGuestRequiresApproval, true);
  assert.deepEqual([...tmpl.requiredScopes].sort(), ['pms', 'rooms', 'schedule', 'staff']);
});

// 13 — importing the module self-registers it so the engine/catalog can resolve it.
test('importing the module registers morning-turnover so the engine can resolve it', () => {
  assert.equal(getTemplate(MORNING_TURNOVER_TEMPLATE_KEY)?.key, MORNING_TURNOVER_TEMPLATE_KEY);
  assert.equal(getTemplate('morning-turnover'), tmpl);
});
