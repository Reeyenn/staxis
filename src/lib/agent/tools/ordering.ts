// ─── Setting up who supplies what, by saying it once ─────────────────────────
//
// One tool: `staxis_set_up_vendors`. A manager says
//
//   "food from Sysco by email, linens from Guest Supply's site, rest is Sam's"
//
// and it becomes a vendor list with categories attached. The alternative the
// product ruling rejected was asking per item — a 100-item hotel is 100
// questions, and nobody finishes that. Vendors map to CATEGORIES, so three to
// six answers cover the whole storeroom.
//
// TWO CALLS, AND THE SECOND ONE NEEDS A HUMAN — the same machinery as
// staxis-setup.ts, for the same reason. The read-back is structured and names
// every vendor, every method and every category the model derived, because the
// failure this catches is silent: "Guest Supply's site" heard as an email
// vendor produces a screen that offers to email a supplier who does not take
// email, and a manager told "got it" has no way to find that out.
//
// WHY THIS TOOL WRITES NO PRICES AND NO QUANTITIES
// It sets up ROUTING only — who supplies which category, and how you reach
// them. It cannot place an order, cannot mark anything ordered, and never
// states a figure. Money on this feature comes from receipts on the ordering
// screen, and a tool that could put a number into a conversation would be a
// second, unreceipted path to one.

import { registerTool, type ToolResult, type ToolHandlerContext } from '../tools';
import {
  proposeConfirmation,
  takeConfirmation,
  confirmedMarker,
  type ReadBack,
} from '../chat-confirm';
import { listVendors, createVendor, updateVendorOrdering, setVendorCategory } from '@/lib/ordering/db';
import { ORDER_METHODS, type BucketKey, type OrderMethod } from '@/lib/ordering/types';

const MANAGER_ROLES = ['admin', 'owner', 'general_manager'] as const;

/** What one line of the manager's sentence turns into. */
interface ProposedVendor {
  name: string;
  method: OrderMethod | null;
  email: string | null;
  websiteUrl: string | null;
  phone: string | null;
  buckets: BucketKey[];
}

interface VendorSetupParams {
  vendors: ProposedVendor[];
}

const METHOD_WORDS: Record<OrderMethod, { en: string; es: string }> = {
  email: { en: 'by email', es: 'por correo' },
  website: { en: 'on their website', es: 'en su sitio web' },
  store: { en: 'a store run', es: 'yendo a la tienda' },
  phone: { en: 'by phone', es: 'por teléfono' },
};

/** The hotel's real category list, so the model cannot invent one.
 *
 *  Returns display labels keyed by bucket. 'general' and 'breakfast' always
 *  exist; custom categories are whatever this hotel made. A category the model
 *  names that is not in here is REFUSED rather than created — inventing a
 *  category from a chat sentence would put items nowhere. */
async function hotelBuckets(ctx: ToolHandlerContext): Promise<Map<BucketKey, string>> {
  const out = new Map<BucketKey, string>([
    ['general', 'General'],
    ['breakfast', 'Breakfast'],
  ]);
  // ctx.db, not supabaseAdmin: the AI layer reads through the property-scoped
  // client so a tool cannot see another hotel's category names even by
  // accident. The vendor writes below go through @/lib/ordering/db, which
  // takes the property id explicitly and filters on it.
  const { data } = await ctx.db
    .from('inventory_custom_categories')
    .select('id, name')
    .limit(60);
  for (const raw of data ?? []) {
    const r = raw as Record<string, unknown>;
    out.set(`custom:${String(r.id)}` as BucketKey, String(r.name ?? ''));
  }
  return out;
}

/** Match what the model said against the hotel's real categories.
 *
 *  Case- and whitespace-insensitive on the LABEL, plus the raw bucket key, so
 *  the model may answer with either "Breakfast" or "breakfast". Anything else
 *  returns null and the whole proposal is refused with the real list quoted
 *  back — better to ask again than to file linens under a category nobody has. */
function matchBucket(raw: string, buckets: ReadonlyMap<BucketKey, string>): BucketKey | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  for (const [key, label] of buckets) {
    if (key.toLowerCase() === needle) return key;
    if (label.trim().toLowerCase() === needle) return key;
  }
  return null;
}

