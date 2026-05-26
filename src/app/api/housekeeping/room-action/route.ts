/**
 * Housekeeping room-action — manager-facing tile-cycling writes into the
 * new pms_* schema.
 *
 * Why this exists:
 *   Plan v4 (migration 0204) dropped the legacy `rooms` table. The
 *   manager-side write path used to call `supabase.from('rooms').update`
 *   directly from the browser. RLS deny-all on pms_* blocks that, so
 *   writes now go through this server route.
 *
 *   Mirrors the read route's shape (`/api/housekeeping/rooms`):
 *     - POST /api/housekeeping/room-action  body: { action, pid, rid?, room?, rooms? }
 *
 *   action: 'update' | 'add' | 'delete' | 'bulk-add'
 *     - 'update' → applyRoomUpdate(pid, rid, partial)
 *     - 'add'    → applyRoomAdd(pid, room) → returns the new Room.id
 *     - 'delete' → applyRoomDelete(pid, rid)
 *     - 'bulk-add' → applyBulkRoomAdd(pid, rooms)
 *
 *   The browser side (src/lib/db/rooms.ts) calls this route. It's a
 *   manager-only path — auth via requireSession + userHasPropertyAccess.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
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
  /** Required for 'update' and 'add'. Partial Room for update, full Room (sans id) for add. */
  room?: Partial<Room>;
  /** Required for 'bulk-add'. */
  rooms?: Omit<Room, 'id'>[];
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return err('invalid_json', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const pid = pidV.value!;

  const action = body.action as Action | undefined;
  if (!action || !VALID_ACTIONS.has(action)) {
    return err('action must be one of update | add | delete | bulk-add', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    log.warn('[housekeeping/room-action] forbidden — user lacks property access', {
      requestId, userId: auth.userId, pid,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // Rate-limit per (user, property). Writes are infrequent compared to
  // reads (typically one tap per minute per active room). 600/hr = 10/min
  // covers heavy manual tile cycling without breathing room burning.
  const rl = await checkAndIncrementRateLimit(
    'housekeeping-room-action',
    hashToRateLimitKey(`${auth.userId}:${pid}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    switch (action) {
      case 'update': {
        if (!body.rid || !body.room) {
          return err('update requires rid + room', {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        await applyRoomUpdate(pid, body.rid, body.room);
        return ok({ updated: true }, { requestId });
      }
      case 'add': {
        if (!body.room || !body.room.number) {
          return err('add requires room with number', {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        const id = await applyRoomAdd(pid, body.room as Omit<Room, 'id'>);
        return ok({ id }, { requestId });
      }
      case 'delete': {
        if (!body.rid) {
          return err('delete requires rid', {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        await applyRoomDelete(pid, body.rid);
        return ok({ deleted: true }, { requestId });
      }
      case 'bulk-add': {
        if (!Array.isArray(body.rooms)) {
          return err('bulk-add requires rooms array', {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed,
          });
        }
        const result = await applyBulkRoomAdd(pid, body.rooms);
        if (result.assignmentsFailed.length > 0) {
          // Surface partial failure with the failed room numbers so the
          // client can inform the user / retry selectively. 207-style
          // semantics via the standard envelope.
          return err(
            `bulk-add: ${result.assignmentsFailed.length} of ${result.requested} assignment writes failed`,
            {
              requestId,
              status: 207,
              code: ApiErrorCode.PartialFailure,
              details: result,
            },
          );
        }
        return ok(result, { requestId });
      }
    }
  } catch (e: unknown) {
    log.error('[housekeeping/room-action] write failed', {
      requestId, pid, action, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
