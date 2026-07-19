/**
 * GET /api/admin/pms-coverage
 *
 * Returns one row per supported PMS type with the state of its active
 * v4 knowledge file + how many properties use it. Powers the
 * "PMS coverage" column on the Onboarding tab.
 *
 * Source of truth (post-v4): `public.pms_knowledge_files`. The legacy
 * `pms_recipes` table is read elsewhere by the old mapper but is no
 * longer the canonical store; v4 dispatches off pms_knowledge_files.
 *
 * Coverage is computed against the 5 v4 feeds the new CUA polls (vs
 * the 4 legacy actions the old mapper covered):
 *   - dashboard_counts
 *   - arrivals_departures
 *   - room_status
 *   - housekeeping
 *   - work_orders
 *
 * Per-PMS fields:
 *   - active knowledge file id, version, learned_at (null if not learned)
 *   - feeds captured / missing
 *   - coveragePct: 0..100 = live feeds / learnable feeds (actions-aware, see below)
 *   - propertyCount: hotels currently on this PMS
 *   - latestJob: most-recent in-flight session (paused_mfa / paused_no_kf /
 *     failed_restart) for any hotel on this PMS — gives the admin a
 *     fast read on "is anyone stuck on this PMS right now"
 *
 * COVERAGE % — actions-aware source of truth (was the bug):
 *   The original logic counted the 5 LEGACY snake_case feed keys under
 *   `knowledge.feeds`. Mapper-produced maps store feeds under `knowledge.actions`
 *   (camelCase verbs: getRoomStatus, …) and have NO `knowledge.feeds`, so EVERY
 *   modern map read 0%. We now use parseKnowledgeCoverage() (which understands
 *   both shapes) to enumerate the present feeds, and `knowledge.feedGaps` to mark
 *   each present feed live vs learning — mirroring /api/admin/mapper/coverage and
 *   src/lib/pms/feed-status.ts. Coverage = live feeds / learnable feeds present.
 *
 * Read-only.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { PMS_REGISTRY } from '@/lib/pms/registry';
import type { PMSType } from '@/lib/pms/types';
import {
  computeFamilyCoverage,
  type PerFeed,
} from '@/lib/pms/family-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// The 5 feeds the v4 CUA polls (mirrors pms_knowledge_files.knowledge.feeds keys).
const TARGET_FEEDS = [
  'dashboard_counts',
  'arrivals_departures',
  'room_status',
  'housekeeping',
  'work_orders',
] as const;
type TargetFeed = (typeof TARGET_FEEDS)[number];

interface CoverageRow {
  pmsType: PMSType;
  label: string;
  hint: string;
  tier: 1 | 2 | 3;
  runtime: 'railway' | 'fly';
  /** Friendly name for the LEARNED coverage: COALESCE(display_name, label).
   *  Falls back to the registry label when un-renamed or unlearned. */
  displayName: string;
  /** Actions-aware coverage over learnable feeds (0..100). 0 when unlearned. */
  coveragePct: number;
  /** Per-feed live/learning state of the active coverage. [] when unlearned. */
  perFeed: PerFeed[];
  recipe: {
    id: string;
    version: number;
    createdAt: string;
    actionsCaptured: TargetFeed[];
    actionsMissing: TargetFeed[];
    coveragePct: number;
    /** Plan v8 self-repair — all action_keys present in the active
     *  recipe. Admin Repair button populates its dropdown from this. */
    actionKeys: string[];
  } | null;
  propertyCount: number;
  /** A learned map parked as a DRAFT awaiting founder review — surfaced on the
   *  main list so the "needs review" signal is visible without opening Manage-
   *  maps. Omitted when there's no parked draft for this family. */
  pendingReview?: PendingReview;
  /** Plan v8 self-repair — any property on this PMS family. Repair
   *  jobs need SOME property_id; admin shouldn't have to pick one. */
  representativePropertyId: string | null;
  latestJob: {
    id: string;
    status: string;
    step: string | null;
    progressPct: number | null;
    error: string | null;
    createdAt: string;
  } | null;
}

