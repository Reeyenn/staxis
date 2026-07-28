/**
 * The AI Staff roster, and the standing check that it cannot rot.
 *
 * WHY THIS TEST EXISTS
 * An "AI employee" is a name over ids that live somewhere else — a feature key
 * in the AI Control Center's registry, a detector id in the findings registry, a
 * scheduled job that is a directory on disk. None of those are hard to rename,
 * and every one of them, renamed alone, leaves a card on the founder's page
 * describing work that nothing does. That failure is silent by construction: the
 * page still renders, the switch still flips, the status still says something.
 *
 * So the walk below is the point of the file. Every id any employee bundles is
 * traced back to the registry that owns it, and a rename that orphans an
 * employee fails here rather than on a screen.
 *
 * The second half drives `assertEmployeeRosterShape` with deliberately broken
 * rosters, because a validator nobody has ever seen reject anything is a
 * validator nobody knows the behaviour of.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_EMPLOYEES,
  AiEmployeeRegistryError,
  BUNDLE_LABELS,
  assertEmployeeRosterShape,
  deriveEmployeeStatus,
  getAiEmployee,
  hiredAiEmployees,
  type AiEmployee,
} from '@/lib/ai/employee-registry';
import { MORNING_BRIEFER_ID, NAMED_EMPLOYEE_IDS } from '@/lib/ai/employee-ids';
import { AI_FEATURE_REGISTRY } from '@/lib/ai/feature-registry';
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';
import { allDetectors } from '@/lib/findings/registry';
import '@/lib/findings/detectors';

const CRON_ROOT = join(process.cwd(), 'src', 'app', 'api', 'cron');

function hired(): AiEmployee[] {
  return hiredAiEmployees();
}

/** A minimal valid entry the broken-roster cases mutate one field at a time. */
function fixture(over: Partial<AiEmployee> = {}): AiEmployee {
  return {
    id: 'test_employee',
    name: { en: 'Test Employee', es: 'Empleado de prueba' },
    job: { en: 'Does a thing.', es: 'Hace una cosa.' },
    hired: true,
    bundle: {
      features: ['findings.brief'],
      detectors: [],
      crons: ['run-findings'],
      surfaces: [{ en: 'Somewhere', es: 'En algún sitio' }],
    },
    ...over,
  };
}

describe('AI employee roster — integrity', () => {
  test('the roster is not empty and names exactly the employees that exist', () => {
    assert.ok(AI_EMPLOYEES.length >= 13, 'the org chart should carry the whole plan');
    const names = hired().map((e) => e.id);
    // Pinned by name rather than counted. The page's whole claim is that a
    // card means real work is happening, so hiring someone has to be a
    // deliberate edit here — a length check would let a half-built employee
    // reach the founder's page by accident.
    assert.deepEqual(names, ['ordering_manager', MORNING_BRIEFER_ID]);
  });

  test('an employee with no billed feature says so instead of showing $0.00', () => {
    // The Ordering Manager's only model work happens inside a chat turn and is
    // billed to the chat's own feature. Bundling a key here that never
    // receives an agent_costs row would render a confident zero next to work
    // that does cost money — so the empty bundle is the assertion, not an
    // omission waiting to be filled in.
    const ordering = getAiEmployee('ordering_manager');
    assert.ok(ordering, 'the Ordering Manager should be on the roster');
    assert.equal(ordering!.hired, true);
    assert.deepEqual(
      ordering!.bundle.features,
      [],
      'adding a feature key here makes the AI Staff card claim a bill; only do it '
      + 'when a model call actually writes agent_costs under that key.',
    );
    assert.ok(
      ordering!.bundle.surfaces.length > 0,
      'a hired employee must name where its work shows up',
    );
  });

  test('every id code refers to by name is declared, hired, and spelled the same', () => {
    for (const id of NAMED_EMPLOYEE_IDS) {
      const e = getAiEmployee(id);
      assert.ok(
        e,
        `Code asks the kill switch about "${id}", which the roster no longer declares. ` +
        'The switch row in ai_employee_switches (0373) is keyed on this exact string.',
      );
      assert.equal(e!.hired, true, `"${id}" is referenced by code but marked not hired`);
    }
  });

  test('every bundled AI feature key exists in the AI feature registry', () => {
    for (const e of hired()) {
      for (const key of e.bundle.features) {
        assert.ok(
          key in AI_FEATURE_REGISTRY,
          `AI employee "${e.id}" bundles feature "${key}", which no longer exists. ` +
          'Renaming a feature key orphans the employee that claims it.',
        );
      }
    }
  });

  test('every bundled detector id exists in the detector registry', () => {
    const known = new Set(allDetectors().map((d) => d.declaration.id));
    // Proof the lookup set is real, so the assertion below is not vacuous
    // simply because the detector modules failed to import.
    assert.ok(known.size >= 5, 'the detector registry did not load');
    for (const e of hired()) {
      for (const id of e.bundle.detectors) {
        assert.ok(
          known.has(id),
          `AI employee "${e.id}" bundles detector "${id}", which is not registered.`,
        );
      }
    }
  });

  test('every bundled scheduled job has a route on disk', () => {
    for (const e of hired()) {
      for (const name of e.bundle.crons) {
        assert.ok(
          existsSync(join(CRON_ROOT, name, 'route.ts')),
          `AI employee "${e.id}" depends on scheduled job "${name}", which has no route at ` +
          `src/app/api/cron/${name}/route.ts.`,
        );
      }
    }
  });

  test('every bundled id has a readable line in both languages', () => {
    for (const e of hired()) {
      for (const key of [...e.bundle.features, ...e.bundle.detectors, ...e.bundle.crons]) {
        const label = BUNDLE_LABELS[key];
        assert.ok(label, `"${key}" (employee "${e.id}") has no BUNDLE_LABELS line`);
        assert.ok(label.en.trim().length > 0, `"${key}" has no English line`);
        assert.ok(label.es.trim().length > 0, `"${key}" has no Spanish line`);
        assert.notEqual(
          label.en.trim(), label.es.trim(),
          `"${key}" ships the same string as English and Spanish — that is a missing translation`,
        );
      }
    }
  });

  test('every roster entry is bilingual, hired or not', () => {
    for (const e of AI_EMPLOYEES) {
      assert.ok(e.name.en.trim() && e.name.es.trim(), `${e.id} name`);
      assert.ok(e.job.en.trim() && e.job.es.trim(), `${e.id} job`);
      // A job description is a whole sentence. The same string in both columns
      // is the shape "English got shipped into the Spanish slot" takes.
      assert.notEqual(e.job.en.trim(), e.job.es.trim(), `${e.id}: EN and ES job are the same string`);
    }
  });

  test('nobody on the plan carries a bundle — a dimmed card has nothing to show', () => {
    for (const e of AI_EMPLOYEES.filter((x) => !x.hired)) {
      assert.equal(e.bundle.features.length, 0, `${e.id} features`);
      assert.equal(e.bundle.detectors.length, 0, `${e.id} detectors`);
      assert.equal(e.bundle.crons.length, 0, `${e.id} crons`);
      assert.equal(e.bundle.surfaces.length, 0, `${e.id} surfaces`);
    }
  });
});

