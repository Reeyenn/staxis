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
import { env } from '@/lib/env';
import { PLACEHOLDER_HOTEL_NAME } from '@/lib/onboarding/state';
import {
  validateBody,
  type CreateBody,
} from '@/lib/admin-property-create-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
      // Empty array means "capture later" (e.g., via PMS sync).
      ...(v.roomNumbers.length > 0 ? { room_inventory: v.roomNumbers } : {}),
    })
    .select('id, name, created_at')
    .single();

  if (insErr || !created) {
    log.error('[admin/properties/create] insert failed', { requestId, msg: insErr?.message ?? String(insErr) });
    return err(
      `Failed to create property: ${insErr?.message ?? 'unknown error'}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }

  // Deliberately NO preset inventory (2026-07-09, Reeyen): new hotels start
  // with an empty inventory list — owners add their own items. The old Phase
  // M1.5 seed of 16 default items lived here; removing it means inventory ML
  // cold-start simply waits for the first real items/counts, which is fine.

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
      log.error('[admin/properties/create] ML kick threw (non-fatal)', {
        requestId, propertyId, msg: e instanceof Error ? e.message : String(e),
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
    log.error('[admin/properties/create] property created but join code failed', {
      requestId, propertyId: created.id, msg: codeErr instanceof Error ? codeErr.message : String(codeErr),
    });
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
      // The lean flow doesn't collect a hotel name up front — keep the
      // invite email reading naturally ("set up your hotel") until the
      // owner names it in the wizard.
      hotelName: v.name === PLACEHOLDER_HOTEL_NAME ? 'your hotel' : v.name,
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
