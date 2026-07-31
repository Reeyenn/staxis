// ═══════════════════════════════════════════════════════════════════════════
// Inventory vendors — server data layer (service-role).
//
// Every function here runs with supabaseAdmin (bypasses RLS) and is reached
// ONLY from /api/inventory/* routes behind requireOrderingAccess. The vendors
// table (migration 0246) is service-role-only.
//
// 2026-07-18: the purchase-order data layer (catalog, create/send/receive
// orders, spend rollup) was removed with the ordering flow — every hotel
// orders differently and the flow is being redesigned as a per-hotel
// workflow. Vendors survive because inventory items link to a vendor record.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type {
  BucketKey,
  OrderCandidate,
  OrderMethod,
  Vendor,
  VendorCategoryLink,
  VendorReviewState,
  VendorSuggestion,
  VendorSuggestionSource,
} from './types';
import { bucketKeyForItem, looksLikePropertyItself } from './resolve';

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
    orderMethod: (r.order_method as OrderMethod | null) ?? null,
    websiteUrl: (r.website_url as string | null) ?? null,
    knowledgeContactId: (r.knowledge_contact_id as string | null) ?? null,
    // Defaulting a row with no review_state to 'confirmed' matches the column
    // default and the reason for it: every vendor that predates this feature
    // was typed by a human. It also keeps the app readable if it deploys
    // before the migration is applied by hand.
    reviewState: ((r.review_state as string | null) ?? 'confirmed') as VendorReviewState,
    suggestedFrom: (r.suggested_from as VendorSuggestionSource | null) ?? null,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

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

export interface InventoryAuditActor {
  userId: string;
  name: string | null;
}

export async function createVendor(
  pid: string,
  input: VendorInput,
  actor: InventoryAuditActor,
): Promise<Vendor> {
  // The RPC writes the vendor and its immutable inventory audit event in one
  // transaction. A direct service-role insert would lose the end-user actor.
  const { data, error } = await supabaseAdmin.rpc('staxis_create_inventory_vendor', {
    p_property_id: pid,
    p_name: input.name,
    p_email: input.email ?? null,
    p_phone: input.phone ?? null,
    p_account_number: input.accountNumber ?? null,
    p_notes: input.notes ?? null,
    p_is_active: input.isActive ?? true,
    p_actor_id: actor.userId,
    p_actor_name: actor.name,
  });
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
  actor: InventoryAuditActor,
): Promise<Vendor | null> {
  const rpcPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) rpcPatch.name = patch.name;
  if (patch.email !== undefined) rpcPatch.email = patch.email;
  if (patch.phone !== undefined) rpcPatch.phone = patch.phone;
  if (patch.accountNumber !== undefined) rpcPatch.accountNumber = patch.accountNumber;
  if (patch.notes !== undefined) rpcPatch.notes = patch.notes;
  if (patch.isActive !== undefined) rpcPatch.isActive = patch.isActive;

  const { data, error } = await supabaseAdmin.rpc('staxis_update_inventory_vendor', {
    p_property_id: pid,
    p_vendor_id: vendorId,
    p_patch: rpcPatch,
    p_actor_id: actor.userId,
    p_actor_name: actor.name,
  });
  if (error) {
    log.error('[ordering] updateVendor failed', { pid, vendorId, err: error.message });
    throw error;
  }
  return data ? fromVendorRow(data as Record<string, unknown>) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ordering Manager (2026-07-28)
//
// The identity fields above (name/email/phone/account/notes/active) keep going
// through the two RPCs, which write the vendor and its immutable inventory
// audit event in one transaction. The ordering-specific columns added by 0377
// are written directly here instead of widening those RPC signatures, and the
// split is deliberate: the RPC's audit contract is about WHO changed a
// supplier record, while "they take orders by phone" is a routing detail with
// no money and no external effect. A failed second write leaves the vendor
// with order_method NULL, which is a real, rendered, self-correcting state
// (the missing-piece chip) rather than a corruption.
// ═══════════════════════════════════════════════════════════════════════════

/** Fields on a vendor that only the Ordering screen sets. */
export interface VendorOrderingPatch {
  orderMethod?: OrderMethod | null;
  websiteUrl?: string | null;
  reviewState?: VendorReviewState;
  knowledgeContactId?: string | null;
  suggestedFrom?: VendorSuggestionSource | null;
}

