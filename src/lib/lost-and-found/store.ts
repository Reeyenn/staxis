// ═══════════════════════════════════════════════════════════════════════════
// Lost & Found — server-side store (supabaseAdmin).
//
// EVERY read/write goes through here, never the browser client. Both physical
// tables are deny-all-browser (CLAUDE.md "RLS bug class"), so the union read
// MUST run service-role on the server. Callers (API routes) own the auth gate
// (requireSession + userHasPropertyAccess / gateHousekeeperRequest); this file
// assumes the property is already authorized and just does the data work.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { logErr, asRecordRows, asRecordRow } from '@/lib/db/_common';
import {
  type LostFoundItem,
  type LostFoundCounts,
  type LostFoundType,
  type LostFoundOrigin,
  LAF_HOLD_DAYS,
  LAF_NEARING_DISPOSAL_DAYS,
} from './types';

// Columns we read off the app table. Module constant so supabase-js doesn't
// try (and fail) to infer the row type from a dynamic string.
const APP_COLS =
  'id, property_id, type, item_description, category, location, room_number, ' +
  'photo_path, status, found_by, found_by_staff_id, reported_by, guest_name, ' +
  'matched_item_id, occurred_at, hold_until, claimed_at, ' +
  'returned_at, shipping_info, source, notes, created_by_account_id, created_at';

const PMS_COLS =
  'id, property_id, item_description, location_found, room_number, found_at, ' +
  'found_by, status, claimed_by_guest, claimed_at, shipping_info, notes, created_at';

/** Coerce a Date or ISO/parseable string to an ISO string, else null. Guards
 *  against the ".toISOString() on a JSON string" crash class. */
function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asJsonb(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Validate a stored photo path against the EXACT shape our presign routes mint:
 *   <pid>/<fd|hk>/<scopeKey>/<uuid>.<ext>
 * Rejects path traversal (`..`), wrong property prefix, extra segments, and any
 * arbitrary same-prefix key — so signItemPhotos can never sign something a
 * caller hand-crafted to point elsewhere. Used by both the front-desk log route
 * and the housekeeper report route.
 */
export function isValidItemPhotoPath(pid: string, path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false;
  if (path.includes('..')) return false;
  const parts = path.split('/');
  if (parts.length !== 4) return false;
  if (parts[0] !== pid) return false;
  if (parts[1] !== 'fd' && parts[1] !== 'hk') return false;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(parts[2])) return false;
  return /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$/i.test(parts[3]);
}

// ─── Normalizers ────────────────────────────────────────────────────────────

function normalizeAppRow(r: Record<string, unknown>): LostFoundItem {
  return {
    id: String(r.id),
    source: 'app',
    type: (r.type === 'lost' ? 'lost' : 'found') as LostFoundType,
    itemDescription: typeof r.item_description === 'string' ? r.item_description : '',
    category: asStr(r.category),
    location: asStr(r.location),
    roomNumber: asStr(r.room_number),
    photoPath: asStr(r.photo_path),
    status: typeof r.status === 'string' ? r.status : 'open',
    foundBy: asStr(r.found_by),
    reportedBy: asStr(r.reported_by),
    guestName: asStr(r.guest_name),
    matchedItemId: asStr(r.matched_item_id),
    occurredAt: toIso(r.occurred_at),
    holdUntil: toIso(r.hold_until),
    claimedAt: toIso(r.claimed_at),
    returnedAt: toIso(r.returned_at),
    shippingInfo: asJsonb(r.shipping_info),
    notes: asStr(r.notes),
    createdAt: toIso(r.created_at) ?? new Date(0).toISOString(),
    editable: true,
  };
}

function normalizePmsRow(r: Record<string, unknown>): LostFoundItem {
  return {
    id: String(r.id),
    source: 'pms',
    type: 'found', // PMS only tracks found items
    itemDescription: typeof r.item_description === 'string' ? r.item_description : '',
    category: null,
    location: asStr(r.location_found),
    roomNumber: asStr(r.room_number),
    photoPath: null,
    status: typeof r.status === 'string' ? r.status : 'open',
    foundBy: asStr(r.found_by),
    reportedBy: null,
    guestName: asStr(r.claimed_by_guest),
    matchedItemId: null,
    occurredAt: toIso(r.found_at),
    holdUntil: null,
    claimedAt: toIso(r.claimed_at),
    returnedAt: null,
    shippingInfo: asJsonb(r.shipping_info),
    notes: asStr(r.notes),
    createdAt: toIso(r.created_at) ?? new Date(0).toISOString(),
    editable: false, // CUA owns pms_lost_and_found — never mutate from the app
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * Unified register: app-logged items + PMS-synced items, newest first.
 * Returns [] on error (a partial read is worse than empty — the caller
 * surfaces a load failure separately via the requestId/log).
 */
export async function fetchRegister(propertyId: string): Promise<LostFoundItem[]> {
  const [appRes, pmsRes] = await Promise.all([
    supabaseAdmin
      .from('lost_and_found_items')
      .select(APP_COLS)
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })
      .limit(2000),
    supabaseAdmin
      .from('pms_lost_and_found')
      .select(PMS_COLS)
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })
      .limit(2000),
  ]);

  // The app table is the primary source — fail CLOSED so the route returns an
  // error rather than computing silently-wrong counts from partial data. The
  // PMS table is supplementary (empty in Phase 1); a transient CUA-side error
  // degrades to app-only data (logged) instead of breaking the whole register.
  if (appRes.error) {
    logErr('lost-and-found.fetchRegister(app)', appRes.error);
    throw new Error('lost_and_found read failed');
  }
  if (pmsRes.error) logErr('lost-and-found.fetchRegister(pms)', pmsRes.error);

  const app = asRecordRows(appRes.data).map(normalizeAppRow);
  const pms = asRecordRows(pmsRes.data).map(normalizePmsRow);

  return [...app, ...pms].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Bucket holding found-item photos (private; signed server-side). */
