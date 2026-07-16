// ─── Owner-tier report tools ──────────────────────────────────────────────
// Revenue, occupancy, inventory, financial reporting. Some of these are
// stubs until the underlying data sources are wired up — we return an
// honest "not yet available" message rather than making numbers up.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';
import { computeRoomTotal } from './_helpers';
import { fetchTodayPropertyCounts } from '@/lib/db/today-room-work';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { countsTrusted } from '@/lib/pms/feed-status';

// ─── get_occupancy ────────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_occupancy',
  description:
    'Get current hotel occupancy. Returns total rooms, occupied count, vacant count, and occupancy percentage.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  handler: async (_, ctx): Promise<ToolResult> => {
    // Plan v4 (2026): live room state now comes from the pms_* tables the
    // persistent CUA writes (the legacy `rooms` table is empty). Occupancy
    // is a COUNTS question, so we read the today_property_counts_v1 RPC
    // (in_house / vacant / total_rooms day aggregates) instead of listing
    // and re-aggregating every room — far cheaper, and this tool runs on a
    // hot path (every owner "how full are we?" turn).
    //
    // Date: there is no `rooms.date` anymore. "Current" = today in the
    // property's timezone, mirroring the doctor's Intl.DateTimeFormat
    // approach (route.ts: property-local `en-CA` date, UTC fallback).
    //
    // Total: kept the Round-14/Round-15 "never under-report" rule. Total is
    // the MAX of every size signal — properties.room_inventory.length,
    // properties.total_rooms, and now the RPC's total_rooms — so a stale or
    // empty source can't silently shrink the hotel. The doctor check still
    // fails loud when inventory and total_rooms disagree (INV-24).
    const { data: propRow } = await supabaseAdmin
      .from('properties')
      .select('room_inventory, total_rooms, timezone')
      .eq('id', ctx.propertyId)
      .maybeSingle();

    const inventory = (propRow?.room_inventory as string[] | null) ?? [];
    const inventoryLength = inventory.length;
    const configuredTotalRooms = Number(propRow?.total_rooms ?? 0);

    // Today in the property's local timezone (en-CA → YYYY-MM-DD), with a
    // UTC fallback if the timezone is missing/invalid — same shape the
    // doctor uses so the agent and the health check agree on "today".
    const tz = (propRow?.timezone as string | null) ?? null;
    let asOfDate: string;
    try {
      asOfDate = tz
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(new Date())
        : new Date().toISOString().slice(0, 10);
    } catch {
      asOfDate = new Date().toISOString().slice(0, 10);
    }

    // today_property_counts_v1: { checkouts, stayovers, vacant_clean,
    // vacant_dirty, ooo, total_rooms, in_house, ... }. Returns all-zeros
    // when the CUA hasn't populated a snapshot yet (bootstrap window) —
    // which reads as "every room vacant," the honest cold-start answer.
    const counts = await fetchTodayPropertyCounts(ctx.propertyId, asOfDate);

    // Occupied = rooms with a guest in them right now (point-in-time
    // in-house), not today's turn-work (checkouts + stayovers conflate
    // departures with occupancy). Fold the RPC's total_rooms into the same
    // max so it joins inventory + configured as a third "never shrink"
    // signal; seededRowCount is in_house (the occupied floor we can see).
    const occupied = Math.max(0, Number(counts.in_house ?? 0));
    const rpcTotalRooms = Math.max(0, Number(counts.total_rooms ?? 0));
    const { total } = computeRoomTotal(
      inventoryLength,
      Math.max(configuredTotalRooms, rpcTotalRooms),
      occupied,
    );
    const vacant = Math.max(0, total - occupied);
    const occupancyPercent = total > 0
      ? Math.round((occupied / total) * 1000) / 10
      : 0;

    // Review pass (fake-empty hunter #5) — in_house is a snapshot
    // COALESCE-0 when the counts feed has no source; "0 occupied / 0%"
    // would be a confident wrong claim. Null + explain instead.
    let countsOk = true;
    try {
      countsOk = countsTrusted(await getPropertyFeedStatus(ctx.propertyId));
    } catch { /* non-fatal */ }
    if (!countsOk) {
      return {
        ok: true,
        data: {
          total,
          occupied: null,
          vacant: null,
          occupancyPercent: null,
          asOfDate,
          pmsDataNote:
            'occupancy counts are not available from this hotel\'s PMS connection yet — say "still syncing / not available", never zero.',
        },
      };
    }

    return {
      ok: true,
      data: { total, occupied, vacant, occupancyPercent, asOfDate },
    };
  },
});

// ─── get_revenue ──────────────────────────────────────────────────────────

