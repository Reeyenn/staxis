/**
 * Pure-function SMS body builders for the sick-callout flow.
 *
 * Lives in its own file (separate from notify.ts) so the unit tests can
 * import them WITHOUT pulling @/lib/sms → @sentry/nextjs into the test
 * graph. Sentry's instrumentation has a module-load side effect that can
 * hang the Node test runner in certain configurations; keeping the pure
 * helpers isolated dodges that entirely.
 *
 * notify.ts re-exports these so the public surface stays unchanged.
 */

import { sanitizeForSms } from '@/lib/api-validate';
import type { Language } from '@/lib/translations';

/**
 * Build the SMS body for an affected housekeeper. Falls back to English
 * when language is unset. Body is intentionally short — Twilio segments at
 * 160 chars and we want one segment per message.
 */
export function buildPickupSms(
  sickStaffName: string,
  pickedUpRoomNumbers: string[],
  newTotalRooms: number,
  language: Language,
): string {
  const rooms = pickedUpRoomNumbers.join(', ');
  const body =
    language === 'es'
      ? `${sickStaffName} se reportó enfermo — recogiste habitaciones ${rooms}. Nuevo total: ${newTotalRooms}.`
      : `${sickStaffName} called out — you picked up rooms ${rooms}. New total: ${newTotalRooms}.`;
  return sanitizeForSms(body);
}

export function buildManagerSummarySms(
  sickStaffName: string,
  totalRedistributed: number,
  pickups: Array<{ staff_name: string; count: number }>,
): string {
  if (totalRedistributed === 0) {
    return sanitizeForSms(
      `${sickStaffName} called out today. No rooms to redistribute (none assigned yet).`,
    );
  }
  const breakdown = pickups
    .filter((p) => p.count > 0)
    .map((p) => `${p.staff_name} +${p.count}`)
    .join(', ');
  return sanitizeForSms(
    `${sickStaffName} called out — ${totalRedistributed} room${totalRedistributed === 1 ? '' : 's'} redistributed. ${breakdown}.`,
  );
}

export function buildRevertSms(sickStaffName: string, language: Language): string {
  const body =
    language === 'es'
      ? `Se canceló la ausencia de ${sickStaffName}. Tu lista de habitaciones volvió a la normalidad.`
      : `${sickStaffName}'s callout was reverted — your queue is back to normal.`;
  return sanitizeForSms(body);
}
