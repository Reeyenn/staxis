import type { ScheduledShiftStatus } from '@/types';

// The unified manager schedule publishes each saved row immediately. The old
// week-publication stamp is bookkeeping only and is not authoritative: its
// insert is deliberately non-fatal, so using it as a visibility gate can hide
// a successfully saved shift. Row status is the canonical staff boundary.
export function isStaffVisibleScheduleStatus(status: ScheduledShiftStatus): boolean {
  return status === 'published' || status === 'sent' || status === 'confirmed';
}
