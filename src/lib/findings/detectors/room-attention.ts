// ─── Detector: a room needs someone right now ────────────────────────────────
//
// Ports the nudge layer's operational alerts (`checkOperationalAlerts` in
// src/lib/agent/nudges.ts) into the one runner WITHOUT touching that module.
// The nudge cron keeps inserting agent_nudges rows exactly as before — this
// detector never writes one — so what a manager receives is byte-identical.
// What changes is that the same condition now also leaves a durable trace, so
// "room 214 ran long again" can be counted over weeks instead of vanishing the
// moment the notification was read.
//
// Everything about the DATA'S CLOCK is inherited, not re-implemented: the nudge
// layer already refuses to speak when the PMS feed is older than one report
// cycle and already measures elapsed time against the report's capture time
// (INV-34). Re-deriving any of that here would be a second, drifting copy of
// the rule that stops false alarms during an ingestion outage.

import { registerDetector } from '../registry';
import type {
  Detector,
  DetectorContext,
  DetectorParams,
  FindingDraft,
  FindingSeverity,
  JsonValue,
  NudgeDraftFeed,
} from '../types';
import { readFeed } from '../types';

const RECEIPT = 'nudge_operational_alerts';

/** The nudge layer's three levels, in the ledger's vocabulary. */
const SEVERITY: Record<string, FindingSeverity> = {
  urgent: 'critical',
  warning: 'attention',
  info: 'info',
};

function numberFrom(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return null;
}

export function draftsFromNudges(drafts: NudgeDraftFeed, businessDate: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const draft of drafts) {
    const payload = draft.payload as Record<string, unknown>;
    const type = typeof payload.type === 'string' ? payload.type : 'operational_alert';
    const room = typeof payload.roomNumber === 'string' ? payload.roomNumber : 'unknown';
    const summary = typeof payload.summary === 'string' ? payload.summary : `${type} on room ${room}`;
    const minutes = numberFrom(payload, 'minutesElapsed', 'minutesAgo');
    const asOfRaw = typeof payload.asOf === 'string' ? payload.asOf : null;
    const asOf = asOfRaw ? new Date(asOfRaw) : null;

    out.push({
      // Identity is (what, which room, which day). A room running long today
      // and running long tomorrow are two events, not one ongoing problem —
      // and staleAfterDays retires each one the day after.
      key: `${type}:${businessDate}:${room}`,
      summary,
      severity: SEVERITY[draft.severity] ?? 'attention',
      magnitude: minutes ?? 1,
      evidence: {
        queryId: RECEIPT,
        params: { business_date: businessDate, room_number: room, alert_type: type },
        values: {
          minutes: minutes,
          nudge_severity: draft.severity,
          staff_name: (payload.staffName as JsonValue) ?? null,
        },
        basis: summary,
        // WHICH room, in the shape the room's own screen can look up. Omitted
        // when the nudge did not name one: 'unknown' is this function's
        // placeholder for a missing room, and claiming a target of "unknown"
        // would put a chip on nothing — or, worse, on a room a hotel really
        // did name "unknown".
        target: room === 'unknown' ? null : { kind: 'room', value: room },
      },
      asOf: asOf && !Number.isNaN(asOf.getTime()) ? asOf : null,
      price: null,
    });
  }
  return out;
}

export const roomAttentionDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'room_needs_attention',
    description:
      'A room has been in progress far longer than a clean usually takes, or a help request is still unanswered.',
    inputs: ['nudge_drafts'],
    requires: [
      {
        feed: 'nudge_drafts',
        minRecords: 0,
        because:
          'the room-status feed is missing or older than one report cycle, so nothing about today can be said honestly',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'recommend',
    defaultSeverity: 'attention',
    // A single day's event. Silencing it is a same-day decision and there is
    // nothing to escalate into — tomorrow brings a different problem key.
    escalation: null,
    maxPerRun: 25,
    staleAfterDays: 1,
    evalCases: [
      {
        name: 'an overdue room becomes one finding for that room on that day',
        feeds: {
          nudge_drafts: [
            {
              severity: 'warning',
              payload: {
                summary: 'Room 214 has been in progress for 120 min. Usually takes ~25 min.',
                type: 'overdue_room',
                roomNumber: '214',
                staffName: 'Maria',
                minutesElapsed: 120,
              },
              dedupeKey: 'overdue_room:pid:2026-07-25:214',
            },
          ],
        },
        businessDate: '2026-07-25',
        expectKeys: ['overdue_room:2026-07-25:214'],
        expectMagnitude: { 'overdue_room:2026-07-25:214': 120 },
      },
      {
        name: 'a stale or empty feed produces nothing rather than a guess',
        feeds: { nudge_drafts: [] },
        expectKeys: [],
      },
    ],
  },
  detect(ctx: DetectorContext): FindingDraft[] {
    return draftsFromNudges(readFeed(ctx, 'nudge_drafts'), ctx.businessDate);
  },
};

registerDetector(roomAttentionDetector);
