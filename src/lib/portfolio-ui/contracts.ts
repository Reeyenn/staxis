/**
 * Server-neutral wire contracts for the bounded portfolio UI read model.
 *
 * Keep this module free of React, Next.js, Supabase, and server-only imports.
 * The browser may import these types without pulling authorization or database
 * code into its bundle.
 */

export const PORTFOLIO_UI_VERSION = 'portfolio-ui.v1' as const;

export const PORTFOLIO_UI_SECTIONS = [
  'dashboard',
  'housekeeping',
  'communications',
  'maintenance',
  'inventory',
  'staff',
  'financials',
] as const;

export type PortfolioUiSection = (typeof PORTFOLIO_UI_SECTIONS)[number];
export type PortfolioUiCompanyRole = 'owner' | 'regional_manager';

export function isPortfolioUiSection(value: unknown): value is PortfolioUiSection {
  return typeof value === 'string'
    && (PORTFOLIO_UI_SECTIONS as readonly string[]).includes(value);
}

/** No source failure is represented as a zero or a reassuring `fresh`. */
export type PortfolioUiDataState =
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'partial'
  | 'unavailable'
  | 'disabled';

export interface PortfolioUiFreshness {
  state: PortfolioUiDataState;
  /** Timestamp of the newest source record, not the response generation time. */
  observedAt: string | null;
  /** Calendar date represented by the source when it has one. */
  asOfDate: string | null;
  /** Stable, presentation-neutral explanation for non-fresh states. */
  reason: string | null;
}

export type PortfolioUiIndicatorTone = 'neutral' | 'good' | 'warning' | 'critical';
export type PortfolioUiIndicatorUnit =
  | 'count'
  | 'percent'
  | 'percentage_points'
  | 'currency_cents';

export interface PortfolioUiIndicator {
  key: string;
  value: number | null;
  unit: PortfolioUiIndicatorUnit;
  tone: PortfolioUiIndicatorTone;
  /** True means `value` is only a known minimum because the bounded read filled. */
  lowerBound: boolean;
}

/** Company-level doors. Every boolean is emitted explicitly and defaults closed. */
export interface PortfolioUiCapabilities {
  canReadPortfolio: boolean;
  canActOnFindings: boolean;
  canManageStaff: boolean;
  canViewFinancials: boolean;
  canAskStaxis: boolean;
}

export interface PortfolioUiHotelCapabilities {
  canManageHotel: boolean;
  canViewFinancials: boolean;
}

export interface PortfolioUiCompanyContext {
  organizationId: string;
  organizationName: string | null;
  companyRole: PortfolioUiCompanyRole;
  /** Exact, current hotel coverage from the caller's company-scope hats. */
  hotelIds: string[];
  hotelCount: number;
  /** Whole-company Finding queue visibility from the current receipt. Read-only. */
  queueAvailable: boolean;
  capabilities: PortfolioUiCapabilities;
  chat: {
    state: 'available' | 'disabled' | 'unavailable';
    reason: string | null;
  };
}

export type PortfolioUiHotelStatus = 'neutral' | 'attention' | 'critical' | 'unknown';

export interface PortfolioUiHotel {
  propertyId: string;
  name: string;
  /** Null when the property model has no trustworthy city field. */
  city: string | null;
  region: string | null;
  brand: string | null;
  totalRooms: number;
  timezone: string | null;
  /** Every authorized company context that covers this hotel. Usually one. */
  contextIds: string[];
  /** Effective legacy-role vocabulary at this hotel; null is no capacity claim. */
  roleAtHotel: string | null;
  capabilities: PortfolioUiHotelCapabilities;
  /** Strictly decoded. A malformed/failed policy read yields all false. */
  sections: Record<PortfolioUiSection, boolean>;
  freshness: PortfolioUiFreshness;
  partial: boolean;
  /** Never claims "healthy"; neutral means the bounded read found no attention item. */
  status: PortfolioUiHotelStatus;
  /** Null when the attention feed was unavailable or incomplete. */
  attention: boolean | null;
  indicators: PortfolioUiIndicator[];
}

export interface PortfolioUiCoverage {
  /** Authorized ids in scope before any storage/page limitation. */
  total: number;
  /** Rows actually represented in this response. */
  shown: number;
  /** `total - shown`; never hidden behind a hard-coded hotel cap. */
  omitted: number;
}

export interface PortfolioUiEntryDecisionInputs {
  mode: 'portfolio' | 'company_picker' | 'hotel';
  companyCount: number;
  legacyHotelCount: number;
  requiresCompanySelection: boolean;
}

export interface PortfolioUiSelection {
  requestedOrganizationId: string | null;
  selectedOrganizationId: string | null;
  state: 'selected' | 'needs_selection' | 'hotel_only';
}

