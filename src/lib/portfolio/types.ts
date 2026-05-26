/**
 * Portfolio layer — type contracts.
 *
 * The portfolio layer is the foundation that every backend module
 * (housekeeping, maintenance, inventory, staff, labor) plugs into to
 * surface its per-property KPIs on the cross-property `/portfolio` page.
 *
 * Contract design — server/client separation:
 *   • Adapters are PURE DATA producers. They fetch + describe a single
 *     property's KPI payload server-side under supabaseAdmin and never
 *     touch React.
 *   • The page hard-codes one React tile-body component per module.
 *     Adding a new module = ship an adapter + add one switch case in
 *     PropertyTile.tsx. This keeps `supabase-admin` (server-only,
 *     throws-at-import on missing env vars) out of client bundles.
 *
 * See `./README.md` for the full plug-in guide.
 */

import type { Property } from '@/types';

// ─── Module identification ───────────────────────────────────────────────

/**
 * Stable IDs for the five planned modules. Add new IDs here when a new
 * module plugs in.
 */
export type PortfolioModuleId =
  | 'housekeeping'
  | 'maintenance'
  | 'inventory'
  | 'staff'
  | 'labor';

// ─── Honesty / accuracy label ─────────────────────────────────────────────

/**
 * Three-state confidence label every tile attaches to its KPIs. Borrowed
 * from the ML "honesty labels" pattern so users can tell at a glance
 * whether a number is grounded in actual data or an early-days estimate.
 *
 *   ai_prediction              — confident: ML or sufficient real data is
 *                                driving the number.
 *   industry_estimate_learning — bootstrapping: industry-average priors
 *                                or partial data while the model warms up.
 *   capacity_unavailable       — no useful data: required inputs (budget,
 *                                wage, schedule, inspections) are missing.
 */
export type AccuracyLabel =
  | 'ai_prediction'
  | 'industry_estimate_learning'
  | 'capacity_unavailable';

// ─── Tile data (housekeeping shape, exported as the canonical first tile) ─

/**
 * Housekeeping module's tile payload. The values are intentionally
 * permissive of `null` because greenfield properties may be missing
 * wage data, budgets, or inspections. The tile UI renders "—" for nulls
 * rather than zero so an operator can't confuse "no data" with "value
 * happens to be zero".
 */
export interface HousekeepingTileData {
  propertyId: string;
  property: Pick<Property, 'id' | 'name' | 'totalRooms'>;

  /** Rooms completed today (cleaning_events.status in 'recorded','approved'). */
  roomsTurned: number;
  /** Rooms still dirty / pending today (from latest pms_room_status_log). */
  roomsRemaining: number;

  /** 0..1 fraction. null when there were no completed inspections today. */
  inspectionPassRate: number | null;

  /** Average duration_minutes for today's checkout cleans. null when none. */
  avgMinutesPerDeparture: number | null;

  /** Labor cost incurred so far today, in integer cents. null when unavailable. */
  laborCostTodayCents: number | null;

  /** Daily labor budget in integer cents. null when no budget is set. */
  laborBudgetTodayCents: number | null;

  /** Staff actively working today (shifts in 'confirmed' state for today). */
  staffActiveCount: number;
  /** Staff scheduled for today (shifts on today with staff_id assigned). */
  staffScheduledCount: number;

  /** Honesty label for the tile's numbers as a whole. */
  accuracyLabel: AccuracyLabel;
}

/**
 * Discriminated-union tile-payload type. Today only housekeeping ships;
 * other modules will widen the union with their own variants.
 */
export type PortfolioTileData =
  | ({ module: 'housekeeping' } & HousekeepingTileData);
// future: | ({ module: 'maintenance' } & MaintenanceTileData)
// future: | ({ module: 'inventory' } & InventoryTileData)
// future: | ({ module: 'staff' } & StaffTileData)
// future: | ({ module: 'labor' } & LaborTileData)

// ─── Anomaly ──────────────────────────────────────────────────────────────

export type AnomalySeverity = 'yellow' | 'red';

/**
 * Anomaly flagged by the detector for one property. The page bubbles
 * the list to the summary banner and to per-tile indicator chips.
 */
export interface PortfolioAnomaly {
  module: PortfolioModuleId;
  propertyId: string;
  propertyName: string;
  metric: string;          // human-readable metric label, EN
  severity: AnomalySeverity;
  /** Plain-English explanation. */
  explanation: string;
}

// ─── The adapter contract ────────────────────────────────────────────────

/**
 * Every module that wants to surface a tile on /portfolio must export
 * one adapter implementing this interface. The adapter is server-side:
 *   • `fetchTileData(propertyId)` runs under supabaseAdmin (the API
 *     route handles cross-property batching).
 *   • `anomalyFlag(data, average)` returns module-specific anomalies on
 *     top of the generic detector. Return null to defer entirely.
 *
 * Rendering is NOT on the adapter. The page hard-codes one tile-body
 * React component per moduleId — see PropertyTile.tsx. This isolation
 * keeps server-only secrets out of client bundles.
 */
export interface PortfolioTileAdapter<TData extends PortfolioTileData = PortfolioTileData> {
  moduleId: PortfolioModuleId;
  /** Bilingual label shown above the module's column. */
  moduleLabel: { en: string; es: string };

  /**
   * Server-side fetch for one property. Must never throw — return a
   * degraded `accuracyLabel: 'capacity_unavailable'` payload on partial
   * failure so the grid can still render.
   */
  fetchTileData: (propertyId: string) => Promise<TData>;

  /**
   * Module-specific anomaly hook. Return null to use only the generic
   * detector; return an array to ADD module-specific anomalies.
   */
  anomalyFlag: (
    data: TData,
    portfolioAvg: PortfolioModuleAverages,
  ) => PortfolioAnomaly[] | null;
}

// ─── Aggregator output ───────────────────────────────────────────────────

/**
 * Portfolio-wide averages, per module. The aggregator computes one entry
 * per module from the array of per-property tile data. The anomaly
 * detector compares each property against this baseline.
 *
 * `null` for a metric means the portfolio doesn't have enough data to
 * compute it.
 */
export interface PortfolioModuleAverages {
  module: PortfolioModuleId;
  propertiesIncluded: number;       // n properties contributing
  avgRoomsTurned: number | null;
  avgRoomsRemaining: number | null;
  avgInspectionPassRate: number | null;
  avgMinutesPerDeparture: number | null;
  avgLaborCostTodayCents: number | null;
  avgLaborBudgetTodayCents: number | null;
  avgStaffActive: number | null;
  avgStaffScheduled: number | null;
}

/** Aggregate totals (summed, not averaged) for the summary banner. */
export interface PortfolioSummary {
  propertiesCount: number;
  totalRoomsTurned: number;
  totalRoomsRemaining: number;
  totalLaborCostTodayCents: number;
  totalLaborBudgetTodayCents: number;
  totalStaffActive: number;
  totalStaffScheduled: number;
  anomalyCount: number;
}
