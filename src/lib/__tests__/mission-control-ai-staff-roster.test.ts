/**
 * Mission Control's AI STAFF column, and the two ways it can quietly lie.
 *
 * WHAT WENT WRONG. The Morning Briefer was hired — a flag in the AI employee
 * registry, a page at /admin/ai-staff, a kill switch behind it — and the
 * founder's own dashboard went on listing one member of AI staff: the copilot.
 * The column was written before there was a roster to read, so it did not read
 * one. That failure is silent by construction: the section renders, the count
 * is a number, and nothing about the screen suggests somebody is missing from
 * it.
 *
 * So the checks below are about the column being ROSTER-DRIVEN rather than
 * about the Morning Briefer specifically. Employee #2 is twenty lines in the
 * registry and no edit here; a test that only knew the Briefer's name would
 * pass on the day #2 went missing.
 *
 * AND ABOUT WHAT A ROW IS ALLOWED TO CLAIM. Two things on that row are claims
 * the product has to be able to back — the status ("Ready — waiting for the
 * master switch" is a different sentence from "On", and only one of them is
 * true) and the money. `$0.00` beside an employee whose spend nothing tracks
 * reads as "it ran today and cost nothing"; the honest render of not knowing
 * is no number at all, and the last group here holds that line.
 *
 * HOW IT RUNS. `npm test` runs under `--conditions=react-server`, where
 * react-dom/server will not load, so the house pattern applies: the two pieces
 * under test are hook-free, they are called as plain functions, and the
 * element tree they return is walked. Child elements (CopilotRow, RobotRow)
 * are never executed — they are nodes in that tree, which is exactly what the
 * count-and-membership checks need to look at.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

import {
  AI_EMPLOYEES,
  EMPLOYEE_STATUS_LABEL,
  hiredAiEmployees,
  type AiEmployee,
} from '@/lib/ai/employee-registry';
// The fold moved to the module the route reads it from: since 0374 the AI
// Staff page needs the same arithmetic, and a lib module cannot import from a
// route that already imports it. Same function, same contract.
import { billedBundleKeys, foldSpendRows, type SpendRow } from '@/lib/ai/employee-spend';
import { AI_FEATURE_KEYS } from '@/lib/ai/feature-registry';

// ── Why the React shim ──────────────────────────────────────────────────────
// React 19's react-server build exports no createContext, and this surface
// reaches LanguageContext at module load. Nothing here mounts a hooks-using
// component, so a stub context is enough to get the module loaded. Installed
// on the LIVE `react` module object (not an esbuild namespace copy), hence
// createRequire — same shim, same reasons, as concourse-queue-honesty.test.ts.
const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type SurfaceModule = typeof import('@/app/admin/_components/studio/surfaces/MissionControlSurface');
type StaffMember = Parameters<SurfaceModule['AiEmployeeRow']>[0]['e'];

let surface: SurfaceModule;
let R: typeof import('react');

before(async () => {
  const react = nodeRequire('react') as Record<string, unknown>;
  if (typeof react.createContext !== 'function') {
    react.createContext = (defaultValue: unknown) => ({
      Provider: () => null,
      Consumer: () => null,
      _currentValue: defaultValue,
    });
  }
  R = react as unknown as typeof import('react');
  surface = await import('@/app/admin/_components/studio/surfaces/MissionControlSurface');
});

// ─── Tree walking ───────────────────────────────────────────────────────────

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };
type AnyElement = React.ReactElement<AnyProps>;

/** Every element in a returned tree, parents before children. */
function elementsOf(node: React.ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => elementsOf(child, out));
    return out;
  }
  if (R.isValidElement<AnyProps>(node)) {
    out.push(node);
    elementsOf(node.props.children, out);
  }
  return out;
}

/**
 * Every string a reader could end up seeing: text children, and string props
 * (the kit's `Metric` takes its label and value as props, so a walk of
 * children alone would miss the money entirely — which is the one thing the
 * last group here is trying to catch).
 */
function stringsOf(node: React.ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => stringsOf(child, out));
    return out;
  }
  if (R.isValidElement<AnyProps>(node)) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key !== 'children' && typeof value === 'string') out.push(value);
    }
    stringsOf(node.props.children, out);
  }
  return out;
}

