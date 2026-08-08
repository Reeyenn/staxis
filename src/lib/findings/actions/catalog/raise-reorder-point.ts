// ─── Action: raise an item's reorder point to cover its own lead time ────────
//
// The fix for "bath towels are going out at about 12 a day — this item's own
// usual rate here is about 7". A reorder point is the stock level at which the
// hotel places an order, and it only works if it covers the days between
// ordering and the delivery landing. When consumption moves and the reorder
// point does not, the hotel runs out DURING the wait, every time, and nobody
// connects the stockout to a number set months ago.
//
// THE NUMBER IS ARITHMETIC, NOT JUDGEMENT.
//   suggested = ceil(current rate per day × the hotel's own lead days)
// Both inputs are the hotel's own: the rate is what the inventory-usage
// detector measured from this item's counts, and `reorder_lead_days` is what
// the hotel typed in. No model, no borrowed benchmark, no percentage anyone
// chose. If either input is missing, there is no action — a reorder point set
// from a guess is worse than one that is merely old.
//
// WHY THIS ONE IS SAFE TO OFFER
//   • it is a THRESHOLD, not an order. Nothing is bought, nothing is spent, no
//     vendor hears about it. The only thing that changes is when the app starts
//     saying "running low".
//   • it never goes DOWN. The action exists only when the covering level is
//     higher than what is set now, so approving it can never quietly relax an
//     alert a manager tightened deliberately.
//   • the undo is exact: the previous value is frozen in the plan, and the undo
//     writes it straight back — refusing if anybody changed the number in the
//     meantime, because overwriting a human's edit is not an undo.

import { registerAction } from '../registry';
import type {
  ActionDefinition,
  ActionParams,
  ActionReceipt,
  Bilingual,
  PostConditionResult,
} from '../types';
import { ACTION_CONTRACT_VERSION } from '@/lib/staxis/foundation';

/** Long enough for at least one order cycle to have run at the new level. */
export const REORDER_OUTCOME_DAYS = 21;

/** Below this the suggestion is noise — an item whose covering level is one
 *  unit above today's is not a finding, it is rounding. */
export const MIN_REORDER_INCREASE = 2;

