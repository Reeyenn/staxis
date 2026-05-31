/**
 * /api/front-desk/lost-and-found
 *
 * GET  — the unified register (app-logged items UNION pms_lost_and_found) +
 *        counts. `?countsOnly=1` returns just the counts (dashboard tile).
 * POST — mutations, discriminated by `action`:
 *          'log'    — log a found item or a guest lost report
 *          'update' — mark returned / shipped / disposed, edit fields
 *          'match'  — link a lost report to a found item
 *
 * Authenticated, management-role only (see api-gate). Both underlying tables
 * are deny-all-browser, so EVERY read/write is service-role via the store.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  validateString,
  validateUuid,
  validateEnum,
  validatePhone,
  isValidEmail,
} from '@/lib/api-validate';
import { gateFrontDeskRead, gateFrontDeskWrite } from '@/lib/lost-and-found/api-gate';
import {
  fetchRegister,
  computeCounts,
  createItem,
  updateAppItem,
  matchItems,
  signItemPhotos,
} from '@/lib/lost-and-found/store';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// ─── GET — register + counts ────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await gateFrontDeskRead(req, 'lost-found-read');
  if (!gate.ok) return gate.response;

  try {
    const items = await fetchRegister(gate.pid);
    const counts = computeCounts(items);
    const countsOnly = new URL(req.url).searchParams.get('countsOnly') === '1';
    if (countsOnly) return ok({ counts }, { requestId: gate.requestId });
    const withPhotos = await signItemPhotos(items);
    return ok({ items: withPhotos, counts }, { requestId: gate.requestId });
  } catch (e) {
    log.error('lost-and-found GET failed', { requestId: gate.requestId, err: errToString(e) });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

// ─── POST — mutations ─────────────────────────────────────────────────────────

interface MutationBody {
  pid?: string;
  action?: string;
  // log
  type?: string;
  itemDescription?: string;
  category?: string | null;
  location?: string | null;
  roomNumber?: string | null;
  photoPath?: string | null;
  guestName?: string | null;
  guestContact?: string | null;
  foundBy?: string | null;
  reportedBy?: string | null;
  notes?: string | null;
  occurredAt?: string | null;
  // update
  id?: string;
  status?: string;
  shippingInfo?: Record<string, unknown> | null;
  // match
  lostId?: string;
  foundId?: string;
}

const UPDATABLE_STATUSES = ['open', 'returned', 'shipped', 'disposed'] as const;

/** Optional-string validator: null/undefined/'' → null; else length-capped. */
function optStr(v: unknown, max: number, label: string): { error?: string; value?: string | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  const r = validateString(v, { max, label });
  if (r.error) return { error: r.error };
  return { value: r.value! };
}