describe('AI employee roster — the validator actually rejects things', () => {
  const cases: Array<{ why: string; roster: AiEmployee[] }> = [
    {
      why: 'a feature key that is not in the AI feature registry',
      roster: [fixture({ bundle: { ...fixture().bundle, features: ['findings.nonexistent' as never] } })],
    },
    {
      why: 'two employees sharing one id (they would share one kill switch)',
      roster: [fixture(), fixture()],
    },
    {
      why: 'an id that is not lower_snake_case (the switch primary key would reject it)',
      roster: [fixture({ id: 'Morning Briefer' })],
    },
    {
      why: 'a missing Spanish name on a bilingual product',
      roster: [fixture({ name: { en: 'X', es: '  ' } })],
    },
    {
      why: 'a missing Spanish job description',
      roster: [fixture({ job: { en: 'Does a thing.', es: '' } })],
    },
    {
      why: 'an unhired employee carrying a bundle (its card would grow controls)',
      roster: [fixture({ hired: false })],
    },
    {
      why: 'a hired employee that writes nowhere',
      roster: [fixture({ bundle: { ...fixture().bundle, surfaces: [] } })],
    },
    {
      why: 'a bundled id with no readable line — the card would print the raw id',
      roster: [fixture({ bundle: { ...fixture().bundle, crons: ['some_unlabelled_job'] } })],
    },
  ];

  for (const c of cases) {
    test(`rejects ${c.why}`, () => {
      assert.throws(
        () => assertEmployeeRosterShape(c.roster),
        AiEmployeeRegistryError,
        `the validator accepted ${c.why}`,
      );
    });
  }

  test('accepts the shape it is meant to accept', () => {
    assert.doesNotThrow(() => assertEmployeeRosterShape([fixture()]));
  });
});

describe('AI employee status — derived, never stored', () => {
  const employee = fixture();
  const withCrons = (...names: string[]) => new Set(names);

  test('not hired outranks everything — a plan has no status', () => {
    const planned = fixture({ hired: false, bundle: { features: [], detectors: [], crons: [], surfaces: [] } });
    assert.equal(
      deriveEmployeeStatus({ employee: planned, switchedOff: true, scheduledCrons: withCrons('run-findings') }),
      'not_hired',
    );
  });

  test('the founder switching it off outranks the schedule', () => {
    assert.equal(
      deriveEmployeeStatus({ employee, switchedOff: true, scheduledCrons: withCrons('run-findings') }),
      'switched_off',
    );
    assert.equal(
      deriveEmployeeStatus({ employee, switchedOff: true, scheduledCrons: withCrons() }),
      'switched_off',
    );
  });

  test('a job it needs that is not scheduled means waiting, not on', () => {
    assert.equal(
      deriveEmployeeStatus({ employee, switchedOff: false, scheduledCrons: withCrons() }),
      'waiting_for_master',
    );
  });

  test('on only when nothing it needs is missing', () => {
    assert.equal(
      deriveEmployeeStatus({ employee, switchedOff: false, scheduledCrons: withCrons('run-findings') }),
      'on',
    );
  });

  // The honesty check for what the page shows TODAY. The nightly check is not
  // scheduled (the founder's master switch is off), so the Morning Briefer must
  // read "ready — waiting", never "on". If someone schedules run-findings, this
  // test flips to the other branch — which is exactly the moment somebody should
  // be looking at what this page claims.
  test('today the Morning Briefer is honest about the master switch being off', () => {
    const scheduled = new Set(SCHEDULE_REGISTRY.map((e) => e.heartbeatName));
    const briefer = getAiEmployee(MORNING_BRIEFER_ID)!;
    const status = deriveEmployeeStatus({ employee: briefer, switchedOff: false, scheduledCrons: scheduled });
    if (scheduled.has('run-findings')) {
      assert.equal(status, 'on', 'run-findings is scheduled now, so "on" is the honest answer');
    } else {
      assert.equal(
        status, 'waiting_for_master',
        'The nightly check is not scheduled, so the card must not claim the Morning Briefer is on.',
      );
    }
  });
});
