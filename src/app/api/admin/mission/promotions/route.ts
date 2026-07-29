/**
 * /api/admin/mission/promotions — the founder's knowledge promotion queue.
 *
 * Staxis AI holds knowledge in three tiers: GLOBAL → PMS/BRAND FAMILY → THIS
 * HOTEL, and hotel-specific always wins. Anything moving UP a tier — a lesson
 * learned at one hotel becoming knowledge shared with hotels that never
 * generated it — crosses a privacy boundary, so it is the founder's decision
 * alone. Hotels must never see this queue and must never learn that their data
 * contributed, which is why this lives on /api/admin behind `requireAdmin`
 * (session + role='admin'), NOT on requireAdminOrCron: no cron drives it and
 * the shared CRON_SECRET has too many holders for a surface that names which
 * hotels supplied which evidence.
 *
 * THIS IS NOT THE HOTEL-FACING QUEUE. A GM approving "order towels" or "flip
 * room 214" is agent_pending_actions. Different audience, different
 * consequences. Never merge them.
 *
 *   GET  → { available, pending[], promoted[], counts }
 *   POST → { id, decision: approve | reject | retract | reconfirm, content?, note? }
 *
 * Migration 0353 is applied by hand, so both verbs survive the table being
 * absent: GET answers `available:false` with empty lists instead of 500ing the
 * Mission Control surface.
 *
 * SIDE EFFECTS. An item may carry a target row (today only agent_prompts).
 * Approving activates it; retracting puts back whatever was active before
 * (previous_target_row_id) — without that, retracting a base-prompt promotion
 * would leave the copilot with NO active base prompt.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateEnum, validateString, validateUuid } from '@/lib/api-validate';
import {
  type PromotionRow,
  type PreconditionFacts,
  countNeedingAttention,
  daysUntilExpiry,
  describeEvidence,
  expiryFrom,
  isExpired,
  isMissingRelationError,
  meetsEvidenceBar,
  plainLockReason,
  promotionJourney,
  promotionOriginLabel,
  shortClaim,
  tierLabel,
  unmetPreconditions,
} from '@/lib/promotion-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const SELECT_COLUMNS =
  'id, topic, claim, evidence_summary, proposed_content, final_content, source_tier, target_tier, ' +
  'pms_family, origin, source_kind, source_ref, source_property_ids, supporting_hotel_count, ' +
  'observation_count, evidence_window_start, evidence_window_end, holdout_validated, is_aggregate, ' +
  'preconditions, target_table, target_row_id, previous_target_row_id, status, decided_at, ' +
  'decided_by_account_id, decision_note, approved_at, expires_at, reconfirmed_at, reconfirm_count, ' +
  'retracted_at, applied_property_ids, created_at, updated_at';

/** What the panel renders. Derived fields are computed here so the browser
 *  never has to know the promotion rules. */
interface PromotionView {
  id: string;
  topic: string;
  claim: string;
  evidenceSummary: string | null;
  proposedContent: string;
  liveContent: string | null;
  status: PromotionRow['status'];
  origin: PromotionRow['origin'];
  /** The claim cut to two lines. Full text stays on `claim`, under Details. */
  headline: string;
  headlineTruncated: boolean;
  /** "Written by hand" / "Learned from hotels" — the card's eyebrow. */
  originLabel: string;
  /** Where it lives now → where it is asking to go, in plain words. */
  journey: { from: string; to: string };
  /** ONE plain sentence for why Approve is off. Empty exactly when
   *  `blockedReasons` is empty — the same verdict, said shorter. */
  lockReason: string;
  /** Plain English: "Every hotel" / "Every hotel on choice advantage". */
  audience: string;
  /** Plain English: where it came from. */
  cameFrom: string;
  /** Plain English: how strong the evidence is. */
  evidence: string;
  supportingHotels: number;
  observations: number;
  isAggregate: boolean;
  /** Empty when the evidence clears the bar for the tier it wants to enter. */
  barReason: string;
  /** Plain-English reasons Approve is disabled. Empty = approvable. */
  blockedReasons: string[];
  /** True for a live item whose 75 days ran out — needs re-confirming. */
  expired: boolean;
  daysLeft: number | null;
  reconfirmCount: number;
  approvedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Who this reached (or would reach) while live. */
  blastRadius: { count: number; hotels: Array<{ id: string; name: string }> };
  changesBehaviour: boolean;
  createdAt: string;
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  agent_memory: 'Something one hotel taught the copilot',
  consolidation: 'The nightly "what Staxis learned" review',
  eval: 'A test run against the copilot',
  extraction: 'Reading a hotel report',
  migration: 'Written by hand during a build',
  human: 'Typed in by a person',
};

