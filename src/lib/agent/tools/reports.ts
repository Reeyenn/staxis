// ─── Owner-tier report tools ──────────────────────────────────────────────
// Revenue, occupancy, inventory, financial reporting. Some of these are
// stubs until the underlying data sources are wired up — we return an
// honest "not yet available" message rather than making numbers up.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult } from '../tools';

// ─── get_occupancy ────────────────────────────────────────────────────────

registerTool<Record<string, never>>({
  name: 'get_occupancy',
  description:
    'Get current hotel occupancy. Returns total rooms, occupied count, vacant count, and occupancy percentage.',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  handler: async (_, ctx): Promise<ToolResult> => {
    const { data, error } = await supabaseAdmin
      .from('rooms')
      .select('status, type, is_dnd')
      .eq('property_id', ctx.propertyId);
    if (error) return { ok: false, error: 'Failed to read occupancy.' };

    const total = data?.length ?? 0;
    // Occupied: anything that's NOT 'vacant' type. DND rooms count as occupied (guest is in).
    const occupied = (data ?? []).filter(r => r.type !== 'vacant').length;
    const vacant = total - occupied;
    const occupancyPct = total > 0 ? Math.round((occupied / total) * 1000) / 10 : 0;

    return {
      ok: true,
      data: {
        total,
        occupied,
        vacant,
        occupancyPercent: occupancyPct,
      },
    };
  },
});

// ─── get_revenue ──────────────────────────────────────────────────────────

registerTool<{ period?: 'today' | 'week' | 'month' | 'quarter' | 'year' }>({
  name: 'get_revenue',
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
      .eq('property_id', ctx.propertyId);
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
