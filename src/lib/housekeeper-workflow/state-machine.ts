/**
 * Pure state-machine functions for the housekeeper workflow.
 *
 * This file has NO database calls and NO side effects — every function is
 * pure (input → output, no I/O). That makes the rules trivially unit
 * testable and keeps the API routes focused on persistence concerns.
 *
 * Workflow lifecycle:
 *
 *   dirty
 *     │
 *     │  Start  ───────────────────────────────────────► in_progress
 *     │                                                    │
 *     │                                          ┌────────┤
 *     │                                          │        │
 *     │                                       Pause   Done
 *     │                                          │        │
 *     │                                          ▼        ▼
 *     │                                  in_progress    clean
 *     │                                  (is_paused)
 *     │                                          │
 *     │                                       Resume
 *     │                                          ▼
 *     │                                   in_progress
 *     │
 *     │  Exception ► dirty (with exception_type set)
 *     │
 *     └──────────────────────────────────────────────►
 *
 *  Exception types: 'dnd' | 'nsr' | 'dla' | 'sleep_out' | 'skipped'
 *
 *  Tested in src/lib/housekeeper-workflow/__tests__/state-machine.test.ts.
 */

export type RoomWorkflowStatus = 'dirty' | 'in_progress' | 'clean' | 'inspected';

export type ExceptionType = 'dnd' | 'nsr' | 'dla' | 'sleep_out' | 'skipped';

export const EXCEPTION_TYPES: readonly ExceptionType[] = [
  'dnd',
  'nsr',
  'dla',
  'sleep_out',
  'skipped',
] as const;

export interface RoomWorkflowState {
  status: RoomWorkflowStatus;
  isPaused: boolean;
  exceptionType: ExceptionType | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  totalPausedSeconds: number;
}

export type WorkflowAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'exception'
  | 'clear_exception'
  | 'reset';

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  next?: RoomWorkflowState;
}

/**
 * Compute the next state from current state + action. Pure.
 *
 * `nowIso` is injected so tests can pin the clock; production code passes
 * `new Date().toISOString()`.
 *
 * Returns `{ ok: false, reason }` for illegal transitions so the API
 * route can respond 409 with a useful message instead of corrupting the
 * row.
 */
