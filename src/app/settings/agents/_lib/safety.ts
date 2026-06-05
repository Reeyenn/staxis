// Pure safety-dial logic. Imports ONLY contract types so the unit test loads
// cleanly under `tsx --conditions=react-server` (no client/server modules).
//
// The Safety Dial has three modes, least → most autonomous:
//   suggest        — only proposes; never executes
//   approve_first  — queues; executes after a manager approves ("Ask me first")
//   auto           — executes immediately, no approval
//
// approvalFloor is the LOWEST-friction mode allowed. Money/guest actions have
// approvalFloor='approve_first', so 'auto' (lower friction than the floor) is
// forbidden for them — the UI hides it and buildAgentConfig clamps it.

import type { ActionApprovalMode } from '@/lib/agents/types';

export const ALL_MODES: ActionApprovalMode[] = ['suggest', 'approve_first', 'auto'];

interface FloorBearing {
  approvalFloor: ActionApprovalMode;
}

/** True when 'auto' must be disabled — i.e. the action spends money or contacts
 *  a guest (floor is approve_first). */
export function autoDisabled(meta: FloorBearing): boolean {
  return meta.approvalFloor === 'approve_first';
}

/** The modes the dial may offer for an action, respecting its floor. */
export function allowedModes(meta: FloorBearing): ActionApprovalMode[] {
  return autoDisabled(meta) ? ['suggest', 'approve_first'] : ALL_MODES;
}

/** Clamp a desired mode so it never drops below the floor.
 *  Defense-in-depth: even if the UI sent 'auto' for a flagged action, this keeps
 *  it at approve_first before it can be persisted. (The engine also re-clamps at
 *  run time via moneyOrGuestRequiresApproval.) */
export function clampMode(mode: ActionApprovalMode, floor: ActionApprovalMode): ActionApprovalMode {
  if (floor === 'approve_first' && mode === 'auto') return 'approve_first';
  return mode;
}
