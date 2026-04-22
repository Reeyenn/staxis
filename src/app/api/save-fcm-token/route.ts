import { NextRequest, NextResponse } from 'next/server';

/**
 * DEPRECATED — FCM push was removed during the Supabase migration.
 *
 * Notifications to housekeepers are now SMS-only via Twilio. The mobile
 * housekeeper page no longer requests an FCM token, so this endpoint should
 * never be called in practice. We keep the route alive as a 410 Gone so
 * stale client bundles in the wild fail loudly rather than silently 404 on
 * every page load.
 *
 * Clean-up task: once we confirm no clients are still POSTing here (check
 * Vercel logs for 30 days), this file can be deleted.
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: 'Endpoint deprecated',
      message:
        'FCM push notifications were retired. Housekeepers now receive Twilio SMS. ' +
        'If you are seeing this error, refresh the page to load the latest client bundle.',
    },
    { status: 410 },
  );
}
