// POST /api/engineer/log-reading
// Body: { pid, staffId, readingTypeId, value?, textValue?, note?, source?,
//         photoBase64?, mediaType?, idempotencyKey? }
//
// Public engineer log. Capability gate, then logReading() (which detects
// out-of-range, auto-creates a work order + texts maintenance, and leaves the
// v2 anomaly seam). Photo (snap-to-log audit copy) is optional.

import { NextRequest } from 'next/server';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { checkStaffCapability } from '@/lib/compliance/api-helpers';
import { logReading, uploadCompliancePhoto } from '@/lib/compliance/store';
import { READING_SOURCES } from '@/lib/compliance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

interface Body {
  pid?: unknown; staffId?: unknown; readingTypeId?: unknown;
  value?: unknown; textValue?: unknown; note?: unknown; source?: unknown;
  photoBase64?: unknown; mediaType?: unknown; idempotencyKey?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const typeV = validateUuid(body.readingTypeId, 'readingTypeId');
  if (typeV.error) return err(typeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, staffId = staffV.value!, readingTypeId = typeV.value!;

  // value: finite number OR null (text-only reading). textValue is the fallback.
  let value: number | null = null;
  if (body.value !== null && body.value !== undefined && body.value !== '') {
    const n = Number(body.value);
    if (!Number.isFinite(n)) return err('value must be a number', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    if (n < -1e9 || n > 1e9) return err('value out of bounds', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    value = n;
  }
  let textValue: string | null = null;
  if (body.textValue !== undefined && body.textValue !== null) {
    const tv = validateString(body.textValue, { max: 200, label: 'textValue', allowEmpty: true });
    if (tv.error) return err(tv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    textValue = tv.value || null;
  }
  if (value === null && !textValue) {
    return err('Provide a numeric value or a text value', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    const nv = validateString(body.note, { max: 500, label: 'note', allowEmpty: true });
    if (nv.error) return err(nv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    note = nv.value || null;
  }
  let source: 'manual' | 'voice' | 'photo' = 'manual';
  if (body.source !== undefined) {
    const sv = validateEnum(body.source, READING_SOURCES, 'source');
    if (sv.error) return err(sv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    source = sv.value!;
  }

  const rl = await checkAndIncrementRateLimit('engineer-log', hashToRateLimitKey(`${pid}:${staffId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const staff = await checkStaffCapability(pid, staffId);
  if (!staff) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  try {
    // Optional snap-to-log photo for the audit trail.
    let photoPath: string | null = null;
    if (typeof body.photoBase64 === 'string' && body.photoBase64.length > 100 && body.photoBase64.length < 8_000_000 &&
        typeof body.mediaType === 'string' && (MEDIA_TYPES as readonly string[]).includes(body.mediaType)) {
      photoPath = await uploadCompliancePhoto(pid, body.photoBase64, body.mediaType);
      if (photoPath && source === 'manual') source = 'photo';
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length <= 120
      ? body.idempotencyKey : null;

    const result = await logReading({
      pid, readingTypeId, value, textValue, source, note, photoPath,
      staffId: staff.id, staffName: staff.name, idempotencyKey,
    });
    return ok({
      readingId: result.reading.id,
      outOfRange: result.outOfRange,
      workOrderCreated: !!result.workOrderId,
      duplicate: result.duplicate,
    }, { requestId });
  } catch (e) {
    log.error('[engineer/log-reading] failed', { requestId, pid, staffId, msg: errToString(e) });
    const msg = errToString(e);
    if (/not found/i.test(msg)) return err('Reading type not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