export interface RaiseReorderPointParams extends ActionParams {
  item_id: string;
  /** Shown on the card and in the receipt. The id is what is written. */
  item_name: string;
  unit: string;
  /** What it is now. The undo writes this back verbatim. */
  from_reorder_at: number;
  /** ceil(rate per day × lead days). */
  to_reorder_at: number;
  /** The two inputs, kept so the card can show its working. */
  rate_per_day: number;
  lead_days: number;
  outcome_check_days: number;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function num(params: ActionParams, key: string): number | null {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ReorderPointInput {
  itemId: string;
  itemName: string;
  unit: string;
  /** Current value on the inventory row, or null when it has never been set. */
  currentReorderAt: number | null;
  /** The hotel's own lead time in days. */
  leadDays: number | null;
  /** What the usage detector measured, per day. */
  ratePerDay: number;
}

/**
 * The frozen plan, or null when there is no honest one.
 *
 * Returns null — no action, the finding stays a plain card — when the hotel has
 * not told us its lead time, when the item has no reorder point at all (setting
 * a first one is a policy decision, not a correction), or when the covering
 * level is not meaningfully above what is already set.
 */
export function raiseReorderPointParams(input: ReorderPointInput): RaiseReorderPointParams | null {
  const { currentReorderAt, leadDays, ratePerDay } = input;
  if (currentReorderAt === null || !Number.isFinite(currentReorderAt)) return null;
  if (leadDays === null || !Number.isFinite(leadDays) || leadDays < 1) return null;
  if (!Number.isFinite(ratePerDay) || ratePerDay <= 0) return null;

  const covering = Math.ceil(ratePerDay * leadDays);
  if (covering - currentReorderAt < MIN_REORDER_INCREASE) return null;

  return {
    item_id: input.itemId,
    item_name: input.itemName.slice(0, 120),
    unit: input.unit.slice(0, 40),
    from_reorder_at: currentReorderAt,
    to_reorder_at: covering,
    rate_per_day: Math.round(ratePerDay * 10) / 10,
    lead_days: Math.round(leadDays),
    outcome_check_days: REORDER_OUTCOME_DAYS,
  };
}

export const raiseReorderPointAction: ActionDefinition<RaiseReorderPointParams> = {
  kind: 'raise_inventory_reorder_point',
  description:
    "Raise one item's reorder point to the level that covers the hotel's own delivery lead time at the rate the item is currently going out.",
  undoDescription:
    'The reorder point is written straight back to the number it had before, which is frozen in the plan — unless somebody has changed it since, in which case the undo refuses rather than overwriting their edit.',
  outcomeCheckDays: REORDER_OUTCOME_DAYS,
  actionContract: {
    contractVersion: ACTION_CONTRACT_VERSION,
    effect: {
      domain: 'inventory',
      operation: 'raise_reorder_point',
      targetKind: 'inventory_item',
      boundary: 'in_app_only',
      statement: 'After the existing manager hotel-standing and company sign-off gates pass, raise exactly one existing inventory item reorder threshold to the frozen integer value.',
      limit: 'Changes one internal inventory threshold only. It does not place an order, spend money, contact a vendor, write to a PMS, or prove delivery or stock availability.',
    },
    authority: {
      propertyScoped: true,
      roles: ['admin', 'owner', 'general_manager'],
      capability: null,
      surfaces: ['findings'],
    },
    approval: { mode: 'explicit_card', tier: 'card', policyId: 'staxis.finding.manager-company-signoff.v1' },
    frozenInput: {
      immutable: true,
      fields: ['propertyId', 'findingId', 'params', 'verify'],
      fingerprint: 'server_sha256',
      staleInput: 'decline',
    },
    idempotency: {
      scope: 'property_action_and_input',
      keyFields: ['propertyId', 'findingId', 'paramsFingerprint', 'verifyFingerprint'],
      retry: 'first_receipt',
    },
    receipt: {
      contractVersion: ACTION_CONTRACT_VERSION,
      requiredFields: ['table', 'id', 'kind', 'label', 'column', 'from', 'to'],
      internalOnly: true,
      physicalCompletionClaim: 'never',
    },
    outcome: {
      observability: 'conditional',
      verificationState: 'pending',
      verificationWindowDays: REORDER_OUTCOME_DAYS,
      basisRequired: true,
    },
  },

  validate(params: ActionParams): string | null {
    const itemId = params.item_id;
    if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) {
      return 'that action names no inventory item';
    }
    if (typeof params.item_name !== 'string' || params.item_name.trim() === '') {
      return 'that action names no item';
    }
    const from = num(params, 'from_reorder_at');
    const to = num(params, 'to_reorder_at');
    if (from === null || from < 0) return 'the current reorder point is missing';
    if (to === null || to < 0) return 'the suggested reorder point is missing';
    // The one-way rule, enforced rather than described. An action that could
    // lower a threshold would be able to quietly relax an alert a manager
    // tightened on purpose.
    if (to - from < MIN_REORDER_INCREASE) {
      return 'this action only ever raises a reorder point, and not by a rounding error';
    }
    const lead = num(params, 'lead_days');
    if (lead === null || lead < 1) return 'the hotel has no delivery lead time on record';
    const rate = num(params, 'rate_per_day');
    if (rate === null || rate <= 0) return 'there is no measured usage rate behind this';
    const days = params.outcome_check_days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      return 'this action needs a whole number of days before the outcome is checked';
    }
    return null;
  },

  label(): Bilingual {
    return { en: 'Raise the reorder point', es: 'Subir el punto de pedido' };
  },

  offer(params: RaiseReorderPointParams): Bilingual {
    const { item_name: name, from_reorder_at: from, to_reorder_at: to, unit, lead_days: lead } = params;
    return {
      en:
        `Raise the reorder point for ${name} from ${from} to ${to} ${unit}? ` +
        `At the rate it is going out, ${from} does not cover the ${lead} days your order takes to arrive.`,
      es:
        `¿Subir el punto de pedido de ${name} de ${from} a ${to} ${unit}? ` +
        `Al ritmo actual, ${from} no cubre los ${lead} días que tarda en llegar el pedido.`,
    };
  },

  receiptLine(receipt: ActionReceipt, params: RaiseReorderPointParams): Bilingual {
    const from = receipt.from ?? params.from_reorder_at;
    const to = receipt.to ?? params.to_reorder_at;
    return {
      en: `Reorder point for ${params.item_name} raised from ${from} to ${to} ${params.unit}.`,
      es: `Punto de pedido de ${params.item_name} subido de ${from} a ${to} ${params.unit}.`,
    };
  },

  postCondition(receipt: ActionReceipt, params: RaiseReorderPointParams): PostConditionResult {
    if (receipt.table !== 'inventory') {
      return { ok: false, because: `expected an inventory row, got "${receipt.table}"` };
    }
    if (receipt.kind !== 'changed') {
      return { ok: false, because: `expected a changed row, got "${receipt.kind}"` };
    }
    if (receipt.id !== params.item_id) {
      return { ok: false, because: 'the row that changed is not the item the plan named' };
    }
    if (receipt.column !== 'reorder_at') {
      return { ok: false, because: `expected reorder_at to change, got "${receipt.column ?? ''}"` };
    }
    if (receipt.to !== params.to_reorder_at) {
      return {
        ok: false,
        because: `the plan said ${params.to_reorder_at}, the database recorded ${String(receipt.to)}`,
      };
    }
    return { ok: true };
  },
};

registerAction(raiseReorderPointAction);
