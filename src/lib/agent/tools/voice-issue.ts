// ─── createMaintenanceWorkOrder — housekeeper voice issue tool ───────────
//
// Feature #11. A housekeeper taps the mic on a room card, speaks the issue
// in any of EN/ES/HT/TL/VI; ElevenLabs transcribes; Claude extracts
// structured fields; this tool writes the row.
//
// Scope:
//   - VOICE surface only, and only in voice mode 'housekeeper_issue'. The
//     same call signature is unreachable from the chat surface or from the
//     general voice catalog — see `voiceModes` declaration below + the
//     belt-and-braces gate in executeTool().
//   - We DO NOT write to pms_work_orders_v2. That table is a reconciled
//     snapshot of the PMS feed (cua-service/src/recipe-adapter.ts:165 sets
//     writeStrategy='reconcile' which auto-resolves any row that disappears
//     from the next 30s sync). A Staxis-originated ticket has no PMS
//     counterpart and would silently flip to 'resolved' on the very next
//     poll. Instead we write to public.staxis_voice_issues — a dedicated
//     table that the CUA never touches (migration 0214).
//   - We ALSO mirror the spoken note into rooms.issue_note when a matching
//     room exists, so the housekeeper sees the issue surface on the room
//     card without having to wait on the maintenance dashboard. This
//     re-uses the existing `flag_issue` rendering path.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber, assertFloorRoleCanMutateRoom } from './_helpers';

const ACTION_VALUES = ['REPAIR', 'REPLACE', 'CLEAN', 'INSPECT'] as const;
const SEVERITY_VALUES = ['MINOR', 'MAJOR', 'URGENT'] as const;

type IssueAction = (typeof ACTION_VALUES)[number];
type IssueSeverity = (typeof SEVERITY_VALUES)[number];

interface CreateMaintenanceWorkOrderArgs {
  room_number?: string;
  action: IssueAction;
  item: string;
  location_detail?: string;
  severity?: IssueSeverity;
  note?: string;
  original_language?: string;
  original_transcription?: string;
  voice_clip_url?: string | null;
}

// Trim + cap helpers. Voice transcriptions can ramble; we don't want a
// 50 KB hallucination ending up in a maintenance ticket.
function capString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

