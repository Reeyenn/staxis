// ═══════════════════════════════════════════════════════════════════════════
// /api/inventory/ordering — the AI Ordering Manager's screen and its actions.
//
//   GET  ?pid=            → the whole state-aware payload (see OrderingState)
//   POST { pid, action }  → one of the eight actions below
//
// ONE route rather than eight. The repo is at 300+ routes for a single
// customer and "each addition looked harmless" is how it got there, so this
// surface is a single auth gate, a single rate-limit key and a single tenant
// boundary to reason about. The actions are discriminated by `action` and each
// one is small; splitting them would multiply the gate, not the logic.
//
// AUTH: requireOrderingAccess (owner / GM / admin, capability
// manage_inventory_orders, property-scoped, inventory section enabled) — the
// gate migration 0246 already built for exactly this surface. Every table
// touched here is service-role-only, so the browser never reads them
// directly; that is what keeps this off the RLS silent-empty-state path.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';

import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess, type OrderingAccess } from '@/lib/ordering/api-gate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { isUuid, validateString, validateUuid, isValidEmail } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  listVendors,
  createVendor,
  updateVendorOrdering,
  listVendorCategoryMap,
  setVendorCategory,
  setItemVendorOverride,
  lastInvoicePrices,
  buildVendorSuggestions,
  recordPlacedOrder,
  markOrderSent,
  mintPoNumber,
  getIntroDismissedAt,
  dismissIntro,
  openOrdersByItem,
  findRecentMatchingOrder,
  replaceDraftOrderLines,
  knowledgeContactBelongsToProperty,
} from '@/lib/ordering/db';
import { buildCandidate, rankCandidates, groupByVendor, blockReasonFor } from '@/lib/ordering/resolve';
import { sendPoEmail } from '@/lib/ordering/po-email';
import {
  ORDER_METHODS,
  type BucketKey,
  type BurnConfidence,
  type OrderCandidate,
  type OrderGroup,
  type OrderMethod,
  type Vendor,
  type VendorSuggestion,
} from '@/lib/ordering/types';
import {
  fetchDailyAverages,
  fetchMlPredictedRates,
  selectOrderingBurn,
  type BurnSource,
} from '@/lib/inventory-predictions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── The payload ────────────────────────────────────────────────────────────

interface CategoryOption {
  bucketKey: BucketKey;
  /** Built-in buckets carry a null label and are named by the UI in the
   *  viewer's language; a custom category's label is the hotel's own text. */
  label: string | null;
  itemCount: number;
}

export interface OrderingState {
  /** NULL means the welcome has never been dismissed → show it once. */
  introDismissedAt: string | null;
  /** False when the hotel has no inventory items at all — the empty state. */
  hasInventory: boolean;
  vendors: Vendor[];
  suggestions: VendorSuggestion[];
  categories: CategoryOption[];
  categoryMap: Array<{ bucketKey: BucketKey; vendorId: string }>;
  groups: OrderGroup[];
  /** How the burn rates were sourced, for the as-of/honesty line. */
  burnBasis: { source: string; daysOfData: number; mlItems: number };
}

/** BurnSource → the confidence vocabulary this feature exposes.
 *
 *  'fallback-60d' (par ÷ 60) collapses to 'thin' rather than being carried
 *  through by name: it is arithmetic on the par level dressed as a forecast,
 *  and the ordering screen must not be the surface that starts showing it as
 *  a rate. 'thin' and 'none' both render as a dash. */
function toConfidence(source: BurnSource): BurnConfidence {
  if (source === 'ml') return 'ml';
  if (source === 'rule-occupancy') return 'rule-occupancy';
  if (source === 'fallback-60d') return 'thin';
  return 'none';
}

