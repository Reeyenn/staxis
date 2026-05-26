/**
 * GET /api/front-desk/vip-arrivals?pid=<uuid>&today=YYYY-MM-DD
 *
 * VIP arrivals expected today. A reservation counts as VIP when ANY of:
 *   - rooms.priority='vip' for today's matching room number
 *   - pms_reservations.special_requests / notes / package_name mentions
 *     "vip" (case-insensitive)
 *   - pms_reservations.raw->>'vip' looks truthy ("true", "yes", "1")
 *
 * Returns one row per VIP arrival with:
 *   - guestName: redacted to initials for non-manager viewers
 *   - eta: pms_reservations.arrival_time or null
 *   - roomNumber
 *   - amenityReady: true when the matching cleaning task has been
 *     inspected, OR when rooms.status='inspected' for today.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  resolveCallerRole,
  passesFrontDeskGate,
  ROLES_ALLOWED_FRONT_DESK_READ,
  ROLES_ALLOWED_MANAGER_TIER,
} from '@/lib/front-desk-coordination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface VipRow {
  reservationId: string;
  guestName: string | null;
  eta: string | null;
  roomNumber: string | null;
  amenityReady: boolean;
  source: 'pms_text_match' | 'rooms_priority' | 'pms_raw_flag';
}

function initialsOnly(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((p) => `${p[0]?.toUpperCase() ?? ''}.`)
    .join(' ');
}

function looksVipText(...fields: Array<string | null | undefined>): boolean {
  for (const f of fields) {
    if (typeof f === 'string' && /\bvip\b/i.test(f)) return true;
  }
  return false;
}

function looksVipRaw(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const candidates = [r.vip, r.is_vip, r.guest_status, r.special_status, r.priority];
  for (const c of candidates) {
    if (c === true) return true;
    if (typeof c === 'string' && /^(true|yes|1|vip|platinum|gold)$/i.test(c.trim())) return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const today = searchParams.get('today') ?? '';
  if (!DATE_RE.test(today)) {
    return err('today must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const callerInfo = await resolveCallerRole(auth.userId);
  if (!passesFrontDeskGate(callerInfo, pid, ROLES_ALLOWED_FRONT_DESK_READ)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const viewerIsManager = !!callerInfo.role && ROLES_ALLOWED_MANAGER_TIER.has(callerInfo.role);

  try {
    // Pull arrivals for today.
    const { data: reservations, error: resErr } = await supabaseAdmin
      .from('pms_reservations')
      .select('id, guest_name, room_number, arrival_time, special_requests, package_name, notes, raw')
      .eq('property_id', pid)
      .eq('arrival_date', today);
    if (resErr) {
      log.warn('[front-desk/vip-arrivals] pms_reservations read failed', {
        requestId, pid, err: resErr.message,
      });
    }

    // Pull today's rooms board for the VIP priority flag + inspection status.
    const { data: rooms, error: rmErr } = await supabaseAdmin
      .from('rooms')
      .select('number, priority, status, inspected_at')
      .eq('property_id', pid)
      .eq('date', today);
    if (rmErr) {
      log.warn('[front-desk/vip-arrivals] rooms read failed', {
        requestId, pid, err: rmErr.message,
      });
    }

    type RoomMini = { priority: string | null; status: string; inspectedAt: string | null };
    const byRoomNumber = new Map<string, RoomMini>();
    for (const r of rooms ?? []) {
      const row = r as { number: string; priority: string | null; status: string; inspected_at: string | null };
      byRoomNumber.set(row.number, {
        priority: row.priority,
        status: row.status,
        inspectedAt: row.inspected_at,
      });
    }

    const outRows: VipRow[] = [];
    for (const r of reservations ?? []) {
      const row = r as {
        id: string;
        guest_name: string | null;
        room_number: string | null;
        arrival_time: string | null;
        special_requests: string | null;
        package_name: string | null;
        notes: string | null;
        raw: unknown;
      };

      const roomState = row.room_number ? byRoomNumber.get(row.room_number) ?? null : null;
      const matchedByRoomPriority = roomState?.priority === 'vip';
      const matchedByText = looksVipText(row.special_requests, row.notes, row.package_name);
      const matchedByRaw = looksVipRaw(row.raw);
      if (!matchedByRoomPriority && !matchedByText && !matchedByRaw) continue;

      const amenityReady = roomState
        ? (roomState.status === 'inspected' || roomState.inspectedAt != null)
        : false;

      const guestNameRaw = row.guest_name ?? null;
      outRows.push({
        reservationId: row.id,
        guestName: viewerIsManager
          ? guestNameRaw
          : (guestNameRaw ? initialsOnly(guestNameRaw) : null),
        eta: row.arrival_time,
        roomNumber: row.room_number,
        amenityReady,
        source: matchedByText ? 'pms_text_match'
              : matchedByRaw  ? 'pms_raw_flag'
                              : 'rooms_priority',
      });
    }

    // Also surface VIP-priority rooms that DON'T have a matching
    // reservation row — useful when CUA hasn't populated arrivals yet.
    for (const [number, state] of byRoomNumber.entries()) {
      if (state.priority !== 'vip') continue;
      const alreadyListed = outRows.some((r) => r.roomNumber === number);
      if (alreadyListed) continue;
      outRows.push({
        reservationId: `priority-only-${number}`,
        guestName: null,
        eta: null,
        roomNumber: number,
        amenityReady: state.status === 'inspected' || state.inspectedAt != null,
        source: 'rooms_priority',
      });
    }

    outRows.sort((a, b) => (a.eta ?? '99:99').localeCompare(b.eta ?? '99:99'));

    return ok({
      vips: outRows,
      viewerIsManager,
      generatedAt: new Date().toISOString(),
    }, { requestId });
  } catch (e) {
    log.error('[front-desk/vip-arrivals] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
