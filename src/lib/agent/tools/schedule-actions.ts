// ─── Schedule action tools ─────────────────────────────────────────────────
//
// Three AI-assistant abilities over the staff schedule (migration 0147's
// `scheduled_shifts` — the single source of truth for "who's working"):
//
//   get_schedule    — READ: who is working on a given date (defaults to today),
//                     with approved time-off excluded. Chat + general voice.
//   remove_from_shift — MUTATION (card, manager-gated): give someone a day off
//                     by deleting their assigned shift for that date.
//   assign_shift    — MUTATION (card, manager-gated): add/assign a shift for a
//                     staff member on a date (upsert, mirrors the week-grid).
//
// Data model (confirmed against the schema, do NOT invent tables):
//   scheduled_shifts(property_id, staff_id, department, shift_date, start_time,
//                    end_time, kind='shift'|'open', status='draft'|'published'|…)
//     — one assigned row per (property, staff, date) via an exclusion constraint
//       (23P01 on conflict). staff_id is null only for kind='open' slots.
//   time_off_requests(property_id, staff_id, request_date, status) — an
//     approved row means that day is off; the Schedule tab auto-deletes the
//     matching shift on approval, so we mirror that when reading.
//
// The `staff` table has NO `role` column (roles live on accounts) — every
// select list here uses real columns only, same rule as _helpers.ts.
//
// Identity/roles: the mutations are manager-tier (admin/owner/general_manager),
// matching decide_time_off + assign_room. They act ON a staff member (staff_id),
// not AS the caller, so they don't require ctx.staffId.
//
// ADDITIVE + self-registering — add `import './schedule-actions';` to index.ts.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult, type ToolContext } from '../tools';
import { resolveStaffByName } from './_helpers';
import { todayStr } from '@/lib/utils';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHIFT_DEPARTMENTS = ['housekeeping', 'front_desk', 'maintenance', 'other'] as const;

// A shift with no explicit hours defaults to a standard full day so the model
// can honor "put Maria on Friday" without inventing times. Managers refine
// hours in the Schedule tab; the card shows these defaults so nothing is hidden.
const DEFAULT_START = '08:00';
const DEFAULT_END = '16:00';

/**
 * Resolve a natural date phrase the model may pass ("today"/"tomorrow") or an
 * explicit YYYY-MM-DD into a concrete property-local ISO date. Returns null for
 * anything we can't parse so the tool refuses rather than writing the wrong day.
 */
