import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';

/**
 * POST /api/help-request
 *
 * Triggered when a housekeeper taps "Need Help" on their mobile page.
 * Sends ONE SMS to the single staff member flagged as the property's
 * Scheduling Manager (is_scheduling_manager = true on their staff row).
 *
 * No broadcasts. No department-based routing. One person, one text.
 * If no scheduling manager is flagged, the request is a no-op (sent = 0).
 *
 * Payload:
 *   uid        – retained for back-compat; no longer required for scoping
 *                (RLS + pid are enough under Supabase)
 *   pid        – property id
 *   staffName  – name of the housekeeper asking for help (shown in the SMS)
 *   roomNumber – room the housekeeper is in
 *   language   – 'en' | 'es' (optional, defaults to en)
 */

/** E.164 phone normalization */
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pid, staffId, staffName, roomNumber, language } = body;

    if (!pid || !staffName || !roomNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // ── Light caller verification ─────────────────────────────────────────
    // This route is hit by the housekeeper's mobile page (a public link from
    // an SMS, no auth). To stop a stranger spoofing help requests for any
    // (pid, staffName, roomNumber) tuple they happen to guess, require the
    // caller to ALSO pass staffId and verify the staff row exists, belongs
    // to that property, and isn't retired (is_active != false). This isn't
    // bulletproof — anyone with the SMS link knows the staffId — but it
    // shrinks the abuse surface from "anyone on the internet" to "anyone
    // who has seen one of our SMS links". A token-per-shift in the link is
    // the proper fix; this gates the obvious external abuse.
    //
    // staffId is optional only because legacy callers may not send it; we
    // log and allow the request through but still require pid (above) so
    // we can scope to the property.
    if (staffId) {
      const { data: staffRow, error: staffErr } = await supabaseAdmin
        .from('staff')
        .select('id, property_id, is_active')
        .eq('id', staffId)
        .maybeSingle();
      if (staffErr) {
        console.error('[help-request] staff lookup error:', staffErr.message);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
      }
      if (!staffRow || staffRow.property_id !== pid) {
        // Mismatched (or missing) staff — silently no-op so we don't leak
        // whether a particular id exists. Still 200 so the UI doesn't show
        // a scary error to the housekeeper.
        return NextResponse.json({ sent: 0, failed: 0, reason: 'unknown-staff' });
      }
      if (staffRow.is_active === false) {
        return NextResponse.json({ sent: 0, failed: 0, reason: 'staff-inactive' });
      }
    }

    // Fetch property name and scheduling manager in parallel.
    const [{ data: prop }, { data: managers, error: mgrErr }] = await Promise.all([
      supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle(),
      supabaseAdmin
        .from('staff')
        .select('id, name, phone, is_active, is_scheduling_manager')
        .eq('property_id', pid)
        .eq('is_scheduling_manager', true)
        .limit(1),
    ]);

    if (mgrErr) {
      console.error('[help-request] staff query failed', mgrErr);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const propertyName = prop?.name || 'Your Hotel';

    if (!managers || managers.length === 0) {
      console.warn(
        `[help-request] No scheduling manager flagged for property ${pid}. Help request from ${staffName} in Room ${roomNumber} was not routed.`
      );
      return NextResponse.json({ sent: 0, failed: 0, reason: 'no-scheduling-manager' });
    }

    const manager = managers[0];

    if (!manager.phone || manager.is_active === false) {
      console.warn(
        `[help-request] Scheduling manager ${manager.name} is inactive or has no phone. Help request not routed.`
      );
      return NextResponse.json({ sent: 0, failed: 0, reason: 'manager-unreachable' });
    }

    const e164 = toE164(manager.phone);
    if (!e164) {
      console.error(`[help-request] Invalid phone for scheduling manager: ${manager.phone}`);
      return NextResponse.json({ sent: 0, failed: 1, reason: 'invalid-phone' });
    }

    const lang = language === 'es' ? 'es' : 'en';
    const message = lang === 'es'
      ? `🆘 ¡Ayuda necesaria! ${staffName} necesita ayuda en Habitación ${roomNumber}. – ${propertyName}`
      : `🆘 Help needed! ${staffName} is requesting help in Room ${roomNumber}. – ${propertyName}`;

    try {
      await sendSms(e164, message);
      return NextResponse.json({ sent: 1, failed: 0 });
    } catch (err) {
      console.error(
        `[help-request] SMS failed for scheduling manager ${manager.name} (${manager.phone}):`,
        errToString(err)
      );
      return NextResponse.json({ sent: 0, failed: 1 });
    }
  } catch (err) {
    const msg = errToString(err);
    console.error('[help-request] error:', msg);
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}
