// ═══════════════════════════════════════════════════════════════════════════
// Detector: three tickets that are one failing thing.
//
// THE HERO. A hotel's maintenance board is a list of faults, so a run of rooms
// on one air line reads as three unrelated annoyances: 222 rattles, 218 stops
// cooling by evening, 214 is blowing warm. Nobody adds them up, because adding
// them up means noticing that the room numbers are on the same side of the same
// floor and that all three complaints are about the same kind of machine.
//
// PURE. No clock of its own, no database handle, no model call. Everything
// arrives as an argument, which is what makes the whole thing testable and what
// makes it free to run on every page load.
//
// ─── HOW IT DIFFERS FROM `repeat_room_work_orders` ─────────────────────────
// The findings detector next door answers "which ONE PLACE keeps breaking",
// counts tickets at a single location over thirty days, and writes a card to a
// queue. This answers "which tickets ON THE BOARD RIGHT NOW are one thing",
// groups a RUN of rooms by what kind of machine the words describe, and hands
// back the exact row ids so a line can be drawn between the cards. Same hotel,
// different question, different unit, different output.
//
// The thresholds are deliberately shared where the question really is the same:
// three is a pattern, because a hotel should not learn two definitions of "this
// keeps happening" from one app.
//
// ─── WHY THE WINDOW IS NINETY DAYS AND NOT THIRTY ─────────────────────────
// A dying compressor takes a season, not a month. The three tickets this is
// built to catch land in June, July and August, and a thirty-day window would
// see one of them and call it a bad week. The card always PRINTS the window it
// counted over, so the number on the screen and the number in the code cannot
// drift apart.
//
// ─── MONEY, OR WORDS ───────────────────────────────────────────────────────
// A dollar figure comes from this hotel's own recorded repair costs or it does
// not exist. `findings/pricing.ts` owns that arithmetic and refuses to invent a
// width. With nothing to go on the card still says the true thing, in words:
// a small repair now, or a replacement later. It just does not put a number on
// it, and it says why.
// ═══════════════════════════════════════════════════════════════════════════

import { formatCentsBand, formatMoneyRange, plural, priceFromBand, sampleBand } from '@/lib/findings/pricing';
import { tracePatternKey } from '../identity';
import type { TraceAnchor, TraceCost, TraceFact, TracePattern } from '../types';

export const DETECTOR_ID = 'maintenance_run';

/**
 * Tickets that must still be on the board.
 *
 * Two, and this detector's own floor rather than the shared one in types.ts.
 * "These three tickets are one problem" is a claim about a plural: with one
 * ticket left there is nothing to connect a line between, and nothing left to
 * do about it either, because a run whose tickets have all been closed is a
 * team that is evidently already on it.
 */
export const MIN_OPEN_TICKETS = 2;

/** A season, not a month. See the header. */
export const WINDOW_DAYS = 90;

/** Three is a pattern. Same number the findings ledger uses, on purpose. */
export const MIN_TICKETS = 3;

/** Fewest recorded repair costs before this hotel's own numbers say anything. */
const MIN_COST_SAMPLES = 3;

/** One work order, as this detector needs it. Shaped by the loader. */
export interface TraceWorkOrder {
  readonly id: string;
  /** `work_orders.room_number`, which holds free text ("Room 214", "Lobby"). */
  readonly location: string;
  readonly description: string;
  /** True while it is still on the board. Closed tickets are history. */
  readonly open: boolean;
  /** ISO. When the ticket was logged. */
  readonly createdAt: string;
  /** Whole dollars off `work_orders.repair_cost`, or null. */
  readonly repairCost: number | null;
}

export interface MaintenanceRunInput {
  readonly now: Date;
  readonly workOrders: readonly TraceWorkOrder[];
  /**
   * Every room number this hotel is known to have, from its own data.
   *
   * Used for one thing only: naming a room on the same run that has no ticket
   * yet. Empty means no such claim is ever made, which is the honest default
   * for a hotel whose room list Staxis has never been given. A room Staxis
   * invented would be the worst possible thing to put on this card.
   */
  readonly knownRooms: readonly string[];
}

// ─── What kind of machine the words describe ────────────────────────────────
//
// There is no category column on `work_orders`, and there is not going to be
// one: the board is free text a human typed at 6am. So the category is read out
// of the words, deterministically, from a table anybody can check.
//
// CONSERVATIVE ON PURPOSE. A ticket that matches nothing is `null` and is never
// grouped. "Other" is not a category, it is an admission, and grouping two
// admissions together would produce a pattern out of two things having nothing
// in common.

export type TraceCategory = 'hvac' | 'plumbing' | 'electrical' | 'door' | 'appliance';