registerTool<CreateMaintenanceWorkOrderArgs>({
  name: 'createMaintenanceWorkOrder',
  description:
    'Create a maintenance work order from a housekeeper voice report. ' +
    'CALL THIS at the end of every issue conversation — never just acknowledge verbally without creating a ticket. ' +
    'Extract the structured fields from what the housekeeper said: ' +
    'action (REPAIR/REPLACE/CLEAN/INSPECT), item (e.g. "sink", "TV", "lamp"), ' +
    'location_detail (e.g. "bathroom", "above the bed"), severity (MINOR/MAJOR/URGENT), and a short note. ' +
    'Always include `original_language` (the BCP-47 code or English name of the language they spoke in — "tl", "es", "Tagalog") ' +
    'and `original_transcription` (their exact words, verbatim) so the maintenance team has the audit trail. ' +
    'If `room_number` is omitted, it falls back to the room hint from the UI. ' +
    'After this fires, confirm in ONE short sentence in the housekeeper\'s own language — e.g. ' +
    '"Maintenance ticket created for room 305: broken sink in bathroom, marked urgent."',
  inputSchema: {
    type: 'object',
    properties: {
      room_number: {
        type: 'string',
        description:
          'Room number. Optional — defaults to the room hint from the UI when omitted. ' +
          'Digits/letters/hyphens (e.g. "302", "PH-1").',
      },
      action: {
        type: 'string',
        enum: [...ACTION_VALUES],
        description: 'What needs to happen. REPAIR (broken thing), REPLACE (worn out), CLEAN (stain/spill), INSPECT (might be wrong).',
      },
      item: {
        type: 'string',
        description: 'What the problem is with — sink, TV, lamp, AC, towel rack, etc.',
      },
      location_detail: {
        type: 'string',
        description: 'Where in the room — bathroom, above the bed, by the window, etc.',
      },
      severity: {
        type: 'string',
        enum: [...SEVERITY_VALUES],
        description: 'How urgent. MINOR (cosmetic), MAJOR (in-room equipment broken), URGENT (water leak, no power, safety risk).',
      },
      note: {
        type: 'string',
        description: 'Short free-text note in the property\'s working language (English unless told otherwise). Max ~300 chars.',
      },
      original_language: {
        type: 'string',
        description: 'BCP-47 code or English name of the language the housekeeper spoke (e.g. "tl", "es", "Tagalog"). Helps the maintenance team know which language the transcription is in.',
      },
      original_transcription: {
        type: 'string',
        description: 'The exact transcribed text in the original language, verbatim. Audit trail for the maintenance team.',
      },
      voice_clip_url: {
        type: 'string',
        description: 'Storage path to the original voice clip. Optional — pass null if the audio wasn\'t captured.',
      },
    },
    required: ['action', 'item'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'housekeeping', 'front_desk', 'maintenance'],
  surfaces: ['voice'],
  voiceModes: ['housekeeper_issue'],
  mutates: true,
  handler: async (args, ctx): Promise<ToolResult> => {
    // ─── 1. Resolve room number ─────────────────────────────────────────
    // Prefer the argument; fall back to the UI hint from session mint.
    // Either path is fine — the agent should consult the hint when the
    // housekeeper doesn't restate it (e.g. mic was tapped on room 305's
    // card, they say "the sink is broken" — we know they mean 305).
    const argRoom = capString(args.room_number, 32);
    const hintRoom = capString(ctx.currentRoomNumber ?? null, 32);
    const roomNumber = argRoom ?? hintRoom;

    // ─── 2. Validate action + severity (defensive — schema enums catch
    // most, but the agent occasionally hallucinates an unlisted value).
    const action: IssueAction | null = args.action && ACTION_VALUES.includes(args.action)
      ? args.action
      : null;
    if (!action) {
      return { ok: false, error: 'action must be one of REPAIR, REPLACE, CLEAN, INSPECT.' };
    }
    const severity: IssueSeverity = args.severity && SEVERITY_VALUES.includes(args.severity)
      ? args.severity
      : 'MINOR';

    const item = capString(args.item, 80);
    if (!item) {
      return { ok: false, error: 'item is required — what the problem is with (e.g. "sink", "TV").' };
    }
    const locationDetail = capString(args.location_detail, 120);
    const note = capString(args.note, 300);
    const originalLanguage = capString(args.original_language, 32);
    const originalTranscription = capString(args.original_transcription, 1000);
    const voiceClipPath = capString(args.voice_clip_url ?? null, 500);

    // ─── 3. Floor-role scope check ──────────────────────────────────────
    // Mirrors flag_issue: a housekeeper can only report against a room
    // they're assigned to. Manager-tier roles bypass via
    // assertFloorRoleCanMutateRoom returning null.
    //
    // Codex 2026-05-25 adversarial gate (MAJOR fix): the previous version
    // fell through and wrote a ticket whenever findRoomByNumber returned
    // null (vacant rooms outside the seeded set). A housekeeper could
    // therefore file arbitrary made-up room numbers within their property.
    // Now: for floor roles, an unresolvable room number is a hard refusal.
    // Manager-tier roles can still file for rooms not in the rooms table.
    const isFloorRole = ctx.user.role === 'housekeeping' || ctx.user.role === 'maintenance';
    let resolvedRoomNumber: string | null = roomNumber;
    if (roomNumber) {
      const room = await findRoomByNumber(ctx.propertyId, roomNumber);
      if (room) {
        const scopeError = assertFloorRoleCanMutateRoom(room, ctx);
        if (scopeError) return { ok: false, error: scopeError };
        resolvedRoomNumber = room.number;
      } else if (isFloorRole) {
        return {
          ok: false,
          error: `Room ${roomNumber} isn't on your assignment list. Ask the user to double-check the room number.`,
        };
      }
      // Manager-tier roles fall through with the raw room number.
    } else if (isFloorRole) {
      // Floor role with no room number AND no UI hint — we can't scope
      // the ticket. Refuse rather than file a roomless issue under their
      // identity.
      return {
        ok: false,
        error: 'Please confirm which room the issue is in.',
      };
    }

    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          dryRun: true,
          room_number: resolvedRoomNumber,
          action,
          item,
          location_detail: locationDetail,
          severity,
          note,
        },
      };
    }

    // ─── 4. Insert into staxis_voice_issues ─────────────────────────────
    // Codex 2026-05-25 adversarial gate (MAJOR fix): the voice-session id
    // is the idempotency anchor. If the agent fires this tool twice within
    // one session (model retry, webhook retry, double model output, etc.),
    // the partial unique index on (voice_session_id) refuses the second
    // insert with a 23505 unique_violation. We swallow that and fetch the
    // already-stored row so the caller sees ONE ticket per session.
    const voiceSessionId = ctx.voiceSessionId ?? null;
    const insertPayload = {
      property_id: ctx.propertyId,
      staff_id: ctx.staffId,
      account_id: ctx.user.accountId,
      voice_session_id: voiceSessionId,
      conversation_id: null, // voice-brain doesn't pass conversationId into ToolContext today; future enhancement
      room_number: resolvedRoomNumber,
      action,
      item,
      location_detail: locationDetail,
      severity,
      note,
      original_language: originalLanguage,
      original_transcription: originalTranscription,
      voice_clip_path: voiceClipPath,
      status: 'open',
    };
    const { data, error } = await supabaseAdmin
      .from('staxis_voice_issues')
      .insert(insertPayload)
      .select('id')
      .single();
    let issueId: string | null = null;
    let idempotent = false;
    if (error) {
      const code = (error as { code?: string }).code;
      // 23505 = Postgres unique_violation. Only the per-session partial
      // unique index can fire here (we don't declare any other unique
      // constraints), so this branch is the "agent fired the tool twice"
      // case — fetch the already-stored row instead of a hard error.
      if (code === '23505' && voiceSessionId) {
        const { data: existing, error: lookupErr } = await supabaseAdmin
          .from('staxis_voice_issues')
          .select('id')
          .eq('voice_session_id', voiceSessionId)
          .maybeSingle();
        if (lookupErr || !existing) {
          return {
            ok: false,
            error: `Failed to create the maintenance ticket (duplicate detected but lookup failed): ${lookupErr?.message ?? 'no row'}`,
          };
        }
        issueId = existing.id as string;
        idempotent = true;
      } else {
        return {
          ok: false,
          error: `Failed to create the maintenance ticket: ${error.message ?? 'no row returned'}`,
        };
      }
    } else if (!data) {
      return { ok: false, error: 'Failed to create the maintenance ticket: no row returned' };
    } else {
      issueId = data.id as string;
    }

    // ─── 5. Mirror onto rooms.issue_note so the housekeeper sees it ─────
    // Re-uses the existing rooms.issue_note rendering. Best-effort: if the
    // mirror write fails the ticket still exists, so we don't bubble the
    // error up. The "ticket created" feedback comes from the verbal
    // confirmation either way.
    //
    // Codex 2026-05-25 adversarial gate (MAJOR fix): never overwrite a
    // non-empty issue_note. If a prior issue was already flagged on the
    // room, last-writer-wins would silently hide it from the housekeeper
    // UI even though both tickets exist in staxis_voice_issues. We only
    // write the mirror when the column is null/empty, and we skip the
    // mirror entirely when the insert was idempotent (the same session's
    // first call already mirrored). For "second different issue on the
    // same room" the maintenance dashboard reads the canonical list from
    // staxis_voice_issues — the room card just shows the first hint.
    if (resolvedRoomNumber && !idempotent) {
      const summary = locationDetail
        ? `${action.toLowerCase()} ${item} (${locationDetail})`
        : `${action.toLowerCase()} ${item}`;
      const noteForCard = (`${summary}${note ? ` — ${note}` : ''}`).slice(0, 500);
      const room = await findRoomByNumber(ctx.propertyId, resolvedRoomNumber);
      if (room && !(room.issue_note && room.issue_note.trim().length > 0)) {
        await supabaseAdmin
          .from('rooms')
          .update({ issue_note: noteForCard })
          .eq('id', room.id);
      }
    }

    return {
      ok: true,
      data: {
        issue_id: issueId,
        // True when this call hit the unique index — i.e. the session
        // already had a ticket and we returned the existing one rather
        // than creating a second. The agent can mention "already filed"
        // instead of "created" if it cares.
        idempotent,
        room_number: resolvedRoomNumber,
        action,
        item,
        location_detail: locationDetail,
        severity,
        note,
        original_language: originalLanguage,
      },
    };
  },
});
