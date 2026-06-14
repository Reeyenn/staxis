/**
 * GET /api/admin/mapper/coverage?propertyId=<uuid>
 *
 * feature/cua-coverage-editor — the per-feed coverage DETAIL behind
 * /admin/properties/coverage/[propertyId]. Resolves the property's PMS family,
 * loads the family's ACTIVE knowledge file, and returns every data point (feed)
 * the active map captures: its learned columns, its pms_* table, a live row
 * count + small sample FOR THIS PROPERTY, and its trust state.
 *
 * Why a new route (vs /api/admin/live-mapper/maps): that route deliberately
 * drops the `knowledge` jsonb, so it can't show per-feed columns or live counts.
 *
 * The map is PER-FAMILY (shared by every hotel on it); the row counts are
 * per-PROPERTY (pms_* tables are property-scoped). The page surfaces both.
 *
 * Service-role only (pms_knowledge_files + pms_* are deny-all-browser RLS).
 * Auth: requireAdmin.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { PMS_REGISTRY } from '@/lib/pms/registry';
import {
  parseKnowledgeCoverage,
  addableFeeds,
  type FeedView,
} from '@/lib/pms/recipe-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

interface FeedGapsShape {
  missingRequired?: Array<{ target?: unknown }>;
  missingBusinessCritical?: unknown[];
}

type FeedState = 'live' | 'learning';

interface FeedDetail extends FeedView {
  state: FeedState;
  rowCount: number | null;
  sample: Array<Record<string, unknown>>;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  const propertyId = req.nextUrl.searchParams.get('propertyId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(propertyId)) {
    return err('propertyId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  // 1. The property's CUA session → pms_family + connection state.
  const { data: session, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('pms_family, status, last_successful_read_at')
    .eq('property_id', propertyId)
    .maybeSingle();
  if (sessErr) {
    return err(`could not load session: ${sessErr.message}`, { requestId, status: 500, code: 'db_error' });
  }
  if (!session) {
    return err('This property has no CUA session — coverage is only available for hotels the robot polls.', {
      requestId, status: 404, code: 'not_found',
    });
  }
  const pmsFamily = session.pms_family as string;

  // Property name + how many hotels share this family map (so the page can warn
  // that an edit changes every hotel on the family).
  const [{ data: prop }, { count: hotelsOnFamily }] = await Promise.all([
    supabaseAdmin.from('properties').select('display_name').eq('id', propertyId).maybeSingle(),
    supabaseAdmin.from('property_sessions').select('property_id', { count: 'exact', head: true }).eq('pms_family', pmsFamily),
  ]);

  // 2. The family's ACTIVE knowledge file.
  const { data: activeRow, error: kfErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, version, status, knowledge, signature, signed_with_key_id')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .maybeSingle();
  if (kfErr) {
    return err(`could not load active map: ${kfErr.message}`, { requestId, status: 500, code: 'db_error' });
  }

  const connection = deriveConnection(
    session.status as string,
    (session.last_successful_read_at as string | null) ?? null,
  );
  const familyLabel = (PMS_REGISTRY as Record<string, { label?: string } | undefined>)[pmsFamily]?.label ?? pmsFamily;

  if (!activeRow) {
    // No live map yet (onboarding / all drafts). Page shows an empty state.
    return ok({
      propertyId,
      propertyName: (prop?.display_name as string | undefined) ?? propertyId,
      pmsFamily,
      familyLabel,
      hotelsOnFamily: hotelsOnFamily ?? 0,
      connection,
      activeMap: null,
      feeds: [],
      addableFeeds: [],
    }, { requestId });
  }

  const knowledge = activeRow.knowledge as unknown;
  const parsed = parseKnowledgeCoverage(knowledge);

  // Per-feed trust state from the envelope's feedGaps (gap-listing wins over
  // presence — mirror of src/lib/pms/feed-status.ts).
  const gaps = (knowledge && typeof knowledge === 'object'
    ? (knowledge as { feedGaps?: FeedGapsShape }).feedGaps
    : undefined) ?? null;
  const gapped = new Set<string>([
    ...((gaps?.missingRequired ?? []).map((g) => (typeof g?.target === 'string' ? g.target : '')).filter(Boolean)),
    ...((gaps?.missingBusinessCritical ?? []).filter((t): t is string => typeof t === 'string')),
  ]);

  // 3. Live row count + sample per feed (best-effort; a failed table read
  //    degrades that feed's count to null, never the whole response).
  const feeds: FeedDetail[] = await Promise.all(
    parsed.feeds.map(async (f) => {
      const state: FeedState = f.actionKey && gapped.has(f.actionKey) ? 'learning' : 'live';
      let rowCount: number | null = null;
      let sample: Array<Record<string, unknown>> = [];
      if (f.table) {
        try {
          const [{ count }, { data: rows }] = await Promise.all([
            supabaseAdmin.from(f.table).select('property_id', { count: 'exact', head: true }).eq('property_id', propertyId),
            supabaseAdmin.from(f.table).select('*').eq('property_id', propertyId).limit(3),
          ]);
          rowCount = typeof count === 'number' ? count : null;
          sample = (rows as Array<Record<string, unknown>> | null) ?? [];
        } catch {
          rowCount = null;
          sample = [];
        }
      }
      return { ...f, state, rowCount, sample };
    }),
  );

  const presentKeys = new Set(parsed.feeds.map((f) => f.actionKey).filter((k): k is string => !!k));

  return ok({
    propertyId,
    propertyName: (prop?.display_name as string | undefined) ?? propertyId,
    pmsFamily,
    familyLabel,
    hotelsOnFamily: hotelsOnFamily ?? 0,
    connection,
    activeMap: {
      id: activeRow.id as string,
      version: activeRow.version as number,
      status: activeRow.status as string,
      signed: activeRow.signature != null && activeRow.signed_with_key_id != null,
      shape: parsed.shape,
      editable: parsed.editable,
    },
    feeds,
    // Only an actions-shaped (editable) map can have feeds added by takeover.
    addableFeeds: parsed.editable ? addableFeeds(presentKeys) : [],
  }, { requestId });
}

/** Mirror of src/lib/pms/feed-status.ts deriveConnection (paused set + pending). */
function deriveConnection(status: string, lastRead: string | null): 'healthy' | 'pending' | 'paused' {
  const paused = new Set(['stopped', 'paused_mfa', 'paused_circuit_breaker', 'failed_restart']);
  if (paused.has(status)) return 'paused';
  if (!lastRead) return 'pending';
  return 'healthy';
}
