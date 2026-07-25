/**
 * GET  /api/housekeeping/setup?propertyId=…
 *   Returns this hotel's answers to the one-time Housekeeping questionnaire —
 *   or `setup: null` when nobody has finished it yet, which is the signal the
 *   Housekeeping section uses to show the questionnaire instead of the page.
 *   Also returns the prefill values the first screen needs (`defaults`) and
 *   `canEdit` (management roles only), so the UI never has to guess either.
 *
 * PUT  /api/housekeeping/setup
 *   Body: { propertyId, setup }
 *   Validates the whole submission with validateSetupSubmission (the SAME
 *   validator the questionnaire screens use — client and server can never
 *   disagree about what a valid answer is), stores it on
 *   `properties.housekeeping_setup` (migration 0337), then re-reads and echoes
 *   the canonical persisted state.
 *
 * WHY supabaseAdmin AND NOT THE BROWSER CLIENT
 * --------------------------------------------
 * Browser UPDATE on `properties` is admin-only at the RLS layer. A general
 * manager writing through the anon client gets a silent 200 with 0 rows
 * updated — the questionnaire would look saved and then re-appear on the next
 * visit, forever. Every write here goes through the service-role client. Same
 * reasoning as /api/inventory/property-config.
 *
 * Auth: sessionGate. Reads require property access; WRITES additionally require
 * BOTH a management role (admin / owner / general manager) AND the
 * `manage_clean_times` capability.
 *
 * Both halves are load-bearing, and neither alone is enough:
 *   • `manage_clean_times` carries no `defaultRoles` in the capability registry,
 *     so by default EVERY hotel role has it — front desk, housekeeping,
 *     maintenance. On its own it would let a housekeeper set the hotel's
 *     adoption level and rewrite the standard room minutes that the whole
 *     earned-hours-vs-paid-hours calculation rests on.
 *   • The role check alone would ignore an admin who deliberately restricted
 *     clean-time editing for a role at one hotel.
 * The page gate (src/app/housekeeping/page.tsx) applies the SAME pair, so the
 * questionnaire is never shown to someone whose save would then 403.
 *
 * The answers are not left inert: `checkoutMinutes` / `stayoverMinutes` are
 * written through to `hk_clean_time_standards` (cleaning_type departure /
 * stayover, room_type NULL = all rooms), which is what the board, the timeline
 * and the labor-cost math actually read. See the write-through block below for
 * why that step is deliberately non-fatal.
 *
 * CUSTOM ROOM TYPES ARE STORED BUT NOT WIRED UP — READ THIS BEFORE ASSUMING
 * OTHERWISE
 * ---------------------------------------------------------------------------
 * Q2 lets a hotel add its own room types ("Suite", "Extended stay") with their
 * own minutes. Those are persisted in the jsonb blob and NOTHING ELSE. They are
 * NOT written to `hk_clean_time_standards`, which means they do not currently
 * affect the board, the timeline, auto-assign, or any earned-hours number.
 *
 * Why not, concretely: `hk_clean_time_standards.cleaning_type` is a text column
 * under a CHECK constraint listing exactly seven values (migration 0244), and
 * `upsertCleanTimeStandards` re-checks the same seven before writing. A hotel's
 * free-text label is not one of them and cannot become one without a migration
 * plus a constraint change. The table's other dimension, `room_type`, is
 * nullable free text and would physically accept "Suite" — but it means "this
 * minute count applies when a room of THIS type gets THAT cleaning_type", so
 * writing there would force us to guess which of the seven cleaning types the
 * hotel meant. A label like "Deep clean" is a cleaning type; "Suite" is a room
 * type; "Extended stay studio" could be either. Guessing wrong would silently
 * shift a real property's workload math, which is exactly the class of quiet
 * wrongness this feature is meant to avoid.
 *
 * So: stored honestly, used by nothing yet, and said out loud here rather than
 * dropped in silence. Wiring them up is a separate piece of work that needs a
 * migration and a decision about what a custom label actually means. Until then
 * anything reading `setup.customRoomTypes` must treat it as the hotel's stated
 * intent, not as live input to any calculation.
 *
 * `customDuties` is the same: a label with no minutes model behind it, stored
 * so later screens know time goes there, wired to nothing.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, sessionGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { canManageTeam, isValidRole, type AppRole } from '@/lib/roles';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { upsertCleanTimeStandards } from '@/lib/clean-time-standards-server';
import {
  parseHousekeepingSetup,
  isHousekeepingSetupComplete,
  validateSetupSubmission,
  DEFAULT_CHECKOUT_MINUTES,
  DEFAULT_STAYOVER_MINUTES,
  DEFAULT_SHIFT_START,
  // Aliased on purpose: src/lib/clean-time-standards.ts exports the same two
  // NAMES with a different floor (1 vs 5). Nothing in this file imports those,
  // but the alias keeps it obvious which bounds these are.
  MIN_CLEAN_MINUTES as HK_MIN_CLEAN_MINUTES,
  MAX_CLEAN_MINUTES as HK_MAX_CLEAN_MINUTES,
  type HousekeepingSetup,
} from '@/lib/housekeeping/setup-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Prefill values for the questionnaire screens. Mirrors clean-times' `defaults`. */
const SETUP_DEFAULTS = {
  checkoutMinutes: DEFAULT_CHECKOUT_MINUTES,
  stayoverMinutes: DEFAULT_STAYOVER_MINUTES,
  shiftStartTime: DEFAULT_SHIFT_START,
  minMinutes: HK_MIN_CLEAN_MINUTES,
  maxMinutes: HK_MAX_CLEAN_MINUTES,
} as const;

