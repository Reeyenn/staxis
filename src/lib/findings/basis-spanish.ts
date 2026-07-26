// ═══════════════════════════════════════════════════════════════════════════
// basis-spanish — the two BASIS lines of a hotel finding, in Spanish.
//
// A card carries two receipts in prose: the evidence basis ("4 work orders
// logged at Room 214 …") and the money basis ("3 work orders at $250–$400
// each …"). Every hotel detector writes both in English only, and
// `toQueueFinding` has always had a `basisEs` seam for them — the PORTFOLIO
// checks fill it (see `portfolioSpanish` in ../company/portfolio-checks.ts),
// the hotel detectors never did. So a Spanish-reading manager opened a card
// whose headline was Spanish and whose receipt was English, on every finding
// this product produces.
//
// ─── rebuilt from the receipt, never translated ────────────────────────────
// Nothing here reads the English sentence. Every renderer is handed the
// structured `evidence.params` / `evidence.values` the detector wrote and
// composes a Spanish sentence from those fields, exactly as
// `portfolioSpanish` does. Two consequences, both deliberate:
//
//   · every numeral in the Spanish is a numeral in the payload, so the
//     sentence can be checked against the same row the English was;
//   · a detector whose basis is NOT reconstructible from its receipt gets
//     `null` and keeps its English. `room_needs_attention` copies a
//     pre-formatted sentence out of the nudge layer ("Usually takes ~25 min"
//     — a figure that reaches no field), and `operational_pattern`'s basis is
//     a raw signal metric whose slow-clean variant carries two medians the
//     receipt never sees. Half a translated sentence, with an English clause
//     left inside it, is worse than an honest English one.
//
// ─── the Spanish sentences are shorter than the English ────────────────────
// Same asymmetry `spanishTemplateSentence` states in template-phrasing.ts:
// the English reuses a template the detector already authored and which is
// already exact; the Spanish says only what the payload can vouch for. Where
// the English names a coverage window start that never reached the receipt
// (`repeat_room_work_orders`), the Spanish says "in the last N days" from
// `window_days` instead of inventing the date.
//
// ─── money formatting ──────────────────────────────────────────────────────
// `formatCents` / `formatCentsBand` are the product's only money formatters
// and they group in en-US ("$1,160"). Used here unchanged and on purpose:
// the Spanish basis sits a centimetre under the price CHIP, which is rendered
// by those same functions, and two different groupings for the same number on
// one card would read as a bug. `portfolioSpanish` made the same call.
//
// Detector ids are string literals rather than imports so that an API route
// pulling this module in does not drag ten detector modules (and their feed
// graph) along with it. `findings-basis-spanish.test.ts` asserts every literal
// here still matches the detector's real `id`, so a rename cannot quietly
// switch the Spanish off.
// ═══════════════════════════════════════════════════════════════════════════

import { formatCents, formatCentsBand } from './pricing';

/** The Spanish twins of `PriceRange.basis` and `FindingEvidence.basis`. Either
 *  half may be null on its own — `basisInLang` falls back per field, so a card
 *  can carry a Spanish receipt and an English money line without either being
 *  dropped. */
export interface BasisSpanish {
  price: string | null;
  evidence: string | null;
}

type Values = Readonly<Record<string, unknown>>;
type Receipt = { params?: Values; values?: Values } | null | undefined;

/** The detectors this module can speak for. Kept as a named map so the test
 *  can walk it against the real detector objects. */
export const SPANISH_BASIS_DETECTORS = {
  repeatRoomWorkOrders: 'repeat_room_work_orders',
  repeatEquipmentWorkOrders: 'repeat_equipment_work_orders',
  workOrderRateBaseline: 'work_order_rate_baseline',
  supplySpendBaseline: 'supply_spend_baseline',
  inventoryUsageBaseline: 'inventory_usage_baseline',
  expectedActivityStopped: 'expected_activity_stopped',
  preventiveDue: 'preventive_due',
  cleaningPlanHealth: 'cleaning_plan_health',
} as const;

/** Detectors whose basis line cannot be rebuilt from what they store. Listed
 *  rather than merely absent, so the test can assert they stay silent. */
