/**
 * GET  /api/settings/notifications?propertyId=…
 *   Returns the caller's report_preferences for a property, or default
 *   values if no row exists yet.
 *
 * PUT  /api/settings/notifications
 *   Body: {
 *     propertyId,
 *     deliveryTimeLocal: "HH:MM",     // optional
 *     channels: { email, sms },        // optional
 *     ccEmails: string[],              // optional (replaces)
 *     pausedUntil: string | null,      // optional ISO date or null to clear
 *     weeklyEnabled: boolean,          // optional
 *   }
 *   Upserts the row for (account_id, property_id).
 *
 * Auth: requireSession (the user editing their own preferences).
 * Property scope: caller must have property_access for the propertyId
 * (admins implicitly do).
 *
 * Why we expose CC editing through here: CC recipients are a per-user
 * setting, not per-property. Two managers at the same property can each
 * configure their own CC list.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid, isValidEmail } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_CC = 10;

interface PrefRow {
  account_id: string;
  property_id: string;
  delivery_time_local: string;
  channels: { email: boolean; sms: boolean };
  cc_emails: string[];
  paused_until: string | null;
  weekly_enabled: boolean;
}

const DEFAULTS: Omit<PrefRow, 'account_id' | 'property_id'> = {
  delivery_time_local: '20:00',
  channels: { email: true, sms: false },
  cc_emails: [],
  paused_until: null,
  weekly_enabled: true,
};

async function resolveCallerAccount(authUserId: string): Promise<{ id: string; property_access: string[]; role: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, property_access, role')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    property_access: Array.isArray(data.property_access) ? data.property_access : [],
    role: data.role,
  };
}

function callerCanManageProperty(account: { property_access: string[]; role: string }, propertyId: string): boolean {
  if (account.role === 'admin') return true;
  if (account.property_access.includes('*')) return true;
  return account.property_access.includes(propertyId);
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const propertyIdRaw = url.searchParams.get('propertyId');
  const pidV = validateUuid(propertyIdRaw, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const account = await resolveCallerAccount(session.userId);
  if (!account) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!callerCanManageProperty(account, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data, error: qErr } = await supabaseAdmin
    .from('report_preferences')
    .select('account_id, property_id, delivery_time_local, channels, cc_emails, paused_until, weekly_enabled')
    .eq('account_id', account.id)
    .eq('property_id', pidV.value!)
    .maybeSingle();
  if (qErr) {
    log.error('[settings/notifications:GET] query failed', { requestId, err: qErr.message });
    return err('Failed to load preferences', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  const row = data ?? { account_id: account.id, property_id: pidV.value!, ...DEFAULTS };
  return ok({
    preferences: {
      propertyId: row.property_id,
      deliveryTimeLocal: row.delivery_time_local,
      channels: row.channels,
      ccEmails: row.cc_emails ?? [],
      pausedUntil: row.paused_until,
      weeklyEnabled: row.weekly_enabled,
    },
  }, { requestId });
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => null) as {
    propertyId?: unknown;
    deliveryTimeLocal?: unknown;
    channels?: unknown;
    ccEmails?: unknown;
    pausedUntil?: unknown;
    weeklyEnabled?: unknown;
  } | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const account = await resolveCallerAccount(session.userId);
  if (!account) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!callerCanManageProperty(account, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Validate each optional field. Partial PUT — missing keys keep their
  // current value (or default if no row exists yet).
  const updates: Partial<PrefRow> = {};

  if (body.deliveryTimeLocal !== undefined) {
    if (typeof body.deliveryTimeLocal !== 'string' || !HHMM.test(body.deliveryTimeLocal)) {
      return err('deliveryTimeLocal must be HH:MM (24h)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    updates.delivery_time_local = body.deliveryTimeLocal;
  }

  if (body.channels !== undefined) {
    if (!body.channels || typeof body.channels !== 'object') {
      return err('channels must be { email, sms }', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const c = body.channels as { email?: unknown; sms?: unknown };
    if (typeof c.email !== 'boolean' || typeof c.sms !== 'boolean') {
      return err('channels.email and channels.sms must be booleans', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (!c.email && !c.sms) {
      return err('At least one channel must be enabled (otherwise pause delivery instead)', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    updates.channels = { email: c.email, sms: c.sms };
  }

  if (body.ccEmails !== undefined) {
    if (!Array.isArray(body.ccEmails)) {
      return err('ccEmails must be an array', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (body.ccEmails.length > MAX_CC) {
      return err(`Too many CC recipients (max ${MAX_CC})`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const cleaned: string[] = [];
    for (const raw of body.ccEmails) {
      if (typeof raw !== 'string') return err('Each CC email must be a string', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const trim = raw.trim().toLowerCase();
      if (!trim) continue;
      if (!isValidEmail(trim)) return err(`Invalid email: ${raw}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      if (!cleaned.includes(trim)) cleaned.push(trim);
    }
    updates.cc_emails = cleaned;
  }

  if (body.pausedUntil !== undefined) {
    if (body.pausedUntil === null) {
      updates.paused_until = null;
    } else if (typeof body.pausedUntil === 'string') {
      const ms = Date.parse(body.pausedUntil);
      if (!Number.isFinite(ms)) {
        return err('pausedUntil must be ISO date string or null', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      // Cap at +6 months — accidental "pause until 2099" caught here.
      const sixMonthsMs = 1000 * 60 * 60 * 24 * 180;
      if (ms - Date.now() > sixMonthsMs) {
        return err('pausedUntil cannot be more than 6 months in the future', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed,
        });
      }
      updates.paused_until = new Date(ms).toISOString();
    } else {
      return err('pausedUntil must be ISO date string or null', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
  }

  if (body.weeklyEnabled !== undefined) {
    if (typeof body.weeklyEnabled !== 'boolean') {
      return err('weeklyEnabled must be boolean', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    updates.weekly_enabled = body.weeklyEnabled;
  }

  // Upsert — if no row exists, this creates it with defaults filled in
  // from DEFAULTS for any keys the user didn't provide.
  const row: PrefRow = {
    account_id: account.id,
    property_id: pidV.value!,
    delivery_time_local: updates.delivery_time_local ?? DEFAULTS.delivery_time_local,
    channels: updates.channels ?? DEFAULTS.channels,
    cc_emails: updates.cc_emails ?? DEFAULTS.cc_emails,
    paused_until: updates.paused_until ?? DEFAULTS.paused_until,
    weekly_enabled: updates.weekly_enabled ?? DEFAULTS.weekly_enabled,
  };

  // Read existing row so we preserve any field the caller didn't touch
  // (the DEFAULTS fallback above only fires when there's no existing row).
  const { data: existing } = await supabaseAdmin
    .from('report_preferences')
    .select('delivery_time_local, channels, cc_emails, paused_until, weekly_enabled')
    .eq('account_id', account.id)
    .eq('property_id', pidV.value!)
    .maybeSingle();
  if (existing) {
    row.delivery_time_local = updates.delivery_time_local ?? existing.delivery_time_local;
    row.channels = updates.channels ?? existing.channels;
    row.cc_emails = updates.cc_emails ?? existing.cc_emails ?? [];
    row.paused_until = updates.paused_until !== undefined ? updates.paused_until : existing.paused_until;
    row.weekly_enabled = updates.weekly_enabled ?? existing.weekly_enabled;
  }

  const { error: upErr } = await supabaseAdmin
    .from('report_preferences')
    .upsert(
      { ...row, updated_at: new Date().toISOString() },
      { onConflict: 'account_id,property_id' },
    );
  if (upErr) {
    log.error('[settings/notifications:PUT] upsert failed', { requestId, err: upErr.message });
    return err('Failed to save preferences', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({
    preferences: {
      propertyId: row.property_id,
      deliveryTimeLocal: row.delivery_time_local,
      channels: row.channels,
      ccEmails: row.cc_emails,
      pausedUntil: row.paused_until,
      weeklyEnabled: row.weekly_enabled,
    },
  }, { requestId });
}
