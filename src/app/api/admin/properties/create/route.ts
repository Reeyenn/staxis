/**
 * POST /api/admin/properties/create
 *
 * Phase M1 (2026-05-14) — the only path that creates new hotels in the
 * product. Before this, properties had to be hand-inserted via SQL,
 * which made onboarding hotel #2 impossible through the UI. The
 * createProperty() helper that used to live in src/lib/db/properties.ts
 * was deleted as orphan in Phase K — this is the replacement, gated
 * behind admin auth instead of being callable from any client page.
 *
 * What it does, atomically per request:
 *   1. Validates inputs (name, total_rooms, IANA timezone, optional
 *      pms_type / brand / property_kind / is_test).
 *   2. Inserts the property with the calling admin as owner_id placeholder.
 *      The actual hotel owner gains property_access via the join code in
 *      step 3 — owner_id stays as the admin until any future ownership
 *      transfer flow is built (out of scope here).
 *   3. Mints an "owner" role join code (single-use, 7-day TTL) so the
 *      admin can hand the new hotel's owner a one-shot signup link.
 *   4. Writes an audit row.
 *
 * Returns: { propertyId, joinCode, signupUrl, expiresAt }
 *
 * Discipline:
 *   - All validation runs server-side. Client-side checks are advisory only.
 *   - Timezone validated via Intl.DateTimeFormat (same mechanism as
 *     ml-service's require_property_timezone after Phase L). Phase K's
 *     CHECK (total_rooms > 0) catches a bypass at the DB layer too.
 *   - If join-code minting fails, the property still exists; admin can
 *     mint a code separately via /api/auth/join-codes. We don't wrap the
 *     two steps in a single transaction because Supabase JS doesn't
 *     expose transactions across two .insert() calls — the admin sees
 *     "property created, code generation failed" and can retry the code.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import {
  generateJoinCode,
  OWNER_CODE_TTL_HOURS,
  OWNER_CODE_MAX_USES,
} from '@/lib/join-codes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
  name?: unknown;
  totalRooms?: unknown;
  timezone?: unknown;
  pmsType?: unknown;
  brand?: unknown;
  propertyKind?: unknown;
  isTest?: unknown;
  ownerEmail?: unknown;
}

interface ValidationResult {
  ok: true;
  values: {
    name: string;
    totalRooms: number;
    timezone: string;
    pmsType: string | null;
    brand: string | null;
    propertyKind: string;
    isTest: boolean;
    ownerEmail: string | null;
  };
}

const KNOWN_PMS_TYPES = new Set([
  'choice_advantage',
  'manual_csv',
  // Future PMSes get added here as Phase M4 verifies them. Anything not
  // in this set is rejected so we don't silently accept typos like
  // "choiceadvantge" that would never wire up to a scraper.
]);

const KNOWN_PROPERTY_KINDS = new Set([
  'limited_service',
  'full_service',
  'extended_stay',
  'resort',
]);

function isValidIANATimezone(tz: string): boolean {
  // Same mechanism as Phase L's require_property_timezone in
  // ml-service/src/errors.py. Intl.DateTimeFormat throws a RangeError
  // for invalid IANA names (including path-traversal "../etc/passwd"
  // and embedded nulls — verified empirically in Phase L).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateBody(body: CreateBody): ValidationResult | { ok: false; reason: string } {
  if (typeof body.name !== 'string' || body.name.trim().length < 3 || body.name.length > 100) {
    return { ok: false, reason: 'name must be a string between 3 and 100 characters' };
  }
  if (typeof body.totalRooms !== 'number' || !Number.isInteger(body.totalRooms) ||
      body.totalRooms < 1 || body.totalRooms > 2000) {
    return { ok: false, reason: 'totalRooms must be an integer between 1 and 2000' };
  }
  if (typeof body.timezone !== 'string' || !isValidIANATimezone(body.timezone)) {
    return { ok: false, reason: `timezone must be a valid IANA name (got: ${String(body.timezone)})` };
  }

  // Optional fields.
  let pmsType: string | null = null;
  if (body.pmsType !== undefined && body.pmsType !== null && body.pmsType !== '') {
    if (typeof body.pmsType !== 'string' || !KNOWN_PMS_TYPES.has(body.pmsType)) {
      return {
        ok: false,
        reason: `pmsType must be one of: ${Array.from(KNOWN_PMS_TYPES).join(', ')} (got: ${String(body.pmsType)})`,
      };
    }
    pmsType = body.pmsType;
  }

  let brand: string | null = null;
  if (body.brand !== undefined && body.brand !== null && body.brand !== '') {
    if (typeof body.brand !== 'string' || body.brand.length > 100) {
      return { ok: false, reason: 'brand must be a string up to 100 chars' };
    }
    brand = body.brand;
  }

  let propertyKind = 'limited_service'; // matches DB default
  if (body.propertyKind !== undefined && body.propertyKind !== null && body.propertyKind !== '') {
    if (typeof body.propertyKind !== 'string' || !KNOWN_PROPERTY_KINDS.has(body.propertyKind)) {
      return {
        ok: false,
        reason: `propertyKind must be one of: ${Array.from(KNOWN_PROPERTY_KINDS).join(', ')}`,
      };
    }
    propertyKind = body.propertyKind;
  }

  const isTest = body.isTest === true;

  let ownerEmail: string | null = null;
  if (body.ownerEmail !== undefined && body.ownerEmail !== null && body.ownerEmail !== '') {
    if (typeof body.ownerEmail !== 'string' || !body.ownerEmail.includes('@')) {
      return { ok: false, reason: 'ownerEmail must be a valid email address' };
    }
    ownerEmail = body.ownerEmail.trim().toLowerCase();
  }

  return {
    ok: true,
    values: {
      name: body.name.trim(),
      totalRooms: body.totalRooms,
      timezone: body.timezone,
      pmsType,
      brand,
      propertyKind,
      isTest,
      ownerEmail,
    },
  };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return err(validation.reason, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const v = validation.values;

  // Insert property. owner_id = the admin creating it (placeholder until
  // any future ownership-transfer flow). Phase K's CHECK (total_rooms > 0)
  // is the DB-layer safety net if validation here regresses.
  const { data: created, error: insErr } = await supabaseAdmin
    .from('properties')
    .insert({
      owner_id: auth.userId,
      name: v.name,
      total_rooms: v.totalRooms,
      timezone: v.timezone,
      pms_type: v.pmsType,
      brand: v.brand,
      property_kind: v.propertyKind,
      is_test: v.isTest,
      onboarding_source: 'admin',
    })
    .select('id, name, created_at')
    .single();

  if (insErr || !created) {
    console.error('[admin/properties/create] insert failed', { requestId, error: insErr });
    return err(
      `Failed to create property: ${insErr?.message ?? 'unknown error'}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }

  // Mint an owner-role join code so the admin has something to send the
  // hotel's actual owner. Try a few times in case of code collision.
  let joinCodeRow: { code: string; expires_at: string } | null = null;
  let codeErr: unknown = null;
  for (let i = 0; i < 5; i++) {
    const code = generateJoinCode(created.name);
    const expiresAt = new Date(Date.now() + OWNER_CODE_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const { data: ins, error: insertCodeErr } = await supabaseAdmin
      .from('hotel_join_codes')
      .insert({
        hotel_id: created.id,
        code,
        role: 'owner',
        expires_at: expiresAt,
        max_uses: OWNER_CODE_MAX_USES,
        created_by: auth.accountId,
      })
      .select('code, expires_at')
      .single();
    if (!insertCodeErr && ins) {
      joinCodeRow = ins;
      break;
    }
    codeErr = insertCodeErr;
    if (insertCodeErr && !String(insertCodeErr.message ?? '').toLowerCase().includes('duplicate')) break;
  }

  await writeAudit({
    action: 'property.create',
    actorUserId: auth.userId,
    actorEmail: auth.email ?? undefined,
    targetType: 'property',
    targetId: created.id,
    hotelId: created.id,
    metadata: {
      name: v.name,
      total_rooms: v.totalRooms,
      timezone: v.timezone,
      pms_type: v.pmsType,
      is_test: v.isTest,
      owner_email_invited: v.ownerEmail,
      join_code_minted: Boolean(joinCodeRow),
    },
  });

  if (!joinCodeRow) {
    console.error('[admin/properties/create] property created but join code failed', { requestId, propertyId: created.id, codeErr });
    return ok(
      {
        propertyId: created.id,
        joinCode: null,
        signupUrl: null,
        expiresAt: null,
        warning: 'Property created but join code generation failed — mint one via /admin/properties/' + created.id,
      },
      { requestId },
    );
  }

  // Build the signup URL. Use NEXT_PUBLIC_SITE_URL when available so
  // dev/preview/prod each generate links to themselves; fall back to the
  // production canonical (matches the smoke test convention).
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://getstaxis.com';
  const signupUrl = `${siteUrl}/signup?code=${encodeURIComponent(joinCodeRow.code)}`;

  return ok(
    {
      propertyId: created.id,
      joinCode: joinCodeRow.code,
      signupUrl,
      expiresAt: joinCodeRow.expires_at,
    },
    { requestId },
  );
}
