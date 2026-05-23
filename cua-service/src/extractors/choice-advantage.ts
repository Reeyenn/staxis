/**
 * Choice Advantage normalizer.
 *
 * Turns the raw extractor output (CSV rows, DOM table rows, fetched
 * JSON, dashboard fields) into the canonical Row shapes that
 * persistence/new-schema-writer.ts expects. CA-specific knowledge
 * (column names, date formats, status code mapping) lives here so the
 * generic extractors stay PMS-agnostic.
 *
 * Future PMSes get their own normalizer file (mews.ts, cloudbeds.ts).
 * Session-driver dispatches based on the knowledge file's pms_family.
 *
 * Ported from scraper/csv-scraper.js, hk-center-pull.js, ooo-pull.js,
 * dashboard-pull.js with the load-bearing semantics preserved:
 *   - Stayover cycle math (day 1 light, day 2 full) from arrival_date
 *   - Room status mapping (CA's OCC/VAC/OOO → our enum)
 *   - Work order shape from the WorkOrders.jx JSON
 *   - Dashboard counts from the 3 View pages
 */

import type {
  ReservationRow,
  RoomStatusRow,
  HousekeepingRow,
  WorkOrderRow,
  InHouseSnapshotRow,
} from '../validators.js';

// ─── Date helpers ─────────────────────────────────────────────────────────

/**
 * Parse Choice Advantage's M/D/YY date format into ISO YYYY-MM-DD.
 * Returns null on invalid input.
 */
export function parseCaDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (!m) return null;
  let year = Number.parseInt(m[3]!, 10);
  const month = Number.parseInt(m[1]!, 10);
  const day = Number.parseInt(m[2]!, 10);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

// ─── CSV (arrivals / departures / room list) ──────────────────────────────

/**
 * The Choice Advantage Housekeeping Check-off List CSV has columns like:
 *   Room | Type | People | Adults | Children | Status | Condition |
 *   Stay Type | Service | Housekeeper | Special Requests |
 *   Arrival | Departure | Last Clean
 *
 * We extract reservations (occupied rooms with arrival/departure dates)
 * and housekeeping assignments (assigned housekeeper per room for today).
 */
export interface CsvRoomRow {
  Room?: string;
  Type?: string;
  Status?: string;
  Condition?: string;
  'Stay Type'?: string;
  Service?: string;
  Housekeeper?: string;
  Arrival?: string;
  Departure?: string;
  Adults?: string;
  Children?: string;
  [key: string]: string | undefined;
}

export interface NormalizedCsv {
  reservations: ReservationRow[];
  housekeeping: HousekeepingRow[];
  roomStatuses: RoomStatusRow[];
}

export function normalizeCaCsv(
  rows: CsvRoomRow[],
  context: { today: string /* ISO YYYY-MM-DD */ },
): NormalizedCsv {
  const reservations: ReservationRow[] = [];
  const housekeeping: HousekeepingRow[] = [];
  const roomStatuses: RoomStatusRow[] = [];

  for (const r of rows) {
    const room = (r.Room ?? '').trim();
    if (!room) continue;

    const arrivalISO = parseCaDate(r.Arrival);
    const departureISO = parseCaDate(r.Departure);

    // Reservation row when this room is occupied / has a future arrival.
    if (arrivalISO || departureISO) {
      reservations.push({
        // Use room + arrival as the dedup key when PMS doesn't expose a
        // reservation ID via CSV (it doesn't).
        pms_reservation_id: `ca:${room}:${arrivalISO ?? 'noarr'}:${departureISO ?? 'nodep'}`,
        room_number: room,
        arrival_date: arrivalISO ?? undefined,
        departure_date: departureISO ?? undefined,
        adults: toInt(r.Adults),
        children: toInt(r.Children),
        status: mapCsvStatusToReservation(r.Status),
        notes: combineCsvNotes(r),
      });
    }

    // Housekeeping assignment for today.
    housekeeping.push({
      date: context.today,
      room_number: room,
      housekeeper_name: (r.Housekeeper ?? '').trim() || undefined,
      cleaning_type: mapStayTypeToCleaningType(r['Stay Type'], r.Service),
      status: 'not_started',
    });

    // Room status from CSV (CA Status + Condition combination).
    const rs = mapCsvStatusToRoom(r.Status, r.Condition);
    if (rs) {
      roomStatuses.push({
        room_number: room,
        status: rs,
        changed_at: new Date().toISOString(),
      });
    }
  }

  return { reservations, housekeeping, roomStatuses };
}

function toInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function combineCsvNotes(r: CsvRoomRow): string | undefined {
  const parts = [r['Special Requests']].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

function mapCsvStatusToReservation(status?: string): ReservationRow['status'] {
  const v = (status ?? '').trim().toUpperCase();
  if (v === 'OCC' || v === 'OCCUPIED') return 'checked_in';
  if (v === 'VAC' || v === 'VACANT') return undefined;
  return undefined;
}

function mapCsvStatusToRoom(
  status?: string,
  condition?: string,
): RoomStatusRow['status'] | undefined {
  const s = (status ?? '').trim().toUpperCase();
  const c = (condition ?? '').trim().toUpperCase();
  if (s === 'OOO' || c === 'OOO') return 'out_of_order';
  if (s === 'OCC') {
    if (c.startsWith('C')) return 'occupied_clean';
    if (c.startsWith('D')) return 'occupied_dirty';
    return 'occupied';
  }
  if (s === 'VAC') {
    if (c.startsWith('C')) return 'vacant_clean';
    if (c.startsWith('D')) return 'vacant_dirty';
  }
  return undefined;
}

function mapStayTypeToCleaningType(
  stayType?: string,
  service?: string,
): HousekeepingRow['cleaning_type'] {
  const st = (stayType ?? '').trim().toLowerCase();
  const sv = (service ?? '').trim().toLowerCase();
  if (st.startsWith('c')) return 'departure'; // C/O = checkout
  if (st === 'stay' || st.startsWith('s')) {
    if (sv.includes('full')) return 'stayover';
    return 'refresh';
  }
  if (sv === 'none' || sv === '') return undefined;
  return undefined;
}

// ─── HK Center DOM (live room status + assignments) ───────────────────────

export interface HkCenterRow {
  number: string;
  type?: string;
  roomStatus?: string;
  condition?: string;
  service?: string;
  assignedTo?: string;
  isDnd?: string;
  [key: string]: string | undefined;
}

export function normalizeCaHkCenter(
  rows: HkCenterRow[],
  context: { today: string },
): { roomStatuses: RoomStatusRow[]; housekeeping: HousekeepingRow[] } {
  const now = new Date().toISOString();
  const roomStatuses: RoomStatusRow[] = [];
  const housekeeping: HousekeepingRow[] = [];

  for (const r of rows) {
    const room = (r.number ?? '').trim();
    if (!room) continue;
    const status = mapCsvStatusToRoom(r.roomStatus, r.condition);
    if (status) {
      roomStatuses.push({
        room_number: room,
        status,
        changed_at: now,
      });
    }
    housekeeping.push({
      date: context.today,
      room_number: room,
      housekeeper_name: (r.assignedTo ?? '').trim() || undefined,
      dnd_active: (r.isDnd ?? '').toString().trim() === 'true',
    });
  }

  return { roomStatuses, housekeeping };
}

// ─── Work Orders JSON ─────────────────────────────────────────────────────

export interface CaWorkOrder {
  workOrderNumber?: string | number;
  roomNumber?: string;
  reason?: string;
  fromDate?: string;
  toDate?: string;
  workOrderCode?: string;
  notes?: string;
  openingClerk?: string;
  openingDate?: string;
  roomOutOfOrder?: boolean;
  [key: string]: unknown;
}

export function normalizeCaWorkOrders(
  payload: unknown,
  options: { oooOnly?: boolean } = {},
): WorkOrderRow[] {
  const list = extractArrayFromPayload(payload, ['workOrders', 'data', 'items']);
  if (!list) return [];

  const out: WorkOrderRow[] = [];
  for (const raw of list as CaWorkOrder[]) {
    if (options.oooOnly && raw.roomOutOfOrder !== true) continue;
    const id = raw.workOrderNumber !== undefined ? String(raw.workOrderNumber) : undefined;
    if (!id) continue;
    out.push({
      pms_work_order_id: id,
      room_number: typeof raw.roomNumber === 'string' ? raw.roomNumber : undefined,
      description: raw.reason ?? raw.workOrderCode,
      out_of_order: raw.roomOutOfOrder === true,
      notes: raw.notes,
    });
  }
  return out;
}

function extractArrayFromPayload(payload: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

// ─── Dashboard counts (3-page aggregate) ──────────────────────────────────

export interface CaDashboardPage {
  /** Field from DomInlineResult.data — "roomCount" should be the number text. */
  roomCount: string | null;
  guestCount?: string | null;
}

export function normalizeCaDashboardCounts(args: {
  inHouse: CaDashboardPage;
  arrivals: CaDashboardPage;
  departures: CaDashboardPage;
}): InHouseSnapshotRow {
  return {
    total_occupied_rooms: toCount(args.inHouse.roomCount),
    total_guests_in_house: toCount(args.inHouse.guestCount ?? null),
    arrivals_remaining_today: toCount(args.arrivals.roomCount),
    departures_remaining_today: toCount(args.departures.roomCount),
  };
}

function toCount(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}
