/**
 * Fire-and-forget client-side activity tracker.
 *
 * Sends a row to /api/events for every page view inside the app.
 * Failures are swallowed — the tracker must NEVER affect the UI.
 *
 * The server determines user_id and user_role from the bearer token;
 * this function only supplies what it knows on the client side
 * (active property + the path / event type). See /api/events for the
 * full contract.
 */

import { fetchWithAuth } from '@/lib/api-fetch';

export type AppEventType =
  | 'page_view'
  | 'feature_use'
  | 'staff_confirm'
  | 'sms_sent_internal'
  | 'pms_sync_triggered';

interface FireOptions {
  eventType: AppEventType;
  propertyId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function fireEvent(opts: FireOptions): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await fetchWithAuth('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: opts.eventType,
        propertyId: opts.propertyId ?? null,
        metadata: opts.metadata ?? {},
      }),
      // Don't keep the page from unloading on slow networks.
      keepalive: true,
    });
  } catch {
    /* swallow — tracking must never break the UI */
  }
}
