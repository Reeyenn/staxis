// ─── Live hotel context fetcher ───────────────────────────────────────────
// Per-turn snapshot of the hotel state the agent should know about. Gets
// stringified into the system prompt so Claude can answer "what's the
// occupancy" or "any overdue rooms" without having to call a tool first.
//
// Keep this cheap — runs on every user turn. Heavy queries (financial
// reports, multi-day aggregations) should be left for explicit tool calls.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';

export interface HotelSnapshot {
  /** ISO date string YYYY-MM-DD in the property's local time. */
  today: string;
  property: {
    id: string;
    name: string | null;
    timezone: string | null;
  };
  rooms: {
    total: number;
    dirty: number;
    in_progress: number;
    clean: number;
    dnd: number;
    issuesFlagged: number;
    helpRequested: number;
  };
  staff: {
    activeToday: number;
    assignedHousekeepers: number;
  };
  // Only populated for housekeeping role — their own assigned rooms.
  myRooms?: Array<{
    id: string;
    number: string;
    status: string;
    is_dnd: boolean;
    has_issue: boolean;
    help_requested: boolean;
  }>;
}

// 30-second in-process cache keyed by property+role. Hot path; avoids hitting
// the DB on every Enter keypress when the user fires a few quick messages.
type CacheKey = string;
const cache = new Map<CacheKey, { snapshot: HotelSnapshot; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

function cacheKey(propertyId: string, role: AppRole, staffId: string | null): CacheKey {
  return `${propertyId}::${role}::${staffId ?? '-'}`;
}

/**
 * Build a fresh snapshot of the hotel. Pulls ~5 cheap queries from the DB.
 * If a query fails, the corresponding section is null-ish but the snapshot
 * still returns — the agent should be resilient to incomplete context.
 */
export async function buildHotelSnapshot(
  propertyId: string,
  role: AppRole,
  staffId: string | null = null,
): Promise<HotelSnapshot> {
  const key = cacheKey(propertyId, role, staffId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Property name + timezone (cheap, sometimes missing for new orgs).
  let propertyName: string | null = null;
  let timezone: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('name, timezone')
      .eq('id', propertyId)
      .maybeSingle();
    if (data) {
      propertyName = (data.name as string) ?? null;
      timezone = (data.timezone as string) ?? null;
    }
  } catch {
    // non-fatal — snapshot continues with nulls
  }

  // Room summary — all rooms for the property today. One query, group in JS.
  const rooms = {
    total: 0,
    dirty: 0,
    in_progress: 0,
    clean: 0,
    dnd: 0,
    issuesFlagged: 0,
    helpRequested: 0,
  };
  try {
    const { data } = await supabaseAdmin
      .from('rooms')
      .select('status, is_dnd, issue_note, help_requested')
      .eq('property_id', propertyId);
    if (data) {
      rooms.total = data.length;
      for (const r of data) {
        const status = (r.status as string) ?? 'dirty';
        if (r.is_dnd) rooms.dnd++;
        else if (status === 'dirty') rooms.dirty++;
        else if (status === 'in_progress') rooms.in_progress++;
        else if (status === 'clean' || status === 'inspected') rooms.clean++;
        if (r.issue_note) rooms.issuesFlagged++;
        if (r.help_requested) rooms.helpRequested++;
      }
    }
  } catch {
    // non-fatal
  }

  // Active staff (today). is_active=true; the housekeeper public-link flow
  // doesn't reliably check-in/check-out so we use is_active as a proxy.
  let activeToday = 0;
  let assignedHousekeepers = 0;
  try {
    const { data } = await supabaseAdmin
      .from('staff')
      .select('id, role, is_active')
      .eq('property_id', propertyId)
      .eq('is_active', true);
    if (data) {
      activeToday = data.length;
      assignedHousekeepers = data.filter(
        s => (s.role as string)?.toLowerCase().includes('housekeep'),
      ).length;
    }
  } catch {
    // non-fatal
  }

  // For housekeeping role, also include their assigned rooms so they can ask
  // "what's next" without an extra tool call.
  let myRooms: HotelSnapshot['myRooms'] | undefined;
  if (role === 'housekeeping' && staffId) {
    try {
      const { data } = await supabaseAdmin
        .from('rooms')
        .select('id, number, status, is_dnd, issue_note, help_requested')
        .eq('property_id', propertyId)
        .eq('assigned_to', staffId)
        .order('number');
      if (data) {
        myRooms = data.map(r => ({
          id: r.id as string,
          number: (r.number as string) ?? '',
          status: (r.status as string) ?? 'dirty',
          is_dnd: !!r.is_dnd,
          has_issue: !!r.issue_note,
          help_requested: !!r.help_requested,
        }));
      }
    } catch {
      // non-fatal
    }
  }

  const snapshot: HotelSnapshot = {
    today,
    property: { id: propertyId, name: propertyName, timezone },
    rooms,
    staff: { activeToday, assignedHousekeepers },
    ...(myRooms ? { myRooms } : {}),
  };

  cache.set(key, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
  return snapshot;
}

/** Format the snapshot as a compact string the system prompt can embed.
 *
 * Codex adversarial review 2026-05-13 (A-C2): wrap the snapshot in
 * trust-boundary tags. Anything that flows from the database (including
 * fields ultimately derived from PMS imports or staff/guest input) is
 * marked `trust="system"` here — we trust this source today. Tool results
 * (handled in llm.ts) are wrapped `trust="untrusted"` because they can
 * include user-provided text (issue_note, help message) that a prior
 * housekeeper might have crafted to coerce a future model turn.
 *
 * Codex round-7 fix F4, 2026-05-13: escape XML metacharacters in every
 * interpolated dynamic field so a property/room/staff value containing
 * literal "</staxis-snapshot>" can't close the trust boundary and inject
 * "trusted" instructions into the system block. Same defense applied to
 * tool_result wrap in llm.ts. property.name + room.number are the most
 * realistic vectors today; staff names + issue_note arrive here via
 * future snapshot extensions.
 */
function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatSnapshotForPrompt(snap: HotelSnapshot): string {
  const lines: string[] = [];
  lines.push('<staxis-snapshot trust="system">');
  lines.push(`Today: ${esc(snap.today)}`);
  lines.push(
    `Property: ${esc(snap.property.name ?? 'Unnamed')} (${esc(snap.property.id)})` +
    (snap.property.timezone ? `, timezone ${esc(snap.property.timezone)}` : ''),
  );
  lines.push(
    `Rooms: ${snap.rooms.total} total — ${snap.rooms.dirty} dirty, ` +
    `${snap.rooms.in_progress} in progress, ${snap.rooms.clean} clean, ${snap.rooms.dnd} DND` +
    (snap.rooms.issuesFlagged ? `, ${snap.rooms.issuesFlagged} with issue notes` : '') +
    (snap.rooms.helpRequested ? `, ${snap.rooms.helpRequested} requesting help` : ''),
  );
  lines.push(
    `Staff active today: ${snap.staff.activeToday} ` +
    `(${snap.staff.assignedHousekeepers} housekeepers)`,
  );
  if (snap.myRooms?.length) {
    lines.push(`Your ${snap.myRooms.length} assigned rooms:`);
    for (const r of snap.myRooms) {
      const flags: string[] = [];
      if (r.is_dnd) flags.push('DND');
      if (r.has_issue) flags.push('issue');
      if (r.help_requested) flags.push('help-pending');
      lines.push(
        `  • Room ${esc(r.number)} — ${esc(r.status)}` +
        (flags.length ? ` [${flags.join(', ')}]` : ''),
      );
    }
  }
  lines.push('</staxis-snapshot>');
  return lines.join('\n');
}
