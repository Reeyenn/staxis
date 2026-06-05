// ─── Morning Turnover template ──────────────────────────────────────────────
// The flagship named template. Every morning it sizes up the day's checkouts +
// dirty rooms and, IF there's work, proposes the housekeeping assignment (for
// the GM's approval by default) plus a computed bilingual turnover summary for
// the team. If there's nothing to clean — or the PMS snapshot hasn't loaded yet
// — it degrades gracefully instead of firing meaningless actions.
//
// plan() is PURE + SYNC (no clock, no randomness, no DB, no LLM, no network):
// it reads ONLY input.scopes + input.config. That is what makes "Test on a
// date" 100% reproducible and unit-testable. The assignment intelligence (who
// cleans which rooms) is NOT here — it lives in the assign_rooms action's
// execute(); this template only decides WHETHER to assign and what to say.
//
// IMPORTANT: this module may import ONLY from '@/lib/agents/types' and
// './registry' (like custom.ts). Pulling in a scope/action/engine/config module
// would drag in `server-only` and break the unit tests under react-server.

import type {
  ActionApprovalMode,
  AgentConfig,
  AgentTemplate,
  ProposedAction,
  TemplatePlanInput,
} from '@/lib/agents/types';
import { AGENT_CONFIG_VERSION } from '@/lib/agents/types';
import { registerTemplate } from './registry';

export const MORNING_TURNOVER_TEMPLATE_KEY = 'morning-turnover';

// ── pure helpers ──────────────────────────────────────────────────────────────
// The engine stores a scope whose read() threw as { error }. rec() unwraps that
// (and any missing/garbage value) to {} so plan() never throws on a bad scope.
function rec(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !('error' in x)) return x as Record<string, unknown>;
  return {};
}
// typeof-gated on purpose (NOT Number()): keeps plan() deterministic and ignores
// stringified counts, so a future scope returning '9' can't silently change output.
function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

interface Bilingual {
  en: string;
  es: string;
}

function noWorkMessage(): Bilingual {
  // Deliberately does NOT assert "all rooms are clean" — status visibility may be
  // partial. We only claim what we can see: nothing is flagged for cleaning.
  return {
    en: 'Morning turnover: no rooms flagged for cleaning this morning — nothing to assign.',
    es: 'Preparación matutina: no hay habitaciones marcadas para limpieza esta mañana — nada que asignar.',
  };
}

function buildSummary(input: {
  roomsToClean: number;
  checkouts: number;
  checkoutsKnown: boolean;
  assignMode: ActionApprovalMode;
  staff: Record<string, unknown>;
}): Bilingual {
  const { roomsToClean, checkouts, checkoutsKnown, assignMode, staff } = input;

  const roomsEn = roomsToClean === 1 ? '1 room to turn over' : `${roomsToClean} rooms to turn over`;
  const roomsEs = roomsToClean === 1 ? '1 habitación por preparar' : `${roomsToClean} habitaciones por preparar`;

  // Checkouts come from pms.departures. When the PMS read failed/was unavailable
  // we DON'T know the figure, so we omit the clause rather than printing "(0 checkouts)".
  const checkoutEn = checkoutsKnown ? (checkouts === 1 ? ' (1 checkout)' : ` (${checkouts} checkouts)`) : '';
  const checkoutEs = checkoutsKnown ? (checkouts === 1 ? ' (1 salida)' : ` (${checkouts} salidas)`) : '';

  // Staffing signal: byDepartment.housekeeping is the uncapped roster size;
  // staff[] carries the per-member scheduledToday flag (only place both exist).
  const rosterHk = num(rec(staff.byDepartment).housekeeping);
  const staffList = Array.isArray(staff.staff) ? (staff.staff as Array<Record<string, unknown>>) : [];
  const scheduledHk = staffList.filter(
    (m) => m && m.department === 'housekeeping' && m.scheduledToday === true,
  ).length;
  const noHkOnShift = rosterHk > 0 && scheduledHk === 0;

  let tailEn: string;
  let tailEs: string;
  if (noHkOnShift) {
    tailEn = ' — but no housekeepers are on shift yet, please confirm staffing.';
    tailEs = ' — pero no hay recamareras en turno todavía, por favor confirma el personal.';
  } else {
    // The verb mirrors the CONFIGURED assign_rooms mode. It equals the engine's
    // EFFECTIVE mode only because assign_rooms is unflagged (not money/guest); if
    // it ever becomes flagged, mirror clampMode() here so the message stays honest.
    switch (assignMode) {
      case 'auto':
        tailEn = ' — assigning across the team now.';
        tailEs = ' — asignando al equipo ahora.';
        break;
      case 'approve_first':
        tailEn = ' — assignments ready for your approval.';
        tailEs = ' — asignaciones listas para tu aprobación.';
        break;
      default: // 'suggest'
        tailEn = ' — suggested assignments below.';
        tailEs = ' — asignaciones sugeridas abajo.';
        break;
    }
  }

  return {
    en: `Morning turnover: ${roomsEn}${checkoutEn}${tailEn}`,
    es: `Preparación matutina: ${roomsEs}${checkoutEs}${tailEs}`,
  };
}

