/**
 * Unit tests for the housekeeper workflow state machine.
 *
 * Every transition rule has at least one happy-path and one illegal-input
 * test. Pause / Resume math is exercised with a synthetic clock so the
 * elapsed-seconds arithmetic is testable without timer flakiness.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  transition,
  activeDurationMinutes,
  floorFromRoomNumber,
  inferCleaningType,
  type RoomWorkflowState,
} from '../housekeeper-workflow/state-machine';

const ISO = (ms: number) => new Date(ms).toISOString();

function freshState(overrides: Partial<RoomWorkflowState> = {}): RoomWorkflowState {
  return {
    status: 'dirty',
    isPaused: false,
    exceptionType: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    totalPausedSeconds: 0,
    ...overrides,
  };
}

describe('transition: start', () => {
  test('moves dirty → in_progress and records startedAt', () => {
    const at = '2026-05-24T10:00:00.000Z';
    const out = transition(freshState(), 'start', at);
    assert.equal(out.ok, true);
    assert.equal(out.next?.status, 'in_progress');
    assert.equal(out.next?.startedAt, at);
    assert.equal(out.next?.isPaused, false);
    assert.equal(out.next?.totalPausedSeconds, 0);
  });

  test('rejects start from in_progress', () => {
    const out = transition(freshState({ status: 'in_progress' }), 'start', ISO(0));
    assert.equal(out.ok, false);
    assert.match(out.reason ?? '', /cannot start/);
  });

  test('rejects start with active exception', () => {
    const out = transition(
      freshState({ status: 'dirty', exceptionType: 'dnd' }),
      'start',
      ISO(0),
    );
    assert.equal(out.ok, false);
    assert.match(out.reason ?? '', /exception/);
  });
});

describe('transition: pause', () => {
  test('moves in_progress → paused', () => {
    const at = '2026-05-24T10:30:00.000Z';
    const out = transition(
      freshState({ status: 'in_progress', startedAt: '2026-05-24T10:00:00.000Z' }),
      'pause',
      at,
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.isPaused, true);
    assert.equal(out.next?.pausedAt, at);
  });

  test('rejects double pause', () => {
    const out = transition(
      freshState({ status: 'in_progress', isPaused: true, pausedAt: ISO(0) }),
      'pause',
      ISO(10_000),
    );
    assert.equal(out.ok, false);
    assert.match(out.reason ?? '', /already paused/);
  });

  test('rejects pause from dirty', () => {
    const out = transition(freshState(), 'pause', ISO(0));
    assert.equal(out.ok, false);
  });
});

describe('transition: resume', () => {
  test('accumulates elapsed pause time into totalPausedSeconds', () => {
    const pausedAt = '2026-05-24T10:30:00.000Z';
    const resumedAt = '2026-05-24T10:35:00.000Z'; // 5 minutes
    const out = transition(
      freshState({
        status: 'in_progress',
        isPaused: true,
        pausedAt,
        startedAt: '2026-05-24T10:00:00.000Z',
        totalPausedSeconds: 60,
      }),
      'resume',
      resumedAt,
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.isPaused, false);
    assert.equal(out.next?.pausedAt, null);
    // 60s prior + 300s of pause = 360s.
    assert.equal(out.next?.totalPausedSeconds, 360);
  });

  test('rejects resume when not paused', () => {
    const out = transition(
      freshState({ status: 'in_progress' }),
      'resume',
      ISO(0),
    );
    assert.equal(out.ok, false);
    assert.match(out.reason ?? '', /not paused/);
  });
});

describe('transition: complete', () => {
  test('moves in_progress → clean and records completedAt', () => {
    const completedAt = '2026-05-24T10:45:00.000Z';
    const out = transition(
      freshState({ status: 'in_progress', startedAt: '2026-05-24T10:00:00.000Z' }),
      'complete',
      completedAt,
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.status, 'clean');
    assert.equal(out.next?.completedAt, completedAt);
  });

  test('paused → complete folds elapsed pause into totalPausedSeconds', () => {
    const pausedAt = '2026-05-24T10:30:00.000Z';
    const completedAt = '2026-05-24T10:40:00.000Z'; // 10 minutes paused
    const out = transition(
      freshState({
        status: 'in_progress',
        isPaused: true,
        pausedAt,
        startedAt: '2026-05-24T10:00:00.000Z',
        totalPausedSeconds: 0,
      }),
      'complete',
      completedAt,
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.totalPausedSeconds, 600);
    assert.equal(out.next?.isPaused, false);
  });

  test('rejects complete from dirty', () => {
    const out = transition(freshState(), 'complete', ISO(0));
    assert.equal(out.ok, false);
  });
});

describe('transition: exception', () => {
  test('flags exception and resets workflow state', () => {
    const out = transition(
      freshState({
        status: 'in_progress',
        startedAt: '2026-05-24T10:00:00.000Z',
        isPaused: true,
        totalPausedSeconds: 120,
      }),
      'exception',
      ISO(0),
      'nsr',
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.exceptionType, 'nsr');
    assert.equal(out.next?.status, 'dirty');
    assert.equal(out.next?.startedAt, null);
    assert.equal(out.next?.totalPausedSeconds, 0);
    assert.equal(out.next?.isPaused, false);
  });

  test('rejects exception without type', () => {
    const out = transition(freshState(), 'exception', ISO(0));
    assert.equal(out.ok, false);
  });

  test('rejects exception on a completed room', () => {
    const out = transition(
      freshState({ status: 'clean', completedAt: ISO(0) }),
      'exception',
      ISO(0),
      'dnd',
    );
    assert.equal(out.ok, false);
  });
});

describe('transition: clear_exception', () => {
  test('clears existing exception', () => {
    const out = transition(
      freshState({ exceptionType: 'dla' }),
      'clear_exception',
      ISO(0),
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.exceptionType, null);
  });

  test('rejects when no exception is set', () => {
    const out = transition(freshState(), 'clear_exception', ISO(0));
    assert.equal(out.ok, false);
  });
});

describe('transition: reset', () => {
  test('clears everything regardless of state', () => {
    const out = transition(
      freshState({
        status: 'clean',
        completedAt: ISO(0),
        startedAt: ISO(-60_000),
        totalPausedSeconds: 120,
      }),
      'reset',
      ISO(1000),
    );
    assert.equal(out.ok, true);
    assert.equal(out.next?.status, 'dirty');
    assert.equal(out.next?.completedAt, null);
    assert.equal(out.next?.startedAt, null);
    assert.equal(out.next?.totalPausedSeconds, 0);
    assert.equal(out.next?.exceptionType, null);
  });

  test('refuses noop reset of a dirty room with no exception', () => {
    const out = transition(freshState(), 'reset', ISO(0));
    assert.equal(out.ok, false);
  });
});

describe('activeDurationMinutes', () => {
  test('subtracts paused seconds from raw elapsed', () => {
    const start = '2026-05-24T10:00:00.000Z';
    const end = '2026-05-24T11:00:00.000Z'; // 60 min raw
    assert.equal(activeDurationMinutes(start, end, 600), 50);
  });

  test('zero on missing inputs', () => {
    assert.equal(activeDurationMinutes(null, null, 0), 0);
    assert.equal(activeDurationMinutes('2026-05-24T10:00:00.000Z', null, 0), 0);
    assert.equal(activeDurationMinutes('not-iso', '2026-05-24T11:00:00.000Z', 0), 0);
  });

  test('clamps to zero when paused exceeds elapsed', () => {
    const start = '2026-05-24T10:00:00.000Z';
    const end = '2026-05-24T10:05:00.000Z'; // 5 min
    assert.equal(activeDurationMinutes(start, end, 3600), 0);
  });
});

describe('floorFromRoomNumber', () => {
  test('three-digit rooms', () => {
    assert.equal(floorFromRoomNumber('101'), '1');
    assert.equal(floorFromRoomNumber('215'), '2');
    assert.equal(floorFromRoomNumber('349'), '3');
  });
  test('four-digit rooms', () => {
    assert.equal(floorFromRoomNumber('1207'), '12');
  });
  test('two-digit rooms', () => {
    assert.equal(floorFromRoomNumber('99'), '99');
  });
  test('non-numeric labels stay as-is', () => {
    assert.equal(floorFromRoomNumber('PH'), 'PH');
    assert.equal(floorFromRoomNumber('Suite A'), 'Suite A');
  });
});

describe('inferCleaningType', () => {
  test('canonical mappings', () => {
    assert.equal(inferCleaningType('checkout'), 'departure');
    assert.equal(inferCleaningType('stayover'), 'stayover');
    assert.equal(inferCleaningType('vacant'), 'refresh');
  });

  test('falls back to departure for unknowns', () => {
    assert.equal(inferCleaningType(null), 'departure');
    assert.equal(inferCleaningType('mystery'), 'departure');
  });
});
