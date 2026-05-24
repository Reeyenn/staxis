/**
 * Per-feature scoring tests for the auto-assignment engine.
 *
 * Locks each of the nine features independently. If you change a
 * weight or a curve in scoring.ts, you'll see exactly which feature
 * shifted — not a single composite that's gone "up by 0.07 for some
 * reason" with no localization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFloor,
  resolveDurationMinutes,
  isEligible,
  scorePriority,
  scoreUrgency,
  scoreFloorMatch,
  scoreLanguageMatch,
  scoreSkillMatch,
  scoreWorkloadBalance,
  scoreOvertime,
  scoreTraineePenalty,
  scoreRushBoost,
  scoreAssignment,
  buildReason,
  initHkState,
} from '@/lib/assignment-engine';

import { mkTask, mkHk, mkConfig, FIXED_NOW_MS } from './assignment-engine-fixtures';

describe('parseFloor', () => {
  it('strips non-digits and returns the leading digits', () => {
    assert.equal(parseFloor('201'), 2);
    assert.equal(parseFloor('305'), 3);
    assert.equal(parseFloor('1015'), 10);
    assert.equal(parseFloor('14B'), null); // single digit after stripping
    assert.equal(parseFloor('208A'), 2);
    assert.equal(parseFloor(''), null);
  });

  it('returns null on un-parseable input', () => {
    assert.equal(parseFloor('LOBBY'), null);
    assert.equal(parseFloor('9'), null);
  });
});

describe('resolveDurationMinutes', () => {
  it('prefers the task estimate when present', () => {
    const cfg = mkConfig();
    assert.equal(resolveDurationMinutes(mkTask({ estimated_minutes: 22 }), cfg), 22);
  });
  it('falls back to base duration by cleaning_type', () => {
    const cfg = mkConfig();
    assert.equal(resolveDurationMinutes(mkTask({ cleaning_type: 'departure' }), cfg), 30);
    assert.equal(resolveDurationMinutes(mkTask({ cleaning_type: 'stayover' }), cfg), 15);
    assert.equal(resolveDurationMinutes(mkTask({ cleaning_type: 'deep' }), cfg), 60);
  });
  it('uses a 20-minute sentinel for unknown cleaning_type', () => {
    const cfg = mkConfig();
    assert.equal(resolveDurationMinutes(mkTask({ cleaning_type: 'novel_type' }), cfg), 20);
  });
});

describe('isEligible', () => {
  it('rejects inactive HKs', () => {
    const r = isEligible(mkHk({ isActive: false }), mkTask());
    assert.equal(r.ok, false);
  });
  it('rejects HKs out today', () => {
    const r = isEligible(mkHk({ isOutToday: true }), mkTask());
    assert.equal(r.ok, false);
  });
  it('blocks trainees from inspection_only tasks', () => {
    const r = isEligible(mkHk({ isSenior: false }), mkTask({ cleaning_type: 'inspection_only' }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /senior/);
  });
  it('blocks trainees from supervisor_inspection extras', () => {
    const r = isEligible(
      mkHk({ isSenior: false }),
      mkTask({ extras: ['supervisor_inspection'] }),
    );
    assert.equal(r.ok, false);
  });
  it('lets seniors take inspection-only work', () => {
    const r = isEligible(mkHk({ isSenior: true }), mkTask({ cleaning_type: 'inspection_only' }));
    assert.equal(r.ok, true);
  });
});

describe('scorePriority', () => {
  it('ranks urgent > high > normal > low', () => {
    assert.equal(scorePriority(mkTask({ priority: 'urgent' })), 1);
    assert.ok(scorePriority(mkTask({ priority: 'high' })) > scorePriority(mkTask({ priority: 'normal' })));
    assert.ok(scorePriority(mkTask({ priority: 'normal' })) > scorePriority(mkTask({ priority: 'low' })));
    assert.equal(scorePriority(mkTask({ priority: 'low' })), 0);
  });
});

describe('scoreUrgency', () => {
  it('returns 0 when no due_by', () => {
    const cfg = mkConfig();
    assert.equal(scoreUrgency(mkTask({ due_by: null }), cfg), 0);
  });

  it('returns 1 for overdue or near-due tasks', () => {
    const cfg = mkConfig({ urgentWindowMinutes: 60 });
    // 30 min in the future at our FIXED_NOW.
    const dueSoon = new Date(FIXED_NOW_MS + 30 * 60_000).toISOString();
    assert.equal(scoreUrgency(mkTask({ due_by: dueSoon }), cfg), 1);
    // 1 hour overdue.
    const overdue = new Date(FIXED_NOW_MS - 60 * 60_000).toISOString();
    assert.equal(scoreUrgency(mkTask({ due_by: overdue }), cfg), 1);
  });

  it('decays to 0 at 4x the window', () => {
    const cfg = mkConfig({ urgentWindowMinutes: 60 });
    const farFuture = new Date(FIXED_NOW_MS + 240 * 60_000).toISOString();
    assert.equal(scoreUrgency(mkTask({ due_by: farFuture }), cfg), 0);
  });

  it('decays smoothly between window and 4x window', () => {
    const cfg = mkConfig({ urgentWindowMinutes: 60 });
    // 2x window — should be partial.
    const due = new Date(FIXED_NOW_MS + 120 * 60_000).toISOString();
    const s = scoreUrgency(mkTask({ due_by: due }), cfg);
    assert.ok(s > 0 && s < 1, `expected partial urgency, got ${s}`);
  });
});

describe('scoreFloorMatch', () => {
  it('returns 0 when HK has no current floor', () => {
    const state = initHkState(mkHk({ homeFloor: null }));
    assert.equal(scoreFloorMatch(mkTask({ room_number: '203' }), state), 0);
  });

  it('rewards same-floor matches', () => {
    const state = initHkState(mkHk({ homeFloor: 2 }));
    assert.equal(scoreFloorMatch(mkTask({ room_number: '205' }), state), 1);
  });

  it('lightly rewards adjacent floors', () => {
    const state = initHkState(mkHk({ homeFloor: 2 }));
    assert.equal(scoreFloorMatch(mkTask({ room_number: '101' }), state), 0.4);
    assert.equal(scoreFloorMatch(mkTask({ room_number: '302' }), state), 0.4);
  });

  it('penalizes 3+ floor jumps', () => {
    const state = initHkState(mkHk({ homeFloor: 1 }));
    assert.equal(scoreFloorMatch(mkTask({ room_number: '402' }), state), -0.2);
  });
});

describe('scoreLanguageMatch', () => {
  it('returns neutral when no guest language hint', () => {
    assert.equal(
      scoreLanguageMatch(mkTask({ guest_language: null }), mkHk({ language: 'en' })),
      0,
    );
  });

  it('rewards matched languages', () => {
    assert.equal(
      scoreLanguageMatch(mkTask({ guest_language: 'es' }), mkHk({ language: 'es' })),
      1,
    );
    assert.equal(
      scoreLanguageMatch(mkTask({ guest_language: 'en' }), mkHk({ language: 'en' })),
      1,
    );
  });

  it('lightly penalizes mismatches', () => {
    assert.equal(
      scoreLanguageMatch(mkTask({ guest_language: 'es' }), mkHk({ language: 'en' })),
      -0.2,
    );
  });
});

describe('scoreSkillMatch', () => {
  it('returns 0 for routine cleans regardless of seniority', () => {
    assert.equal(scoreSkillMatch(mkTask({ cleaning_type: 'departure' }), mkHk({ isSenior: true })), 0);
    assert.equal(scoreSkillMatch(mkTask({ cleaning_type: 'departure' }), mkHk({ isSenior: false })), 0);
  });

  it('rewards seniors on finicky work', () => {
    const t = mkTask({ requires_inspection: true });
    assert.ok(scoreSkillMatch(t, mkHk({ isSenior: true })) > 0);
    assert.ok(scoreSkillMatch(t, mkHk({ isSenior: false })) < 0);
  });

  it('treats deep cleans as finicky', () => {
    const t = mkTask({ cleaning_type: 'departure_deep' });
    assert.ok(scoreSkillMatch(t, mkHk({ isSenior: true })) > 0);
  });
});

describe('scoreWorkloadBalance', () => {
  it('returns 0 when this HK is tied for lightest', () => {
    const state = initHkState(mkHk());
    assert.equal(
      scoreWorkloadBalance(state, { minWorkloadMinutes: 0 }, mkConfig({ shiftMinutes: 420 })),
      0,
    );
  });

  it('returns 0 when this HK is the lightest (and others are heavier)', () => {
    const state = initHkState(mkHk());
    state.workloadMinutes = 30;
    assert.equal(
      scoreWorkloadBalance(state, { minWorkloadMinutes: 30 }, mkConfig({ shiftMinutes: 420 })),
      0,
    );
  });

  it('returns at least -0.3 for ANY positive gap (floor offset)', () => {
    const state = initHkState(mkHk());
    state.workloadMinutes = 5;
    const score = scoreWorkloadBalance(state, { minWorkloadMinutes: 0 }, mkConfig({ shiftMinutes: 420 }));
    assert.ok(score <= -0.3, `expected at least -0.3, got ${score}`);
  });

  it('drops smoothly as gap grows', () => {
    const cfg = mkConfig({ shiftMinutes: 400 });
    const state = initHkState(mkHk());
    state.workloadMinutes = 100;
    const at100 = scoreWorkloadBalance(state, { minWorkloadMinutes: 0 }, cfg);
    state.workloadMinutes = 300;
    const at300 = scoreWorkloadBalance(state, { minWorkloadMinutes: 0 }, cfg);
    assert.ok(at300 < at100, 'bigger gap = worse score');
  });

  it('caps at -1 when the gap is at or above shiftMinutes', () => {
    const state = initHkState(mkHk());
    state.workloadMinutes = 500;
    assert.equal(
      scoreWorkloadBalance(state, { minWorkloadMinutes: 0 }, mkConfig({ shiftMinutes: 420 })),
      -1,
    );
  });
});

describe('scoreOvertime', () => {
  it('returns 0 when HK has weekly room', () => {
    assert.equal(scoreOvertime(mkHk({ weeklyHours: 30, maxWeeklyHours: 40 })), 0);
  });
  it('returns -1 when HK is at or past cap', () => {
    assert.equal(scoreOvertime(mkHk({ weeklyHours: 40, maxWeeklyHours: 40 })), -1);
    assert.equal(scoreOvertime(mkHk({ weeklyHours: 45, maxWeeklyHours: 40 })), -1);
  });
});

describe('scoreTraineePenalty', () => {
  it('returns 0 for seniors regardless of task', () => {
    const t = mkTask({ priority: 'urgent', extras: ['honeymoon_amenity'] });
    assert.equal(scoreTraineePenalty(t, mkHk({ isSenior: true })), 0);
  });
  it('penalizes trainees on VIP-flavored tasks', () => {
    const t = mkTask({ priority: 'urgent' });
    assert.equal(scoreTraineePenalty(t, mkHk({ isSenior: false })), -1);
  });
  it('penalizes trainees on welcome/honeymoon/anniversary extras', () => {
    const t = mkTask({ extras: ['welcome_amenity'] });
    assert.equal(scoreTraineePenalty(t, mkHk({ isSenior: false })), -1);
  });
  it('treats requires_inspection as VIP-flavored for trainees', () => {
    const t = mkTask({ requires_inspection: true });
    assert.equal(scoreTraineePenalty(t, mkHk({ isSenior: false })), -1);
  });
  it('returns 0 for trainees on routine cleans', () => {
    assert.equal(scoreTraineePenalty(mkTask(), mkHk({ isSenior: false })), 0);
  });
});

describe('scoreRushBoost', () => {
  it('strongly boosts urgent rush tasks', () => {
    assert.equal(scoreRushBoost(mkTask({ priority: 'urgent' })), 1);
  });
  it('lightly boosts high-priority tasks', () => {
    assert.equal(scoreRushBoost(mkTask({ priority: 'high' })), 0.3);
  });
  it('returns 0 for normal / low', () => {
    assert.equal(scoreRushBoost(mkTask({ priority: 'normal' })), 0);
    assert.equal(scoreRushBoost(mkTask({ priority: 'low' })), 0);
  });
});

describe('scoreAssignment (composite)', () => {
  it('builds a breakdown with composite equal to weighted sum', () => {
    const task = mkTask({ priority: 'high', room_number: '301' });
    const hk = mkHk({ homeFloor: 3, isSenior: true });
    const state = initHkState(hk);
    const cfg = mkConfig();
    const b = scoreAssignment(task, state, { minWorkloadMinutes: 0 }, cfg);
    const expected =
      cfg.weights.priority * b.priority +
      cfg.weights.urgency * b.urgency +
      cfg.weights.floorMatch * b.floorMatch +
      cfg.weights.languageMatch * b.languageMatch +
      cfg.weights.skillMatch * b.skillMatch +
      cfg.weights.workloadBalance * b.workloadBalance +
      cfg.weights.overtimePenalty * b.overtimePenalty +
      cfg.weights.traineePenalty * b.traineePenalty +
      cfg.weights.rushBoost * b.rushBoost;
    assert.equal(b.composite.toFixed(6), expected.toFixed(6));
  });
});

describe('buildReason', () => {
  it('mentions the top positive contributor', () => {
    const task = mkTask({ priority: 'urgent', guest_language: 'es', room_number: '203' });
    const hk = mkHk({ language: 'es', homeFloor: 2 });
    const state = initHkState(hk);
    const cfg = mkConfig();
    const b = scoreAssignment(task, state, { minWorkloadMinutes: 0 }, cfg);
    const reason = buildReason(b, hk);
    // Several positive features should appear; "urgent" or "floor match"
    // or "language match" should at least be present.
    assert.match(reason, /urgent|floor match|language match/);
  });

  it('surfaces overtime warning when triggered', () => {
    const task = mkTask({ priority: 'normal' });
    const hk = mkHk({ weeklyHours: 45, maxWeeklyHours: 40 });
    const state = initHkState(hk);
    const cfg = mkConfig();
    const b = scoreAssignment(task, state, { minWorkloadMinutes: 0 }, cfg);
    const reason = buildReason(b, hk);
    assert.match(reason, /over weekly hours/);
  });
});
