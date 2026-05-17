/**
 * /api/inventory/check-alerts — fire SMS alerts for newly-critical items.
 *
 * Why server-side: Twilio credentials are server-only. The browser shouldn't
 * touch them, and the inventory page can't import sendSms anyway because
 * sms.ts reads process.env. Inventory page POSTs here after a count save
 * with the (pid, itemIds) it knows just hit critical, and this route does
 * the dedupe + Twilio dispatch.
 *
 * Capability check: pid must exist + we read property + items via service
 * role. Same trust model as the housekeeper public-page routes.
 *
 * Dedupe: each item has a last_alerted_at timestamp. Skip if alerted within
 * the last 24h. Otherwise stamp the column and fire SMS.
 *
 * Phone fallback: properties.alert_phone first; falls back to MANAGER_PHONE
 * env var (covers solo-operator use case so they don't have to configure
 * a per-property phone).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface RequestBody {
  pid: string;
  /** UUIDs of items the page just classified as critical. */
  criticalItemIds: string[];
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000; // 24h

export async function POST(req: NextRequest) {
  // Trigger is now caller-side: the inventory page only POSTs items that
  // TRANSITIONED into critical (prevStatus !== 'out' && newStatus === 'out').
  // This route still has the 24h-per-item dedupe as a second guardrail.
  //
  // The earlier kill switch (INVENTORY_ALERTS_ENABLED) is removed now that
  // the trigger is correct. If you ever need to disable alerts again, set
  // properties.alert_phone to NULL and unset MANAGER_PHONE/OPS_ALERT_PHONE
  // — the route will then cleanly no-op with reason='no_alert_phone_configured'.
  //
  // Auth: previously this route only validated pid as UUID-shaped. That
  // meant anyone with a guessed pid + critical-item UUIDs could trigger an
  // SMS to the property's alert phone (mitigated by 24h dedupe but the
  // first hit costs Twilio credits and pages a real human). Now requires
  // a logged-in session that owns the property.
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return err('invalid_json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { pid, criticalItemIds } = body;
  if (!isUuid(pid)) {
    return err('invalid_pid', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (!Array.isArray(criticalItemIds) || criticalItemIds.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, reason: 'no_items' });
  }
  if (!criticalItemIds.every(isUuid)) {
    return err('invalid_item_id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // ── Resolve recipient phone ────────────────────────────────────────────
  const { data: prop, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, alert_phone')
    .eq('id', pid)
    .maybeSingle();
  if (propErr || !prop) {
    return NextResponse.json(
      { ok: false, error: 'property_not_found', detail: errToString(propErr) },
      { status: 404 },
    );
  }

  const recipient =
    (prop.alert_phone as string | null) ||
    process.env.MANAGER_PHONE ||
    process.env.OPS_ALERT_PHONE ||
    null;

  if (!recipient) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      skipped: criticalItemIds.length,
      reason: 'no_alert_phone_configured',
    });
  }

  // ── Read items in scope, scoped to this property (capability check) ─────
  const { data: items, error: itemsErr } = await supabaseAdmin
    .from('inventory')
    .select('id, name, current_stock, par_level, unit, last_alerted_at')
    .eq('property_id', pid)
    .in('id', criticalItemIds);

  if (itemsErr) {
    return NextResponse.json(
      { ok: false, error: 'inventory_read_failed', detail: errToString(itemsErr) },
      { status: 500 },
    );
  }

  const now = Date.now();
  let sent = 0;
  let skipped = 0;
  const errors: Array<{ itemId: string; error: string }> = [];

  for (const item of items ?? []) {
    const lastAlerted = item.last_alerted_at ? new Date(item.last_alerted_at as string).getTime() : 0;
    if (lastAlerted && now - lastAlerted < ALERT_DEDUPE_MS) {
      skipped++;
      continue;
    }

    const message =
      `[Staxis] ALERT: ${item.name} is critically low (${Number(item.current_stock)}/${Number(item.par_level)} ${item.unit ?? ''}). ` +
      `Reorder recommended.`;

    try {
      await sendSms(recipient, message);
      // Stamp last_alerted_at — best-effort, don't fail the whole request
      // if the column update errors (the SMS already went out).
      await supabaseAdmin
        .from('inventory')
        .update({ last_alerted_at: new Date().toISOString() })
        .eq('id', item.id);
      sent++;
    } catch (e) {
      errors.push({ itemId: String(item.id), error: errToString(e) });
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    sent,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
    propertyName: prop.name,
  });
}
