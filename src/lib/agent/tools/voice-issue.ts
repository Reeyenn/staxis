// ─── createMaintenanceWorkOrder — housekeeper voice issue tool ───────────
//
// Feature #11 + 2026-05-25 unification. A housekeeper taps the mic on a
// room card, speaks the issue in any of EN/ES/HT/TL/VI; ElevenLabs
// transcribes; Claude extracts structured fields; this tool writes the
// row directly into pms_work_orders_v2 — the canonical maintenance table.
//
// History: feature #11 (migration 0218) originally wrote to a separate
// staxis_voice_issues table because the CUA reconciles pms_work_orders_v2
// as a full snapshot of the PMS feed — any row not in the next sync gets
// auto-resolved (cua-service/src/persistence/generic-table-writer.ts
// writeReconcile). A Staxis-originated row had no PMS counterpart and
// would have flipped to 'resolved' 30s later.
//
// Migration 0225 closed that gap by:
//   1. Adding `source` to pms_work_orders_v2 (default 'pms_sync').
//   2. Teaching the CUA reconciler to scope auto-resolve to
//      `source = 'pms_sync'`. Voice-originated rows are now invisible to
//      the reconciliation pass.
//   3. Backfilling existing staxis_voice_issues into pms_work_orders_v2
//      and dropping the legacy table.
//
// Scope:
//   - VOICE surface only, and only in voice mode 'housekeeper_issue'. The
//     same call signature is unreachable from the chat surface or from the
//     general voice catalog — see `voiceModes` declaration below + the
//     belt-and-braces gate in executeTool().
//   - We also mirror the spoken note into rooms.issue_note when a matching
//     room exists, so the housekeeper sees the issue surface on the room
//     card without having to wait on the maintenance dashboard. This
//     re-uses the existing `flag_issue` rendering path.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { findRoomByNumber, assertFloorRoleCanMutateRoom } from './_helpers';
import { applyRoomUpdate } from '@/lib/pms-rooms-writes';

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
  section: 'maintenance',
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
  approval: 'card',
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

    // ─── 4. Insert into pms_work_orders_v2 ──────────────────────────────
    // Idempotency: the voice-session id is the anchor. If the agent fires
    // this tool twice within one session (model retry, webhook retry, double
    // model output, etc.), the partial unique index on (voice_session_id)
    // refuses the second insert with a 23505 unique_violation. We swallow
    // that and fetch the already-stored row so the caller sees ONE ticket
    // per session.
    //
    // pms_work_order_id is set to a deterministic 'staxis-voice-<uuid>' so
    // it's both unique per property (the canonical natural key) AND stable
    // across retries within the same session.
    //
    // Severity → priority mapping (pms_work_orders_v2 priority enum is
    // 'urgent'|'high'|'medium'|'low'). MAJOR is defined in the prompt as
    // "in-room equipment broken" — that needs to land on the high-priority
    // queue so the manager's dashboard treats broken AC / TV / fridge the
    // same as the PMS-reported `high` priority work orders. Codex
    // 2026-05-25 adversarial gate (MAJOR fix): the prior MAJOR→medium
    // mapping silently dropped broken equipment out of
    // `src/lib/reports/aggregate.ts:339-342`'s critical-pending count
    // (which only sums urgent + high).
    //    URGENT  → urgent
    //    MAJOR   → high
    //    MINOR   → low
    const voiceSessionId = ctx.voiceSessionId ?? null;
    const pmsWorkOrderId = voiceSessionId
      ? `staxis-voice-${voiceSessionId}`
      // No session id (test / dev path) — fall back to a per-call random id
      // so the natural-key index doesn't reject the row.
      : `staxis-voice-adhoc-${crypto.randomUUID()}`;

    const priority =
      severity === 'URGENT' ? 'urgent' :
      severity === 'MAJOR'  ? 'high'   :
                              'low';

    // Description: "REPAIR sink (bathroom) — water leaking" style. The
    // maintenance team sees this on the first row hit; the structured
    // fields live in voice_metadata for any UI that wants to render them.
    const descriptionParts: string[] = [`${action} ${item}`];
    if (locationDetail) descriptionParts[0] += ` (${locationDetail})`;
    if (note)           descriptionParts.push(note);
    const description = descriptionParts.join(' — ').slice(0, 1000);

    const reportedBy = ctx.user.displayName || ctx.user.username || 'Housekeeper voice report';
    const nowIso = new Date().toISOString();

    const insertPayload = {
      property_id: ctx.propertyId,
      pms_work_order_id: pmsWorkOrderId,
      room_number: resolvedRoomNumber,
      description,
      priority,
      status: 'open',
      reported_by: reportedBy,
      reported_at: nowIso,
      source: 'housekeeper_voice',
      voice_session_id: voiceSessionId,
      voice_metadata: {
        action,
        item,
        location_detail: locationDetail,
        severity,
        note,
        original_language: originalLanguage,
        original_transcription: originalTranscription,
        voice_clip_path: voiceClipPath,
        staff_id: ctx.staffId,
        account_id: ctx.user.accountId,
      },
    };

    const { data, error } = await supabaseAdmin
      .from('pms_work_orders_v2')
      .insert(insertPayload)
      .select('id')
      .single();

    let issueId: string | null = null;
    let idempotent = false;
    // Effective fields for the response. On the happy path these are the
    // same as what we just inserted; on the idempotent path they are the
    // STORED values from the first call so a retried call that changed
    // its mind (different action / room / severity) doesn't get a
    // response lying about what's actually in the DB.
    // Codex 2026-05-25 adversarial gate (MAJOR fix): the previous version
    // returned the retry's caller-supplied fields after a 23505 — the
    // agent or UI would then speak "ticket filed for X" while the DB
    // recorded Y.
    let respRoomNumber: string | null = resolvedRoomNumber;
    let respAction: IssueAction = action;
    let respItem: string = item;
    let respLocationDetail: string | null = locationDetail;
    let respSeverity: IssueSeverity = severity;
    let respNote: string | null = note;
    let respOriginalLanguage: string | null = originalLanguage;
    if (error) {
      const code = (error as { code?: string }).code;
      // 23505 = Postgres unique_violation. Two indexes can fire it here:
      //   (a) the partial unique index on (voice_session_id), or
      //   (b) the canonical unique index on (property_id, pms_work_order_id).
      // Both branches mean "this voice session already produced a ticket" —
      // look it up by voice_session_id, hydrate response fields from
      // the stored row, and return. If we don't have a session id (test
      // / dev path), the conflict is the natural-key one and we can't
      // recover — surface a hard error.
      if (code === '23505' && voiceSessionId) {
        const { data: existing, error: lookupErr } = await supabaseAdmin
          .from('pms_work_orders_v2')
          .select('id, room_number, voice_metadata')
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
        const storedMeta = (existing.voice_metadata ?? {}) as {
          action?: string;
          item?: string;
          location_detail?: string | null;
          severity?: string;
          note?: string | null;
          original_language?: string | null;
        };
        respRoomNumber = (existing.room_number as string | null) ?? respRoomNumber;
        if (storedMeta.action && ACTION_VALUES.includes(storedMeta.action as IssueAction)) {
          respAction = storedMeta.action as IssueAction;
        }
        if (typeof storedMeta.item === 'string' && storedMeta.item.length > 0) {
          respItem = storedMeta.item;
        }
        respLocationDetail = (storedMeta.location_detail as string | null) ?? null;
        if (storedMeta.severity && SEVERITY_VALUES.includes(storedMeta.severity as IssueSeverity)) {
          respSeverity = storedMeta.severity as IssueSeverity;
        }
        respNote = (storedMeta.note as string | null) ?? null;
        respOriginalLanguage = (storedMeta.original_language as string | null) ?? null;
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
    // Never overwrite a non-empty issue_note. If a prior issue was already
    // flagged on the room, last-writer-wins would silently hide it from
    // the housekeeper UI even though both tickets exist in
    // pms_work_orders_v2. We only write the mirror when the column is
    // null/empty, and we skip the mirror entirely when the insert was
    // idempotent (the same session's first call already mirrored). For
    // "second different issue on the same room" the maintenance dashboard
    // reads the canonical list from pms_work_orders_v2 — the room card
    // just shows the first hint.
    if (resolvedRoomNumber && !idempotent) {
      const summary = locationDetail
        ? `${action.toLowerCase()} ${item} (${locationDetail})`
        : `${action.toLowerCase()} ${item}`;
      const noteForCard = (`${summary}${note ? ` — ${note}` : ''}`).slice(0, 500);
      const room = await findRoomByNumber(ctx.propertyId, resolvedRoomNumber);
      if (room && !(room.issue_note && room.issue_note.trim().length > 0)) {
        // Mirror onto pms_housekeeping_assignments.issue_note (best-effort).
        await applyRoomUpdate(ctx.propertyId, room.id, { issueNote: noteForCard }).catch(
          () => undefined,
        );
      }
    }

    return {
      ok: true,
      data: {
        issue_id: issueId,
        // True when this call hit the unique index — i.e. the session
        // already had a ticket and we returned the existing one rather
        // than creating a second. The agent can mention "already filed"
        // instead of "created" if it cares. When idempotent=true the
        // fields below describe the STORED ticket, not whatever the
        // retried call passed in.
        idempotent,
        room_number: respRoomNumber,
        action: respAction,
        item: respItem,
        location_detail: respLocationDetail,
        severity: respSeverity,
        note: respNote,
        original_language: respOriginalLanguage,
      },
    };
  },
});