const PHOTO_BUCKET = 'lost-found-item-photos';

/**
 * Decorate items with short-lived signed view URLs for their photos. The
 * bucket is private and denies the browser, so the URL must be minted with
 * supabaseAdmin here. Batched into one storage call; failures degrade to no
 * thumbnail rather than breaking the register.
 */
export async function signItemPhotos(items: LostFoundItem[]): Promise<LostFoundItem[]> {
  const paths = Array.from(
    new Set(items.filter((i) => i.photoPath).map((i) => i.photoPath as string)),
  );
  if (paths.length === 0) return items;
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(paths, 60 * 5);
    if (error || !data) return items;
    const urlByPath = new Map<string, string>();
    for (const row of data) {
      if (row.path && row.signedUrl) urlByPath.set(row.path, row.signedUrl);
    }
    return items.map((i) =>
      i.photoPath ? { ...i, photoUrl: urlByPath.get(i.photoPath) ?? null } : i,
    );
  } catch (e) {
    logErr('lost-and-found.signItemPhotos', e);
    return items;
  }
}

/** Tile/header counts. Pure given a `nowMs`. */
export function computeCounts(items: LostFoundItem[], nowMs: number = Date.now()): LostFoundCounts {
  const nearingCutoff = nowMs + LAF_NEARING_DISPOSAL_DAYS * 24 * 60 * 60 * 1000;
  let open = 0;
  let awaitingReturn = 0;
  let nearingDisposal = 0;
  for (const it of items) {
    if (it.status === 'open') open += 1;
    // A match flips BOTH the lost report and the found item to 'matched'.
    // Count only the FOUND side so one logical match = one "awaiting return"
    // (the physical item to hand back), not two.
    if (it.type === 'found' && it.status === 'matched') awaitingReturn += 1;
    if (it.type === 'found' && it.status === 'open' && it.holdUntil) {
      const ms = Date.parse(it.holdUntil);
      if (Number.isFinite(ms) && ms <= nearingCutoff) nearingDisposal += 1;
    }
  }
  return { open, awaitingReturn, nearingDisposal };
}

export async function fetchCounts(propertyId: string): Promise<LostFoundCounts> {
  return computeCounts(await fetchRegister(propertyId));
}

/** Read a single APP item (scoped to property). PMS items are not editable so
 *  there's no getter for them here. */
export async function getAppItem(
  propertyId: string,
  id: string,
): Promise<LostFoundItem | null> {
  const { data, error } = await supabaseAdmin
    .from('lost_and_found_items')
    .select(APP_COLS)
    .eq('property_id', propertyId)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    logErr('lost-and-found.getAppItem', error);
    return null;
  }
  const row = asRecordRow(data);
  return row ? normalizeAppRow(row) : null;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface CreateItemInput {
  type: LostFoundType;
  itemDescription: string;
  category?: string | null;
  location?: string | null;
  roomNumber?: string | null;
  photoPath?: string | null;
  foundBy?: string | null;
  foundByStaffId?: string | null;
  reportedBy?: string | null;
  guestName?: string | null;
  occurredAt?: string | null;
  source: LostFoundOrigin;
  notes?: string | null;
  createdByAccountId?: string | null;
}

