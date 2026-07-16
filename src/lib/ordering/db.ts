// ═══════════════════════════════════════════════════════════════════════════
// Inventory Ordering — server data layer (service-role).
//
// Every function here runs with supabaseAdmin (bypasses RLS) and is reached
// ONLY from /api/inventory/* routes behind requireOrderingAccess. The new
// ordering tables (migration 0246) are service-role-only.
//
// MONEY: purchase_orders.subtotal_cents + purchase_order_lines.unit_cost_cents
// are INTEGER CENTS. The legacy inventory.unit_cost + inventory_orders.* ledger
// is DOLLARS. Conversions happen HERE and nowhere else:
//   • createPurchaseOrders: cart unitCostCents (cents) → stamp inventory.unit_cost
//     in dollars (cents/100).
//   • receivePurchaseOrder: line.unit_cost_cents (cents) → inventory_orders
//     unit_cost/total_cost in dollars (cents/100), rounded to cents.
//   • spendRollup: inventory_orders.total_cost (dollars) → cents (round(d*100)).
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type {
  CartLineInput,
  CatalogItem,
  OrderStatus,
  PurchaseOrder,
  PurchaseOrderLine,
  ReceiveLineInput,
  SpendRollup,
  SpendRollupRow,
  Vendor,
} from './types';

// ── Row mappers ─────────────────────────────────────────────────────────────

function fromVendorRow(r: Record<string, unknown>): Vendor {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    accountNumber: (r.account_number as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    isActive: r.is_active !== false,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

function fromLineRow(r: Record<string, unknown>): PurchaseOrderLine {
  return {
    id: String(r.id),
    purchaseOrderId: String(r.purchase_order_id ?? ''),
    itemId: (r.item_id as string | null) ?? null,
    description: String(r.description ?? ''),
    qtyOrdered: Number(r.qty_ordered ?? 0),
    unitCostCents: Number(r.unit_cost_cents ?? 0),
    qtyReceived: Number(r.qty_received ?? 0),
  };
}

function fromPoRow(
  r: Record<string, unknown>,
  lines: PurchaseOrderLine[],
  vendorEmail: string | null,
): PurchaseOrder {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    poNumber: String(r.po_number ?? ''),
    vendorId: (r.vendor_id as string | null) ?? null,
    vendorName: (r.vendor_name_snapshot as string | null) ?? null,
    vendorEmail,
    status: ((r.status as string) ?? 'draft') as OrderStatus,
    subtotalCents: Number(r.subtotal_cents ?? 0),
    notes: (r.notes as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    sentAt: (r.sent_at as string | null) ?? null,
    sentToEmail: (r.sent_to_email as string | null) ?? null,
    receivedAt: (r.received_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
    lines,
  };
}

function fromCatalogRow(r: Record<string, unknown>): CatalogItem {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    category: ((r.category as string) ?? 'housekeeping') as CatalogItem['category'],
    defaultVendorName: (r.default_vendor_name as string | null) ?? null,
    suggestedPar: r.suggested_par == null ? null : Number(r.suggested_par),
    unit: String(r.unit ?? 'each'),
    suggestedUnitCostCents:
      r.suggested_unit_cost_cents == null ? null : Number(r.suggested_unit_cost_cents),
    sortOrder: Number(r.sort_order ?? 0),
  };
}

export async function getPropertyName(pid: string): Promise<string> {
  const { data } = await supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle();
  return (data?.name as string) ?? 'Our property';
}

// ── Vendors ─────────────────────────────────────────────────────────────────

export async function listVendors(pid: string, includeInactive = false): Promise<Vendor[]> {
  let q = supabaseAdmin.from('vendors').select('*').eq('property_id', pid);
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('name', { ascending: true });
  if (error) {
    log.error('[ordering] listVendors failed', { pid, err: error.message });
    throw error;
  }
  return (data ?? []).map((r) => fromVendorRow(r as Record<string, unknown>));
}

export interface VendorInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  accountNumber?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export async function createVendor(pid: string, input: VendorInput): Promise<Vendor> {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      property_id: pid,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      account_number: input.accountNumber ?? null,
      notes: input.notes ?? null,
      is_active: input.isActive ?? true,
    })
    .select('*')
    .single();
  if (error) {
    log.error('[ordering] createVendor failed', { pid, err: error.message });
    throw error;
  }
  return fromVendorRow(data as Record<string, unknown>);
}

