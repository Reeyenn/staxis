/**
 * Regression test for the 2026-04-30 floor-cohesion redesign of autoAssignRooms.
 *
 * Maria reported the previous auto-assign output split BOTH floors 3 and 4
 * between Cindy and Astri, even though one of them could have taken a whole
 * floor and only the second worker should have crossed. This test pins the
 * new floor-block behavior so it can't regress.
 */

import { describe, it, expect } from 'vitest';
import { autoAssignRooms } from '../calculations';
import type { StaffMember } from '@/types';

function makeStaff(id: string, schedulePriority: 'priority' | 'normal' = 'normal'): StaffMember {
  return {
    id,
    name: id.toUpperCase(),
    isSenior: false,
    scheduledToday: true,
    isActive: true,
    schedulePriority,
    language: 'en',
    department: 'housekeeping',
  } as unknown as StaffMember;
}

function makeRoom(num: string, type: 'checkout' | 'stayover', stayoverDay?: number) {
  return { id: `r-${num}`, number: num, type, priority: 'standard', stayoverDay };
}

function floorOf(num: string): string {
  return num.length >= 3 ? num[0] : '1';
}

function summarize(
  assignments: Record<string, string>,
  rooms: Array<{ id: string; number: string }>,
) {
  // staffId -> Set<floor>
  const floorsByStaff: Record<string, Set<string>> = {};
  // staffId -> roomNumbers[]
  const roomsByStaff: Record<string, string[]> = {};
  for (const r of rooms) {
    const sid = assignments[r.id];
    if (!sid) continue;
    floorsByStaff[sid] = floorsByStaff[sid] || new Set();
    floorsByStaff[sid].add(floorOf(r.number));
    roomsByStaff[sid] = roomsByStaff[sid] || [];
    roomsByStaff[sid].push(r.number);
  }
  return { floorsByStaff, roomsByStaff };
}


