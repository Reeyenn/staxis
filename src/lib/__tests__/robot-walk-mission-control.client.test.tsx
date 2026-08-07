/**
 * DOES A BROKEN NIGHT REACH THE ONE PLACE THE FOUNDER LOOKS?
 *
 * The nightly robot's whole value is that it fails when the app fails. That
 * value is entirely conditional on the failure being rendered in Mission
 * Control's "Recent errors" box, and there was a live trap sitting directly in
 * that path when this was written.
 *
 * THE TRAP. The box drops any error group whose source reads like a robot:
 *
 *   /(^|[-_.\s])(cua|mapper|robot|session[-_ ]?driver)([-_.\s]|$)/
 *
 * It was added to hide the DECOMMISSIONED PMS robot's leftover noise, and it
 * matches "robot-walk" on the first character. Without the exemption this file
 * pins, every failure the nightly walk ever reports would have been written to
 * the database, grouped correctly by the endpoint, handed to the surface, and
 * then silently thrown away by the box it was written for. Nothing would have
 * looked wrong anywhere.
 *
 * So there are two assertions that matter here and they pull in opposite
 * directions: the walk's failures must survive the filter, and the retired
 * robot's noise must still be dropped. Widening the exemption to fix one at the
 * cost of the other is the regression.
 *
 * HOW IT RUNS. `npm test` runs under `--conditions=react-server`, where
 * react-dom/server will not load. The house pattern is to call the component as
 * a plain function and walk the element tree it returns. ErrorRow holds one
 * `useState` for its expander, so the same live-module shim the AI-staff roster
 * test uses for `createContext` is extended to `useState` here. Nothing mounts;
 * the tree is read.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

import {
  robotWalkFailureDetail,
  robotWalkFailureMessage,
  ROBOT_WALK_ERROR_SOURCE,
} from '@/lib/automation/robot-walk';

const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type SurfaceModule = typeof import('@/app/admin/_components/studio/surfaces/MissionControlSurface');
type ErrorGroup = Parameters<SurfaceModule['ErrorRow']>[0]['g'];

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
  // The collapsed state of an error row. Reading a collapsed row is exactly
  // what the founder does at a glance, so the stub returns the initial value
  // and a setter nothing calls.
  react.useState = (initial: unknown) => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    () => {},
  ];
  R = react as unknown as typeof import('react');
  surface = await import('@/app/admin/_components/studio/surfaces/MissionControlSurface');
});

// ─── Tree walking ───────────────────────────────────────────────────────────

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

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

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * What /api/admin/recent-errors hands the surface for one failing step, built
 * from the SAME producers the report route writes with. A rename of the step
 * label travels into this check instead of leaving it passing against a string
 * nothing produces any more.
 */
function walkFailureGroup(over: Partial<ErrorGroup> = {}): ErrorGroup {
  const step = { name: 'add-todo', ok: false, ms: 900, error: 'the composer never cleared' };
  return {
    source: ROBOT_WALK_ERROR_SOURCE,
    message: robotWalkFailureMessage(step),
    count: 3,
    firstSeen: '2026-08-04T10:00:00.000Z',
    lastSeen: '2026-08-06T10:00:00.000Z',
    affectedPropertyIds: [],
    sampleStack: robotWalkFailureDetail(step),
    ...over,
  };
}

function group(source: string | null, message = 'something happened'): ErrorGroup {
  return {
    source,
    message,
    count: 1,
    firstSeen: '2026-08-06T09:00:00.000Z',
    lastSeen: '2026-08-06T09:00:00.000Z',
    affectedPropertyIds: [],
    sampleStack: null,
  };
}

// ─── 1. The filter ──────────────────────────────────────────────────────────

describe('what the Recent errors box is allowed to hide', () => {
  test('a nightly walk failure is shown', () => {
    const shown = surface.visibleErrorGroups([walkFailureGroup()]);
    assert.equal(shown.length, 1, 'the walk failure was filtered out of the only box that shows it');
  });

  test('the retired PMS robot is still hidden', () => {
    // The exemption must not be a hole. These are the sources the filter was
    // written for, and they stay gone.
    const retired = ['cua', 'cua-mapper', 'mapper', 'session-driver', 'session_driver', 'generic-table-writer'];
    const shown = surface.visibleErrorGroups(retired.map((s) => group(s)));
    assert.deepEqual(shown, [], `retired robot noise came back: ${JSON.stringify(shown.map((g) => g.source))}`);
  });

  test('ordinary application errors are untouched', () => {
    const ordinary = [group('api'), group('agent'), group('inventory'), group(null)];
    assert.equal(surface.visibleErrorGroups(ordinary).length, ordinary.length);
  });

  test('the walk survives alongside the noise it looks like', () => {
    const shown = surface.visibleErrorGroups([group('cua-mapper'), walkFailureGroup(), group('cua')]);
    assert.deepEqual(shown.map((g) => g.source), [ROBOT_WALK_ERROR_SOURCE]);
  });
});

// ─── 2. The row itself ──────────────────────────────────────────────────────

describe('what a failing night looks like on the screen', () => {
  test('the row says which step broke, in words', () => {
    const text = stringsOf(surface.ErrorRow({ g: walkFailureGroup() }));
    assert.ok(
      text.some((t) => t.includes('add a to-do')),
      `the failing step is not on the row: ${JSON.stringify(text)}`,
    );
  });

  test('the row says it was the robot, so nobody hunts for a hotel', () => {
    const text = stringsOf(surface.ErrorRow({ g: walkFailureGroup() }));
    assert.ok(text.includes(ROBOT_WALK_ERROR_SOURCE));
  });

  test('a step broken for three nights is one row that says 3x', () => {
    // The whole reason the message carries no timestamp. Three rows of the
    // same sentence is how a persistent failure becomes wallpaper.
    const text = stringsOf(surface.ErrorRow({ g: walkFailureGroup({ count: 3 }) }));
    assert.ok(text.some((t) => t.includes('3')));
  });

  test('a long sentence is not truncated into uselessness', () => {
    // The box shortens a message past 96 characters. Every step sentence the
    // walk can produce has to survive that with the step name intact.
    const text = stringsOf(surface.ErrorRow({ g: walkFailureGroup() })).join(' ');
    assert.doesNotMatch(text, /Nightly robot walkthrough could not …/);
  });
});