function cameFromLabel(row: PromotionRow): string {
  const base = SOURCE_KIND_LABEL[row.source_kind] ?? row.source_kind.replace(/_/g, ' ');
  return row.source_ref ? `${base} (${row.source_ref})` : base;
}

// ── GET — the queue ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('knowledge_promotions')
    .select(SELECT_COLUMNS)
    .in('status', ['pending', 'approved'])
    .order('created_at', { ascending: false });

  if (error) {
    // Deploy landed before the migration was applied by hand. Say so plainly
    // rather than breaking the surface that hosts the panel.
    if (isMissingRelationError(error)) {
      return ok(
        { available: false, pending: [], promoted: [], counts: { pending: 0, promoted: 0, expired: 0, needsAttention: 0 } },
        { requestId, headers: NO_STORE },
      );
    }
    return err(error.message, { requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE });
  }

  const rows = (data ?? []) as unknown as PromotionRow[];
  const now = new Date();
  const facts = await gatherPreconditionFacts();
  const hotels = await loadHotels();

  const views = rows.map((r) => toView(r, now, facts, hotels));
  const pending = views.filter((v) => v.status === 'pending');
  const promoted = views.filter((v) => v.status === 'approved');

  return ok(
    {
      available: true,
      pending,
      promoted,
      counts: {
        pending: pending.length,
        promoted: promoted.length,
        expired: promoted.filter((v) => v.expired).length,
        needsAttention: countNeedingAttention(rows, now),
      },
    },
    { requestId, headers: NO_STORE },
  );
}

// ── POST — approve / reject / retract / reconfirm ──────────────────────────

