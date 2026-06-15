/**
 * Department-scope checker invariants + comms channel-visibility parity.
 *
 * canReachDeptContent is the single source of truth: managers reach every
 * department; other staff reach only their own. comms channelsVisibleTo is
 * re-expressed on top of it, so we also assert the re-expression reproduces the
 * old "managers see all; staff see all_staff + their dept" behavior exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canReachDeptContent,
  isManagerRole,
  normalizeDept,
  type Dept,
} from '@/lib/capabilities/dept-scope';

const DEPTS: Dept[] = ['front_desk', 'housekeeping', 'maintenance'];
const ALL_CHANNELS = ['all_staff', ...DEPTS] as const;

describe('isManagerRole', () => {
  it('is true for admin/owner/general_manager only', () => {
    for (const r of ['admin', 'owner', 'general_manager']) assert.equal(isManagerRole(r), true);
    for (const r of ['front_desk', 'housekeeping', 'maintenance', 'staff', '', null, undefined]) {
      assert.equal(isManagerRole(r), false);
    }
  });
});

describe('normalizeDept', () => {
  it('maps the three real depts and nulls everything else', () => {
    assert.equal(normalizeDept('front_desk'), 'front_desk');
    assert.equal(normalizeDept('HOUSEKEEPING'), 'housekeeping');
    assert.equal(normalizeDept('maintenance'), 'maintenance');
    assert.equal(normalizeDept('other'), null);
    assert.equal(normalizeDept('all_staff'), null);
    assert.equal(normalizeDept(null), null);
  });
});

describe('canReachDeptContent', () => {
  it('managers reach every department', () => {
    for (const role of ['admin', 'owner', 'general_manager']) {
      for (const dept of DEPTS) {
        assert.equal(canReachDeptContent({ role, staffDept: 'other' }, dept), true);
      }
    }
  });
  it('non-managers reach only their own department', () => {
    for (const own of DEPTS) {
      for (const target of DEPTS) {
        assert.equal(
          canReachDeptContent({ role: 'front_desk', staffDept: own }, target),
          own === target,
          `staffDept=${own} target=${target}`,
        );
      }
    }
  });
  it('the isManager boolean shortcut behaves like a manager role', () => {
    assert.equal(canReachDeptContent({ isManager: true, staffDept: null }, 'maintenance'), true);
    assert.equal(canReachDeptContent({ isManager: false, staffDept: 'housekeeping' }, 'maintenance'), false);
  });
  it('a non-department target is unreachable for non-managers', () => {
    assert.equal(canReachDeptContent({ isManager: false, staffDept: 'housekeeping' }, 'all_staff'), false);
    assert.equal(canReachDeptContent({ isManager: false, staffDept: 'housekeeping' }, null), false);
  });
});

describe('comms channelsVisibleTo parity (re-expressed on canReachDeptContent)', () => {
  // The exact behavior comms/core.ts now produces.
  function viaDeptScope(dept: string | null, isManager: boolean): string[] {
    const out: string[] = ['all_staff'];
    for (const ch of DEPTS) if (canReachDeptContent({ isManager, staffDept: dept }, ch)) out.push(ch);
    return out;
  }
  // The original behavior we must preserve.
  function legacy(dept: string | null, isManager: boolean): string[] {
    if (isManager) return [...ALL_CHANNELS];
    const out: string[] = ['all_staff'];
    const dc = normalizeDept(dept);
    if (dc) out.push(dc);
    return out;
  }

  it('matches the legacy result for managers and every dept', () => {
    for (const dept of ['front_desk', 'housekeeping', 'maintenance', 'other', null]) {
      for (const isManager of [true, false]) {
        assert.deepEqual(viaDeptScope(dept, isManager), legacy(dept, isManager), `dept=${dept} mgr=${isManager}`);
      }
    }
  });
});
