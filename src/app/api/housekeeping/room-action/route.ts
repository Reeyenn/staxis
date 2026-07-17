/**
 * Housekeeping room-action — manager Rooms-tab writes into the pms_* schema.
 *
 * Why this exists:
 *   Plan v4 (migration 0204) dropped the legacy `rooms` table. The manager
 *   tile-cycling writes used to update the legacy rooms table directly
 *   from the browser. RLS deny-all on pms_* blocks that, so writes now go
 *   through this server route, which uses supabaseAdmin to write to
 *   pms_housekeeping_assignments (canonical state) + pms_room_status_log
 *   (auditable change event with source='manual').
 *
 * Endpoint:
 *   POST /api/housekeeping/room-action
 *   body: { action, pid, rid?, room?, rooms? }
 *
 *   action: 'update' | 'add' | 'delete' | 'bulk-add'
 *     - 'update' → applyRoomUpdate(pid, rid, partial)
 *     - 'add'    → applyRoomAdd(pid, room) → returns Room.id
 *     - 'delete' → applyRoomDelete(pid, rid)
 *     - 'bulk-add' → applyBulkRoomAdd(pid, rooms) → returns counts; 207 on partial fail
 *
 * Auth + scope:
 *   - requireSession (manager-facing UI)
 *   - userHasPropertyAccess (the user owns the pid)
 *   - rate-limit per (userId, pid)
 */

import { userHasPropertyAccess } from '@/lib/api-auth';
import { defineRoute, sessionGate } from '@/lib/api-route';
import { validateUuid } from '@/lib/api-validate';
import { ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  applyRoomUpdate,
  applyRoomAdd,
  applyRoomDelete,
  applyBulkRoomAdd,
} from '@/lib/pms-rooms-writes';
import type { Room } from '@/types';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

type Action = 'update' | 'add' | 'delete' | 'bulk-add';
const VALID_ACTIONS: ReadonlySet<Action> = new Set(['update', 'add', 'delete', 'bulk-add']);

interface ActionBody {
  action?: string;
  pid?: string;
  rid?: string;
  room?: Partial<Room>;
  rooms?: Omit<Room, 'id'>[];
}

export const POST = defineRoute({
  resolve: (req) => sessionGate(req),
  handler: async (ctx) => {
    let body: ActionBody;
    try {
      body = (await ctx.req.json()) as ActionBody;
    } catch {
      return ctx.err('invalid_json', { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const pidV = validateUuid(body.pid, 'pid');
    if (pidV.error) {
      return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const pid = pidV.value!;

    const action = body.action as Action | undefined;
    if (!action || !VALID_ACTIONS.has(action)) {
      return ctx.err('action must be one of update | add | delete | bulk-add', {
        status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }

    const hasAccess = await userHasPropertyAccess(ctx.userId, pid);
    if (!hasAccess) {
      log.warn('[housekeeping/room-action] forbidden — user lacks property access', {
        requestId: ctx.requestId, userId: ctx.userId, pid,
      });
      return ctx.err('forbidden — no access to this property', {
        status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const rl = await checkAndIncrementRateLimit(
      'housekeeping-room-action',
      hashToRateLimitKey(`${ctx.userId}:${pid}`),
    );
    if (!rl.allowed) {
      return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
    }

    try {
      switch (action) {
        case 'update': {
          if (!body.rid || !body.room) {
            return ctx.err('update requires rid + room', {
              status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
          await applyRoomUpdate(pid, body.rid, body.room);
          return ctx.ok({ updated: true });
        }
        case 'add': {
          if (!body.room || !body.room.number) {
            return ctx.err('add requires room with number', {
              status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
          const id = await applyRoomAdd(pid, body.room as Omit<Room, 'id'>);
          return ctx.ok({ id });
        }
        case 'delete': {
          if (!body.rid) {
            return ctx.err('delete requires rid', {
              status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
          await applyRoomDelete(pid, body.rid);
          return ctx.ok({ deleted: true });
        }
        case 'bulk-add': {
          if (!Array.isArray(body.rooms)) {
            return ctx.err('bulk-add requires rooms array', {
              status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
          const result = await applyBulkRoomAdd(pid, body.rooms);
          if (result.assignmentsFailed.length > 0) {
            // 207-style envelope — body carries the per-row outcome.
            return ctx.err(
              `bulk-add: ${result.assignmentsFailed.length} of ${result.requested} assignment writes failed`,
              {
                status: 207,
                code: ApiErrorCode.PartialFailure,
                details: result,
              },
            );
          }
          return ctx.ok(result);
        }
      }
    } catch (e: unknown) {
      log.error('[housekeeping/room-action] write failed', {
        requestId: ctx.requestId, pid, action, msg: errToString(e),
      });
      return ctx.err('Internal server error', {
        status: 500, code: ApiErrorCode.InternalError,
      });
    }
  },
});