registerTool<{ period?: 'today' | 'week' | 'month' | 'quarter' | 'year' }>({
  name: 'get_revenue',
  section: 'financials',
  requiresCapability: 'view_financials',
  description:
    'Get revenue figures for a period. Returns total revenue, ADR (average daily rate), and RevPAR. Period defaults to "today".',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year'], description: 'Time window.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ period = 'today' }): Promise<ToolResult> => {
    // V1 stub: the financial data pipeline isn't wired into Supabase yet.
    // Returning an honest "not yet integrated" rather than fabricating numbers.
    return {
      ok: true,
      data: {
        period,
        note: 'Revenue reporting is not yet integrated with this property\'s PMS / accounting system. This will be wired up in a future release.',
        figures: null,
      },
    };
  },
});

// ─── get_financial_report ─────────────────────────────────────────────────

registerTool<{ period?: 'week' | 'month' | 'quarter' }>({
  name: 'get_financial_report',
  section: 'financials',
  requiresCapability: 'view_financials',
  description:
    'Get a detailed financial report for a period. Includes revenue breakdown, labor costs, and net margin. Returns structured data the chat can render as a table.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['week', 'month', 'quarter'], description: 'Time window.' },
    },
  },
  allowedRoles: ['admin', 'owner'],
  handler: async ({ period = 'month' }): Promise<ToolResult> => {
    return {
      ok: true,
      data: {
        period,
        note: 'Detailed financial reports are not yet integrated. The financial data pipeline (PMS revenue + payroll + expenses) will be wired up in a future release.',
        report: null,
      },
    };
  },
});

// ─── get_inventory ────────────────────────────────────────────────────────

registerTool<{ category?: 'housekeeping' | 'maintenance' | 'breakfast' | 'all' }>({
  name: 'get_inventory',
  section: 'inventory',
  description:
    'Get current inventory levels by category. Returns items, current stock, and any below the reorder threshold. Categories: housekeeping, maintenance, breakfast, or all.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['housekeeping', 'maintenance', 'breakfast', 'all'], description: 'Inventory category.' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ category = 'all' }, ctx): Promise<ToolResult> => {
    // Codex adversarial review 2026-05-13 (A-C8 / Codex F4): the prior
    // version queried `inventory_items` (doesn't exist) with field
    // `reorder_threshold` (also doesn't exist). Real table is `inventory`
    // with column `reorder_at` and categories housekeeping/maintenance/
    // breakfast (per supabase/migrations/0001_initial_schema.sql:285-301).
    // Old code ALWAYS returned the misleading "not set up" note.
    let q = supabaseAdmin
      .from('inventory')
      .select('name, category, current_stock, reorder_at, unit')
      .eq('property_id', ctx.propertyId)
      .is('archived_at', null);
    if (category !== 'all') q = q.eq('category', category);
    const { data, error } = await q;
    if (error) {
      // Surface the real error instead of pretending the data isn't there.
      return { ok: false, error: 'Failed to load inventory.' };
    }

    const items = (data ?? []).map(i => ({
      name: i.name as string,
      category: i.category as string,
      currentStock: Number(i.current_stock ?? 0),
      reorderThreshold: Number(i.reorder_at ?? 0),
      unit: (i.unit as string) ?? null,
      belowThreshold: Number(i.current_stock ?? 0) < Number(i.reorder_at ?? 0),
    }));

    const belowThreshold = items.filter(i => i.belowThreshold);
    return {
      ok: true,
      data: {
        category,
        totalItems: items.length,
        itemsBelowThreshold: belowThreshold.length,
        items,
      },
    };
  },
});

// ─── compare_properties ───────────────────────────────────────────────────
// Multi-property comparison. The agent layer is scoped to one property at
// a time per the plan ("multi-property aggregations" is out of scope for v1).
// Return an honest "not yet" so the owner sees a clear answer.

registerTool<{ metric?: 'revenue' | 'occupancy' | 'labor_cost' }>({
  name: 'compare_properties',
  requiresCapability: 'view_financials',
  description:
    'Compare metrics across all properties this user owns (revenue, occupancy, labor cost). Returns a ranked list.',
  inputSchema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: ['revenue', 'occupancy', 'labor_cost'], description: 'Metric to compare on.' },
    },
  },
  allowedRoles: ['admin', 'owner'],
  handler: async ({ metric = 'occupancy' }): Promise<ToolResult> => {
    return {
      ok: true,
      data: {
        metric,
        note: 'Multi-property comparison is not yet enabled. The agent is currently scoped to one property at a time. Switch the active property in the property switcher to ask about a different one.',
        results: null,
      },
    };
  },
});
