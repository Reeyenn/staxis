// ─── Live hotel context fetcher ───────────────────────────────────────────
// Per-turn snapshot of the hotel state the agent should know about. Gets
// stringified into the system prompt so Claude can answer "what's the
// occupancy" or "any overdue rooms" without having to call a tool first.
//
// Keep this cheap — runs on every user turn. Heavy queries (financial
// reports, multi-day aggregations) should be left for explicit tool calls.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import { getCurrentRoomsDate } from './tools/_helpers';

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
    /** When > 0, today's rooms table has fewer rows than the property's
     *  master inventory. Surfaced to the agent so it doesn't claim
     *  "100% occupancy" while silently looking at a partial picture. */
    seedingGap: number;
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

  // Property name + timezone + total_rooms + room_inventory (cheap; one query).
  //
  // Round 14 (2026-05-14): room_inventory is the truth about how many rooms
  // a property has. The `rooms` table is a per-day operational view that
  // may be partially seeded (Choice Advantage's CSV omits vacant-clean
  // rooms — see migration 0025). Reading inventory length here means the
  // agent reports the correct total even when today's seed is incomplete;
  // missing rooms surface as vacant in `get_occupancy` (which is the safe
  // default — absence of data means no guest).
  let propertyName: string | null = null;
  let timezone: string | null = null;
  let configuredTotalRooms = 0;
  let inventoryLength = 0;
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('name, timezone, total_rooms, room_inventory')
      .eq('id', propertyId)
      .maybeSingle();
    if (data) {
      propertyName = (data.name as string) ?? null;
      timezone = (data.timezone as string) ?? null;
      configuredTotalRooms = Number(data.total_rooms ?? 0);
      const inv = data.room_inventory as string[] | null;
      inventoryLength = Array.isArray(inv) ? inv.length : 0;
    }
  } catch {
    // non-fatal — snapshot continues with nulls
  }

  // Pick the rooms.date to query against — see getCurrentRoomsDate for why
  // this isn't just `new Date().toISOString().slice(0,10)`. If the property
  // has no rooms at all (brand-new account, pre-seed) the helper returns
  // null and the rooms summary stays zeroed.
  const roomsDate = await getCurrentRoomsDate(propertyId);
  const today = roomsDate ?? new Date().toISOString().slice(0, 10);

  // Room summary — only the rows for the chosen date.
  //
  // 2026-05-14 root cause: this query previously had no date filter, so
  // for a hotel with N rooms and D days of seeded history it returned
  // N×D rows and reported them all as "today's rooms." Result: the
  // voice mode replied "557 dirty rooms, 432 clean…" for a ~100-room
  // property. The composite key on (property_id, date, number) makes
  // multi-day accumulation the default behavior — the date filter is
  // mandatory for any "today" summary.
  const rooms = {
    total: 0,
    dirty: 0,
    in_progress: 0,
    clean: 0,
    dnd: 0,
    issuesFlagged: 0,
    helpRequested: 0,
    seedingGap: 0,
  };
  let seededRowCount = 0;
  if (roomsDate) {
    try {
      const { data } = await supabaseAdmin
        .from('rooms')
        .select('status, is_dnd, issue_note, help_requested')
        .eq('property_id', propertyId)
        .eq('date', roomsDate);
      if (data) {
        seededRowCount = data.length;
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
  }

  // rooms.total = inventory length when configured (truth), else fall back
  // to the seeded count. seedingGap surfaces partial seeds to the agent.
  rooms.total = inventoryLength > 0 ? inventoryLength : seededRowCount;
  rooms.seedingGap = inventoryLength > 0
    ? Math.max(0, inventoryLength - seededRowCount)
    : 0;

  // Sanity check: seeded rows shouldn't exceed the configured property size
  // (which the manager set at onboarding). If they do, the data layer is
  // somehow returning multi-day rows again — log loudly so we can spot it
  // before the agent reports inflated numbers to a user.
  if (configuredTotalRooms > 0 && seededRowCount > configuredTotalRooms) {
    console.warn(
      `[agent/context] seededRowCount=${seededRowCount} exceeds properties.total_rooms=${configuredTotalRooms} ` +
      `for property=${propertyId} date=${roomsDate} — possible date-filter regression`,
    );
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
  // "what's next" without an extra tool call. Same date filter applies —
  // without it, a housekeeper sees every room they've ever been assigned
  // to instead of the rooms on the active date.
  let myRooms: HotelSnapshot['myRooms'] | undefined;
  if (role === 'housekeeping' && staffId && roomsDate) {
    try {
      const { data } = await supabaseAdmin
        .from('rooms')
        .select('id, number, status, is_dnd, issue_note, help_requested')
        .eq('property_id', propertyId)
        .eq('date', roomsDate)
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

// ─── Voice context (Whisper prompt hint) ─────────────────────────────────
// Whisper accepts an optional `prompt` string that biases the transcriber
// toward the vocabulary it'll hear. Hotel-specific words and proper nouns
// (room numbers, staff names) are the most common source of transcription
// errors — passing them as a hint dramatically improves accuracy.
//
// We pull room-number range + active-staff names per property. Cached for
// 60s because rooms and staff don't change much within a voice session, and
// a user might fire 10 utterances in a minute.
//
// Whisper's prompt limit is 244 tokens, so this is intentionally compact.
// Property name + room range + a comma-list of first names of active staff
// fits comfortably even with a 100-room property and 30 active staff.

interface VoiceContext {
  propertyName: string | null;
  roomNumberRange: string;   // "101–350" or "" if no rooms
  activeStaffNames: string[];
}

const voiceContextCache = new Map<string, { ctx: VoiceContext; expiresAt: number }>();
const VOICE_CONTEXT_TTL_MS = 60_000;

async function loadVoiceContext(propertyId: string): Promise<VoiceContext> {
  const cached = voiceContextCache.get(propertyId);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  let propertyName: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', propertyId)
      .maybeSingle();
    if (data) propertyName = (data.name as string) ?? null;
  } catch { /* non-fatal */ }

  // Room number range — min/max as integers. Some properties have
  // non-numeric room numbers ("L1-201", "Suite-A"); skip those when
  // computing the range to avoid garbage hints.
  let roomNumberRange = '';
  try {
    const { data } = await supabaseAdmin
      .from('rooms')
      .select('number')
      .eq('property_id', propertyId);
    if (data && data.length > 0) {
      const nums: number[] = [];
      for (const r of data) {
        const n = parseInt((r.number as string) ?? '', 10);
        if (Number.isFinite(n)) nums.push(n);
      }
      if (nums.length > 0) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        roomNumberRange = min === max ? String(min) : `${min}–${max}`;
      }
    }
  } catch { /* non-fatal */ }

  let activeStaffNames: string[] = [];
  try {
    const { data } = await supabaseAdmin
      .from('staff')
      .select('name')
      .eq('property_id', propertyId)
      .eq('is_active', true);
    if (data) {
      activeStaffNames = data
        .map(s => (s.name as string)?.trim())
        .filter((n): n is string => !!n)
        .slice(0, 30);  // cap to fit Whisper's 244-token prompt budget
    }
  } catch { /* non-fatal */ }

  const ctx: VoiceContext = { propertyName, roomNumberRange, activeStaffNames };
  voiceContextCache.set(propertyId, { ctx, expiresAt: Date.now() + VOICE_CONTEXT_TTL_MS });
  return ctx;
}

/**
 * Build the Whisper `prompt` string for a given property. Pass to the
 * OpenAI Whisper API to bias transcription toward hotel-specific
 * vocabulary. Result is a single line under ~200 tokens.
 *
 * Empty string is a valid return if the property has no rooms/staff yet;
 * Whisper accepts an empty hint without changing behaviour.
 */
export async function getVoiceContextHint(propertyId: string): Promise<string> {
  const ctx = await loadVoiceContext(propertyId);

  const parts: string[] = [];
  if (ctx.propertyName) parts.push(`Hotel: ${ctx.propertyName}.`);
  if (ctx.roomNumberRange) parts.push(`Rooms ${ctx.roomNumberRange}.`);
  if (ctx.activeStaffNames.length > 0) {
    parts.push(`Staff: ${ctx.activeStaffNames.join(', ')}.`);
  }
  parts.push('Common phrases: dirty, clean, in progress, DND, deep clean, occupancy, maintenance, mark, room, hotel.');

  return parts.join(' ');
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
  if (snap.rooms.seedingGap > 0) {
    // The agent needs to know it's looking at a partial picture so it
    // doesn't claim "100% occupancy" or "all rooms occupied" when really
    // some rooms simply haven't been seeded into today's view yet.
    const seeded = snap.rooms.total - snap.rooms.seedingGap;
    lines.push(
      `Heads-up: today's housekeeping data has ${seeded} of ${snap.rooms.total} rooms seeded; ` +
      `the missing ${snap.rooms.seedingGap} are reported as vacant.`,
    );
  }
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
