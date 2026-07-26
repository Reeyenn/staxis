// ─── Planting a hotel-day ────────────────────────────────────────────────────
//
// The seeding toolkit the exam days speak. Every method writes REAL rows into
// the REAL migrated schema — no fake client, no hand-rolled table — because the
// failure this whole corpus exists to catch includes "the loader selects a
// column that does not exist", which a fake answers just as happily as the
// right spelling.
//
// ONE HOTEL PER EXAM DAY, AND THAT IS LOAD-BEARING.
// Each day gets its own `properties` row. So a detector or feed that loses its
// hotel filter does not merely leak one neighbour's rows into one day — it
// makes twenty-odd hotels' histories visible to every day at once, and the exam
// collapses in a way nobody can mistake for a threshold nudge.
//
// EVERY TIMESTAMP IS MIDDAY UTC ON A HOTEL-LOCAL DATE.
// 18:00Z is midday in Chicago in either half of the year, so a row's UTC
// instant and its hotel-local calendar date never disagree, and no exam day
// changes its verdict because it ran during daylight saving.

import type { PGlite } from '@electric-sql/pglite';

import { addDaysInTz, propertyLocalToday } from '@/lib/schedule/local-date';

import type { ExamPlanter } from './types';

export const EXAM_TIMEZONE = 'America/Chicago';

/** One owner for every exam hotel — `properties.owner_id` is NOT NULL and
 *  points at auth.users, which no migration creates. */
const EXAM_OWNER_ID = 'dddddddd-0000-4000-8000-0000000000ff';

/** Deterministic uuid in a namespace nothing else in the fixtures uses. */
function examUuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

/** The hotel this exam day runs against. */
export function examPropertyId(dayIndex: number): string {
  return examUuid('dddddddd', dayIndex + 1);
}

export interface PlanterOptions {
  pg: PGlite;
  dayIndex: number;
  now: Date;
  timezone?: string;
  enabledSections?: Record<string, boolean> | null;
}

/**
 * Create the hotel and hand back the toolkit its day writes through.
 *
 * `total_rooms` is 60 for every exam hotel: a limited-service property, the
 * kind Staxis is for. Nothing in the findings layer reads it, but a hotel with
 * zero rooms is a hotel no reviewer would believe.
 */