export const NO_SPANISH_BASIS_DETECTORS = {
  roomNeedsAttention: 'room_needs_attention',
  operationalPattern: 'operational_pattern',
} as const;

const MAX_BASIS = 500;

function num(values: Values | undefined, key: string): number | null {
  const raw = values?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function str(values: Values | undefined, key: string): string | null {
  const raw = values?.[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

const pluralEs = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dias = (n: number) => pluralEs(n, 'día', 'días');
const ordenes = (n: number) => pluralEs(n, 'orden de trabajo', 'órdenes de trabajo');
const semanas = (n: number) => pluralEs(n, 'semana', 'semanas');

/** "vence hoy" / "tiene 12 días de retraso" — the Spanish twin of `lateness`
 *  in detectors/preventive-due.ts. */
function retraso(daysOverdue: number): string {
  return daysOverdue === 0 ? 'vence hoy' : `tiene ${dias(daysOverdue)} de retraso`;
}

// ─── per detector ───────────────────────────────────────────────────────────

function repeatRoomWorkOrders(r: Receipt): BasisSpanish | null {
  const total = num(r?.values, 'work_orders');
  const location = str(r?.params, 'location');
  const windowDays = num(r?.params, 'window_days');
  const last = str(r?.values, 'last_logged');
  if (total === null || !location || windowDays === null) return null;
  // The English names the coverage window's START date; that date never
  // reaches the receipt, so the Spanish states the window's LENGTH, which
  // does (`window_days`). Same claim, told from the fields we actually have.
  const tail = last ? `; la última el ${last}` : '';
  return {
    evidence: `${ordenes(total)} registradas en ${location} en los últimos ${dias(windowDays)}${tail}`,
    price: null,
  };
}

function repeatEquipmentWorkOrders(r: Receipt): BasisSpanish | null {
  const total = num(r?.values, 'work_orders');
  const name = str(r?.params, 'equipment_name');
  const windowDays = num(r?.params, 'window_days');
  const covers = str(r?.values, 'covers');
  const last = str(r?.values, 'last_logged');
  if (total === null || !name || windowDays === null) return null;
  const where = covers ? ` (${covers})` : '';
  const tail = last ? `; la última el ${last}` : '';
  return {
    evidence:
      `${ordenes(total)} registradas contra ${name}${where} en los últimos ${dias(windowDays)}${tail}`,
    price: null,
  };
}

function workOrderRateBaseline(r: Receipt): BasisSpanish | null {
  const weeks = num(r?.params, 'baseline_weeks');
  const end = str(r?.params, 'current_end');
  if (weeks === null || !end) return null;
  return {
    // The money basis stays English on purpose: the English quotes the band of
    // EXTRA work orders, and that band is computed and never stored, so the
    // only Spanish available would be a second copy of the arithmetic.
    price: null,
    evidence:
      `órdenes de trabajo creadas en la semana que terminó el ${end}, frente a las ` +
      `${semanas(weeks)} anteriores — cada ventana con la misma mezcla de días de la semana`,
  };
}

function supplySpendBaseline(r: Receipt): BasisSpanish | null {
  const weeks = num(r?.params, 'baseline_weeks');
  const end = str(r?.params, 'current_end');
  if (weeks === null || !end) return null;

  const low = num(r?.values, 'p25_cents');
  const high = num(r?.values, 'p75_cents');
  const current = num(r?.values, 'current_cents');
  const price =
    low !== null && high !== null && current !== null
      ? `tus últimas ${semanas(weeks)} comparables costaron ${formatCentsBand({ low, high })}; ` +
        `la semana que terminó el ${end} fue ${formatCents(current)}`
      : null;

  return {
    price,
    evidence:
      `la semana que terminó el ${end} frente a las ${semanas(weeks)} anteriores — ` +
      'cada ventana con la misma mezcla de días de la semana',
  };
}

function inventoryUsageBaseline(r: Receipt): BasisSpanish | null {
  const end = str(r?.params, 'interval_end');
  const counts = num(r?.values, 'baseline_intervals');
  if (!end || counts === null) return null;
  return {
    // The English money line quotes a per-unit cost the receipt does not carry.
    price: null,
    evidence:
      `existencias contadas el ${end} frente al conteo anterior, más entregas y descartes ` +
      `entre medias — medido contra los ${counts} conteos anteriores de este artículo`,
  };
}

function expectedActivityStopped(r: Receipt): BasisSpanish | null {
  const occurrences = num(r?.values, 'occurrences_on_record');
  const last = str(r?.values, 'last_seen');
  const typical = num(r?.values, 'typical_gap_days');
  const longest = num(r?.values, 'long_but_normal_gap_days');
  if (occurrences === null || !last || typical === null || longest === null) return null;
  return {
    price: null,
    evidence:
      `${pluralEs(occurrences, 'vez registrada', 'veces registradas')}, la más reciente el ` +
      `${last}; aquí la espera habitual es de ${typical} días y la espera normal más larga ` +
      `es de ${longest}`,
  };
}

function preventiveDue(r: Receipt): BasisSpanish | null {
  const name = str(r?.params, 'task_name');
  const overdue = num(r?.values, 'days_overdue');
  if (!name || overdue === null) return null;

  // The follow-up arm is the one the detector writes `days_since_called` for;
  // on the ordinary arm that field is null. Same switch, read off the payload
  // rather than re-derived.
  const sinceCalled = num(r?.values, 'days_since_called');
  if (sinceCalled !== null) {
    return {
      price: null,
      evidence:
        `${name} ${retraso(overdue)}; alguien fue avisado hace ${dias(sinceCalled)} y ` +
        'todavía no está marcado como hecho',
    };
  }

  const cadence = num(r?.params, 'frequency_days');
  const sinceDone = num(r?.values, 'days_since_last_done');
  const lastDone = sinceDone === null
    ? 'no se sabe cuándo se hizo por última vez'
    : `se hizo por última vez hace ${dias(sinceDone)}`;
  const every = cadence === null ? '' : `, y el calendario de este hotel dice cada ${dias(cadence)}`;
  return {
    price: null,
    evidence: `${name} ${lastDone}${every}, así que ahora ${retraso(overdue)}`,
  };
}

function cleaningPlanHealth(r: Receipt): BasisSpanish | null {
  const failed = num(r?.values, 'rooms_failed');
  const evaluated = num(r?.values, 'rooms_evaluated');
  if (failed === null || evaluated === null) return null;
  return {
    price: null,
    evidence: `${failed} de ${evaluated} habitaciones no pasaron la evaluación de reglas`,
  };
}

const RENDERERS: Readonly<Record<string, (r: Receipt) => BasisSpanish | null>> = Object.freeze({
  [SPANISH_BASIS_DETECTORS.repeatRoomWorkOrders]: repeatRoomWorkOrders,
  [SPANISH_BASIS_DETECTORS.repeatEquipmentWorkOrders]: repeatEquipmentWorkOrders,
  [SPANISH_BASIS_DETECTORS.workOrderRateBaseline]: workOrderRateBaseline,
  [SPANISH_BASIS_DETECTORS.supplySpendBaseline]: supplySpendBaseline,
  [SPANISH_BASIS_DETECTORS.inventoryUsageBaseline]: inventoryUsageBaseline,
  [SPANISH_BASIS_DETECTORS.expectedActivityStopped]: expectedActivityStopped,
  [SPANISH_BASIS_DETECTORS.preventiveDue]: preventiveDue,
  [SPANISH_BASIS_DETECTORS.cleaningPlanHealth]: cleaningPlanHealth,
});

/**
 * The Spanish basis lines for one hotel finding, or null when this detector
 * has none — in which case the card keeps its English, because an English
 * receipt is better than no receipt.
 *
 * Never throws: a malformed receipt costs the translation, never the card.
 */
export function hotelBasisSpanish(detectorId: string, evidence: Receipt): BasisSpanish | null {
  if (!evidence) return null;
  const render = RENDERERS[detectorId];
  if (!render) return null;
  try {
    const out = render(evidence);
    if (!out) return null;
    if (out.price === null && out.evidence === null) return null;
    return {
      price: out.price === null ? null : out.price.slice(0, MAX_BASIS),
      evidence: out.evidence === null ? null : out.evidence.slice(0, MAX_BASIS),
    };
  } catch {
    return null;
  }
}
