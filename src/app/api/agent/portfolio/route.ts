// ─── /api/agent/portfolio — cross-hotel chat ───────────────────────────────
//
// GET  — "may I ask company-wide questions, and about which hotels?" The probe
//        a surface calls before offering the mode at all.
// POST — one company-wide turn, streamed as SSE exactly like /api/agent/command.
//
// WHY A SECOND ROUTE RATHER THAN A MODE FLAG ON /api/agent/command
// That route is hotel-shaped from its first line to its last: it takes a
// `propertyId`, gates on `userHasPropertyAccess` + the hotel's `staxis` section,
// builds a HotelSnapshot, mounts the per-hotel tool catalog, and wires the
// approval-card machinery for mutations. A portfolio turn shares none of those
// six things — a different gate stack, a different prompt assembler, a disjoint
// tool catalog, and no mutations at all. Folding it in would put an
// `if (portfolio)` in front of each, and every future change to the copilot
// every hotel uses daily would have to reason about the company branch too.
//
// What IS reused is everything below the fork: `streamAgent`, the tool
// registry and its loop, the conversation tables, the cost reservation, and the
// four `_stream-runner` helpers. No second tool loop exists (which
// `scripts/audit-anthropic-tool-loops.mjs` enforces), and no second registry.
//
// THE GATE STACK, IN ORDER, ALL FOUR REQUIRED:
//   1. requireSession        — a signed-in human.
//   2. loadManagerCaller     — a management-capable account (and the union of
//                              every hotel their hats reach).
//   3. resolvePortfolioAccess— a COMPANY-scope hat (owner / vp / finance) at the
//                              company being asked about. A GM fails here.
//   4. cross_hotel_ai_chat   — that company turned it on. Default off, checked
//                              inside the same call as (3).
// Only then are tools mounted, and the tools re-verify (3) and (4) themselves.

import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadManagerCaller } from '@/lib/team-auth';
import {
  PORTFOLIO_REFUSAL_TEXT,
  resolvePortfolioAccessUncached,
  type PortfolioAccess,
} from '@/lib/company/portfolio';
import {
  ASK_STAXIS_EXECUTION_BUDGET_MS,
  ASK_STAXIS_FALLBACK_RESERVE_MS,
  resolvePortfolioChatExecutionPlan,
  streamAgent,
  type AgentMessage,
} from '@/lib/agent/llm';
import { scaleAiReservationUsd, type AiExecutionPlan } from '@/lib/ai/runtime';
import { anthropicTierTokenRates } from '@/lib/ai/feature-registry';
import { getToolsForRole } from '@/lib/agent/tools';
import {
  cancelCostReservation,
  COST_LIMITS,
  reserveCostBudget,
} from '@/lib/agent/cost-controls';
import {
  createConversation,
  lockLoadAndRecordUserTurn,
  loadConversationScope,
  recordUserTurn,
} from '@/lib/agent/memory';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import {
  boundedHotelIds,
  loadPortfolioHotels,
} from '@/lib/agent/portfolio/hotels';
import { buildPortfolioSystemPrompt } from '@/lib/agent/portfolio/prompt';
import { buildPortfolioSnapshot } from '@/lib/agent/portfolio/snapshot';
import { anchorHotelFor } from '@/lib/agent/portfolio/conversation';
// Side-effect import — registers all tools, including the portfolio catalog.
import '@/lib/agent/tools/index';

import {
  drainDanglingToolCalls,
  finishAgentStream,
  reconcileCostReservation,
  runAgentStream,
} from '../command/_stream-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_USER_MESSAGE_CHARS = 4000;

interface RequestBody {
  conversationId?: string;
  /** Optional narrowing when a person holds company jobs at two companies. */
  organizationId?: string;
  message: string;
}

// ─── GET: may this person ask company-wide questions? ───────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const caller = await loadManagerCaller(auth.userId);
  if (!caller) {
    return ok({ available: false, reason: 'no_company_job', why: PORTFOLIO_REFUSAL_TEXT.no_company_job }, { requestId });
  }

  const url = new URL(req.url);
  const organizationId = url.searchParams.get('organizationId');
  const access = await resolvePortfolioAccessUncached(caller.accountId, organizationId);
  if (!access.ok) {
    return ok(
      { available: false, reason: access.reason, why: PORTFOLIO_REFUSAL_TEXT[access.reason] },
      { requestId },
    );
  }

  const { ids, omittedHotelCount } = boundedHotelIds(access.access.propertyIds);
  const hotels = await loadPortfolioHotels(ids);
  return ok(
    {
      available: true,
      organizationId: access.access.organizationId,
      organizationName: access.access.organizationName,
      companyRole: access.access.companyRole,
      hotels: hotels.map((h) => ({ hotelId: h.id, name: h.name, rooms: h.totalRooms })),
      hotelsNotCovered: omittedHotelCount,
    },
    { requestId },
  );
}

