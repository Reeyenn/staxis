/**
 * "What Staxis knows about your hotel" — MANAGEMENT ONLY, service-role.
 *
 * Serves two surfaces:
 *   • the compact Dashboard box (stats + the taught/noticed/learned counts), and
 *   • the Knows view inside the Staxis section (/feed), which is the full
 *     auditable list: every fact, where it came from, and Confirm / Edit /
 *     Remove.
 *
 * GET ?propertyId=<uuid>
 *   → { ok, data: {
 *        stats: { totalKnown, patternsThisMonth, issuesCaughtEarly, pendingReview },
 *        taught / noticed / learned: [{id,topic,content}],   // Dashboard box
 *        facts: [{ id, topic, content, category, source, reviewState,
 *                  createdByName, updatedAt, expiresAt }],   // Knows view
 *      } }
 *   `stats.totalKnown` counts CONFIRMED facts only — a fact still awaiting
 *   review is not something Staxis knows, and counting it would overstate the
 *   hotel's knowledge on the dashboard. Those are reported as `pendingReview`.
 *
 * POST { propertyId, action: 'confirm' | 'edit' | 'remove', id, content?, category? }
 *   The Knows view's three actions. Each is scoped to the caller's property.
 *
 * Auth: requireSession + canManageTeam + caller must manage the property. All
 * reads/writes via supabaseAdmin behind the gate (agent_memory is deny-all to
 * the browser), and every query filters property_id — that filter IS the
 * per-tenant guarantee here.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { canManageTeam } from '@/lib/roles';
import { loadKnowsCaller, callerManagesProperty } from '@/lib/memory-knows-access';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import {
  listMemory,
  confirmMemoryFact,
  editMemoryFact,
  removeMemoryFact,
  type MemoryRow,
} from '@/lib/db/agent-memory';
import { insightSeverityFromTopic } from '@/lib/agent/operational-signals';
import { isMemoryCategory } from '@/lib/agent/memory-facets';
import { redactMemoryContent } from '@/lib/agent/memory-redact';
import { FACT_MAX_CONTENT } from '@/lib/agent/knowledge-intake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** requireSession + management role + property access, in one place. */
async function gate(req: NextRequest, requestId: string, propertyIdRaw: unknown) {
  const session = await requireSession(req, { requestId });
  if (!session.ok) return { ok: false as const, response: session.response };

  const caller = await loadKnowsCaller(session.userId);
  if (!caller) {
    return {
      ok: false as const,
      response: err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound }),
    };
  }
  if (!canManageTeam(caller.role)) {
    return {
      ok: false as const,
      response: err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }
  const pidV = validateUuid(propertyIdRaw, 'propertyId');
  if (pidV.error) {
    return {
      ok: false as const,
      response: err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed }),
    };
  }
  if (!callerManagesProperty(caller, pidV.value!)) {
    return {
      ok: false as const,
      response: err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }
  return { ok: true as const, caller, propertyId: pidV.value! };
}

const slim = (r: MemoryRow) => ({ id: r.id, topic: r.topic, content: r.content });

const fact = (r: MemoryRow) => ({
  id: r.id,
  topic: r.topic,
  content: r.content,
  category: r.category,
  source: r.source,
  reviewState: r.reviewState,
  createdByName: r.createdByName,
  updatedAt: r.updatedAt,
  expiresAt: r.expiresAt,
});

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const g = await gate(req, requestId, new URL(req.url).searchParams.get('propertyId'));
  if (!g.ok) return g.response;

  // All active HOTEL-wide knowledge (property scope). User-scope personal prefs
  // are excluded — this is "what Staxis knows about the hotel", not about you.
  const rows = await listMemory(g.propertyId, { scope: 'property', limit: 200 });

  const confirmed = rows.filter((r) => r.reviewState === 'confirmed');
  const taught = confirmed.filter((r) => r.source === 'explicit_user' || r.source === 'correction');
  const noticed = confirmed.filter((r) => r.source === 'operational');
  const learned = confirmed.filter((r) => r.source === 'consolidation');

  const monthAgo = Date.now() - 30 * 86400_000;
  const patternsThisMonth = noticed.filter((r) => new Date(r.updatedAt).getTime() >= monthAgo).length;
  // "Issues flagged early" — the downtime-preventing patterns (recurring
  // maintenance / repeat inspection fails / out-of-range compliance / complaint
  // clusters). The real ROI story, no $ fabricated.
  const issuesCaughtEarly = noticed.filter((r) => insightSeverityFromTopic(r.topic) === 'attention').length;

  return ok(
    {
      stats: {
        totalKnown: confirmed.length,
        patternsThisMonth,
        issuesCaughtEarly,
        pendingReview: rows.length - confirmed.length,
      },
      taught: taught.map(slim),
      noticed: noticed.map(slim),
      learned: learned.map(slim),
      // Unreviewed first: the whole point of the screen is that they need you.
      facts: [
        ...rows.filter((r) => r.reviewState === 'unreviewed').map(fact),
        ...confirmed.map(fact),
      ],
    },
    { requestId },
  );
}

interface PostBody {
  propertyId?: unknown;
  action?: unknown;
  id?: unknown;
  content?: unknown;
  category?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const g = await gate(req, requestId, body.propertyId);
  if (!g.ok) return g.response;

  const idV = validateUuid(body.id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const action = body.action;
  if (action !== 'confirm' && action !== 'edit' && action !== 'remove') {
    return err('Unknown action', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const rl = await checkAndIncrementRateLimit('knows-write', g.propertyId);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const actor = { accountId: g.caller.accountId, name: g.caller.name, role: g.caller.role };

  if (action === 'confirm') {
    const res = await confirmMemoryFact(g.propertyId, idV.value!, actor);
    if (!res.ok) {
      log.error('[memory/knows:POST] confirm failed', { requestId, err: res.error });
      return err('Could not confirm that', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!res.confirmed) {
      return err('That fact is no longer there', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    return ok({ action, id: idV.value }, { requestId });
  }

  if (action === 'remove') {
    const res = await removeMemoryFact(g.propertyId, idV.value!);
    if (!res.ok) {
      log.error('[memory/knows:POST] remove failed', { requestId, err: res.error });
      return err('Could not remove that', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!res.removed) {
      return err('That fact is no longer there', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    return ok({ action, id: idV.value }, { requestId });
  }

  // ── edit ──────────────────────────────────────────────────────────────────
  if (typeof body.content !== 'string') {
    return err('content is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  // Same PII masking every other memory write path applies. A manager typing a
  // vendor's mobile number into a fact must not turn long-term memory into a
  // place phone numbers accumulate.
  const content = redactMemoryContent(body.content.slice(0, FACT_MAX_CONTENT)).content.trim();
  if (!content) {
    return err('content is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.category !== undefined && !isMemoryCategory(body.category)) {
    return err('Unknown category', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const res = await editMemoryFact(
    g.propertyId,
    idV.value!,
    { content, ...(body.category !== undefined ? { category: body.category } : {}) },
    actor,
  );
  if (!res.ok) {
    log.error('[memory/knows:POST] edit failed', { requestId, err: res.error });
    return err('Could not save that', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!res.updated) {
    return err('That fact is no longer there', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  return ok({ action, id: idV.value, content }, { requestId });
}
