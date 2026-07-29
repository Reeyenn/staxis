import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { managerManagesHotel, type ManagerCaller } from '@/lib/team-auth';
import { resolveEffectiveRole } from '@/lib/company/access';
import { isCompanyScopeRole } from '@/lib/company/roles';
import { canViewFinancials } from '@/lib/roles';
import { normalizeWorkOrderSeverity } from '@/lib/db-mappers';
import { stockStatus } from '@/lib/stock-status';
import { parseStoredEnabledSections } from '@/lib/sections/server';
import { isSectionEnabled } from '@/lib/sections/registry';
import { addDaysInTz, propertyLocalToday } from '@/lib/schedule/local-date';
import {
  PORTFOLIO_DATA_SECTIONS,
  portfolioHotelFindingPolicyDecision,
  type PortfolioQueuePolicy,
} from '@/lib/company/portfolio-data-policy';
import { readPortfolioToolFindings } from '@/lib/company/portfolio-tool-reads';
import {
  PORTFOLIO_UI_SECTIONS,
  PORTFOLIO_UI_VERSION,
  type PortfolioUiBootstrapV1,
  type PortfolioUiCapabilities,
  type PortfolioUiCompanyContext,
  type PortfolioUiCompanyRole,
  type PortfolioUiCoverage,
  type PortfolioUiFreshness,
  type PortfolioUiHotel,
  type PortfolioUiHotelCapabilities,
  type PortfolioUiHotelStatus,
  type PortfolioUiIndicator,
  type PortfolioUiSection,
  type PortfolioUiSectionHotel,
  type PortfolioUiSectionSummary,
  type PortfolioUiSectionV1,
  type PortfolioUiServerResult,
} from './contracts';
import { isPortfolioUiUuid } from './context';
import type { ManagementCompanyPropertyStanding } from '@/lib/company/authoritative-scope';
import type { OrganizationCapability } from '@/lib/organization-access/domain';
import { standingHasLocalHotelContext } from './local-hotel-authority';

const MAX_PROPERTY_ROWS = 5_000;
const MAX_BULK_ROWS = 10_000;
const MAX_DRILLDOWN_IDS_PER_HOTEL = 50;
const MAX_PORTFOLIO_FINDINGS_PER_HOTEL = 50;
const MAX_PORTFOLIO_FINDING_HOTELS = 50;
const FINDING_RUN_LOOKBACK_DAYS = 14;
const FRESH_FINDING_RUN_MS = 36 * 60 * 60 * 1_000;

interface OrganizationRow {
  id: string;
  name: string | null;
}

interface PropertyRow {
  id: string;
  name: string | null;
  brand: string | null;
  region: string | null;
  total_rooms: number | string | null;
  timezone: string | null;
  enabled_sections: unknown;
  updated_at: string | null;
}

interface FinancialOverrideRow {
  property_id: string;
  role: string;
  allowed: boolean;
}

interface CompanyChatRow {
  organization_id: string;
  setting_value: string;
}

interface FindingRunRow extends Record<string, unknown> {
  id?: unknown;
  property_id?: unknown;
  run_at?: unknown;
  run_date?: unknown;
  detectors_checked?: unknown;
  detectors_skipped?: unknown;
  detectors_failed?: unknown;
}

interface FindingRow extends Record<string, unknown> {
  id?: unknown;
  property_id?: unknown;
  detector_id?: unknown;
  summary?: unknown;
  judged_summary_en?: unknown;
  judged_summary_es?: unknown;
  evidence?: unknown;
  severity?: unknown;
  price_low_cents?: unknown;
  price_high_cents?: unknown;
  price_currency?: unknown;
  price_basis?: unknown;
  updated_at?: unknown;
}

export interface PortfolioUiBulkRows<T> {
  rows: T[];
  /** Exact matched-row count when the backing store supplied one. */
  total: number | null;
  /** False means the bounded page may have omitted rows. */
  complete: boolean;
  /** Hotels whose per-hotel row window filled and therefore only has a lower bound. */
  saturatedPropertyIds?: string[];
  /** Hotels whose exact company-intersected bucket was denied, missing, or too large to transfer. */
  unavailablePropertyIds?: string[];
}

/** Injectable fixed-query data plane. Tests use this without mocking auth. */
export interface PortfolioUiDataSource {
  readOrganizations(organizationIds: readonly string[]): Promise<OrganizationRow[]>;
  readProperties(propertyIds: readonly string[] | null): Promise<PortfolioUiBulkRows<PropertyRow>>;
  readFinancialOverrides(propertyIds: readonly string[]): Promise<FinancialOverrideRow[]>;
  readCompanyChatSettings(organizationIds: readonly string[]): Promise<CompanyChatRow[]>;
  readFindingRuns(
    propertyIds: readonly string[],
    sinceIso: string,
    limit: number,
  ): Promise<PortfolioUiBulkRows<FindingRunRow>>;
  readFindings(
    propertyIds: readonly string[],
    limit: number,
  ): Promise<PortfolioUiBulkRows<FindingRow>>;
  readPortfolioFindings(
    organizationId: string,
    propertyIds: readonly string[],
    limitPerProperty: number,
  ): Promise<PortfolioUiBulkRows<FindingRow>>;
  readSectionRows(
    section: PortfolioUiSection,
    propertyIds: readonly string[],
    financialPropertyIds: readonly string[],
    now: Date,
    limit: number,
  ): Promise<PortfolioUiBulkRows<Record<string, unknown>>>;
}

const INTERNAL_ROW_SOURCE = '__portfolio_source';
const INTERNAL_DRILLDOWN = '__portfolio_drilldown';

type SectionRowSource =
  | 'dashboard_occupancy'
  | 'dashboard_financial'
  | 'housekeeping_task'
  | 'housekeeping_shift'
  | 'communications_escalation'
  | 'communications_announcement'
  | 'communications_acknowledgement'
  | 'communications_roster'
  | 'maintenance_open'
  | 'maintenance_history'
  | 'maintenance_equipment'
  | 'inventory_item'
  | 'inventory_close'
  | 'staff_shift'
  | 'staff_roster'
  | 'financial_daily';

const SECTION_ROW_SOURCES = new Set<SectionRowSource>([
  'dashboard_occupancy',
  'dashboard_financial',
  'housekeeping_task',
  'housekeeping_shift',
  'communications_escalation',
  'communications_announcement',
  'communications_acknowledgement',
  'communications_roster',
  'maintenance_open',
  'maintenance_history',
  'maintenance_equipment',
  'inventory_item',
  'inventory_close',
  'staff_shift',
  'staff_roster',
  'financial_daily',
]);

function taggedBulkRows<T extends Record<string, unknown>>(
  rows: T[] | null,
  count: number | null,
  limit: number,
  source: SectionRowSource,
  drilldownEligible: boolean,
): PortfolioUiBulkRows<Record<string, unknown>> {
  const read = bulkRows(rows, count, limit);
  return {
    ...read,
    rows: read.rows.map((row) => ({
      ...row,
      [INTERNAL_ROW_SOURCE]: source,
      [INTERNAL_DRILLDOWN]: drilldownEligible,
    })),
  };
}

function combineBulkRows(
  reads: readonly PortfolioUiBulkRows<Record<string, unknown>>[],
): PortfolioUiBulkRows<Record<string, unknown>> {
  return {
    rows: reads.flatMap((read) => read.rows),
    total: reads.every((read) => read.total != null)
      ? reads.reduce((sum, read) => sum + (read.total ?? 0), 0)
      : null,
    complete: reads.every((read) => read.complete),
  };
}

function monthStartOffset(date: string, offset: number): string {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
}

/**
 * At the start of a UTC month, hotels west of UTC can still be closing the
 * prior local month. Their comparable prior period is therefore two UTC
 * month offsets back until even UTC-12 has crossed midnight.
 */
function portfolioFinancialHistoryStart(now: Date): string {
  const utcToday = now.toISOString().slice(0, 10);
  const westernHotelStillInPriorMonth = utcToday.endsWith('-01') && now.getUTCHours() < 12;
  return monthStartOffset(utcToday, westernHotelStillInPriorMonth ? -2 : -1);
}

function bulkRows<T>(
  rows: T[] | null,
  count: number | null,
  limit: number,
): PortfolioUiBulkRows<T> {
  const safeRows = rows ?? [];
  return {
    rows: safeRows,
    total: typeof count === 'number' ? count : null,
    complete: typeof count === 'number' ? count <= safeRows.length : safeRows.length < limit,
  };
}

function throwRead(label: string, error: { message?: string } | null): never {
  throw new Error(`${label} failed${error?.message ? `: ${error.message}` : ''}`);
}