// The read-back is the sentence the manager checks, so it prints the category
// LABELS the hotel knows, never the internal bucket keys. A custom category's
// key is `custom:<uuid>`, and reading a UUID out to somebody is the difference
// between a check they can do and one they will wave through.
function buildReadBack(
  vendors: readonly ProposedVendor[],
  buckets: ReadonlyMap<BucketKey, string>,
): ReadBack {
  const line = (v: ProposedVendor, lang: 'en' | 'es'): string => {
    const method = v.method
      ? METHOD_WORDS[v.method][lang]
      : (lang === 'en' ? 'method not set yet' : 'sin método todavía');
    const where = v.email ?? v.websiteUrl ?? v.phone;
    const detail = where ? ` (${where})` : '';
    const cats = v.buckets.length > 0
      ? v.buckets.map((b) => buckets.get(b) ?? b).join(', ')
      : (lang === 'en' ? 'no categories' : 'sin categorías');
    return `${v.name}, ${method}${detail}, ${cats}`;
  };
  return {
    en: `Saving ${vendors.length} supplier(s): ${vendors.map((v) => line(v, 'en')).join('; ')}. `
      + 'Items in each category will show that supplier unless an item says otherwise. Right?',
    es: `Guardando ${vendors.length} proveedor(es): ${vendors.map((v) => line(v, 'es')).join('; ')}. `
      + 'Los artículos de cada categoría mostrarán ese proveedor salvo que un artículo indique otro. ¿Correcto?',
  };
}

