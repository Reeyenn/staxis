// ═══════════════════════════════════════════════════════════════════════════
// Client-side notification helpers.
//
// Design note — SMS-only as of 2026-04-22:
// Firebase Cloud Messaging (web push) was dropped alongside the Firestore
// migration. Housekeepers reliably carry SMS-capable phones but rarely
// re-open PWAs, and FCM on iOS required installing the page to the home
// screen first — a user-hostile onboarding step we never got around. Every
// notification path now goes through Twilio.
//
// `registerForPushNotifications` is retained as a no-op so legacy callers
// (the /housekeeper/setup flow) compile unchanged during the migration.
// It always resolves to `null` to signal "no push available"; callers
// should fall back to their SMS flow.
//
// `sendAssignmentNotifications` is a thin alias over `sendSmsNotifications`
// so the Smart Assign CTA in the housekeeping dashboard keeps working.
// New code should call `sendSmsNotifications` directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LEGACY / NO-OP. Kept for backwards compatibility with the /housekeeper
 * onboarding page. Always returns null — push is no longer supported.
 * Callers should treat a null return as "push unavailable" and proceed
 * with their SMS path.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  return null;
}

/**
 * Send SMS room-assignment notifications via Twilio.
 * Invoked after Smart Assign. Skips staff with no phone number on file.
 */
export async function sendSmsNotifications(
  assignments: Record<string, string[]>,   // staffId → room numbers[]
  staffNames:  Record<string, string>,     // staffId → name
  staffPhones: Record<string, string>,     // staffId → phone number
): Promise<{ sent: number; failed: number }> {
  const entries = Object.entries(assignments).filter(([staffId]) => staffPhones[staffId]);
  if (entries.length === 0) return { sent: 0, failed: 0 };

  const res = await fetch('/api/notify-housekeepers-sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      entries.map(([staffId, rooms]) => ({
        phone:          staffPhones[staffId],
        name:           staffNames[staffId] ?? 'Housekeeper',
        rooms,
        housekeeperId:  staffId,
      }))
    ),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`notify-housekeepers-sms HTTP ${res.status}:`, text);
    return { sent: 0, failed: entries.length };
  }

  return res.json() as Promise<{ sent: number; failed: number }>;
}

/**
 * LEGACY — kept so the Smart Assign CTA in housekeeping/page.tsx keeps
 * compiling. Now an alias for `sendSmsNotifications`. The old signature
 * took `staffTokens` (FCM tokens); we map that positionally to
 * `staffPhones` for zero behavioral change at call-sites that already
 * pass phone numbers. New code should call `sendSmsNotifications` directly.
 */
export async function sendAssignmentNotifications(
  assignments: Record<string, string[]>,
  staffNames:  Record<string, string>,
  staffPhones: Record<string, string>,
): Promise<{ sent: number; failed: number }> {
  return sendSmsNotifications(assignments, staffNames, staffPhones);
}
