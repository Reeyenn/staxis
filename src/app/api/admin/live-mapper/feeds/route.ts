/**
 * GET /api/admin/live-mapper/feeds?pmsFamily=<family>
 *
 * Admin-only. Per-feed coverage for ONE family's LIVE map — the data behind the
 * "Show feeds" expander in the Manage-maps modal (MapsManager). The map manager
 * already lists map VERSIONS (promote / take offline / delete a whole map); this
 * drills into the live map's individual feeds so an admin can VIEW each feed's
 * learned columns and re-point (Edit) or remove (Delete) a single feed.
 *
 * What it returns (per feed):
 *   - key / actionKey / label
 *   - the learned columns (name → selector) for VIEW, via columnsFromAction
 *   - required (REQUIRED_ACTION_KEYS) — Delete is hidden for these (the
 *     delete-feed route refuses them anyway; this is the UX mirror)
 *   - learnable (LEARNABLE_ACTION_KEYS) / drilldown (DRILLDOWN_ACTION_KEYS) /
 *     canTakeover (learnable AND not drill-down) — Edit is only offered when
 *     canTakeover, matching POST /api/admin/mapper/coverage/edit-feed's gate
 *   - rowCount — best-effort live row count for that feed's pms_* table, scoped
 *     to the representative property (tolerates read failure → null)
 *   - editable — false for a legacy knowledge.feeds map (must be re-learned once
 *     before per-feed edit/delete works; the UI gates on this)
 *
 * Plus ONE representative propertyId for the family (the recipe is family-scoped,
 * so any logged-in session on the family drives an edit/delete run). The
 * edit-feed / delete-feed routes re-derive pms_family from THIS property's
 * session and re-validate against the LIVE active map, so the representative
 * property is only a starting point, never trusted.
 *
 * Privacy: the raw knowledge envelope and the HMAC signature are NEVER returned;
 * only per-feed columns + flags. Read-only — no mutation, no signing.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role; pms_knowledge_files is
 * deny-all-browser per migration 0201).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  parseKnowledgeCoverage,
  REQUIRED_ACTION_KEYS,
  LEARNABLE_ACTION_KEYS,
  DRILLDOWN_ACTION_KEYS,
} from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface KnowledgeRow {
  id: string;
  version: number;
  status: string;
  knowledge: unknown;
}

interface FeedRow {
  key: string;
  actionKey: string | null;
  label: string;
  table: string | null;
  /** Learned columns (name → selector) for the VIEW panel. Empty for legacy. */
  columns: Record<string, string>;
  required: boolean;
  learnable: boolean;
  drilldown: boolean;
  /** Edit (re-point via takeover) is only offered when true. */
  canTakeover: boolean;
  /** Best-effort live row count for the feed's pms_* table (rep property), or null. */
  rowCount: number | null;
  source: 'actions' | 'legacy';
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const pmsFamily = req.nextUrl.searchParams.get('pmsFamily')?.trim() ?? '';
  if (!pmsFamily) {
    return err('pmsFamily required', { requestId, status: 400, code: 'bad_request' });
  }

  // The LIVE (active) map for the family — that's the one drives every hotel
  // and the one edit/delete-feed act on. Soft-deleted rows excluded.
  const { data: activeRow, error: loadErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, status, knowledge')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle<KnowledgeRow>();

  if (loadErr) {
    return err(`Could not load the map: ${loadErr.message}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  if (!activeRow) {
    // No live map — surface an empty (but successful) shape so the expander can
    // say "nothing to edit yet" instead of erroring.
    return ok(
      { pmsFamily, propertyId: null, mapVersion: null, editable: false, shape: 'empty', feeds: [] },
      { requestId },
    );
  }

  // ONE representative property on the family — the recipe is family-scoped, so
  // any logged-in session works to drive an edit/delete run. The mutating routes
  // re-derive pms_family from this property's session, so it's only a seed.
  const { data: sessionRow } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id')
    .eq('pms_family', pmsFamily)
    .limit(1)
    .maybeSingle();
  const propertyId = (sessionRow?.property_id as string | undefined) ?? null;

  const parsed = parseKnowledgeCoverage(activeRow.knowledge);

  // Best-effort per-feed live row counts, scoped to the representative property.
  // Every pms_* table has property_id (migrations 0201–0203). A read failure on
  // any one count must never break the feed list — default to null (no badge).
  const feeds: FeedRow[] = await Promise.all(
    parsed.feeds.map(async (f): Promise<FeedRow> => {
      let rowCount: number | null = null;
      if (propertyId && f.table) {
        try {
          const { count, error: countErr } = await supabaseAdmin
            .from(f.table)
            .select('property_id', { count: 'exact', head: true })
            .eq('property_id', propertyId);
          if (!countErr && typeof count === 'number') rowCount = count;
        } catch {
          // tolerate — leave rowCount null
        }
      }
      return {
        key: f.key,
        actionKey: f.actionKey,
        label: f.label,
        table: f.table,
        columns: f.columns,
        required: f.actionKey ? REQUIRED_ACTION_KEYS.has(f.actionKey) : f.required,
        learnable: f.actionKey ? LEARNABLE_ACTION_KEYS.has(f.actionKey) : false,
        drilldown: f.actionKey ? DRILLDOWN_ACTION_KEYS.has(f.actionKey) : false,
        canTakeover: f.canTakeover,
        rowCount,
        source: f.source,
      };
    }),
  );

  return ok(
    {
      pmsFamily,
      propertyId,
      mapVersion: activeRow.version,
      editable: parsed.editable,
      shape: parsed.shape,
      feeds,
    },
    { requestId },
  );
}