interface KnowledgeFileRow {
  id: string;
  pms_family: string;
  version: number;
  learned_at: string;
  knowledge: unknown;
  display_name: string | null;
}

/**
 * A parked DRAFT awaiting the founder's review, surfaced on the MAIN coverage
 * list (not just inside Manage-maps). Optional — present only when a family has
 * a non-deleted draft. Carries a SUBSET of the verification verdict only
 * (score/threshold) and a short human reason — NEVER selectors or full
 * knowledge. Mirrors the verify-before-live subset the maps route already echoes.
 */
interface PendingReview {
  version: number;
  score?: number;
  threshold?: number;
  reason?: string;
}

interface DraftRow {
  pms_family: string;
  version: number;
  knowledge: unknown;
  notes: string | null;
  display_name: string | null;
}

/**
 * Read score/threshold out of a draft's `knowledge.verification`, defensively.
 * Subset ONLY (never selectors). Returns {} when the row carries no usable
 * verification telemetry (seeded/edit/legacy drafts), so the badge degrades to
 * just "review" without a confidence figure.
 */
function readDraftVerification(knowledge: unknown): { score?: number; threshold?: number } {
  if (!knowledge || typeof knowledge !== 'object') return {};
  const v = (knowledge as { verification?: unknown }).verification;
  if (!v || typeof v !== 'object') return {};
  const r = v as Record<string, unknown>;
  const out: { score?: number; threshold?: number } = {};
  if (typeof r.score === 'number') out.score = r.score;
  if (typeof r.threshold === 'number') out.threshold = r.threshold;
  return out;
}

/**
 * Distil a draft's `notes` into a short human reason. Strips a leading
 * "<origin>/<decision>: " prefix (e.g. "mapper/park: …") when present, takes
 * the first sentence, and clamps the length. Returns undefined for empty notes.
 */
function shortReason(notes: string | null): string | undefined {
  if (!notes) return undefined;
  // Strip a leading "<origin>/<decision>: " prefix (single slash-joined token
  // pair followed by a colon) if present; otherwise leave the note untouched.
  const stripped = notes.replace(/^\s*[\w-]+\/[\w-]+:\s*/, '').trim();
  if (!stripped) return undefined;
  const firstSentence = stripped.split(/(?<=[.!?])\s/)[0].trim();
  const reason = firstSentence || stripped;
  return reason.length > 140 ? `${reason.slice(0, 137)}…` : reason;
}

/**
 * Narrow-shape guard for the knowledge.feeds jsonb. Returns an empty
 * object when knowledge is missing, isn't an object, or its `feeds`
 * field isn't an object. Keeps the coverage calculation deterministic
 * for malformed rows (every feed shows as missing) without throwing.
 */
function extractFeedsMap(knowledge: unknown): Record<string, unknown> {
  if (!knowledge || typeof knowledge !== 'object') return {};
  const feeds = (knowledge as Record<string, unknown>).feeds;
  if (!feeds || typeof feeds !== 'object' || Array.isArray(feeds)) return {};
  return feeds as Record<string, unknown>;
}

/**
 * Plan v8 self-repair — list of action_keys in the active recipe.
 * Used by the admin Repair button to populate its target dropdown.
 * Mapper-produced recipes store these under `knowledge.actions`; the
 * legacy hand-seeded migration 0203 stored them under `knowledge.feeds`
 * — return both so the button shows targets either way.
 */
function extractActionKeys(knowledge: unknown): string[] {
  if (!knowledge || typeof knowledge !== 'object') return [];
  const k = knowledge as Record<string, unknown>;
  const fromActions = (k.actions && typeof k.actions === 'object' && !Array.isArray(k.actions))
    ? Object.keys(k.actions as Record<string, unknown>)
    : [];
  const fromFeeds = (k.feeds && typeof k.feeds === 'object' && !Array.isArray(k.feeds))
    ? Object.keys(k.feeds as Record<string, unknown>)
    : [];
  return Array.from(new Set([...fromActions, ...fromFeeds]));
}