/** Insert a new app-side item. Found items get a 90-day disposal hold. */
export async function createItem(
  propertyId: string,
  input: CreateItemInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const now = Date.now();
  const occurredAt = toIso(input.occurredAt) ?? new Date(now).toISOString();
  // Only found items have a disposal clock.
  const holdUntil =
    input.type === 'found'
      ? new Date(now + LAF_HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const row = {
    property_id: propertyId,
    type: input.type,
    item_description: input.itemDescription,
    category: input.category ?? null,
    location: input.location ?? null,
    room_number: input.roomNumber ?? null,
    photo_path: input.photoPath ?? null,
    status: 'open',
    found_by: input.foundBy ?? null,
    found_by_staff_id: input.foundByStaffId ?? null,
    reported_by: input.reportedBy ?? null,
    guest_name: input.guestName ?? null,
    occurred_at: occurredAt,
    hold_until: holdUntil,
    source: input.source,
    notes: input.notes ?? null,
    created_by_account_id: input.createdByAccountId ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from('lost_and_found_items')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) {
    logErr('lost-and-found.createItem', error);
    return { ok: false, error: 'insert_failed' };
  }
  return { ok: true, id: String(data.id) };
}

/** Patch a subset of fields on an app item. Always property-scoped so a
 *  forged id from another tenant can't be updated. */
export interface UpdateItemPatch {
  status?: string;
  category?: string | null;
  location?: string | null;
  roomNumber?: string | null;
  guestName?: string | null;
  notes?: string | null;
  claimedAt?: string | null;
  returnedAt?: string | null;
  shippingInfo?: Record<string, unknown> | null;
  matchedItemId?: string | null;
  holdUntil?: string | null;
}

export async function updateAppItem(
  propertyId: string,
  id: string,
  patch: UpdateItemPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.category !== undefined) row.category = patch.category;
  if (patch.location !== undefined) row.location = patch.location;
  if (patch.roomNumber !== undefined) row.room_number = patch.roomNumber;
  if (patch.guestName !== undefined) row.guest_name = patch.guestName;
  if (patch.notes !== undefined) row.notes = patch.notes;
  if (patch.claimedAt !== undefined) row.claimed_at = toIso(patch.claimedAt);
  if (patch.returnedAt !== undefined) row.returned_at = toIso(patch.returnedAt);
  if (patch.shippingInfo !== undefined) row.shipping_info = patch.shippingInfo;
  if (patch.matchedItemId !== undefined) row.matched_item_id = patch.matchedItemId;
  if (patch.holdUntil !== undefined) row.hold_until = toIso(patch.holdUntil);

  if (Object.keys(row).length === 0) return { ok: true };

  // .select() forces the WHERE to actually match a row — a forged id (or a
  // PMS id, which lives in a different table) updates nothing and we report it.
  const { data, error } = await supabaseAdmin
    .from('lost_and_found_items')
    .update(row)
    .eq('property_id', propertyId)
    .eq('id', id)
    .select('id');
  if (error) {
    logErr('lost-and-found.updateAppItem', error);
    return { ok: false, error: 'update_failed' };
  }
  if (!data || data.length === 0) return { ok: false, error: 'not_found' };
  return { ok: true };
}

/**
 * Link a lost report ↔ a found item. Both must be app-side, open, same
 * property, opposite types. Sets matched_item_id on both and flips status to
 * 'matched'. Returns the normalized pair on success.
 */
export async function matchItems(
  propertyId: string,
  lostId: string,
  foundId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (lostId === foundId) return { ok: false, error: 'cannot_match_self' };

  const [lost, found] = await Promise.all([
    getAppItem(propertyId, lostId),
    getAppItem(propertyId, foundId),
  ]);
  if (!lost || !found) return { ok: false, error: 'not_found' };
  if (lost.type !== 'lost' || found.type !== 'found') {
    return { ok: false, error: 'type_mismatch' };
  }
  if (lost.status !== 'open' || found.status !== 'open') {
    return { ok: false, error: 'already_resolved' };
  }

  // Conditional updates guard against a concurrent match (the pre-checks above
  // only give friendly errors; the WHERE clauses are the real race guard).
  // Each leg flips ONLY a row that is still its type + open + unmatched. If the
  // lost leg matches 0 rows, someone matched it first → abort. If the found leg
  // matches 0 rows, roll the lost leg back so we never leave a half-match.
  const { data: lostUpd, error: lostErr } = await supabaseAdmin
    .from('lost_and_found_items')
    .update({ matched_item_id: foundId, status: 'matched' })
    .eq('property_id', propertyId)
    .eq('id', lostId)
    .eq('type', 'lost')
    .eq('status', 'open')
    .is('matched_item_id', null)
    .select('id');
  if (lostErr) {
    logErr('lost-and-found.matchItems(lost)', lostErr);
    return { ok: false, error: 'update_failed' };
  }
  if (!lostUpd || lostUpd.length === 0) return { ok: false, error: 'already_resolved' };

  const { data: foundUpd, error: foundErr } = await supabaseAdmin
    .from('lost_and_found_items')
    .update({ matched_item_id: lostId, status: 'matched' })
    .eq('property_id', propertyId)
    .eq('id', foundId)
    .eq('type', 'found')
    .eq('status', 'open')
    .is('matched_item_id', null)
    .select('id');
  if (foundErr || !foundUpd || foundUpd.length === 0) {
    if (foundErr) logErr('lost-and-found.matchItems(found)', foundErr);
    // Roll the lost leg back to open/unmatched.
    await supabaseAdmin
      .from('lost_and_found_items')
      .update({ matched_item_id: null, status: 'open' })
      .eq('property_id', propertyId)
      .eq('id', lostId);
    return { ok: false, error: foundErr ? 'update_failed' : 'already_resolved' };
  }
  return { ok: true };
}