/** Guest contact: a phone OR an email, capped. Empty → null. */
function validateGuestContact(v: unknown): { error?: string; value?: string | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: 'guestContact must be a string' };
  const trimmed = v.trim();
  if (trimmed.length > 200) return { error: 'guestContact too long (max 200)' };
  if (trimmed.includes('@')) {
    return isValidEmail(trimmed) ? { value: trimmed } : { error: 'guestContact is not a valid email' };
  }
  const ph = validatePhone(trimmed, 'guestContact');
  if (ph.error) return { error: ph.error };
  return { value: ph.value || null };
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateFrontDeskWrite<MutationBody>(req, 'lost-found-write');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId, accountId } = gate;

  const bad = (msg: string) =>
    err(msg, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  try {
    switch (body.action) {
      // ── log a found item or a lost report ──────────────────────────────
      case 'log': {
        const typeV = validateEnum(body.type, ['found', 'lost'] as const, 'type');
        if (typeV.error) return bad(typeV.error);

        const descV = validateString(body.itemDescription, { max: 500, label: 'itemDescription' });
        if (descV.error) return bad(descV.error);

        let category: string | null = null;
        if (body.category) {
          const c = validateEnum(body.category, LAF_CATEGORIES, 'category');
          if (c.error) return bad(c.error);
          category = c.value!;
        }

        const locV = optStr(body.location, 200, 'location');
        if (locV.error) return bad(locV.error);
        const roomV = optStr(body.roomNumber, 20, 'roomNumber');
        if (roomV.error) return bad(roomV.error);
        const guestNameV = optStr(body.guestName, 120, 'guestName');
        if (guestNameV.error) return bad(guestNameV.error);
        const contactV = validateGuestContact(body.guestContact);
        if (contactV.error) return bad(contactV.error);
        const foundByV = optStr(body.foundBy, 120, 'foundBy');
        if (foundByV.error) return bad(foundByV.error);
        const reportedByV = optStr(body.reportedBy, 120, 'reportedBy');
        if (reportedByV.error) return bad(reportedByV.error);
        const notesV = optStr(body.notes, 1000, 'notes');
        if (notesV.error) return bad(notesV.error);

        // Photo path must belong to THIS property's storage scope — never
        // accept an arbitrary or cross-tenant key.
        let photoPath: string | null = null;
        if (body.photoPath) {
          const p = String(body.photoPath);
          if (p.length > 200 || !p.startsWith(`${pid}/`) || !/^[A-Za-z0-9/_.-]+$/.test(p)) {
            return bad('invalid photoPath');
          }
          photoPath = p;
        }

        let occurredAt: string | null = null;
        if (body.occurredAt) {
          const ms = Date.parse(String(body.occurredAt));
          if (!Number.isFinite(ms)) return bad('occurredAt is not a valid timestamp');
          // Clamp to "not in the future" — found/lost happened already.
          occurredAt = new Date(Math.min(ms, Date.now())).toISOString();
        }

        const res = await createItem(pid, {
          type: typeV.value!,
          itemDescription: descV.value!,
          category,
          location: locV.value,
          roomNumber: roomV.value,
          photoPath,
          guestName: guestNameV.value,
          guestContact: contactV.value,
          foundBy: foundByV.value,
          reportedBy: reportedByV.value,
          notes: notesV.value,
          occurredAt,
          source: 'front_desk',
          createdByAccountId: accountId,
        });
        if (!res.ok) {
          return err('Could not log item', {
            requestId,
            status: 500,
            code: ApiErrorCode.InternalError,
          });
        }
        return ok({ id: res.id }, { requestId });
      }

      // ── update status / fields ─────────────────────────────────────────
      case 'update': {
        const idV = validateUuid(body.id, 'id');
        if (idV.error) return bad(idV.error);

        const patch: Parameters<typeof updateAppItem>[2] = {};
        if (body.status !== undefined) {
          const s = validateEnum(body.status, UPDATABLE_STATUSES, 'status');
          if (s.error) return bad(s.error);
          patch.status = s.value!;
          // Stamp the resolution time so the register can show "returned 2d ago".
          if (s.value === 'returned' || s.value === 'shipped') {
            patch.returnedAt = new Date().toISOString();
          }
        }
        if (body.notes !== undefined) {
          const n = optStr(body.notes, 1000, 'notes');
          if (n.error) return bad(n.error);
          patch.notes = n.value;
        }
        if (body.guestContact !== undefined) {
          const c = validateGuestContact(body.guestContact);
          if (c.error) return bad(c.error);
          patch.guestContact = c.value;
        }
        if (body.guestName !== undefined) {
          const g = optStr(body.guestName, 120, 'guestName');
          if (g.error) return bad(g.error);
          patch.guestName = g.value;
        }
        if (body.category !== undefined && body.category !== null) {
          const c = validateEnum(body.category, LAF_CATEGORIES, 'category');
          if (c.error) return bad(c.error);
          patch.category = c.value!;
        }
        if (body.shippingInfo !== undefined) {
          if (body.shippingInfo !== null && typeof body.shippingInfo !== 'object') {
            return bad('shippingInfo must be an object');
          }
          // Cap the serialized size so a forged client can't bloat the row.
          if (body.shippingInfo && JSON.stringify(body.shippingInfo).length > 4000) {
            return bad('shippingInfo too large');
          }
          patch.shippingInfo = body.shippingInfo;
        }

        const res = await updateAppItem(pid, idV.value!, patch);
        if (!res.ok) {
          if (res.error === 'not_found') {
            return err('Item not found', {
              requestId,
              status: 404,
              code: ApiErrorCode.NotFound,
            });
          }
          return err('Could not update item', {
            requestId,
            status: 500,
            code: ApiErrorCode.InternalError,
          });
        }
        return ok({ updated: true }, { requestId });
      }

      // ── match a lost report to a found item ────────────────────────────
      case 'match': {
        const lostV = validateUuid(body.lostId, 'lostId');
        if (lostV.error) return bad(lostV.error);
        const foundV = validateUuid(body.foundId, 'foundId');
        if (foundV.error) return bad(foundV.error);

        const res = await matchItems(pid, lostV.value!, foundV.value!);
        if (!res.ok) {
          const status = res.error === 'not_found' ? 404 : 409;
          return err(`match_${res.error}`, {
            requestId,
            status,
            code: status === 404 ? ApiErrorCode.NotFound : ApiErrorCode.ValidationFailed,
          });
        }
        return ok({ matched: true }, { requestId });
      }

      default:
        return bad('unknown action');
    }
  } catch (e) {
    log.error('lost-and-found POST failed', {
      requestId,
      action: body.action,
      err: errToString(e),
    });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
