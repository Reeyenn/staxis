import {
  APP_SECTIONS,
  normalizeSectionFlags,
  resolveSections,
} from '@/lib/sections/registry';

export type AtlasAvailability = 'available' | 'unavailable';
export type AtlasServiceStatus = 'live' | 'attention' | 'setup' | 'retired' | 'unknown';
export type AtlasFeedState =
  | 'live'
  | 'stale'
  | 'learning'
  | 'unavailable'
  | 'no_expectations'
  | 'unknown';

export interface AtlasPropertyRow {
  id: string;
  name: string | null;
  total_rooms: number | null;
  subscription_status: string | null;
  property_kind: string | null;
  pms_type: string | null;
  onboarding_completed_at: string | null;
  enabled_sections: unknown;
  created_at: string;
  updated_at: string;
}

export interface AtlasStaffRow {
  id: string;
  property_id: string;
}

export interface AtlasPropertyHealthRow {
  property_id: string | null;
  worst_state: string | null;
  feeds_total: number | null;
  feeds_live: number | null;
  feeds_stale: number | null;
  feeds_learning: number | null;
  feeds_unavailable: number | null;
  required_feeds_degraded: number | null;
  newest_signal_at: string | null;
  worst_minutes_late: number | null;
  open_quarantine_total: number | null;
  open_unmapped_total: number | null;
}

export interface AtlasSchemaRow {
  tablename: unknown;
  rls_enabled: boolean | null;
  policy_count: number | null;
  has_tenant_column: boolean | null;
}

export interface AtlasHotel {
  id: string;
  name: string;
  subscriptionStatus: string;
  propertyKind: string;
  totalRooms: number;
  activeStaff: number | null;
  onboardingCompleted: boolean;
  enabledSectionCount: number;
  createdAt: string;
  updatedAt: string;
  report: {
    state: AtlasFeedState;
    lastSignalAt: string | null;
    minutesLate: number | null;
    feedCount: number;
    liveFeeds: number;
    warnings: string[];
  };
}

export interface AtlasSchemaDomain {
  id: string;
  label: string;
  purpose: string;
  tables: string[];
  security: {
    rlsEnabled: number;
    withPolicies: number;
    directTenantColumn: number;
  };
}

export interface DataAtlasPayload {
  generatedAt: string;
  overview: {
    hotels: number;
    organizations: number | null;
    activeStaff: number | null;
    roomsConfigured: number;
    warnings: string[];
  };
  hotels: AtlasHotel[];
  schema: {
    status: AtlasAvailability;
    tableCount: number | null;
    rlsEnabledCount: number | null;
    policyCoveredCount: number | null;
    directTenantColumnCount: number | null;
    domains: AtlasSchemaDomain[];
    note: string;
  };
  domains: Array<{
    id: string;
    label: string;
    description: string;
    status: 'catalogued';
    rowCount: number | null;
  }>;
  services: Array<{
    id: string;
    label: string;
    summary: string;
    status: AtlasServiceStatus;
  }>;
  migrations: {
    status: AtlasAvailability;
    appliedCount: number | null;
    latestVersion: string | null;
    latestAppliedAt: string | null;
    note: string;
  };
}

interface SchemaDomainDefinition {
  id: string;
  label: string;
  purpose: string;
  exact?: readonly string[];
  prefixes?: readonly string[];
}

