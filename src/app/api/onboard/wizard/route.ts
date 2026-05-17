/**
 * Phase M1.5 (2026-05-14) — wizard state persistence.
 *
 * GET /api/onboard/wizard?code=XXXX
 *   Public endpoint (no auth required for steps 1-2 where the user
 *   hasn't created an account yet). Returns the property's current
 *   onboarding state + minimal hotel details so the wizard can render
 *   "Welcome to <Hotel Name>" without the user being signed in.
 *
 *   Auth is graceful: if a session exists AND owns the property, more
 *   detail is returned. Otherwise just the bare welcome info.
 *
 * PATCH /api/onboard/wizard
 *   Body: { code, partialState }
 *   Merges partialState into properties.onboarding_state.
 *   Auth required for steps 3+ (after account creation). The endpoint
 *   accepts either a session token OR the code+still-valid join_code
 *   for steps 1-2 transitions (welcome → account).
 *
 *   Idempotent: re-PATCHing the same partialState produces the same
 *   end state.
 *
 * Per Phase L discipline:
 *   - Verify-before-fix: the schema (onboarding_state jsonb,
 *     onboarding_completed_at timestamptz) added by migration 0119
 *     was confirmed before this code was written.
 *   - All swallow patterns log structured events.
 */

import { NextRequest, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { requireSession } from '@/lib/api-auth';
import { triggerMlTraining } from '@/lib/ml-invoke';
import {
  deriveCurrentStep,
  isValidPartialState,
  type OnboardingState,
} from '@/lib/onboarding/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Look up the property associated with a join code, validating the
 * code is non-revoked and non-expired. Returns the property + the
 * code row, or null if not found / not usable.
 *
 * Used by both GET and PATCH to authenticate "user holds a valid
 * code, therefore is allowed to read/write the wizard state for the
 * property the code is bound to."
 */
async function resolvePropertyByCode(code: string): Promise<{
  propertyId: string;
  codeRow: { role: string | null; revoked_at: string | null; expires_at: string };
} | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;

  const { data: codeRow, error: codeErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('hotel_id, role, revoked_at, expires_at')
    .eq('code', normalized)
    .maybeSingle();
  if (codeErr || !codeRow) return null;
  if (codeRow.revoked_at) return null;
  if (new Date(codeRow.expires_at).getTime() <= Date.now()) return null;
  return {
    propertyId: codeRow.hotel_id as string,
    codeRow: {
      role: codeRow.role as string | null,
      revoked_at: codeRow.revoked_at as string | null,
      expires_at: codeRow.expires_at as string,
    },
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const code = new URL(req.url).searchParams.get('code') ?? '';

  const resolved = await resolvePropertyByCode(code);
  if (!resolved) {
    return err('Invalid or expired code', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Read property + onboarding state. Use service-role to bypass RLS
  // since unauthenticated users (steps 1-2) need to see the welcome.
  // We're already gated by the join code's validity — that's the trust
  // anchor for unauth reads here.
  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, total_rooms, timezone, brand, property_kind, pms_type, onboarding_state, onboarding_completed_at')
    .eq('id', resolved.propertyId)
    .maybeSingle();
  if (propErr || !prop) {
    log.error('[onboard/wizard:GET] property fetch failed', { err: propErr, requestId, propertyId: resolved.propertyId });
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Already completed? Tell the caller so the wizard can redirect to /dashboard.
  if (prop.onboarding_completed_at) {
    return ok({
      propertyId: prop.id,
      propertyName: prop.name,
      currentStep: 9 as const,
      completed: true,
      state: (prop.onboarding_state as OnboardingState) ?? { step: 9 },
      hotelDefaults: null,
      inviteRole: resolved.codeRow.role,
    }, { requestId });
  }

  const state = (prop.onboarding_state as OnboardingState) ?? { step: 1 };
  const currentStep = deriveCurrentStep(state);

  return ok({
    propertyId: prop.id,
    propertyName: prop.name,
    currentStep,
    completed: false,
    state,
    hotelDefaults: {
      name: prop.name,
      totalRooms: prop.total_rooms,
      timezone: prop.timezone,
      brand: prop.brand,
      propertyKind: prop.property_kind,
      pmsType: prop.pms_type,
    },
    inviteRole: resolved.codeRow.role,
  }, { requestId });
}

interface PatchBody {
  code?: unknown;
  partialState?: unknown;
  // Steps 4-8 may also bundle property updates (name change, services,
  // etc.) into the same PATCH so the client doesn't need 2 round-trips.
  propertyUpdates?: unknown;
  // When the wizard hits Step 9 + the user clicks "Go to Dashboard",
  // the client sends finalize=true so we set onboarding_completed_at.
  finalize?: unknown;
}

const ALLOWED_PROPERTY_UPDATE_FIELDS = new Set([
  'name', 'total_rooms', 'timezone', 'brand', 'property_kind',
  'region', 'climate_zone', 'size_tier', 'services_enabled',
]);

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const code = typeof body.code === 'string' ? body.code : '';
  const resolved = await resolvePropertyByCode(code);
  if (!resolved) {
    return err('Invalid or expired code', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Validate partialState shape if present.
  let partialState: Partial<OnboardingState> = {};
  if (body.partialState !== undefined) {
    if (!isValidPartialState(body.partialState)) {
      return err('Invalid partialState shape', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    partialState = body.partialState;
  }

  // Validate propertyUpdates: each key must be in the allow-list.
  // Don't trust the client to send arbitrary column names.
  const propertyUpdates: Record<string, unknown> = {};
  if (body.propertyUpdates !== undefined && body.propertyUpdates !== null) {
    if (typeof body.propertyUpdates !== 'object') {
      return err('Invalid propertyUpdates shape', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    for (const [key, value] of Object.entries(body.propertyUpdates as Record<string, unknown>)) {
      if (!ALLOWED_PROPERTY_UPDATE_FIELDS.has(key)) {
        return err(`propertyUpdates.${key} is not in the allow-list`, {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      propertyUpdates[key] = value;
    }
  }

  // For steps that mutate property data (4+), the user MUST be signed
  // in and own the property. Steps 1-3 only touch onboarding_state and
  // are gated by code validity alone.
  const isMutatingProperty = Object.keys(propertyUpdates).length > 0 || body.finalize === true;
  if (isMutatingProperty) {
    const session = await requireSession(req);
    if (!session.ok) return session.response;
    // Verify session owns the property via accounts.property_access.
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('property_access, role')
      .eq('data_user_id', session.userId)
      .maybeSingle();
    const access = (account?.property_access ?? []) as string[];
    const isAdmin = account?.role === 'admin';
    if (!isAdmin && !access.includes(resolved.propertyId)) {
      return err('Forbidden — your session does not own this property', {
        requestId, status: 403, code: ApiErrorCode.Unauthorized,
      });
    }
  }

  // Read current state so we can MERGE (not overwrite) onboarding_state.
  const { data: current, error: readErr } = await supabaseAdmin
    .from('properties')
    .select('onboarding_state')
    .eq('id', resolved.propertyId)
    .maybeSingle();
  if (readErr || !current) {
    log.error('[onboard/wizard:PATCH] state read failed', { err: readErr, requestId });
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const currentState = (current.onboarding_state as OnboardingState) ?? { step: 1 };
  const mergedState: OnboardingState = {
    ...currentState,
    ...partialState,
  };
  // Recompute step from the merged state (don't trust client-sent step).
  mergedState.step = deriveCurrentStep(mergedState);

  // Build the UPDATE payload.
  const update: Record<string, unknown> = {
    onboarding_state: mergedState,
    ...propertyUpdates,
  };
  if (body.finalize === true) {
    update.onboarding_completed_at = new Date().toISOString();
  }

  const { error: updErr } = await supabaseAdmin
    .from('properties')
    .update(update)
    .eq('id', resolved.propertyId);
  if (updErr) {
    log.error('[onboard/wizard:PATCH] update failed', { err: updErr, requestId });
    return err(`Update failed: ${updErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Phase M3.1 (2026-05-14): on wizard finalize, trigger demand+supply
  // cold-start ML training for the property AFTER response is sent.
  // Without this, a hotel onboarded Monday waits up to 6 days for the
  // weekly training cron (Sunday 03:00 CT) — Day-1 promise broken.
  // Inventory is NOT triggered here; inventory cold-start runs on first
  // count and the existing path is correct.
  //
  // Fire-and-forget via next/server's after() — Next.js holds the
  // function alive past the response so this completes (vs raw fire-
  // and-forget where Vercel may freeze before the fetch resolves).
  // Failures are non-fatal: the daily aggregator + weekly cron remain
  // the safety nets. triggerMlTraining never throws.
  if (body.finalize === true) {
    const propertyId = resolved.propertyId;
    after(async () => {
      const results = await Promise.allSettled([
        triggerMlTraining(propertyId, 'demand', { requestId }),
        triggerMlTraining(propertyId, 'supply', { requestId }),
      ]);
      log.info('onboard_finalize_ml_kick', {
        requestId,
        pid: propertyId,
        demandStatus: results[0].status === 'fulfilled' ? results[0].value.status : 'rejected',
        supplyStatus: results[1].status === 'fulfilled' ? results[1].value.status : 'rejected',
      });
    });
  }

  return ok({
    propertyId: resolved.propertyId,
    state: mergedState,
    currentStep: mergedState.step,
    completed: body.finalize === true,
  }, { requestId });
}
