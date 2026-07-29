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
 *      The guarded one-shot owner claim later replaces that placeholder; a GM
 *      claim receives hotel access but does not become owner of record.
 *   3. Mints an owner/GM onboarding code through the DB-guarded platform-
 *      admin RPC (single-use, 7-day TTL, exact unclaimed hotel).
 *   4. Writes an audit row.
 *
 * Returns: { propertyId, joinCode, signupUrl, expiresAt }
 *
 * Discipline:
 *   - All validation runs server-side. Client-side checks are advisory only.
 *   - Timezone validated via Intl.DateTimeFormat (same mechanism as
 *     ml-service's require_property_timezone after Phase L). Phase K's
 *     CHECK (total_rooms > 0) catches a bypass at the DB layer too.
 *   - If join-code minting fails, the property still exists but no broad
 *     staff-code endpoint is used as a fallback. The response is explicit so
 *     platform operations can retry/repair the guarded bootstrap only.
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

  // Insert property. owner_id = the admin creating it, as the exact bootstrap
  // placeholder 0396 requires until the one-shot owner claim succeeds. Phase
  // K's CHECK (total_rooms > 0) is the DB-layer safety net if validation here
  // regresses.
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

  // Mint the one-shot owner/GM bootstrap credential through the database
  // guard. 0396 locks the property, rechecks this exact live platform-admin
  // identity, proves the hotel is still unclaimed/incomplete, and owns the
  // one-use/seven-day bounds. A direct service-role INSERT is deliberately
  // rejected by the trigger.
  let joinCodeRow: { code: string; expires_at: string } | null = null;
  let codeErr: unknown = null;
  for (let i = 0; i < 5; i++) {
    const code = generateJoinCode(created.name);
    const { data, error: mintError } = await supabaseAdmin.rpc(
      'staxis_mint_privileged_onboarding_join_code',
      {
        p_actor_account_id: auth.accountId,
        p_actor_auth_user_id: auth.userId,
        p_hotel_id: created.id,
        p_code: code,
        p_role: v.inviteRole,
        p_request_id: requestId,
      },
    );
    const mint = data as {
      ok?: boolean;
      status?: string;
      code?: string;
      expiresAt?: string;
    } | null;
    if (!mintError && mint?.ok === true && mint.code && mint.expiresAt) {
      joinCodeRow = { code: mint.code, expires_at: mint.expiresAt };
      break;
    }
    codeErr = mintError ?? new Error(`privileged join-code mint returned ${mint?.status ?? 'invalid response'}`);
    if (mint?.status !== 'code_collision') break;
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
        warning: 'Property created, but its guarded onboarding invite could not be minted. Retry from platform administration before assigning the hotel.',
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