// ── config ────────────────────────────────────────────────────────────────────
const defaultConfig: AgentConfig = {
  version: AGENT_CONFIG_VERSION,
  trigger: { type: 'schedule', atLocalTime: '08:00' }, // every day (daysOfWeek omitted)
  scopes: ['rooms', 'staff', 'schedule', 'pms'],
  actions: ['assign_rooms', 'notify_manager'],
  approvalRules: {
    moneyOrGuestRequiresApproval: true,
    defaultMode: 'suggest',
    // Trust-first: the GM reviews the morning assignment before it commits. They
    // can flip assign_rooms to Auto in the wizard once comfortable.
    perAction: { assign_rooms: 'approve_first', notify_manager: 'auto' },
  },
};

// ── template ──────────────────────────────────────────────────────────────────
export const morningTurnoverTemplate: AgentTemplate = {
  key: MORNING_TURNOVER_TEMPLATE_KEY,
  defaultConfig,
  requiredScopes: ['rooms', 'staff', 'schedule', 'pms'],
  plan(input: TemplatePlanInput): ProposedAction[] {
    const rooms = rec(input.scopes.rooms);
    const pms = rec(input.scopes.pms);
    const schedule = rec(input.scopes.schedule);
    const staff = rec(input.scopes.staff);

    const cleaningTasks = num(schedule.totalTasks);
    const byStatus = rec(rooms.byStatus);
    const dirty = num(byStatus.dirty) + num(byStatus.in_progress); // the RoomStatus "needs cleaning" set
    const checkouts = num(pms.departures);

    // Did we actually see the PMS feed? (checked against the RAW value, pre-rec)
    const pmsRaw = input.scopes.pms;
    const checkoutsKnown =
      !!pmsRaw &&
      typeof pmsRaw === 'object' &&
      !('error' in pmsRaw) &&
      (pmsRaw as Record<string, unknown>).unavailable !== true;

    // max() — not sum() — so we never double-count and the shown checkouts can
    // never exceed the shown rooms (checkouts <= roomsToClean by construction).
    const roomsToClean = Math.max(cleaningTasks, dirty, checkouts);

    // Readiness honors EVERY signal the count uses: a snapshot that failed to load
    // can't surface dirty/checkouts/tasks, so this never "proposes on empty", and
    // a known checkout/dirty figure is never silently dropped to a no-op.
    const dataReady = num(rooms.total) > 0 || cleaningTasks > 0 || checkouts > 0 || dirty > 0;
    if (!dataReady) return []; // snapshot not loaded yet → silent no-op (scope caveats ride in run.approximations)

    if (roomsToClean <= 0) {
      // Data is ready but nothing is flagged for cleaning. One proof-of-life post
      // so the GM knows the agent ran (rare in practice — hotels almost always
      // have checkouts). Flip to `return []` if silent clean-mornings are preferred.
      const m = noWorkMessage();
      return [
        {
          actionKey: 'notify_manager',
          payload: { message: m.en, messageEs: m.es },
          reason: {
            en: 'Morning turnover check — nothing to assign',
            es: 'Revisión de preparación matutina — nada que asignar',
          },
        },
      ];
    }

    const rules = input.config.approvalRules;
    const assignMode: ActionApprovalMode = rules.perAction['assign_rooms'] ?? rules.defaultMode;
    const msg = buildSummary({ roomsToClean, checkouts, checkoutsKnown, assignMode, staff });

    // assign_rooms first (queued for approval by default), then the auto summary.
    // payload {} = assign all floors; the action recomputes the real assignment
    // off cleaning_tasks in execute() — we only decide WHETHER to assign.
    return [
      {
        actionKey: 'assign_rooms',
        payload: {},
        reason: {
          en: "Assign this morning's cleaning across the housekeeping team",
          es: 'Asignar la limpieza de esta mañana al equipo de limpieza',
        },
      },
      {
        actionKey: 'notify_manager',
        payload: { message: msg.en, messageEs: msg.es },
        reason: {
          en: 'Morning turnover summary for the team',
          es: 'Resumen de preparación matutina para el equipo',
        },
      },
    ];
  },
};

registerTemplate({
  template: morningTurnoverTemplate,
  name: { en: 'Morning Turnover', es: 'Preparación matutina' },
  description: {
    en: "Every morning, sizes up the day's checkouts and dirty rooms, proposes the housekeeping assignment for your approval, and posts a turnover summary to the team.",
    es: 'Cada mañana evalúa las salidas y habitaciones sucias del día, propone la asignación de limpieza para tu aprobación y publica un resumen de preparación al equipo.',
  },
});
