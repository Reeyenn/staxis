// ─── /api/agent/portfolio — one chat, exact current company scope ──────────
//
// This route is a portfolio ORCHESTRATOR behind the existing chat runtime, not
// a second chatbot or a second foundation model. It resolves authorization,
// plans a closed typed query, executes deterministic property-scoped adapters,
// and gives the model only the bounded evidence package for final wording.
//
// Security invariant: authorization is resolved at request time, asserted
// before and after every deterministic query, asserted atomically with history
// replay/append, and asserted once more after model synthesis before either the
// answer or its conversation row is released. The final synthesis is therefore
// intentionally buffered. A streaming token emitted before the last assertion
// could leak after a mid-turn revocation; portfolio correctness wins that
// trade-off while the hotel chat keeps its normal streaming behavior.

import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadSessionAccount } from '@/lib/team-auth';
import {
  PORTFOLIO_REFUSAL_TEXT,
  resolvePortfolioAccessUncached,
} from '@/lib/company/portfolio';
import { resolvePortfolioQueuePolicy } from '@/lib/company/portfolio-data-policy';
import {
  assertAuthorizationScopeReceipt,
  loadAuthorizedPropertyMetadata,
  resolveAuthorizationScope,
} from '@/lib/authorization/server';
import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import {
  ASK_STAXIS_EXECUTION_BUDGET_MS,
  ASK_STAXIS_FALLBACK_RESERVE_MS,
  resolvePortfolioChatExecutionPlan,
  runAgent,
  type AgentMessage,
  type UsageReport,
} from '@/lib/agent/llm';
import { scaleAiReservationUsd, type AiExecutionPlan } from '@/lib/ai/runtime';
import { anthropicTierTokenRates } from '@/lib/ai/feature-registry';
import {
  cancelCostReservation,
  COST_LIMITS,
  reserveCostBudget,
} from '@/lib/agent/cost-controls';
import {
  createPortfolioConversation,
  commitPortfolioConversationTurn,
  loadConversationScope,
  lockLoadAndRecordPortfolioUserTurn,
} from '@/lib/agent/memory';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import {
  anchorHotelFor,
  portfolioPolicyFingerprintFromStamp,
  stampPortfolioPolicy,
} from '@/lib/agent/portfolio/conversation';
import type { PortfolioHotel } from '@/lib/agent/portfolio/hotels';
import { validatePortfolioAnswerNumbers } from '@/lib/agent/portfolio-intelligence/answer-guard';
import {
  PortfolioQueryContractError,
  PortfolioQueryInterruptedError,
  PortfolioScopeChangedError,
  runPortfolioIntelligence,
} from '@/lib/agent/portfolio-intelligence/engine';
import {
  acquirePortfolioQueryAdmission,
  releasePortfolioQueryAdmission,
} from '@/lib/portfolio-query-admission';
import {
  buildCompanyKnowledgeOverlay,
  formatKnowledgeOverlayForPrompt,
  loadConfirmedCompanyKnowledge,
  loadConfirmedPortfolioPropertyKnowledge,
  PORTFOLIO_KNOWLEDGE_OVERLAY_VERSION,
  PORTFOLIO_KNOWLEDGE_PROMPT_VERSION,
  type CompanyKnowledgeOverlayV1,
} from '@/lib/agent/portfolio-intelligence/knowledge';
import {
  buildPortfolioKnowledgeClaimCatalog,
  PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
  renderPortfolioKnowledgeAnswer,
  selectPortfolioKnowledgeClaims,
} from '@/lib/agent/portfolio-intelligence/knowledge-presentation';
import { persistPortfolioKnowledgeReceipt } from '@/lib/agent/portfolio-intelligence/knowledge-receipts';
import { planPortfolioQuestion } from '@/lib/agent/portfolio-intelligence/planner';
import { buildPortfolioIntelligenceSystemPrompt } from '@/lib/agent/portfolio-intelligence/prompt';
import {
  persistPortfolioQueryReceipt,
} from '@/lib/agent/portfolio-intelligence/receipts';
import {
  buildPortfolioFindingPresentationProjection,
  PORTFOLIO_PRESENTATION_OUTPUT_CONFIG,
  renderPortfolioAnswerArtifact,
  validatePortfolioPresentationPlan,
} from '@/lib/agent/portfolio-intelligence/presentation';
import {
  activeScopeEvent,
  authorizationSelectorForPlan,
  buildPlannerScopeCatalog,
  portfolioTurnRequestSchema,
  scopeLabelForPlan,
  type PortfolioActiveScopeEvent,
} from '@/lib/agent/portfolio-intelligence/route-contract';
import type { PlannerScopeCatalog, PortfolioQueryPlan } from '@/lib/agent/portfolio-intelligence/schemas';
import { PORTFOLIO_FINDING_LOAD_TIMEOUT_MS } from '@/lib/agent/portfolio-intelligence/versions';
import {
  buildPortfolioFindingProjection,
  buildPortfolioFindingProjectionReceipt,
  PORTFOLIO_FINDING_MAX_SELECTED_PROPERTIES,
  type PortfolioFindingReceiptV1,
} from '@/lib/agent/portfolio-intelligence/pattern-contract';
import {
  loadAndConsumePortfolioFindings,
  portfolioFindingLoader,
  type PortfolioFindingMountDependencies,
} from '@/lib/agent/portfolio-intelligence/finding-mount';
import { reconcileCostReservation } from '../command/_stream-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const PORTFOLIO_KNOWLEDGE_BUDGET_MS = 2_000;

const PORTFOLIO_PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization',
});

interface PreparedScope {
  catalog: PlannerScopeCatalog;
  plan: PortfolioQueryPlan;
  receipt: AuthorizationScopeReceipt;
  selectorLabel: string;
}

/** Narrow dependency seam for executable route tests. Production `POST`
 * always uses this immutable default; tests may replace the provider/cost
 * boundary while retaining the real authorization, planner, adapters,
 * conversation functions, and receipt persistence. */
export interface PortfolioPostDependencies {
  resolveExecutionPlan: typeof resolvePortfolioChatExecutionPlan;
  runSynthesis: typeof runAgent;
  reserveBudget: typeof reserveCostBudget;
  cancelReservation: typeof cancelCostReservation;
  reconcileReservation: typeof reconcileCostReservation;
  loadAuthorizedMetadata: typeof loadAuthorizedPropertyMetadata;
  loadCompanyKnowledge: typeof loadConfirmedCompanyKnowledge;
  loadPropertyKnowledge: typeof loadConfirmedPortfolioPropertyKnowledge;
  loadPortfolioFindings: PortfolioFindingMountDependencies['loadFindings'];
  acquireAdmission: typeof acquirePortfolioQueryAdmission;
  releaseAdmission: typeof releasePortfolioQueryAdmission;
}

