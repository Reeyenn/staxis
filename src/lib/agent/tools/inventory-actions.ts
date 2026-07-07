// ─── Inventory action tools ────────────────────────────────────────────────
//
// Two AI-assistant abilities over the manual inventory (the `inventory` table —
// migration 0001, extended by the intelligence/ordering migrations):
//
//   get_low_stock  — READ: what's running low or critical right now, classified
//                    with the 70/30-style Good/Low/Critical thresholds the
//                    Inventory tab uses. Chat + general voice.
//   adjust_stock   — MUTATION (card): set an item's on-hand count, and
//                    optionally record that an order was placed for it.
//
// Data model (confirmed, do NOT invent tables):
//   inventory(id, property_id, name, category, current_stock, par_level,
//             reorder_at, unit, last_counted_at, last_ordered_at, …)
//   inventory_orders(property_id, item_id, item_name, quantity, ordered_at,
//                    received_at, notes, …) — the restock ledger (DOLLARS).
//
// Status classification mirrors src/app/inventory/_components/format.ts
// `ratioStatus`: ratio = current/par; <0.5 critical, <1.0 low, else good.
// (Re-implemented inline so a server tool doesn't import an app-route module.)
//
// Roles: reads + writes are allowed for managers AND front_desk (the inventory
// UI's default audience). The MUTATION additionally carries
// requiresCapability:'manage_inventory_orders' so executeTool enforces the same
// per-hotel Access-tab gate the InventoryShell uses (can('manage_inventory_orders')) —
// an admin who switched a role OFF for ordering at this property is honored here.
//
// ADDITIVE + self-registering — add `import './inventory-actions';` to index.ts.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { registerTool, type ToolResult, type ToolContext } from '../tools';

const INVENTORY_CATEGORIES = ['housekeeping', 'maintenance', 'breakfast'] as const;
type StockStatus = 'good' | 'low' | 'critical';

/** 70/30-style Good/Low/Critical from the current/par ratio. Matches the
 *  Inventory tab (format.ts ratioStatus): <0.5 critical, <1.0 low, else good.
 *  A zero/absent par can't be classified — treat as 'good' (no target set). */
function stockStatus(current: number, par: number): StockStatus {
  if (!(par > 0)) return 'good';
  const r = current / par;
  if (r < 0.5) return 'critical';
  if (r < 1.0) return 'low';
  return 'good';
}

interface InvItemRow {
  id: string;
  name: string;
  category: string;
  current_stock: number | null;
  par_level: number | null;
  unit: string | null;
}

const INV_SELECT = 'id, name, category, current_stock, par_level, unit';

/**
 * Resolve an inventory item by name (case-insensitive), with ambiguity as a
 * first-class outcome so a mutation never edits the wrong item. Prefers an
 * exact name match; falls back to substring. Scoped to the property.
 */
type ItemResolution =
  | { kind: 'ok'; item: InvItemRow }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: InvItemRow[] };

async function resolveInventoryItem(propertyId: string, query: string): Promise<ItemResolution> {
  const raw = String(query ?? '').trim();
  if (!raw) return { kind: 'none' };
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select(INV_SELECT)
    .eq('property_id', propertyId);
  if (error || !data) return { kind: 'none' };
  const rows = data as unknown as InvItemRow[];
  const q = raw.toLowerCase();
  const exact = rows.filter((r) => (r.name ?? '').toLowerCase() === q);
  const matches = exact.length > 0 ? exact : rows.filter((r) => (r.name ?? '').toLowerCase().includes(q));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.slice(0, 8) };
  return { kind: 'ok', item: matches[0] };
}

// ─── get_low_stock ───────────────────────────────────────────────────────────

interface GetLowStockArgs {
  category?: string;
  includeAll?: boolean;
}

registerTool<GetLowStockArgs>({
  name: 'get_low_stock',
  section: 'inventory',
  description:
    'List inventory items that are running LOW or CRITICAL right now. Use for "what\'s running low?", "what do we need to reorder?", "are we low on towels?", "qué se está acabando?". ' +
    'By default returns only low + critical items (below par). Set includeAll=true to list every item with its status. Optionally filter by category (housekeeping/maintenance/breakfast). ' +
    'Status is Critical below half of par, Low below par, Good at or above par.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['housekeeping', 'maintenance', 'breakfast'], description: 'Optional category filter.' },
      includeAll: { type: 'boolean', description: 'When true, return all items (not just low/critical).' },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  // Chat-only (default) — the whole new ability set is scoped to the chat surface.
  handler: async ({ category, includeAll }, ctx: ToolContext): Promise<ToolResult> => {
    const cat = category && (INVENTORY_CATEGORIES as readonly string[]).includes(category) ? category : null;
    let q = supabaseAdmin
      .from('inventory')
      .select(INV_SELECT)
      .eq('property_id', ctx.propertyId);
    if (cat) q = q.eq('category', cat);
    const { data, error } = await q;
    if (error) return { ok: false, error: 'Failed to load inventory.' };

    const all = (data as unknown as InvItemRow[] ?? []).map((r) => {
      const current = Number(r.current_stock ?? 0);
      const par = Number(r.par_level ?? 0);
      return {
        name: r.name,
        category: r.category,
        currentStock: current,
        parLevel: par,
        unit: r.unit ?? null,
        status: stockStatus(current, par),
      };
    });

    const rank: Record<StockStatus, number> = { critical: 0, low: 1, good: 2 };
    const filtered = (includeAll === true ? all : all.filter((i) => i.status !== 'good'))
      .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

    return {
      ok: true,
      data: {
        category: cat,
        totalItems: all.length,
        criticalCount: all.filter((i) => i.status === 'critical').length,
        lowCount: all.filter((i) => i.status === 'low').length,
        items: filtered,
      },
    };
  },
});

