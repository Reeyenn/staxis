/**
 * GET /api/admin/mapper/coverage?propertyId=<uuid>
 *
 * feature/cua-coverage-editor — the per-feed coverage DETAIL behind
 * /admin/properties/coverage/[propertyId]. Resolves the property's PMS family,
 * loads the family's ACTIVE knowledge file, and returns every data point (feed)
 * the active map captures: its learned columns, its pms_* table, a live row
 * count + small sample FOR THIS PROPERTY, and its trust state.
 *
 * feature/coverage-show-draft — when there is NO active map for the family, this
 * route FALLS BACK to the latest non-deleted PARKED DRAFT (status='draft') and
 * returns it in the SAME activeMap shape, plus `isDraft:true`, `draftId`, and a
 * small `review` subset (verification score/threshold + a short notes reason —
 * never selectors / full knowledge). The page then lets the founder review the
 * draft and "Make live" on one screen. When an active map exists, behaviour is
 * unchanged (no isDraft). The empty state shows only when there's NEITHER.
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
    .select('id, version, status, knowledge, signature, signed_with_key_id, notes, learned_at, disabled_feeds')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (kfErr) {
    return err(`could not load active map: ${kfErr.message}`, { requestId, status: 500, code: 'db_error' });
  }

  const connection = deriveConnection(
    session.status as string,
    (session.last_successful_read_at as string | null) ?? null,
  );
  const familyLabel = (PMS_REGISTRY as Record<string, { label?: string } | undefined>)[pmsFamily]?.label ?? pmsFamily;

  // 2b. NO active map → fall back to the latest non-deleted PARKED DRAFT, so the
  //     founder can review a freshly-learned-but-not-yet-live map on this same
  //     screen (the natural "View what the robot captures →" path) instead of an
  //     empty "No live map yet" state. Additive: when an active map exists this
  //     branch is skipped entirely and the response is byte-identical to before.
  const reviewRow = activeRow ?? await (async () => {
    const { data: draftRow } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id, version, status, knowledge, signature, signed_with_key_id, notes, learned_at, disabled_feeds')
      .eq('pms_family', pmsFamily)
      .eq('status', 'draft')
      .is('deleted_at', null)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    return draftRow ?? null;
  })();

  if (!reviewRow) {
    // Neither active NOR draft (onboarding not started / all discarded).
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

  const isDraft = !activeRow; // reviewRow is the parked draft when there's no active.
  const knowledge = reviewRow.knowledge as unknown;
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
      id: reviewRow.id as string,
      version: reviewRow.version as number,
      status: reviewRow.status as string,
      signed: reviewRow.signature != null && reviewRow.signed_with_key_id != null,
      shape: parsed.shape,
      editable: parsed.editable,
      // feature/coverage-gated-feeds — action keys the session-driver is NOT
      // polling (from pms_knowledge_files.disabled_feeds). On a LIVE map the page
      // uses this to mark each feed "Collecting" vs "Off — Re-read to turn on";
      // on a DRAFT it's typically [] (gating is applied at Make-live). Parsed
      // defensively — a legacy row predating the column omits it → [].
      disabledFeeds: Array.isArray(reviewRow.disabled_feeds)
        ? (reviewRow.disabled_feeds as unknown[]).filter((k): k is string => typeof k === 'string')
        : [],
      // self-repair provenance — the worker records a reanchor's origin as a
      // 'reanchor/' PREFIX on the active row's notes (promoteRecipeChange →
      // saveDraftKnowledgeFile, `${origin}/${decision}: …`). Surface it so the
      // page can show a "Repaired (auto)" pill. Optional; absent when not a
      // reanchor (fresh learn / founder edit).
      ...(((reviewRow.notes as string | null) ?? '').startsWith('reanchor/')
        ? { repaired: true, repairedAt: (reviewRow.learned_at as string | null) ?? null }
        : {}),
      // PARKED DRAFT review — only when there is NO active map and this row is a
      // not-yet-live draft. The page renders the same feeds/columns but with a
      // "review before it goes live" banner + a Make-live button. `review` is a
      // SUBSET of the signed envelope's verification (score/threshold only) plus
      // a short human reason from `notes` — never selectors or full knowledge.
      ...(isDraft
        ? {
            isDraft: true as const,
            draftId: reviewRow.id as string,
            review: buildReview(knowledge, (reviewRow.notes as string | null) ?? null),
          }
        : {}),
    },
    feeds,
    // Only an actions-shaped (editable) map can have feeds added by takeover.
    addableFeeds: parsed.editable ? addableFeeds(presentKeys) : [],
  }, { requestId });
}

/**
 * Build the small `review` subset for a parked draft — the WHY-park summary the
 * founder sees before promoting. Reads `knowledge.verification.{score,threshold}`
 * defensively (never selectors / full knowledge) and a short human `reason` from
 * the draft's `notes`. Every field is optional: a seeded/edit/garbage envelope
 * simply omits the numbers, and an empty notes omits the reason.
 */
function buildReview(
  knowledge: unknown,
  notes: string | null,
): { score?: number; threshold?: number; reason?: string } {
  const out: { score?: number; threshold?: number; reason?: string } = {};
  if (knowledge && typeof knowledge === 'object') {
    const v = (knowledge as { verification?: unknown }).verification;
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (typeof r.score === 'number') out.score = r.score;
      if (typeof r.threshold === 'number') out.threshold = r.threshold;
    }
  }
  const reason = (notes ?? '').trim();
  if (reason) out.reason = reason.length > 200 ? `${reason.slice(0, 197)}…` : reason;
  return out;
}

/** Mirror of src/lib/pms/feed-status.ts deriveConnection (paused set + pending). */
function deriveConnection(status: string, lastRead: string | null): 'healthy' | 'pending' | 'paused' {
  const paused = new Set(['stopped', 'paused_mfa', 'paused_circuit_breaker', 'failed_restart']);
  if (paused.has(status)) return 'paused';
  if (!lastRead) return 'pending';
  return 'healthy';
}