registerTool<{
  vendors?: Array<{
    name?: string;
    method?: string;
    email?: string;
    websiteUrl?: string;
    phone?: string;
    categories?: string[];
  }>;
  confirmToken?: string;
}>({
  name: 'staxis_set_up_vendors',
  section: 'inventory',
  allowedRoles: MANAGER_ROLES,
  requiresCapability: 'manage_inventory_orders',
  mutates: true,
  confirmInChat: true,
  description:
    'Record WHO supplies the hotel and HOW you order from each of them, from one sentence the manager just said, so the Ordering screen can group what is running low by supplier. '
    + 'Use when: someone describes their suppliers — "food from Sysco by email, linens from Guest Supply\'s site, everything else is Sam\'s Club", "los amenities los traemos de Costco". Not for placing an order (this tool never orders anything and never states a price), and not for a one-off purchase. '
    + 'Args: vendors — one entry per supplier. name is their name in the manager\'s words. method is HOW the hotel orders from them: "email", "website", "store" (someone drives there), or "phone"; LEAVE IT OUT when they did not say — do not guess, an unset method shows as a question on the screen and a wrong one sends an order down a channel the supplier does not use. email / websiteUrl / phone only when they actually gave one. categories — which inventory categories this supplier covers, using the hotel\'s OWN category names; ask rather than invent. confirmToken — ONLY on the second call, after they have agreed. '
    + 'Returns: on the first call { awaitingConfirmation, readBack, confirm } — nothing is saved; read the readBack out in their language and wait. On the second call, what was saved. '
    + 'Refuses: a category this hotel does not have (it lists the real ones instead of creating one), a supplier name that already exists (it says so rather than making a duplicate), a website method with no URL, more than 20 suppliers at once, and saving on the first call. It also refuses a confirmToken when the person has not said anything since the read-back: your own agreement is not theirs.',
  inputSchema: {
    type: 'object',
    properties: {
      vendors: {
        type: 'array',
        description: 'One entry per supplier the manager named.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The supplier\'s name, in the manager\'s own words.' },
            method: { type: 'string', enum: ['email', 'website', 'store', 'phone'], description: 'How the hotel orders from them. Omit entirely when they did not say — never guess.' },
            email: { type: 'string', description: 'Order address, only if they gave one.' },
            websiteUrl: { type: 'string', description: 'Their ordering site, only if they gave one. Required when method is "website".' },
            phone: { type: 'string', description: 'Order phone number, only if they gave one.' },
            categories: { type: 'array', items: { type: 'string' }, description: 'The hotel\'s own inventory category names this supplier covers.' },
          },
        },
      },
      confirmToken: { type: 'string', description: 'The token from your earlier proposal. Send ONLY after the person has said yes in a new message.' },
    },
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // ── the confirm half ──
    if (args.confirmToken) {
      const taken = await takeConfirmation<VendorSetupParams>(ctx, 'vendor_setup', args.confirmToken);
      if (!taken.ok) return { ok: false, error: taken.error };
      const frozen = taken.params;
      if (!frozen || !Array.isArray(frozen.vendors) || frozen.vendors.length === 0) {
        return { ok: false, error: 'What you agreed to did not survive intact, so I have not saved it. Propose it again.' };
      }
      if (ctx.dryRun) {
        return {
          ok: true,
          data: {
            ...confirmedMarker(args.confirmToken),
            saved: frozen.vendors.map((v) => v.name),
            dryRun: true,
          },
        };
      }

      const actor = { userId: ctx.user.uid, name: ctx.user.displayName || null };
      const saved: string[] = [];
      for (const proposed of frozen.vendors) {
        const vendor = await createVendor(
          ctx.propertyId,
          { name: proposed.name, email: proposed.email, phone: proposed.phone },
          actor,
        );
        await updateVendorOrdering(ctx.propertyId, vendor.id, {
          orderMethod: proposed.method,
          websiteUrl: proposed.websiteUrl,
          // Confirmed: a human said yes to this exact read-back. The chat is
          // the one place a suggestion can be born already confirmed, because
          // unlike a contact scrape it came from someone telling us.
          reviewState: 'confirmed',
          suggestedFrom: 'chat',
        });
        for (const bucket of proposed.buckets) {
          await setVendorCategory(ctx.propertyId, bucket, vendor.id, actor);
        }
        saved.push(proposed.name);
      }

      return {
        ok: true,
        data: {
          ...confirmedMarker(args.confirmToken),
          saved,
          note: 'Saved. The Ordering screen on the inventory page now groups low items by these suppliers.',
        },
      };
    }

    // ── the propose half — writes nothing ──
    const rawVendors = Array.isArray(args.vendors) ? args.vendors : [];
    if (rawVendors.length === 0) {
      return { ok: false, error: 'Which suppliers? Ask them who supplies what. Do not name suppliers yourself.' };
    }
    if (rawVendors.length > 20) {
      return { ok: false, error: 'That is more than 20 suppliers at once. Do them in smaller groups so the person can actually check the read-back.' };
    }

    const buckets = await hotelBuckets(ctx);
    const existing = await listVendors(ctx.propertyId);
    const existingNames = new Set(existing.map((v) => v.name.trim().toLowerCase()));

    const proposed: ProposedVendor[] = [];
    const seen = new Set<string>();
    for (const raw of rawVendors) {
      const name = String(raw.name ?? '').trim();
      if (name.length < 2 || name.length > 120) {
        return { ok: false, error: 'Every supplier needs a name of at least 2 characters. Ask them what the supplier is called.' };
      }
      const key = name.toLowerCase();
      if (existingNames.has(key)) {
        return { ok: false, error: `"${name}" is already on this hotel's supplier list. Tell them it is already there. Do not add a second one. To change how they order from it, say so and I will update that one instead.` };
      }
      if (seen.has(key)) {
        return { ok: false, error: `You listed "${name}" twice. Send each supplier once.` };
      }
      seen.add(key);

      let method: OrderMethod | null = null;
      if (raw.method !== undefined && raw.method !== null && String(raw.method).trim() !== '') {
        const candidate = String(raw.method).trim().toLowerCase();
        if (!(ORDER_METHODS as readonly string[]).includes(candidate)) {
          return { ok: false, error: `"${raw.method}" is not a way to order. It is one of: email, website, store, phone. If they did not say, leave it out. The screen will ask them.` };
        }
        method = candidate as OrderMethod;
      }

      const email = raw.email ? String(raw.email).trim() : '';
      const websiteUrl = raw.websiteUrl ? String(raw.websiteUrl).trim() : '';
      const phone = raw.phone ? String(raw.phone).trim() : '';

      if (method === 'website' && !/^https?:\/\/\S+$/i.test(websiteUrl)) {
        return { ok: false, error: `You said ${name} is ordered from their website but gave no web address. Ask them for the link, or leave the method out until they have it.` };
      }
      if (method === 'email' && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: `"${email}" does not look like an email address. Check it with them.` };
      }

      const itemBuckets: BucketKey[] = [];
      for (const rawCat of Array.isArray(raw.categories) ? raw.categories : []) {
        const matched = matchBucket(String(rawCat), buckets);
        if (!matched) {
          return {
            ok: false,
            error: `This hotel has no category called "${rawCat}". Its categories are: ${[...buckets.values()].join(', ')}. Ask which of those ${name} covers. Do not create a category.`,
          };
        }
        if (!itemBuckets.includes(matched)) itemBuckets.push(matched);
      }

      proposed.push({
        name,
        method,
        email: method === 'email' && email ? email : null,
        websiteUrl: method === 'website' ? websiteUrl : null,
        phone: phone || null,
        buckets: itemBuckets,
      });
    }

    // Two suppliers claiming the same category is not a preference to resolve
    // silently — whichever won would decide who gets emailed for every item in
    // it. Refuse and let the person say.
    const claimed = new Map<BucketKey, string>();
    for (const vendor of proposed) {
      for (const bucket of vendor.buckets) {
        const already = claimed.get(bucket);
        if (already) {
          return { ok: false, error: `Both ${already} and ${vendor.name} were given the same category (${buckets.get(bucket) ?? bucket}). One supplier per category, so ask them which one it is. Individual items can be pointed elsewhere afterwards.` };
        }
        claimed.set(bucket, vendor.name);
      }
    }

    const params: VendorSetupParams = { vendors: proposed };
    return {
      ok: true,
      data: {
        ...(await proposeConfirmation(ctx, 'vendor_setup', params, buildReadBack(proposed, buckets))),
        // Named so the model can read the gap out loud rather than glossing it.
        missingMethod: proposed.filter((v) => !v.method).map((v) => v.name),
        withoutCategories: proposed.filter((v) => v.buckets.length === 0).map((v) => v.name),
      },
    };
  },
});

export type { ProposedVendor, VendorSetupParams };