export async function updateVendor(
  pid: string,
  vendorId: string,
  patch: Partial<VendorInput>,
): Promise<Vendor | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.accountNumber !== undefined) row.account_number = patch.accountNumber;
  if (patch.notes !== undefined) row.notes = patch.notes;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabaseAdmin
    .from('vendors')
    .update(row)
    .eq('id', vendorId)
    .eq('property_id', pid) // tenant scope — never touch another property's vendor
    .select('*')
    .maybeSingle();
  if (error) {
    log.error('[ordering] updateVendor failed', { pid, vendorId, err: error.message });
    throw error;
  }
  return data ? fromVendorRow(data as Record<string, unknown>) : null;
}

// ── Catalog ───────────────────────────────────────────────────────────────

export async function listCatalogItems(): Promise<CatalogItem[]> {
  const { data, error } = await supabaseAdmin
    .from('catalog_items')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) {
    log.error('[ordering] listCatalogItems failed', { err: error.message });
    throw error;
  }
  return (data ?? []).map((r) => fromCatalogRow(r as Record<string, unknown>));
}

// Idempotent: seeds inventory rows from the global catalog, skipping any item
// whose (name, category) already exists for the property. Returns counts.
export async function importCatalog(
  pid: string,
): Promise<{ imported: number; skipped: number }> {
  const catalog = await listCatalogItems();
  if (catalog.length === 0) return { imported: 0, skipped: 0 };

  const { data: existing, error: exErr } = await supabaseAdmin
    .from('inventory')
    .select('name, category')
    .eq('property_id', pid)
    .is('archived_at', null);
  if (exErr) {
    log.error('[ordering] importCatalog: read existing failed', { pid, err: exErr.message });
    throw exErr;
  }
  const have = new Set(
    (existing ?? []).map(
      (r) => `${String((r as { name?: string }).name ?? '').trim().toLowerCase()}|${String((r as { category?: string }).category ?? '')}`,
    ),
  );

  const toInsert = catalog
    .filter((c) => !have.has(`${c.name.trim().toLowerCase()}|${c.category}`))
    .map((c) => ({
      property_id: pid,
      name: c.name,
      category: c.category,
      unit: c.unit || 'each',
      current_stock: 0,
      par_level: c.suggestedPar ?? 0,
      // cents → dollars for the dollars-based inventory.unit_cost column
      unit_cost: c.suggestedUnitCostCents == null ? null : c.suggestedUnitCostCents / 100,
      vendor_name: c.defaultVendorName ?? null,
    }));

  if (toInsert.length === 0) return { imported: 0, skipped: catalog.length };

  const { error: insErr } = await supabaseAdmin.from('inventory').insert(toInsert);
  if (insErr) {
    log.error('[ordering] importCatalog: insert failed', { pid, err: insErr.message });
    throw insErr;
  }
  return { imported: toInsert.length, skipped: catalog.length - toInsert.length };
}

// ── Purchase orders ─────────────────────────────────────────────────────────

// Hydrate a set of PO header rows with their lines + the vendor email.
async function hydratePurchaseOrders(
  headers: Record<string, unknown>[],
): Promise<PurchaseOrder[]> {
  if (headers.length === 0) return [];
  const poIds = headers.map((h) => String(h.id));
  const vendorIds = [
    ...new Set(headers.map((h) => h.vendor_id).filter((v): v is string => typeof v === 'string')),
  ];

  const [{ data: lineRows, error: lineErr }, vendorEmailById] = await Promise.all([
    supabaseAdmin
      .from('purchase_order_lines')
      .select('*')
      .in('purchase_order_id', poIds)
      .order('created_at', { ascending: true }),
    (async () => {
      const map = new Map<string, string | null>();
      if (vendorIds.length === 0) return map;
      const { data } = await supabaseAdmin
        .from('vendors')
        .select('id, email')
        .in('id', vendorIds);
      for (const v of data ?? []) {
        map.set(String((v as { id: string }).id), ((v as { email: string | null }).email) ?? null);
      }
      return map;
    })(),
  ]);
  if (lineErr) {
    log.error('[ordering] hydratePurchaseOrders: lines read failed', { err: lineErr.message });
    throw lineErr;
  }

  const linesByPo = new Map<string, PurchaseOrderLine[]>();
  for (const r of lineRows ?? []) {
    const line = fromLineRow(r as Record<string, unknown>);
    const arr = linesByPo.get(line.purchaseOrderId) ?? [];
    arr.push(line);
    linesByPo.set(line.purchaseOrderId, arr);
  }

  return headers.map((h) =>
    fromPoRow(
      h,
      linesByPo.get(String(h.id)) ?? [],
      h.vendor_id ? vendorEmailById.get(String(h.vendor_id)) ?? null : null,
    ),
  );
}