const PORTFOLIO_POST_DEPENDENCIES: PortfolioPostDependencies = Object.freeze({
  resolveExecutionPlan: resolvePortfolioChatExecutionPlan,
  runSynthesis: runAgent,
  reserveBudget: reserveCostBudget,
  cancelReservation: cancelCostReservation,
  reconcileReservation: reconcileCostReservation,
  loadAuthorizedMetadata: loadAuthorizedPropertyMetadata,
  loadCompanyKnowledge: loadConfirmedCompanyKnowledge,
  loadPropertyKnowledge: loadConfirmedPortfolioPropertyKnowledge,
  loadPortfolioFindings: portfolioFindingLoader,
  acquireAdmission: acquirePortfolioQueryAdmission,
  releaseAdmission: releasePortfolioQueryAdmission,
});

interface PortfolioAvailabilityDependencies {
  loadAuthorizedMetadata: typeof loadAuthorizedPropertyMetadata;
}

const PORTFOLIO_AVAILABILITY_DEPENDENCIES: PortfolioAvailabilityDependencies = Object.freeze({
  loadAuthorizedMetadata: loadAuthorizedPropertyMetadata,
});

function sseResponse(events: readonly unknown[], requestId: string, status = 200): Response {
  const encoder = new TextEncoder();
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(encoder.encode(body), {
    status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      'x-request-id': requestId,
      'x-accel-buffering': 'no',
    },
  });
}

function staticAnswer(
  text: string,
  requestId: string,
  scope?: PortfolioActiveScopeEvent,
): Response {
  return sseResponse([
    ...(scope ? [scope] : []),
    { type: 'text_delta', delta: text },
    { type: 'done', finalText: text },
  ], requestId);
}

function scopeErrorStatus(reason: string): number {
  if (reason === 'invalid_request') return 400;
  if (reason === 'scope_changed' || reason === 'revoked_or_changed' || reason === 'expired') return 409;
  if (reason === 'store_unavailable') return 503;
  return 403;
}

function scopeErrorText(reason: string): string {
  if (reason === 'scope_changed' || reason === 'revoked_or_changed' || reason === 'expired') {
    return 'Your hotel access changed. Start a new portfolio chat so Staxis can use the new scope.';
  }
  if (reason === 'unauthorized_scope') {
    return 'That hotel, region, or portfolio is not in your current authorized scope.';
  }
  if (reason === 'store_unavailable') {
    return 'Your current hotel access could not be verified. No portfolio data was released.';
  }
  return 'That portfolio scope is not available to this account.';
}

function selectedHotels(
  receipt: AuthorizationScopeReceipt,
  catalog: PlannerScopeCatalog,
): PortfolioHotel[] {
  const byId = new Map(catalog.hotels.map((hotel) => [hotel.propertyId, hotel]));
  return receipt.propertyIds.map((propertyId) => {
    const hotel = byId.get(propertyId);
    return {
      id: propertyId,
      name: hotel?.name ?? `Hotel ${propertyId.slice(0, 8)}`,
      totalRooms: hotel?.totalRooms ?? null,
      timezone: hotel?.timezone ?? null,
    };
  });
}

interface PortfolioKnowledgeContext {
  block: string;
  overlay: CompanyKnowledgeOverlayV1 | null;
  versions: Record<string, unknown>;
}

interface PortfolioKnowledgeLoaders {
  loadCompanyFacts: typeof loadConfirmedCompanyKnowledge;
  loadPropertyFacts: typeof loadConfirmedPortfolioPropertyKnowledge;
}

const PORTFOLIO_KNOWLEDGE_LOADERS: PortfolioKnowledgeLoaders = Object.freeze({
  loadCompanyFacts: loadConfirmedCompanyKnowledge,
  loadPropertyFacts: loadConfirmedPortfolioPropertyKnowledge,
});

class PortfolioKnowledgeDeadlineError extends Error {
  constructor(readonly reason: 'cancelled' | 'timed_out') {
    super(`portfolio knowledge request ${reason === 'cancelled' ? 'cancelled' : 'timed out'}`);
    this.name = 'PortfolioKnowledgeDeadlineError';
  }
}

/** Bound the entire overlay operation, including legacy company-fact reads
 * whose PostgREST client does not currently expose an AbortSignal. The losing
 * promise may finish in the background, but it cannot delay synthesis or alter
 * the already-returned evidence-only context. */
function withPortfolioKnowledgeDeadline<T>(input: {
  promise: Promise<T>;
  deadlineAt: number;
  signal: AbortSignal;
}): Promise<T> {
  if (input.signal.aborted) {
    return Promise.reject(new PortfolioKnowledgeDeadlineError('cancelled'));
  }
  const remainingMs = input.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new PortfolioKnowledgeDeadlineError('timed_out'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new PortfolioKnowledgeDeadlineError('cancelled')));
    const timer = setTimeout(
      () => finish(() => reject(new PortfolioKnowledgeDeadlineError('timed_out'))),
      remainingMs,
    );
    input.signal.addEventListener('abort', onAbort, { once: true });
    input.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function companyKnowledgeBlock(input: {
  organizationId: string;
  propertyIds: string[];
  now: Date;
  requestId: string;
  deadlineAt: number;
  signal: AbortSignal;
}, loaders: PortfolioKnowledgeLoaders = PORTFOLIO_KNOWLEDGE_LOADERS): Promise<PortfolioKnowledgeContext> {
  try {
    if (input.signal.aborted || input.deadlineAt <= Date.now()) {
      throw new PortfolioKnowledgeDeadlineError(input.signal.aborted ? 'cancelled' : 'timed_out');
    }
    const [companyFacts, propertyFacts] = await withPortfolioKnowledgeDeadline({
      promise: Promise.all([
        loaders.loadCompanyFacts(input.organizationId),
        loaders.loadPropertyFacts({
          organizationId: input.organizationId,
          propertyIds: input.propertyIds,
          asOf: input.now,
          deadlineAt: input.deadlineAt,
          signal: input.signal,
        }),
      ]),
      deadlineAt: input.deadlineAt,
      signal: input.signal,
    });
    const overlay: CompanyKnowledgeOverlayV1 = buildCompanyKnowledgeOverlay({
      organizationId: input.organizationId,
      selectedPropertyIds: input.propertyIds,
      asOf: input.now.toISOString(),
      companyFacts,
      propertyFacts,
    });
    return {
      block: formatKnowledgeOverlayForPrompt(overlay),
      overlay,
      versions: {
        status: 'included',
        overlayVersion: PORTFOLIO_KNOWLEDGE_OVERLAY_VERSION,
        promptVersion: PORTFOLIO_KNOWLEDGE_PROMPT_VERSION,
        asOf: overlay.asOf,
        company: companyFacts.map((fact) => ({ id: fact.id, updatedAt: fact.updatedAt })),
        property: propertyFacts.map((fact) => ({
          id: fact.id,
          propertyId: fact.propertyId,
          updatedAt: fact.updatedAt,
        })),
      },
    };
  } catch (error) {
    // Knowledge is reference context, never permission or canonical evidence.
    // A store issue degrades to an evidence-only answer and is observable.
    log.warn('[agent/portfolio] knowledge overlay unavailable', {
      requestId: input.requestId,
      organizationId: input.organizationId,
      error,
    });
    return {
      block: '',
      overlay: null,
      versions: {
        status: error instanceof PortfolioKnowledgeDeadlineError
          ? error.reason
          : input.signal.aborted ? 'cancelled' : 'unavailable',
        overlayVersion: PORTFOLIO_KNOWLEDGE_OVERLAY_VERSION,
        promptVersion: PORTFOLIO_KNOWLEDGE_PROMPT_VERSION,
      },
    };
  }
}