export async function updateVendorOrdering(
  pid: string,
  vendorId: string,
  patch: VendorOrderingPatch,
): Promise<boolean> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.orderMethod !== undefined) row.order_method = patch.orderMethod;
  // Clearing the method must clear the URL with it, or the paired CHECK in
  // 0377 rejects the update and the manager sees an opaque failure.
  if (patch.orderMethod !== undefined && patch.orderMethod !== 'website') row.website_url = null;
  if (patch.websiteUrl !== undefined) row.website_url = patch.websiteUrl;
  if (patch.reviewState !== undefined) row.review_state = patch.reviewState;
  if (patch.knowledgeContactId !== undefined) row.knowledge_contact_id = patch.knowledgeContactId;
  if (patch.suggestedFrom !== undefined) row.suggested_from = patch.suggestedFrom;

  const { error, count } = await supabaseAdmin
    .from('vendors')
    .update(row, { count: 'exact' })
    .eq('id', vendorId)
    .eq('property_id', pid);
  if (error) {
    log.error('[ordering] updateVendorOrdering failed', { pid, vendorId, err: error.message });
    throw error;
  }
  return (count ?? 0) > 0;
}

// ─── Vendor ↔ category map ─────────────────────────────────────────────────

export async function listVendorCategoryMap(pid: string): Promise<VendorCategoryLink[]> {
  const { data, error } = await supabaseAdmin
    .from('vendor_category_map')
    .select('bucket_key, vendor_id')
    .eq('property_id', pid);
  if (error) {
    log.error('[ordering] listVendorCategoryMap failed', { pid, err: error.message });
    throw error;
  }
  return (data ?? []).map((r) => ({
    bucketKey: String((r as Record<string, unknown>).bucket_key) as BucketKey,
    vendorId: String((r as Record<string, unknown>).vendor_id),
  }));
}

/**
 * Point a category at a vendor, or clear it when vendorId is null.
 *
 * Upsert on the (property_id, bucket_key) unique index — remapping a category
 * REPLACES the old link rather than adding a second one, which is what makes
 * "who supplies this item?" a single-valued question.
 */
export async function setVendorCategory(
  pid: string,
  bucketKey: BucketKey,
  vendorId: string | null,
  actor: InventoryAuditActor,
): Promise<void> {
  if (vendorId == null) {
    const { error } = await supabaseAdmin
      .from('vendor_category_map')
      .delete()
      .eq('property_id', pid)
      .eq('bucket_key', bucketKey);
    if (error) {
      log.error('[ordering] setVendorCategory clear failed', { pid, bucketKey, err: error.message });
      throw error;
    }
    return;
  }
  const { error } = await supabaseAdmin
    .from('vendor_category_map')
    .upsert(
      {
        property_id: pid,
        bucket_key: bucketKey,
        vendor_id: vendorId,
        created_by: actor.userId,
        created_by_name: actor.name,
      },
      { onConflict: 'property_id,bucket_key' },
    );
  if (error) {
    log.error('[ordering] setVendorCategory failed', { pid, bucketKey, err: error.message });
    throw error;
  }
}

/** The per-item override — one tap on a card whose vendor is wrong. */
export async function setItemVendorOverride(
  pid: string,
  itemId: string,
  vendorId: string | null,
): Promise<boolean> {
  const { error, count } = await supabaseAdmin
    .from('inventory')
    .update({ vendor_id: vendorId }, { count: 'exact' })
    .eq('id', itemId)
    .eq('property_id', pid);
  if (error) {
    log.error('[ordering] setItemVendorOverride failed', { pid, itemId, err: error.message });
    throw error;
  }
  return (count ?? 0) > 0;
}

// ─── Last invoice price ────────────────────────────────────────────────────

export interface LastPrice {
  /** INTEGER CENTS. inventory_orders.unit_cost is DOLLARS — converted here,
   *  which is the single boundary between the two conventions on this path. */
  cents: number;
  at: string;
}

/**
 * The most recent price actually seen on a receipt, per item.
 *
 * This is the ONLY source of a dollar figure anywhere in this feature. There
 * is no fallback to inventory.unit_cost: that column is a manager-typed
 * estimate that nothing refreshes, and presenting it beside "from your last
 * invoice" would make a typed guess look like a receipt. An item missing from
 * this map renders a dash, and the order card counts it in itemsWithoutPrice.
 */