export async function listPurchaseOrders(pid: string, limit = 200): Promise<PurchaseOrder[]> {
  const { data, error } = await supabaseAdmin
    .from('purchase_orders')
    .select('*')
    .eq('property_id', pid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    log.error('[ordering] listPurchaseOrders failed', { pid, err: error.message });
    throw error;
  }
  return hydratePurchaseOrders((data ?? []) as Record<string, unknown>[]);
}

export async function getPurchaseOrder(pid: string, id: string): Promise<PurchaseOrder | null> {
  const { data, error } = await supabaseAdmin
    .from('purchase_orders')
    .select('*')
    .eq('id', id)
    .eq('property_id', pid)
    .maybeSingle();
  if (error) {
    log.error('[ordering] getPurchaseOrder failed', { pid, id, err: error.message });
    throw error;
  }
  if (!data) return null;
  const [po] = await hydratePurchaseOrders([data as Record<string, unknown>]);
  return po ?? null;
}

// Insert a PO header with a per-property po_number, retrying on the unique
// (property_id, po_number) constraint so concurrent creates don't collide.
async function insertPoHeader(
  pid: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { count } = await supabaseAdmin
      .from('purchase_orders')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', pid);
    const candidate = `PO-${String((count ?? 0) + 1 + attempt).padStart(5, '0')}`;
    const { data, error } = await supabaseAdmin
      .from('purchase_orders')
      .insert({ ...fields, property_id: pid, po_number: candidate })
      .select('*')
      .single();
    if (!error) return data as Record<string, unknown>;
    if (error.code === '23505') {
      lastErr = error;
      continue; // po_number collision — bump and retry
    }
    log.error('[ordering] insertPoHeader failed', { pid, err: error.message });
    throw error;
  }
  log.error('[ordering] insertPoHeader exhausted retries', { pid });
  throw lastErr ?? new Error('could not allocate a PO number');
}

// Stamp each ordered item's last_ordered_at (+ vendor / unit cost) so the
// reorder UI shows "ordered N days ago" — mirrors addInventoryOrder's stamp.
// Non-fatal: a failed stamp never blocks the order.
async function stampOrderedItems(pid: string, lines: CartLineInput[], vendorName: string | null): Promise<void> {
  const nowIso = new Date().toISOString();
  await Promise.all(
    lines
      .filter((l) => l.itemId)
      .map(async (l) => {
        const stamp: Record<string, unknown> = { last_ordered_at: nowIso };
        if (vendorName) stamp.vendor_name = vendorName;
        if (l.unitCostCents > 0) stamp.unit_cost = l.unitCostCents / 100; // cents → dollars
        // Scope by property_id — supabaseAdmin bypasses RLS, so without this a
        // cart line carrying another hotel's inventory UUID would overwrite that
        // hotel's vendor/cost/last_ordered_at. A foreign itemId now matches 0
        // rows (silent no-op). (Security audit 2026-06-18.)
        const { error } = await supabaseAdmin
          .from('inventory')
          .update(stamp)
          .eq('id', l.itemId!)
          .eq('property_id', pid)
          .is('archived_at', null);
        if (error) {
          log.error('[ordering] stampOrderedItems failed (non-fatal)', {
            itemId: l.itemId,
            err: error.message,
          });
        }
      }),
  );
}