export interface PortfolioUiBootstrapV1 {
  version: typeof PORTFOLIO_UI_VERSION;
  generatedAt: string;
  /** True only when the account holds an owner/regional-manager company hat,
   * even if that hat currently covers no hotels. */
  hasCompanyHat: boolean;
  contexts: PortfolioUiCompanyContext[];
  entry: PortfolioUiEntryDecisionInputs;
  selection: PortfolioUiSelection;
  /** Non-null only after the server has matched it to a current authorized hat. */
  selectedCompany: PortfolioUiCompanyContext | null;
  /** Union of current hat coverage and legacy property access, never capped. */
  hotels: PortfolioUiHotel[];
  coverage: PortfolioUiCoverage;
  partial: boolean;
  missingPropertyIds: string[];
}

export interface PortfolioUiSectionHotel {
  propertyId: string;
  name: string;
  city: string | null;
  region: string | null;
  brand: string | null;
  freshness: PortfolioUiFreshness;
  partial: boolean;
  indicators: PortfolioUiIndicator[];
  /** Opaque row ids only; no guest message, employee, or financial row bodies. */
  drilldownIds: string[];
  drilldownOmitted: number;
}

export interface PortfolioUiDashboardSummary {
  kind: 'dashboard';
  reportingHotels: number | null;
  occupiedRooms: number | null;
  availableRooms: number | null;
  occupancyPercent: number | null;
  occupancyComparisonHotels: number | null;
  recentOccupancyPercent: number | null;
  priorOccupancyPercent: number | null;
  occupancyChangePoints: number | null;
  financialReportingHotels: number | null;
  financialComparisonHotels: number | null;
  monthToDateRevenueCents: number | null;
  priorPeriodRevenueCents: number | null;
  revenueChangePercent: number | null;
}

export interface PortfolioUiHousekeepingSummary {
  kind: 'housekeeping';
  reportingHotels: number | null;
  openTasks: number | null;
  urgentTasks: number | null;
  completedTasks: number | null;
  completionPercent: number | null;
  staffingReportingHotels: number | null;
  staffedShifts: number | null;
  openStaffingSlots: number | null;
  staffingCoveragePercent: number | null;
}

export interface PortfolioUiCommunicationsSummary {
  kind: 'communications';
  reportingHotels: number | null;
  openItems: number | null;
  highSeverityItems: number | null;
  announcements: number | null;
  companyAnnouncements: number | null;
  acknowledgementResponses: number | null;
  pendingAcknowledgements: number | null;
  acknowledgementPercent: number | null;
}

export interface PortfolioUiMaintenanceSummary {
  kind: 'maintenance';
  reportingHotels: number | null;
  openWorkOrders: number | null;
  urgentWorkOrders: number | null;
  highPriorityWorkOrders: number | null;
  agingWorkOrders: number | null;
  recurringEquipmentIssues: number | null;
  degradedEquipment: number | null;
}

export interface PortfolioUiInventorySummary {
  kind: 'inventory';
  reportingHotels: number | null;
  trackedItems: number | null;
  lowStockItems: number | null;
  uncountedItems: number | null;
  comparableSpendHotels: number | null;
  lastClosedSpendCents: number | null;
  priorClosedSpendCents: number | null;
  spendVariancePercent: number | null;
}

export interface PortfolioUiStaffSummary {
  kind: 'staff';
  reportingHotels: number | null;
  assignedShifts: number | null;
  openShifts: number | null;
  scheduledPeople: number | null;
  activeStaff: number | null;
  keyLeaders: number | null;
  departmentsWithoutCoverage: number | null;
  staffingCoveragePercent: number | null;
}

export interface PortfolioUiFinancialsSummary {
  kind: 'financials';
  reportingHotels: number | null;
  monthToDateRevenueCents: number | null;
  occupiedRooms: number | null;
  comparisonHotels: number | null;
  priorPeriodRevenueCents: number | null;
  revenueChangePercent: number | null;
  occupancyPercent: number | null;
  adrCents: number | null;
  revparCents: number | null;
  grossOperatingProfitCents: number | null;
}

export type PortfolioUiSectionSummary =
  | PortfolioUiDashboardSummary
  | PortfolioUiHousekeepingSummary
  | PortfolioUiCommunicationsSummary
  | PortfolioUiMaintenanceSummary
  | PortfolioUiInventorySummary
  | PortfolioUiStaffSummary
  | PortfolioUiFinancialsSummary;

export interface PortfolioUiSectionV1 {
  version: typeof PORTFOLIO_UI_VERSION;
  generatedAt: string;
  organizationId: string;
  section: PortfolioUiSection;
  capabilities: PortfolioUiCapabilities;
  coverage: PortfolioUiCoverage;
  partial: boolean;
  missingPropertyIds: string[];
  summary: PortfolioUiSectionSummary;
  hotels: PortfolioUiSectionHotel[];
}

export type PortfolioUiServerErrorCode =
  | 'invalid_request'
  | 'company_not_authorized'
  | 'company_required'
  | 'financials_forbidden'
  | 'access_unavailable'
  | 'data_unavailable';

export type PortfolioUiServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 403 | 503;
      code: PortfolioUiServerErrorCode;
      message: string;
    };
