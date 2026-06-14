/**
 * /api/admin/cua-sessions
 *
 * GET  — list every property_sessions row + a compact knowledge-file
 *        summary for the hotel's pms_family. Backs /admin/property-sessions.
 *
 * POST — admin actions on a single session:
 *          { propertyId, action: 'resume_mfa' | 'reset_cost_cap' | 'stop' | 'restart' }
 *
 * Service-role only via supabaseAdmin. Auth: cron secret OR signed-in
 * admin via requireAdminOrCron.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PropertySessionRow {
  property_id: string;
  pms_family: string;
  status: string;
  last_alive_at: string | null;
  last_successful_read_at: string | null;
  current_browser_url: string | null;
  daily_claude_cost_micros: number;
  daily_claude_cost_resets_at: string | null;
  paused_reason: string | null;
  paused_until: string | null;
  worker_machine_id: string | null;
  restart_count: number;
  read_failure_streak: number;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

interface PropertyRow {
  id: string;
  display_name: string | null;
}

interface KnowledgeRow {
  pms_family: string;
  version: number;
  status: string;
  learned_at: string;
  /** feat/cua-partial-promotion — knowledge->feedGaps (JSON path select). */
  feed_gaps: {
    missingRequired?: Array<{ target: string; reason: string; missingColumns?: string[] }>;
    missingBusinessCritical?: string[];
  } | null;
}

interface MapperJobRow {
  id: string;
  property_id: string;
  status: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/** Compact mapper-job summary attached to each session row. */
interface MapperJobSummary {
  id: string;
  status: string;
  created_at: string;
  /** Active jobs only — true when a pending help request is waiting (the
   *  robot is stuck and idling for the founder's click). Drives the red
   *  "it needs you" treatment on the fleet card, so a founder whose
   *  heartbeat keeps the robot waiting can actually SEE the request. */
  needs_help?: boolean;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;

