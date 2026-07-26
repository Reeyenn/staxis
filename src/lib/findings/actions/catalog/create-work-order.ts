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

const MAX_LOCATION = 120;
const MAX_DESCRIPTION = 400;
const SEVERITIES = new Set(['urgent', 'medium', 'low']);

function str(params: ActionParams, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
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
    return null;
  },

  label(): Bilingual {
    return { en: 'Create the work order', es: 'Crear la orden de trabajo' };
  },

  offer(params: CreateWorkOrderParams): Bilingual {
    return {
      en: `Create a work order for a full inspection of ${params.location}?`,
      es: `¿Crear una orden de trabajo para una inspección completa de ${params.location}?`,
    };
  },

  receiptLine(receipt: ActionReceipt, params: CreateWorkOrderParams): Bilingual {
    const where = receipt.where ?? params.location;
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
