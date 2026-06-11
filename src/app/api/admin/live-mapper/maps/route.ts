/**
 * GET /api/admin/live-mapper/maps
 *
 * Admin-only. Lists EVERY pms_knowledge_files row (all statuses) grouped by
 * pms_family — the data behind the Live Mapper admin view (/admin/live-mapper).
 * The table is service-role-only (migration 0201 deny-all-browser policy), so
 * this route is the only read path the browser has.
 *
 * Privacy / minimal surface:
 *   - The raw `knowledge` jsonb is NEVER returned. It holds the robot's PMS
 *     selectors and can be large; we read it server-side only to compute each
 *     map's feed coverage, then drop it.
 *   - The signing columns (signature bytea, signed_with_key_id, signed_at) are
 *     reduced to a single boolean `signed`. Neither the HMAC value nor the key
 *     fingerprint nor the sign timestamp is returned.
 *
 * Read-only. No mutation, no signing — see promote/deprecate/delete siblings.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { PMS_REGISTRY } from '@/lib/pms/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// The 5 feeds the v4 CUA polls (mirrors /api/admin/pms-coverage).
const TARGET_FEEDS = [
  'dashboard_counts',
  'arrivals_departures',
  'room_status',
  'housekeeping',
  'work_orders',
] as const;
type TargetFeed = (typeof TARGET_FEEDS)[number];

// A target feed can be stored under more than one key depending on the map's
// origin: legacy hand-seeded maps (migration 0203) use the snake_case feed name
// under `knowledge.feeds`, while mapper-produced maps use camelCase verbs under
// `knowledge.actions` (cua-service types.ts Recipe.actions + recipe-adapter.ts).
// A feed counts as covered if ANY of its source keys is present in either map.
// Best-effort indicator only: `housekeeping` has no distinct mapper action
// today (it's derived from room_status), so a mapper-shaped map may under-count
// it — acceptable for an at-a-glance health hint that never over-claims.
const FEED_SOURCE_KEYS: Record<TargetFeed, readonly string[]> = {
  dashboard_counts: ['dashboard_counts', 'getDashboardCounts'],
  arrivals_departures: ['arrivals_departures', 'getArrivals', 'getDepartures'],
  room_status: ['room_status', 'getRoomStatus'],
  housekeeping: ['housekeeping', 'getHousekeeping'],
  work_orders: ['work_orders', 'getWorkOrders'],
};

/**
 * Collect the union of `knowledge.feeds` and `knowledge.actions` keys. Tolerant
 * of missing/malformed knowledge (returns an empty set) so coverage is
 * deterministic instead of throwing.
 */
function knowledgeKeys(knowledge: unknown): Set<string> {
  const out = new Set<string>();
  if (!knowledge || typeof knowledge !== 'object') return out;
  const k = knowledge as Record<string, unknown>;
  for (const field of ['feeds', 'actions'] as const) {
    const obj = k[field];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const key of Object.keys(obj as Record<string, unknown>)) out.add(key);
    }
  }
  return out;
}

interface KnowledgeFileRow {
  id: string;
  pms_family: string;
  version: number;
  status: string;
  knowledge: unknown;
  learned_at: string;
  promoted_to_active_at: string | null;
  deprecated_at: string | null;
  created_by: string;
  notes: string | null;
  signature: string | null; // bytea → read server-side only to derive `signed`
  signed_with_key_id: string | null;
}

interface MapView {
  id: string;
  pmsFamily: string;
  version: number;
  status: string;
  feedsCovered: TargetFeed[];
  feedsTotal: number;
  /** feat/cua-partial-promotion — targets the gate flagged missing/dead
   *  (from the envelope's feedGaps). Lets the admin tell an improved
   *  partial from a stale one at the Promote decision point; presence-only
   *  feedsCovered counts a structurally-dead (incomplete_columns) feed as
   *  covered, so this is the honest counterweight. */
  gapTargets: string[];
  learnedAt: string;
  promotedToActiveAt: string | null;
  deprecatedAt: string | null;
  createdBy: string;
  notes: string | null;
  signed: boolean;
}

interface FamilyGroup {
  family: string;
  label: string;
  activeCount: number;
  maps: MapView[];
}

// PMS_REGISTRY is keyed by the known PMSType union; pms_family in the DB is a
// free-text column, so look it up defensively and fall back to the raw value.
const REGISTRY_LABELS = PMS_REGISTRY as Record<string, { label?: string } | undefined>;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select(
      'id, pms_family, version, status, knowledge, learned_at, promoted_to_active_at, deprecated_at, created_by, notes, signature, signed_with_key_id',
    )
    .order('pms_family', { ascending: true })
    .order('version', { ascending: false });

  if (error) {
    return err(`Could not load maps: ${error.message}`, {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  const rows = (data ?? []) as KnowledgeFileRow[];

  // Group by family, preserving the query's version-desc order within each.
  const byFamily = new Map<string, MapView[]>();
  for (const r of rows) {
    const keys = knowledgeKeys(r.knowledge);
    const feedsCovered = TARGET_FEEDS.filter((f) => FEED_SOURCE_KEYS[f].some((a) => keys.has(a)));
    const kGaps = (r.knowledge as { feedGaps?: { missingRequired?: Array<{ target: string }>; missingBusinessCritical?: string[] } } | null)?.feedGaps;
    const gapTargets = [
      ...((kGaps?.missingRequired ?? []).map((g) => g.target)),
      ...(kGaps?.missingBusinessCritical ?? []),
    ];
    const view: MapView = {
      id: r.id,
      pmsFamily: r.pms_family,
      version: r.version,
      status: r.status,
      feedsCovered,
      feedsTotal: TARGET_FEEDS.length,
      gapTargets,
      learnedAt: r.learned_at,
      promotedToActiveAt: r.promoted_to_active_at,
      deprecatedAt: r.deprecated_at,
      createdBy: r.created_by,
      notes: r.notes,
      // Matches the robot's verifiable definition: recipe-signing verifyRecipe
      // treats a row as signed only when BOTH the signature and its key id are
      // present. We read those columns server-side only — neither the HMAC nor
      // the key fingerprint is returned to the browser. We can't verify the
      // HMAC here anyway (RECIPE_SIGNING_KEY is Fly-only); the UI just surfaces
      // presence so an admin knows a map might be refused if unsigned.
      signed: r.signature != null && r.signed_with_key_id != null,
    };
    const list = byFamily.get(r.pms_family) ?? [];
    list.push(view);
    byFamily.set(r.pms_family, list);
  }

  const families: FamilyGroup[] = [...byFamily.entries()].map(([family, maps]) => ({
    family,
    label: REGISTRY_LABELS[family]?.label ?? family,
    activeCount: maps.filter((m) => m.status === 'active').length,
    maps,
  }));

  // Families with a live map first, then alphabetical by label.
  families.sort((a, b) => {
    const aHas = a.activeCount > 0 ? 1 : 0;
    const bHas = b.activeCount > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return a.label.localeCompare(b.label);
  });

  return ok({ families }, { requestId });
}