// ─── adjust_stock ────────────────────────────────────────────────────────────

interface AdjustStockArgs {
  itemName: string;
  newCount?: number;
  markOrdered?: boolean;
  orderQuantity?: number;
}

registerTool<AdjustStockArgs>({
  name: 'adjust_stock',
  section: 'inventory',
  description:
    'Update an inventory item\'s on-hand count and/or record that an order was placed for it. Use for "we have 40 rolls of toilet paper now", "set towels to 120", "mark the pillowcases as ordered", "pedí 2 cajas de jabón". ' +
    'itemName = the item (a partial name is fine if unique). Set newCount to the CURRENT on-hand quantity (not a delta). Set markOrdered=true to log that an order was placed; orderQuantity is how many were ordered. ' +
    'At least one of newCount or markOrdered is required. Managers and front desk only.',
  inputSchema: {
    type: 'object',
    properties: {
      itemName: { type: 'string', description: 'Which item — its name (partial is fine if unique).' },
      newCount: { type: 'number', description: 'The new CURRENT on-hand count (absolute, not a change).' },
      markOrdered: { type: 'boolean', description: 'When true, records that an order was placed for this item.' },
      orderQuantity: { type: 'number', description: 'How many units were ordered (only used with markOrdered).' },
    },
    required: ['itemName'],
  },
  allowedRoles: ['admin', 'owner', 'general_manager', 'front_desk'],
  requiresCapability: 'manage_inventory_orders',
  mutates: true,
  approval: 'card',
  handler: async ({ itemName, newCount, markOrdered, orderQuantity }, ctx: ToolContext): Promise<ToolResult> => {
    const wantsCount = typeof newCount === 'number' && Number.isFinite(newCount);
    const wantsOrder = markOrdered === true;
    if (!wantsCount && !wantsOrder) {
      return { ok: false, error: 'Tell me the new count, or that the item was ordered — there\'s nothing to change otherwise.' };
    }
    if (wantsCount && (newCount as number) < 0) {
      return { ok: false, error: 'The stock count can\'t be negative.' };
    }

    const res = await resolveInventoryItem(ctx.propertyId, itemName);
    if (res.kind === 'none') return { ok: false, error: `No inventory item matching "${itemName}" at this property.` };
    if (res.kind === 'ambiguous') {
      return {
        ok: false,
        error: `Several items match "${itemName}": ${res.candidates.map((c) => c.name).join(', ')}. Ask the user which one, then try again with the exact name.`,
        data: { ambiguous: true, candidates: res.candidates.map((c) => ({ name: c.name, category: c.category })) },
      };
    }
    const item = res.item;
    const count = wantsCount ? Math.round(Number(newCount)) : null;
    const orderQty = typeof orderQuantity === 'number' && Number.isFinite(orderQuantity) && orderQuantity > 0
      ? Math.round(orderQuantity) : null;

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, itemName: item.name, newCount: count, markedOrdered: wantsOrder, orderQuantity: orderQty } };
    }

    const nowIso = new Date().toISOString();

    // 1) Adjust the on-hand count. Stamp last_counted_at (a count was recorded) —
    //    same rule the inventory db helper enforces.
    if (wantsCount && count !== null) {
      const { error: updErr } = await supabaseAdmin
        .from('inventory')
        .update({ current_stock: count, last_counted_at: nowIso, updated_at: nowIso })
        .eq('property_id', ctx.propertyId)
        .eq('id', item.id);
      if (updErr) return { ok: false, error: 'Failed to update the stock count.' };
    }

    // 2) Record an order placed: append to the restock ledger + stamp the item's
    //    last_ordered_at (mirrors addInventoryOrder). Best-effort ledger row.
    let orderLogged = false;
    if (wantsOrder) {
      const { error: ordErr } = await supabaseAdmin
        .from('inventory_orders')
        .insert({
          property_id: ctx.propertyId,
          item_id: item.id,
          item_name: item.name,
          quantity: orderQty ?? 0,
          ordered_at: nowIso,
          notes: 'Marked ordered via assistant',
        });
      if (!ordErr) {
        orderLogged = true;
        await supabaseAdmin
          .from('inventory')
          .update({ last_ordered_at: nowIso, updated_at: nowIso })
          .eq('property_id', ctx.propertyId)
          .eq('id', item.id);
      }
    }

    return {
      ok: true,
      data: {
        itemName: item.name,
        category: item.category,
        newCount: wantsCount ? count : null,
        unit: item.unit ?? null,
        markedOrdered: wantsOrder,
        orderLogged,
        orderQuantity: orderQty,
      },
    };
  },
});