export async function lastInvoicePrices(
  pid: string,
  itemIds: readonly string[],
): Promise<Map<string, LastPrice>> {
  const out = new Map<string, LastPrice>();
  if (itemIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('inventory_orders')
    .select('item_id, unit_cost, received_at')
    .eq('property_id', pid)
    .eq('entry_kind', 'receipt')
    .in('item_id', itemIds as string[])
    .not('unit_cost', 'is', null)
    .order('received_at', { ascending: false })
    .limit(4000);
  if (error) {
    log.error('[ordering] lastInvoicePrices failed', { pid, err: error.message });
    return out; // A missing price is a supported state; a failed read degrades to it.
  }
  for (const raw of data ?? []) {
    const r = raw as Record<string, unknown>;
    const id = r.item_id == null ? '' : String(r.item_id);
    if (!id || out.has(id)) continue; // ordered desc — first hit is the latest
    const dollars = Number(r.unit_cost);
    if (!Number.isFinite(dollars) || dollars < 0) continue;
    out.set(id, { cents: Math.round(dollars * 100), at: String(r.received_at ?? '') });
  }
  return out;
}

// ─── Pre-built vendor suggestions ──────────────────────────────────────────

function normalizeVendorName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the suggestion list from what the database already holds.
 *
 * TWO SOURCES, both things a human already typed or photographed:
 *   • knowledge_contacts where category='vendor' — the contacts directory the
 *     Knows tab owns. We LINK to the row; we do not copy the phone and email
 *     into vendors, so the contact stays the one place to edit them.
 *   • scanned-invoice vendor names on the receipt ledger, with the categories
 *     their items landed in as bucket hints.
 *
 * Anything already present as a vendor row — matched on normalized name or on
 * the linked contact id — is EXCLUDED, so the screen never asks about a
 * supplier it has already been told about. That exclusion is the whole
 * "never re-ask" rule in one filter.
 *
 * The hotel's OWN name is excluded too (looksLikePropertyItself): the invoice
 * scanner sometimes reads the bill-to — the hotel — as vendor_name, and a
 * screen that suggests the hotel supplies itself reads as broken. The filter
 * runs over both sources so no path can offer it.
 */
export async function buildVendorSuggestions(
  pid: string,
  existing: readonly Vendor[],
): Promise<VendorSuggestion[]> {
  const takenNames = new Set(existing.map((v) => normalizeVendorName(v.name)));
  const takenContacts = new Set(
    existing.map((v) => v.knowledgeContactId).filter((v): v is string => !!v),
  );
  const out = new Map<string, VendorSuggestion>();

  const { data: propertyRow } = await supabaseAdmin
    .from('properties')
    .select('name')
    .eq('id', pid)
    .maybeSingle();
  const propertyName = propertyRow
    ? String((propertyRow as Record<string, unknown>).name ?? '')
    : '';

  // ── Source 1: the contacts directory ──
  const { data: contacts, error: contactErr } = await supabaseAdmin
    .from('knowledge_contacts')
    .select('id, name, company, phone, email')
    .eq('property_id', pid)
    .eq('category', 'vendor')
    .limit(200);
  if (contactErr) {
    log.error('[ordering] suggestion contacts read failed', { pid, err: contactErr.message });
  }
  for (const raw of contacts ?? []) {
    const r = raw as Record<string, unknown>;
    const id = String(r.id);
    // The supplier's trading name is what appears on an invoice, so `company`
    // leads and the contact's personal name is the fallback.
    const name = String(r.company ?? '').trim() || String(r.name ?? '').trim();
    if (!name) continue;
    if (takenContacts.has(id) || takenNames.has(normalizeVendorName(name))) continue;
    if (looksLikePropertyItself(name, propertyName)) continue;
    out.set(`contact:${id}`, {
      key: `contact:${id}`,
      name,
      source: 'contact',
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      knowledgeContactId: id,
      seenOnInvoices: 0,
      bucketHints: [],
    });
  }

  // ── Source 2: scanned invoices ──
  const { data: receipts, error: receiptErr } = await supabaseAdmin
    .from('inventory_orders')
    .select('vendor_name, item_id')
    .eq('property_id', pid)
    .eq('entry_kind', 'receipt')
    .not('vendor_name', 'is', null)
    .order('received_at', { ascending: false })
    .limit(2000);
  if (receiptErr) {
    log.error('[ordering] suggestion receipts read failed', { pid, err: receiptErr.message });
  }

  const byName = new Map<string, { name: string; count: number; itemIds: Set<string> }>();
  for (const raw of receipts ?? []) {
    const r = raw as Record<string, unknown>;
    const name = String(r.vendor_name ?? '').trim();
    if (!name) continue;
    const key = normalizeVendorName(name);
    let entry = byName.get(key);
    if (!entry) {
      entry = { name, count: 0, itemIds: new Set() };
      byName.set(key, entry);
    }
    entry.count += 1;
    if (r.item_id) entry.itemIds.add(String(r.item_id));
  }

  // Bucket hints need each item's category, so resolve the union in one read.
  const hintItemIds = [...new Set([...byName.values()].flatMap((e) => [...e.itemIds]))];
  const bucketByItem = new Map<string, BucketKey>();
  if (hintItemIds.length > 0) {
    const { data: items } = await supabaseAdmin
      .from('inventory')
      .select('id, category, custom_category_id')
      .eq('property_id', pid)
      .in('id', hintItemIds.slice(0, 1000));
    for (const raw of items ?? []) {
      const r = raw as Record<string, unknown>;
      bucketByItem.set(
        String(r.id),
        bucketKeyForItem({
          category: (r.category as string | null) ?? null,
          customCategoryId: (r.custom_category_id as string | null) ?? null,
        }),
      );
    }
  }

  for (const [key, entry] of byName) {
    if (takenNames.has(key)) continue;
    // The scanner read this name off a photographed page. If it is the hotel
    // itself (the bill-to, not the counterparty), it is not a supplier.
    if (looksLikePropertyItself(entry.name, propertyName)) continue;
    const hints = new Set<BucketKey>();
    for (const itemId of entry.itemIds) {
      const bucket = bucketByItem.get(itemId);
      if (bucket) hints.add(bucket);
    }
    const suggestionKey = `invoice:${key}`;
    const alreadyFromContact = [...out.values()].find(
      (s) => normalizeVendorName(s.name) === key,
    );
    if (alreadyFromContact) {
      // The same supplier is in the contacts AND on invoices. Keep the contact
      // suggestion (it carries the link and the contact details) and fold the
      // invoice evidence into it rather than offering the manager the same
      // vendor twice.
      alreadyFromContact.seenOnInvoices = entry.count;
      alreadyFromContact.bucketHints = [...hints];
      continue;
    }
    out.set(suggestionKey, {
      key: suggestionKey,
      name: entry.name,
      source: 'invoice',
      email: null,
      phone: null,
      knowledgeContactId: null,
      seenOnInvoices: entry.count,
      bucketHints: [...hints],
    });
  }

  return [...out.values()].sort((a, b) => {
    if (a.seenOnInvoices !== b.seenOnInvoices) return b.seenOnInvoices - a.seenOnInvoices;
    return a.name.localeCompare(b.name);
  });
}

// ─── Purchase orders ───────────────────────────────────────────────────────

/**
 * A human-readable, per-property order number.
 *
 * Date plus four random hex rather than a running count: a count would need a
 * read-then-write against the unique index, which two managers ordering at the
 * same moment would race on. The number only has to be unique per hotel and
 * quotable over the phone, and this is both.
 */
export function mintPoNumber(now: Date = new Date()): string {
  const y = String(now.getUTCFullYear()).slice(2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase();
  return `PO-${y}${m}${d}-${suffix}`;
}

export interface RecordedOrderLine {
  itemId: string;
  description: string;
  qty: number;
  unitCostCents: number | null;
}

export interface RecordOrderInput {
  vendorId: string | null;
  vendorName: string | null;
  placedVia: OrderMethod;
  lines: readonly RecordedOrderLine[];
  subtotalCents: number;
  sentToEmail: string | null;
  notes: string | null;
  /** Supplied by the email path, which must mint the number BEFORE rendering
   *  so the document the vendor receives and the row we keep carry the same
   *  reference. Omitted elsewhere and minted here. */
  poNumber?: string;
  /** 'sent' (the default) is for orders already placed by the time we hear
   *  about them: a store run, a phone call, a website checkout the manager did
   *  themselves. The email path writes 'draft' first and promotes the row with
   *  markOrderSent only once the mail is actually accepted. See the note on
   *  recordPlacedOrder. */
  status?: 'draft' | 'sent';
}

/**
 * Write the order and stamp its items as ordered.
 *
 * DELIBERATELY DOES NOT TOUCH `inventory_orders`. That table is the RECEIPT
 * ledger — a row in it means stock physically arrived and money was spent, and
 * it feeds the month's purchases figure. An order that has been placed is not
 * a delivery; writing one there would inflate spend for goods nobody has, and
 * would double-count when the invoice is later scanned. The existing
 * `adjust_stock` tool carries the same warning for the same reason. Receiving
 * stays owned by the delivery / invoice-scan path.
 *
 * `inventory.last_ordered_at` is what stops an item reappearing on tomorrow's
 * list, and it is the same field the agent's markOrdered already stamps.
 *
 * A 'draft' order is deliberately half-written: no sent_at, no recipient, and
 * NO last_ordered_at stamp. That is what keeps the items on the ordering list
 * so the manager can retry, and it is why the email path can safely write the
 * row before it knows whether the mail will go through.
 */
export async function recordPlacedOrder(
  pid: string,
  input: RecordOrderInput,
  actor: InventoryAuditActor,
): Promise<{ id: string; poNumber: string } | null> {
  const poNumber = input.poNumber ?? mintPoNumber();
  const status = input.status ?? 'sent';
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('purchase_orders')
    .insert({
      property_id: pid,
      po_number: poNumber,
      vendor_id: input.vendorId,
      vendor_name_snapshot: input.vendorName,
      status,
      placed_via: input.placedVia,
      subtotal_cents: Math.max(0, Math.round(input.subtotalCents)),
      notes: input.notes,
      created_by: actor.userId,
      created_by_name: actor.name,
      sent_at: status === 'sent' ? nowIso : null,
      sent_to_email: status === 'sent' ? input.sentToEmail : null,
    })
    .select('id, po_number')
    .maybeSingle();
  if (error || !data) {
    log.error('[ordering] recordPlacedOrder failed', { pid, err: error?.message });
    throw error ?? new Error('purchase order insert returned no row');
  }
  const orderId = String((data as Record<string, unknown>).id);

  if (input.lines.length > 0) {
    const { error: lineError } = await supabaseAdmin.from('purchase_order_lines').insert(
      input.lines.map((line) => ({
        purchase_order_id: orderId,
        item_id: line.itemId,
        description: line.description,
        qty_ordered: line.qty,
        unit_cost_cents: line.unitCostCents == null ? 0 : Math.max(0, Math.round(line.unitCostCents)),
      })),
    );
    if (lineError) {
      log.error('[ordering] recordPlacedOrder lines failed', { pid, orderId, err: lineError.message });
      throw lineError;
    }
  }

  if (status === 'sent') {
    await stampOrdered(pid, orderId, input.lines.map((l) => l.itemId), nowIso);
  }

  return { id: orderId, poNumber: String((data as Record<string, unknown>).po_number ?? poNumber) };
}

/**
 * Promote a draft order to sent, once the email has actually been accepted.
 *
 * The second half of the email path's two-step. The row and its lines already
 * exist by the time this runs, so a crash here loses the stamp and the sent_at
 * but never the order itself, and the manager can see what was attempted.
 */
export async function markOrderSent(
  pid: string,
  orderId: string,
  input: { sentToEmail: string | null; itemIds: readonly string[] },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('purchase_orders')
    .update({ status: 'sent', sent_at: nowIso, sent_to_email: input.sentToEmail })
    .eq('id', orderId)
    .eq('property_id', pid);
  if (error) {
    // The vendor has the order. Saying it failed now would be a lie that gets
    // the same order sent twice, so this is logged and swallowed.
    log.error('[ordering] markOrderSent failed', { pid, orderId, err: error.message });
    return;
  }
  await stampOrdered(pid, orderId, input.itemIds, nowIso);
}

/** `inventory.last_ordered_at` is what keeps an item off tomorrow's list. It
 *  is a convenience, not the record of the order, so a failure here is logged
 *  and swallowed rather than reported as a failed order. */
async function stampOrdered(
  pid: string,
  orderId: string,
  itemIds: readonly string[],
  nowIso: string,
): Promise<void> {
  const ids = itemIds.filter(Boolean);
  if (ids.length === 0) return;
  const { error } = await supabaseAdmin
    .from('inventory')
    .update({ last_ordered_at: nowIso })
    .eq('property_id', pid)
    .in('id', ids);
  if (error) {
    log.error('[ordering] last_ordered_at stamp failed', { pid, orderId, err: error.message });
  }
}

// ─── The one-time welcome ──────────────────────────────────────────────────

export async function getIntroDismissedAt(pid: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('ordering_intro_dismissed_at, name')
    .eq('id', pid)
    .maybeSingle();
  if (error || !data) return null;
  return ((data as Record<string, unknown>).ordering_intro_dismissed_at as string | null) ?? null;
}

export async function dismissIntro(pid: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('properties')
    .update({ ordering_intro_dismissed_at: new Date().toISOString() })
    .eq('id', pid);
  if (error) {
    log.error('[ordering] dismissIntro failed', { pid, err: error.message });
    throw error;
  }
}

/** Order candidates re-exported for route typing convenience. */
export type { OrderCandidate };