interface CallerAccount {
  id: string;
  property_access: string[];
  role: AppRole;
}

async function resolveCallerAccount(authUserId: string): Promise<CallerAccount | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, property_access, role')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    property_access: Array.isArray(data.property_access) ? data.property_access : [],
    role: (isValidRole(data.role) ? data.role : 'staff') as AppRole,
  };
}

function callerHasPropertyAccess(account: CallerAccount, propertyId: string): boolean {
  if (account.role === 'admin') return true;
  if (account.property_access.includes('*')) return true;
  return account.property_access.includes(propertyId);
}

/** Distinguishes "0337 isn't applied in this environment yet" from a real error. */
function isMissingColumnError(e: { code?: string | null; message?: string | null } | null): boolean {
  if (!e) return false;
  // 42703 = undefined_column (direct PG); PGRST204 = PostgREST's cached-schema
  // miss on a column it doesn't know about yet.
  if (e.code === '42703' || e.code === 'PGRST204') return true;
  return /housekeeping_setup/.test(e.message ?? '') && /column|schema/i.test(e.message ?? '');
}

type ReadResult =
  | { ok: true; found: boolean; setup: HousekeepingSetup | null }
  | { ok: false };

/**
 * Read + parse the stored blob.
 *
 * `setup` is non-null ONLY when the questionnaire is actually finished, which
 * is the contract the Housekeeping gate depends on: null means "ask the six
 * questions". A half-written blob (no completedAt) reads as null for exactly
 * that reason — see isHousekeepingSetupComplete.
 *
 * Migrations are applied by hand in this project, so the column may not exist
 * yet in a given environment. That degrades to "questionnaire not done" rather
 * than a 500 — the same graceful-pre-migration behaviour as
 * fetchCleanTimeStandards.
 */
async function readSetup(propertyId: string, requestId: string): Promise<ReadResult> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('housekeeping_setup')
    .eq('id', propertyId)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error)) {
      log.warn('[housekeeping/setup] housekeeping_setup column missing — migration 0337 not applied here', {
        requestId, propertyId,
      });
      return { ok: true, found: true, setup: null };
    }
    log.error('[housekeeping/setup] read failed', { requestId, propertyId, msg: error.message });
    return { ok: false };
  }
  if (!data) return { ok: true, found: false, setup: null };

  const raw = (data as { housekeeping_setup?: unknown }).housekeeping_setup;
  return {
    ok: true,
    found: true,
    setup: isHousekeepingSetupComplete(raw) ? parseHousekeepingSetup(raw) : null,
  };
}