async function exactReceiptStillCurrent(
  receipt: AuthorizationScopeReceipt,
): Promise<boolean> {
  const asserted = await assertAuthorizationScopeReceipt({
    receiptId: receipt.id,
    accountId: receipt.accountId,
  });
  const exactArray = (left: readonly string[], right: readonly string[]) => (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
  if (!asserted.ok
      || asserted.receipt.id !== receipt.id
      || asserted.receipt.accountId !== receipt.accountId
      || asserted.receipt.organizationId !== receipt.organizationId
      || asserted.receipt.authorityMode !== receipt.authorityMode
      || asserted.receipt.selectorType !== receipt.selectorType
      || asserted.receipt.requestedPortfolioId !== receipt.requestedPortfolioId
      || asserted.receipt.authorizedPropertyCount !== receipt.authorizedPropertyCount
      || asserted.receipt.selectedPropertyCount !== receipt.selectedPropertyCount
      || asserted.receipt.accountAuthorizationVersion !== receipt.accountAuthorizationVersion
      || asserted.receipt.organizationAccessEpoch !== receipt.organizationAccessEpoch
      || asserted.receipt.resolverVersion !== receipt.resolverVersion
      || asserted.receipt.authorizationHash !== receipt.authorizationHash
      || asserted.receipt.scopeHash !== receipt.scopeHash
      || asserted.receipt.expiresAt !== receipt.expiresAt
      || !exactArray(asserted.receipt.requestedPropertyIds, receipt.requestedPropertyIds)
      || !exactArray(asserted.receipt.authorizedPropertyIds, receipt.authorizedPropertyIds)
      || !exactArray(asserted.receipt.propertyIds, receipt.propertyIds)) return false;
  // The receipt proves hotel reach. Re-open the company chat door too so a
  // mid-turn capability/feature revocation is effective before provider egress
  // and before browser egress.
  const standing = await resolvePortfolioAccessUncached(receipt.accountId, receipt.organizationId);
  return standing.ok
    && standing.access.authorizationReceipt.authorizationHash === receipt.authorizationHash
    && exactArray(
      standing.access.authorizationReceipt.authorizedPropertyIds,
      receipt.authorizedPropertyIds,
    );
}

async function prepareScope(input: {
  accountId: string;
  organizationId: string;
  baseReceipt: AuthorizationScopeReceipt;
  catalog: PlannerScopeCatalog;
  question: string;
  requestedSelector?: import('@/lib/agent/portfolio-intelligence/schemas').PortfolioScopeSelector;
}): Promise<PreparedScope | { refusal: ReturnType<typeof planPortfolioQuestion> & { ok: false } } | { scopeFailure: string }> {
  const planned = planPortfolioQuestion(input.question, input.catalog, input.requestedSelector);
  if (!planned.ok) return { refusal: planned };
  const selector = authorizationSelectorForPlan(planned.plan.selector);
  const resolved = selector.type === 'all_authorized'
    ? { ok: true as const, receipt: input.baseReceipt }
    : await resolveAuthorizationScope({
        accountId: input.accountId,
        organizationId: input.organizationId,
        selector,
      });
  if (!resolved.ok) return { scopeFailure: resolved.reason };
  if (resolved.receipt.authorizationHash !== input.baseReceipt.authorizationHash) {
    return { scopeFailure: 'scope_changed' };
  }
  return {
    catalog: input.catalog,
    plan: planned.plan,
    receipt: resolved.receipt,
    selectorLabel: scopeLabelForPlan(planned.plan, input.catalog),
  };
}

// ─── GET: exact, untruncated company-chat availability ─────────────────────

export async function handlePortfolioGet(
  req: NextRequest,
  overrides: Partial<PortfolioAvailabilityDependencies> = {},
): Promise<Response> {
  const dependencies = { ...PORTFOLIO_AVAILABILITY_DEPENDENCIES, ...overrides };
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const caller = await loadSessionAccount(auth.userId);
  if (!caller) {
    return ok(
      { available: false, reason: 'no_company_job', why: PORTFOLIO_REFUSAL_TEXT.no_company_job },
      { requestId, headers: PORTFOLIO_PRIVATE_HEADERS },
    );
  }

  const organizationId = new URL(req.url).searchParams.get('organizationId');
  const access = await resolvePortfolioAccessUncached(caller.accountId, organizationId);
  if (!access.ok) {
    return ok(
      { available: false, reason: access.reason, why: PORTFOLIO_REFUSAL_TEXT[access.reason] },
      { requestId, headers: PORTFOLIO_PRIVATE_HEADERS },
    );
  }
  const metadata = await dependencies.loadAuthorizedMetadata({ receipt: access.access.authorizationReceipt });
  if (!metadata.ok) {
    return ok(
      { available: false, reason: metadata.reason, why: scopeErrorText(metadata.reason) },
      { requestId, headers: PORTFOLIO_PRIVATE_HEADERS },
    );
  }
  const catalog = buildPlannerScopeCatalog({
    receipt: access.access.authorizationReceipt,
    metadata,
  });
  if (!await exactReceiptStillCurrent(access.access.authorizationReceipt)) {
    return ok({
      available: false,
      reason: 'scope_changed',
      why: 'Your portfolio access changed while Staxis was loading it. Refresh before continuing.',
    }, { requestId, headers: PORTFOLIO_PRIVATE_HEADERS });
  }
  return ok({
    available: true,
    organizationId: access.access.organizationId,
    organizationName: access.access.organizationName,
    companyRole: access.access.companyRole,
    authorizedHotelCount: access.access.authorizationReceipt.authorizedPropertyCount,
    hotels: catalog.hotels.map((hotel) => ({
      hotelId: hotel.propertyId,
      name: hotel.name,
      rooms: hotel.totalRooms,
      region: hotel.region,
      timezone: hotel.timezone,
    })),
    portfolios: catalog.portfolios.map((portfolio) => ({
      portfolioId: portfolio.portfolioId,
      name: portfolio.name,
      type: portfolio.type,
      hotelCount: portfolio.propertyIds.length,
    })),
    hotelsNotCovered: 0,
    metadataUnavailableHotelIds: metadata.missingPropertyIds,
  }, { requestId, headers: PORTFOLIO_PRIVATE_HEADERS });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handlePortfolioGet(req);
}

// ─── POST: deterministic query first, bounded synthesis last ───────────────

export async function handlePortfolioPost(
  req: NextRequest,
  overrides: Partial<PortfolioPostDependencies> = {},
): Promise<Response> {
  const dependencies: PortfolioPostDependencies = {
    ...PORTFOLIO_POST_DEPENDENCIES,
    ...overrides,
  };
  const requestId = getOrMintRequestId(req);
  const executionDeadlineAt = Date.now() + ASK_STAXIS_EXECUTION_BUDGET_MS;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const rawBody = await req.json().catch(() => null);
  const parsedBody = portfolioTurnRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return err('invalid portfolio question', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      details: parsedBody.error.flatten(),
    });
  }
  const body = parsedBody.data;
  const caller = await loadSessionAccount(auth.userId);
  if (!caller) {
    return err(PORTFOLIO_REFUSAL_TEXT.no_company_job, {
      requestId, status: 403, code: ApiErrorCode.Forbidden, details: 'no_company_job',
    });
  }

  let existingScope: Awaited<ReturnType<typeof loadConversationScope>> = null;
  if (body.conversationId) {
    existingScope = await loadConversationScope(body.conversationId, caller.accountId);
    if (!existingScope) {
      return err('conversation not found or not yours', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    if (existingScope.conversationKind !== 'portfolio' || !existingScope.organizationId) {
      return err('that conversation is about a single hotel', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (body.organizationId && body.organizationId !== existingScope.organizationId) {
      return err('a portfolio conversation cannot be moved to another company', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
  }

  const organizationId = existingScope?.organizationId ?? body.organizationId ?? null;
  const access = await resolvePortfolioAccessUncached(caller.accountId, organizationId);
  if (!access.ok) {
    return err(PORTFOLIO_REFUSAL_TEXT[access.reason], {
      requestId,
      status: access.reason === 'authorization_unavailable' ? 503 : 403,
      code: access.reason === 'authorization_unavailable' ? ApiErrorCode.UpstreamFailure : ApiErrorCode.Forbidden,
      details: access.reason,
    });
  }
  const baseReceipt = access.access.authorizationReceipt;
  if (existingScope?.authorizationHash
      && existingScope.authorizationHash !== baseReceipt.authorizationHash) {
    return err('Your hotel access changed. Start a new portfolio chat so Staxis can use the new scope.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }
  // This is the first operation after current authoritative scope resolution.
  // Nothing that loads company metadata or fans out to a hotel may move above
  // it. The database makes the rate slot + account/organization lease one
  // atomic, distributed, fail-closed decision.
  const admission = await dependencies.acquireAdmission({
    accountId: caller.accountId,
    organizationId: baseReceipt.organizationId,
  });
  if (!admission.ok) {
    const response = err(
      admission.reason === 'busy'
        ? 'Another portfolio question for this company is still running. Try again shortly.'
        : admission.reason === 'rate_limited'
          ? 'Too many portfolio questions were submitted for this company. Try again shortly.'
          : 'Portfolio query admission is temporarily unavailable. No hotel data was read.',
      {
        requestId,
        status: admission.reason === 'unavailable' ? 503 : 429,
        code: admission.reason === 'unavailable'
          ? ApiErrorCode.UpstreamFailure
          : ApiErrorCode.RateLimited,
        details: admission.reason,
      },
    );
    response.headers.set('Retry-After', String(admission.retryAfterSeconds));
    return response;
  }

  let admissionReleased = false;
  const releaseAdmissionOnce = async (): Promise<void> => {
    if (admissionReleased) return;
    // Mark before awaiting: the production release helper is non-throwing, and
    // this guarantees the outer finally cannot issue a second RPC if a test
    // seam or future implementation unexpectedly rejects.
    admissionReleased = true;
    await dependencies.releaseAdmission({
      accountId: caller.accountId,
      organizationId: baseReceipt.organizationId,
      leaseToken: admission.leaseToken,
    });
  };

  try {
  if (req.signal.aborted || executionDeadlineAt <= Date.now()) {
    return err('The portfolio question was cancelled before any hotel data was read.', {
      requestId, status: 408, code: ApiErrorCode.UpstreamFailure,
    });
  }
  const conversationPolicy = await resolvePortfolioQueuePolicy(
    caller,
    baseReceipt.organizationId,
    baseReceipt.authorizedPropertyIds,
  );
  if (existingScope
      && portfolioPolicyFingerprintFromStamp(existingScope.promptVersion)
        !== conversationPolicy.fingerprint) {
    return err(
      'Your portfolio module or financial access changed. Start a new portfolio chat for the current scope.',
      { requestId, status: 409, code: 'scope_changed' },
    );
  }
  const knowledgeConversationPromptVersion = stampPortfolioPolicy(
    PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
    conversationPolicy.fingerprint,
  );
  const synthesisConversationPromptVersion = stampPortfolioPolicy(
    PROMPT_VERSION,
    conversationPolicy.fingerprint,
  );
  const exactTurnScopeStillCurrent = async (
    currentReceipt: AuthorizationScopeReceipt,
  ): Promise<boolean> => {
    if (!await exactReceiptStillCurrent(currentReceipt)) return false;
    try {
      const currentPolicy = await resolvePortfolioQueuePolicy(
        caller,
        baseReceipt.organizationId,
        baseReceipt.authorizedPropertyIds,
      );
      return currentPolicy.fingerprint === conversationPolicy.fingerprint;
    } catch {
      return false;
    }
  };

  const metadata = await dependencies.loadAuthorizedMetadata({
    receipt: baseReceipt,
    signal: req.signal,
    deadlineAt: executionDeadlineAt - ASK_STAXIS_FALLBACK_RESERVE_MS,
  });
  if (!metadata.ok) {
    return err(scopeErrorText(metadata.reason), {
      requestId,
      status: scopeErrorStatus(metadata.reason),
      code: metadata.reason === 'scope_changed' ? 'scope_changed' : ApiErrorCode.Forbidden,
      details: metadata.reason,
    });
  }
  const catalog = buildPlannerScopeCatalog({ receipt: baseReceipt, metadata });
  const prepared = await prepareScope({
    accountId: caller.accountId,
    organizationId: baseReceipt.organizationId,
    baseReceipt,
    catalog,
    question: body.message,
    requestedSelector: body.selector,
  });
  if ('refusal' in prepared) {
    const noDataScope: PortfolioActiveScopeEvent = {
      type: 'active_scope',
      scope: {
        organizationId: baseReceipt.organizationId,
        organizationName: baseReceipt.organizationName,
        selectorLabel: 'No data scope selected, clarification required',
        selectedHotelCount: 0,
        authorizedHotelCount: baseReceipt.authorizedPropertyCount,
        hotelNames: [],
        hotelNamesOmitted: 0,
        coverage: { reported: 0, total: 0, omitted: 0 },
      },
    };
    // Release is an awaited external boundary. Release first, then make the
    // authorization check the last await before this metadata-bearing SSE.
    await releaseAdmissionOnce();
    if (!await exactTurnScopeStillCurrent(baseReceipt)) {
      return err('Your portfolio access changed while Staxis was clarifying scope. No hotel metadata was released.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    return staticAnswer(prepared.refusal.message, requestId, noDataScope);
  }
  if ('scopeFailure' in prepared) {
    return err(scopeErrorText(prepared.scopeFailure), {
      requestId,
      status: scopeErrorStatus(prepared.scopeFailure),
      code: prepared.scopeFailure === 'scope_changed' ? 'scope_changed' : ApiErrorCode.Forbidden,
      details: prepared.scopeFailure,
    });
  }
  const { receipt, plan, selectorLabel } = prepared;
  const preQueryScope = activeScopeEvent({
    receipt,
    catalog,
    selectorLabel,
    reported: 0,
    omitted: receipt.selectedPropertyCount,
  });

  // Finding/evidence queries are deliberately bounded to one exact, named set
  // of at most 250 hotels. A larger all-authorized receipt is valid authority,
  // but it is not silently truncated or converted into a peer cohort. Ask the
  // manager to choose an explicit portfolio/region/subset before any hotel
  // operational data or pattern candidate is read.
  if (receipt.selectedPropertyCount > PORTFOLIO_FINDING_MAX_SELECTED_PROPERTIES) {
    await releaseAdmissionOnce();
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your portfolio access changed before the scope limit could be shown.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    return staticAnswer(
      `This exact scope contains ${receipt.selectedPropertyCount} hotels. Portfolio answers are limited to ${PORTFOLIO_FINDING_MAX_SELECTED_PROPERTIES} hotels at a time, so I did not omit or substitute any hotel. Choose a portfolio, region, or selected-hotel subset and ask again.`,
      requestId,
      preQueryScope,
    );
  }

  if (plan.intent === 'knowledge_lookup') {
    const now = new Date();
    // The all-authorized plan reuses the base receipt minted before admission
    // and metadata loading. Reassert both the exact hotel universe and the
    // company chat capability immediately before the active-only Finding
    // loader. Its own receipt-bound pre/post assertions close the producer read.
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your hotel access changed before findings or company knowledge could be read. No knowledge was released.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    let findingVersions: PortfolioFindingReceiptV1;
    try {
      const mountedFindings = await loadAndConsumePortfolioFindings({
        receipt,
        now,
        deadlineAt: Math.min(
          executionDeadlineAt - ASK_STAXIS_FALLBACK_RESERVE_MS,
          Date.now() + PORTFOLIO_FINDING_LOAD_TIMEOUT_MS,
        ),
        signal: req.signal,
      }, { loadFindings: dependencies.loadPortfolioFindings });
      const projection = buildPortfolioFindingProjection({
        packageValue: mountedFindings.packageValue,
        accountId: receipt.accountId,
        authorizationHash: receipt.authorizationHash,
        scopeHash: receipt.scopeHash,
        // Deterministic knowledge answers never render Finding claims. Keep the
        // producer/consumer partitions mounted and mark every accepted claim as
        // projection-omitted instead of silently recording `not_mounted`.
        maxProjectedItems: 0,
        producer: mountedFindings.producer,
      });
      findingVersions = buildPortfolioFindingProjectionReceipt({
        projection,
        displayedClaimIds: [],
      });
    } catch (error) {
      log.error('[agent/portfolio] finding mount contract failed closed', {
        requestId,
        organizationId: receipt.organizationId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return err('Current portfolio findings could not be verified safely. No knowledge was released.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    const knowledgeStartedAt = Date.now();
    const knowledgeContext = await companyKnowledgeBlock({
      organizationId: receipt.organizationId,
      propertyIds: receipt.propertyIds,
      now,
      requestId,
      deadlineAt: Math.min(
        executionDeadlineAt - ASK_STAXIS_FALLBACK_RESERVE_MS,
        Date.now() + PORTFOLIO_KNOWLEDGE_BUDGET_MS,
      ),
      signal: req.signal,
    }, {
      loadCompanyFacts: dependencies.loadCompanyKnowledge,
      loadPropertyFacts: dependencies.loadPropertyKnowledge,
    });
    if (req.signal.aborted || executionDeadlineAt <= Date.now()) {
      return err('The portfolio knowledge question was cancelled or exceeded its time budget.', {
        requestId, status: 408, code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your hotel access changed while company knowledge was being verified. No knowledge was released.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }

    if (!knowledgeContext.overlay || !plan.knowledgeQuery) {
      const unavailableAnswer =
        'Current company and selected-hotel knowledge for the active scope could not be verified, so I did not answer from stale, unconfirmed, or inferred notes. Try again.';
      await releaseAdmissionOnce();
      if (!await exactTurnScopeStillCurrent(receipt)) {
        return err('Your hotel access changed before the knowledge status could be released.', {
          requestId, status: 409, code: 'scope_changed',
        });
      }
      return staticAnswer(unavailableAnswer, requestId, preQueryScope);
    }

    let answer: string;
    let claimCatalog: ReturnType<typeof buildPortfolioKnowledgeClaimCatalog>;
    let selectedClaims: ReturnType<typeof selectPortfolioKnowledgeClaims>;
    try {
      claimCatalog = buildPortfolioKnowledgeClaimCatalog({
        receipt,
        catalog,
        overlay: knowledgeContext.overlay,
      });
      selectedClaims = selectPortfolioKnowledgeClaims({
        catalog: claimCatalog,
        query: plan.knowledgeQuery,
      });
      answer = renderPortfolioKnowledgeAnswer({
        catalog: claimCatalog,
        selection: selectedClaims.selection,
        totalMatched: selectedClaims.totalMatched,
        selectorLabel,
      });
    } catch (error) {
      log.error('[agent/portfolio] deterministic knowledge rendering failed closed', {
        requestId,
        organizationId: receipt.organizationId,
        error,
      });
      return err('Current company knowledge could not be rendered under the verified scope. No knowledge was released.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }

    const anchorPropertyId = anchorHotelFor(receipt.propertyIds);
    if (!anchorPropertyId) {
      return err(PORTFOLIO_REFUSAL_TEXT.no_hotels, {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
    let conversationId = body.conversationId;
    try {
      if (conversationId) {
        const prep = await lockLoadAndRecordPortfolioUserTurn({
          conversationId,
          userAccountId: caller.accountId,
          organizationId: receipt.organizationId,
          authorizationHash: receipt.authorizationHash,
          scopeReceiptId: receipt.id,
          userMessage: body.message,
        });
        if (!prep.ok) {
          const status = prep.reason === 'scope_changed' ? 409
            : prep.reason === 'not_found' || prep.reason === 'wrong_owner' ? 404
              : 400;
          return err(
            prep.reason === 'scope_changed'
              ? 'Your hotel access changed. Start a new portfolio chat so Staxis can use the new scope.'
              : 'The portfolio conversation could not be continued.',
            {
              requestId,
              status,
              code: prep.reason === 'scope_changed'
                ? 'scope_changed'
                : ApiErrorCode.ValidationFailed,
              details: prep.reason,
            },
          );
        }
      } else {
        const created = await createPortfolioConversation({
          userAccountId: caller.accountId,
          propertyAnchorId: anchorPropertyId,
          role: caller.role,
          promptVersion: knowledgeConversationPromptVersion,
          title: body.message.slice(0, 120),
          organizationId: receipt.organizationId,
          authorizationHash: receipt.authorizationHash,
          scopeReceiptId: receipt.id,
          userMessage: body.message,
        });
        if (!created.ok) {
          return err(
            created.reason === 'scope_changed'
              ? 'Your hotel access changed. Start a new portfolio chat so Staxis can use the new scope.'
              : 'The portfolio conversation could not be created safely.',
            {
              requestId,
              status: created.reason === 'scope_changed' ? 409 : 503,
              code: created.reason === 'scope_changed'
                ? 'scope_changed'
                : ApiErrorCode.UpstreamFailure,
              details: created.reason,
            },
          );
        }
        conversationId = created.conversationId;
      }
    } catch (error) {
      log.error('[agent/portfolio] deterministic knowledge conversation preparation failed', {
        requestId,
        error,
      });
      return err('The portfolio conversation could not be prepared safely.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (!conversationId || !await exactTurnScopeStillCurrent(receipt)) {
      return err('Your hotel access changed before the knowledge receipt was recorded. No knowledge was released.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }

    let queryReceiptId: string;
    try {
      queryReceiptId = await persistPortfolioKnowledgeReceipt({
        receipt,
        scopeCatalog: catalog,
        plan,
        overlay: knowledgeContext.overlay,
        claimCatalog,
        selection: selectedClaims.selection,
        totalMatched: selectedClaims.totalMatched,
        selectorLabel,
        conversationId,
        question: body.message,
        answer,
        generatedAt: now,
        durationMs: Math.max(0, Date.now() - knowledgeStartedAt),
        findingVersions,
      });
    } catch (error) {
      log.error('[agent/portfolio] immutable deterministic knowledge receipt failed', {
        requestId,
        conversationId,
        error,
      });
      return err('The knowledge answer audit receipt could not be recorded, so no answer was released.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your hotel access changed before the knowledge turn could be committed. No knowledge was released.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    try {
      const committed = await commitPortfolioConversationTurn({
        conversationId,
        userAccountId: caller.accountId,
        organizationId: receipt.organizationId,
        authorizationHash: receipt.authorizationHash,
        scopeReceiptId: receipt.id,
        queryReceiptId,
        userMessage: body.message,
        assistantText: answer,
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: 'deterministic',
        modelId: null,
        costUsd: 0,
        promptVersion: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
      });
      if (!committed.ok) {
        const changed = committed.reason === 'scope_changed'
          || committed.reason === 'scope_unavailable';
        return err(
          changed
            ? 'Your hotel access changed before the knowledge turn could be committed. No knowledge was shown.'
            : 'The receipt-bound knowledge turn could not be committed, so no knowledge was shown.',
          {
            requestId,
            status: changed ? 409 : 503,
            code: changed ? 'scope_changed' : ApiErrorCode.InternalError,
            details: committed.reason,
          },
        );
      }
    } catch (error) {
      log.error('[agent/portfolio] receipt-bound deterministic knowledge commit failed', {
        requestId,
        conversationId,
        error,
      });
      return err('The receipt-bound knowledge answer could not be saved safely, so it was not released.', {
        requestId, status: 503, code: ApiErrorCode.InternalError,
      });
    }

    // Lease release is an awaited external boundary. Reassert current hotel
    // reach and the cross-hotel chat feature after it, with no await remaining
    // before the buffered deterministic answer reaches the browser.
    await releaseAdmissionOnce();
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your hotel access changed before the knowledge answer could be released. No knowledge was shown.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    const knowledgeScope = activeScopeEvent({
      receipt,
      catalog,
      selectorLabel,
      reported: receipt.selectedPropertyCount,
      omitted: 0,
    });
    return sseResponse([
      knowledgeScope,
      { type: 'conversation_id', id: conversationId },
      { type: 'text_delta', delta: answer },
      { type: 'done', finalText: answer },
    ], requestId);
  }

  if (plan.intent === 'generic_tools' || plan.metricIds.length === 0) {
    await releaseAdmissionOnce();
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your portfolio access changed before the scope could be shown.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    return staticAnswer(
      'I can answer current rooms on the books, current housekeeping output, open work orders, and supported comparisons for this scope. I do not have a canonical metric for that question yet, so I did not substitute or estimate one.',
      requestId,
      preQueryScope,
    );
  }
  const unavailableAdapters = plan.metricIds.filter(
    (metric) => metric === 'live_in_house_rooms' || metric === 'final_rooms_sold',
  );
  if (unavailableAdapters.length > 0) {
    await releaseAdmissionOnce();
    if (!await exactTurnScopeStillCurrent(receipt)) {
      return err('Your portfolio access changed before the scope could be shown.', {
        requestId, status: 409, code: 'scope_changed',
      });
    }
    return staticAnswer(
      `The requested measure (${unavailableAdapters.join(', ')}) is defined, but its trusted source adapter is not available on this chat path yet. I did not substitute rooms on the books or estimate a value.`,
      requestId,
      preQueryScope,
    );
  }

  const now = new Date();
  let evidence;
  try {
    evidence = await runPortfolioIntelligence({
      receipt,
      catalog,
      plan,
      assertReceipt: async (receiptId, accountId) => {
        const assertion = await assertAuthorizationScopeReceipt({ receiptId, accountId });
        if (!assertion.ok) return assertion;
        return assertion.receipt.scopeHash === receipt.scopeHash
          && assertion.receipt.authorizationHash === receipt.authorizationHash
          ? { ok: true as const }
          : { ok: false as const, reason: 'scope_changed' };
      },
      now,
      signal: req.signal,
      deadlineAt: executionDeadlineAt - ASK_STAXIS_FALLBACK_RESERVE_MS,
    });
  } catch (error) {
    if (error instanceof PortfolioScopeChangedError) {
      return err(error.message, { requestId, status: 409, code: 'scope_changed', details: error.reason });
    }
    if (error instanceof PortfolioQueryContractError) {
      return err(error.message, { requestId, status: 422, code: ApiErrorCode.ValidationFailed });
    }
    if (error instanceof PortfolioQueryInterruptedError) {
      return err(error.message, {
        requestId,
        status: 408,
        code: ApiErrorCode.UpstreamFailure,
        details: error.reason,
      });
    }
    log.error('[agent/portfolio] deterministic query failed', { requestId, error });
    return err('The portfolio sources could not be queried safely. No answer was synthesized.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!await exactTurnScopeStillCurrent(receipt)) {
    return err('Your hotel access changed before findings or reference knowledge could be read. No answer was synthesized.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }
  let findingsProjection: ReturnType<typeof buildPortfolioFindingPresentationProjection>;
  try {
    const mountedFindings = await loadAndConsumePortfolioFindings({
      receipt,
      now,
      deadlineAt: Math.min(
        executionDeadlineAt - ASK_STAXIS_FALLBACK_RESERVE_MS,
        Date.now() + PORTFOLIO_FINDING_LOAD_TIMEOUT_MS,
      ),
      signal: req.signal,
    }, { loadFindings: dependencies.loadPortfolioFindings });
    findingsProjection = buildPortfolioFindingPresentationProjection({
      evidence,
      packageValue: mountedFindings.packageValue,
      accountId: receipt.accountId,
      authorizationHash: receipt.authorizationHash,
      producer: mountedFindings.producer,
    });
  } catch (error) {
    log.error('[agent/portfolio] finding mount contract failed closed', {
      requestId,
      organizationId: receipt.organizationId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return err('Current portfolio findings could not be verified safely. No answer was synthesized.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }
  const knowledgeContext = await companyKnowledgeBlock({
    organizationId: receipt.organizationId,
    propertyIds: receipt.propertyIds,
    now,
    requestId,
    // Optional reference context must never consume the provider's route
    // budget. It degrades to evidence-only after this narrow sub-budget.
    deadlineAt: Math.min(
      executionDeadlineAt - ASK_STAXIS_FALLBACK_RESERVE_MS,
      Date.now() + PORTFOLIO_KNOWLEDGE_BUDGET_MS,
    ),
    signal: req.signal,
  }, {
    loadCompanyFacts: dependencies.loadCompanyKnowledge,
    loadPropertyFacts: dependencies.loadPropertyKnowledge,
  });
  if (req.signal.aborted || executionDeadlineAt <= Date.now()) {
    return err('The portfolio question was cancelled or exceeded its time budget before synthesis.', {
      requestId, status: 408, code: ApiErrorCode.UpstreamFailure,
    });
  }
  if (!await exactTurnScopeStillCurrent(receipt)) {
    return err('Your hotel access changed while reference knowledge was being prepared. Nothing was sent to the model.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }
  const hotels = selectedHotels(receipt, catalog);
  const systemPrompt = await buildPortfolioIntelligenceSystemPrompt({
    identity: {
      organizationId: receipt.organizationId,
      organizationName: receipt.organizationName,
      hotels,
      omittedHotelCount: 0,
      authorizedHotelCount: receipt.authorizedPropertyCount,
      scopeLabel: selectorLabel,
    },
    companyRole: access.access.companyRole,
    evidence,
    knowledgeBlock: knowledgeContext.block,
    findingsProjection,
    // New conversations do not yet have a row id; the fresh receipt id is a
    // valid, request-unique UUID for prompt lookup/cache assembly. No custom
    // conversation prompt can exist before the row does.
    conversationId: body.conversationId ?? receipt.id,
    now,
  });

  let executionPlan: AiExecutionPlan;
  let estimatedUsd: number;
  try {
    executionPlan = await dependencies.resolveExecutionPlan();
    estimatedUsd = scaleAiReservationUsd(
      [executionPlan.primary, executionPlan.fallback].filter(
        (model): model is NonNullable<typeof model> => model !== null,
      ),
      { usd: COST_LIMITS.estimatedRequestUsd, ...anthropicTierTokenRates('sonnet') },
    );
  } catch (error) {
    return err(error instanceof Error ? error.message : 'Portfolio synthesis is unavailable', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  const anchorPropertyId = existingScope?.propertyId
    && receipt.propertyIds.includes(existingScope.propertyId)
    ? existingScope.propertyId
    : anchorHotelFor(receipt.propertyIds);
  if (!anchorPropertyId) {
    return err(PORTFOLIO_REFUSAL_TEXT.no_hotels, {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }
  const reservation = await dependencies.reserveBudget({
    userId: caller.accountId,
    propertyId: anchorPropertyId,
    estimatedUsd,
  });
  if (!reservation.ok) {
    return err(reservation.message, {
      requestId, status: 429, code: ApiErrorCode.RateLimited, details: reservation.reason,
    });
  }

  let conversationId = body.conversationId;
  let history: AgentMessage[] = [];
  try {
    if (conversationId) {
      const prep = await lockLoadAndRecordPortfolioUserTurn({
        conversationId,
        userAccountId: caller.accountId,
        organizationId: receipt.organizationId,
        authorizationHash: receipt.authorizationHash,
        scopeReceiptId: receipt.id,
        userMessage: body.message,
      });
      if (!prep.ok) {
        await dependencies.cancelReservation(reservation.reservationId);
        const status = prep.reason === 'scope_changed' ? 409
          : prep.reason === 'not_found' || prep.reason === 'wrong_owner' ? 404
            : 400;
        return err(
          prep.reason === 'scope_changed'
            ? 'Your hotel access changed. Start a new portfolio chat so Staxis can use the new scope.'
            : 'The portfolio conversation could not be continued.',
          { requestId, status, code: prep.reason === 'scope_changed' ? 'scope_changed' : ApiErrorCode.ValidationFailed, details: prep.reason },
        );
      }
      history = prep.history;
      if (prep.historyWindow && prep.historyWindow.omittedTurnCount > 0) {
        log.info('[agent/portfolio] bounded conversation replay', {
          requestId,
          conversationId,
          totalTurnCount: prep.historyWindow.totalTurnCount,
          includedTurnCount: prep.historyWindow.includedTurnCount,
          omittedTurnCount: prep.historyWindow.omittedTurnCount,
          totalUtf8Bytes: prep.historyWindow.totalUtf8Bytes,
          includedUtf8Bytes: prep.historyWindow.includedUtf8Bytes,
          omittedUtf8Bytes: prep.historyWindow.omittedUtf8Bytes,
        });
      }
    } else {
      const created = await createPortfolioConversation({
        userAccountId: caller.accountId,
        propertyAnchorId: anchorPropertyId,
        role: caller.role,
          promptVersion: synthesisConversationPromptVersion,
        title: body.message.slice(0, 120),
        organizationId: receipt.organizationId,
        authorizationHash: receipt.authorizationHash,
        scopeReceiptId: receipt.id,
        userMessage: body.message,
      });
      if (!created.ok) {
        await dependencies.cancelReservation(reservation.reservationId);
        return err(
          created.reason === 'scope_changed'
            ? 'Your hotel access changed. Start a new portfolio chat so Staxis can use the new scope.'
            : 'The portfolio conversation could not be created safely.',
          { requestId, status: created.reason === 'scope_changed' ? 409 : 503, code: created.reason === 'scope_changed' ? 'scope_changed' : ApiErrorCode.UpstreamFailure, details: created.reason },
        );
      }
      conversationId = created.conversationId;
    }
  } catch (error) {
    await dependencies.cancelReservation(reservation.reservationId);
    log.error('[agent/portfolio] conversation preparation failed', { requestId, error });
    return err('The portfolio conversation could not be prepared safely.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!await exactTurnScopeStillCurrent(receipt)) {
    await dependencies.cancelReservation(reservation.reservationId);
    return err('Your hotel access changed before synthesis. Nothing was sent to the model.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }

  let failureUsage: UsageReport | null = null;
  let run: Awaited<ReturnType<typeof runAgent>>;
  try {
    run = await dependencies.runSynthesis({
      systemPrompt,
      history,
      newUserMessage: body.message,
      tools: [],
      featureKey: 'agent.portfolio_chat',
      executionPlan,
      deadlineAt: executionDeadlineAt,
      fallbackReserveMs: ASK_STAXIS_FALLBACK_RESERVE_MS,
      outputConfig: PORTFOLIO_PRESENTATION_OUTPUT_CONFIG,
      abortSignal: req.signal,
      onUsage: (usage) => { failureUsage = usage; },
      validateAssistantResponse: ({ text, toolCallCount }) => {
        if (!text.trim()) throw new Error('portfolio synthesis returned an empty answer');
        if (toolCallCount !== 0) throw new Error('portfolio synthesis attempted an unmounted tool');
        const verdict = validatePortfolioPresentationPlan({
          candidate: text,
          evidence,
          findingsProjection,
        });
        if (!verdict.ok) {
          throw new Error(`portfolio presentation plan rejected: ${verdict.reason}`);
        }
      },
      toolContext: {
        user: {
          uid: auth.userId,
          accountId: caller.accountId,
          username: caller.displayName ?? 'company',
          displayName: caller.displayName ?? 'Company',
          role: caller.role,
          propertyAccess: receipt.authorizedPropertyIds,
        },
        propertyId: anchorPropertyId,
        staffId: null,
        requestId,
        surface: 'portfolio',
        conversationId,
        portfolio: {
          organizationId: receipt.organizationId,
          organizationName: receipt.organizationName,
          propertyIds: receipt.propertyIds,
        },
      },
    });
  } catch (error) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: failureUsage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    log.error('[agent/portfolio] bounded synthesis failed', { requestId, conversationId, error });
    return err('Staxis could not finish that portfolio answer.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  const presentationVerdict = validatePortfolioPresentationPlan({
    candidate: run.text,
    evidence,
    findingsProjection,
  });
  const renderedArtifact = presentationVerdict.ok
    ? renderPortfolioAnswerArtifact({
        evidence,
        plan: presentationVerdict.plan,
        selectorLabel,
        findingsProjection,
      })
    : null;
  const renderedAnswer = renderedArtifact?.text ?? null;
  const numberVerdict = renderedAnswer
    ? validatePortfolioAnswerNumbers({
        answer: renderedAnswer,
        systemPrompt,
        findingPayloads: renderedArtifact?.findingNumberReceiptPayloads,
      })
    : { ok: false as const, violations: [] };
  const displayedFindingClaimIds = renderedArtifact?.displayedFindingClaimIds ?? [];
  const findingVersions = buildPortfolioFindingProjectionReceipt({
    projection: findingsProjection,
    displayedClaimIds: displayedFindingClaimIds,
  });
  const authorizationCurrent = await exactTurnScopeStillCurrent(receipt);
  let queryReceiptId: string;
  try {
    queryReceiptId = await persistPortfolioQueryReceipt({
      receipt,
      evidence,
      conversationId,
      question: body.message,
      systemPrompt,
      executionPlan,
      providerRequestAttempts: run.providerRequestAttempts ?? [],
      actualModelId: run.usage.modelId,
      actualModelTier: run.usage.model,
      knowledgeVersions: knowledgeContext.versions,
      findingVersions,
      modelCandidateText: run.text,
      presentationPlan: presentationVerdict.ok ? presentationVerdict.plan : null,
      answerText: renderedAnswer,
      statusOverride: !authorizationCurrent
        ? 'authorization_changed'
        : !presentationVerdict.ok || !numberVerdict.ok
          ? 'abstained'
          : undefined,
    });
  } catch (error) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    log.error('[agent/portfolio] immutable query receipt failed', { requestId, conversationId, error });
    return err('The answer audit receipt could not be recorded, so no answer was released.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!authorizationCurrent) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    return err('Your hotel access changed while Staxis was answering. No answer was released; start a new portfolio chat.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }

  if (!presentationVerdict.ok) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    log.error('[agent/portfolio] ID-only presentation plan withheld', {
      requestId,
      conversationId,
      reason: presentationVerdict.reason,
    });
    return err('Staxis drafted an answer that was not backed by deterministic portfolio evidence, so it was withheld.', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!numberVerdict.ok) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    log.error('[agent/portfolio] number-honesty guard withheld synthesized answer', {
      requestId,
      conversationId,
      violationCount: numberVerdict.violations.length,
      violationKinds: [...new Set(numberVerdict.violations.map((item) => item.kind))],
    });
    return err('Staxis drafted a figure that was not backed by the portfolio evidence, so the answer was withheld.', {
      requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
    });
  }

  if (!renderedAnswer) {
    // Exhaustiveness guard: a validated presentation plan always renders a
    // non-empty deterministic answer. Keep this fail-closed if that invariant
    // changes in a future renderer version.
    return err('The deterministic portfolio renderer produced no answer.', {
      requestId, status: 503, code: ApiErrorCode.InternalError,
    });
  }

  if (!await exactTurnScopeStillCurrent(receipt)) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    return err('Your hotel access changed before the final conversation persistence. No answer was shown.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }

  try {
    const committed = await commitPortfolioConversationTurn({
      conversationId,
      userAccountId: caller.accountId,
      organizationId: receipt.organizationId,
      authorizationHash: receipt.authorizationHash,
      scopeReceiptId: receipt.id,
      queryReceiptId,
      userMessage: body.message,
      assistantText: renderedAnswer,
      tokensIn: run.usage.inputTokens,
      tokensOut: run.usage.outputTokens,
      modelUsed: run.usage.model,
      modelId: run.usage.modelId,
      costUsd: run.usage.costUsd,
      promptVersion: systemPrompt.versionLabel,
    });
    if (!committed.ok) {
      await dependencies.reconcileReservation({
        reservationId: reservation.reservationId,
        conversationId,
        finalUsage: run.usage,
        userId: caller.accountId,
        propertyId: anchorPropertyId,
        requestId,
        feature: 'agent.portfolio_chat',
      });
      const changed = committed.reason === 'scope_changed'
        || committed.reason === 'scope_unavailable';
      return err(
        changed
          ? 'Your hotel access changed before the conversation turn could be committed. No answer was shown.'
          : 'The receipt-bound conversation turn could not be committed, so no answer was shown.',
        {
          requestId,
          status: changed ? 409 : 503,
          code: changed ? 'scope_changed' : ApiErrorCode.InternalError,
          details: committed.reason,
        },
      );
    }
  } catch (error) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    log.error('[agent/portfolio] receipt-bound turn commit failed', { requestId, conversationId, error });
    return err('The receipt-bound answer could not be saved safely, so it was not released.', {
      requestId, status: 503, code: ApiErrorCode.InternalError,
    });
  }

  // Last possible fail-closed check before browser egress. This repeats both
  // receipt/epoch validation and the company cross-hotel-chat capability gate.
  if (!await exactTurnScopeStillCurrent(receipt)) {
    await dependencies.reconcileReservation({
      reservationId: reservation.reservationId,
      conversationId,
      finalUsage: run.usage,
      userId: caller.accountId,
      propertyId: anchorPropertyId,
      requestId,
      feature: 'agent.portfolio_chat',
    });
    return err('Your hotel access changed before the answer could be released. No answer was shown.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }

  await dependencies.reconcileReservation({
    reservationId: reservation.reservationId,
    conversationId,
    finalUsage: run.usage,
    userId: caller.accountId,
    propertyId: anchorPropertyId,
    requestId,
    feature: 'agent.portfolio_chat',
  });

  // Reconciliation and lease release are awaited external boundaries. Release
  // first, then authorize once more and leave no further await before the
  // buffered browser response.
  await releaseAdmissionOnce();
  if (!await exactTurnScopeStillCurrent(receipt)) {
    return err('Your hotel access changed while usage was being finalized. No answer was shown.', {
      requestId, status: 409, code: 'scope_changed',
    });
  }

  const scope = activeScopeEvent({
    receipt,
    catalog,
    selectorLabel,
    reported: evidence.coverage.reported,
    omitted: evidence.coverage.excluded,
  });
  return sseResponse([
    scope,
    { type: 'conversation_id', id: conversationId },
    { type: 'text_delta', delta: renderedAnswer },
    { type: 'done', finalText: renderedAnswer, usage: run.usage },
  ], requestId);
  } finally {
    await releaseAdmissionOnce();
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handlePortfolioPost(req);
}