function resolveScheduleDate(input: string | undefined): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw === 'today') return todayStr();
  if (raw === 'tomorrow') {
    const d = new Date(`${todayStr()}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (DATE_RE.test(raw)) return raw;
  return null;
}

// ─── get_schedule ────────────────────────────────────────────────────────────

interface GetScheduleArgs {
  date?: string;
  department?: string;
}

registerTool<GetScheduleArgs>({
  name: 'get_schedule',
  section: 'staff',
  description:
    'Look up who is scheduled to work on a given date. Use for "who\'s working tomorrow?", "who\'s on Friday?", "quién trabaja mañana?", "is Maria working Saturday?". ' +
    'date can be "today", "tomorrow", or an ISO date (YYYY-MM-DD); defaults to today. Optionally filter by department (housekeeping/front_desk/maintenance). ' +
    'Returns each scheduled person with their hours and department, and lists anyone with approved time off that day. Only counts assigned shifts — open (unfilled) slots are reported separately.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Which day — "today", "tomorrow", or an ISO date YYYY-MM-DD. Defaults to today.' },
      department: { type: 'string', enum: ['housekeeping', 'front_desk', 'maintenance'], description: 'Optional department filter.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  // Chat-only (default). Kept off voice so the whole new ability set lands on one
  // reviewed surface; a spoken "who's working?" read can be added later.
  handler: async ({ date, department }, ctx: ToolContext): Promise<ToolResult> => {
    const target = resolveScheduleDate(date);
    if (!target) {
      return { ok: false, error: 'I couldn\'t read that date. Give me a day like "tomorrow" or a date like 2026-07-08.' };
    }
    const dept = department && (SHIFT_DEPARTMENTS as readonly string[]).includes(department) ? department : null;

    let shiftQ = supabaseAdmin
      .from('scheduled_shifts')
      .select('staff_id, department, start_time, end_time, kind, status')
      .eq('property_id', ctx.propertyId)
      .eq('shift_date', target);
    if (dept) shiftQ = shiftQ.eq('department', dept);
    const { data: shiftRows, error: shiftErr } = await shiftQ;
    if (shiftErr) return { ok: false, error: 'Failed to load the schedule.' };

    // Approved time-off for the day — surfaced so the manager sees who's OUT,
    // and so we never report someone as "working" whose day was approved off
    // after the shift row was written.
    const { data: offRows } = await supabaseAdmin
      .from('time_off_requests')
      .select('staff_id')
      .eq('property_id', ctx.propertyId)
      .eq('request_date', target)
      .eq('status', 'approved');
    const offStaffIds = new Set((offRows ?? []).map((r) => r.staff_id as string).filter(Boolean));

    // Resolve staff names in one batched read.
    const rows = shiftRows ?? [];
    const staffIds = Array.from(new Set(rows.map((r) => r.staff_id as string).filter(Boolean).concat(...offStaffIds)));
    const nameById = new Map<string, string>();
    if (staffIds.length) {
      const { data: staffRows } = await supabaseAdmin
        .from('staff')
        .select('id, name')
        .eq('property_id', ctx.propertyId)
        .in('id', staffIds);
      for (const s of staffRows ?? []) nameById.set(s.id as string, (s.name as string) ?? 'Unknown');
    }

    const working = rows
      .filter((r) => r.kind === 'shift' && r.staff_id && !offStaffIds.has(r.staff_id as string))
      .map((r) => ({
        staffId: r.staff_id as string,
        name: nameById.get(r.staff_id as string) ?? 'Unknown',
        department: (r.department as string) ?? null,
        start: (r.start_time as string) ?? null,
        end: (r.end_time as string) ?? null,
        status: (r.status as string) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const openSlots = rows.filter((r) => r.kind === 'open').length;
    const timeOff = Array.from(offStaffIds).map((id) => nameById.get(id) ?? 'Unknown').sort();

    return {
      ok: true,
      data: {
        date: target,
        department: dept,
        working,
        workingCount: working.length,
        openSlots,
        timeOff,
      },
    };
  },
});

// ─── remove_from_shift ─────────────────────────────────────────────────────

interface RemoveFromShiftArgs {
  staffName: string;
  date: string;
}

registerTool<RemoveFromShiftArgs>({
  name: 'remove_from_shift',
  section: 'staff',
  description:
    'Give a staff member a day off by removing their assigned shift on a date. Use for "give Maria Friday off", "take Carlos off Saturday", "dale el día libre a Ana el martes". ' +
    'Identify the person by name and pass the date ("tomorrow" or YYYY-MM-DD). This deletes their assigned shift for that day; it does not touch other days. Managers only.',
  inputSchema: {
    type: 'object',
    properties: {
      staffName: { type: 'string', description: 'Who to take off — a staff member\'s name (first name is enough if unique).' },
      date: { type: 'string', description: 'The day to clear — "tomorrow" or an ISO date YYYY-MM-DD.' },
    },
    required: ['staffName', 'date'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  mutates: true,
  approval: 'card',
  handler: async ({ staffName, date }, ctx: ToolContext): Promise<ToolResult> => {
    const target = resolveScheduleDate(date);
    if (!target) return { ok: false, error: 'I couldn\'t read that date. Use "tomorrow" or a date like 2026-07-08.' };

    const res = await resolveStaffByName(ctx.propertyId, staffName);
    if (res.kind === 'none') return { ok: false, error: `No active staff member matching "${staffName}".` };
    if (res.kind === 'ambiguous') {
      return {
        ok: false,
        error: `Several staff match "${staffName}": ${res.candidates.map((c) => c.name).join(', ')}. Ask the user which one, then try again with the exact name.`,
        data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, department: c.department })) },
      };
    }
    const staff = res.staff;

    // Confirm they actually have an assigned shift that day — otherwise we'd
    // approve a card that deletes nothing and the manager would think it worked.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('scheduled_shifts')
      .select('id')
      .eq('property_id', ctx.propertyId)
      .eq('staff_id', staff.id)
      .eq('shift_date', target)
      .eq('kind', 'shift');
    if (exErr) return { ok: false, error: 'Failed to look up the shift.' };
    if (!existing || existing.length === 0) {
      return { ok: false, error: `${staff.name} isn't scheduled for a shift on ${target}, so there's nothing to remove.` };
    }

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, staffName: staff.name, date: target, removed: existing.length } };
    }

    const { error: delErr } = await supabaseAdmin
      .from('scheduled_shifts')
      .delete()
      .eq('property_id', ctx.propertyId)
      .eq('staff_id', staff.id)
      .eq('shift_date', target)
      .eq('kind', 'shift');
    if (delErr) return { ok: false, error: 'Failed to remove the shift.' };

    return { ok: true, data: { staffName: staff.name, staffId: staff.id, date: target, removed: existing.length } };
  },
});

// ─── assign_shift ──────────────────────────────────────────────────────────

interface AssignShiftArgs {
  staffName: string;
  date: string;
  startTime?: string;
  endTime?: string;
  department?: string;
}

registerTool<AssignShiftArgs>({
  name: 'assign_shift',
  section: 'staff',
  description:
    'Put a staff member on the schedule for a date (add/assign a shift). Use for "put Maria on Friday", "schedule Carlos tomorrow 7am to 3pm", "pon a Ana el sábado". ' +
    'Identify the person by name and pass the date. Hours are optional — default 08:00–16:00 if not given (startTime/endTime as HH:MM, 24-hour). Department defaults to the staff member\'s own. ' +
    'If they already have a shift that day, it is updated rather than duplicated. The shift is created as a draft (visible once the manager publishes the week). Managers only.',
  inputSchema: {
    type: 'object',
    properties: {
      staffName: { type: 'string', description: 'Who to schedule — a staff member\'s name (first name is enough if unique).' },
      date: { type: 'string', description: 'The day — "tomorrow" or an ISO date YYYY-MM-DD.' },
      startTime: { type: 'string', description: 'Optional start time, HH:MM 24-hour (e.g. "07:00"). Defaults to 08:00.' },
      endTime: { type: 'string', description: 'Optional end time, HH:MM 24-hour (e.g. "15:00"). Defaults to 16:00.' },
      department: { type: 'string', enum: ['housekeeping', 'front_desk', 'maintenance'], description: 'Optional department. Defaults to the staff member\'s own.' },
    },
    required: ['staffName', 'date'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  mutates: true,
  approval: 'card',
  handler: async ({ staffName, date, startTime, endTime, department }, ctx: ToolContext): Promise<ToolResult> => {
    const target = resolveScheduleDate(date);
    if (!target) return { ok: false, error: 'I couldn\'t read that date. Use "tomorrow" or a date like 2026-07-08.' };

    const start = startTime && TIME_RE.test(startTime) ? startTime : DEFAULT_START;
    const end = endTime && TIME_RE.test(endTime) ? endTime : DEFAULT_END;

    const res = await resolveStaffByName(ctx.propertyId, staffName);
    if (res.kind === 'none') return { ok: false, error: `No active staff member matching "${staffName}".` };
    if (res.kind === 'ambiguous') {
      return {
        ok: false,
        error: `Several staff match "${staffName}": ${res.candidates.map((c) => c.name).join(', ')}. Ask the user which one, then try again with the exact name.`,
        data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, department: c.department })) },
      };
    }
    const staff = res.staff;

    // Department: explicit arg wins; else the staff member's own; else 'other'.
    const staffDept = staff.department && (SHIFT_DEPARTMENTS as readonly string[]).includes(staff.department)
      ? staff.department : null;
    const dept = (department && (SHIFT_DEPARTMENTS as readonly string[]).includes(department))
      ? department
      : (staffDept ?? 'other');

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, staffName: staff.name, date: target, start, end, department: dept } };
    }

    const row = {
      property_id: ctx.propertyId,
      staff_id: staff.id,
      department: dept,
      shift_date: target,
      start_time: start,
      end_time: end,
      kind: 'shift' as const,
    };

    // INSERT, retrying as an UPDATE on the exclusion-constraint conflict (23P01)
    // — mirrors /api/staff-schedule/shifts so a re-scheduled day overwrites the
    // existing cell instead of erroring.
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('scheduled_shifts').insert(row).select('id').single();
    if (insErr) {
      if (insErr.code === '23P01') {
        const { data: upd, error: upErr } = await supabaseAdmin
          .from('scheduled_shifts')
          .update({ department: dept, start_time: start, end_time: end })
          .eq('property_id', ctx.propertyId)
          .eq('staff_id', staff.id)
          .eq('shift_date', target)
          .eq('kind', 'shift')
          .select('id')
          .single();
        if (upErr) return { ok: false, error: 'Failed to update the shift.' };
        return {
          ok: true,
          data: { shiftId: upd.id as string, staffName: staff.name, staffId: staff.id, date: target, start, end, department: dept, updated: true },
        };
      }
      return { ok: false, error: 'Failed to add the shift.' };
    }

    return {
      ok: true,
      data: { shiftId: inserted.id as string, staffName: staff.name, staffId: staff.id, date: target, start, end, department: dept, updated: false },
    };
  },
});