const SCHEMA_DOMAIN_DEFINITIONS: readonly SchemaDomainDefinition[] = [
  {
    id: 'hotels-access',
    label: 'Hotels & access',
    purpose: 'Hotels, companies, memberships, invitations, and account access.',
    exact: ['properties', 'organizations', 'accounts', 'hotel_join_codes', 'join_requests'],
    prefixes: ['account_', 'organization_', 'authorization_', 'company_access_', 'role_changes', 'trusted_devices', 'mfa_'],
  },
  {
    id: 'housekeeping',
    label: 'Housekeeping',
    purpose: 'Rooms, cleaning work, inspections, laundry, and walkthroughs.',
    exact: ['room_work', 'inspections', 'laundry_completion', 'laundry_config'],
    prefixes: ['cleaning_', 'housekeeping_', 'hk_', 'inspection_', 'deep_clean_', 'walkthrough_', 'manager_room_'],
  },
  {
    id: 'people-scheduling',
    label: 'People & scheduling',
    purpose: 'Staff records, shifts, availability, attendance, and schedules.',
    exact: ['staff', 'scheduled_shifts', 'attendance_marks', 'time_off_requests'],
    prefixes: ['staff_', 'schedule_', 'shift_', 'callout_', 'property_shift_', 'week_publications'],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    purpose: 'Work orders, equipment, preventive work, and hotel areas.',
    exact: ['work_orders', 'preventive_tasks', 'equipment', 'component_rooms', 'public_areas'],
  },
  {
    id: 'inventory',
    label: 'Inventory & purchasing',
    purpose: 'Supplies, counts, budgets, vendors, orders, and deliveries.',
    exact: ['inventory', 'catalog_items', 'vendors'],
    prefixes: ['inventory_', 'purchase_', 'vendor_'],
  },
  {
    id: 'messages',
    label: 'Messages & guest service',
    purpose: 'Team communication, handoffs, requests, notices, and lost items.',
    exact: ['guest_requests', 'complaints', 'daily_logs', 'handoff_logs', 'lost_and_found_items', 'manager_notifications', 'packages'],
    prefixes: ['comms_', 'housekeeping_notices'],
  },
  {
    id: 'money',
    label: 'Money',
    purpose: 'Expenses, budgets, payments, capital projects, and financial records.',
    exact: ['expenses', 'financial_expenses', 'payment_history', 'department_budgets'],
    prefixes: ['financial_', 'capex_', 'labor_wage_', 'stripe_'],
  },
  {
    id: 'reports-exports',
    label: 'Reports & exports',
    purpose: 'Reports Staxis creates, plus their schedules, favorites, and delivery choices.',
    exact: ['report_runs', 'report_preferences', 'report_favorites', 'report_schedules'],
  },
  {
    id: 'pms-reports',
    label: 'PMS reports',
    purpose: 'Scheduled report intake, mappings, data quality, and hotel operating facts.',
    exact: ['property_sessions', 'onboarding_jobs', 'pull_jobs', 'workflow_jobs'],
    prefixes: ['pms_', 'mapping_', 'mapper_', 'scraper_'],
  },
  {
    id: 'ai-intelligence',
    label: 'AI & intelligence',
    purpose: 'AI conversations, recommendations, models, findings, and portfolio intelligence.',
    exact: ['agents', 'findings', 'model_runs', 'optimizer_results', 'prediction_log', 'supply_predictions', 'supply_priors'],
    prefixes: ['agent_', 'ai_', 'ml_', 'finding_', 'demand_', 'prediction_', 'management_pattern_', 'portfolio_'],
  },
  {
    id: 'platform',
    label: 'Platform & audit',
    purpose: 'Settings, limits, logs, background jobs, diagnostics, and platform history.',
    exact: ['activity_log', 'admin_audit_log', 'applied_migrations', 'cron_heartbeats', 'error_logs', 'idempotency_log', 'webhook_log'],
    prefixes: ['app_', 'api_', 'github_', 'processed_', 'local_worktrees', 'roadmap_'],
  },
] as const;

const OTHER_DOMAIN: SchemaDomainDefinition = {
  id: 'other',
  label: 'Other',
  purpose: 'New or specialized tables that do not fit a founder-facing group yet.',
};

function matchesDomain(table: string, definition: SchemaDomainDefinition): boolean {
  if (definition.exact?.includes(table)) return true;
  return definition.prefixes?.some((prefix) => table.startsWith(prefix)) ?? false;
}

function finiteCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function groupAtlasSchema(rows: readonly AtlasSchemaRow[]): AtlasSchemaDomain[] {
  const groups = new Map<string, { definition: SchemaDomainDefinition; rows: AtlasSchemaRow[] }>();
  for (const definition of [...SCHEMA_DOMAIN_DEFINITIONS, OTHER_DOMAIN]) {
    groups.set(definition.id, { definition, rows: [] });
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.tablename !== 'string' || row.tablename.trim().length === 0) continue;
    const name = row.tablename.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = SCHEMA_DOMAIN_DEFINITIONS.find((candidate) => matchesDomain(name, candidate)) ?? OTHER_DOMAIN;
    groups.get(definition.id)?.rows.push({ ...row, tablename: name });
  }

  return [...groups.values()]
    .map(({ definition, rows: domainRows }): AtlasSchemaDomain => ({
      id: definition.id,
      label: definition.label,
      purpose: definition.purpose,
      tables: domainRows
        .map((row) => String(row.tablename))
        .sort((a, b) => a.localeCompare(b)),
      security: {
        rlsEnabled: domainRows.filter((row) => row.rls_enabled === true).length,
        withPolicies: domainRows.filter((row) => finiteCount(row.policy_count) > 0).length,
        directTenantColumn: domainRows.filter((row) => row.has_tenant_column === true).length,
      },
    }))
    .filter((domain) => domain.tables.length > 0);
}

function normalizeFeedState(value: string | null): Exclude<AtlasFeedState, 'no_expectations' | 'unknown'> | 'unknown' {
  return value === 'live' || value === 'stale' || value === 'learning' || value === 'unavailable'
    ? value
    : 'unknown';
}