export function transition(
  current: RoomWorkflowState,
  action: WorkflowAction,
  nowIso: string,
  exceptionType: ExceptionType | null = null,
): TransitionResult {
  switch (action) {
    case 'start': {
      // Start requires status=dirty AND no exception. Re-Start after a
      // Reset is fine because Reset clears exception_type.
      if (current.status !== 'dirty') {
        return { ok: false, reason: `cannot start from status ${current.status}` };
      }
      if (current.exceptionType) {
        return { ok: false, reason: `cannot start a room with exception ${current.exceptionType}` };
      }
      return {
        ok: true,
        next: {
          ...current,
          status: 'in_progress',
          isPaused: false,
          startedAt: nowIso,
          pausedAt: null,
          completedAt: null,
          totalPausedSeconds: 0,
        },
      };
    }

    case 'pause': {
      if (current.status !== 'in_progress') {
        return { ok: false, reason: `cannot pause from status ${current.status}` };
      }
      if (current.isPaused) {
        return { ok: false, reason: 'already paused' };
      }
      return {
        ok: true,
        next: {
          ...current,
          isPaused: true,
          pausedAt: nowIso,
        },
      };
    }

    case 'resume': {
      if (current.status !== 'in_progress') {
        return { ok: false, reason: `cannot resume from status ${current.status}` };
      }
      if (!current.isPaused) {
        return { ok: false, reason: 'not paused' };
      }
      // Accumulate the elapsed pause time into totalPausedSeconds.
      const pausedAtMs = current.pausedAt ? Date.parse(current.pausedAt) : NaN;
      const nowMs = Date.parse(nowIso);
      const elapsedSec = Number.isFinite(pausedAtMs) && Number.isFinite(nowMs)
        ? Math.max(0, Math.floor((nowMs - pausedAtMs) / 1000))
        : 0;
      return {
        ok: true,
        next: {
          ...current,
          isPaused: false,
          pausedAt: null,
          totalPausedSeconds: current.totalPausedSeconds + elapsedSec,
        },
      };
    }

    case 'complete': {
      if (current.status !== 'in_progress') {
        return { ok: false, reason: `cannot complete from status ${current.status}` };
      }
      // If the room is currently paused when Done is tapped, finalize the
      // pause window the same way Resume would. Otherwise the duration
      // calculation would include the pause time.
      let totalPaused = current.totalPausedSeconds;
      if (current.isPaused && current.pausedAt) {
        const pausedAtMs = Date.parse(current.pausedAt);
        const nowMs = Date.parse(nowIso);
        if (Number.isFinite(pausedAtMs) && Number.isFinite(nowMs)) {
          totalPaused += Math.max(0, Math.floor((nowMs - pausedAtMs) / 1000));
        }
      }
      return {
        ok: true,
        next: {
          ...current,
          status: 'clean',
          isPaused: false,
          pausedAt: null,
          completedAt: nowIso,
          totalPausedSeconds: totalPaused,
        },
      };
    }

    case 'exception': {
      if (!exceptionType) {
        return { ok: false, reason: 'exception requires exceptionType' };
      }
      if (current.status === 'clean' || current.status === 'inspected') {
        return { ok: false, reason: `cannot flag exception on a ${current.status} room` };
      }
      // Exception while in-progress: revert to dirty, clear timing.
      return {
        ok: true,
        next: {
          ...current,
          status: 'dirty',
          isPaused: false,
          pausedAt: null,
          startedAt: null,
          completedAt: null,
          totalPausedSeconds: 0,
          exceptionType,
        },
      };
    }

    case 'clear_exception': {
      if (!current.exceptionType) {
        return { ok: false, reason: 'no exception to clear' };
      }
      return {
        ok: true,
        next: {
          ...current,
          exceptionType: null,
        },
      };
    }

    case 'reset': {
      if (current.status === 'dirty' && !current.exceptionType) {
        return { ok: false, reason: 'already dirty' };
      }
      return {
        ok: true,
        next: {
          status: 'dirty',
          isPaused: false,
          exceptionType: null,
          startedAt: null,
          pausedAt: null,
          completedAt: null,
          totalPausedSeconds: 0,
        },
      };
    }

    default:
      return { ok: false, reason: `unknown action ${String(action)}` };
  }
}

/**
 * Compute active cleaning duration in minutes from start → complete,
 * subtracting paused time. Used for cleaning_events.duration_minutes.
 *
 * If either timestamp is missing or unparseable, returns 0.
 */
export function activeDurationMinutes(
  startedAtIso: string | null,
  completedAtIso: string | null,
  totalPausedSeconds: number,
): number {
  if (!startedAtIso || !completedAtIso) return 0;
  const startMs = Date.parse(startedAtIso);
  const endMs = Date.parse(completedAtIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const activeSec = Math.max(0, elapsedSec - totalPausedSeconds);
  return Number((activeSec / 60).toFixed(2));
}

/**
 * Map cleaning_type ↔ room.type ↔ default-checklist key.
 *
 * Until the rules engine is fully wired to the housekeeper UI, rooms come
 * off the legacy `rooms` table with just `type` ('checkout' | 'stayover' |
 * 'vacant') and we infer the cleaning_type. Once cleaning_tasks lands as
 * the read source, the cleaning_type comes directly off the row.
 *
 * Fallback table:
 *   checkout → departure
 *   stayover → stayover  (or refresh if same-name back-to-back, future)
 *   vacant   → refresh
 *   anything else → departure (conservative default)
 */
export function inferCleaningType(
  roomType: string | null | undefined,
): 'departure' | 'stayover' | 'deep' | 'refresh' | 'inspection' {
  switch (roomType) {
    case 'checkout':
      return 'departure';
    case 'stayover':
      return 'stayover';
    case 'vacant':
      return 'refresh';
    default:
      return 'departure';
  }
}

/**
 * Pull a numeric floor out of a room number. "101" → "1", "205A" → "2",
 * "PH" → "PH" (penthouse / non-numeric labels stay as-is).
 */
export function floorFromRoomNumber(roomNumber: string): string {
  const n = parseInt(roomNumber, 10);
  if (!Number.isFinite(n)) return roomNumber;
  // 101 → 1, 215 → 2, 1207 → 12
  if (n < 100) return String(n);
  return String(Math.floor(n / 100));
}