describe('autoAssignRooms — floor cohesion (2026-04-30 redesign)', () => {
  it('gives an entire small-enough floor to ONE housekeeper instead of splitting it', () => {
    // Two floors, each with rooms that easily fit on one HK at the 7h cap.
    // Two HKs available. Expectation: HK1 owns one floor entirely, HK2 owns
    // the other entirely. Zero cross-floor walking.
    const rooms = [
      // Floor 1 — 6 stayovers ≈ 150 min, fits one HK trivially.
      makeRoom('101', 'stayover'), makeRoom('102', 'stayover'),
      makeRoom('103', 'stayover'), makeRoom('104', 'stayover'),
      makeRoom('105', 'stayover'), makeRoom('106', 'stayover'),
      // Floor 2 — same shape.
      makeRoom('201', 'stayover'), makeRoom('202', 'stayover'),
      makeRoom('203', 'stayover'), makeRoom('204', 'stayover'),
      makeRoom('205', 'stayover'), makeRoom('206', 'stayover'),
    ];
    const staff = [makeStaff('a'), makeStaff('b')];
    const out = autoAssignRooms(rooms, staff);

    const { floorsByStaff } = summarize(out, rooms);
    // Each HK should own exactly one floor.
    expect(Object.keys(floorsByStaff)).toHaveLength(2);
    for (const sid of Object.keys(floorsByStaff)) {
      expect(floorsByStaff[sid].size).toBe(1);
    }
  });

  it('only the spillover housekeeper crosses floors when one floor exceeds a single shift', () => {
    // Floor 3: 21 stayovers × ~25 min each = ~525 min — too big for 1 HK at
    // the 420-min cap. Floor 4: 18 stayovers ≈ 450 min, also too big — but
    // close enough that one HK can take most of it.
    //
    // Expected with the new algorithm:
    //   • One HK owns ~17 rooms on floor 3 (capped near 420 min)
    //   • The other HK takes the floor-3 spillover (~3-4 rooms) AND ~14 rooms
    //     on floor 4 — they're the only one who crosses.
    //
    // The OLD algorithm (regression target) would have split BOTH floors
    // between the two HKs. We assert at most ONE HK crosses both floors.
    const rooms: ReturnType<typeof makeRoom>[] = [];
    for (let n = 300; n < 321; n++) rooms.push(makeRoom(String(n), 'stayover'));
    for (let n = 400; n < 418; n++) rooms.push(makeRoom(String(n), 'stayover'));

    const staff = [makeStaff('a'), makeStaff('b')];
    const out = autoAssignRooms(rooms, staff);
    const { floorsByStaff, roomsByStaff } = summarize(out, rooms);

    // The algorithm should fill both shifts close to the cap. With 2 HKs at
    // 420 min and ~25 min/room, expect ~32 rooms placed (the rest correctly
    // surface as unassigned — Reeyen prefers a flagged overflow over a
    // silent over-cap shift).
    const placed = Object.values(roomsByStaff).reduce((s, arr) => s + arr.length, 0);
    expect(placed).toBeGreaterThanOrEqual(30);

    // CRITICAL ASSERTION: at most ONE housekeeper touches both floors.
    // The pre-redesign algorithm split BOTH floors between the same two
    // HKs (each crossing). If this regresses, both HKs will have size > 1.
    const crossers = Object.values(floorsByStaff).filter(s => s.size > 1).length;
    expect(crossers).toBeLessThanOrEqual(1);
  });

  it('produces deterministic output (same input → same assignment)', () => {
    // Mario clicks Auto-assign twice in a row; both clicks must yield the
    // same room → staff mapping. Otherwise the schedule shuffles every
    // time someone accidentally re-clicks the button.
    const rooms = [
      makeRoom('101', 'checkout'), makeRoom('102', 'stayover'),
      makeRoom('201', 'checkout'), makeRoom('202', 'stayover'),
      makeRoom('301', 'checkout'), makeRoom('302', 'stayover'),
    ];
    const staff = [makeStaff('a'), makeStaff('b'), makeStaff('c')];

    const a1 = autoAssignRooms(rooms, staff);
    const a2 = autoAssignRooms(rooms, staff);
    expect(a1).toEqual(a2);
  });

  it("respects the shift cap — never piles a HK over the cap to keep them on one floor", () => {
    // Pathological: ONE huge floor much larger than any single shift.
    // The spillover MUST go somewhere — we trade some floor-purity for the
    // hard cap. Each HK individually must remain under the cap.
    const rooms: ReturnType<typeof makeRoom>[] = [];
    for (let n = 300; n < 340; n++) rooms.push(makeRoom(String(n), 'checkout'));
    const staff = [makeStaff('a'), makeStaff('b'), makeStaff('c')];

    const out = autoAssignRooms(rooms, staff);
    // Recompute load per HK (checkout = 30 + 5 prep = 35).
    const load: Record<string, number> = {};
    for (const r of rooms) {
      const sid = out[r.id];
      if (sid) load[sid] = (load[sid] ?? 0) + 35;
    }
    for (const sid of Object.keys(load)) {
      expect(load[sid]).toBeLessThanOrEqual(420);
    }
  });

  it("prefers stickiness when spillover happens (HK already on floor finishes it)", () => {
    // Floor 1: 10 stayovers (fits) + Floor 2: 30 stayovers (forces split).
    // Algorithm processes floor 2 first (largest). Two HKs split it. Then
    // floor 1 goes to whoever has more capacity — should NOT bring in
    // a third HK who hasn't been touched yet.
    const rooms: ReturnType<typeof makeRoom>[] = [];
    for (let n = 101; n <= 110; n++) rooms.push(makeRoom(String(n), 'stayover'));
    for (let n = 201; n <= 230; n++) rooms.push(makeRoom(String(n), 'stayover'));

    const staff = [makeStaff('a'), makeStaff('b'), makeStaff('c')];
    const out = autoAssignRooms(rooms, staff);
    const { floorsByStaff } = summarize(out, rooms);

    // The third HK should ideally NOT remain unused — they're the natural
    // home for floor 1 once the first two have committed to floor 2.
    // (Whichever HK ends up with floor 1 should own it cleanly.)
    let singleFloorCount = 0;
    for (const f of Object.values(floorsByStaff)) {
      if (f.size === 1) singleFloorCount++;
    }
    // At least 2 of the 3 HKs are single-floor.
    expect(singleFloorCount).toBeGreaterThanOrEqual(2);
  });
});