async function loadState(pid: string): Promise<OrderingState> {
  const [introDismissedAt, vendors, categoryLinks] = await Promise.all([
    getIntroDismissedAt(pid),
    listVendors(pid),
    listVendorCategoryMap(pid),
  ]);

  const { data: itemRows, error: itemError } = await supabaseAdmin
    .from('inventory')
    .select(
      'id, name, unit, category, custom_category_id, current_stock, set_aside, par_level, '
      + 'vendor_id, vendor_name, usage_per_checkout, usage_per_stayover',
    )
    .eq('property_id', pid)
    .is('archived_at', null)
    .limit(2000);
  if (itemError) {
    log.error('[ordering] item read failed', { pid, err: itemError.message });
    throw itemError;
  }
  const items = (itemRows ?? []) as unknown as Array<Record<string, unknown>>;

  const [customCategories, averages, mlRates, suggestions] = await Promise.all([
    supabaseAdmin
      .from('inventory_custom_categories')
      .select('id, name, sort')
      .eq('property_id', pid)
      .order('sort', { ascending: true }),
    // supabaseAdmin, not the default anon client — see the note on the
    // `client` parameter in inventory-predictions.ts.
    fetchDailyAverages(pid, 14, supabaseAdmin),
    fetchMlPredictedRates(pid, supabaseAdmin),
    buildVendorSuggestions(pid, vendors),
  ]);

  const vendorsById = new Map(vendors.map((v) => [v.id, v]));
  const categoryMap = new Map<BucketKey, string>(
    categoryLinks.map((l) => [l.bucketKey, l.vendorId] as const),
  );

  const itemIds = items.map((r) => String(r.id));
  // One clock for the whole payload: the order-age judgement and the list it
  // filters must not be able to disagree with each other.
  const now = new Date();
  const [prices, openOrders] = await Promise.all([
    lastInvoicePrices(pid, itemIds),
    openOrdersByItem(pid, itemIds, now),
  ]);

  const candidates: OrderCandidate[] = [];
  const bucketCounts = new Map<BucketKey, number>();

  for (const row of items) {
    const id = String(row.id);
    const parLevel = Number(row.par_level ?? 0);
    const currentStock = Number(row.current_stock ?? 0);
    const setAside = Number(row.set_aside ?? 0);
    // Usable stock, the same rule the item cards use: units held back as
    // stained / awaiting repair are owned but cannot be put in a room, so
    // counting them would suppress a real shortage.
    const onHand = Math.max(0, currentStock - setAside);

    // selectOrderingBurn, not raw selectBurnRate: the rule-occupancy math here
    // must be the same pc·co + ps·so the item cards use, or the two surfaces
    // contradict each other AND unrelated items collapse onto one identical
    // weekly figure whenever their larger per-room rate matches. It also flags
    // a too-thin occupancy sample so the rate degrades to a caveat, matching
    // what the footer already tells the manager in that state.
    const burn = selectOrderingBurn(
      {
        id,
        usagePerCheckout: row.usage_per_checkout == null ? null : Number(row.usage_per_checkout),
        usagePerStayover: row.usage_per_stayover == null ? null : Number(row.usage_per_stayover),
        parLevel,
      },
      mlRates.get(id),
      averages,
    );

    const price = prices.get(id) ?? null;
    const candidate = buildCandidate(
      {
        itemId: id,
        name: String(row.name ?? ''),
        unit: String(row.unit ?? ''),
        onHand,
        par: parLevel,
        category: (row.category as string | null) ?? null,
        customCategoryId: (row.custom_category_id as string | null) ?? null,
        vendorId: (row.vendor_id as string | null) ?? null,
        vendorName: (row.vendor_name as string | null) ?? null,
        burnPerDay: burn.burnPerDay,
        burnConfidence: burn.thinSample ? 'thin' : toConfidence(burn.burnSource),
        lastPriceCents: price?.cents ?? null,
        lastPriceAt: price?.at ?? null,
        // An order already on its way takes the item off this list until the
        // delivery is scanned. Without it the screen asks for the same order
        // again tomorrow, which is the one thing that makes the list a chore
        // instead of an answer.
        openOrder: openOrders.get(id) ?? null,
      },
      categoryMap,
      vendorsById,
      now,
    );
    if (candidate) candidates.push(candidate);

    const bucket: BucketKey = row.custom_category_id
      ? `custom:${String(row.custom_category_id)}`
      : row.category === 'breakfast'
        ? 'breakfast'
        : 'general';
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
  }

  const categories: CategoryOption[] = [
    { bucketKey: 'general' as BucketKey, label: null, itemCount: bucketCounts.get('general') ?? 0 },
    { bucketKey: 'breakfast' as BucketKey, label: null, itemCount: bucketCounts.get('breakfast') ?? 0 },
    ...((customCategories.data ?? []) as Array<Record<string, unknown>>).map((c) => {
      const key = `custom:${String(c.id)}` as BucketKey;
      return { bucketKey: key, label: String(c.name ?? ''), itemCount: bucketCounts.get(key) ?? 0 };
    }),
  ];

  return {
    introDismissedAt,
    hasInventory: items.length > 0,
    vendors,
    suggestions,
    categories,
    categoryMap: categoryLinks,
    groups: groupByVendor(rankCandidates(candidates), vendorsById),
    burnBasis: {
      source: averages.source,
      daysOfData: averages.daysOfData,
      mlItems: mlRates.size,
    },
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireOrderingAccess(req, pid);
  if (!gate.ok) return gate.response;

  const rl = await checkAndIncrementRateLimit('inventory-ordering', gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const state = await loadState(gate.pid);
    return ok(state, { requestId: gate.requestId });
  } catch {
    return err('failed to load ordering', {
      requestId: gate.requestId,
      status: 500,
      code: 'load_failed',
    });
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

// MUST MATCH THE CHECK IN MIGRATION 0377 CHARACTER FOR CHARACTER. It used to
// be the looser `custom:[0-9a-f-]{36}`, which accepts 36 hex characters with
// no hyphens (and hyphens in any position). Those values passed this route and
// were then refused by the database, so a validation problem arrived as a 500
// — and in confirm_suggestion it arrived AFTER the vendor row had been
// written, leaving a half-done confirm behind. A route regex looser than the
// column's is not validation, it is a delayed crash.
const BUCKET_KEY_RE
  = /^(general|breakfast|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function parseBucketKey(raw: unknown): BucketKey | null {
  if (typeof raw !== 'string' || !BUCKET_KEY_RE.test(raw)) return null;
  return raw as BucketKey;
}

function parseOrderMethod(raw: unknown): OrderMethod | null {
  return typeof raw === 'string' && (ORDER_METHODS as readonly string[]).includes(raw)
    ? (raw as OrderMethod)
    : null;
}

function badRequest(gate: Extract<OrderingAccess, { ok: true }>, message: string): Response {
  return err(message, { requestId: gate.requestId, status: 400, code: 'validation_failed' });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('invalid json', { requestId: 'pre-auth', status: 400, code: 'validation_failed' });
  }

  const gate = await requireOrderingAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const action = typeof body.action === 'string' ? body.action : '';
  // The email send has its own, much tighter bucket: it is the only action
  // that leaves the building.
  const bucket = action === 'send_po' ? 'inventory-po-send' : 'inventory-ordering';
  const rl = await checkAndIncrementRateLimit(bucket, gate.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const actor = { userId: gate.userId, name: gate.name };

  try {
    switch (action) {
      // ── The one-time welcome ──
      case 'dismiss_intro': {
        await dismissIntro(gate.pid);
        return ok({ dismissed: true }, { requestId: gate.requestId });
      }

      // ── Turn a suggestion into hotel-asserted knowledge ──
      // The confirm tap is what promotes a guess to a fact. Nothing is stored
      // as a vendor until this runs, so an unconfirmed suggestion can never be
      // ordered from or cited.
      case 'confirm_suggestion': {
        const nameV = validateString(body.name, { label: 'name', max: 120, min: 1 });
        if (nameV.error) return badRequest(gate, nameV.error);

        const method = parseOrderMethod(body.orderMethod);
        if (body.orderMethod != null && !method) return badRequest(gate, 'invalid orderMethod');

        const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
        if (email && !isValidEmail(email)) return badRequest(gate, 'invalid email');

        const contactId = typeof body.knowledgeContactId === 'string' ? body.knowledgeContactId : null;
        if (contactId && !isUuid(contactId)) return badRequest(gate, 'invalid knowledgeContactId');

        // EVERYTHING THAT CAN REFUSE THIS CONFIRM RUNS BEFORE THE FIRST WRITE.
        // The category keys used to be parsed inside the loop that follows the
        // vendor insert, so a key this route accepted and the database refused
        // failed with the vendor already created and its categories not
        // applied. A confirm either happens or it does not.
        const rawBuckets = Array.isArray(body.bucketKeys) ? body.bucketKeys : [];
        const buckets: BucketKey[] = [];
        for (const raw of rawBuckets) {
          const key = parseBucketKey(raw);
          if (!key) return badRequest(gate, 'invalid bucketKey');
          buckets.push(key);
        }

        // The contact must be THIS hotel's. Nothing renders the link, so a
        // foreign id leaks no data, but it plants a cross-tenant reference and
        // turns the confirm into an existence oracle for another hotel's
        // contact ids. Checked here, before anything is written.
        if (contactId && !(await knowledgeContactBelongsToProperty(gate.pid, contactId))) {
          return badRequest(gate, 'invalid knowledgeContactId');
        }

        const vendor = await createVendor(
          gate.pid,
          {
            name: nameV.value as string,
            email,
            phone: typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null,
          },
          actor,
        );
        await updateVendorOrdering(gate.pid, vendor.id, {
          orderMethod: method,
          websiteUrl: method === 'website' && typeof body.websiteUrl === 'string'
            ? body.websiteUrl.trim() || null
            : null,
          reviewState: 'confirmed',
          knowledgeContactId: contactId,
          suggestedFrom: null,
        });

        // Categories offered pre-ticked in the confirm step are applied here,
        // which is what makes "one minute of setup" true: confirming Sysco and
        // ticking Breakfast is the entire mapping for every breakfast item.
        for (const key of buckets) {
          await setVendorCategory(gate.pid, key, vendor.id, actor);
        }
        return ok({ vendorId: vendor.id }, { requestId: gate.requestId, status: 201 });
      }

      // ── The missing piece: how do you order from them? ──
      case 'set_vendor_method': {
        const idV = validateUuid(body.vendorId, 'vendorId');
        if (idV.error) return badRequest(gate, idV.error);
        const method = parseOrderMethod(body.orderMethod);
        if (!method) return badRequest(gate, 'invalid orderMethod');
        let websiteUrl: string | null = null;
        if (method === 'website') {
          const raw = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : '';
          // A website vendor must carry a real http(s) URL: the card renders it
          // as a link the manager taps, and the DB pairs the two.
          if (!/^https?:\/\/\S+$/i.test(raw)) return badRequest(gate, 'websiteUrl must be an http(s) URL');
          if (raw.length > 500) return badRequest(gate, 'websiteUrl too long');
          websiteUrl = raw;
        }
        const found = await updateVendorOrdering(gate.pid, idV.value as string, {
          orderMethod: method,
          websiteUrl,
        });
        if (!found) return err('vendor not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
        return ok({ updated: true }, { requestId: gate.requestId });
      }

      // ── Map a category to a vendor (the one-minute setup) ──
      case 'set_category_vendor': {
        const key = parseBucketKey(body.bucketKey);
        if (!key) return badRequest(gate, 'invalid bucketKey');
        const rawVendor = body.vendorId;
        if (rawVendor !== null && !isUuid(rawVendor)) return badRequest(gate, 'invalid vendorId');
        await setVendorCategory(gate.pid, key, rawVendor === null ? null : String(rawVendor), actor);
        return ok({ updated: true }, { requestId: gate.requestId });
      }

      // ── The per-item override ("actually from…") ──
      case 'set_item_vendor': {
        const itemV = validateUuid(body.itemId, 'itemId');
        if (itemV.error) return badRequest(gate, itemV.error);
        const rawVendor = body.vendorId;
        if (rawVendor !== null && !isUuid(rawVendor)) return badRequest(gate, 'invalid vendorId');
        const found = await setItemVendorOverride(
          gate.pid,
          itemV.value as string,
          rawVendor === null ? null : String(rawVendor),
        );
        if (!found) return err('item not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
        return ok({ updated: true }, { requestId: gate.requestId });
      }

      // ── "I placed it" / shopping list done / phoned it in ──
      case 'mark_ordered': {
        const method = parseOrderMethod(body.placedVia);
        if (!method) return badRequest(gate, 'invalid placedVia');
        if (method === 'email') {
          // Marking an email order as placed by hand would record a send that
          // never happened. Emailing is send_po's job, and only send_po can
          // report that it succeeded.
          return badRequest(gate, 'email orders are placed with send_po');
        }
        const resolved = await resolveOrderLines(gate.pid, body);
        if ('error' in resolved) return badRequest(gate, resolved.error);
        // The same guard send_po has always had. Without it a list whose items
        // were all restocked since the screen loaded records an order with no
        // lines: a purchase order for nothing, which then stamps nothing and
        // reads in the history as an order the manager never placed.
        if (resolved.lines.length === 0) return badRequest(gate, 'nothing to order');

        const lineItemIds = resolved.lines.map((l) => l.itemId);
        // A double tap is one order. Marking a store run twice would double
        // the hotel's own record of what it bought.
        //
        // ONLY a SENT match counts. A draft is an email attempt that was never
        // accepted, and treating it as "already recorded" would swallow a
        // genuine "I placed it": the manager would be told it was recorded
        // while the row stayed a draft and the items were never stamped.
        const already = await findRecentMatchingOrder(gate.pid, resolved.vendorId, lineItemIds);
        if (already && already.status === 'sent') {
          return ok(
            { order: { id: already.id, poNumber: already.poNumber }, alreadyRecorded: true },
            { requestId: gate.requestId },
          );
        }

        const recorded = await recordPlacedOrder(
          gate.pid,
          {
            vendorId: resolved.vendorId,
            vendorName: resolved.vendorName,
            placedVia: method,
            lines: resolved.lines,
            subtotalCents: resolved.subtotalCents,
            sentToEmail: null,
            notes: null,
          },
          actor,
        );
        return ok({ order: recorded }, { requestId: gate.requestId, status: 201 });
      }

      // ── The only action that leaves the building ──
      case 'send_po': {
        const idV = validateUuid(body.vendorId, 'vendorId');
        if (idV.error) return badRequest(gate, idV.error);

        const vendors = await listVendors(gate.pid);
        const vendor = vendors.find((v) => v.id === idV.value);
        if (!vendor) return err('vendor not found', { requestId: gate.requestId, status: 404, code: 'not_found' });

        // Re-check the block reason at send time rather than trusting the
        // screen: the client decided this button was available some seconds
        // ago, and a vendor can be edited in another tab in between.
        const blocked = blockReasonFor(vendor);
        if (blocked) return badRequest(gate, `vendor not ready to email: ${blocked}`);
        if (vendor.orderMethod !== 'email' || !vendor.email) {
          return badRequest(gate, 'vendor is not an email vendor');
        }
        if (!gate.email) {
          // Reply-to and the manager's copy both need a real address. Sending
          // without one would put the vendor's reply somewhere nobody reads.
          return badRequest(gate, 'your account has no email address to reply to');
        }

        const resolved = await resolveOrderLines(gate.pid, body);
        if ('error' in resolved) return badRequest(gate, resolved.error);
        if (resolved.lines.length === 0) return badRequest(gate, 'nothing to order');

        const hotelName = await propertyName(gate.pid);
        const lineItemIds = resolved.lines.map((l) => l.itemId);

        // ── ONE ORDER PER ORDER, HOWEVER MANY TIMES IT IS ASKED FOR ──
        //
        // The send can fail in a way that tells the manager nothing certain: a
        // 15-second timeout, a 502 from a slow mail hop. The panel's own copy
        // then invites the retry ("The order is still here, try again"). This
        // used to mint a fresh number on that retry and put a SECOND purchase
        // order, under a second reference, in a real supplier's inbox for the
        // same goods. So the order is identified by its content — this hotel,
        // this vendor, this set of items — not by the request that created it.
        //
        //   already SENT  → the vendor has it. Report the SAME order and do
        //                   not go near the mail server.
        //   still a DRAFT → the mail was never confirmed accepted. Reuse the
        //                   row and its number so the retry cannot become a
        //                   second reference, and refresh its lines so the
        //                   document and the row cannot disagree.
        const existing = await findRecentMatchingOrder(gate.pid, vendor.id, lineItemIds);
        if (existing && existing.status === 'sent') {
          return ok(
            {
              order: { id: existing.id, poNumber: existing.poNumber },
              sentTo: vendor.email,
              alreadySent: true,
            },
            { requestId: gate.requestId },
          );
        }

        // Mint the number BEFORE rendering: the reference the vendor quotes
        // back on the phone has to be the one on the row we kept.
        const poNumber = existing ? existing.poNumber : mintPoNumber();

        // WRITE THE ORDER BEFORE SENDING IT. The send used to come first, so a
        // crash or a timeout between the two lost the order entirely: no row,
        // no lines, no record that anything had been attempted. The draft row
        // carries no sent_at, no recipient and does NOT stamp the items as
        // ordered, so the items stay on the list to retry and nothing claims
        // the vendor has it. markOrderSent promotes it once the mail is
        // actually accepted.
        let recorded: { id: string; poNumber: string } | null;
        if (existing) {
          await replaceDraftOrderLines(gate.pid, existing.id, resolved.lines, resolved.subtotalCents);
          recorded = { id: existing.id, poNumber: existing.poNumber };
        } else {
          recorded = await recordPlacedOrder(
            gate.pid,
            {
              vendorId: vendor.id,
              vendorName: vendor.name,
              placedVia: 'email',
              lines: resolved.lines,
              subtotalCents: resolved.subtotalCents,
              sentToEmail: vendor.email,
              notes: null,
              poNumber,
              status: 'draft',
            },
            actor,
          );
        }
        if (!recorded) {
          return err('could not record the order', {
            requestId: gate.requestId,
            status: 500,
            code: 'action_failed',
          });
        }

        const sent = await sendPoEmail({
          to: vendor.email,
          vendorName: vendor.name,
          hotelName,
          managerName: gate.name,
          managerEmail: gate.email,
          poNumber,
          lines: resolved.lines.map((l) => ({
            description: l.description,
            qty: l.qty,
            unit: l.unit,
            unitCostCents: l.unitCostCents,
          })),
          accountNumber: vendor.accountNumber,
          notes: null,
        });
        if (!sent.ok) {
          // The draft row stays. The panel shows "Could not send. The order is
          // still here, try again." and the items are still on the list.
          return err(`could not send: ${sent.error}`, {
            requestId: gate.requestId,
            status: 502,
            code: 'send_failed',
          });
        }

        await markOrderSent(gate.pid, recorded.id, {
          sentToEmail: vendor.email,
          itemIds: resolved.lines.map((l) => l.itemId),
        });
        return ok(
          { order: recorded, sentTo: vendor.email },
          { requestId: gate.requestId, status: 201 },
        );
      }

      default:
        return badRequest(gate, 'unknown action');
    }
  } catch (e) {
    log.error('[ordering] action failed', {
      pid: gate.pid,
      action,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('action failed', { requestId: gate.requestId, status: 500, code: 'action_failed' });
  }
}

// ─── Shared line resolution ─────────────────────────────────────────────────

interface ResolvedLines {
  vendorId: string | null;
  vendorName: string | null;
  lines: Array<{
    itemId: string;
    description: string;
    qty: number;
    unit: string;
    unitCostCents: number | null;
  }>;
  subtotalCents: number;
}

/**
 * Turn the client's item ids into order lines, RE-DERIVING every quantity and
 * price on the server.
 *
 * The client sends WHICH items, never how many or at what price. Quantities
 * come from the live par gap and prices from the receipt ledger, both read
 * here, so a tampered or merely stale page cannot put a quantity or a dollar
 * figure into a document that goes to a vendor.
 */
async function resolveOrderLines(
  pid: string,
  body: Record<string, unknown>,
): Promise<ResolvedLines | { error: string }> {
  const rawIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  const itemIds = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && isUuid(v)))];
  if (itemIds.length === 0) return { error: 'itemIds must be a non-empty array of item ids' };
  if (itemIds.length > 200) return { error: 'too many items in one order' };

  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('id, name, unit, current_stock, set_aside, par_level')
    .eq('property_id', pid)
    .is('archived_at', null)
    .in('id', itemIds);
  if (error) return { error: 'could not read items' };

  const prices = await lastInvoicePrices(pid, itemIds);
  const lines: ResolvedLines['lines'] = [];
  let subtotalCents = 0;

  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const id = String(raw.id);
    const par = Number(raw.par_level ?? 0);
    const onHand = Math.max(0, Number(raw.current_stock ?? 0) - Number(raw.set_aside ?? 0));
    // NO FLOOR OF ONE. This used to be Math.max(1, …), which put a line on a
    // real purchase order for an item that needs nothing: restocked since the
    // screen loaded, or never given a par level at all. buildCandidate can
    // never produce that case, so the guard only ever fired on a stale or
    // tampered page — and it fired by inventing a unit the hotel would be
    // billed for. An item with nothing to order gets no line.
    const qty = Math.ceil(par - onHand);
    if (!(qty > 0)) continue;
    const price = prices.get(id)?.cents ?? null;
    lines.push({
      itemId: id,
      description: String(raw.name ?? ''),
      qty,
      unit: String(raw.unit ?? ''),
      unitCostCents: price,
    });
    if (price != null) subtotalCents += price * qty;
  }

  const vendorId = typeof body.vendorId === 'string' && isUuid(body.vendorId) ? body.vendorId : null;
  let vendorName: string | null = null;
  if (vendorId) {
    const { data: v } = await supabaseAdmin
      .from('vendors')
      .select('name')
      .eq('id', vendorId)
      .eq('property_id', pid)
      .maybeSingle();
    vendorName = v ? String((v as Record<string, unknown>).name ?? '') : null;
  }

  return { vendorId, vendorName, lines, subtotalCents };
}

async function propertyName(pid: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('properties')
    .select('name')
    .eq('id', pid)
    .maybeSingle();
  return data ? String((data as Record<string, unknown>).name ?? 'the hotel') : 'the hotel';
}