function feedWarnings(row: AtlasPropertyHealthRow): string[] {
  const warnings: string[] = [];
  const stale = finiteCount(row.feeds_stale);
  const learning = finiteCount(row.feeds_learning);
  const degraded = finiteCount(row.required_feeds_degraded);
  const quarantined = finiteCount(row.open_quarantine_total);
  const unmapped = finiteCount(row.open_unmapped_total);
  if (degraded > 0) warnings.push(`${degraded} required feed${degraded === 1 ? '' : 's'} need attention.`);
  else if (stale > 0) warnings.push(`${stale} feed${stale === 1 ? '' : 's'} are late.`);
  if (learning > 0) warnings.push(`${learning} feed${learning === 1 ? '' : 's'} are still learning their report shape.`);
  if (quarantined > 0) warnings.push(`${quarantined} report row${quarantined === 1 ? '' : 's'} are waiting for review.`);
  if (unmapped > 0) warnings.push(`${unmapped} report column${unmapped === 1 ? '' : 's'} are not mapped yet.`);
  return warnings;
}

export function buildAtlasHotels(input: {
  properties: readonly AtlasPropertyRow[];
  activeStaff: readonly AtlasStaffRow[] | null;
  propertyHealth: readonly AtlasPropertyHealthRow[] | null;
}): AtlasHotel[] {
  const staffByProperty = new Map<string, number>();
  for (const row of input.activeStaff ?? []) {
    staffByProperty.set(row.property_id, (staffByProperty.get(row.property_id) ?? 0) + 1);
  }
  const healthByProperty = new Map<string, AtlasPropertyHealthRow>();
  for (const row of input.propertyHealth ?? []) {
    if (typeof row.property_id === 'string' && row.property_id.length > 0) {
      healthByProperty.set(row.property_id, row);
    }
  }

  return input.properties
    .map((property): AtlasHotel => {
      const health = healthByProperty.get(property.id);
      let report: AtlasHotel['report'];
      if (input.propertyHealth === null) {
        report = {
          state: 'unknown',
          lastSignalAt: null,
          minutesLate: null,
          feedCount: 0,
          liveFeeds: 0,
          warnings: ['Report health is unavailable right now.'],
        };
      } else if (!health) {
        report = {
          state: 'no_expectations',
          lastSignalAt: null,
          minutesLate: null,
          feedCount: 0,
          liveFeeds: 0,
          warnings: [
            property.pms_type
              ? 'A PMS is configured, but no scheduled report feeds are set up.'
              : 'No scheduled report feeds are set up for this hotel.',
          ],
        };
      } else {
        report = {
          state: normalizeFeedState(health.worst_state),
          lastSignalAt: health.newest_signal_at,
          minutesLate: health.worst_minutes_late,
          feedCount: finiteCount(health.feeds_total),
          liveFeeds: finiteCount(health.feeds_live),
          warnings: feedWarnings(health),
        };
      }
      const enabledSections = resolveSections(normalizeSectionFlags(property.enabled_sections));
      return {
        id: property.id,
        name: property.name?.trim() || 'Unnamed hotel',
        subscriptionStatus: property.subscription_status ?? 'unknown',
        propertyKind: property.property_kind ?? 'hotel',
        totalRooms: finiteCount(property.total_rooms),
        activeStaff: input.activeStaff === null ? null : staffByProperty.get(property.id) ?? 0,
        onboardingCompleted: Boolean(property.onboarding_completed_at),
        enabledSectionCount: APP_SECTIONS.filter((section) => enabledSections[section]).length,
        createdAt: property.created_at,
        updatedAt: property.updated_at,
        report,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeReportService(
  propertyHealth: readonly AtlasPropertyHealthRow[] | null,
): DataAtlasPayload['services'][number] {
  if (propertyHealth === null) {
    return {
      id: 'report-intake',
      label: 'Scheduled report data',
      summary: 'The report-health view could not be read right now.',
      status: 'unknown',
    };
  }
  if (propertyHealth.length === 0) {
    return {
      id: 'report-intake',
      label: 'Scheduled report data',
      summary: 'No hotel report schedules are configured yet.',
      status: 'setup',
    };
  }
  const needsAttention = propertyHealth.some((row) => {
    const state = normalizeFeedState(row.worst_state);
    return (state !== 'live' && state !== 'unavailable')
    || finiteCount(row.required_feeds_degraded) > 0
    || finiteCount(row.open_quarantine_total) > 0
    || finiteCount(row.open_unmapped_total) > 0;
  });
  const allTurnedOff = propertyHealth.every((row) => normalizeFeedState(row.worst_state) === 'unavailable');
  return {
    id: 'report-intake',
    label: 'Scheduled report data',
    summary: needsAttention
      ? 'At least one hotel report feed needs attention.'
      : allTurnedOff
        ? 'Configured scheduled feeds are turned off.'
        : `Active configured feed checks are current across ${propertyHealth.length} hotel${propertyHealth.length === 1 ? '' : 's'}.`,
    status: needsAttention ? 'attention' : allTurnedOff ? 'setup' : 'live',
  };
}