export const GET = defineRoute({
  resolve: (req) => sessionGate(req),
  handler: async (ctx) => {
    const url = new URL(ctx.req.url);
    const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    const propertyId = pidV.value!;

    const account = await resolveCallerAccount(ctx.userId);
    if (!account) return ctx.err('Account not found', { status: 404, code: ApiErrorCode.NotFound });
    if (!callerHasPropertyAccess(account, propertyId)) {
      return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });
    }

    const read = await readSetup(propertyId, ctx.requestId);
    if (!read.ok) {
      return ctx.err('Failed to read housekeeping setup', {
        status: 500, code: ApiErrorCode.InternalError,
      });
    }
    if (!read.found) {
      return ctx.err('Property not found', { status: 404, code: ApiErrorCode.NotFound });
    }

    const capabilityDecision = await capabilityDecisionForProperty(
      { role: account.role },
      'manage_clean_times',
      propertyId,
    );
    if (capabilityDecision === 'unavailable') {
      return capabilityUnavailableResponse(ctx.requestId);
    }

    return ctx.ok({
      setup: read.setup,
      defaults: SETUP_DEFAULTS,
      // Exactly the predicate PUT enforces — see the header.
      canEdit: capabilityDecision === 'allowed' && canManageTeam(account.role),
    });
  },
});

