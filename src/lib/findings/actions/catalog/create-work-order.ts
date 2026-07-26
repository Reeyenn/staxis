// ─── Action: put a work order on the maintenance board ───────────────────────
//
// The fix for "Room 214 has had four work orders in the last thirty days".
// Individually every one of those tickets was a small job; together they are a
// room nobody has looked at as a whole. This action puts exactly that on the
// board: one work order asking for a full inspection of the location.
//
// WHY THIS ONE IS SAFE TO OFFER
//   • it costs nothing — no order is placed, no money moves, no vendor is called
//   • it belongs to the department that owns the problem: maintenance, not
//     housekeeping, and nothing here writes back to a PMS
//   • the worst case is a job nobody needed on the board, which a manager can
//     mark done in one tap
//   • and it comes back: see UNDO below
//
// UNDO REMOVES THE ROW STAXIS CREATED — AND ONLY WHILE IT IS UNTOUCHED.
// The alternative was to mark it 'resolved', because that is what the board's
// two-status vocabulary offers (types/index.ts: open ↔ 'submitted',
// done ↔ 'resolved'). That would put a job NOBODY DID into the hotel's
// completed-maintenance history, where it would go on to skew the repair-cost
// samples and the per-asset history forever. Deleting the untouched row Staxis
// itself wrote is the honest reversal, and nothing is lost: `finding_actions`
// keeps the full receipt of what was created, when, and who approved it. The
// moment a human touches the ticket — assigns it, works it, prices it, closes
// it — the undo REFUSES and says so (migration 0363). Staxis undoes its own
// suggestion; it does not erase somebody's work.
//
// THE DESCRIPTION IS ENGLISH, ON PURPOSE.
// It lands in `work_orders.description`, a shared operational record read by
// whoever picks the job up, alongside every other ticket at this hotel — which
// staff type in English. The CARD is bilingual (label/offer/receiptLine below);
// the row is not, because a Spanish description on an otherwise-English board
// would be a translation nobody asked for in a column nobody can re-render.

import { registerAction } from '../registry';
import type {
  ActionDefinition,
  ActionParams,
  ActionReceipt,
  Bilingual,
  PostConditionResult,
} from '../types';

/** How long to wait before asking whether it helped. Two weeks: long enough for
 *  an inspection to have been done, short enough that the answer still relates
 *  to the finding that prompted it. */
export const WORK_ORDER_OUTCOME_DAYS = 14;

export interface CreateWorkOrderParams extends ActionParams {
  /** Free-text location exactly as the board stores it: "Room 214", "Lobby". */
  location: string;
  /** What the ticket asks for. Deliberately free of the measurement — see the
   *  note on stability in actions/store.ts. */
  description: string;
  severity: 'urgent' | 'medium' | 'low';
  submitted_by_name: string;
  submitter_role: string;
  outcome_check_days: number;
}

/**
 * The two extra keys a PREVENTIVE plan carries, on top of the shape above.
 *
 * ONE ACTION KIND, TWO REASONS TO WRITE A TICKET. A second
 * `create_pm_work_order` kind would have meant a second execute branch, a second
 * undo branch, a second validate and a second set of copy — four places for "put
 * a work order on the board" to drift from itself. What actually differs between
 * the two is the SENTENCE and what has to still be true at the tap, and both of
 * those are already per-plan rather than per-kind.
 *
 * `preventive_task_id` is frozen in `params` rather than re-derived at execution
 * because it lands in `work_orders.preventive_task_id`, and that link is what
 * makes closing the ticket stamp the schedule done (migration 0366). A link
 * recomputed at execution time would be a link the manager was never shown.
 *
 * ═══ WHY THESE ARE NOT OPTIONAL FIELDS ON `CreateWorkOrderParams` ═══
 * `ActionParams` is `Record<string, JsonValue>`, and an optional property's type
 * includes `undefined`, which is not a `JsonValue` — so `preventive_task_id?:
 * string` does not typecheck against that index signature at all.
 *
 * Declaring them REQUIRED-and-nullable would have typechecked, and would have
 * been worse: every repeat-location plan would then carry two extra null keys,
 * which changes its `params` json, which changes the fingerprint the database
 * computes from it — and every standing untapped offer at every hotel would be
 * superseded and re-proposed on the next run for no reason anybody could see.
 * Keeping the base shape byte-identical means the plans already frozen out there
 * stay frozen.
 *
 * The keys are still perfectly real at runtime: `params` is a jsonb blob, the
 * builder below writes them, `validate` checks them, and the copy reads them
 * through `str()` — the same accessor validation already uses.
 */
