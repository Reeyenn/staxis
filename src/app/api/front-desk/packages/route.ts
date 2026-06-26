/**
 * /api/front-desk/packages
 *
 * GET  — list packages for a property (+ held/picked-up counts).
 *        `?status=held|picked_up` filters the items; counts are always the full
 *        totals.
 * POST — log a new incoming package (status defaults to 'held').
 *
 * Authenticated, ANY signed-in user with access to the property (front-desk
 * staff access level — NOT management-only). The `packages` table is deny-all-
 * browser, so every read/write is service-role via the store.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateString, validateEnum } from '@/lib/api-validate';
import { gatePackagesRead, gatePackagesWrite } from '@/lib/packages/api-gate';
import {
  listPackages,
  computeCounts,
  signLabelPhotos,
  toClientRow,
  createPackage,
  isValidLabelPhotoPath,
} from '@/lib/packages/store';
import { PACKAGE_CARRIERS } from '@/lib/packages/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/** Optional-string validator: null/undefined/'' → null; else length-capped. */
function optStr(v: unknown, max: number, label: string): { error?: string; value?: string | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  const r = validateString(v, { max, label });
  if (r.error) return { error: r.error };
  return { value: r.value! };
}

// ─── GET — list + counts ─────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await gatePackagesRead(req, 'packages-read');
  if (!gate.ok) return gate.response;

  try {
    const records = await listPackages(gate.pid);
    const counts = computeCounts(records);

    const statusParam = new URL(req.url).searchParams.get('status');
    const filtered =
      statusParam === 'held' || statusParam === 'picked_up'
        ? records.filter((r) => r.status === statusParam)
        : records;

    const signed = await signLabelPhotos(filtered);
    return ok(
      { items: signed.map(toClientRow), counts },
      { requestId: gate.requestId },
    );
  } catch (e) {
    log.error('packages GET failed', { requestId: gate.requestId, err: errToString(e) });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

// ─── POST — create ───────────────────────────────────────────────────────────

interface CreateBody {
  pid?: string;
  guestName?: string;
  roomNumber?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  notes?: string | null;
  photoPath?: string | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gatePackagesWrite<CreateBody>(req, 'packages-write');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId, accountId } = gate;

  const bad = (msg: string) =>
    err(msg, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Recipient is required — a parcel with no addressee can't be handed back.
  const nameV = validateString(body.guestName, { max: 120, label: 'guestName' });
  if (nameV.error) return bad(nameV.error);
  const guestName = nameV.value!.trim();
  if (!guestName) return bad('guestName cannot be empty');

  const roomV = optStr(body.roomNumber, 20, 'roomNumber');
  if (roomV.error) return bad(roomV.error);

  let carrier: (typeof PACKAGE_CARRIERS)[number] | null = null;
  if (body.carrier !== undefined && body.carrier !== null && body.carrier !== '') {
    const c = validateEnum(body.carrier, PACKAGE_CARRIERS, 'carrier');
    if (c.error) return bad(c.error);
    carrier = c.value!;
  }

  const trackingV = optStr(body.trackingNumber, 40, 'trackingNumber');
  if (trackingV.error) return bad(trackingV.error);

  const notesV = optStr(body.notes, 1000, 'notes');
  if (notesV.error) return bad(notesV.error);

  // Photo path must match the EXACT shape our presign route mints under this
  // property — never an arbitrary, traversal, or cross-tenant key.
  let photoPath: string | null = null;
  if (body.photoPath) {
    if (!isValidLabelPhotoPath(pid, body.photoPath)) return bad('invalid photoPath');
    photoPath = String(body.photoPath);
  }

  try {
    const res = await createPackage(pid, {
      guestName,
      roomNumber: roomV.value,
      carrier,
      trackingNumber: trackingV.value,
      notes: notesV.value,
      photoPath,
      loggedByAccountId: accountId,
    });
    if (!res.ok) {
      return err('Could not log package', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    return ok({ id: res.id }, { requestId, status: 201 });
  } catch (e) {
    log.error('packages POST failed', { requestId, pid, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