  const [
    { data: sessionRows, error: sessErr },
    { data: kfRows, error: kfErr },
    { data: activeJobRows, error: activeJobErr },
    { data: termJobRows, error: termJobErr },
  ] = await Promise.all([
    supabaseAdmin
      .from('property_sessions')
      .select(
        'property_id, pms_family, status, last_alive_at, last_successful_read_at, current_browser_url, daily_claude_cost_micros, daily_claude_cost_resets_at, paused_reason, paused_until, worker_machine_id, restart_count, read_failure_streak, notes, created_at, updated_at',
      )
      .order('updated_at', { ascending: false }),
    supabaseAdmin
      .from('pms_knowledge_files')
      .select('pms_family, version, status, learned_at, feed_gaps:knowledge->feedGaps')
      .order('pms_family')
      .order('version', { ascending: false }),
    // Learning Board — mapper jobs so each session card can link to the
    // live board. Mapper jobs are enqueued once per PMS FAMILY (with one
    // representative property_id), so matching below is by family OR
    // property. Active jobs are fetched UNCAPPED (inherently few — one per
    // family being learned); terminal jobs capped at the most recent 100,
    // which only feed the "see the last run" link.
    supabaseAdmin
      .from('workflow_jobs')
      .select('id, property_id, status, payload, created_at')
      .like('kind', 'mapper.%')
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('workflow_jobs')
      .select('id, property_id, status, payload, created_at')
      .like('kind', 'mapper.%')
      .in('status', ['completed', 'failed', 'cancelled'])
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  if (sessErr) return NextResponse.json({ ok: false, error: sessErr.message }, { status: 500 });
  if (kfErr) return NextResponse.json({ ok: false, error: kfErr.message }, { status: 500 });
  if (activeJobErr) return NextResponse.json({ ok: false, error: activeJobErr.message }, { status: 500 });
  if (termJobErr) return NextResponse.json({ ok: false, error: termJobErr.message }, { status: 500 });

  const sessions = (sessionRows ?? []) as PropertySessionRow[];

  // Hydrate property display names.
  const propertyIds = sessions.map((s) => s.property_id);
  let displayNames = new Map<string, string>();
  if (propertyIds.length > 0) {
    const { data: propsData } = await supabaseAdmin
      .from('properties')
      .select('id, display_name')
      .in('id', propertyIds);
    if (propsData) {
      displayNames = new Map((propsData as PropertyRow[]).map((p) => [p.id, p.display_name ?? p.id]));
    }
  }

  // Group knowledge files by pms_family; keep active version + most recent
  // draft + (feat/cua-partial-promotion) the ACTIVE version's feed gaps so
  // the admin page can show "Partial — missing: …" without another query.
  interface FamilyKnowledge {
    active: number | null;
    latest: number;
    status: string;
    missing_required: string[];
    missing_business_critical: string[];
    /** Newest row with status='draft' — the founder's review queue. Keyed
     *  explicitly (hunter re-review P2-3): keying "awaiting review" off the
     *  LATEST row's status hid the parked draft whenever a newer
     *  quarantined/deprecated row existed, while the backfill cron's
     *  draft-awaiting gate stayed latched on it with no visible explanation. */
    newest_draft: number | null;
  }
  const knowledgeByFamily = new Map<string, FamilyKnowledge>();
  for (const k of (kfRows ?? []) as KnowledgeRow[]) {
    const existing = knowledgeByFamily.get(k.pms_family);
    const gapsOf = (row: KnowledgeRow) => ({
      missing_required: (row.feed_gaps?.missingRequired ?? []).map((g) => g.target),
      missing_business_critical: row.feed_gaps?.missingBusinessCritical ?? [],
    });
    if (!existing) {
      knowledgeByFamily.set(k.pms_family, {
        active: k.status === 'active' ? k.version : null,
        latest: k.version,
        status: k.status,
        newest_draft: k.status === 'draft' ? k.version : null,
        ...(k.status === 'active' ? gapsOf(k) : { missing_required: [], missing_business_critical: [] }),
      });
    } else {
      if (k.status === 'active') {
        existing.active = k.version;
        const g = gapsOf(k);
        existing.missing_required = g.missing_required;
        existing.missing_business_critical = g.missing_business_critical;
      }
      if (k.status === 'draft' && existing.newest_draft === null) {
        existing.newest_draft = k.version; // versions sorted desc → first draft = newest
      }
      // versions are sorted desc so first is latest
    }
  }

  const activeJobs = (activeJobRows ?? []) as MapperJobRow[];
  const terminalJobs = (termJobRows ?? []) as MapperJobRow[];
  const jobMatchesSession = (j: MapperJobRow, s: PropertySessionRow): boolean => {
    if (j.property_id === s.property_id) return true;
    const family = j.payload && typeof j.payload.pms_family === 'string' ? j.payload.pms_family : null;
    return family !== null && family === s.pms_family;
  };

  // Pending help requests on the active jobs — the robot is stuck and
  // idling for the founder's click; the fleet card must show RED, not a
  // calm caramel "learning" banner (the heartbeat from that very page is
  // what makes the robot wait).
  const needsHelpJobIds = new Set<string>();
  if (activeJobs.length > 0) {
    const { data: helpRows } = await supabaseAdmin
      .from('mapping_help_requests')
      .select('job_id')
      .eq('status', 'pending')
      .in('job_id', activeJobs.map((j) => j.id));
    for (const r of (helpRows ?? []) as Array<{ job_id: string }>) {
      needsHelpJobIds.add(r.job_id);
    }
  }

  // feat/cua-partial-promotion — best-effort retry context per family: the
  // latest backfill job's age + outcome, so the chip can say "auto-retrying
  // daily" vs "auto-retry paused" truthfully. Failure here only loses the
  // retry line, never the session list.
  const backfillByFamily = new Map<string, { last_at: string; last_outcome: string }>();
  try {
    const { data: backfillJobs } = await supabaseAdmin
      .from('workflow_jobs')
      .select('created_at, status, result, payload')
      .eq('kind', 'mapper.learn_pms_family')
      .filter('payload->>backfill_missing_feeds', 'eq', 'true')
      .order('created_at', { ascending: false })
      .limit(50);
    for (const j of (backfillJobs ?? []) as Array<{ created_at: string; status: string; result: { promotion_decision?: string } | null; payload: { pms_family?: string } | null }>) {
      const fam = j.payload?.pms_family;
      if (!fam || backfillByFamily.has(fam)) continue;
      backfillByFamily.set(fam, {
        last_at: j.created_at,
        last_outcome: j.result?.promotion_decision ?? j.status,
      });
    }
  } catch { /* best-effort */ }

  const enriched = sessions.map((s) => {
    // Rows are newest-first, so find() = most recent.
    const active = activeJobs.find((j) => jobMatchesSession(j, s));
    // feature/cua-live-assist — findability fix: a finished learning run must
    // be reopenable for ANY session, not only paused_no_knowledge_file ones.
    // Previously, once a session went alive/stopped/failed the link vanished
    // and the board was reachable only by hand-typing the URL. terminalJobs is
    // already fetched (newest-first, capped); surface the most-recent matching
    // terminal run whenever nothing is actively running, plus up to 5 recent
    // runs for a "past runs" list.
    const matchingTerminal = terminalJobs.filter((j) => jobMatchesSession(j, s)); // newest-first
    const last = !active ? matchingTerminal[0] : undefined;
    return {
      ...s,
      display_name: displayNames.get(s.property_id) ?? s.property_id,
      knowledge_file: knowledgeByFamily.get(s.pms_family) ?? null,
      active_mapper_job: active
        ? ({ id: active.id, status: active.status, created_at: active.created_at, needs_help: needsHelpJobIds.has(active.id) } satisfies MapperJobSummary)
        : null,
      last_mapper_job: last
        ? ({ id: last.id, status: last.status, created_at: last.created_at } satisfies MapperJobSummary)
        : null,
      recent_mapper_jobs: matchingTerminal.slice(0, 5).map((j) =>
        ({ id: j.id, status: j.status, created_at: j.created_at } satisfies MapperJobSummary)),
      backfill: backfillByFamily.get(s.pms_family) ?? null,
    };
  });

  return NextResponse.json({ ok: true, data: { sessions: enriched } });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;

  let body: { propertyId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const propertyId = body.propertyId;
  const action = body.action;
  if (!propertyId || !action) {
    return NextResponse.json(
      { ok: false, error: 'propertyId and action required' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  switch (action) {
    case 'resume_mfa':
      // Flip status back to 'starting'; supervisor reconcile picks it up
      // and respawns the driver. New driver attempts login with whatever
      // storageState is now in scraper_session.
      patch = { status: 'starting', paused_reason: null, paused_until: null };
      break;
    case 'reset_cost_cap':
      patch = {
        status: 'alive',
        daily_claude_cost_micros: 0,
        daily_claude_cost_resets_at: now,
        paused_reason: null,
        paused_until: null,
      };
      break;
    case 'stop':
      patch = { status: 'stopped', paused_reason: 'Admin stop', paused_until: null };
      break;
    case 'restart':
      patch = { status: 'starting', restart_count: 0, paused_reason: null, paused_until: null };
      break;
    default:
      return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('property_sessions')
    .update(patch)
    .eq('property_id', propertyId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, data: { propertyId, action, patch } });
}