export const portfolioUiDataSource: PortfolioUiDataSource = {
  async readOrganizations(organizationIds) {
    if (organizationIds.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('id, name')
      .in('id', [...organizationIds]);
    if (error || !Array.isArray(data)) throwRead('portfolio organization read', error);
    return data as OrganizationRow[];
  },

  async readProperties(propertyIds) {
    if (propertyIds !== null && propertyIds.length === 0) {
      return bulkRows([], 0, MAX_PROPERTY_ROWS);
    }
    let query = supabaseAdmin
      .from('properties')
      .select('id, name, brand, region, total_rooms, timezone, enabled_sections, updated_at', {
        count: 'exact',
      });
    if (propertyIds !== null) query = query.in('id', [...propertyIds]);
    const { data, error, count } = await query
      .order('name', { ascending: true })
      .range(0, MAX_PROPERTY_ROWS - 1);
    if (error || !Array.isArray(data)) throwRead('portfolio property read', error);
    return bulkRows(data as unknown as PropertyRow[], count, MAX_PROPERTY_ROWS);
  },

  async readFinancialOverrides(propertyIds) {
    if (propertyIds.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from('capability_overrides')
      .select('property_id, role, allowed')
      .in('property_id', [...propertyIds])
      .eq('capability', 'view_financials');
    if (error || !Array.isArray(data)) throwRead('portfolio capability read', error);
    return data as FinancialOverrideRow[];
  },

  async readCompanyChatSettings(organizationIds) {
    if (organizationIds.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from('company_access_settings')
      .select('organization_id, setting_value')
      .in('organization_id', [...organizationIds])
      .eq('setting_key', 'cross_hotel_ai_chat');
    if (error || !Array.isArray(data)) throwRead('portfolio chat-setting read', error);
    return data as unknown as CompanyChatRow[];
  },

  async readFindingRuns(propertyIds, sinceIso, limit) {
    if (propertyIds.length === 0) return bulkRows([], 0, limit);
    const { data, error, count } = await supabaseAdmin
      .from('finding_runs')
      .select(
        'id, property_id, run_at, run_date, detectors_checked, detectors_skipped, detectors_failed',
        { count: 'exact' },
      )
      .in('property_id', [...propertyIds])
      .gte('run_at', sinceIso)
      .order('run_at', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) throwRead('portfolio finding-run read', error);
    return bulkRows(data as unknown as FindingRunRow[], count, limit);
  },

  async readFindings(propertyIds, limit) {
    if (propertyIds.length === 0) return bulkRows([], 0, limit);
    const { data, error, count } = await supabaseAdmin
      .from('findings')
      .select(
        'id, property_id, detector_id, summary, judged_summary_en, judged_summary_es, evidence, severity, status, price_low_cents, price_high_cents, price_currency, price_basis, updated_at',
        { count: 'exact' },
      )
      .in('property_id', [...propertyIds])
      .in('status', ['open', 'updated'])
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) throwRead('portfolio findings read', error);
    return bulkRows(data as unknown as FindingRow[], count, limit);
  },

  async readPortfolioFindings(organizationId, propertyIds, limitPerProperty) {
    const read = await readPortfolioToolFindings(
      organizationId,
      propertyIds,
      ['open', 'updated'],
      limitPerProperty,
    );
    const visibleLimit = Math.max(0, limitPerProperty - 1);
    const saturatedPropertyIds: string[] = [];
    const rows: FindingRow[] = [];
    for (const propertyId of propertyIds) {
      const bucket = read.rowsByPropertyId.get(propertyId);
      if (!bucket) continue;
      if (bucket.length > visibleLimit) saturatedPropertyIds.push(propertyId);
      rows.push(...bucket.slice(0, visibleLimit) as FindingRow[]);
    }
    const unavailablePropertyIds = [...read.unavailablePropertyIds];
    const complete = saturatedPropertyIds.length === 0 && unavailablePropertyIds.length === 0;
    return {
      rows,
      total: complete ? rows.length : null,
      complete,
      saturatedPropertyIds,
      unavailablePropertyIds,
    };
  },

  async readSectionRows(section, propertyIds, financialPropertyIds, now, limit) {
    if (propertyIds.length === 0) return bulkRows([], 0, limit);
    const utcToday = now.toISOString().slice(0, 10);
    const nearbyStart = addDaysInTz(utcToday, -2);
    const nearbyEnd = addDaysInTz(utcToday, 2);
    const partLimit = (share: number) => Math.max(
      propertyIds.length,
      Math.min(limit, Math.floor(limit * share)),
    );

    if (section === 'dashboard') {
      const occupancyLimit = partLimit(0.3);
      const financialLimit = partLimit(0.7);
      const occupancyStart = addDaysInTz(utcToday, -15);
      const financialStart = portfolioFinancialHistoryStart(now);
      const [occupancyRead, financialRead] = await Promise.all([
        supabaseAdmin
          .from('pms_revenue_daily_current')
          .select(
            'id, property_id, business_date, occupied_rooms, available_rooms, occupancy_pct, last_synced_at, updated_at',
            { count: 'exact' },
          )
          .in('property_id', [...propertyIds])
          .gte('business_date', occupancyStart)
          .lte('business_date', nearbyEnd)
          .order('business_date', { ascending: false })
          .limit(occupancyLimit),
        financialPropertyIds.length === 0
          ? Promise.resolve({ data: [], error: null, count: 0 })
          : supabaseAdmin
            .from('pms_revenue_daily_current')
            .select(
              'id, property_id, business_date, total_revenue_cents, last_synced_at, updated_at',
              { count: 'exact' },
            )
            .in('property_id', [...financialPropertyIds])
            .gte('business_date', financialStart)
            .lte('business_date', nearbyEnd)
            .order('business_date', { ascending: false })
            .limit(financialLimit),
      ]);
      if (occupancyRead.error || !Array.isArray(occupancyRead.data)) {
        throwRead('portfolio dashboard occupancy read', occupancyRead.error);
      }
      if (financialRead.error || !Array.isArray(financialRead.data)) {
        throwRead('portfolio dashboard financial read', financialRead.error);
      }
      return combineBulkRows([
        taggedBulkRows(
          occupancyRead.data as unknown as Record<string, unknown>[],
          occupancyRead.count,
          occupancyLimit,
          'dashboard_occupancy',
          false,
        ),
        taggedBulkRows(
          financialRead.data as unknown as Record<string, unknown>[],
          financialRead.count,
          financialLimit,
          'dashboard_financial',
          false,
        ),
      ]);
    }

    if (section === 'housekeeping') {
      const taskLimit = partLimit(0.7);
      const shiftLimit = partLimit(0.3);
      const [taskRead, shiftRead] = await Promise.all([
        supabaseAdmin
          .from('cleaning_tasks')
          .select('id, property_id, business_date, status, priority, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .gte('business_date', nearbyStart)
          .lte('business_date', nearbyEnd)
          .order('updated_at', { ascending: false })
          .limit(taskLimit),
        supabaseAdmin
          .from('scheduled_shifts')
          .select('id, property_id, shift_date, kind, status, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .eq('department', 'housekeeping')
          .gte('shift_date', nearbyStart)
          .lte('shift_date', nearbyEnd)
          .neq('status', 'declined')
          .order('updated_at', { ascending: false })
          .limit(shiftLimit),
      ]);
      if (taskRead.error || !Array.isArray(taskRead.data)) {
        throwRead('portfolio housekeeping task read', taskRead.error);
      }
      if (shiftRead.error || !Array.isArray(shiftRead.data)) {
        throwRead('portfolio housekeeping staffing read', shiftRead.error);
      }
      return combineBulkRows([
        taggedBulkRows(
          taskRead.data as unknown as Record<string, unknown>[],
          taskRead.count,
          taskLimit,
          'housekeeping_task',
          true,
        ),
        taggedBulkRows(
          shiftRead.data as unknown as Record<string, unknown>[],
          shiftRead.count,
          shiftLimit,
          'housekeeping_shift',
          false,
        ),
      ]);
    }

    if (section === 'communications') {
      // Deliberately excludes guest/contact fields, message bodies, previews,
      // direct-message rows, names, phone numbers, and staff profile fields.
      const escalationLimit = partLimit(0.35);
      const announcementLimit = partLimit(0.25);
      const acknowledgementLimit = partLimit(0.2);
      const rosterLimit = partLimit(0.2);
      const sinceIso = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      const [escalationRead, announcementRead, acknowledgementRead, rosterRead] = await Promise.all([
        supabaseAdmin
          .from('complaints')
          .select('id, property_id, status, severity, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .in('status', ['open', 'in_progress'])
          .order('updated_at', { ascending: false })
          .limit(escalationLimit),
        supabaseAdmin
          .from('comms_messages')
          .select(
            'id, property_id, created_at, requires_ack, ack_campaign_id, sender_staff_id',
            { count: 'exact' },
          )
          .in('property_id', [...propertyIds])
          .eq('msg_type', 'announcement')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(announcementLimit),
        supabaseAdmin
          .from('comms_acknowledgements')
          .select('property_id, message_id, staff_id, acknowledged_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .gte('acknowledged_at', sinceIso)
          .order('acknowledged_at', { ascending: false })
          .limit(acknowledgementLimit),
        supabaseAdmin
          .from('staff')
          .select('property_id, id, created_at, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(rosterLimit),
      ]);
      if (escalationRead.error || !Array.isArray(escalationRead.data)) {
        throwRead('portfolio communications escalation read', escalationRead.error);
      }
      if (announcementRead.error || !Array.isArray(announcementRead.data)) {
        throwRead('portfolio communications announcement read', announcementRead.error);
      }
      if (acknowledgementRead.error || !Array.isArray(acknowledgementRead.data)) {
        throwRead('portfolio communications acknowledgement read', acknowledgementRead.error);
      }
      if (rosterRead.error || !Array.isArray(rosterRead.data)) {
        throwRead('portfolio communications roster read', rosterRead.error);
      }
      return combineBulkRows([
        taggedBulkRows(
          escalationRead.data as unknown as Record<string, unknown>[],
          escalationRead.count,
          escalationLimit,
          'communications_escalation',
          true,
        ),
        taggedBulkRows(
          announcementRead.data as unknown as Record<string, unknown>[],
          announcementRead.count,
          announcementLimit,
          'communications_announcement',
          false,
        ),
        taggedBulkRows(
          acknowledgementRead.data as unknown as Record<string, unknown>[],
          acknowledgementRead.count,
          acknowledgementLimit,
          'communications_acknowledgement',
          false,
        ),
        taggedBulkRows(
          rosterRead.data as unknown as Record<string, unknown>[],
          rosterRead.count,
          rosterLimit,
          'communications_roster',
          false,
        ),
      ]);
    }

    if (section === 'maintenance') {
      const openLimit = partLimit(0.45);
      const historyLimit = partLimit(0.35);
      const equipmentLimit = partLimit(0.2);
      const historyStart = new Date(now.getTime() - 90 * 86_400_000).toISOString();
      const [openRead, historyRead, equipmentRead] = await Promise.all([
        supabaseAdmin
          .from('work_orders')
          .select('id, property_id, status, severity, equipment_id, created_at, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .or('status.is.null,status.neq.resolved')
          .order('updated_at', { ascending: false })
          .limit(openLimit),
        supabaseAdmin
          .from('work_orders')
          .select('id, property_id, status, equipment_id, created_at, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .gte('created_at', historyStart)
          .order('created_at', { ascending: false })
          .limit(historyLimit),
        supabaseAdmin
          .from('equipment')
          .select('id, property_id, status, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .in('status', ['degraded', 'failed'])
          .order('updated_at', { ascending: false })
          .limit(equipmentLimit),
      ]);
      if (openRead.error || !Array.isArray(openRead.data)) {
        throwRead('portfolio maintenance open-work read', openRead.error);
      }
      if (historyRead.error || !Array.isArray(historyRead.data)) {
        throwRead('portfolio maintenance recurrence read', historyRead.error);
      }
      if (equipmentRead.error || !Array.isArray(equipmentRead.data)) {
        throwRead('portfolio maintenance equipment read', equipmentRead.error);
      }
      return combineBulkRows([
        taggedBulkRows(
          openRead.data as unknown as Record<string, unknown>[],
          openRead.count,
          openLimit,
          'maintenance_open',
          true,
        ),
        taggedBulkRows(
          historyRead.data as unknown as Record<string, unknown>[],
          historyRead.count,
          historyLimit,
          'maintenance_history',
          false,
        ),
        taggedBulkRows(
          equipmentRead.data as unknown as Record<string, unknown>[],
          equipmentRead.count,
          equipmentLimit,
          'maintenance_equipment',
          false,
        ),
      ]);
    }

    if (section === 'inventory') {
      const itemLimit = partLimit(0.75);
      const closeLimit = partLimit(0.25);
      const closeStart = monthStartOffset(utcToday, -4);
      const [itemRead, closeRead] = await Promise.all([
        supabaseAdmin
          .from('inventory')
          .select('id, property_id, current_stock, par_level, last_counted_at, updated_at', {
            count: 'exact',
          })
          .in('property_id', [...propertyIds])
          .is('archived_at', null)
          .order('updated_at', { ascending: false })
          .limit(itemLimit),
        financialPropertyIds.length === 0
          ? Promise.resolve({ data: [], error: null, count: 0 })
          : supabaseAdmin
            .from('inventory_month_closes')
            .select(
              'id, property_id, month_start, status, is_partial, confirmed_purchase_cents, updated_at',
              { count: 'exact' },
            )
            .in('property_id', [...financialPropertyIds])
            .eq('status', 'closed')
            .gte('month_start', closeStart)
            .order('month_start', { ascending: false })
            .limit(closeLimit),
      ]);
      if (itemRead.error || !Array.isArray(itemRead.data)) {
        throwRead('portfolio inventory item read', itemRead.error);
      }
      if (closeRead.error || !Array.isArray(closeRead.data)) {
        throwRead('portfolio inventory closed-period read', closeRead.error);
      }
      return combineBulkRows([
        taggedBulkRows(
          itemRead.data as unknown as Record<string, unknown>[],
          itemRead.count,
          itemLimit,
          'inventory_item',
          true,
        ),
        taggedBulkRows(
          closeRead.data as unknown as Record<string, unknown>[],
          closeRead.count,
          closeLimit,
          'inventory_close',
          false,
        ),
      ]);
    }

    if (section === 'staff') {
      // Opaque staff ids are used only for distinct counts server-side. Names,
      // contact details, wages, notes, and schedules outside the bounded window
      // are never selected or returned.
      const shiftLimit = partLimit(0.65);
      const rosterLimit = partLimit(0.35);
      const [shiftRead, rosterRead] = await Promise.all([
        supabaseAdmin
          .from('scheduled_shifts')
          .select('id, property_id, staff_id, department, shift_date, kind, status, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .gte('shift_date', nearbyStart)
          .lte('shift_date', nearbyEnd)
          .neq('status', 'declined')
          .order('updated_at', { ascending: false })
          .limit(shiftLimit),
        supabaseAdmin
          .from('staff')
          .select('property_id, department, is_scheduling_manager, is_senior, updated_at', { count: 'exact' })
          .in('property_id', [...propertyIds])
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(rosterLimit),
      ]);
      if (shiftRead.error || !Array.isArray(shiftRead.data)) {
        throwRead('portfolio staff schedule read', shiftRead.error);
      }
      if (rosterRead.error || !Array.isArray(rosterRead.data)) {
        throwRead('portfolio staff roster read', rosterRead.error);
      }
      return combineBulkRows([
        taggedBulkRows(
          shiftRead.data as unknown as Record<string, unknown>[],
          shiftRead.count,
          shiftLimit,
          'staff_shift',
          true,
        ),
        taggedBulkRows(
          rosterRead.data as unknown as Record<string, unknown>[],
          rosterRead.count,
          rosterLimit,
          'staff_roster',
          false,
        ),
      ]);
    }

    const financialStart = portfolioFinancialHistoryStart(now);
    const { data, error, count } = await supabaseAdmin
      .from('pms_revenue_daily_current')
      .select(
        'id, property_id, business_date, total_revenue_cents, rooms_revenue_cents, gross_operating_profit_cents, occupied_rooms, available_rooms, adr_cents, revpar_cents, last_synced_at, updated_at',
        { count: 'exact' },
      )
      .in('property_id', [...propertyIds])
      .gte('business_date', financialStart)
      .lte('business_date', nearbyEnd)
      .order('business_date', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) throwRead('portfolio financials read', error);
    return taggedBulkRows(
      data as unknown as Record<string, unknown>[],
      count,
      limit,
      'financial_daily',
      false,
    );
  },
};

interface ContextFact {
  organizationId: string;
  organizationName: string | null;
  companyRole: PortfolioUiCompanyRole;
  hotelIds: string[];
  queueAvailable: boolean;
  propertyStandings: ManagementCompanyPropertyStanding[];
  presentationCapabilities: OrganizationCapability[];
}

const COMPANY_ROLE_STRENGTH: Record<PortfolioUiCompanyRole, number> = {
  owner: 3,
  vp: 2,
  finance: 1,
};

export interface PortfolioUiAuthoritativeCompany {
  organizationId: string;
  organizationName: string | null;
  companyRole: PortfolioUiCompanyRole;
  propertyIds: readonly string[];
  queueAvailable: boolean;
  propertyStandings: readonly ManagementCompanyPropertyStanding[];
  presentationCapabilities: readonly OrganizationCapability[];
}

/** Current company contexts projected only from fresh authoritative receipts. */
export function authorizedPortfolioUiContexts(
  input: readonly PortfolioUiAuthoritativeCompany[] | Pick<ManagerCaller, 'hats' | 'propertyStandings' | 'role' | 'propertyAccess'>,
): ContextFact[] {
  // Unit/data-plane callers from before the authoritative route integration
  // may still exercise the pure projector with a synthetic ManagerCaller.
  // Production routes always supply receipt-derived companies explicitly.
  const companies: readonly PortfolioUiAuthoritativeCompany[] = Array.isArray(input)
    ? input
    : (() => {
        const account = input as Pick<
          ManagerCaller,
          'hats' | 'propertyStandings' | 'role' | 'propertyAccess'
        >;
        const grouped = new Map<string, {
          role: PortfolioUiCompanyRole;
          propertyIds: Set<string>;
        }>();
        for (const hat of account.hats ?? []) {
          if (hat.scope !== 'company' || !isCompanyScopeRole(hat.role)) continue;
          const role = hat.role as PortfolioUiCompanyRole;
          const current = grouped.get(hat.organizationId);
          if (!current) {
            grouped.set(hat.organizationId, {
              role,
              propertyIds: new Set(hat.coveredPropertyIds),
            });
          } else {
            if (COMPANY_ROLE_STRENGTH[role] > COMPANY_ROLE_STRENGTH[current.role]) {
              current.role = role;
            }
            for (const propertyId of hat.coveredPropertyIds) current.propertyIds.add(propertyId);
          }
        }
        return [...grouped.entries()].map(([organizationId, group]) => ({
          organizationId,
          organizationName: null,
          companyRole: group.role,
          propertyIds: [...group.propertyIds].sort(),
          queueAvailable: true,
          propertyStandings: [...group.propertyIds].sort().map((propertyId) => {
            const authoritative = account.propertyStandings
              ?.find((standing) => standing.propertyId === propertyId);
            const effective = resolveEffectiveRole({
              legacyRole: account.role,
              legacyPropertyAccess: account.propertyAccess,
              hats: account.hats ?? [],
            }, propertyId);
            return {
              propertyId,
              operationalRole: authoritative?.operationalRole === 'general_manager'
                || authoritative?.operationalRole === 'owner'
                ? 'general_manager' as const
                : 'front_desk' as const,
              canManageHotel: authoritative?.hotelMutationAllowed
                ?? managerManagesHotel(account as ManagerCaller, propertyId),
              seesFinancials: authoritative?.seesFinancials ?? effective.seesFinancials,
              portfolioIntelligenceRead: true as const,
            };
          }),
          presentationCapabilities: group.role === 'finance'
            ? ['portfolio_intelligence_read' as const]
            : ['portfolio_intelligence_read' as const, 'manage_people' as const],
        }));
      })();
  return companies
    .map((company) => ({
      organizationId: company.organizationId,
      organizationName: company.organizationName,
      companyRole: company.companyRole,
      hotelIds: [...company.propertyIds],
      queueAvailable: company.queueAvailable,
      propertyStandings: [...company.propertyStandings],
      presentationCapabilities: [...company.presentationCapabilities],
    }))
    .sort((a, b) => a.organizationId.localeCompare(b.organizationId));
}

function authorizedPropertyIds(account: ManagerCaller): string[] | null {
  if (account.reachesAllProperties || account.role === 'admin' || account.propertyAccess.includes('*')) {
    return null;
  }
  return [...new Set([
    ...account.propertyAccess,
    ...(account.hats ?? []).flatMap((hat) => hat.coveredPropertyIds),
  ])].filter((id) => id !== '*').sort();
}

function strictSections(raw: unknown): {
  sections: Record<PortfolioUiSection, boolean>;
  staxisEnabled: boolean;
  malformed: boolean;
} {
  const closed = Object.fromEntries(PORTFOLIO_UI_SECTIONS.map((key) => [key, false])) as
    Record<PortfolioUiSection, boolean>;
  try {
    const stored = parseStoredEnabledSections(raw);
    return {
      sections: Object.fromEntries(
        PORTFOLIO_UI_SECTIONS.map((key) => [key, isSectionEnabled(stored, key)]),
      ) as Record<PortfolioUiSection, boolean>,
      staxisEnabled: isSectionEnabled(stored, 'staxis'),
      malformed: false,
    };
  } catch {
    return { sections: closed, staxisEnabled: false, malformed: true };
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed == null || parsed < 0 ? null : Math.round(parsed);
}

function roomCount(value: unknown): number {
  return nonNegativeInt(value) ?? 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function canonicalUuid(value: unknown): string | null {
  if (!isPortfolioUiUuid(value)) return null;
  const canonical = value.toLowerCase();
  return value === canonical ? canonical : null;
}

function validBulkEnvelope(value: unknown): value is PortfolioUiBulkRows<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const read = value as Partial<PortfolioUiBulkRows<unknown>>;
  if (!Array.isArray(read.rows) || typeof read.complete !== 'boolean') return false;
  if (read.total !== null
      && (!Number.isSafeInteger(read.total) || (read.total ?? -1) < read.rows.length)) {
    return false;
  }
  if (read.complete && read.total !== null && read.total !== read.rows.length) return false;
  return true;
}

function validNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function validNullableTimestamp(value: unknown): boolean {
  return value === null
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

/**
 * Treat the access resolver's exact ids as the only legal property adapter
 * scope. A duplicate, malformed, or extra row fails the whole projection;
 * silently filtering would let a compromised adapter influence totals and
 * capability reads even if its hotel card never rendered.
 */
function validatePropertyRead(
  value: unknown,
  requestedPropertyIds: readonly string[] | null,
): PortfolioUiBulkRows<PropertyRow> | null {
  if (!validBulkEnvelope(value)) return null;
  const requested = requestedPropertyIds === null ? null : new Set<string>();
  if (requested) {
    for (const rawId of requestedPropertyIds ?? []) {
      const id = canonicalUuid(rawId);
      if (!id || requested.has(id)) return null;
      requested.add(id);
    }
    if (value.total != null && value.total > requested.size) return null;
  }

  const seen = new Set<string>();
  for (const candidate of value.rows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    const id = canonicalUuid(row.id);
    if (!id || seen.has(id) || (requested && !requested.has(id))) return null;
    if (!validNullableString(row.name)
        || !validNullableString(row.brand)
        || !validNullableString(row.region)
        || !validNullableString(row.timezone)
        || !validNullableTimestamp(row.updated_at)) {
      return null;
    }
    if (row.total_rooms !== null && nonNegativeInt(row.total_rooms) == null) return null;
    seen.add(id);
  }
  return value as PortfolioUiBulkRows<PropertyRow>;
}

function validateSectionRead(
  value: unknown,
  requestedPropertyIds: readonly string[],
): PortfolioUiBulkRows<Record<string, unknown>> | null {
  if (!validBulkEnvelope(value)) return null;
  const allowed = new Set<string>();
  const drilldownIds = new Set<string>();
  for (const rawId of requestedPropertyIds) {
    const id = canonicalUuid(rawId);
    if (!id || allowed.has(id)) return null;
    allowed.add(id);
  }
  for (const candidate of value.rows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    const propertyId = canonicalUuid(row.property_id);
    if (!propertyId || !allowed.has(propertyId)) return null;
    const source = row[INTERNAL_ROW_SOURCE];
    if (source !== undefined
        && (typeof source !== 'string' || !SECTION_ROW_SOURCES.has(source as SectionRowSource))) {
      return null;
    }
    const drilldownEligible = row[INTERNAL_DRILLDOWN];
    if (drilldownEligible !== undefined && typeof drilldownEligible !== 'boolean') return null;
    if (drilldownEligible === true) {
      const id = canonicalUuid(row.id);
      if (!id || drilldownIds.has(id)) return null;
      drilldownIds.add(id);
    }
  }
  return value as PortfolioUiBulkRows<Record<string, unknown>>;
}

function latestTimestamp(rows: readonly Record<string, unknown>[], keys: readonly string[]): string | null {
  let latest: { iso: string; ms: number } | null = null;
  for (const row of rows) {
    for (const key of keys) {
      const value = stringValue(row[key]);
      if (!value) continue;
      const ms = new Date(value).getTime();
      if (!Number.isFinite(ms)) continue;
      if (!latest || ms > latest.ms) latest = { iso: value, ms };
    }
  }
  return latest?.iso ?? null;
}

function staleFreshness(
  observedAt: string | null,
  now: Date,
  staleAfterMs: number,
  asOfDate: string | null = null,
): PortfolioUiFreshness {
  if (!observedAt) {
    return { state: 'missing', observedAt: null, asOfDate, reason: 'no_source_record' };
  }
  const observedMs = new Date(observedAt).getTime();
  if (!Number.isFinite(observedMs)) {
    return { state: 'unavailable', observedAt: null, asOfDate, reason: 'invalid_source_timestamp' };
  }
  return now.getTime() - observedMs <= staleAfterMs
    ? { state: 'fresh', observedAt, asOfDate, reason: null }
    : { state: 'stale', observedAt, asOfDate, reason: 'source_record_is_stale' };
}

function unavailableFreshness(reason: string): PortfolioUiFreshness {
  return { state: 'unavailable', observedAt: null, asOfDate: null, reason };
}

function partialFreshness(reason: string, observedAt: string | null = null): PortfolioUiFreshness {
  return { state: 'partial', observedAt, asOfDate: null, reason };
}

function indicator(
  key: string,
  value: number | null,
  tone: PortfolioUiIndicator['tone'],
  unit: PortfolioUiIndicator['unit'] = 'count',
  lowerBound = false,
): PortfolioUiIndicator {
  return { key, value, unit, tone, lowerBound };
}

function financialOverrideMap(rows: readonly FinancialOverrideRow[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const row of rows) {
    if (typeof row.property_id !== 'string' || typeof row.role !== 'string') continue;
    if (typeof row.allowed !== 'boolean') continue;
    out.set(`${row.property_id}:${row.role}`, row.allowed);
  }
  return out;
}

function effectiveRoleAt(account: ManagerCaller, propertyId: string) {
  return resolveEffectiveRole({
    legacyRole: account.role,
    legacyPropertyAccess: account.propertyAccess,
    hats: account.hats ?? [],
  }, propertyId);
}

function hotelCapabilities(
  account: ManagerCaller,
  propertyId: string,
  sections: Record<PortfolioUiSection, boolean>,
  overrides: ReadonlyMap<string, boolean>,
  capabilityStoreAvailable: boolean,
  standing?: ManagementCompanyPropertyStanding,
  companyRole?: PortfolioUiCompanyRole,
): PortfolioUiHotelCapabilities {
  const effective = effectiveRoleAt(account, propertyId);
  const legacyPropertyHatCanManage = account.propertyStandings === undefined
    && (account.hats ?? []).some((hat) => (
      hat.scope === 'property'
      && hat.coveredPropertyIds.includes(propertyId)
      && (hat.role === 'owner' || hat.role === 'general_manager')
    ));
  // Portfolio reach is read-only. Reuse the route-layer standing predicate so
  // a company owner/VP card never advertises implicit GM write authority.
  // The explicit property-hat fallback is only for legacy/unit callers that do
  // not yet carry authoritative standings; production bootstrap always does.
  const canManageHotel = standing?.canManageHotel
    ?? (managerManagesHotel(account, propertyId) || legacyPropertyHatCanManage);
  const operationalRole = standing?.operationalRole ?? effective.role;
  if (!capabilityStoreAvailable || !sections.financials || !operationalRole) {
    return { canManageHotel, canViewFinancials: false };
  }
  const roleAllowsMoney = standing?.seesFinancials
    ?? (effective.seesFinancials || canViewFinancials(operationalRole));
  const restrictingRoles = new Set<string>([operationalRole]);
  if (companyRole === 'owner') restrictingRoles.add('owner');
  const explicitlyDenied = [...restrictingRoles]
    .some((role) => overrides.get(`${propertyId}:${role}`) === false);
  return {
    canManageHotel,
    // An `allowed:true` row never elevates a role; an explicit false restricts.
    canViewFinancials: roleAllowsMoney && !explicitlyDenied,
  };
}

type PolicyFinding = Parameters<typeof portfolioHotelFindingPolicyDecision>[0];

/** Minimal finding projection consumed by the shared source/money policy. */
function findingForBootstrapPolicy(row: FindingRow): PolicyFinding | null {
  const propertyId = stringValue(row.property_id);
  const detectorId = stringValue(row.detector_id);
  if (!propertyId || !detectorId || typeof row.summary !== 'string') return null;
  if (!row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) return null;
  if (row.judged_summary_en != null && typeof row.judged_summary_en !== 'string') return null;
  if (row.judged_summary_es != null && typeof row.judged_summary_es !== 'string') return null;

  // Either bound (or a basis without bounds) is enough to classify a malformed
  // historical range as money. The decision helper only inspects nullability;
  // it never renders or calculates with this defensive placeholder.
  const hasPriceMaterial = row.price_low_cents != null
    || row.price_high_cents != null
    || row.price_basis != null;
  const low = finiteNumber(row.price_low_cents);
  const high = finiteNumber(row.price_high_cents);
  return {
    propertyId,
    detectorId,
    summary: row.summary,
    judgedSummaryEn: typeof row.judged_summary_en === 'string' ? row.judged_summary_en : null,
    judgedSummaryEs: typeof row.judged_summary_es === 'string' ? row.judged_summary_es : null,
    evidence: row.evidence,
    price: hasPriceMaterial
      ? {
          lowCents: low ?? 0,
          highCents: high != null && high > (low ?? 0) ? high : (low ?? 0) + 1,
          currency: stringValue(row.price_currency) ?? 'USD',
          basis: typeof row.price_basis === 'string' ? row.price_basis : '',
        }
      : null,
  } as PolicyFinding;
}

function bootstrapFindingPolicy(args: {
  properties: readonly PropertyRow[];
  parsedByProperty: ReadonlyMap<string, ReturnType<typeof strictSections>>;
  capabilities: ReadonlyMap<string, PortfolioUiHotelCapabilities>;
  financialStoreAvailable: boolean;
}): PortfolioQueuePolicy {
  const propertyIds = args.properties.map((property) => property.id);
  const sections = Object.fromEntries(PORTFOLIO_DATA_SECTIONS.map((section) => [
    section,
    new Map(propertyIds.map((propertyId) => {
      const parsed = args.parsedByProperty.get(propertyId);
      if (!parsed || parsed.malformed) return [propertyId, 'unavailable' as const];
      const enabled = section === 'staxis'
        ? parsed.staxisEnabled
        : parsed.sections[section];
      return [propertyId, enabled ? 'enabled' as const : 'disabled' as const];
    })),
  ])) as unknown as PortfolioQueuePolicy['sections'];
  const financials = new Map(propertyIds.map((propertyId) => [
    propertyId,
    !args.financialStoreAvailable
      ? 'unavailable' as const
      : args.capabilities.get(propertyId)?.canViewFinancials === true
        ? 'allowed' as const
        : 'denied' as const,
  ]));
  return {
    propertyIds,
    sections,
    financials,
    // The shared decision helper does not inspect the fingerprint. Bootstrap
    // neither caches nor exposes this local read-policy snapshot, so it must
    // not duplicate the authoritative fingerprint implementation.
    fingerprint: 'bootstrap-read-policy',
  };
}

function filterBootstrapFindings(
  rows: readonly FindingRow[],
  policy: PortfolioQueuePolicy,
): { allowed: FindingRow[]; unavailableHotelIds: Set<string> } {
  const allowed: FindingRow[] = [];
  const unavailableHotelIds = new Set<string>();
  const scopedIds = new Set(policy.propertyIds);
  for (const row of rows) {
    const propertyId = stringValue(row.property_id);
    if (!propertyId) {
      // A bounded row with no attributable hotel means no hotel's zero is
      // trustworthy. This should be impossible under the schema, but the
      // presentation still fails closed if a source adapter regresses.
      for (const id of policy.propertyIds) unavailableHotelIds.add(id);
      continue;
    }
    if (!scopedIds.has(propertyId)) continue;
    const finding = findingForBootstrapPolicy(row);
    if (!finding) {
      unavailableHotelIds.add(propertyId);
      continue;
    }
    const decision = portfolioHotelFindingPolicyDecision(finding, policy);
    if (decision === 'allowed') allowed.push(row);
    else if (decision === 'unavailable') unavailableHotelIds.add(propertyId);
  }
  return { allowed, unavailableHotelIds };
}

function contextCapabilities(
  fact: ContextFact,
  financialByHotel: ReadonlyMap<string, boolean>,
  canAskStaxis: boolean,
): PortfolioUiCapabilities {
  const hasHotels = fact.hotelIds.length > 0;
  return {
    canReadPortfolio: hasHotels,
    canActOnFindings: hasHotels
      && fact.propertyStandings.some((standing) => standing.canManageHotel),
    canManageStaff: hasHotels
      && fact.presentationCapabilities.includes('manage_people'),
    canViewFinancials: hasHotels && fact.hotelIds.some((id) => financialByHotel.get(id) === true),
    canAskStaxis: hasHotels && canAskStaxis,
  };
}

function coverage(total: number, shown: number): PortfolioUiCoverage {
  return { total, shown, omitted: Math.max(0, total - shown) };
}

function resultError<T>(
  status: 400 | 403 | 503,
  code: Extract<PortfolioUiServerResult<T>, { ok: false }>['code'],
  message: string,
): PortfolioUiServerResult<T> {
  return { ok: false, status, code, message };
}

function readLimit(hotelCount: number, perHotel: number): number {
  return Math.max(1, Math.min(MAX_BULK_ROWS, Math.max(hotelCount, hotelCount * perHotel)));
}

function groupRows<T extends Record<string, unknown>>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const propertyId = stringValue(row.property_id);
    if (!propertyId) continue;
    const bucket = grouped.get(propertyId) ?? [];
    bucket.push(row);
    grouped.set(propertyId, bucket);
  }
  return grouped;
}

interface ChatState {
  state: 'available' | 'disabled' | 'unavailable';
  reason: string | null;
}

function chatStates(
  facts: readonly ContextFact[],
  rows: readonly CompanyChatRow[],
  available: boolean,
): Map<string, ChatState> {
  const settings = new Map(rows.map((row) => [row.organization_id, row.setting_value]));
  const out = new Map<string, ChatState>();
  for (const fact of facts) {
    if (!available) {
      out.set(fact.organizationId, { state: 'unavailable', reason: 'settings_unavailable' });
      continue;
    }
    if (fact.hotelIds.length === 0) {
      out.set(fact.organizationId, { state: 'disabled', reason: 'no_hotels' });
      continue;
    }
    const value = settings.get(fact.organizationId) ?? 'false';
    if (value === 'true') out.set(fact.organizationId, { state: 'available', reason: null });
    else if (value === 'false') {
      out.set(fact.organizationId, { state: 'disabled', reason: 'company_setting_off' });
    } else {
      out.set(fact.organizationId, { state: 'unavailable', reason: 'invalid_company_setting' });
    }
  }
  return out;
}

function newestRunByHotel(rows: readonly FindingRunRow[]): Map<string, FindingRunRow> {
  const out = new Map<string, FindingRunRow>();
  for (const row of rows) {
    const propertyId = stringValue(row.property_id);
    const runAt = stringValue(row.run_at);
    if (!propertyId || !runAt) continue;
    const current = out.get(propertyId);
    const currentAt = current ? stringValue(current.run_at) : null;
    if (!currentAt || new Date(runAt).getTime() > new Date(currentAt).getTime()) {
      out.set(propertyId, row);
    }
  }
  return out;
}

function bootstrapHotelState(args: {
  run: FindingRunRow | undefined;
  openRows: readonly FindingRow[] | null;
  runsAvailable: boolean;
  runsComplete: boolean;
  findingsAvailable: boolean;
  findingsComplete: boolean;
  sectionsMalformed: boolean;
  staxisSectionEnabled: boolean;
  now: Date;
}): Pick<PortfolioUiHotel, 'freshness' | 'partial' | 'status' | 'attention' | 'indicators'> {
  const {
    run, openRows, runsAvailable, runsComplete, findingsAvailable, findingsComplete,
    sectionsMalformed, staxisSectionEnabled, now,
  } = args;
  if (!staxisSectionEnabled) {
    return {
      freshness: {
        state: sectionsMalformed ? 'unavailable' : 'disabled',
        observedAt: null,
        asOfDate: null,
        reason: sectionsMalformed ? 'enabled_sections_unavailable' : 'staxis_section_disabled',
      },
      partial: sectionsMalformed,
      status: 'unknown',
      attention: null,
      indicators: [
        indicator('open_findings', null, 'neutral'),
        indicator('critical_findings', null, 'neutral'),
        indicator('detectors_checked', null, 'neutral'),
      ],
    };
  }
  const findingCount = openRows?.length ?? 0;
  const criticalCount = openRows?.filter((row) => row.severity === 'critical').length ?? 0;
  const findingPartial = findingsAvailable && !findingsComplete;
  const visibleFindingCount = findingsAvailable && (findingsComplete || findingCount > 0)
    ? findingCount
    : null;
  const visibleCriticalCount = findingsAvailable && (findingsComplete || criticalCount > 0)
    ? criticalCount
    : null;
  const indicators = [
    indicator(
      'open_findings',
      visibleFindingCount,
      findingCount > 0 ? 'warning' : 'neutral',
      'count',
      findingPartial && findingCount > 0,
    ),
    indicator(
      'critical_findings',
      visibleCriticalCount,
      criticalCount > 0 ? 'critical' : 'neutral',
      'count',
      findingPartial && criticalCount > 0,
    ),
    indicator(
      'detectors_checked',
      run ? nonNegativeInt(run.detectors_checked) : null,
      'neutral',
    ),
  ];

  const runFailures = run
    ? (nonNegativeInt(run.detectors_failed) ?? 0) + (nonNegativeInt(run.detectors_skipped) ?? 0)
    : 0;
  let freshness: PortfolioUiFreshness;
  if (!runsAvailable) freshness = unavailableFreshness('finding_runs_unavailable');
  else if (!run && !runsComplete) freshness = partialFreshness('finding_runs_page_incomplete');
  else if (!run) {
    freshness = { state: 'missing', observedAt: null, asOfDate: null, reason: 'no_recent_finding_run' };
  } else if (runFailures > 0) {
    freshness = partialFreshness('detectors_skipped_or_failed', stringValue(run.run_at));
  } else {
    freshness = staleFreshness(
      stringValue(run.run_at),
      now,
      FRESH_FINDING_RUN_MS,
      stringValue(run.run_date),
    );
  }

  const partial = sectionsMalformed
    || !runsAvailable
    || !findingsAvailable
    || !runsComplete
    || !findingsComplete
    || runFailures > 0
    || freshness.state !== 'fresh';

  let status: PortfolioUiHotelStatus = 'unknown';
  let attention: boolean | null = null;
  if (findingsAvailable && findingsComplete) {
    if (findingCount > 0) {
      attention = true;
      status = criticalCount > 0 ? 'critical' : 'attention';
    } else if (freshness.state === 'fresh') {
      // A recent finding_runs row is the null-result artifact proving that an
      // empty findings table means "checked and quiet", not "runner missing".
      attention = false;
      status = 'neutral';
    }
  }
  return { freshness, partial, status, attention, indicators };
}

export interface PortfolioUiBootstrapOptions {
  account: ManagerCaller;
  authoritativeCompanies?: readonly PortfolioUiAuthoritativeCompany[];
  requestedOrganizationId?: string | null;
  now?: Date;
  source?: PortfolioUiDataSource;
}

/** Build the bootstrap after the route has authenticated and loaded the account. */
export async function loadPortfolioUiBootstrap(
  options: PortfolioUiBootstrapOptions,
): Promise<PortfolioUiServerResult<PortfolioUiBootstrapV1>> {
  const source = options.source ?? portfolioUiDataSource;
  const now = options.now ?? new Date();
  const requestedOrganizationId = options.requestedOrganizationId?.toLowerCase() ?? null;
  const facts = authorizedPortfolioUiContexts(options.authoritativeCompanies ?? options.account);

  if (requestedOrganizationId
    && !facts.some((fact) => fact.organizationId === requestedOrganizationId)) {
    return resultError(403, 'company_not_authorized', 'That company is not available to this account');
  }

  // Selection is decided before any hotel read. A requested company narrows
  // the read itself, not merely the label on a merged union. One company may
  // auto-select only when the account has no separate hotel context to choose
  // instead. That includes both current property-scope hats and legacy
  // property_access hotels outside the sole company's coverage. Multiple
  // companies never produce a flat hotel list.
  const propertyScopeIds = [...new Set([
    ...(options.account.propertyStandings ?? [])
      .filter((standing) => standingHasLocalHotelContext(standing))
      .map((standing) => standing.propertyId),
    // Legacy/unit callers may not yet carry the authoritative standing DTO,
    // but a normalized property-scoped membership is still an explicit second
    // hat. Preserve the deliberate acting-context choice instead of silently
    // auto-selecting the one company job.
    ...(options.account.hats ?? [])
      .filter((hat) => hat.scope === 'property')
      .flatMap((hat) => hat.coveredPropertyIds),
  ])].sort();
  const soleCompanyHotelIds = new Set(facts.length === 1 ? facts[0].hotelIds : []);
  const independentLegacyIds = options.account.propertyAccess
    .filter((id) => id !== '*' && !soleCompanyHotelIds.has(id));
  const competingHotelIds = [...new Set([
    ...propertyScopeIds,
    ...independentLegacyIds,
  ])].sort();
  const selectedFact = requestedOrganizationId
    ? facts.find((fact) => fact.organizationId === requestedOrganizationId) ?? null
    : facts.length === 1 && competingHotelIds.length === 0 ? facts[0] : null;
  const authorizedIds = selectedFact
    ? selectedFact.hotelIds
    : facts.length > 1
      ? []
      : facts.length === 1
        ? competingHotelIds
        : authorizedPropertyIds(options.account);
  let propertyRead: PortfolioUiBulkRows<PropertyRow>;
  try {
    const rawPropertyRead = await source.readProperties(authorizedIds);
    const validated = validatePropertyRead(rawPropertyRead, authorizedIds);
    if (!validated) throw new Error('portfolio property adapter crossed or malformed its scope');
    propertyRead = validated;
  } catch {
    return resultError(503, 'data_unavailable', 'Portfolio properties are temporarily unavailable');
  }

  const propertyRows = propertyRead.rows;
  const visibleIds = propertyRows.map((row) => row.id);
  const parsedByProperty = new Map(
    propertyRows.map((row) => [row.id, strictSections(row.enabled_sections)]),
  );
  const staxisReadableIds = propertyRows
    .filter((row) => {
      const parsed = parsedByProperty.get(row.id);
      return !!parsed && !parsed.malformed && parsed.staxisEnabled;
    })
    .map((row) => row.id);
  const portfolioFindingIds = selectedFact
    ? staxisReadableIds.slice(0, MAX_PORTFOLIO_FINDING_HOTELS)
    : [];
  const portfolioFindingOverflowIds = selectedFact
    ? staxisReadableIds.slice(MAX_PORTFOLIO_FINDING_HOTELS)
    : [];
  const allAuthorizedIds = authorizedIds ?? visibleIds;
  const expectedTotal = authorizedIds === null
    ? (propertyRead.total ?? propertyRows.length)
    : authorizedIds.length;
  if (authorizedIds === null && !propertyRead.complete && propertyRead.total == null) {
    return resultError(503, 'data_unavailable', 'Portfolio property coverage is incomplete');
  }

  let organizationRows: OrganizationRow[] = [];
  let organizationReadAvailable = true;
  let overrideRows: FinancialOverrideRow[] = [];
  let overrideReadAvailable = true;
  let chatRows: CompanyChatRow[] = [];
  let chatReadAvailable = true;
  let runRead: PortfolioUiBulkRows<FindingRunRow> = bulkRows([], 0, 1);
  let runsAvailable = true;
  let findingRead: PortfolioUiBulkRows<FindingRow> = bulkRows([], 0, 1);
  let findingsAvailable = true;

  await Promise.all([
    source.readOrganizations(facts.map((fact) => fact.organizationId))
      .then((rows) => { organizationRows = rows; })
      .catch(() => { organizationReadAvailable = false; }),
    source.readFinancialOverrides(visibleIds)
      .then((rows) => { overrideRows = rows; })
      .catch(() => { overrideReadAvailable = false; }),
    source.readCompanyChatSettings(facts.map((fact) => fact.organizationId))
      .then((rows) => { chatRows = rows; })
      .catch(() => { chatReadAvailable = false; }),
    source.readFindingRuns(
      staxisReadableIds,
      new Date(now.getTime() - FINDING_RUN_LOOKBACK_DAYS * 86_400_000).toISOString(),
      readLimit(staxisReadableIds.length, 4),
    ).then((read) => { runRead = read; }).catch(() => { runsAvailable = false; }),
    (selectedFact
      ? source.readPortfolioFindings(
          selectedFact.organizationId,
          portfolioFindingIds,
          MAX_PORTFOLIO_FINDINGS_PER_HOTEL + 1,
        ).then((read) => {
          const unavailablePropertyIds = [...new Set([
            ...(read.unavailablePropertyIds ?? []),
            ...portfolioFindingOverflowIds,
          ])];
          findingRead = {
            ...read,
            complete: read.complete && unavailablePropertyIds.length === 0,
            saturatedPropertyIds: [...new Set(read.saturatedPropertyIds ?? [])],
            unavailablePropertyIds,
          };
        })
      : source.readFindings(staxisReadableIds, readLimit(staxisReadableIds.length, 50))
        .then((read) => { findingRead = read; }))
      .catch(() => { findingsAvailable = false; }),
  ]);

  const organizationNames = new Map(organizationRows.map((row) => [row.id, row.name]));
  const overrides = financialOverrideMap(overrideRows);
  const hotelCapabilityById = new Map<string, PortfolioUiHotelCapabilities>();
  for (const row of propertyRows) {
    const parsed = parsedByProperty.get(row.id) ?? strictSections({ bad: 'row' });
    const standing = selectedFact?.propertyStandings
      .find((candidate) => candidate.propertyId === row.id);
    hotelCapabilityById.set(row.id, hotelCapabilities(
      options.account,
      row.id,
      parsed.sections,
      overrides,
      overrideReadAvailable,
      standing,
      selectedFact?.companyRole,
    ));
  }
  const financialByHotel = new Map(
    [...hotelCapabilityById.entries()].map(([id, caps]) => [id, caps.canViewFinancials]),
  );
  const chats = chatStates(facts, chatRows, chatReadAvailable);

  const contexts: PortfolioUiCompanyContext[] = facts.map((fact) => {
    const chat = chats.get(fact.organizationId)
      ?? { state: 'unavailable' as const, reason: 'settings_unavailable' };
    return {
      organizationId: fact.organizationId,
      organizationName: fact.organizationName
        ?? organizationNames.get(fact.organizationId)
        ?? null,
      companyRole: fact.companyRole,
      hotelIds: fact.hotelIds,
      hotelCount: fact.hotelIds.length,
      queueAvailable: fact.queueAvailable,
      capabilities: contextCapabilities(
        fact,
        financialByHotel,
        chat.state === 'available',
      ),
      chat,
    };
  });

  const selectedCompany = selectedFact
    ? contexts.find((context) => context.organizationId === selectedFact.organizationId) ?? null
    : null;
  const selection = selectedCompany
    ? {
        requestedOrganizationId,
        selectedOrganizationId: selectedCompany.organizationId,
        state: 'selected' as const,
      }
    : contexts.length > 0
      ? {
          requestedOrganizationId,
          selectedOrganizationId: null,
          state: 'needs_selection' as const,
        }
      : {
          requestedOrganizationId,
          selectedOrganizationId: null,
          state: 'hotel_only' as const,
        };

  const contextIdsByHotel = new Map<string, string[]>();
  for (const context of contexts) {
    for (const propertyId of context.hotelIds) {
      const values = contextIdsByHotel.get(propertyId) ?? [];
      values.push(context.organizationId);
      contextIdsByHotel.set(propertyId, values);
    }
  }

  const newestRuns = newestRunByHotel(runRead.rows);
  let visibleFindingRows = findingRead.rows;
  let findingPolicyUnavailableHotelIds = new Set<string>();
  if (selectedFact && findingsAvailable) {
    const filtered = filterBootstrapFindings(
      findingRead.rows,
      bootstrapFindingPolicy({
        properties: propertyRows,
        parsedByProperty,
        capabilities: hotelCapabilityById,
        financialStoreAvailable: overrideReadAvailable,
      }),
    );
    visibleFindingRows = filtered.allowed;
    findingPolicyUnavailableHotelIds = filtered.unavailableHotelIds;
  }
  const findingWindowMetadataAvailable = findingRead.saturatedPropertyIds !== undefined
    || findingRead.unavailablePropertyIds !== undefined;
  const saturatedFindingHotelIds = new Set(findingRead.saturatedPropertyIds ?? []);
  const unavailableFindingHotelIds = new Set(findingRead.unavailablePropertyIds ?? []);
  const findingsByHotel = groupRows(visibleFindingRows);
  const hotels: PortfolioUiHotel[] = propertyRows.map((row) => {
    const parsed = parsedByProperty.get(row.id) ?? strictSections({ bad: 'row' });
    const hotelFindingsAvailable = findingsAvailable && !unavailableFindingHotelIds.has(row.id);
    const hotelFindingWindowComplete = findingWindowMetadataAvailable
      ? !saturatedFindingHotelIds.has(row.id) && !unavailableFindingHotelIds.has(row.id)
      : findingRead.complete;
    const state = bootstrapHotelState({
      run: newestRuns.get(row.id),
      openRows: hotelFindingsAvailable ? findingsByHotel.get(row.id) ?? [] : null,
      runsAvailable,
      runsComplete: runRead.complete,
      findingsAvailable: hotelFindingsAvailable,
      findingsComplete: hotelFindingWindowComplete
        && !findingPolicyUnavailableHotelIds.has(row.id),
      sectionsMalformed: parsed.malformed,
      staxisSectionEnabled: parsed.staxisEnabled,
      now,
    });
    return {
      propertyId: row.id,
      name: row.name ?? 'This hotel',
      city: null,
      region: row.region ?? null,
      brand: row.brand ?? null,
      totalRooms: roomCount(row.total_rooms),
      timezone: row.timezone ?? null,
      contextIds: [...new Set(contextIdsByHotel.get(row.id) ?? [])].sort(),
      roleAtHotel: selectedFact?.propertyStandings
        .find((standing) => standing.propertyId === row.id)?.operationalRole
        ?? effectiveRoleAt(options.account, row.id).role,
      capabilities: hotelCapabilityById.get(row.id)
        ?? { canManageHotel: false, canViewFinancials: false },
      sections: parsed.sections,
      ...state,
    };
  });

  const shownIds = new Set(propertyRows.map((row) => row.id));
  const missingPropertyIds = authorizedIds === null
    ? []
    : allAuthorizedIds.filter((id) => !shownIds.has(id));
  const malformedSections = [...parsedByProperty.values()].some((value) => value.malformed);
  const partial = !propertyRead.complete
    || missingPropertyIds.length > 0
    || !organizationReadAvailable
    || !overrideReadAvailable
    || !chatReadAvailable
    || !runsAvailable
    || !findingsAvailable
    || !runRead.complete
    || !findingRead.complete
    || malformedSections
    || hotels.some((hotel) => hotel.partial);
  const legacyHotelCount = facts.length > 0
    ? competingHotelIds.length
    : new Set(options.account.propertyAccess.filter((id) => id !== '*')).size;

  return {
    ok: true,
    data: {
      version: PORTFOLIO_UI_VERSION,
      generatedAt: now.toISOString(),
      contexts,
      entry: {
        mode: selectedCompany ? 'portfolio' : contexts.length > 0 ? 'company_picker' : 'hotel',
        companyCount: contexts.length,
        legacyHotelCount,
        requiresCompanySelection: contexts.length > 0 && !selectedCompany,
      },
      selection,
      selectedCompany,
      hotels,
      coverage: coverage(expectedTotal, propertyRows.length),
      partial,
      missingPropertyIds,
    },
  };
}

interface SectionAggregation {
  summary: PortfolioUiSectionSummary;
  hotels: PortfolioUiSectionHotel[];
}

function drilldown(rows: readonly Record<string, unknown>[]): {
  ids: string[];
  omitted: number;
  malformed: boolean;
} {
  const all: string[] = [];
  const seen = new Set<string>();
  let malformed = false;
  for (const row of rows.filter((candidate) => candidate[INTERNAL_DRILLDOWN] !== false)) {
    const id = canonicalUuid(row.id);
    if (!id || seen.has(id)) {
      malformed = true;
      continue;
    }
    seen.add(id);
    all.push(id);
  }
  return {
    ids: all.slice(0, MAX_DRILLDOWN_IDS_PER_HOTEL),
    omitted: Math.max(0, all.length - MAX_DRILLDOWN_IDS_PER_HOTEL),
    malformed,
  };
}

function sectionHotel(
  property: PropertyRow,
  rows: readonly Record<string, unknown>[],
  freshness: PortfolioUiFreshness,
  partial: boolean,
  indicators: PortfolioUiIndicator[],
): PortfolioUiSectionHotel {
  const ids = drilldown(rows);
  return {
    propertyId: property.id,
    name: property.name ?? 'This hotel',
    city: null,
    region: property.region ?? null,
    brand: property.brand ?? null,
    freshness,
    partial: partial
      || ids.omitted > 0
      || ids.malformed
      || (freshness.state !== 'fresh' && freshness.state !== 'disabled'),
    indicators,
    drilldownIds: ids.ids,
    drilldownOmitted: ids.omitted,
  };
}

function sourceRows(
  rows: readonly Record<string, unknown>[],
  source: SectionRowSource,
  untagged: (row: Record<string, unknown>) => boolean = () => false,
): Record<string, unknown>[] {
  return rows.filter((row) => (
    row[INTERNAL_ROW_SOURCE] === source
    || (row[INTERNAL_ROW_SOURCE] == null && untagged(row))
  ));
}

function businessDate(row: Record<string, unknown>): string | null {
  return stringValue(row.business_date) ?? stringValue(row.date);
}

function roundedPercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function roundedDelta(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null) return null;
  return Math.round((current - prior) * 100) / 100;
}

function roundedChangePercent(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 10_000) / 100;
}

interface OccupancyNumbers {
  occupied: number;
  available: number;
  percent: number | null;
}

function occupancyNumbers(rows: readonly Record<string, unknown>[]): OccupancyNumbers | null {
  if (rows.length === 0) return null;
  let occupied = 0;
  let available = 0;
  for (const row of rows) {
    const rowOccupied = nonNegativeInt(row.occupied_rooms);
    const rowAvailable = nonNegativeInt(row.available_rooms);
    if (rowOccupied == null || rowAvailable == null) return null;
    occupied += rowOccupied;
    available += rowAvailable;
  }
  return { occupied, available, percent: roundedPercent(occupied, available) };
}

function combinedOccupancy(values: readonly (OccupancyNumbers | null)[]): OccupancyNumbers | null {
  const known = values.filter((value): value is OccupancyNumbers => value != null);
  if (known.length === 0) return null;
  const occupied = known.reduce((sum, value) => sum + value.occupied, 0);
  const available = known.reduce((sum, value) => sum + value.available, 0);
  return { occupied, available, percent: roundedPercent(occupied, available) };
}

function completeSum(
  rows: readonly Record<string, unknown>[],
  key: string,
  parser: (value: unknown) => number | null = finiteNumber,
): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    const value = parser(row[key]);
    if (value == null) return null;
    total += value;
  }
  return Math.round(total);
}

function allOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value == null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function countOrNull<T>(values: readonly T[]): number | null {
  return values.length > 0 ? values.length : null;
}

function previousMonthKey(localDate: string): string {
  return monthStartOffset(localDate, -1).slice(0, 7);
}

function validBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function exactDateWindowRows(
  rows: readonly Record<string, unknown>[],
  start: string,
  end: string,
): Record<string, unknown>[] | null {
  if (!validBusinessDate(start) || !validBusinessDate(end) || end < start) return null;
  const expected: string[] = [];
  for (let cursor = start; cursor <= end && expected.length <= 62; cursor = addDaysInTz(cursor, 1)) {
    expected.push(cursor);
  }
  if (expected.length === 0 || expected.length > 62) return null;

  const byDate = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const date = businessDate(row);
    if (!date || !validBusinessDate(date)) return null;
    if (date < start || date > end) continue;
    if (byDate.has(date)) return null;
    byDate.set(date, row);
  }
  if (byDate.size !== expected.length) return null;
  return expected.map((date) => byDate.get(date) as Record<string, unknown>);
}

interface MonthWindows {
  currentStart: string;
  currentEnd: string;
  currentComparableEnd: string;
  priorStart: string;
  priorEnd: string;
}

function monthWindows(localDate: string): MonthWindows {
  const currentStart = `${localDate.slice(0, 7)}-01`;
  const priorStart = monthStartOffset(localDate, -1);
  const [priorYear, priorMonth] = priorStart.split('-').map(Number);
  const priorLastDay = new Date(Date.UTC(priorYear, priorMonth, 0)).getUTCDate();
  const comparisonDay = Math.min(Number(localDate.slice(8, 10)), priorLastDay);
  const day = String(comparisonDay).padStart(2, '0');
  return {
    currentStart,
    currentEnd: localDate,
    currentComparableEnd: `${localDate.slice(0, 7)}-${day}`,
    priorStart,
    priorEnd: `${priorStart.slice(0, 7)}-${day}`,
  };
}

interface FinancialNumbers {
  revenueCents: number | null;
  roomsRevenueCents: number | null;
  occupiedRooms: number | null;
  availableRooms: number | null;
  grossOperatingProfitCents: number | null;
  occupancyPercent: number | null;
  adrCents: number | null;
  revparCents: number | null;
}

function financialNumbers(rows: readonly Record<string, unknown>[]): FinancialNumbers {
  const revenueCents = completeSum(rows, 'total_revenue_cents');
  const roomsRevenueCents = completeSum(rows, 'rooms_revenue_cents');
  const occupiedRooms = completeSum(rows, 'occupied_rooms', nonNegativeInt);
  const availableRooms = completeSum(rows, 'available_rooms', nonNegativeInt);
  const grossOperatingProfitCents = completeSum(rows, 'gross_operating_profit_cents');
  return {
    revenueCents,
    roomsRevenueCents,
    occupiedRooms,
    availableRooms,
    grossOperatingProfitCents,
    occupancyPercent: occupiedRooms != null && availableRooms != null
      ? roundedPercent(occupiedRooms, availableRooms)
      : null,
    adrCents: roomsRevenueCents != null && occupiedRooms != null && occupiedRooms > 0
      ? Math.round(roomsRevenueCents / occupiedRooms)
      : null,
    revparCents: roomsRevenueCents != null && availableRooms != null && availableRooms > 0
      ? Math.round(roomsRevenueCents / availableRooms)
      : null,
  };
}

function nullSummary(section: PortfolioUiSection): PortfolioUiSectionSummary {
  switch (section) {
    case 'dashboard':
      return {
        kind: section,
        reportingHotels: null,
        occupiedRooms: null,
        availableRooms: null,
        occupancyPercent: null,
        occupancyComparisonHotels: null,
        recentOccupancyPercent: null,
        priorOccupancyPercent: null,
        occupancyChangePoints: null,
        financialReportingHotels: null,
        financialComparisonHotels: null,
        monthToDateRevenueCents: null,
        priorPeriodRevenueCents: null,
        revenueChangePercent: null,
      };
    case 'housekeeping':
      return {
        kind: section,
        reportingHotels: null,
        openTasks: null,
        urgentTasks: null,
        completedTasks: null,
        completionPercent: null,
        staffingReportingHotels: null,
        staffedShifts: null,
        openStaffingSlots: null,
        staffingCoveragePercent: null,
      };
    case 'communications':
      return {
        kind: section,
        reportingHotels: null,
        openItems: null,
        highSeverityItems: null,
        announcements: null,
        companyAnnouncements: null,
        acknowledgementResponses: null,
        pendingAcknowledgements: null,
        acknowledgementPercent: null,
      };
    case 'maintenance':
      return {
        kind: section,
        reportingHotels: null,
        openWorkOrders: null,
        urgentWorkOrders: null,
        highPriorityWorkOrders: null,
        agingWorkOrders: null,
        recurringEquipmentIssues: null,
        degradedEquipment: null,
      };
    case 'inventory':
      return {
        kind: section,
        reportingHotels: null,
        trackedItems: null,
        lowStockItems: null,
        uncountedItems: null,
        comparableSpendHotels: null,
        lastClosedSpendCents: null,
        priorClosedSpendCents: null,
        spendVariancePercent: null,
      };
    case 'staff':
      return {
        kind: section,
        reportingHotels: null,
        assignedShifts: null,
        openShifts: null,
        scheduledPeople: null,
        activeStaff: null,
        keyLeaders: null,
        departmentsWithoutCoverage: null,
        staffingCoveragePercent: null,
      };
    case 'financials':
      return {
        kind: section,
        reportingHotels: null,
        monthToDateRevenueCents: null,
        occupiedRooms: null,
        comparisonHotels: null,
        priorPeriodRevenueCents: null,
        revenueChangePercent: null,
        occupancyPercent: null,
        adrCents: null,
        revparCents: null,
        grossOperatingProfitCents: null,
      };
  }
}

function aggregateSection(
  section: PortfolioUiSection,
  properties: readonly PropertyRow[],
  rows: readonly Record<string, unknown>[],
  complete: boolean,
  available: boolean,
  now: Date,
  financialPropertyIds: ReadonlySet<string>,
): SectionAggregation {
  if (!available) {
    return {
      summary: nullSummary(section),
      hotels: properties.map((property) => sectionHotel(
        property,
        [],
        unavailableFreshness(`${section}_source_unavailable`),
        true,
        [],
      )),
    };
  }

  const grouped = groupRows(rows);
  const hotels: PortfolioUiSectionHotel[] = [];
  const dashboardFacts: Array<{
    today: OccupancyNumbers | null;
    recent: OccupancyNumbers | null;
    prior: OccupancyNumbers | null;
    currentRevenue: number | null;
    comparisonCurrentRevenue: number | null;
    priorRevenue: number | null;
  }> = [];
  const housekeepingFacts: Array<{
    taskReporting: boolean;
    open: number;
    urgent: number;
    completed: number;
    staffingReporting: boolean;
    staffed: number;
    openSlots: number;
  }> = [];
  const communicationsFacts: Array<{
    reporting: boolean;
    escalationReporting: boolean;
    announcementReporting: boolean;
    open: number | null;
    high: number | null;
    announcements: number | null;
    campaignIds: string[];
    acknowledged: number | null;
    pending: number | null;
    expected: number | null;
  }> = [];
  const maintenanceFacts: Array<{
    reporting: boolean;
    workReporting: boolean;
    historyReporting: boolean;
    equipmentReporting: boolean;
    open: number | null;
    urgent: number | null;
    high: number | null;
    aging: number | null;
    recurring: number | null;
    degraded: number | null;
  }> = [];
  const inventoryFacts: Array<{
    reporting: boolean;
    tracked: number | null;
    low: number | null;
    uncounted: number | null;
    latestSpend: number | null;
    priorSpend: number | null;
    latestMonth: string | null;
    priorMonth: string | null;
  }> = [];
  const staffFacts: Array<{
    reporting: boolean;
    assigned: number | null;
    open: number | null;
    people: number | null;
    active: number | null;
    keyLeaders: number | null;
    uncoveredDepartments: number | null;
  }> = [];
  const financialFacts: Array<{
    current: FinancialNumbers;
    comparisonCurrent: FinancialNumbers;
    prior: FinancialNumbers;
  }> = [];

  for (const property of properties) {
    const localDate = propertyLocalToday(now, property.timezone);
    const scoped = grouped.get(property.id) ?? [];
    const readPartial = !complete;
    let evidenceRows: Record<string, unknown>[] = [];
    let drilldownRows: Record<string, unknown>[] = [];
    let indicators: PortfolioUiIndicator[] = [];
    let shapePartial = false;
    let shapePartialReason = 'invalid_source_values';

    if (section === 'dashboard') {
      const occupancy = sourceRows(
        scoped,
        'dashboard_occupancy',
        (row) => row.occupied_rooms != null || row.available_rooms != null || row.occupancy_pct != null,
      );
      const financial = sourceRows(
        scoped,
        'dashboard_financial',
        (row) => row.total_revenue_cents != null,
      );
      const recentStart = addDaysInTz(localDate, -6);
      const priorStart = addDaysInTz(localDate, -13);
      const priorEnd = addDaysInTz(localDate, -7);
      const todayRows = exactDateWindowRows(occupancy, localDate, localDate);
      const recentRows = exactDateWindowRows(occupancy, recentStart, localDate);
      const priorRows = exactDateWindowRows(occupancy, priorStart, priorEnd);
      const today = todayRows ? occupancyNumbers(todayRows) : null;
      const recent = recentRows ? occupancyNumbers(recentRows) : null;
      const prior = priorRows ? occupancyNumbers(priorRows) : null;
      const mayReadMoney = financialPropertyIds.has(property.id);
      const windows = monthWindows(localDate);
      const currentFinancialRows = mayReadMoney
        ? exactDateWindowRows(financial, windows.currentStart, windows.currentEnd)
        : null;
      const comparisonCurrentRows = mayReadMoney
        ? exactDateWindowRows(financial, windows.currentStart, windows.currentComparableEnd)
        : null;
      const priorFinancialRows = mayReadMoney
        ? exactDateWindowRows(financial, windows.priorStart, windows.priorEnd)
        : null;
      const currentFinancial = financialNumbers(currentFinancialRows ?? []);
      const comparisonCurrentFinancial = financialNumbers(comparisonCurrentRows ?? []);
      const priorFinancial = financialNumbers(priorFinancialRows ?? []);
      if (!todayRows || !recentRows || !priorRows
          || (mayReadMoney
            && (!currentFinancialRows || !comparisonCurrentRows || !priorFinancialRows))) {
        shapePartial = true;
        shapePartialReason = 'insufficient_date_coverage';
      } else if (!today || !recent || !prior
          || (mayReadMoney && (
            currentFinancial.revenueCents == null
            || comparisonCurrentFinancial.revenueCents == null
            || priorFinancial.revenueCents == null
          ))) {
        shapePartial = true;
      }
      dashboardFacts.push({
        today,
        recent,
        prior,
        currentRevenue: mayReadMoney ? currentFinancial.revenueCents : null,
        comparisonCurrentRevenue: mayReadMoney
          ? comparisonCurrentFinancial.revenueCents
          : null,
        priorRevenue: mayReadMoney ? priorFinancial.revenueCents : null,
      });
      const trend = roundedDelta(recent?.percent ?? null, prior?.percent ?? null);
      indicators = [
        indicator('occupied_rooms', readPartial ? null : today?.occupied ?? null, 'neutral'),
        indicator('occupancy_percent', readPartial ? null : today?.percent ?? null, 'neutral', 'percent'),
        indicator('recent_occupancy_percent', readPartial ? null : recent?.percent ?? null, 'neutral', 'percent'),
        indicator('occupancy_change_points', readPartial ? null : trend, 'neutral', 'percentage_points'),
        ...(mayReadMoney ? [indicator(
          'month_to_date_revenue',
          readPartial ? null : currentFinancial.revenueCents,
          'neutral',
          'currency_cents',
        )] : []),
      ];
      evidenceRows = [...occupancy, ...(mayReadMoney ? financial : [])];
    } else if (section === 'housekeeping') {
      const tasks = sourceRows(scoped, 'housekeeping_task', (row) => row.business_date != null)
        .filter((row) => row.business_date === localDate);
      const shifts = sourceRows(scoped, 'housekeeping_shift')
        .filter((row) => row.shift_date === localDate);
      const completedStates = new Set([
        'completed', 'inspected_pass', 'correction_complete', 'check_complete',
      ]);
      const excludedStates = new Set(['cancelled', 'skipped', 'superseded']);
      const eligible = tasks.filter((row) => !excludedStates.has(String(row.status ?? '')));
      const completed = eligible.filter((row) => completedStates.has(String(row.status ?? ''))).length;
      const open = eligible.length - completed;
      const urgent = eligible.filter((row) => (
        !completedStates.has(String(row.status ?? ''))
        && (row.priority === 'urgent' || row.priority === 'high')
      )).length;
      const staffed = shifts.filter((row) => row.kind === 'shift').length;
      const openSlots = shifts.filter((row) => row.kind === 'open').length;
      const taskReporting = tasks.length > 0;
      const staffingReporting = shifts.length > 0;
      const completionPercent = taskReporting ? roundedPercent(completed, eligible.length) : null;
      const staffingCoverage = staffingReporting
        ? roundedPercent(staffed, staffed + openSlots)
        : null;
      housekeepingFacts.push({
        taskReporting,
        open,
        urgent,
        completed,
        staffingReporting,
        staffed,
        openSlots,
      });
      indicators = [
        indicator(
          'open_tasks',
          taskReporting ? open : null,
          open > 0 ? 'warning' : 'neutral',
          'count',
          readPartial,
        ),
        indicator(
          'urgent_tasks',
          taskReporting ? urgent : null,
          urgent > 0 ? 'critical' : 'neutral',
          'count',
          readPartial,
        ),
        indicator('completion_percent', readPartial ? null : completionPercent, 'neutral', 'percent'),
        indicator(
          'open_staffing_slots',
          staffingReporting ? openSlots : null,
          openSlots > 0 ? 'warning' : 'neutral',
          'count',
          readPartial,
        ),
        indicator('staffing_coverage_percent', readPartial ? null : staffingCoverage, 'neutral', 'percent'),
      ];
      evidenceRows = [...tasks, ...shifts];
      drilldownRows = tasks;
    } else if (section === 'communications') {
      const escalations = sourceRows(
        scoped,
        'communications_escalation',
        (row) => row.status != null || row.severity != null,
      );
      const announcements = sourceRows(scoped, 'communications_announcement');
      const acknowledgementRows = sourceRows(scoped, 'communications_acknowledgement');
      const rosterRows = sourceRows(scoped, 'communications_roster');
      const activeCreatedAt = new Map<string, number>();
      let rosterValid = rosterRows.length > 0;
      for (const row of rosterRows) {
        const id = stringValue(row.id);
        const createdAt = stringValue(row.created_at);
        const createdAtMs = createdAt ? new Date(createdAt).getTime() : Number.NaN;
        if (!id || !Number.isFinite(createdAtMs) || activeCreatedAt.has(id)) {
          rosterValid = false;
          continue;
        }
        activeCreatedAt.set(id, createdAtMs);
      }
      const acknowledgementByMessage = new Map<string, Set<string>>();
      for (const row of acknowledgementRows) {
        const messageId = stringValue(row.message_id);
        const staffId = stringValue(row.staff_id);
        if (!messageId || !staffId || !activeCreatedAt.has(staffId)) continue;
        const values = acknowledgementByMessage.get(messageId) ?? new Set<string>();
        values.add(staffId);
        acknowledgementByMessage.set(messageId, values);
      }
      let expected = 0;
      let acknowledged = 0;
      const announcementAckShapeValid = announcements.every(
        (row) => typeof row.requires_ack === 'boolean',
      );
      const requiredAnnouncements = announcements.filter((row) => row.requires_ack === true);
      let acknowledgementsComparable = announcementAckShapeValid
        && (requiredAnnouncements.length === 0 || rosterValid);
      for (const announcement of requiredAnnouncements) {
        const messageId = stringValue(announcement.id);
        const announcedAt = stringValue(announcement.created_at);
        const announcedAtMs = announcedAt ? new Date(announcedAt).getTime() : Number.NaN;
        if (!messageId || !Number.isFinite(announcedAtMs) || !rosterValid) {
          acknowledgementsComparable = false;
          continue;
        }
        const sender = stringValue(announcement.sender_staff_id);
        const expectedIds = [...activeCreatedAt.entries()]
          .filter(([id, hiredAtMs]) => id !== sender && hiredAtMs <= announcedAtMs)
          .map(([id]) => id);
        expected += expectedIds.length;
        const acked = acknowledgementByMessage.get(messageId) ?? new Set<string>();
        acknowledged += expectedIds.filter((id) => acked.has(id)).length;
      }
      if (!acknowledgementsComparable) shapePartial = true;
      const high = escalations.filter((row) => row.severity === 'high').length;
      const expectedValue = announcements.length > 0 && acknowledgementsComparable ? expected : null;
      const acknowledgedValue = expectedValue == null ? null : acknowledged;
      const pending = expectedValue == null ? null : Math.max(0, expectedValue - acknowledged);
      const campaignIds = announcements
        .map((row) => stringValue(row.ack_campaign_id))
        .filter((id): id is string => id != null);
      const reporting = escalations.length > 0 || announcements.length > 0;
      communicationsFacts.push({
        reporting,
        escalationReporting: escalations.length > 0,
        announcementReporting: announcements.length > 0,
        open: escalations.length > 0 ? escalations.length : null,
        high: escalations.length > 0 ? high : null,
        announcements: announcements.length > 0 ? announcements.length : null,
        campaignIds,
        acknowledged: acknowledgedValue,
        pending,
        expected: expectedValue,
      });
      indicators = [
        indicator(
          'open_items',
          escalations.length > 0 ? escalations.length : null,
          escalations.length > 0 ? 'warning' : 'neutral',
          'count',
          readPartial,
        ),
        indicator(
          'high_severity_items',
          escalations.length > 0 ? high : null,
          high > 0 ? 'critical' : 'neutral',
          'count',
          readPartial,
        ),
        indicator(
          'announcements_30d',
          announcements.length > 0 ? announcements.length : null,
          'neutral',
          'count',
          readPartial,
        ),
        indicator('acknowledgement_responses', acknowledgedValue, 'neutral', 'count', readPartial),
        indicator(
          'pending_acknowledgements',
          readPartial ? null : pending,
          (pending ?? 0) > 0 ? 'warning' : 'neutral',
        ),
        indicator(
          'acknowledgement_percent',
          readPartial || acknowledgedValue == null || expectedValue == null
            ? null
            : roundedPercent(acknowledgedValue, expectedValue),
          'neutral',
          'percent',
        ),
      ];
      evidenceRows = [
        ...escalations,
        ...announcements,
        ...(announcements.length > 0 ? acknowledgementRows : []),
      ];
      drilldownRows = escalations;
    } else if (section === 'maintenance') {
      const openRows = sourceRows(
        scoped,
        'maintenance_open',
        (row) => row.status !== 'resolved' && row.severity != null,
      );
      const historyRows = sourceRows(scoped, 'maintenance_history');
      const equipmentRows = sourceRows(scoped, 'maintenance_equipment');
      const severities = openRows.map((row) => normalizeWorkOrderSeverity(row.severity));
      const severityValuesValid = severities.every((severity) => severity !== 'unspecified');
      const urgent = severityValuesValid
        ? severities.filter((severity) => severity === 'urgent').length
        : null;
      const high = severityValuesValid
        ? severities.filter((severity) => severity === 'high').length
        : null;
      if (!severityValuesValid) shapePartial = true;
      const agingThreshold = now.getTime() - 7 * 86_400_000;
      const createdTimes = openRows.map((row) => {
        const createdAt = stringValue(row.created_at);
        const time = createdAt ? new Date(createdAt).getTime() : Number.NaN;
        return Number.isFinite(time) ? time : null;
      });
      const aging = createdTimes.some((value) => value == null)
        ? null
        : createdTimes.filter((value) => (value ?? now.getTime()) <= agingThreshold).length;
      if (aging == null && openRows.length > 0) shapePartial = true;
      const historyByEquipment = new Map<string, Set<string>>();
      let historyValuesValid = true;
      for (const row of historyRows) {
        const equipmentId = stringValue(row.equipment_id);
        const rowId = stringValue(row.id);
        if (!equipmentId || !rowId) {
          historyValuesValid = false;
          continue;
        }
        const values = historyByEquipment.get(equipmentId) ?? new Set<string>();
        values.add(rowId);
        historyByEquipment.set(equipmentId, values);
      }
      if (!historyValuesValid) shapePartial = true;
      const workReporting = openRows.length > 0;
      const historyReporting = historyRows.length > 0;
      const equipmentReporting = equipmentRows.length > 0;
      const recurring = historyReporting && historyValuesValid
        ? [...historyByEquipment.values()].filter((ids) => ids.size >= 2).length
        : null;
      const degraded = equipmentReporting ? equipmentRows.length : null;
      maintenanceFacts.push({
        reporting: workReporting || historyReporting || equipmentReporting,
        workReporting,
        historyReporting,
        equipmentReporting,
        open: workReporting ? openRows.length : null,
        urgent: workReporting && severityValuesValid ? urgent : null,
        high: workReporting && severityValuesValid ? high : null,
        aging: workReporting ? aging : null,
        recurring,
        degraded,
      });
      indicators = [
        indicator(
          'open_work_orders',
          workReporting ? openRows.length : null,
          openRows.length > 0 ? 'warning' : 'neutral',
          'count',
          readPartial,
        ),
        indicator(
          'urgent_work_orders',
          workReporting && severityValuesValid ? urgent : null,
          (urgent ?? 0) > 0 ? 'critical' : 'neutral',
          'count',
          readPartial,
        ),
        indicator(
          'high_priority_work_orders',
          workReporting && severityValuesValid ? high : null,
          (high ?? 0) > 0 ? 'warning' : 'neutral',
          'count',
          readPartial,
        ),
        indicator(
          'aging_work_orders',
          workReporting ? aging : null,
          (aging ?? 0) > 0 ? 'warning' : 'neutral',
          'count',
          readPartial,
        ),
        indicator('recurring_equipment_issues', recurring, (recurring ?? 0) > 0 ? 'warning' : 'neutral', 'count', readPartial),
        indicator('degraded_equipment', degraded, (degraded ?? 0) > 0 ? 'warning' : 'neutral', 'count', readPartial),
      ];
      evidenceRows = [...openRows, ...historyRows, ...equipmentRows];
      drilldownRows = openRows;
    } else if (section === 'inventory') {
      const items = sourceRows(
        scoped,
        'inventory_item',
        (row) => row.current_stock != null || row.par_level != null,
      );
      const closeRows = sourceRows(scoped, 'inventory_close')
        .sort((left, right) => String(right.month_start ?? '').localeCompare(String(left.month_start ?? '')));
      const itemValuesValid = items.every((row) => (
        finiteNumber(row.current_stock) != null && finiteNumber(row.par_level) != null
      ));
      const low = items.length > 0 && itemValuesValid ? items.filter((row) => {
        const current = finiteNumber(row.current_stock);
        const par = finiteNumber(row.par_level);
        return current != null && par != null && stockStatus(current, par) !== 'good';
      }).length : null;
      if (!itemValuesValid) shapePartial = true;
      const uncounted = items.length > 0
        ? items.filter((row) => !stringValue(row.last_counted_at)).length
        : null;
      const validCloses = closeRows.filter((row) => (
        row.status === 'closed'
        && row.is_partial === false
        && finiteNumber(row.confirmed_purchase_cents) != null
        && stringValue(row.month_start) != null
      ));
      const latest = validCloses[0];
      const prior = validCloses[1];
      const latestMonth = latest ? stringValue(latest.month_start)?.slice(0, 7) ?? null : null;
      const priorMonth = prior ? stringValue(prior.month_start)?.slice(0, 7) ?? null : null;
      const consecutive = latestMonth != null
        && priorMonth != null
        && previousMonthKey(`${latestMonth}-01`) === priorMonth;
      const latestSpend = consecutive ? finiteNumber(latest.confirmed_purchase_cents) : null;
      const priorSpend = consecutive ? finiteNumber(prior.confirmed_purchase_cents) : null;
      const mayReadMoney = financialPropertyIds.has(property.id);
      inventoryFacts.push({
        reporting: items.length > 0 || (mayReadMoney && closeRows.length > 0),
        tracked: items.length > 0 ? items.length : null,
        low,
        uncounted,
        latestSpend: mayReadMoney ? latestSpend : null,
        priorSpend: mayReadMoney ? priorSpend : null,
        latestMonth: mayReadMoney && consecutive ? latestMonth : null,
        priorMonth: mayReadMoney && consecutive ? priorMonth : null,
      });
      indicators = [
        indicator('tracked_items', items.length > 0 ? items.length : null, 'neutral', 'count', readPartial),
        indicator('low_stock_items', low, (low ?? 0) > 0 ? 'warning' : 'neutral', 'count', readPartial),
        indicator('uncounted_items', uncounted, (uncounted ?? 0) > 0 ? 'warning' : 'neutral', 'count', readPartial),
        ...(mayReadMoney ? [
          indicator(
            'last_closed_spend',
            readPartial ? null : latestSpend,
            'neutral',
            'currency_cents',
          ),
          indicator(
            'spend_variance_percent',
            readPartial ? null : roundedChangePercent(latestSpend, priorSpend),
            'neutral',
            'percent',
          ),
        ] : []),
      ];
      evidenceRows = [...items, ...(mayReadMoney ? closeRows : [])];
      drilldownRows = items;
    } else if (section === 'staff') {
      const shifts = sourceRows(
        scoped,
        'staff_shift',
        (row) => row.shift_date != null || row.kind != null,
      ).filter((row) => row.shift_date === localDate);
      const roster = sourceRows(scoped, 'staff_roster');
      const shiftValuesValid = shifts.every((row) => row.kind === 'shift' || row.kind === 'open');
      if (!shiftValuesValid) shapePartial = true;
      const assigned = shifts.length > 0 && shiftValuesValid
        ? shifts.filter((row) => row.kind === 'shift' && stringValue(row.staff_id)).length
        : null;
      const open = shifts.length > 0 && shiftValuesValid
        ? shifts.filter((row) => row.kind === 'open').length
        : null;
      const people = shifts.length > 0 && shiftValuesValid
        ? new Set(
          shifts.map((row) => stringValue(row.staff_id)).filter((id): id is string => !!id),
        ).size
        : null;
      const active = roster.length > 0 ? roster.length : null;
      const keyLeaders = roster.length > 0 ? roster.filter((row) => (
        row.is_scheduling_manager === true || row.is_senior === true
      )).length : null;
      const assignedDepartments = new Set(
        shifts
          .filter((row) => row.kind === 'shift')
          .map((row) => stringValue(row.department))
          .filter((value): value is string => value != null),
      );
      const openRows = shifts.filter((row) => row.kind === 'open');
      const openDepartments = new Set(
        openRows.map((row) => stringValue(row.department)).filter((value): value is string => value != null),
      );
      const uncoveredDepartments = shifts.length === 0 || !shiftValuesValid
        ? null
        : openRows.some((row) => !stringValue(row.department))
        ? null
        : [...openDepartments].filter((department) => !assignedDepartments.has(department)).length;
      if (uncoveredDepartments == null && openRows.length > 0) shapePartial = true;
      staffFacts.push({
        reporting: shifts.length > 0 || roster.length > 0,
        assigned,
        open,
        people,
        active,
        keyLeaders,
        uncoveredDepartments,
      });
      indicators = [
        indicator('active_staff', active, 'neutral', 'count', readPartial),
        indicator('key_leaders', keyLeaders, keyLeaders === 0 ? 'warning' : 'neutral', 'count', readPartial),
        indicator('open_shifts', open, (open ?? 0) > 0 ? 'warning' : 'neutral', 'count', readPartial),
        indicator(
          'staffing_coverage_percent',
          readPartial || assigned == null || open == null
            ? null
            : roundedPercent(assigned, assigned + open),
          'neutral',
          'percent',
        ),
        indicator(
          'departments_without_coverage',
          readPartial ? null : uncoveredDepartments,
          (uncoveredDepartments ?? 0) > 0 ? 'warning' : 'neutral',
        ),
      ];
      evidenceRows = [...shifts, ...roster];
      drilldownRows = shifts;
    } else {
      const daily = sourceRows(scoped, 'financial_daily', () => true);
      const windows = monthWindows(localDate);
      const currentRows = exactDateWindowRows(daily, windows.currentStart, windows.currentEnd);
      const comparisonCurrentRows = exactDateWindowRows(
        daily,
        windows.currentStart,
        windows.currentComparableEnd,
      );
      const priorRows = exactDateWindowRows(daily, windows.priorStart, windows.priorEnd);
      const current = financialNumbers(currentRows ?? []);
      const comparisonCurrent = financialNumbers(comparisonCurrentRows ?? []);
      const prior = financialNumbers(priorRows ?? []);
      if (!currentRows || !comparisonCurrentRows || !priorRows) {
        shapePartial = true;
        shapePartialReason = 'insufficient_date_coverage';
      } else if (
        current.revenueCents == null
        || current.roomsRevenueCents == null
        || current.occupiedRooms == null
        || current.availableRooms == null
        || current.grossOperatingProfitCents == null
        || comparisonCurrent.revenueCents == null
        || prior.revenueCents == null
      ) {
        shapePartial = true;
      }
      financialFacts.push({ current, comparisonCurrent, prior });
      indicators = [
        indicator('month_to_date_revenue', readPartial ? null : current.revenueCents, 'neutral', 'currency_cents'),
        indicator(
          'revenue_change_percent',
          readPartial
            ? null
            : roundedChangePercent(comparisonCurrent.revenueCents, prior.revenueCents),
          'neutral',
          'percent',
        ),
        indicator('occupancy_percent', readPartial ? null : current.occupancyPercent, 'neutral', 'percent'),
        indicator('adr', readPartial ? null : current.adrCents, 'neutral', 'currency_cents'),
        indicator('revpar', readPartial ? null : current.revparCents, 'neutral', 'currency_cents'),
        indicator(
          'gross_operating_profit',
          readPartial ? null : current.grossOperatingProfitCents,
          'neutral',
          'currency_cents',
        ),
      ];
      evidenceRows = daily;
    }

    if (evidenceRows.length === 0) {
      shapePartial = true;
      shapePartialReason = 'no_source_record';
      indicators = indicators.map((value) => ({
        ...value,
        value: null,
        tone: 'neutral',
        lowerBound: false,
      }));
    }

    const observedAt = latestTimestamp(
      evidenceRows,
      ['last_synced_at', 'last_counted_at', 'acknowledged_at', 'updated_at', 'created_at'],
    );
    let freshness = staleFreshness(
      observedAt,
      now,
      section === 'inventory' ? 7 * 86_400_000 : 36 * 60 * 60 * 1_000,
      localDate,
    );
    if (readPartial) freshness = partialFreshness('bounded_read_incomplete', observedAt);
    else if (shapePartial && evidenceRows.length > 0) {
      freshness = partialFreshness(shapePartialReason, observedAt);
    }
    hotels.push(sectionHotel(
      property,
      drilldownRows,
      freshness,
      readPartial || shapePartial,
      indicators,
    ));
  }

  if (!complete) return { summary: nullSummary(section), hotels };
  let summary: PortfolioUiSectionSummary;
  switch (section) {
    case 'dashboard': {
      const today = dashboardFacts.filter((fact) => fact.today != null);
      const recent = dashboardFacts.filter((fact) => fact.recent != null);
      const comparison = dashboardFacts.filter((fact) => fact.recent != null && fact.prior != null);
      const todayCombined = combinedOccupancy(today.map((fact) => fact.today));
      const recentCombined = combinedOccupancy(recent.map((fact) => fact.recent));
      const comparableRecent = combinedOccupancy(comparison.map((fact) => fact.recent));
      const comparablePrior = combinedOccupancy(comparison.map((fact) => fact.prior));
      const financialReporting = dashboardFacts.filter((fact) => fact.currentRevenue != null);
      const financialComparison = dashboardFacts.filter((fact) => (
        fact.comparisonCurrentRevenue != null && fact.priorRevenue != null
      ));
      const comparisonCurrentRevenue = allOrNull(
        financialComparison.map((fact) => fact.comparisonCurrentRevenue),
      );
      const comparisonPriorRevenue = allOrNull(
        financialComparison.map((fact) => fact.priorRevenue),
      );
      summary = {
        kind: section,
        reportingHotels: countOrNull(today),
        occupiedRooms: todayCombined?.occupied ?? null,
        availableRooms: todayCombined?.available ?? null,
        occupancyPercent: todayCombined?.percent ?? null,
        occupancyComparisonHotels: countOrNull(comparison),
        recentOccupancyPercent: recentCombined?.percent ?? null,
        priorOccupancyPercent: comparablePrior?.percent ?? null,
        occupancyChangePoints: roundedDelta(
          comparableRecent?.percent ?? null,
          comparablePrior?.percent ?? null,
        ),
        financialReportingHotels: countOrNull(financialReporting),
        financialComparisonHotels: countOrNull(financialComparison),
        monthToDateRevenueCents: allOrNull(
          financialReporting.map((fact) => fact.currentRevenue),
        ),
        priorPeriodRevenueCents: comparisonPriorRevenue,
        revenueChangePercent: roundedChangePercent(
          comparisonCurrentRevenue,
          comparisonPriorRevenue,
        ),
      };
      break;
    }
    case 'housekeeping': {
      const taskReporting = housekeepingFacts.filter((fact) => fact.taskReporting);
      const staffingReporting = housekeepingFacts.filter((fact) => fact.staffingReporting);
      const completed = allOrNull(taskReporting.map((fact) => fact.completed));
      const open = allOrNull(taskReporting.map((fact) => fact.open));
      const urgent = allOrNull(taskReporting.map((fact) => fact.urgent));
      const staffed = allOrNull(staffingReporting.map((fact) => fact.staffed));
      const openSlots = allOrNull(staffingReporting.map((fact) => fact.openSlots));
      summary = {
        kind: section,
        reportingHotels: countOrNull(taskReporting),
        openTasks: open,
        urgentTasks: urgent,
        completedTasks: completed,
        completionPercent: completed != null && open != null
          ? roundedPercent(completed, completed + open)
          : null,
        staffingReportingHotels: countOrNull(staffingReporting),
        staffedShifts: staffed,
        openStaffingSlots: openSlots,
        staffingCoveragePercent: staffed != null && openSlots != null
          ? roundedPercent(staffed, staffed + openSlots)
          : null,
      };
      break;
    }
    case 'communications': {
      const reporting = communicationsFacts.filter((fact) => fact.reporting);
      const escalationReporting = communicationsFacts.filter((fact) => fact.escalationReporting);
      const announcementReporting = communicationsFacts.filter((fact) => fact.announcementReporting);
      const acknowledged = allOrNull(announcementReporting.map((fact) => fact.acknowledged));
      const expected = allOrNull(announcementReporting.map((fact) => fact.expected));
      summary = {
        kind: section,
        reportingHotels: countOrNull(reporting),
        openItems: allOrNull(escalationReporting.map((fact) => fact.open)),
        highSeverityItems: allOrNull(escalationReporting.map((fact) => fact.high)),
        announcements: allOrNull(announcementReporting.map((fact) => fact.announcements)),
        companyAnnouncements: announcementReporting.length > 0
          ? new Set(announcementReporting.flatMap((fact) => fact.campaignIds)).size
          : null,
        acknowledgementResponses: acknowledged,
        pendingAcknowledgements: allOrNull(
          announcementReporting.map((fact) => fact.pending),
        ),
        acknowledgementPercent: acknowledged != null && expected != null
          ? roundedPercent(acknowledged, expected)
          : null,
      };
      break;
    }
    case 'maintenance': {
      const reporting = maintenanceFacts.filter((fact) => fact.reporting);
      const workReporting = maintenanceFacts.filter((fact) => fact.workReporting);
      const historyReporting = maintenanceFacts.filter((fact) => fact.historyReporting);
      const equipmentReporting = maintenanceFacts.filter((fact) => fact.equipmentReporting);
      summary = {
        kind: section,
        reportingHotels: countOrNull(reporting),
        openWorkOrders: allOrNull(workReporting.map((fact) => fact.open)),
        urgentWorkOrders: allOrNull(workReporting.map((fact) => fact.urgent)),
        highPriorityWorkOrders: allOrNull(workReporting.map((fact) => fact.high)),
        agingWorkOrders: allOrNull(workReporting.map((fact) => fact.aging)),
        recurringEquipmentIssues: allOrNull(historyReporting.map((fact) => fact.recurring)),
        degradedEquipment: allOrNull(equipmentReporting.map((fact) => fact.degraded)),
      };
      break;
    }
    case 'inventory': {
      const reporting = inventoryFacts.filter((fact) => fact.reporting);
      const itemReporting = inventoryFacts.filter((fact) => fact.tracked != null);
      const comparable = inventoryFacts.filter((fact) => (
        fact.latestSpend != null
        && fact.priorSpend != null
        && fact.latestMonth != null
        && fact.priorMonth != null
      ));
      const periodPairs = new Set(
        comparable.map((fact) => `${fact.latestMonth}:${fact.priorMonth}`),
      );
      const samePeriods = periodPairs.size === 1;
      const latestSpend = samePeriods
        ? allOrNull(comparable.map((fact) => fact.latestSpend))
        : null;
      const priorSpend = samePeriods
        ? allOrNull(comparable.map((fact) => fact.priorSpend))
        : null;
      summary = {
        kind: section,
        reportingHotels: countOrNull(reporting),
        trackedItems: allOrNull(itemReporting.map((fact) => fact.tracked)),
        lowStockItems: allOrNull(itemReporting.map((fact) => fact.low)),
        uncountedItems: allOrNull(itemReporting.map((fact) => fact.uncounted)),
        comparableSpendHotels: countOrNull(comparable),
        lastClosedSpendCents: latestSpend,
        priorClosedSpendCents: priorSpend,
        spendVariancePercent: roundedChangePercent(latestSpend, priorSpend),
      };
      break;
    }
    case 'staff': {
      const reporting = staffFacts.filter((fact) => fact.reporting);
      const shiftReporting = staffFacts.filter((fact) => fact.assigned != null && fact.open != null);
      const rosterReporting = staffFacts.filter((fact) => fact.active != null);
      const assigned = allOrNull(shiftReporting.map((fact) => fact.assigned));
      const open = allOrNull(shiftReporting.map((fact) => fact.open));
      summary = {
        kind: section,
        reportingHotels: countOrNull(reporting),
        assignedShifts: assigned,
        openShifts: open,
        scheduledPeople: allOrNull(shiftReporting.map((fact) => fact.people)),
        activeStaff: allOrNull(rosterReporting.map((fact) => fact.active)),
        keyLeaders: allOrNull(rosterReporting.map((fact) => fact.keyLeaders)),
        departmentsWithoutCoverage: allOrNull(
          shiftReporting.map((fact) => fact.uncoveredDepartments),
        ),
        staffingCoveragePercent: assigned != null && open != null
          ? roundedPercent(assigned, assigned + open)
          : null,
      };
      break;
    }
    case 'financials': {
      const reporting = financialFacts.filter((fact) => fact.current.revenueCents != null);
      const comparison = reporting.filter((fact) => (
        fact.comparisonCurrent.revenueCents != null && fact.prior.revenueCents != null
      ));
      const comparisonCurrent = allOrNull(
        comparison.map((fact) => fact.comparisonCurrent.revenueCents),
      );
      const comparisonPrior = allOrNull(
        comparison.map((fact) => fact.prior.revenueCents),
      );
      const occupied = allOrNull(reporting.map((fact) => fact.current.occupiedRooms));
      const availableRooms = allOrNull(reporting.map((fact) => fact.current.availableRooms));
      const roomsRevenue = allOrNull(reporting.map((fact) => fact.current.roomsRevenueCents));
      summary = {
        kind: section,
        reportingHotels: countOrNull(reporting),
        monthToDateRevenueCents: allOrNull(
          reporting.map((fact) => fact.current.revenueCents),
        ),
        occupiedRooms: occupied,
        comparisonHotels: countOrNull(comparison),
        priorPeriodRevenueCents: comparisonPrior,
        revenueChangePercent: roundedChangePercent(comparisonCurrent, comparisonPrior),
        occupancyPercent: occupied != null && availableRooms != null
          ? roundedPercent(occupied, availableRooms)
          : null,
        adrCents: roomsRevenue != null && occupied != null && occupied > 0
          ? Math.round(roomsRevenue / occupied)
          : null,
        revparCents: roomsRevenue != null && availableRooms != null && availableRooms > 0
          ? Math.round(roomsRevenue / availableRooms)
          : null,
        grossOperatingProfitCents: allOrNull(
          reporting.map((fact) => fact.current.grossOperatingProfitCents),
        ),
      };
      break;
    }
  }
  return { summary, hotels };
}

export interface PortfolioUiSectionOptions {
  account: ManagerCaller;
  authoritativeCompany?: PortfolioUiAuthoritativeCompany;
  organizationId: string;
  section: PortfolioUiSection;
  now?: Date;
  source?: PortfolioUiDataSource;
}

/** Reauthorizes the organization from the current account snapshot on every call. */
export async function loadPortfolioUiSection(
  options: PortfolioUiSectionOptions,
): Promise<PortfolioUiServerResult<PortfolioUiSectionV1>> {
  const source = options.source ?? portfolioUiDataSource;
  const now = options.now ?? new Date();
  const organizationId = options.organizationId.toLowerCase();
  const fact = authorizedPortfolioUiContexts(
    options.authoritativeCompany ? [options.authoritativeCompany] : options.account,
  )
    .find((candidate) => candidate.organizationId === organizationId);
  if (!fact) {
    return resultError(403, 'company_not_authorized', 'That company is not available to this account');
  }

  let propertyRead: PortfolioUiBulkRows<PropertyRow>;
  try {
    const rawPropertyRead = await source.readProperties(fact.hotelIds);
    const validated = validatePropertyRead(rawPropertyRead, fact.hotelIds);
    if (!validated) throw new Error('portfolio property adapter crossed or malformed its scope');
    propertyRead = validated;
  } catch {
    return resultError(503, 'data_unavailable', 'Portfolio properties are temporarily unavailable');
  }

  let overrides: FinancialOverrideRow[] = [];
  let overridesAvailable = true;
  let chatRows: CompanyChatRow[] = [];
  let chatAvailable = true;
  await Promise.all([
    source.readFinancialOverrides(propertyRead.rows.map((row) => row.id))
      .then((rows) => { overrides = rows; })
      .catch(() => { overridesAvailable = false; }),
    source.readCompanyChatSettings([fact.organizationId])
      .then((rows) => { chatRows = rows; })
      .catch(() => { chatAvailable = false; }),
  ]);

  if (options.section === 'financials' && !overridesAvailable) {
    return resultError(503, 'access_unavailable', 'Financial access is temporarily unavailable');
  }

  const overrideMap = financialOverrideMap(overrides);
  const parsedById = new Map<string, ReturnType<typeof strictSections>>();
  const financialByHotel = new Map<string, boolean>();
  for (const property of propertyRead.rows) {
    const parsed = strictSections(property.enabled_sections);
    parsedById.set(property.id, parsed);
    const caps = hotelCapabilities(
      options.account,
      property.id,
      parsed.sections,
      overrideMap,
      overridesAvailable,
      fact.propertyStandings.find((standing) => standing.propertyId === property.id),
      fact.companyRole,
    );
    financialByHotel.set(property.id, caps.canViewFinancials);
  }
  const chat = chatStates([fact], chatRows, chatAvailable).get(fact.organizationId)
    ?? { state: 'unavailable' as const, reason: 'settings_unavailable' };
  const capabilities = contextCapabilities(fact, financialByHotel, chat.state === 'available');
  if (options.section === 'financials' && !capabilities.canViewFinancials) {
    return resultError(403, 'financials_forbidden', 'Financials are not available for this company context');
  }

  const readableProperties = propertyRead.rows.filter((property) => {
    const parsed = parsedById.get(property.id);
    if (!parsed || !parsed.sections[options.section]) return false;
    return options.section !== 'financials' || financialByHotel.get(property.id) === true;
  });

  let domainRead = bulkRows<Record<string, unknown>>([], 0, 1);
  let domainAvailable = true;
  if (readableProperties.length > 0) {
    try {
      const rawDomainRead = await source.readSectionRows(
        options.section,
        readableProperties.map((row) => row.id),
        readableProperties
          .filter((row) => financialByHotel.get(row.id) === true)
          .map((row) => row.id),
        now,
        readLimit(readableProperties.length, options.section === 'inventory' ? 200 : 100),
      );
      const validated = validateSectionRead(
        rawDomainRead,
        readableProperties.map((row) => row.id),
      );
      if (!validated) throw new Error('portfolio section adapter crossed or malformed its scope');
      domainRead = validated;
    } catch {
      domainAvailable = false;
    }
  }

  const aggregated = aggregateSection(
    options.section,
    readableProperties,
    domainRead.rows,
    domainRead.complete,
    domainAvailable,
    now,
    new Set(
      readableProperties
        .filter((property) => financialByHotel.get(property.id) === true)
        .map((property) => property.id),
    ),
  );
  const aggregatedById = new Map(aggregated.hotels.map((hotel) => [hotel.propertyId, hotel]));
  const hotels: PortfolioUiSectionHotel[] = propertyRead.rows.map((property) => {
    const rendered = aggregatedById.get(property.id);
    if (rendered) return rendered;
    const parsed = parsedById.get(property.id);
    const reason = !parsed || parsed.malformed
      ? 'section_policy_unavailable'
      : !parsed.sections[options.section]
        ? 'section_disabled'
        : 'capability_denied';
    return {
      propertyId: property.id,
      name: property.name ?? 'This hotel',
      city: null,
      region: property.region ?? null,
      brand: property.brand ?? null,
      freshness: {
        state: reason === 'section_disabled' ? 'disabled' : 'unavailable',
        observedAt: null,
        asOfDate: null,
        reason,
      },
      partial: reason !== 'section_disabled',
      indicators: [],
      drilldownIds: [],
      drilldownOmitted: 0,
    };
  });

  const shownIds = new Set(propertyRead.rows.map((row) => row.id));
  const missingPropertyIds = fact.hotelIds.filter((id) => !shownIds.has(id));
  const policyPartial = [...parsedById.values()].some((parsed) => parsed.malformed);
  const partial = !propertyRead.complete
    || missingPropertyIds.length > 0
    || !overridesAvailable
    || !chatAvailable
    || !domainAvailable
    || !domainRead.complete
    || policyPartial
    || hotels.some((hotel) => hotel.partial);

  return {
    ok: true,
    data: {
      version: PORTFOLIO_UI_VERSION,
      generatedAt: now.toISOString(),
      organizationId: fact.organizationId,
      section: options.section,
      capabilities,
      coverage: coverage(fact.hotelIds.length, propertyRead.rows.length),
      partial,
      missingPropertyIds,
      summary: aggregated.summary,
      hotels,
    },
  };
}
