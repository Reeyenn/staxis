// Public surface of the front-desk coordination layer.
//
// Keep imports throughout the app coming THROUGH this barrel. Internal
// modules can import from each other directly; everything outside the
// directory should depend only on the names exported here.

export { dispatchSMS, resolveSmsNotificationMode } from './dispatch-sms';
export type { DispatchSMSInput, DispatchSMSResult } from './dispatch-sms';

export {
  findCurrentlyWorkingFrontDesk,
  clockInTimezone,
  isTimeInShiftWindow,
} from './find-currently-working';
export type { CurrentlyWorkingStaff } from './find-currently-working';

export { findNextReadyRoom } from './next-ready-room';
export type { NextReadyRoomInput, NextReadyRoomCandidate } from './next-ready-room';

export { executeRoomMove } from './room-move-orchestrator';
export type { RoomMoveInput, RoomMoveResult } from './room-move-orchestrator';

export type {
  DispatchEventType,
  DispatchMode,
  DispatchOutcome,
  DispatchRecipient,
} from './types';

export {
  ROLES_ALLOWED_FRONT_DESK_READ,
  ROLES_ALLOWED_FRONT_DESK_WRITE,
  ROLES_ALLOWED_MANAGER_TIER,
  resolveCallerRole,
  passesFrontDeskGate,
} from './role-gate';
export type { CallerRoleInfo } from './role-gate';
