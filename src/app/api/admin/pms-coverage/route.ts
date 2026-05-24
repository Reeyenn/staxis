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
 *   - coveragePct: 0..100 = captured / 5
 *   - propertyCount: hotels currently on this PMS
 *   - latestJob: most-recent in-flight session (paused_mfa / paused_no_kf /
 *     failed_restart) for any hotel on this PMS — gives the admin a
 *     fast read on "is anyone stuck on this PMS right now"
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
  recipe: {
    id: string;
    version: number;
    createdAt: string;
    actionsCaptured: TargetFeed[];
    actionsMissing: TargetFeed[];
    coveragePct: number;
  } | null;
  propertyCount: number;
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
    .select('id, pms_family, version, learned_at, knowledge')
    .eq('status', 'active');

  if (kfErr) {
    return err(`Could not load knowledge files: ${kfErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const kfRows = (kfRowsRaw ?? []) as KnowledgeFileRow[];

  // ─── Property counts per pms_type ─────────────────────────────────────
  const { data: properties, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('pms_type');

  if (propErr) {
    return err(`Could not load properties: ${propErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const propertyCountByPms = new Map<string, number>();
  for (const p of properties ?? []) {
    const t = (p as { pms_type: string | null }).pms_type;
    if (!t) continue;
    propertyCountByPms.set(t, (propertyCountByPms.get(t) ?? 0) + 1);
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
    if (kf && kf.knowledge && typeof kf.knowledge === 'object') {
      const feeds = (kf.knowledge as { feeds?: Record<string, unknown> }).feeds ?? {};
      for (const f of TARGET_FEEDS) {
        if (feeds[f]) captured.push(f);
        else missing.push(f);
      }
    } else {
      missing.push(...TARGET_FEEDS);
    }

    const recipe = kf
      ? {
          id: kf.id,
          version: kf.version,
          createdAt: kf.learned_at,
          actionsCaptured: captured,
          actionsMissing: missing,
          coveragePct: Math.round((captured.length / TARGET_FEEDS.length) * 100),
        }
      : null;

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
      recipe,
      propertyCount: propertyCountByPms.get(pmsType) ?? 0,
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

  return ok({ pmsTypes: rows }, { requestId });
}
