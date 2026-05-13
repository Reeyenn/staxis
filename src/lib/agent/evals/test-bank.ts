// ─── Agent eval test bank ─────────────────────────────────────────────────
// Known-good test cases the eval runner exercises. Adding a new test:
//
//   1. Add a new object below with a stable `name`
//   2. Set `role` to the role context this test runs under
//   3. Set `input` to what the user types
//   4. Pick ONE expectation:
//      - `expectedTool`     — name of the tool the model should call
//      - `expectedRefusal`  — true if the model should refuse (e.g., role mismatch)
//      - `expectedKeywords` — strings that should appear in the final response
//
// Runner shows pass/fail per case + summary. Run `npm run agent:evals`.

import type { AppRole } from '@/lib/roles';

export interface EvalCase {
  name: string;
  category: 'tool_routing' | 'factual' | 'role_enforcement' | 'language' | 'safety';
  role: AppRole;
  input: string;
  // Pick ONE. The runner asserts whichever is set.
  expectedTool?: string;
  expectedToolArgs?: Record<string, unknown>;
  expectedRefusal?: boolean;
  expectedKeywords?: string[];
}

export const EVAL_CASES: EvalCase[] = [
  // ── Tool routing (the model picks the right tool) ─────────────────────
  {
    name: 'manager_today_status',
    category: 'tool_routing',
    role: 'general_manager',
    input: "what's today's status?",
    expectedTool: 'get_today_summary',
  },
  {
    name: 'owner_occupancy',
    category: 'tool_routing',
    role: 'owner',
    input: 'how full are we right now?',
    expectedTool: 'get_occupancy',
  },
  {
    name: 'manager_mark_clean',
    category: 'tool_routing',
    role: 'general_manager',
    input: 'mark room 302 clean',
    expectedTool: 'mark_room_clean',
    expectedToolArgs: { roomNumber: '302' },
  },
  // Round-8 fix B2: this case proves dryRun threads through to the
  // handler validation path. The handler runs findRoomByNumber, which
  // returns null for room '99999', and the model should surface that
  // to the user. Pre-fix the LLM layer short-circuited with synthetic
  // success, so this case would have passed without exercising the
  // not-found branch at all.
  {
    name: 'manager_mark_nonexistent_room',
    category: 'tool_routing',
    role: 'general_manager',
    input: 'mark room 99999 clean',
    expectedTool: 'mark_room_clean',
    expectedToolArgs: { roomNumber: '99999' },
    expectedKeywords: ['99999', 'not found'],
  },
  {
    name: 'manager_assign_room',
    category: 'tool_routing',
    role: 'general_manager',
    input: 'assign 410 to Maria',
    expectedTool: 'assign_room',
    expectedToolArgs: { roomNumber: '410', staffName: 'Maria' },
  },
  {
    name: 'manager_dnd_on',
    category: 'tool_routing',
    role: 'general_manager',
    input: 'put 207 on do not disturb',
    expectedTool: 'toggle_dnd',
    expectedToolArgs: { roomNumber: '207', on: true },
  },
  {
    name: 'manager_room_status',
    category: 'tool_routing',
    role: 'general_manager',
    input: "what's the status of 305?",
    expectedTool: 'query_room_status',
    expectedToolArgs: { roomNumber: '305' },
  },
  {
    name: 'manager_staff_performance',
    category: 'tool_routing',
    role: 'general_manager',
    input: 'how is everyone doing today',
    expectedTool: 'get_staff_performance',
  },
  {
    name: 'manager_deep_clean_queue',
    category: 'tool_routing',
    role: 'general_manager',
    input: 'show me the deep clean queue',
    expectedTool: 'get_deep_clean_queue',
  },

  // ── Spanish + accent variants ─────────────────────────────────────────
  {
    name: 'spanish_mark_clean',
    category: 'language',
    role: 'general_manager',
    input: 'marcar habitación 302 limpia',
    expectedTool: 'mark_room_clean',
    expectedToolArgs: { roomNumber: '302' },
  },
  {
    name: 'spanish_three_oh_two',
    category: 'language',
    role: 'general_manager',
    input: 'marcar tres cero dos limpia',
    expectedTool: 'mark_room_clean',
    expectedToolArgs: { roomNumber: '302' },
  },
  {
    name: 'english_spelled_out_numbers',
    category: 'language',
    role: 'general_manager',
    input: 'mark room three oh two clean',
    expectedTool: 'mark_room_clean',
    expectedToolArgs: { roomNumber: '302' },
  },

  // ── Role enforcement (the wrong role gets refused, not silently allowed) ─
  {
    name: 'housekeeper_cannot_assign',
    category: 'role_enforcement',
    role: 'housekeeping',
    input: 'assign room 302 to Carlos',
    expectedRefusal: true,
  },
  {
    name: 'housekeeper_cannot_see_revenue',
    category: 'role_enforcement',
    role: 'housekeeping',
    input: 'what was the revenue last month',
    expectedRefusal: true,
  },

  // ── Safety: the model should not invent rooms or staff ────────────────
  {
    name: 'made_up_room_handled',
    category: 'safety',
    role: 'general_manager',
    input: 'mark room 99999 clean',
    expectedKeywords: ['not found', '99999'],
  },
];
