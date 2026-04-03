import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';

interface NotifyEntry {
  token: string;     // FCM device token
  name: string;      // housekeeper's name (for the message)
  rooms: string[];   // room numbers assigned to them
}

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://hotelops-ai.vercel.app';

export async function POST(req: NextRequest) {
  // Guard: admin SDK must be initialized (requires server env vars)
  if (!admin.apps.length) {
    console.error('notify-housekeepers: Firebase Admin SDK not initialized');
    return NextResponse.json(
      { error: 'Server not configured for push notifications' },
      { status: 503 }
    );
  }

  try {
    const entries: NotifyEntry[] = await req.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: 'No entries provided' }, { status: 400 });
    }

    const messaging = admin.messaging();

    const results = await Promise.allSettled(
      entries.map(({ token, name, rooms }) => {
        const roomList = rooms.length <= 4
          ? rooms.join(', ')
          : `${rooms.slice(0, 3).join(', ')} +${rooms.length - 3} more`;

        return messaging.send({
          token,
          notification: {
            title: `Your rooms are ready, ${name.split(' ')[0]}`,
            body: `Assigned: ${roomList}`,
          },
          data: {
            rooms: rooms.join(','),
          },
          webpush: {
            notification: {
              icon: `${APP_URL}/icon-192.png`,
              badge: `${APP_URL}/icon-192.png`,
              tag: 'room-assignment',
              renotify: true,
            },
            fcmOptions: {
              // Absolute URL - relative URLs are rejected by the push service
              link: `${APP_URL}/rooms`,
            },
          },
        });
      })
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Log any failures for debugging
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Failed to notify ${entries[i].name}:`, r.reason);
      }
    });

    return NextResponse.json({ sent, failed });
  } catch (err) {
    console.error('notify-housekeepers error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
