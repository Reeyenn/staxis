import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';

interface SmsEntry {
  phone: string;          // E.164 format, e.g. +15551234567
  name:  string;
  rooms: string[];
  housekeeperId?: string; // staff.id — used to build personal room link
}

/** Normalise a phone number to E.164. Strips non-digits and prepends +1 for 10-digit US numbers. */
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // Lock this route behind CRON_SECRET. /api/notify-housekeepers-sms
    // is currently dead in the codebase (the active SMS path is
    // /api/send-shift-confirmations) but the URL is still public and
    // would fire SMS through our Twilio account if anyone discovered
    // it. Same secret as /api/cron/* and /api/morning-resend.
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers.get('authorization') ?? '';
      if (authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const reqBody = await req.json();

    // Handle both array format (legacy) and object format with uid/pid.
    let entries: SmsEntry[];
    let pid: string | undefined;

    if (Array.isArray(reqBody)) {
      entries = reqBody;
    } else {
      entries = reqBody.entries ?? [];
      // uid still accepted for back-compat but ignored; pid is the scoping key.
      pid = reqBody.pid;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: 'No entries provided' }, { status: 400 });
    }

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
      entries.map(({ phone, name, rooms, housekeeperId }) => {
        const e164 = toE164(phone);
        if (!e164) throw new Error(`Invalid phone number: ${phone}`);

        const roomList = rooms.length <= 4
          ? rooms.join(', ')
          : `${rooms.slice(0, 3).join(', ')} +${rooms.length - 3} more`;

        const link = housekeeperId
          ? ` View your rooms: https://hotelops-ai.vercel.app/housekeeper/${housekeeperId}`
          : '';
        const message = `Hi ${name.split(' ')[0]}, your rooms for today: ${roomList}.${link} – ${hotelName}`;

        return sendSms(e164, message);
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        // Redact phone + log staffId-ish position rather than the raw name,
        // to keep PII out of log aggregators.
        const redacted = (entries[i].phone ?? '').replace(/\D/g, '').slice(-4);
        console.error(`[notify-housekeepers-sms] SMS failed entry[${i}] phone=***${redacted}: ${errToString(r.reason)}`);
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    // Server-side error detail in log; generic 500 to the caller.
    console.error('[notify-housekeepers-sms] error:', errToString(err));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
