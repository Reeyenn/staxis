// Shared helpers used by the redesigned ScheduleTab.
//
// History: this file used to be a 800-line junk drawer for the old
// housekeeping monolith — leaderboard helpers, pace badges, public-areas
// modal, staff colors, ML prediction badges, etc. After the May-2026
// redesign moved everything to per-tab files + the Snow primitives in
// `_snow.tsx`, only ScheduleTab still needs five small helpers from here.
// Everything else was removed in the dead-code cleanup.
//
// If a future redesign needs anything that USED to live here, prefer
// adding it to the consuming tab file or to `_snow.tsx` rather than
// re-bloating this module.

'use client';

import type { PlanSnapshot } from '@/lib/db';
import type { Room, RoomType, RoomPriority, RoomStatus } from '@/types';

// ─── Date helpers ────────────────────────────────────────────────────────

/** Add `n` days to a YYYY-MM-DD string and return a new YYYY-MM-DD. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('en-CA');
}

// Always default to today. Maria uses the arrow keys to flip to tomorrow
// when she's planning the next day's crew — auto-jumping at 1pm was
// confusing because she'd open the page expecting today's numbers and get
// tomorrow instead. Manual navigation beats clever defaults here.
export function defaultShiftDate(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Short, human-friendly stamp for a CSV pull time.
 * "Today 6:02 AM" if the pull happened today, otherwise "Fri 7:02 PM".
 * Keeps Maria oriented at a glance — she always knows how fresh the room list is.
 */
export function formatPulledAt(iso: string | null, lang: 'en' | 'es'): string {
  if (!iso) return '';
  const d = new Date(iso);
  const todayLocal = new Intl.DateTimeFormat('en-CA').format(new Date());
  const thenLocal = new Intl.DateTimeFormat('en-CA').format(d);
  const time = d.toLocaleTimeString(lang === 'es' ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' });
  if (thenLocal === todayLocal) {
    return `${lang === 'es' ? 'Hoy' : 'Today'} ${time}`;
  }
  const weekday = d.toLocaleDateString(lang === 'es' ? 'es' : 'en', { weekday: 'short' });
  return `${weekday} ${time}`;
}

export function formatDisplayDate(dateStr: string, lang: 'en' | 'es'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

// ─── PlanSnapshot → Room[] ──────────────────────────────────────────────

/**
 * Derive synthetic Room[] from a planSnapshot (CSV data).
 * This is the ONLY source the Schedule tab reads from — no rooms-collection dependency.
 *   - C/O stayType → checkout
 *   - OCC + Stay stayType → stayover
 *   - everything else → skipped (arrivals, vacants, OOO don't need HK assignment)
 */
export function snapshotToShiftRooms(snap: PlanSnapshot | null, pid: string): Room[] {
  if (!snap?.rooms) return [];
  const out: Room[] = [];
  for (const r of snap.rooms) {
    let type: RoomType | null = null;
    if (r.stayType === 'C/O') type = 'checkout';
    else if (r.stayType === 'Stay') type = 'stayover';
    if (!type) continue;
    out.push({
      id: `${snap.date}_${r.number}`,
      number: r.number,
      type,
      priority: 'standard' as RoomPriority,
      status: 'dirty' as RoomStatus,
      date: snap.date,
      propertyId: pid,
      assignedTo: r.housekeeper ?? undefined,
      // Carry the stayover cycle day through so the UI can label S1 vs S2
      // (light vs full clean) on both the unassigned pool and crew tiles.
      stayoverDay: typeof r.stayoverDay === 'number' ? r.stayoverDay : undefined,
    });
  }
  return out;
}
