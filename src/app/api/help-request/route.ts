import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { toE164 } from '@/lib/phone';
import { verifyStaffBelongsToProperty } from '@/lib/api-auth';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    // `uid` from the HK page IS the staff id (it's the [id] path param).
    // Accept it as `staffId` going forward; fall back to `uid` for back-compat.
    const { pid, staffName, roomNumber, language } = body;
    const staffId: string | undefined = body.staffId ?? body.uid;

    if (!pid || !staffName || !roomNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }
    // Public-link sanity check: only allow help-requests where the staff
    // member actually exists for this property. Stops a stranger who scrapes
    // a single pid from spamming help SMS to the scheduling manager.
    if (!staffId || !(await verifyStaffBelongsToProperty(staffId, pid))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
