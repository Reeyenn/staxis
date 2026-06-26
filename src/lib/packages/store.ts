// ═══════════════════════════════════════════════════════════════════════════
// Packages — server-side store (supabaseAdmin).
//
// EVERY read/write/storage call for the feature lives here, never in a route
// file and never in the browser. `packages` is deny-all-browser (CLAUDE.md "RLS
// bug class"), so the anon client would silently return [] — the API routes go
// through this module with the service-role client instead. Callers (the API
// routes) own the auth gate (gatePackagesRead / gatePackagesWrite); this file
// assumes the property is already authorized and just does the data work.
//
// Concentrating supabaseAdmin here also keeps the route files free of a direct
// service-role import, so audit-api-route-tenant-scope is satisfied by the gate.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { logErr, asRecordRows, asRecordRow } from '@/lib/db/_common';
import type {
  PackageRow,
  PackageCounts,
  PackageStatus,
  PackageCarrier,
} from './types';

const COLS =
  'id, property_id, guest_name, room_number, carrier, tracking_number, ' +
  'notes, photo_path, status, logged_by_account_id, logged_at, ' +
  'picked_up_at, picked_up_by_account_id';

const PHOTO_BUCKET = 'package-label-photos';

/**
 * Internal record for an incoming package. Routes map this to the
 * client-facing PackageRow via toClientRow before responding.
 */
export interface PackageRecord {
  id: string;
  guestName: string;
  roomNumber: string | null;
  carrier: PackageCarrier | null;
  trackingNumber: string | null;
  notes: string | null;
  photoPath: string | null;
  photoUrl: string | null;
  status: PackageStatus;
  loggedAt: string;
  pickedUpAt: string | null;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Coerce a Date or ISO/parseable string to an ISO string, else null. Guards
 *  the ".toISOString() on a JSON string" crash class. */
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

const CARRIERS: ReadonlySet<string> = new Set(['UPS', 'FedEx', 'USPS', 'Amazon', 'Other']);

/**
 * Validate a stored photo path against the EXACT shape the presign route mints:
 *   <pid>/pkg/<scopeKey>/<uuid>.<ext>
 * Rejects traversal (`..`), wrong property prefix, extra segments, and any
 * arbitrary same-prefix key — so signLabelPhotos can never sign something a
 * caller hand-crafted to point at another tenant's object.
 */
export function isValidLabelPhotoPath(pid: string, path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false;
  if (path.includes('..')) return false;
  const parts = path.split('/');
  if (parts.length !== 4) return false;
  if (parts[0] !== pid) return false;
  if (parts[1] !== 'pkg') return false;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(parts[2])) return false;
  return /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$/i.test(parts[3]);
}

function normalizeRow(r: Record<string, unknown>): PackageRecord {
  const carrier = typeof r.carrier === 'string' && CARRIERS.has(r.carrier)
    ? (r.carrier as PackageCarrier)
    : null;
  return {
    id: String(r.id),
    guestName: typeof r.guest_name === 'string' ? r.guest_name : '',
    roomNumber: asStr(r.room_number),
    carrier,
    trackingNumber: asStr(r.tracking_number),
    notes: asStr(r.notes),
    photoPath: asStr(r.photo_path),
    photoUrl: null,
    status: r.status === 'picked_up' ? 'picked_up' : 'held',
    loggedAt: toIso(r.logged_at) ?? new Date(0).toISOString(),
    pickedUpAt: toIso(r.picked_up_at),
  };
}

/** Shape the internal record for the browser (drops nothing sensitive now —
 *  kept as the single mapping seam between the DB row and the API row). */
export function toClientRow(r: PackageRecord): PackageRow {
  return {
    id: r.id,
    guestName: r.guestName,
    roomNumber: r.roomNumber,
    carrier: r.carrier,
    trackingNumber: r.trackingNumber,
    notes: r.notes,
    photoPath: r.photoPath,
    photoUrl: r.photoUrl,
    status: r.status,
    loggedAt: r.loggedAt,
    pickedUpAt: r.pickedUpAt,
  };
}

// ─── reads ──────────────────────────────────────────────────────────────────

/**
 * All packages for a property, newest-first. Returns internal records; the
 * route maps them to the client shape via toClientRow before responding.
 * Throws on a hard read error so the route returns 500 rather than rendering a
 * silently-empty list.
 */
export async function listPackages(propertyId: string): Promise<PackageRecord[]> {
  const { data, error } = await supabaseAdmin
    .from('packages')
    .select(COLS)
    .eq('property_id', propertyId)
    .order('logged_at', { ascending: false })
    .limit(2000);
  if (error) {
    logErr('packages.listPackages', error);
    throw new Error('packages read failed');
  }
  return asRecordRows(data).map(normalizeRow);
}

