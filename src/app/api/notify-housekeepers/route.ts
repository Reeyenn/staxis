import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';

/**
 * POST /api/notify-housekeepers
 *
 * Notifies housekeepers of their room assignments for the day.
 *
 * Historically this route sent Firebase Cloud Messaging (FCM) web-push
 * notifications to any housekeeper whose browser had registered a push
 * token. FCM is removed in the Supabase migration — hotel housekeeping
 * staff rarely keep the tab open and nearly always have their phones out,
 * so SMS via Twilio is the better channel. This route now forwards to the
 * same code path as /api/notify-housekeepers-sms so existing callers keep
 * working without changing their payload shape.
 *
 * Accepted payload shapes:
 *   [{ name, rooms[], phone?, housekeeperId? }, ...]   // legacy array
 *   { entries: [...], uid?, pid? }                     // new wrapper
 *
 * The `token` field (FCM device token) from the legacy payload is ignored.
 * If no `phone` is present on an entry, we look it up in the staff table
 * by staff.id (= housekeeperId) so the client doesn't have to round-trip.
 */

interface NotifyEntry {
  /** Ignored — FCM was removed. Present on legacy callers, kept for type compat. */
  token?: string;
  /** Preferred: E.164 phone or 10-digit US. If missing, we resolve via housekeeperId. */
  phone?: string;
  name: string;
  rooms: string[];
  housekeeperId?: string;
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const reqBody = await req.json();

    let entries: NotifyEntry[];
    let pid: string | undefined;
    if (Array.isArray(reqBody)) {
      entries = reqBody;
    } else {
      entries = reqBody.entries ?? [];
      pid = reqBody.pid;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: 'No entries provided' }, { status: 400 });
    }

    // Resolve missing phones from staff table in one batched query.
    const missingPhoneIds = entries
      .filter(e => !e.phone && e.housekeeperId)
      .map(e => e.housekeeperId!)
      .filter(Boolean);

    let phoneLookup: Record<string, string | null> = {};
    if (missingPhoneIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('staff')
        .select('id, phone')
        .in('id', missingPhoneIds);
      if (error) {
        console.error('[notify-housekeepers] staff phone lookup failed', error);
      } else {
        phoneLookup = Object.fromEntries(
          (data ?? []).map(r => [r.id as string, (r.phone as string | null) ?? null]),
        );
      }
    }

    // Look up hotel name once per request.
    let hotelName = 'Your Hotel';
    if (pid) {
      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('name')
        .eq('id', pid)
        .maybeSingle();
      hotelName = prop?.name || 'Your Hotel';
    }

    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const rawPhone = entry.phone
          ?? (entry.housekeeperId ? phoneLookup[entry.housekeeperId] ?? '' : '');
        const e164 = rawPhone ? toE164(rawPhone) : null;
        if (!e164) {
          throw new Error(`No deliverable phone for ${entry.name}`);
        }

        const rooms = entry.rooms ?? [];
        const roomList = rooms.length <= 4
          ? rooms.join(', ')
          : `${rooms.slice(0, 3).join(', ')} +${rooms.length - 3} more`;

        const link = entry.housekeeperId
          ? ` View your rooms: https://hotelops-ai.vercel.app/housekeeper/${entry.housekeeperId}`
          : '';
        const message = `Hi ${entry.name.split(' ')[0]}, your rooms for today: ${roomList}.${link} – ${hotelName}`;

        await sendSms(e164, message);
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`SMS failed for ${entries[i].name}:`, errToString((r as PromiseRejectedResult).reason));
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    const msg = errToString(err);
    console.error('notify-housekeepers error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