function elementsNamed(tree: React.ReactNode, fn: unknown): AnyElement[] {
  return elementsOf(tree).filter((el) => el.type === fn);
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** What the endpoint hands the column for one hired employee. Built from a
 *  real registry entry so a roster rename travels into these checks. */
function memberOf(e: AiEmployee, over: Partial<StaffMember> = {}): StaffMember {
  return {
    id: e.id,
    name: e.name,
    job: e.job,
    hired: true,
    status: 'waiting_for_master',
    spend: { known: true, usd: 0.42, todayUsd: 0.07 },
    ...over,
  } as StaffMember;
}

const BRIEFER = hiredAiEmployees()[0];

/** A future hire. Stands in for "the registry gained an employee and nobody
 *  touched this file", which is the whole point of the column reading a
 *  roster instead of listing names. */
const FUTURE_HIRE: AiEmployee = {
  id: 'night_auditor',
  name: { en: 'Night Auditor', es: 'Auditor nocturno' },
  job: { en: 'Reconciles the overnight totals.', es: 'Cuadra los totales de la noche.' },
  hired: true,
  bundle: { features: [], detectors: [], crons: [], surfaces: [] },
};

function column(employees: StaffMember[], robots: unknown[] = []) {
  return surface.AiStaffColumn({
    metrics: null,
    employees,
    robots: robots as Parameters<SurfaceModule['AiStaffColumn']>[0]['robots'],
    l: 'en',
    busyKey: null,
    onAction: () => {},
  });
}

const ROBOT = { property_id: 'p1', status: 'alive', last_alive_at: null } as unknown;

// ─── 1. the column reads the roster ─────────────────────────────────────────

describe('who the AI STAFF column lists', () => {
  test('the one hired employee gets a row of their own', () => {
    const rows = elementsNamed(column([memberOf(BRIEFER)]), surface.AiEmployeeRow);
    assert.equal(rows.length, 1);
    assert.equal((rows[0].props.e as StaffMember).id, BRIEFER.id);
  });

  test('a roster that gained a hire renders it, with no edit to this column', () => {
    // The regression this file exists for, in reverse: the column must be
    // driven by what it is handed. Hardcoding the copilot — or the Briefer —
    // fails right here.
    const rows = elementsNamed(
      column([memberOf(BRIEFER), memberOf(FUTURE_HIRE)]),
      surface.AiEmployeeRow,
    );
    assert.deepEqual(
      rows.map((r) => (r.props.e as StaffMember).id),
      [BRIEFER.id, FUTURE_HIRE.id],
    );
  });

  test('the copilot keeps its own row, above the named staff', () => {
    const tree = column([memberOf(BRIEFER)]);
    const all = elementsOf(tree);
    const copilotAt = all.findIndex((el) => (el.type as { name?: string })?.name === 'CopilotRow');
    const firstStaffAt = all.findIndex((el) => el.type === surface.AiEmployeeRow);
    assert.ok(copilotAt >= 0, 'the copilot row disappeared from the column');
    assert.ok(copilotAt < firstStaffAt, 'the copilot should still lead the column');
  });

  test('an unread roster leaves the column exactly as it was', () => {
    // A failed read hands down an empty list. That must draw the copilot and
    // the robots, never an empty-roster claim.
    const rows = elementsNamed(column([]), surface.AiEmployeeRow);
    assert.equal(rows.length, 0);
    const all = elementsOf(column([]));
    assert.ok(all.some((el) => (el.type as { name?: string })?.name === 'CopilotRow'));
  });
});

// ─── 2. the header count ────────────────────────────────────────────────────

describe('the number in the AI STAFF header', () => {
  function headerCount(employees: StaffMember[], robots: unknown[] = []): number {
    const section = elementsOf(column(employees, robots))[0];
    return section.props.count as number;
  }

  test('counts the copilot, the named staff and the robots', () => {
    assert.equal(headerCount([]), 1);
    assert.equal(headerCount([memberOf(BRIEFER)]), 2);
    assert.equal(headerCount([memberOf(BRIEFER), memberOf(FUTURE_HIRE)]), 3);
    assert.equal(headerCount([memberOf(BRIEFER)], [ROBOT, ROBOT]), 4);
  });

  test('the count matches the rows the column actually drew', () => {
    // The count and the list are two statements about the same thing, and a
    // count that outran its rows is how "one AI staff member" survived a
    // second hire in the first place.
    for (const staff of [[], [memberOf(BRIEFER)], [memberOf(BRIEFER), memberOf(FUTURE_HIRE)]]) {
      const tree = column(staff);
      const drawn = 1 /* copilot */ + elementsNamed(tree, surface.AiEmployeeRow).length;
      assert.equal(elementsOf(tree)[0].props.count, drawn);
    }
  });

  test('a switched-off employee is still on the payroll', () => {
    // Everything else in this column counts by existing, not by being
    // healthy: a stopped robot is counted, and so is an employee the founder
    // switched off. Their row is where the bad news goes.
    assert.equal(headerCount([memberOf(BRIEFER, { status: 'switched_off' })]), 2);
  });
});

// ─── 3. what a row says about how it is doing ───────────────────────────────

describe('the status on an employee row', () => {
  function textFor(over: Partial<StaffMember>, l: 'en' | 'es' = 'en'): string[] {
    return stringsOf(surface.AiEmployeeRow({ e: memberOf(BRIEFER, over), l }));
  }

  test('built, switched on, and its overnight check unscheduled — it says so', () => {
    const text = textFor({ status: 'waiting_for_master' });
    assert.ok(text.includes(EMPLOYEE_STATUS_LABEL.waiting_for_master.en));
    assert.ok(!text.includes(EMPLOYEE_STATUS_LABEL.on.en), 'a waiting employee must never read as On');
  });

  test('switched off by the founder — it says that, and not "ready"', () => {
    const text = textFor({ status: 'switched_off' });
    assert.ok(text.includes(EMPLOYEE_STATUS_LABEL.switched_off.en));
    assert.ok(!text.includes(EMPLOYEE_STATUS_LABEL.waiting_for_master.en));
  });

  test('the sentence is the registry\'s, in the reader\'s language', () => {
    const es = textFor({ status: 'waiting_for_master' }, 'es');
    assert.ok(es.includes(EMPLOYEE_STATUS_LABEL.waiting_for_master.es));
    assert.ok(es.includes(BRIEFER.name.es));
    assert.ok(es.includes(BRIEFER.job.es));
    assert.ok(!es.includes(BRIEFER.job.en), 'a Spanish reader should not be handed the English job');
  });

  test('the row is a way through to the page with the controls on it', () => {
    const href = elementsOf(surface.AiEmployeeRow({ e: memberOf(BRIEFER), l: 'en' }))
      .map((el) => el.props.href)
      .find((h) => typeof h === 'string');
    assert.equal(href, '/admin/ai-staff');
  });
});

// ─── 4. no number the ledger cannot back ────────────────────────────────────

describe('what an employee row says it cost', () => {
  function textFor(spend: StaffMember['spend']): string[] {
    return stringsOf(surface.AiEmployeeRow({ e: memberOf(BRIEFER, { spend }), l: 'en' }));
  }

  test('a figure the ledger separates out is shown, to the cent', () => {
    assert.ok(textFor({ known: true, usd: 1.23, todayUsd: 0.31 }).includes('$0.31'));
  });

  test('spend nothing tracks shows NO number — not zero', () => {
    // $0.00 is a claim: it says the day is accounted for. The honest render
    // of "no separate bill for this one" is silence, with the AI Staff page a
    // click away to say why.
    for (const spend of [
      { known: false, usd: null, todayUsd: null },
      null,
      undefined,
      { known: true, usd: 4.5, todayUsd: null },
    ] as StaffMember['spend'][]) {
      const text = textFor(spend);
      assert.ok(
        !text.some((t) => t.includes('$')),
        `an underivable spend printed a figure: ${JSON.stringify(text)}`,
      );
    }
  });

  test('a real zero is still a real answer', () => {
    // Nothing spent today, on a ledger that would have caught it. That IS
    // knowable, and hiding it would be its own small dishonesty.
    assert.ok(textFor({ known: true, usd: 2.2, todayUsd: 0 }).includes('$0.00'));
  });
});

// ─── 5. where today's figure comes from ─────────────────────────────────────

describe('splitting the spend ledger into today and the month', () => {
  const DAY_START = Date.parse('2026-07-26T00:00:00.000Z');
  const row = (over: Partial<SpendRow>): SpendRow => ({
    feature: 'findings.brief',
    cost_usd: 1,
    created_at: '2026-07-26T09:00:00.000Z',
    ...over,
  });

  test('a row from earlier today counts in both windows', () => {
    const t = foldSpendRows([row({ cost_usd: 0.25 })], DAY_START);
    assert.equal(t.window.get('findings.brief'), 0.25);
    assert.equal(t.today.get('findings.brief'), 0.25);
  });

  test('a row from last week counts in the month and NOT in today', () => {
    const t = foldSpendRows([row({ created_at: '2026-07-19T09:00:00.000Z', cost_usd: 3 })], DAY_START);
    assert.equal(t.window.get('findings.brief'), 3);
    assert.equal(t.today.has('findings.brief'), false);
  });

  test('one unparseable cost does not take the whole figure down with it', () => {
    // Carried forward, a NaN poisons every sum it touches — the founder gets
    // "$NaN today" for a feature that spent a real, knowable amount.
    const t = foldSpendRows(
      [row({ cost_usd: 'not-a-number' }), row({ cost_usd: '0.50' })],
      DAY_START,
    );
    assert.equal(t.today.get('findings.brief'), 0.5);
    assert.equal(t.window.get('findings.brief'), 0.5);
  });

  test('features are kept apart', () => {
    const t = foldSpendRows(
      [row({ feature: 'findings.brief', cost_usd: 1 }), row({ feature: 'findings.judge', cost_usd: 2 })],
      DAY_START,
    );
    assert.equal(t.today.get('findings.brief'), 1);
    assert.equal(t.today.get('findings.judge'), 2);
  });

  // ── a retired feature's money is still the hotel's money ──────────────────
  //
  // 2026-07-27: `communications.unread_summary` left the AI feature registry
  // with the "Catch up" screen that was its only caller. What it already spent
  // is real money that was really spent, and it stays on the books —
  // `agent_costs.feature` is a length-bounded text column (0374) and
  // deliberately NOT an enum, precisely so that retiring a feature never
  // rewrites history and never needs a migration to do it.
  //
  // For that to hold, the fold has to stay registry-BLIND. The danger is the
  // obvious-looking "improvement": resolving each row's key through
  // `getAiFeatureDefinition()` to pretty-print it. That helper returns
  // `undefined` for an unknown key while its type promises otherwise, so the
  // next property access throws — and it would take down the whole spend
  // figure, every employee's bill, not just the dead feature's.
  test("a de-registered feature's history still totals, and is kept apart from a live one", () => {
    const retired = 'communications.unread_summary';
    assert.ok(
      !(AI_FEATURE_KEYS as readonly string[]).includes(retired),
      'this check only means something while the key is genuinely out of the registry',
    );

    const totals = foldSpendRows(
      [
        row({ feature: retired, cost_usd: 0.4 }),
        row({ feature: retired, cost_usd: 0.1, created_at: '2026-07-19T09:00:00.000Z' }),
        row({ feature: 'findings.brief', cost_usd: 2 }),
      ],
      DAY_START,
    );

    // Nothing vanished, nothing went NaN, and the month/today split still holds
    // for a key no registry can explain.
    assert.equal(totals.window.get(retired), 0.5);
    assert.equal(totals.today.get(retired), 0.4);
    // And the retired key's money did not leak into a living feature's figure.
    assert.equal(totals.window.get('findings.brief'), 2);
  });

  test('no hired employee still claims the retired feature', () => {
    // The one place a removed key CAN crash: `billedBundleKeys()` runs every
    // hired employee's bundle through `billsPerCall`, which does reach into the
    // registry. A bundle left pointing at a deleted key throws here, and this
    // list is what the AI Staff route asks the ledger for — so the failure
    // would be a blank money column, not a loud error.
    const keys = billedBundleKeys();
    assert.ok(!keys.includes('communications.unread_summary'));
    for (const key of keys) {
      assert.ok(
        (AI_FEATURE_KEYS as readonly string[]).includes(key),
        `${key} is billed for but no longer in the registry`,
      );
    }
  });
});

// ─── 6. the roster this column is drawn from ────────────────────────────────

describe('the registry the column reads', () => {
  test('carries hired employees, so the column has somebody to draw', () => {
    // A vacuous suite is the failure mode here: every check above would pass
    // against an empty roster.
    assert.ok(hiredAiEmployees().length >= 1);
    assert.ok(AI_EMPLOYEES.length > hiredAiEmployees().length, 'the plan should outnumber the hires');
  });
});