export const PUT = defineRoute({
  resolve: (req) => sessionGate(req),
  handler: async (ctx) => {
    const body = (await ctx.req.json().catch(() => null)) as {
      propertyId?: unknown;
      setup?: unknown;
    } | null;
    if (!body) return ctx.err('Invalid JSON body', { status: 400, code: ApiErrorCode.ValidationFailed });

    const pidV = validateUuid(body.propertyId, 'propertyId');
    if (pidV.error) return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    const propertyId = pidV.value!;

    const account = await resolveCallerAccount(ctx.userId);
    if (!account) return ctx.err('Account not found', { status: 404, code: ApiErrorCode.NotFound });
    if (!callerHasPropertyAccess(account, propertyId)) {
      return ctx.err('Forbidden', { status: 403, code: ApiErrorCode.Forbidden });
    }

    // Management role AND the capability — see the header for why both.
    if (!canManageTeam(account.role)) {
      return ctx.err('Only managers can set up housekeeping', {
        status: 403, code: ApiErrorCode.Forbidden,
      });
    }
    const capabilityDecision = await capabilityDecisionForProperty(
      { role: account.role },
      'manage_clean_times',
      propertyId,
    );
    if (capabilityDecision === 'unavailable') {
      return capabilityUnavailableResponse(ctx.requestId);
    }
    if (capabilityDecision === 'denied') {
      return ctx.err('Only managers can set up housekeeping', {
        status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Strict validation. The module rejects with a message naming the offending
    // field, and returns a fully normalized value that is safe to persist
    // verbatim — including `completedAt`, which it stamps itself.
    const validated = validateSetupSubmission(body.setup);
    if ('error' in validated) {
      return ctx.err(validated.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    // NEVER trust a client-supplied timestamp for "when did this hotel finish
    // setup" — it is the field the gate keys on, and a wrong/forged value would
    // either re-ask forever or mark an unfinished hotel as done. Stamp it here,
    // from the server clock, overriding whatever came in.
    // The board photo path is client-supplied and the validator only checks that
    // it is a short string. Every path this route's own uploader mints starts
    // with `{propertyId}/`, so anything else is either a bug or an attempt to
    // point one hotel's setup at another hotel's file. Dropped rather than
    // rejected: the photo is an optional extra, and 400-ing a submission the
    // manager cannot possibly fix would strand them on the last screen.
    let boardPhotoPath = validated.value.boardPhotoPath;
    if (boardPhotoPath !== null && !boardPhotoPath.startsWith(`${propertyId}/`)) {
      log.warn('[housekeeping/setup:PUT] dropping board photo path from another property', {
        requestId: ctx.requestId, propertyId,
      });
      boardPhotoPath = null;
    }

    const setup: HousekeepingSetup = {
      ...validated.value,
      boardPhotoPath,
      completedAt: new Date().toISOString(),
    };

    // `.select('id')` is not decoration: PostgREST answers 200 with zero rows
    // when nothing matched, so without it a write against a property that does
    // not exist would report success, the client would call onComplete(), and
    // the questionnaire would re-appear on every visit forever with no error
    // ever shown. Same guard as /api/inventory/property-config.
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('properties')
      .update({ housekeeping_setup: setup })
      .eq('id', propertyId)
      .select('id');

    if (updateErr) {
      if (isMissingColumnError(updateErr)) {
        log.error('[housekeeping/setup:PUT] housekeeping_setup column missing — apply migration 0337', {
          requestId: ctx.requestId, propertyId,
        });
        return ctx.err('Housekeeping setup storage is not ready yet', {
          status: 503, code: ApiErrorCode.UpstreamFailure,
        });
      }
      log.error('[housekeeping/setup:PUT] update failed', {
        requestId: ctx.requestId, propertyId, msg: updateErr.message,
      });
      return ctx.err('Failed to save housekeeping setup', {
        status: 500, code: ApiErrorCode.InternalError,
      });
    }
    if (!Array.isArray(updated) || updated.length === 0) {
      log.error('[housekeeping/setup:PUT] update matched no property row', {
        requestId: ctx.requestId, propertyId,
      });
      return ctx.err('Property not found', { status: 404, code: ApiErrorCode.NotFound });
    }

    // ── Write the two room times through to the table that actually drives
    //    behaviour ────────────────────────────────────────────────────────
    // Without this the questionnaire's most consequential answer would sit
    // inert in a jsonb blob while the board, the timeline and the earned-hours
    // math kept using the old standards. departure = "checkout", stayover =
    // "stayover"; room_type NULL means "all rooms".
    //
    // ONLY these two. `setup.customRoomTypes` is deliberately NOT synced here —
    // its labels are free text and this table's `cleaning_type` is a
    // CHECK-constrained enum, so there is no correct row to write without a
    // migration and a decision about what a custom label means. Full reasoning
    // in the file header. Do not "fix" this by writing the label into
    // `room_type`: that column pairs a room with one of the seven known
    // cleaning types, so it would silently guess which type the hotel meant.
    //
    // DELIBERATELY NON-FATAL: the questionnaire completing is what unblocks the
    // whole Housekeeping section, and it is already committed above. Failing the
    // request here would leave the hotel with a saved setup AND an error screen,
    // and a retry would just re-save the same setup. So we log loudly and keep
    // going; the manager can change the two numbers any time in Settings →
    // cleaning times, and the response says whether the sync landed.
    let cleanTimesSynced = true;
    try {
      const sync = await upsertCleanTimeStandards(
        propertyId,
        [
          { cleaning_type: 'departure', base_minutes: setup.checkoutMinutes },
          { cleaning_type: 'stayover', base_minutes: setup.stayoverMinutes },
        ],
        account.id,
      );
      if (!sync.ok) {
        cleanTimesSynced = false;
        log.error('[housekeeping/setup:PUT] clean-time write-through failed (setup still saved)', {
          requestId: ctx.requestId, propertyId, err: sync.error,
        });
      }
    } catch (e) {
      cleanTimesSynced = false;
      log.error('[housekeeping/setup:PUT] clean-time write-through threw (setup still saved)', {
        requestId: ctx.requestId,
        propertyId,
        err: e instanceof Error ? e : new Error(String(e)),
      });
    }

    // Echo the canonical persisted state — re-read rather than returning what we
    // just built, so the client reflects the row exactly (including a concurrent
    // edit from another manager).
    const read = await readSetup(propertyId, ctx.requestId);
    return ctx.ok({
      setup: read.ok ? read.setup : setup,
      defaults: SETUP_DEFAULTS,
      canEdit: true,
      cleanTimesSynced,
    });
  },
});