// Create one purchase order PER VENDOR from the reorder cart. Status follows
// Orders start as 'draft' (ready to send); the client then emails each vendor
// that has an address on file.
export async function createPurchaseOrders(
  pid: string,
  accountId: string,
  cartLines: CartLineInput[],
): Promise<{ orders: PurchaseOrder[] }> {
  const lines = cartLines.filter((l) => l.qtyOrdered > 0);
  if (lines.length === 0) return { orders: [] };

  const status: OrderStatus = 'draft';

  // Resolve vendor records once for the whole property (id + name → record).
  const vendors = await listVendors(pid, true);
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const vendorByName = new Map(vendors.map((v) => [v.name.trim().toLowerCase(), v]));

  // Group cart lines by vendor. Key precedence: explicit vendorId, else
  // normalized vendorName, else a single "unassigned" bucket.
  const groups = new Map<string, { vendor: Vendor | null; nameSnapshot: string | null; lines: CartLineInput[] }>();
  for (const l of lines) {
    let vendor: Vendor | null = null;
    if (l.vendorId && vendorById.has(l.vendorId)) vendor = vendorById.get(l.vendorId)!;
    else if (l.vendorName && vendorByName.has(l.vendorName.trim().toLowerCase())) {
      vendor = vendorByName.get(l.vendorName.trim().toLowerCase())!;
    }
    const nameSnapshot = vendor?.name ?? (l.vendorName?.trim() || null);
    const key = vendor?.id ?? (nameSnapshot ? `name:${nameSnapshot.toLowerCase()}` : '__unassigned__');
    const g = groups.get(key) ?? { vendor, nameSnapshot, lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }

  const created: PurchaseOrder[] = [];
  for (const g of groups.values()) {
    const subtotalCents = g.lines.reduce(
      (s, l) => s + Math.round(l.unitCostCents) * l.qtyOrdered,
      0,
    );
    const header = await insertPoHeader(pid, {
      vendor_id: g.vendor?.id ?? null,
      vendor_name_snapshot: g.nameSnapshot,
      status,
      subtotal_cents: subtotalCents,
      created_by: accountId,
    });
    const poId = String(header.id);

    const lineRows = g.lines.map((l) => ({
      purchase_order_id: poId,
      item_id: l.itemId,
      description: l.description,
      qty_ordered: l.qtyOrdered,
      unit_cost_cents: Math.round(l.unitCostCents),
      qty_received: 0,
    }));
    const { error: lineErr } = await supabaseAdmin.from('purchase_order_lines').insert(lineRows);
    if (lineErr) {
      log.error('[ordering] createPurchaseOrders: line insert failed', { poId, err: lineErr.message });
      throw lineErr;
    }

    await stampOrderedItems(pid, g.lines, g.nameSnapshot);

    const full = await getPurchaseOrder(pid, poId);
    if (full) created.push(full);
  }

  return { orders: created };
}

// Stamp a PO sent (status → 'sent', sent_at, sent_to_email). The email itself
// is fired by the route via src/lib/ordering/email.ts BEFORE calling this, so a
// failed email never flips the status. Guarded by the status state machine:
// only from 'draft' (a 'sent' order may be re-sent — re-emailing is allowed).
export async function markPurchaseOrderSent(
  pid: string,
  id: string,
  toEmail: string,
): Promise<{ ok: true; order: PurchaseOrder } | { ok: false; reason: string }> {
  const po = await getPurchaseOrder(pid, id);
  if (!po) return { ok: false, reason: 'not_found' };
  if (!['draft', 'sent'].includes(po.status)) {
    return { ok: false, reason: `cannot send an order in status "${po.status}"` };
  }
  const { error } = await supabaseAdmin
    .from('purchase_orders')
    .update({
      status: 'sent',
      sent_at: po.sentAt ?? new Date().toISOString(),
      sent_to_email: toEmail,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('property_id', pid);
  if (error) {
    log.error('[ordering] markPurchaseOrderSent failed', { pid, id, err: error.message });
    throw error;
  }
  const order = await getPurchaseOrder(pid, id);
  return order ? { ok: true, order } : { ok: false, reason: 'not_found' };
}

// Receive deliveries against a PO. qtyReceived per line is a CUMULATIVE TARGET
// (the new total received), clamped to [0, qty_ordered]. Migration 0312 makes
// the database authoritative for the delta: it locks each line, computes
// target - CURRENT qty_received, increments stock, appends the delivery ledger,
// and updates the PO status in one transaction. The caller never supplies a
// trusted delta or item id, so concurrent retries of the same target are true
// no-ops instead of double receipts.
export async function receivePurchaseOrder(
  pid: string,
  id: string,
  receiveLines: ReceiveLineInput[],
): Promise<
  | { ok: true; order: PurchaseOrder; shortLines: { lineId: string; ordered: number; received: number }[] }
  | { ok: false; reason: string }
> {
  const po = await getPurchaseOrder(pid, id);
  if (!po) return { ok: false, reason: 'not_found' };
  if (po.status === 'cancelled') return { ok: false, reason: 'order is cancelled' };

  const lineById = new Map(po.lines.map((l) => [l.id, l]));
  const targets = new Map<string, number>();
  for (const rl of receiveLines) {
    const line = lineById.get(rl.lineId);
    if (!line) continue; // ignore lines that don't belong to this PO
    const clamped = Math.max(0, Math.min(rl.qtyReceived, line.qtyOrdered));
    targets.set(rl.lineId, clamped);
  }

  const rpcLines = [...targets].map(([lineId, target]) => ({
    line_id: lineId,
    target_qty: target,
  }));

  // Apply line totals, stock increments, ledger rows, and PO status atomically.
  // If this throws, nothing moved and the exact request is safely retryable.
  if (rpcLines.length > 0) {
    const { error: rpcErr } = await supabaseAdmin.rpc('staxis_receive_po_lines_v2', {
      p_property_id: pid,
      p_po_id: id,
      p_lines: rpcLines,
    });
    if (rpcErr) {
      log.error('[ordering] receive: atomic apply failed', { id, err: rpcErr.message });
      throw rpcErr;
    }
  }

  const order = await getPurchaseOrder(pid, id);
  if (!order) return { ok: false, reason: 'not_found' };
  const shortLines = order.lines
    .filter((l) => l.qtyReceived < l.qtyOrdered)
    .map((l) => ({ lineId: l.id, ordered: l.qtyOrdered, received: l.qtyReceived }));
  return { ok: true, order, shortLines };
}

// ── Cross-property spend rollup (Phase E) ───────────────────────────────────
// Reads the EXISTING dollars-based inventory_orders ledger across all the
// caller's properties and rolls it up per property / vendor / category, in
// CENTS. Category is resolved by joining inventory by item_id (items may be
// deleted → 'Uncategorized').
export async function spendRollup(
  propertyIds: string[],
  fromIso: string,
  toIso: string,
): Promise<SpendRollup> {
  const empty: SpendRollup = {
    fromIso,
    toIso,
    totalCents: 0,
    byProperty: [],
    byVendor: [],
    byCategory: [],
  };
  if (propertyIds.length === 0) return empty;

  const [{ data: orders, error: ordErr }, { data: props }, { data: items }] = await Promise.all([
    supabaseAdmin
      .from('inventory_orders')
      .select('property_id, item_id, vendor_name, quantity, unit_cost, total_cost, received_at')
      .in('property_id', propertyIds)
      .gte('received_at', fromIso)
      .lte('received_at', toIso),
    supabaseAdmin.from('properties').select('id, name').in('id', propertyIds),
    supabaseAdmin.from('inventory').select('id, category').in('property_id', propertyIds),
  ]);
  if (ordErr) {
    log.error('[ordering] spendRollup failed', { err: ordErr.message });
    throw ordErr;
  }

  const propName = new Map((props ?? []).map((p) => [String((p as { id: string }).id), String((p as { name: string }).name ?? 'Property')]));
  const itemCat = new Map((items ?? []).map((i) => [String((i as { id: string }).id), String((i as { category: string }).category ?? 'housekeeping')]));

  const byProp = new Map<string, SpendRollupRow>();
  const byVendor = new Map<string, SpendRollupRow>();
  const byCat = new Map<string, SpendRollupRow>();
  let totalCents = 0;

  const bump = (map: Map<string, SpendRollupRow>, key: string, label: string, cents: number) => {
    const row = map.get(key) ?? { key, label, spentCents: 0, orderCount: 0 };
    row.spentCents += cents;
    row.orderCount += 1;
    map.set(key, row);
  };

  for (const o of orders ?? []) {
    const r = o as {
      property_id: string;
      item_id: string | null;
      vendor_name: string | null;
      quantity: number | null;
      unit_cost: number | null;
      total_cost: number | null;
    };
    // dollars → cents (total_cost preferred; fall back to unit_cost * qty)
    const dollars =
      r.total_cost != null
        ? Number(r.total_cost)
        : r.unit_cost != null
          ? Number(r.unit_cost) * Number(r.quantity ?? 0)
          : 0;
    const cents = Math.round(dollars * 100);
    if (cents <= 0) continue;
    totalCents += cents;

    const pid = String(r.property_id);
    bump(byProp, pid, propName.get(pid) ?? 'Property', cents);

    const vendor = (r.vendor_name?.trim() || 'Unassigned');
    bump(byVendor, vendor.toLowerCase(), vendor, cents);

    const cat = r.item_id ? itemCat.get(String(r.item_id)) ?? 'Uncategorized' : 'Uncategorized';
    bump(byCat, cat, cat, cents);
  }

  const sortDesc = (a: SpendRollupRow, b: SpendRollupRow) => b.spentCents - a.spentCents;
  return {
    fromIso,
    toIso,
    totalCents,
    byProperty: [...byProp.values()].sort(sortDesc),
    byVendor: [...byVendor.values()].sort(sortDesc),
    byCategory: [...byCat.values()].sort(sortDesc),
  };
}