export async function createExamHotel(opts: PlanterOptions): Promise<ExamPlanter> {
  const { pg, dayIndex, now } = opts;
  const timezone = opts.timezone ?? EXAM_TIMEZONE;
  const propertyId = examPropertyId(dayIndex);
  const businessDate = propertyLocalToday(now, timezone);

  await pg.query(
    `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
    [EXAM_OWNER_ID, 'exam-owner@staxis.test'],
  );
  await pg.query(
    `insert into properties (id, owner_id, name, total_rooms, timezone, enabled_sections)
     values ($1, $2, $3, 60, $4, $5)`,
    [
      propertyId,
      EXAM_OWNER_ID,
      `Exam Hotel ${String(dayIndex + 1).padStart(2, '0')}`,
      timezone,
      opts.enabledSections === undefined ? null : JSON.stringify(opts.enabledSections),
    ],
  );

  return new Planter(pg, propertyId, dayIndex, now, timezone, businessDate);
}

class Planter implements ExamPlanter {
  /** Created lazily: only the days that plant pms_* rows need one. */
  private ingestRunId: string | null = null;
  private readonly items = new Set<number>();

  constructor(
    readonly pg: PGlite,
    readonly propertyId: string,
    private readonly dayIndex: number,
    readonly now: Date,
    readonly timezone: string,
    readonly businessDate: string,
  ) {}

  ago(days: number): string {
    return addDaysInTz(this.businessDate, -days);
  }

  atNoon(date: string): string {
    return `${date}T18:00:00.000Z`;
  }

  minutesAgo(minutes: number): string {
    return new Date(this.now.getTime() - minutes * 60_000).toISOString();
  }

  itemId(slot = 0): string {
    return examUuid('dddddd11', this.dayIndex * 100 + slot + 1);
  }

  private roomWorkOrderId(): string {
    return examUuid('dddddd22', this.dayIndex * 10_000 + this.sequence++);
  }

  private sequence = 1;

  async item(spec: {
    slot?: number;
    name?: string;
    unit?: string;
    reorderAt?: number | null;
    reorderLeadDays?: number | null;
  } = {}): Promise<string> {
    const slot = spec.slot ?? 0;
    const id = this.itemId(slot);
    if (this.items.has(slot)) return id;
    this.items.add(slot);
    await this.pg.query(
      `insert into inventory (id, property_id, name, category, current_stock, par_level, unit,
                              unit_cost, reorder_at, reorder_lead_days)
       values ($1, $2, $3, 'housekeeping', 0, 200, $4, 4.50, $5, $6)`,
      [
        id,
        this.propertyId,
        spec.name ?? 'Bath towels',
        spec.unit ?? 'each',
        spec.reorderAt ?? null,
        spec.reorderLeadDays ?? null,
      ],
    );
    return id;
  }

  /** One delivery. `cents` is the whole receipt; `unitCostCents` prices a unit. */
  async supplyDelivery(spec: {
    date: string;
    cents?: number;
    itemSlot?: number;
    quantity?: number;
    unitCostCents?: number;
  }): Promise<void> {
    const itemId = await this.item({ slot: spec.itemSlot ?? 0 });
    await this.pg.query(
      `insert into inventory_orders (property_id, item_id, item_name, quantity, unit_cost,
                                     total_cost, received_at, entry_kind)
       values ($1, $2, 'Bath towels', $3, $4, $5, $6, 'receipt')`,
      [
        this.propertyId,
        itemId,
        spec.quantity ?? 1,
        spec.unitCostCents === undefined ? null : spec.unitCostCents / 100,
        spec.cents === undefined ? null : spec.cents / 100,
        this.atNoon(spec.date),
      ],
    );
  }

  async workOrder(spec: {
    date: string;
    location?: string;
    status?: string;
    repairCostCents?: number | null;
    equipmentId?: string | null;
    description?: string;
  }): Promise<void> {
    await this.pg.query(
      `insert into work_orders (id, property_id, room_number, description, severity, status,
                                repair_cost, created_at, equipment_id)
       values ($1, $2, $3, $4, 'medium', $5, $6, $7, $8)`,
      [
        this.roomWorkOrderId(),
        this.propertyId,
        spec.location ?? 'Room 101',
        spec.description ?? 'planted by the detector exam',
        spec.status ?? 'submitted',
        spec.repairCostCents === undefined || spec.repairCostCents === null
          ? null
          : spec.repairCostCents / 100,
        this.atNoon(spec.date),
        spec.equipmentId ?? null,
      ],
    );
  }

  async equipment(spec: {
    id: string;
    name: string;
    location?: string | null;
    installYear?: number | null;
    category?: string;
    status?: string;
  }): Promise<string> {
    await this.pg.query(
      `insert into equipment (id, property_id, name, category, location, status, install_date)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        spec.id,
        this.propertyId,
        spec.name,
        spec.category ?? 'hvac',
        spec.location === undefined ? null : spec.location,
        spec.status ?? 'operational',
        // A June install date: mid-year, so the YEAR the card prints is the same
        // one in every timezone the exam might run in.
        spec.installYear === undefined || spec.installYear === null
          ? null
          : `${spec.installYear}-06-15`,
      ],
    );
    return spec.id;
  }

  async count(spec: {
    date: string;
    itemSlot?: number;
    stock: number;
    varianceValueCents?: number | null;
  }): Promise<void> {
    const itemId = await this.item({ slot: spec.itemSlot ?? 0 });
    await this.pg.query(
      `insert into inventory_counts (property_id, item_id, item_name, counted_stock,
                                     variance_value, unit_cost, counted_at)
       values ($1, $2, 'Bath towels', $3, $4, 4.50, $5)`,
      [
        this.propertyId,
        itemId,
        spec.stock,
        spec.varianceValueCents === undefined || spec.varianceValueCents === null
          ? null
          : spec.varianceValueCents / 100,
        this.atNoon(spec.date),
      ],
    );
  }

  async discard(spec: { date: string; itemSlot?: number; quantity: number }): Promise<void> {
    const itemId = await this.item({ slot: spec.itemSlot ?? 0 });
    await this.pg.query(
      `insert into inventory_discards (property_id, item_id, item_name, quantity, reason, discarded_at)
       values ($1, $2, 'Bath towels', $3, 'damaged', $4)`,
      [this.propertyId, itemId, spec.quantity, this.atNoon(spec.date)],
    );
  }

  async preventiveTask(spec: {
    id: string;
    name: string;
    frequencyDays: number;
    lastDoneDaysAgo: number | null;
    area?: string | null;
    calledDaysAgo?: number | null;
    calledBy?: string | null;
  }): Promise<string> {
    const id = spec.id;
    await this.pg.query(
      `insert into preventive_tasks (id, property_id, name, area, frequency_days,
                                     last_completed_at, called_at, called_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        this.propertyId,
        spec.name,
        spec.area === undefined ? 'Building' : spec.area,
        spec.frequencyDays,
        // Midday UTC on the hotel-local day, like every other timestamp here, so
        // the row's instant and its calendar date never disagree.
        spec.lastDoneDaysAgo === null ? null : this.atNoon(this.ago(spec.lastDoneDaysAgo)),
        spec.calledDaysAgo === undefined || spec.calledDaysAgo === null
          ? null
          : this.atNoon(this.ago(spec.calledDaysAgo)),
        spec.calledDaysAgo === undefined || spec.calledDaysAgo === null
          ? null
          : spec.calledBy ?? 'Dana',
      ],
    );
    return id;
  }

  async dailyLog(date: string): Promise<void> {
    await this.pg.query(
      `insert into daily_logs (property_id, date, rooms_completed) values ($1, $2, 20)`,
      [this.propertyId, date],
    );
  }

  async complaint(spec: {
    date: string;
    room: string;
    category: string;
    severity?: string;
  }): Promise<void> {
    await this.pg.query(
      `insert into complaints (property_id, room_number, category, severity, description,
                               source, created_at)
       values ($1, $2, $3, $4, 'planted by the detector exam', 'front_desk', $5)`,
      [this.propertyId, spec.room, spec.category, spec.severity ?? 'medium', this.atNoon(spec.date)],
    );
  }

  async inspection(spec: { date: string; room: string; result: string }): Promise<void> {
    await this.pg.query(
      `insert into inspections (property_id, room_number, result, started_at, completed_at)
       values ($1, $2, $3, $4, $4)`,
      [this.propertyId, spec.room, spec.result, this.atNoon(spec.date)],
    );
  }

  async cleaningEvent(spec: { date: string; room: string; minutes: number }): Promise<void> {
    const started = this.atNoon(spec.date);
    await this.pg.query(
      `insert into cleaning_events (property_id, date, room_number, room_type, staff_name,
                                    started_at, completed_at, duration_minutes)
       values ($1, $2, $3, 'checkout', 'Maria Garcia', $4,
               $4::timestamptz + make_interval(mins => $5), $5)`,
      [this.propertyId, spec.date, spec.room, started, spec.minutes],
    );
  }

  async pmsWorkOrder(spec: { date: string; room: string; category: string }): Promise<void> {
    const runId = await this.ensureIngestRun();
    await this.pg.query(
      `insert into pms_work_orders_v2 (property_id, pms_work_order_id, room_number, category,
                                       created_at, ingest_run_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        this.propertyId,
        `exam-wo-${this.sequence++}`,
        spec.room,
        spec.category,
        this.atNoon(spec.date),
        runId,
      ],
    );
  }

  async pmsRoom(spec: { room: string; roomType?: string; isSuite?: boolean }): Promise<void> {
    const runId = await this.ensureIngestRun();
    await this.pg.query(
      `insert into pms_rooms_inventory (property_id, room_number, room_type, is_suite, ingest_run_id)
       values ($1, $2, $3, $4, $5)`,
      [this.propertyId, spec.room, spec.roomType ?? 'king', spec.isSuite ?? false, runId],
    );
  }

  async pmsReservation(spec: {
    room: string;
    arrivalDate: string;
    departureDate: string;
    status?: string;
    notes?: string | null;
  }): Promise<void> {
    const runId = await this.ensureIngestRun();
    await this.pg.query(
      `insert into pms_reservations (property_id, pms_reservation_id, room_number, arrival_date,
                                     departure_date, arrival_time, departure_time, num_nights,
                                     adults, status, notes, ingest_run_id)
       values ($1, $2, $3, $4, $5, '15:00', '11:00', $6, 2, $7, $8, $9)`,
      [
        this.propertyId,
        `exam-res-${this.sequence++}`,
        spec.room,
        spec.arrivalDate,
        spec.departureDate,
        Math.max(1, daysApart(spec.arrivalDate, spec.departureDate)),
        spec.status ?? 'checked_in',
        spec.notes ?? null,
        runId,
      ],
    );
  }

  /**
   * Today's housekeeping plan for one room.
   *
   * The PMS mirror carries the plan; `room_work` carries what a person did.
   * `started_at` lives on the Staxis side only — the merge stitches the two,
   * which is why a room "in progress for two hours" is planted on both.
   */
  async hkAssignment(spec: {
    room: string;
    date?: string;
    cleaningType?: string;
    startedMinutesAgo?: number | null;
    completed?: boolean;
  }): Promise<void> {
    const runId = await this.ensureIngestRun();
    const date = spec.date ?? this.businessDate;
    await this.pg.query(
      `insert into pms_housekeeping_assignments (property_id, date, room_number, cleaning_type,
                                                 housekeeper_name, ingest_run_id)
       values ($1, $2, $3, $4, 'Maria Garcia', $5)`,
      [this.propertyId, date, spec.room, spec.cleaningType ?? 'departure', runId],
    );
    const startedAt =
      spec.startedMinutesAgo === undefined || spec.startedMinutesAgo === null
        ? null
        : this.minutesAgo(spec.startedMinutesAgo);
    await this.pg.query(
      `insert into room_work (property_id, date, room_number, status, started_at, completed_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        this.propertyId,
        date,
        spec.room,
        spec.completed ? 'completed' : startedAt ? 'in_progress' : 'not_started',
        startedAt,
        spec.completed ? this.minutesAgo(5) : null,
      ],
    );
  }

  async roomStatus(spec: { room: string; status: string; changedAt?: string }): Promise<void> {
    const runId = await this.ensureIngestRun();
    await this.pg.query(
      `insert into pms_room_status_log (property_id, room_number, status, changed_at, source, ingest_run_id)
       values ($1, $2, $3, $4, 'cua', $5)`,
      [this.propertyId, spec.room, spec.status, spec.changedAt ?? this.minutesAgo(120), runId],
    );
  }

  private async ensureIngestRun(): Promise<string> {
    if (this.ingestRunId) return this.ingestRunId;
    const id = examUuid('dddddd33', this.dayIndex + 1);
    await this.pg.query(
      `insert into pms_ingest_runs (id, property_id, source_kind, parser_name, parser_version,
                                    source_captured_at, status)
       values ($1, $2, 'manual_backfill', 'detector-exam', '1', $3, 'succeeded')`,
      [id, this.propertyId, this.minutesAgo(30)],
    );
    this.ingestRunId = id;
    return id;
  }
}

/** Whole days between two YYYY-MM-DD dates. */
function daysApart(from: string, to: string): number {
  const parse = (value: string) => {
    const [y, m, d] = value.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}