const CATEGORY_WORDS: Readonly<Record<TraceCategory, readonly string[]>> = Object.freeze({
  hvac: ['ac', 'a/c', 'air condition', 'aircon', 'hvac', 'ptac', 'heater', 'heating', 'heat pump',
    'thermostat', 'furnace', 'cooling', 'cools', 'blowing warm', 'blowing hot', 'vent', 'compressor'],
  plumbing: ['leak', 'leaking', 'toilet', 'drain', 'faucet', 'sink', 'shower', 'tub', 'pipe',
    'clog', 'clogged', 'water pressure', 'running water', 'hot water'],
  electrical: ['outlet', 'socket', 'light', 'lamp', 'breaker', 'power', 'switch', 'bulb', 'wiring', 'flicker'],
  door: ['door', 'lock', 'keycard', 'key card', 'latch', 'hinge', 'deadbolt', 'closer'],
  appliance: ['fridge', 'refrigerator', 'microwave', 'tv', 'television', 'coffee maker', 'ice machine', 'kettle'],
});

/** Human-readable, for the card. Never the slug. */
const CATEGORY_LABEL: Readonly<Record<TraceCategory, string>> = Object.freeze({
  hvac: 'air conditioning',
  plumbing: 'plumbing',
  electrical: 'electrical',
  door: 'doors and locks',
  appliance: 'appliances',
});

/**
 * Which kind of machine a ticket is about, or null.
 *
 * Word-boundary matched, so "vacant" never counts as "ac" and "switchboard"
 * never counts as "switch". The first category with a hit wins, and the tables
 * are written so that a hit in two of them at once is not a thing that happens
 * in practice; when it does, the order above decides, and that is a stable
 * answer rather than a correct one, which is what a grouping key needs.
 */
export function categoryOf(description: string): TraceCategory | null {
  const text = ` ${description.toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ')} `;
  for (const [category, words] of Object.entries(CATEGORY_WORDS) as Array<[TraceCategory, readonly string[]]>) {
    for (const word of words) {
      if (text.includes(` ${word} `)) return category;
    }
  }
  return null;
}

// ─── Where the ticket is ────────────────────────────────────────────────────

/** "Room 214" / "214" / "rm 214" → "214". Anything else is not a room. */
export function roomNumberOf(location: string): string | null {
  const trimmed = location.trim();
  const bare = /^(\d{2,5})$/.exec(trimmed);
  if (bare) return bare[1];
  const named = /^(?:rooms?|rms?)\.?\s*#?\s*(\d{2,5})\b/i.exec(trimmed);
  return named ? named[1] : null;
}

/**
 * The RUN a room belongs to: its floor and which side of the corridor it is on.
 *
 * In a limited-service hotel the rooms on one side of one floor share a riser,
 * a supply line and an air handler, and they are numbered in one parity: 214,
 * 216, 218 face each other across from 213, 215, 217. That is the whole idea,
 * and it is the reason a run is worth naming: replacing the thing they share is
 * one job, and fixing them one at a time is three jobs and a fourth next month.
 *
 * Floor is the number minus its last two digits ("214" → 2, "1214" → 12), which
 * is how every hotel in this product numbers rooms. A two-digit room is floor 0
 * and still groups with its own parity, which is right for a single-storey
 * building.
 */
export function runOf(roomNumber: string): { floor: number; even: boolean } | null {
  if (!/^\d{2,5}$/.test(roomNumber)) return null;
  const n = Number(roomNumber);
  if (!Number.isFinite(n)) return null;
  return { floor: Math.floor(n / 100), even: n % 2 === 0 };
}

/** "2nd floor, even side" — what the run is called out loud. */
export function runLabel(run: { floor: number; even: boolean }): string {
  const side = run.even ? 'even side' : 'odd side';
  if (run.floor === 0) return `ground floor, ${side}`;
  const suffix = run.floor === 1 ? 'st' : run.floor === 2 ? 'nd' : run.floor === 3 ? 'rd' : 'th';
  return `${run.floor}${suffix} floor, ${side}`;
}

// ─── Grouping ───────────────────────────────────────────────────────────────