type Decision = 'approve' | 'reject' | 'retract' | 'reconfirm';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err('Invalid JSON body.', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
  }

  const idCheck = validateUuid(body.id, 'id');
  if (idCheck.error) {
    return err(idCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
  }
  const id = idCheck.value as string;

  const decisionCheck = validateEnum<Decision>(
    body.decision,
    ['approve', 'reject', 'retract', 'reconfirm'],
    'decision',
  );
  if (decisionCheck.error) {
    return err(decisionCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
  }
  const decision = decisionCheck.value as Decision;

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== '') {
    const noteCheck = validateString(body.note, { label: 'note', max: 1000 });
    if (noteCheck.error) {
      return err(noteCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
    }
    note = noteCheck.value ?? null;
  }

  // Edit-then-approve: the founder can reword the text before it goes live.
  let editedContent: string | null = null;
  if (body.content !== undefined && body.content !== null && body.content !== '') {
    const contentCheck = validateString(body.content, { label: 'content', min: 1, max: 8000 });
    if (contentCheck.error) {
      return err(contentCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
    }
    editedContent = contentCheck.value ?? null;
  }

  const { data: rowData, error: readErr } = await supabaseAdmin
    .from('knowledge_promotions')
    .select(SELECT_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (readErr) {
    if (isMissingRelationError(readErr)) {
      return err('The promotion queue is not set up on this database yet.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure, headers: NO_STORE,
      });
    }
    return err(readErr.message, { requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE });
  }
  if (!rowData) {
    return err('That item is no longer in the queue.', {
      requestId, status: 404, code: ApiErrorCode.NotFound, headers: NO_STORE,
    });
  }
  const row = rowData as unknown as PromotionRow;
  const accountId = auth.accountId;

  switch (decision) {
    case 'approve':
      return approve(row, { requestId, accountId, note, editedContent });
    case 'reject':
      return reject(row, { requestId, accountId, note });
    case 'retract':
      return retract(row, { requestId, accountId, note });
    case 'reconfirm':
      return reconfirm(row, { requestId, accountId });
  }
}

interface DecisionCtx {
  requestId: string;
  accountId: string;
  note: string | null;
  editedContent?: string | null;
}

// ── approve ────────────────────────────────────────────────────────────────

async function approve(row: PromotionRow, ctx: DecisionCtx) {
  const { requestId } = ctx;
  if (row.status !== 'pending') {
    return err(`This item was already ${row.status}.`, {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE,
    });
  }

  // Re-check the bar server-side. The DB CHECK guarded the insert; this guards
  // against a row whose evidence was edited between proposal and decision.
  const bar = meetsEvidenceBar(row);
  if (!bar.ok) {
    return err(bar.reason, { requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
  }

  const facts = await gatherPreconditionFacts();
  const blocked = unmetPreconditions(row, facts);
  if (blocked.length > 0) {
    return err(blocked[0], { requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE });
  }

  const finalContent = ctx.editedContent ?? row.proposed_content;
  const now = new Date();

  // What is live in this tier right now — remembered so a retract can put it
  // back rather than leaving the tier empty.
  let previousRowId: string | null = null;
  let targetRole: string | null = null;
  let targetFamily: string | null = null;
  if (row.target_table === 'agent_prompts' && row.target_row_id) {
    const target = await readPromptRow(row.target_row_id);
    if (!target) {
      return err('The instruction this item points at no longer exists.', {
        requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE,
      });
    }
    targetRole = target.role;
    targetFamily = target.pms_family;
    previousRowId = await readActivePromptId(target.role, target.pms_family, row.target_row_id);
  }

  // Claim the item first: a conditional UPDATE on status='pending' means two
  // concurrent approvals can never both take effect.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('knowledge_promotions')
    .update({
      status: 'approved',
      final_content: finalContent,
      approved_at: now.toISOString(),
      expires_at: expiryFrom(now),
      decided_at: now.toISOString(),
      decided_by_account_id: ctx.accountId,
      decision_note: ctx.note,
      previous_target_row_id: previousRowId,
      applied_property_ids: await propertyIdsInScope(row),
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (claimErr) {
    return err(claimErr.message, { requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE });
  }
  if (!claimed) {
    return err('Someone already decided this item.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE,
    });
  }

  // Now make it real. If this fails, hand the item back to the queue so the
  // record never claims a promotion is live when it isn't.
  if (row.target_table === 'agent_prompts' && row.target_row_id && targetRole) {
    try {
      await activatePrompt(row.target_row_id, targetRole, targetFamily, finalContent, row.proposed_content);
    } catch (e) {
      await supabaseAdmin
        .from('knowledge_promotions')
        .update({
          status: 'pending', final_content: null, approved_at: null, expires_at: null,
          decided_at: null, decided_by_account_id: null, decision_note: null,
          previous_target_row_id: null, applied_property_ids: [],
        })
        .eq('id', row.id);
      log.error('[mission/promotions] activation failed, item returned to the queue', {
        requestId, err: e instanceof Error ? e : new Error(String(e)),
      });
      return err('Could not switch the new instructions on. Nothing changed and the item is back in the queue.', {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE,
      });
    }
  }

  return ok({ id: row.id, status: 'approved' }, { requestId, headers: NO_STORE });
}

// ── reject (permanent) ─────────────────────────────────────────────────────

async function reject(row: PromotionRow, ctx: DecisionCtx) {
  const { requestId } = ctx;
  if (row.status !== 'pending') {
    return err(`This item was already ${row.status}.`, {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE,
    });
  }

  const { data, error } = await supabaseAdmin
    .from('knowledge_promotions')
    .update({
      status: 'rejected',
      decided_at: new Date().toISOString(),
      decided_by_account_id: ctx.accountId,
      decision_note: ctx.note,
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) return err(error.message, { requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE });
  if (!data) {
    return err('Someone already decided this item.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE,
    });
  }
  // staxis_propose_promotion now refuses this topic forever — the same refusal
  // the memory consolidator makes for a manager-deleted fact.
  return ok({ id: row.id, status: 'rejected', permanent: true }, { requestId, headers: NO_STORE });
}

// ── retract (reversible) ───────────────────────────────────────────────────

async function retract(row: PromotionRow, ctx: DecisionCtx) {
  const { requestId } = ctx;
  if (row.status !== 'approved') {
    return err('Only something that is live can be pulled back.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE,
    });
  }

  // Refuse to strand a tier with nothing active. Deactivating the only live
  // base prompt would leave the copilot with no instructions at all.
  let restoreId: string | null = null;
  let targetRole: string | null = null;
  let targetFamily: string | null = null;
  if (row.target_table === 'agent_prompts' && row.target_row_id) {
    const target = await readPromptRow(row.target_row_id);
    if (!target) {
      return err('The instruction this item points at no longer exists.', {
        requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE,
      });
    }
    targetRole = target.role;
    targetFamily = target.pms_family;
    restoreId = row.previous_target_row_id;
    if (!restoreId) {
      return err(
        'There is nothing to put back in its place, so pulling this would leave the copilot with no instructions. ' +
        'Replace it with a new version instead.',
        { requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE },
      );
    }
  }

  const now = new Date().toISOString();
  // Widen the blast-radius record first: hotels that joined while it was live
  // relied on it too, and after the retract they are no longer in scope.
  const scopeNow = await propertyIdsInScope(row);
  const merged = Array.from(new Set([...(row.applied_property_ids ?? []), ...scopeNow]));

  const { data, error } = await supabaseAdmin
    .from('knowledge_promotions')
    .update({
      status: 'retracted',
      retracted_at: now,
      decision_note: ctx.note ?? row.decision_note,
      applied_property_ids: merged,
    })
    .eq('id', row.id)
    .eq('status', 'approved')
    .select('id')
    .maybeSingle();

  if (error) return err(error.message, { requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE });
  if (!data) {
    return err('Someone already changed this item.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE,
    });
  }

  if (restoreId && targetRole) {
    try {
      const { error: rpcErr } = await supabaseAdmin.rpc('staxis_activate_prompt', {
        p_id: restoreId, p_role: targetRole, p_pms_family: targetFamily,
      });
      if (rpcErr) throw new Error(rpcErr.message);
    } catch (e) {
      await supabaseAdmin
        .from('knowledge_promotions')
        .update({ status: 'approved', retracted_at: null })
        .eq('id', row.id);
      log.error('[mission/promotions] restore failed, item left live', {
        requestId, err: e instanceof Error ? e : new Error(String(e)),
      });
      return err('Could not put the previous instructions back. Nothing changed.', {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE,
      });
    }
  }

  return ok({ id: row.id, status: 'retracted' }, { requestId, headers: NO_STORE });
}

// ── reconfirm (reset the 75-day clock) ─────────────────────────────────────

async function reconfirm(row: PromotionRow, ctx: { requestId: string; accountId: string }) {
  const { requestId } = ctx;
  if (row.status !== 'approved') {
    return err('Only something that is live can be re-confirmed.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed, headers: NO_STORE,
    });
  }
  const now = new Date();
  const { data, error } = await supabaseAdmin
    .from('knowledge_promotions')
    .update({
      expires_at: expiryFrom(now),
      reconfirmed_at: now.toISOString(),
      reconfirm_count: row.reconfirm_count + 1,
    })
    .eq('id', row.id)
    .eq('status', 'approved')
    .select('id')
    .maybeSingle();

  if (error) return err(error.message, { requestId, status: 500, code: ApiErrorCode.InternalError, headers: NO_STORE });
  if (!data) {
    return err('Someone already changed this item.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE,
    });
  }
  return ok({ id: row.id, status: 'approved', expiresAt: expiryFrom(now) }, { requestId, headers: NO_STORE });
}

// ── helpers ────────────────────────────────────────────────────────────────

async function readPromptRow(id: string): Promise<{ role: string; pms_family: string | null; content: string } | null> {
  const { data } = await supabaseAdmin
    .from('agent_prompts')
    .select('role, pms_family, content')
    .eq('id', id)
    .maybeSingle();
  return (data as { role: string; pms_family: string | null; content: string } | null) ?? null;
}

async function readActivePromptId(role: string, family: string | null, excludeId: string): Promise<string | null> {
  let q = supabaseAdmin.from('agent_prompts').select('id').eq('role', role).eq('is_active', true).neq('id', excludeId);
  q = family === null ? q.is('pms_family', null) : q.eq('pms_family', family);
  const { data } = await q.maybeSingle();
  return ((data as { id: string } | null)?.id) ?? null;
}

/**
 * Activate the target instruction, writing the edited text first when the
 * founder reworded it before approving. Content-then-activate, not the reverse,
 * so the old wording is never briefly served as the new one.
 *
 * If the activate step then fails, the row keeps the edited text but stays
 * INACTIVE, so nothing the copilot reads changed — and the retry writes the
 * same text again.
 */
async function activatePrompt(
  rowId: string,
  role: string,
  family: string | null,
  finalContent: string,
  proposedContent: string,
) {
  if (finalContent !== proposedContent) {
    const { error } = await supabaseAdmin
      .from('agent_prompts')
      .update({ content: finalContent })
      .eq('id', rowId);
    if (error) throw new Error(error.message);
  }
  const { error: rpcErr } = await supabaseAdmin.rpc('staxis_activate_prompt', {
    p_id: rowId, p_role: role, p_pms_family: family,
  });
  if (rpcErr) throw new Error(rpcErr.message);
}

/** Machine-checkable facts the preconditions are evaluated against. */
async function gatherPreconditionFacts(): Promise<PreconditionFacts> {
  const { count } = await supabaseAdmin
    .from('agent_prompts')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'family')
    .eq('is_active', true);
  return { activeFamilyRowCount: count ?? 0 };
}

