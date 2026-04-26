import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { toE164 } from '@/lib/phone';
import { requireSession } from '@/lib/api-auth';

interface SmsEntry {
  phone: string;          // E.164 format, e.g. +15551234567
  name:  string;
  rooms: string[];
  housekeeperId?: string; // staff.id — used to build personal room link
}

export async function POST(req: NextRequest) {
  try {
    const reqBody = await req.json().catch(() => null);
    if (!reqBody) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

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
    if (!pid) {
      return NextResponse.json({ error: 'pid is required' }, { status: 400 });
    }
    const session = await requireSession(req, { pid });
    if (session instanceof NextResponse) return session;

    let hotelName = 'Your Hotel';
    if (pid) {
      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('name')
        .eq('id', pid)
        .maybeSingle();
      hotelName = prop?.name || 'Your Hotel';
    }

    // Async function so any sync throw (missing field, bad phone) becomes a
    // per-entry rejection rather than killing the whole batch — previously
    // a single malformed `name` would crash the request and leave earlier
    // SMS already in-flight with no record of who got what.
    const results = await Promise.allSettled(
      entries.map(async ({ phone, name, rooms, housekeeperId }) => {
        if (!phone || !name || !Array.isArray(rooms)) {
          throw new Error('Entry missing phone/name/rooms');
        }
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
        console.error(`SMS failed for ${entries[i].name} (${entries[i].phone}):`, errToString(r.reason));
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    const msg = errToString(err);
    console.error('notify-housekeepers-sms error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