interface Group {
  /** Stable subject parts, in a fixed order. See identity.ts. */
  readonly subject: readonly string[];
  /** What the group is called in a sentence. */
  readonly where: string;
  readonly category: TraceCategory;
  readonly run: { floor: number; even: boolean } | null;
  readonly tickets: TraceWorkOrder[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function withinWindow(order: TraceWorkOrder, now: Date): boolean {
  const at = Date.parse(order.createdAt);
  if (!Number.isFinite(at)) return false;
  const ageDays = (now.getTime() - at) / DAY_MS;
  return ageDays >= 0 && ageDays <= WINDOW_DAYS;
}

/** "Jun 14" — the short date the mono label under each dot carries. */
export function shortDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${at.getUTCDate()}`;
}

/**
 * The three or four words under the dot.
 *
 * The ticket's own opening words, not a summary: the label is there so a
 * manager can look from the line to the card and see the same sentence, and
 * anything Staxis wrote instead would break that.
 */
export function anchorLabel(order: TraceWorkOrder): string {
  const words = order.description.trim().split(/\s+/).slice(0, 3).join(' ');
  const date = shortDate(order.createdAt);
  const gist = words.length > 24 ? `${words.slice(0, 23)}…` : words;
  return date ? `${date} · ${gist}` : gist;
}

/**
 * The room on this run that has no ticket yet, if the hotel's own room list
 * knows of one.
 *
 * Only ever the NEXT room outward from the run that already has tickets, and
 * only when it is a room this hotel actually has. Naming five rooms would be a
 * list; naming one is a thing somebody can go and check before lunch.
 */
export function siblingRoomFor(
  rooms: readonly string[],
  run: { floor: number; even: boolean },
  ticketed: readonly string[],
): string | null {
  const onRun = rooms
    .map((r) => r.trim())
    .filter((r) => {
      const its = runOf(r);
      return its !== null && its.floor === run.floor && its.even === run.even;
    })
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (onRun.length === 0) return null;

  const taken = new Set(ticketed.map(Number));
  const low = Math.min(...taken);
  const high = Math.max(...taken);
  // Outward from the run, nearest first: the room just past the top end, then
  // the room just before the bottom end. A gap INSIDE the run is checked first
  // of all, because a skipped room in the middle of a failing line is the most
  // suspicious room in the building.
  const inside = onRun.find((n) => n > low && n < high && !taken.has(n));
  if (inside !== undefined) return String(inside);
  const above = onRun.find((n) => n > high);
  if (above !== undefined) return String(above);
  const below = [...onRun].reverse().find((n) => n < low);
  return below !== undefined ? String(below) : null;
}

// ─── The money line ─────────────────────────────────────────────────────────

function costFor(tickets: readonly TraceWorkOrder[], samplesDollars: readonly number[]): TraceCost {
  const cents = samplesDollars
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round(n * 100));
  const band = sampleBand(cents, { minSamples: MIN_COST_SAMPLES });
  const outcome = priceFromBand(
    band ? { low: band.low * tickets.length, high: band.high * tickets.length } : null,
    band
      ? `${plural(tickets.length, 'repair')} at ${formatCentsBand(band)} each, the range of the `
        + `${plural(cents.length, 'repair cost')} this hotel has recorded`
      : '',
    cents.length < MIN_COST_SAMPLES
      ? 'No dollar figure. This hotel has recorded a repair cost on only '
        + `${plural(cents.length, 'work order')}, which is not enough to say what a repair costs here.`
      : 'No dollar figure. Every repair cost this hotel has recorded is the same number, so there is '
        + 'no honest range to quote.',
  );

  if (outcome.price) {
    return {
      figure: formatMoneyRange(outcome.price.lowCents, outcome.price.highCents, outcome.price.currency),
      line: 'to fix these one at a time, going by what this hotel has paid before',
      basis: outcome.note,
    };
  }
  return {
    figure: null,
    // True with or without a number, which is exactly why it is safe to print.
    line: 'One repair on the shared part now, or the same three rooms again next season.',
    basis: outcome.note,
  };
}

// ─── The detector ───────────────────────────────────────────────────────────

export function detectMaintenanceRuns(input: MaintenanceRunInput): TracePattern[] {
  const inWindow = input.workOrders.filter((o) => withinWindow(o, input.now));
  const groups = new Map<string, Group>();

  for (const order of inWindow) {
    const category = categoryOf(order.description);
    if (!category) continue;
    const room = roomNumberOf(order.location);
    const run = room ? runOf(room) : null;
    // A run when the location is a room, the location itself otherwise. A
    // ticket on "Lobby" is still a place that can keep breaking; it just has no
    // neighbours to reach out to.
    const subject = run
      ? [`floor-${run.floor}`, run.even ? 'even' : 'odd', category]
      : [`place-${order.location}`, category];
    const id = subject.join('|');
    const existing = groups.get(id);
    if (existing) {
      existing.tickets.push(order);
      continue;
    }
    groups.set(id, {
      subject,
      where: run ? runLabel(run) : order.location.trim(),
      category,
      run,
      tickets: [order],
    });
  }

  const costSamples = input.workOrders
    .map((o) => o.repairCost)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);

  const out: TracePattern[] = [];
  for (const group of groups.values()) {
    const pattern = patternFor(group, costSamples, input);
    if (pattern) out.push(pattern);
  }
  // Worst first, so the one thing the companion offers is the one that matters.
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

function patternFor(
  group: Group,
  costSamples: readonly number[],
  input: MaintenanceRunInput,
): TracePattern | null {
  const tickets = [...group.tickets].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (tickets.length < MIN_TICKETS) return null;

  const open = tickets.filter((t) => t.open);
  if (open.length < MIN_OPEN_TICKETS) return null;

  const closed = tickets.length - open.length;
  const rooms = Array.from(new Set(
    tickets.map((t) => roomNumberOf(t.location)).filter((r): r is string => r !== null),
  ));

  const anchors: TraceAnchor[] = open.map((t) => ({
    domId: `wo:${t.id}`,
    label: anchorLabel(t).toUpperCase(),
    present: true,
  }));

  const sibling = group.run && rooms.length >= 2
    ? siblingRoomFor(input.knownRooms, group.run, rooms)
    : null;
  if (sibling) {
    anchors.push({
      domId: '',
      label: `ROOM ${sibling}`,
      present: false,
      note: `Room ${sibling} is on the same run and has no ticket at all.`,
    });
  }

  const facts: TraceFact[] = tickets.map((t) => ({
    k: shortDate(t.createdAt),
    v: `${t.location.trim()}. ${t.description.trim()}${t.open ? '' : ' Already closed.'}`,
  }));
  if (sibling) {
    facts.push({
      k: `Room ${sibling}`,
      v: 'On the same run, and nobody has reported anything. Worth ten seconds with the door open.',
    });
  }

  const machine = CATEGORY_LABEL[group.category];
  const roomsPhrase = rooms.length >= 2
    ? `${rooms.length} rooms on the ${group.where}`
    : group.where;

  const body = rooms.length >= 2
    ? `These are not ${plural(tickets.length, 'separate ticket')}. It is one ${machine} run on the `
      + `${group.where}, and it has been getting worse in order.`
    : `${group.where} has produced ${plural(tickets.length, 'ticket')} about the same ${machine} in `
      + `${WINDOW_DAYS} days. That is one thing failing, not ${plural(tickets.length, 'thing')}.`;

  const ask = rooms.length >= 2
    ? `I think these ${plural(open.length, 'ticket')} are one problem. Mind if I show you?`
    : `I think the ${plural(open.length, 'open ticket')} on ${group.where} are one problem. Mind if I show you?`;

  const description = rooms.length >= 2
    ? `Check the ${machine} run on the ${group.where}. `
      + `One job covering ${rooms.join(', ')}${sibling ? ` and ${sibling}` : ''}. `
      + `Opened from ${plural(tickets.length, 'ticket')} Staxis found on the same run.`
    : `Full ${machine} inspection at ${group.where}, opened from `
      + `${plural(tickets.length, 'ticket')} in ${WINDOW_DAYS} days.`;

  return {
    key: tracePatternKey(DETECTOR_ID, group.subject),
    detectorId: DETECTOR_ID,
    page: 'maintenance',
    ask,
    kicker: rooms.length >= 2
      ? `${plural(rooms.length, 'room')}, one run · ${group.where}`
      : `${plural(tickets.length, 'ticket')}, one machine · ${group.where}`,
    body,
    facts,
    cost: costFor(tickets, costSamples),
    basis: `${plural(tickets.length, 'work order')} about ${machine} at ${roomsPhrase} in the last `
      + `${WINDOW_DAYS} days${closed > 0 ? `, ${closed} of them already closed` : ''}.`,
    anchors,
    actions: [
      {
        tool: 'create_work_order',
        label: 'Put one job on the board',
        args: {
          location: rooms.length >= 1 ? `Room ${rooms[0]}` : group.where,
          description,
          severity: open.some((t) => t.open) ? 'medium' : 'low',
        },
      },
      ...(sibling
        ? [{
          tool: 'create_work_order' as const,
          label: `Check ${sibling} today`,
          args: {
            location: `Room ${sibling}`,
            description: `Check the ${machine} in room ${sibling}. It is on the same run as `
              + `${rooms.join(', ')}, which have ${plural(tickets.length, 'ticket')} between them, `
              + 'and it has none.',
            severity: 'low',
          },
        }]
        : []),
    ],
    sensitivity: 'operational',
    severity: tickets.length >= MIN_TICKETS * 2 ? 'urgent' : 'watch',
    covers: open.map((t) => `item:workorder:${t.id}`),
    magnitude: tickets.length,
  };
}