export interface PreventiveWorkOrderExtras {
  preventive_task_id: string;
  preventive_task_name: string;
}

const MAX_LOCATION = 120;
const MAX_DESCRIPTION = 400;
const SEVERITIES = new Set(['urgent', 'medium', 'low']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(params: ActionParams, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** True when this plan is a preventive-schedule ticket rather than a repeat-location one. */
function isPreventive(params: ActionParams): boolean {
  return str(params, 'preventive_task_id') !== '';
}

/**
 * Build the frozen plan for one location.
 *
 * `description` carries no count on purpose. The measurement belongs in
 * `verify` (where it is re-checked) and on the card (where it is re-rendered
 * from the live finding). Baking "4 work orders" into the ticket would mean a
 * fifth work order tomorrow produced a DIFFERENT plan for the same problem,
 * and the one-live-offer-per-finding index would then churn a new proposal
 * every night — the exact stacking the whole ledger exists to prevent.
 */
export function createWorkOrderParams(location: string): CreateWorkOrderParams {
  const where = location.trim().slice(0, MAX_LOCATION);
  return {
    location: where,
    description:
      `Full inspection of ${where}. Staxis noticed repeat maintenance here — ` +
      'worth looking at the location as a whole rather than one fault at a time.',
    severity: 'medium',
    submitted_by_name: 'Staxis',
    submitter_role: 'Staxis',
    outcome_check_days: WORK_ORDER_OUTCOME_DAYS,
  };
}

/**
 * The frozen plan for one upkeep schedule that has come due.
 *
 * STABLE ACROSS NIGHTS WITHIN ONE CYCLE, which is the property that matters
 * most here. `proposeAction` supersedes the standing offer and writes a new one
 * whenever the plan changes, so anything that moved daily — days overdue, "3
 * weeks late" — would churn a fresh proposal every night for the same problem.
 * Everything below is either constant or fixed until the task is actually done:
 * the name, the area, the cadence, the date it was due. The lateness lives on
 * the card, which re-renders from the live finding, and in `verify`, which is
 * re-checked rather than displayed.
 *
 * The description is ENGLISH for the same reason the repeat-location one is: it
 * lands in `work_orders.description`, a shared board that this hotel's staff
 * type into in English. The CARD is bilingual.
 */
export function createPreventiveWorkOrderParams(args: {
  taskId: string;
  taskName: string;
  area: string | null;
  frequencyDays: number;
  lastDoneDate: string | null;
  dueDate: string;
}): CreateWorkOrderParams & PreventiveWorkOrderExtras {
  const name = args.taskName.trim().slice(0, MAX_LOCATION);
  // The board's location column is free text. The AREA is what a person would
  // write there ("Building", "Pool"); the task name is the fallback when the
  // hotel left the area blank, because a ticket with an empty location is a
  // ticket nobody can find.
  const where = (args.area?.trim() || name).slice(0, MAX_LOCATION);
  const cadence = `every ${args.frequencyDays} ${args.frequencyDays === 1 ? 'day' : 'days'}`;
  const lastDone = args.lastDoneDate ? `Last done ${args.lastDoneDate}.` : '';

  return {
    location: where,
    description:
      `${name} — preventive maintenance, due ${args.dueDate}. ` +
      `This hotel's upkeep schedule says ${cadence}. ${lastDone}`.trim().slice(0, MAX_DESCRIPTION),
    // Upkeep that has slipped its date is not an emergency. 'medium' keeps it on
    // the board's normal lane rather than shouting past a genuinely urgent
    // ticket somebody raised this morning.
    severity: 'medium',
    submitted_by_name: 'Staxis',
    submitter_role: 'Staxis',
    outcome_check_days: WORK_ORDER_OUTCOME_DAYS,
    preventive_task_id: args.taskId,
    preventive_task_name: name,
  };
}

export const createWorkOrderAction: ActionDefinition<CreateWorkOrderParams> = {
  kind: 'create_work_order',
  description:
    'Put one work order on the maintenance board asking for a full inspection of a location that keeps producing faults.',
  undoDescription:
    'The work order Staxis created is removed from the board, but only while it is still exactly as created — once anyone has assigned, worked, priced or closed it, the undo refuses and says so.',
  outcomeCheckDays: WORK_ORDER_OUTCOME_DAYS,

  validate(params: ActionParams): string | null {
    const location = str(params, 'location');
    if (!location) return 'a work order needs a location';
    if (location.length > MAX_LOCATION) return 'that location is too long for the board';
    const description = str(params, 'description');
    if (!description) return 'a work order needs a description';
    if (description.length > MAX_DESCRIPTION) return 'that description is too long for the board';
    if (!SEVERITIES.has(str(params, 'severity'))) {
      return 'a work order needs a severity the board understands';
    }
    if (!str(params, 'submitted_by_name')) return 'a work order needs a submitter name';
    const days = params.outcome_check_days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      return 'a work order action needs a whole number of days before the outcome is checked';
    }
    // The two halves of the preventive link travel together or not at all. An
    // id with no name would render a sentence with a hole in it; a name with no
    // id would write a ticket that never stamps its schedule done, which is the
    // whole point of carrying the link. The id must also be a uuid: it lands in
    // a uuid column, and a cast that fails inside the execute transaction is a
    // 'failed' action where a refused proposal would have been honest.
    const taskId = str(params, 'preventive_task_id');
    const taskName = str(params, 'preventive_task_name');
    if (taskId && !UUID_RE.test(taskId)) {
      return 'that upkeep schedule id is not a valid id';
    }
    if (taskId && !taskName) return 'a preventive work order needs the name of the upkeep task';
    if (taskName && !taskId) return 'a preventive work order needs the id of the upkeep task';
    return null;
  },

  label(params: CreateWorkOrderParams): Bilingual {
    return isPreventive(params)
      ? { en: 'Put it on the board', es: 'Ponerlo en el tablero' }
      : { en: 'Create the work order', es: 'Crear la orden de trabajo' };
  },

  offer(params: CreateWorkOrderParams): Bilingual {
    if (isPreventive(params)) {
      const task = str(params, 'preventive_task_name');
      return {
        en: `Create a work order for ${task}?`,
        es: `¿Crear una orden de trabajo para ${task}?`,
      };
    }
    return {
      en: `Create a work order for a full inspection of ${params.location}?`,
      es: `¿Crear una orden de trabajo para una inspección completa de ${params.location}?`,
    };
  },

  receiptLine(receipt: ActionReceipt, params: CreateWorkOrderParams): Bilingual {
    const where = receipt.where ?? params.location;
    if (isPreventive(params)) {
      const task = str(params, 'preventive_task_name');
      // Says the second half out loud on purpose. Closing that ticket is what
      // restarts this schedule's clock (migration 0366), and a manager who does
      // not know that will mark the same job done twice.
      return {
        en: `Work order created for ${task} — it is on the maintenance board. Closing it marks this upkeep task done.`,
        es: `Orden de trabajo creada para ${task}: ya está en el tablero. Al cerrarla, esta tarea de mantenimiento queda marcada como hecha.`,
      };
    }
    return {
      en: `Work order created for ${where} — it is on the maintenance board now.`,
      es: `Orden de trabajo creada para ${where}: ya está en el tablero de mantenimiento.`,
    };
  },

  postCondition(receipt: ActionReceipt, params: CreateWorkOrderParams): PostConditionResult {
    if (receipt.table !== 'work_orders') {
      return { ok: false, because: `expected a work_orders row, got "${receipt.table}"` };
    }
    if (receipt.kind !== 'created') {
      return { ok: false, because: `expected a created row, got "${receipt.kind}"` };
    }
    if (!receipt.id) return { ok: false, because: 'the receipt names no work order' };
    if ((receipt.where ?? '') !== params.location) {
      return {
        ok: false,
        because: `the work order landed on "${receipt.where ?? ''}", not on "${params.location}"`,
      };
    }
    return { ok: true };
  },
};

registerAction(createWorkOrderAction);