/** Read a single package (property-scoped). */
export async function getPackage(
  propertyId: string,
  id: string,
): Promise<PackageRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('packages')
    .select(COLS)
    .eq('property_id', propertyId)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    logErr('packages.getPackage', error);
    return null;
  }
  const row = asRecordRow(data);
  return row ? normalizeRow(row) : null;
}

/** Held vs picked-up counts over the full record set. */
export function computeCounts(records: PackageRecord[]): PackageCounts {
  let held = 0;
  let pickedUp = 0;
  for (const r of records) {
    if (r.status === 'held') held += 1;
    else if (r.status === 'picked_up') pickedUp += 1;
  }
  return { held, pickedUp };
}

/**
 * Decorate records with short-lived signed view URLs for their label photos.
 * The bucket is private + deny-browser, so the URL must be minted with
 * supabaseAdmin here. Best-effort: a storage hiccup degrades to no thumbnail.
 */
export async function signLabelPhotos(records: PackageRecord[]): Promise<PackageRecord[]> {
  const paths = Array.from(
    new Set(records.filter((r) => r.photoPath).map((r) => r.photoPath as string)),
  );
  if (paths.length === 0) return records;
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(paths, 60 * 5);
    if (error || !data) return records;
    const urlByPath = new Map<string, string>();
    for (const row of data) {
      if (row.path && row.signedUrl) urlByPath.set(row.path, row.signedUrl);
    }
    return records.map((r) =>
      r.photoPath ? { ...r, photoUrl: urlByPath.get(r.photoPath) ?? null } : r,
    );
  } catch (e) {
    logErr('packages.signLabelPhotos', e);
    return records;
  }
}

// ─── writes ─────────────────────────────────────────────────────────────────

export interface CreatePackageInput {
  guestName: string;
  roomNumber?: string | null;
  carrier?: PackageCarrier | null;
  trackingNumber?: string | null;
  notes?: string | null;
  photoPath?: string | null;
  loggedByAccountId?: string | null;
}

export async function createPackage(
  propertyId: string,
  input: CreatePackageInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const row = {
    property_id: propertyId,
    guest_name: input.guestName,
    room_number: input.roomNumber ?? null,
    carrier: input.carrier ?? null,
    tracking_number: input.trackingNumber ?? null,
    notes: input.notes ?? null,
    photo_path: input.photoPath ?? null,
    status: 'held',
    logged_by_account_id: input.loggedByAccountId ?? null,
  };
  const { data, error } = await supabaseAdmin
    .from('packages')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) {
    logErr('packages.createPackage', error);
    return { ok: false, error: 'insert_failed' };
  }
  return { ok: true, id: String(data.id) };
}

/**
 * Mark a held package picked up. The `status = 'held'` WHERE guard makes this
 * idempotent under a double-tap (a second call matches 0 rows → not_found) and
 * never un-picks an already-collected parcel.
 */
export async function markPickedUp(
  propertyId: string,
  id: string,
  pickedUpByAccountId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from('packages')
    .update({
      status: 'picked_up',
      picked_up_at: new Date().toISOString(),
      picked_up_by_account_id: pickedUpByAccountId,
    })
    .eq('property_id', propertyId)
    .eq('id', id)
    .eq('status', 'held')
    .select('id');
  if (error) {
    logErr('packages.markPickedUp', error);
    return { ok: false, error: 'update_failed' };
  }
  if (!data || data.length === 0) return { ok: false, error: 'not_found' };
  return { ok: true };
}

/** Delete a package (property-scoped) — for an immediate log-mistake undo. */
export async function deletePackage(
  propertyId: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from('packages')
    .delete()
    .eq('property_id', propertyId)
    .eq('id', id)
    .select('id');
  if (error) {
    logErr('packages.deletePackage', error);
    return { ok: false, error: 'delete_failed' };
  }
  if (!data || data.length === 0) return { ok: false, error: 'not_found' };
  return { ok: true };
}

// ─── storage ────────────────────────────────────────────────────────────────

export interface PresignResult {
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * Mint a signed-upload URL for a label photo at
 * <pid>/pkg/<scopeKey>/<uuid>.<ext>. The scopeKey/filename are validated by the
 * route before calling. Returns null on any storage error (caller 500s).
 */
export async function createLabelUploadUrl(
  pid: string,
  scopeKey: string,
  ext: string,
): Promise<PresignResult | null> {
  const photoKey = `${pid}/pkg/${scopeKey}/${crypto.randomUUID()}.${ext}`;
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(PHOTO_BUCKET)
      .createSignedUploadUrl(photoKey);
    if (error || !data) {
      logErr('packages.createLabelUploadUrl', error ?? 'no url');
      return null;
    }
    return { path: photoKey, signedUrl: data.signedUrl, token: data.token };
  } catch (e) {
    logErr('packages.createLabelUploadUrl', e);
    return null;
  }
}