interface PropertySessionRow {
  property_id: string;
  pms_family: string;
  status: string;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  // ─── Active knowledge files per PMS family (one per family by partial
  //     unique index, see migration 0201). ────────────────────────────────
  const { data: kfRowsRaw, error: kfErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, pms_family, version, learned_at, knowledge, display_name')
    .eq('status', 'active')
    .is('deleted_at', null); // 0288 — hide soft-deleted coverages from the studio

  if (kfErr) {
    return err(`Could not load knowledge files: ${kfErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const kfRows = (kfRowsRaw ?? []) as KnowledgeFileRow[];

  // ─── Parked DRAFTS per PMS family (latest non-deleted draft each). ─────
  //     Surfaces the "a new map is parked for review" signal on the MAIN list
  //     so the founder sees it without opening Manage-maps. Subset only —
  //     never the full knowledge/selectors (see PendingReview).
  const { data: draftRowsRaw, error: draftErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('pms_family, version, knowledge, notes, display_name')
    .eq('status', 'draft')
    .is('deleted_at', null)
    .order('version', { ascending: false });

  if (draftErr) {
    return err(`Could not load draft maps: ${draftErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  // Keep the highest-version draft per family (query is version-desc, so the
  // first one seen per family wins).
  const latestDraftByFamily = new Map<string, DraftRow>();
  for (const d of (draftRowsRaw ?? []) as DraftRow[]) {
    if (!latestDraftByFamily.has(d.pms_family)) latestDraftByFamily.set(d.pms_family, d);
  }

  // ─── Property counts per pms_type ─────────────────────────────────────
  const { data: properties, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, pms_type');

  if (propErr) {
    return err(`Could not load properties: ${propErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const propertyCountByPms = new Map<string, number>();
  // Plan v8 self-repair — also remember ONE representative property_id
  // per PMS family, so the admin Repair button can target a real
  // property without making the admin pick one.
  const representativePropIdByPms = new Map<string, string>();
  // Hotels with no system detected (pms_type IS NULL) — the count the studio
  // shows as "unassigned hotels" so the founder knows how many need matching.
  let unassignedHotelCount = 0;
  for (const p of properties ?? []) {
    const row = p as { pms_type: string | null; id?: string };
    const t = row.pms_type;
    if (!t) { unassignedHotelCount += 1; continue; }
    propertyCountByPms.set(t, (propertyCountByPms.get(t) ?? 0) + 1);
    if (row.id && !representativePropIdByPms.has(t)) {
      representativePropIdByPms.set(t, row.id);
    }
  }

  // ─── Most-recent in-flight session per pms_family. ────────────────────
  // Surfaces "is anyone stuck on this PMS right now" — paused_mfa /
  // paused_no_knowledge_file / failed_restart are the interesting states.
  const { data: sessionsRaw, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id, pms_family, status, paused_reason, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(200);

  if (sessErr) {
    return err(`Could not load sessions: ${sessErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const sessions = (sessionsRaw ?? []) as PropertySessionRow[];

  // Keep the most-recent non-alive session per family — that's the one
  // surfaced as "latest job".
  const NON_ALIVE = new Set(['paused_mfa', 'paused_no_knowledge_file', 'paused_circuit_breaker', 'failed_restart', 'stopped', 'paused_cost_cap']);
  const latestNonAliveByFamily = new Map<string, PropertySessionRow>();
  for (const s of sessions) {
    if (!NON_ALIVE.has(s.status)) continue;
    if (!latestNonAliveByFamily.has(s.pms_family)) {
      latestNonAliveByFamily.set(s.pms_family, s);
    }
  }

  // Helper: derive (status, step, progress) from a session row for the
  // legacy CoverageRow.latestJob shape.
  const mapSessionForLatestJob = (s: PropertySessionRow) => {
    let status = 'running';
    let step: string | null = null;
    let progress: number | null = null;
    switch (s.status) {
      case 'paused_mfa':
        status = 'mapping'; step = 'Waiting for MFA'; progress = 70; break;
      case 'paused_no_knowledge_file':
        status = 'mapping'; step = 'Awaiting mapper'; progress = 50; break;
      case 'paused_cost_cap':
        status = 'running'; step = 'Cost cap tripped'; progress = 90; break;
      case 'paused_circuit_breaker':
      case 'failed_restart':
        status = 'failed'; step = 'Login / read failures'; break;
      case 'stopped':
        status = 'cancelled'; step = 'Stopped by admin'; break;
    }
    return { status, step, progress };
  };

  // ─── Assemble rows ─────────────────────────────────────────────────────
  // Skip 'other' — it's a catch-all input value, not a real PMS.
  const pmsTypes = Object.keys(PMS_REGISTRY).filter((t) => t !== 'other') as PMSType[];

  const rows: CoverageRow[] = pmsTypes.map((pmsType) => {
    const def = PMS_REGISTRY[pmsType];
    const kf = kfRows.find((k) => k.pms_family === pmsType);

    const captured: TargetFeed[] = [];
    const missing: TargetFeed[] = [];
    const feeds = extractFeedsMap(kf?.knowledge);
    for (const f of TARGET_FEEDS) {
      if (feeds[f]) captured.push(f);
      else missing.push(f);
    }

    // Actions-aware coverage (the bug fix): live/learning per-feed + a % over
    // learnable feeds that understands both the modern `actions` shape and the
    // legacy `feeds` shape. The legacy snake_case captured/missing arrays below
    // are kept for back-compat with already-deployed clients.
    const { perFeed, coveragePct } = kf
      ? computeFamilyCoverage(kf.knowledge)
      : { perFeed: [] as PerFeed[], coveragePct: 0 };

    // Resolve the friendly name from active-OR-latest-draft (matches the rename
    // route): a draft-only family (no active map yet, e.g. a parked Choice
    // Advantage) still shows its renamed label instead of the registry default.
    const displayName = kf?.display_name || latestDraftByFamily.get(pmsType)?.display_name || def.label;

    const recipe = kf
      ? {
          id: kf.id,
          version: kf.version,
          createdAt: kf.learned_at,
          actionsCaptured: captured,
          actionsMissing: missing,
          // Top-level coveragePct is the source of truth now; keep recipe-level
          // in sync (was the legacy captured/5 — actions maps always read 0).
          coveragePct,
          // Plan v8 self-repair — full action_keys list for the Repair button.
          actionKeys: extractActionKeys(kf.knowledge),
        }
      : null;

    // Parked draft awaiting review (if any) — subset only.
    const draft = latestDraftByFamily.get(pmsType);
    const pendingReview: PendingReview | undefined = draft
      ? {
          version: draft.version,
          ...readDraftVerification(draft.knowledge),
          ...((): { reason?: string } => {
            const reason = shortReason(draft.notes);
            return reason ? { reason } : {};
          })(),
        }
      : undefined;

    const session = latestNonAliveByFamily.get(pmsType);
    let latestJob: CoverageRow['latestJob'] = null;
    if (session) {
      const m = mapSessionForLatestJob(session);
      latestJob = {
        id: session.property_id,
        status: m.status,
        step: m.step,
        progressPct: m.progress,
        error: session.paused_reason,
        createdAt: session.updated_at,
      };
    }

    return {
      pmsType,
      label: def.label,
      hint: def.hint,
      tier: def.tier,
      runtime: def.runtime,
      displayName,
      coveragePct,
      perFeed,
      recipe,
      propertyCount: propertyCountByPms.get(pmsType) ?? 0,
      ...(pendingReview ? { pendingReview } : {}),
      representativePropertyId: representativePropIdByPms.get(pmsType) ?? null,
      latestJob,
    };
  });

  // Sort: PMSes WITH active knowledge files first (by coverage desc),
  // then unmapped (by property count desc — most-needed first).
  rows.sort((a, b) => {
    const aHas = a.recipe ? 1 : 0;
    const bHas = b.recipe ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    if (a.recipe && b.recipe) return b.recipe.coveragePct - a.recipe.coveragePct;
    return b.propertyCount - a.propertyCount;
  });

  return ok({ pmsTypes: rows, unassignedHotelCount }, { requestId });
}