// ─── POST: one company-wide turn ───────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const executionDeadlineAt = Date.now() + ASK_STAXIS_EXECUTION_BUDGET_MS;

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!body.message?.trim()) {
    return err('message is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.message.length > MAX_USER_MESSAGE_CHARS) {
    return err(`message exceeds ${MAX_USER_MESSAGE_CHARS} chars`, {
      requestId, status: 413, code: ApiErrorCode.ValidationFailed,
    });
  }

  // ── Gate 2: a management-capable account, and the hotels their hats reach ──
  const caller = await loadManagerCaller(auth.userId);
  if (!caller) {
    return err(PORTFOLIO_REFUSAL_TEXT.no_company_job, {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // Continuing a conversation: its company comes from the ROW, never from the
  // request. Otherwise a person with jobs at two companies could hand company
  // A's conversation company B's id and mix two portfolios into one thread.
  let existingScope: Awaited<ReturnType<typeof loadConversationScope>> = null;
  if (body.conversationId) {
    existingScope = await loadConversationScope(body.conversationId, caller.accountId);
    if (!existingScope) {
      return err('conversation not found or not yours', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    if (!existingScope.organizationId) {
      // A per-hotel conversation cannot be continued as a company one: its
      // history was answered under the hotel prompt and the hotel tool catalog.
      return err('that conversation is about a single hotel', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
  }

  // ── Gates 3 + 4: a company-scope hat, and the company's own switch ────────
  const access = await resolvePortfolioAccessUncached(
    caller.accountId,
    existingScope?.organizationId ?? body.organizationId ?? null,
  );
  if (!access.ok) {
    return err(PORTFOLIO_REFUSAL_TEXT[access.reason], {
      requestId, status: 403, code: ApiErrorCode.Forbidden, details: access.reason,
    });
  }
  const portfolio: PortfolioAccess = access.access;

  // ── The hotels this turn reads ───────────────────────────────────────────
  const { ids, omittedHotelCount } = boundedHotelIds(portfolio.propertyIds);
  const hotels = await loadPortfolioHotels(ids);
  if (hotels.length === 0) {
    return err(PORTFOLIO_REFUSAL_TEXT.no_hotels, {
      requestId, status: 403, code: ApiErrorCode.Forbidden, details: 'no_hotels',
    });
  }

  // ── Cost reservation ─────────────────────────────────────────────────────
  // Anchored on the SAME per-user and per-property daily caps the hotel copilot
  // uses. A company question is billed to its anchor hotel, which is the
  // conservative reading of "one hotel's budget" — the alternative (billing
  // nobody) would put an uncapped surface next to a capped one.
  const anchorPropertyId = existingScope?.propertyId ?? anchorHotelFor(ids);
  if (!anchorPropertyId) {
    return err(PORTFOLIO_REFUSAL_TEXT.no_hotels, {
      requestId, status: 403, code: ApiErrorCode.Forbidden, details: 'no_hotels',
    });
  }

  let estimatedUsd: number;
  let executionPlan: AiExecutionPlan;
  try {
    executionPlan = await resolvePortfolioChatExecutionPlan();
    estimatedUsd = scaleAiReservationUsd(
      [executionPlan.primary, executionPlan.fallback].filter(
        (model): model is NonNullable<typeof model> => model !== null,
      ),
      { usd: COST_LIMITS.estimatedRequestUsd, ...anthropicTierTokenRates('sonnet') },
    );
  } catch (error) {
    return err(error instanceof Error ? error.message : 'Company-wide questions are unavailable', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  const reservation = await reserveCostBudget({
    userId: caller.accountId,
    propertyId: anchorPropertyId,
    estimatedUsd,
  });
  if (!reservation.ok) {
    return err(reservation.message, {
      requestId, status: 429, code: ApiErrorCode.RateLimited, details: reservation.reason,
    });
  }
  const reservationId = reservation.reservationId;

  // ── Load or create the conversation ──────────────────────────────────────
  let conversationId = body.conversationId;
  let history: AgentMessage[] = [];
  try {
    if (conversationId && existingScope) {
      const prep = await lockLoadAndRecordUserTurn({
        conversationId,
        userAccountId: caller.accountId,
        // The row's OWN anchor, so a company that acquired a hotel sorting
        // before the old anchor does not fail its VP's next message.
        propertyId: existingScope.propertyId,
        userMessage: body.message,
      });
      if (!prep.ok) {
        await cancelCostReservation(reservationId);
        return err('failed to prepare conversation', {
          requestId, status: prep.reason === 'not_found' || prep.reason === 'wrong_owner' ? 404 : 500,
          code: ApiErrorCode.NotFound, details: prep.reason ?? undefined,
        });
      }
      history = prep.history;
    } else {
      conversationId = await createConversation({
        userAccountId: caller.accountId,
        propertyId: anchorPropertyId,
        role: caller.role,
        promptVersion: PROMPT_VERSION,
        organizationId: portfolio.organizationId,
        title: body.message.trim().slice(0, 120),
      });
      await recordUserTurn(conversationId, body.message);
    }
  } catch (e) {
    log.error('[agent/portfolio] failed to prepare conversation', { requestId, reservationId, e });
    await cancelCostReservation(reservationId);
    return err('failed to prepare conversation', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // ── Build the turn ───────────────────────────────────────────────────────
  const snapshot = await buildPortfolioSnapshot(portfolio.organizationId, hotels, omittedHotelCount);
  const systemPrompt = await buildPortfolioSystemPrompt({
    identity: {
      organizationId: portfolio.organizationId,
      organizationName: portfolio.organizationName,
      hotels,
      omittedHotelCount,
    },
    companyRole: portfolio.companyRole,
    snapshot,
    conversationId,
  });
  // The portfolio catalog. Every per-hotel tool declares no `surfaces` and is
  // therefore chat-only, so this returns the seven portfolio tools and nothing
  // else — by construction, not by a filter.
  const tools = getToolsForRole(caller.role, 'portfolio');

  // The union of every hotel this person's hats reach. `accounts.property_access`
  // is EMPTY for a company person (their access is entirely a hat), so handing
  // executeTool the raw array would make its cached-propertyAccess backstop
  // refuse the anchor hotel and every portfolio tool with it.
  const callerReach = caller.reachesAllProperties
    ? ['*', ...(caller.accessiblePropertyIds ?? caller.propertyAccess)]
    : (caller.accessiblePropertyIds ?? caller.propertyAccess);

  const encoder = new TextEncoder();
  const finalConversationId = conversationId;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // Controller closed (client disconnected). The finally block cleans up.
        }
      };

      send({ type: 'conversation_id', id: finalConversationId });

      const runnerCtx = {
        conversationId: finalConversationId,
        requestId,
        promptVersion: systemPrompt.versionLabel,
        send,
      };
      const pendingToolCallIds = new Set<string>();
      let result: Awaited<ReturnType<typeof runAgentStream>> | null = null;

      try {
        const iter = streamAgent({
          systemPrompt,
          history,
          newUserMessage: body.message,
          tools,
          // No approval mode: nothing on this surface mutates, so there is no
          // card to hold. If a mutating tool ever appeared in this catalog it
          // would execute inline with no approval — which is exactly why the
          // "no mutating portfolio tool" rule is asserted in the leak suite
          // rather than left as a comment.
          featureKey: 'agent.portfolio_chat',
          executionPlan,
          deadlineAt: executionDeadlineAt,
          fallbackReserveMs: ASK_STAXIS_FALLBACK_RESERVE_MS,
          abortSignal: req.signal,
          toolContext: {
            user: {
              uid: auth.userId,
              accountId: caller.accountId,
              username: caller.displayName ?? 'company',
              displayName: caller.displayName ?? 'Company',
              role: caller.role,
              // The union of every hotel their hats reach — which is what makes
              // executeTool's cached-propertyAccess backstop meaningful for a
              // company person, whose `accounts.property_access` is empty.
              propertyAccess: callerReach,
            },
            propertyId: anchorPropertyId,
            staffId: null,
            requestId,
            surface: 'portfolio',
            conversationId: finalConversationId,
            portfolio: {
              organizationId: portfolio.organizationId,
              organizationName: portfolio.organizationName,
              propertyIds: ids,
            },
          },
        });

        result = await runAgentStream(iter, runnerCtx, { pendingToolCallIds });
        await finishAgentStream(result, runnerCtx);
      } catch (e) {
        log.error('[agent/portfolio] stream loop threw', {
          requestId, conversationId: finalConversationId, reservationId, e,
        });
        // A CODE, never the exception. Whatever threw here was not written to
        // be read by a VP — it is a stack-adjacent sentence about a database
        // column, a model API, or a JSON parse — and CommandCenter renders the
        // `message` field verbatim, in whatever language it happens to be in.
        // The real error is already on the log line above, with the requestId
        // that ties it to this stream. `message` is kept as an English
        // last-resort for any reader that does not know the code.
        send({
          type: 'error',
          code: 'stream_failed',
          message: 'Staxis could not finish that answer.',
        });
      } finally {
        await drainDanglingToolCalls(pendingToolCallIds, runnerCtx);
        await reconcileCostReservation({
          reservationId,
          conversationId: finalConversationId,
          finalUsage: result?.finalUsage ?? result?.lastTurnUsage ?? null,
          userId: caller.accountId,
          propertyId: anchorPropertyId,
          requestId,
          feature: 'agent.portfolio_chat',
        });
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-request-id': requestId,
      'x-accel-buffering': 'no',
    },
  });
}
