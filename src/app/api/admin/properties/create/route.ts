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

import { NextRequest, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { triggerMlTraining } from '@/lib/ml-invoke';
import {
  generateJoinCode,
  OWNER_CODE_TTL_HOURS,
  OWNER_CODE_MAX_USES,
} from '@/lib/join-codes';
import { sendOnboardingInvite } from '@/lib/email/onboarding-invite';
import { DEFAULT_INVENTORY_ITEMS } from '@/lib/inventory/default-items';
import { validateRoomNumbers } from '@/lib/api-validate';
import { env } from '@/lib/env';

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
  // Phase M1.5 additions:
  inviteRole?: unknown;  // 'owner' | 'general_manager' (default 'owner')
  sendEmail?: unknown;   // boolean (default false). Requires ownerEmail.
  // Round 15 follow-up: capture the master room list at creation time so
  // phantom-seed has something to work with from day 1. Optional —
  // omitted means inventory stays empty and the doctor warns until
  // it's populated (e.g., via PMS sync).
  roomNumbers?: unknown;
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
    inviteRole: 'owner' | 'general_manager';
    sendEmail: boolean;
    roomNumbers: string[];  // [] when omitted
  };
}

// Phase M1.5: only owner + general_manager can be invited via this
// admin flow. Staff roles (front_desk/housekeeping/maintenance) come
// in via the staff-side join codes minted later from the per-property
// admin page, not at hotel creation.
const INVITE_ROLES = new Set(['owner', 'general_manager']);

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

  // Phase M1.5: invite role and send-email flag
  let inviteRole: 'owner' | 'general_manager' = 'owner';
  if (body.inviteRole !== undefined && body.inviteRole !== null && body.inviteRole !== '') {
    if (typeof body.inviteRole !== 'string' || !INVITE_ROLES.has(body.inviteRole)) {
      return {
        ok: false,
        reason: `inviteRole must be one of: ${Array.from(INVITE_ROLES).join(', ')} (got: ${String(body.inviteRole)})`,
      };
    }
    inviteRole = body.inviteRole as 'owner' | 'general_manager';
  }

  const sendEmail = body.sendEmail === true;
  if (sendEmail && !ownerEmail) {
    return { ok: false, reason: 'sendEmail=true requires ownerEmail' };
  }

  // Room numbers — optional. If provided, must be an array of strings
  // and the length must equal totalRooms (otherwise INV-24 would fire
  // the moment the row lands; better to reject at the API).
  let roomNumbers: string[] = [];
  if (body.roomNumbers !== undefined && body.roomNumbers !== null) {
    const r = validateRoomNumbers(body.roomNumbers, { label: 'roomNumbers' });
    if (r.error) return { ok: false, reason: r.error };
    roomNumbers = r.value!;
    if (roomNumbers.length > 0 && roomNumbers.length !== body.totalRooms) {
      return {
        ok: false,
        reason: `roomNumbers count (${roomNumbers.length}) must match totalRooms (${body.totalRooms}). ` +
                `Either fix the list or change totalRooms.`,
      };
    }
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
      inviteRole,
      sendEmail,
      roomNumbers,
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
      // Round 15 follow-up: when the admin provided a room list, write it
      // here so phantom-seed can run from day 1. Migration 0125's trigger
      // re-derives total_rooms from this if non-empty (defense against
      // a typed totalRooms ≠ list-length mismatch); the API validation
      // above already enforces equality, so the trigger normally no-ops.
      // Empty array means "capture later" (e.g., via PMS sync); the
      // doctor warns in that state.
      ...(v.roomNumbers.length > 0 ? { room_inventory: v.roomNumbers } : {}),
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

  // Phase M1.5: seed the 16 default inventory items immediately so the
  // wizard can confidently say "your inventory is set up" at Step 9 and
  // ML cold-start training can begin as soon as the first count event
  // arrives (instead of waiting for the owner to open the inventory
  // page once to trigger the auto-seed). Idempotent — the unique index
  // (property_id, lower(name)) makes re-running this a no-op.
  //
  // Best-effort: a failure here doesn't roll back the property. The
  // inventory page's existing client-side seed (page.tsx:38) is the
  // backstop — if the server-side seed flakes, the owner gets the same
  // items the next time they open the page.
  try {
    const inventoryRows = DEFAULT_INVENTORY_ITEMS.map((item) => ({
      property_id: created.id,
      name: item.name,
      category: item.category,
      current_stock: item.currentStock,
      par_level: item.parLevel,
      unit: item.unit,
    }));
    const { error: seedErr } = await supabaseAdmin
      .from('inventory')
      .insert(inventoryRows);
    if (seedErr && !String(seedErr.message ?? '').toLowerCase().includes('duplicate')) {
      // Non-duplicate errors are real; log them so ops can investigate.
      console.error('[admin/properties/create] inventory seed failed (non-fatal)', {
        requestId, propertyId: created.id, error: seedErr.message,
      });
    }
  } catch (e) {
    console.error('[admin/properties/create] inventory seed threw (non-fatal)', {
      requestId, propertyId: created.id, error: e instanceof Error ? e.message : String(e),
    });
  }

  // Phase M3.1 (2026-05-14): trigger demand+supply cold-start ML training
  // for the new property AFTER response is sent. Matches the wizard finalize
  // hook so admin-created hotels also get instant Day-1 predictions instead
  // of waiting for the next weekly training cron (Sunday 03:00 CT).
  //
  // Fire-and-forget via next/server's after() — Next.js holds the function
  // alive past the response so this completes (vs raw fire-and-forget where
  // Vercel may freeze before the fetch resolves). Failures are non-fatal:
  // the daily aggregator + weekly cron remain the safety nets.
  after(async () => {
    const propertyId = created.id;
    try {
      const results = await Promise.allSettled([
        triggerMlTraining(propertyId, 'demand', { requestId }),
        triggerMlTraining(propertyId, 'supply', { requestId }),
      ]);
      log.info('admin_create_ml_kick', {
        requestId,
        pid: propertyId,
        demandStatus: results[0].status === 'fulfilled' ? results[0].value.status : 'rejected',
        supplyStatus: results[1].status === 'fulfilled' ? results[1].value.status : 'rejected',
      });
    } catch (e) {
      // Should be unreachable — triggerMlTraining never throws — but
      // belt-and-suspenders for after() context.
      console.error('[admin/properties/create] ML kick threw (non-fatal)', {
        requestId, propertyId, error: e instanceof Error ? e.message : String(e),
      });
    }
  });

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
        role: v.inviteRole,  // Phase M1.5: 'owner' | 'general_manager'
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
      room_inventory_count: v.roomNumbers.length,
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
  // Phase M1.5: changed path from /signup to /onboard — the new unified
  // wizard. Old /signup URLs still work via the redirect added in
  // Commit 8.
  const siteUrl = env.NEXT_PUBLIC_APP_URL ?? 'https://getstaxis.com';
  const signupUrl = `${siteUrl}/onboard?code=${encodeURIComponent(joinCodeRow.code)}`;

  // Phase M1.5: optional Resend email send. Failure is NEVER fatal —
  // the signup URL is still in the response body so the admin can
  // copy/paste as a fallback.
  let emailSent = false;
  let emailError: string | null = null;
  if (v.sendEmail && v.ownerEmail) {
    const emailResult = await sendOnboardingInvite({
      to: v.ownerEmail,
      hotelName: v.name,
      signupUrl,
      inviteRole: v.inviteRole,
      expiresAt: joinCodeRow.expires_at,
      auditContext: {
        actorUserId: auth.userId,
        actorEmail: auth.email ?? undefined,
        targetType: 'property',
        targetId: created.id,
        hotelId: created.id,
      },
    });
    if (emailResult.ok) {
      emailSent = true;
    } else {
      emailError = emailResult.error;
      console.warn('[admin/properties/create] email send failed (non-fatal)', {
        requestId, propertyId: created.id, error: emailResult.error,
      });
    }
  }

  return ok(
    {
      propertyId: created.id,
      joinCode: joinCodeRow.code,
      signupUrl,
      expiresAt: joinCodeRow.expires_at,
      emailSent,
      emailError,
      inviteRole: v.inviteRole,
    },
    { requestId },
  );
}