/** `properties.pms_type` is the PMS-family key — the same column the prompt
 *  assembler reads (src/lib/agent/context.ts). `property_sessions.pms_family`
 *  is the CUA-era copy and stopped being written; never read it here. */
async function loadHotels(): Promise<Array<{ id: string; name: string; pms_family: string | null }>> {
  const { data } = await supabaseAdmin.from('properties').select('id, name, pms_type');
  return ((data ?? []) as Array<{ id: string; name: string | null; pms_type: string | null }>).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    pms_family: p.pms_type,
  }));
}

/** Every hotel a promotion at this tier reaches. A tier applies to its whole
 *  audience by definition — there is no per-hotel opt-in — so this is the
 *  blast radius, not an estimate. */
async function propertyIdsInScope(row: PromotionRow): Promise<string[]> {
  let q = supabaseAdmin.from('properties').select('id');
  if (row.target_tier === 'family' && row.pms_family) q = q.eq('pms_type', row.pms_family);
  const { data } = await q;
  return ((data ?? []) as Array<{ id: string }>).map((p) => p.id);
}

function toView(
  row: PromotionRow,
  now: Date,
  facts: PreconditionFacts,
  hotels: Array<{ id: string; name: string; pms_family: string | null }>,
): PromotionView {
  const bar = meetsEvidenceBar(row);
  const blocked = [...unmetPreconditions(row, facts)];
  if (!bar.ok) blocked.unshift(bar.reason);
  const headline = shortClaim(row.claim);

  // Live items report who they actually reached; pending items report who they
  // WOULD reach, so the cost of saying yes is visible before saying it.
  const scopeIds =
    row.status === 'approved' && (row.applied_property_ids ?? []).length > 0
      ? new Set(row.applied_property_ids ?? [])
      : new Set(
          hotels
            .filter((h) => row.target_tier === 'global' || h.pms_family === row.pms_family)
            .map((h) => h.id),
        );
  const nameById = new Map(hotels.map((h) => [h.id, h.name]));
  const blastHotels = Array.from(scopeIds).map((id) => ({ id, name: nameById.get(id) ?? 'A hotel that has since been removed' }));

  return {
    id: row.id,
    topic: row.topic,
    claim: row.claim,
    evidenceSummary: row.evidence_summary,
    proposedContent: row.proposed_content,
    liveContent: row.final_content,
    status: row.status,
    origin: row.origin,
    headline: headline.text,
    headlineTruncated: headline.truncated,
    originLabel: promotionOriginLabel(row),
    journey: promotionJourney(row),
    lockReason: plainLockReason(row, facts),
    audience: tierLabel(row.target_tier, row.pms_family),
    cameFrom: cameFromLabel(row),
    evidence: describeEvidence(row),
    supportingHotels: row.supporting_hotel_count,
    observations: row.observation_count,
    isAggregate: row.is_aggregate,
    barReason: bar.ok ? '' : bar.reason,
    blockedReasons: blocked,
    expired: isExpired(row, now),
    daysLeft: daysUntilExpiry(row, now),
    reconfirmCount: row.reconfirm_count,
    approvedAt: row.approved_at,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    blastRadius: { count: blastHotels.length, hotels: blastHotels },
    changesBehaviour: row.target_table === 'agent_prompts',
    createdAt: row.created_at,
  };
}
