import { NextRequest, NextResponse } from 'next/server';
import { sendSms } from '@/lib/sms';

interface SmsEntry {
  phone: string;          // E.164 format, e.g. +15551234567
  name:  string;
  rooms: string[];
  housekeeperId?: string; // Firestore staff document ID — used to build personal room link
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
    const entries: SmsEntry[] = await req.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: 'No entries provided' }, { status: 400 });
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
        const message = `Hi ${name.split(' ')[0]}, your rooms for today: ${roomList}.${link} – Comfort Suites`;

        return sendSms(e164, message);
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`SMS failed for ${entries[i].name} (${entries[i].phone}):`, r.reason);
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    console.error('notify-housekeepers-sms error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
