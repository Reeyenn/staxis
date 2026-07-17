/**
 * Shared API-route wrapper — the declarative prologue/epilogue that every
 * /api/* handler was hand-rolling.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nearly every route repeats the same five-step ceremony:
 *
 *   1. mint a requestId (getOrMintRequestId) and, sometimes, an
 *      `{ 'x-request-id': requestId }` header bag,
 *   2. parse the JSON body with a fallback (`try { … } catch { body = {} }`),
 *   3. run an auth/context gate (requireSession / requireAdmin /
 *      requireCronSecret / commsContext / requireOrderingAccess / …) and
 *      short-circuit with its 401/403 response,
 *   4. do route-specific validation + rate-limiting + work,
 *   5. return an `ok(...)` / `err(...)` envelope carrying that requestId
 *      (and, for some routes, the header bag).
 *
 * Steps 1, 2, 3 and the envelope-binding half of 5 are pure boilerplate that
 * drifts subtly between routes. `defineRoute` folds them into one call while
 * preserving BYTE-IDENTICAL HTTP behaviour:
 *
 *   - The gate you pass is the SAME function the route used inline, so auth
 *     order, status codes, and error bodies are unchanged.
 *   - `ctx.ok` / `ctx.err` are the SAME `ok()` / `err()` helpers from
 *     api-response.ts, pre-bound to the gate's requestId + (optional) headers.
 *     Pass any extra option (status, code, details, headers) exactly as before.
 *   - Body parsing runs BEFORE the gate only for `body:'empty'` (the fallback
 *     never short-circuits, so moving it ahead of the gate is unobservable —
 *     the gate still returns its 401/403 for an unauthenticated caller). This
 *     is what lets composite gates read `body.pid`. Routes whose bad-JSON path
 *     must return a specific 4xx BEFORE the gate should keep parsing inline
 *     (pass `body:'none'` and read the body themselves), or they are not a fit.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   - It does NOT hoist rate-limiting. In the wild, validation runs BEFORE the
 *     rate-limit check, and reordering them IS observable (a bad field + an
 *     over-limit caller would 429 instead of 400). Keep `checkAndIncrementRateLimit`
 *     in the handler, in its original position.
 *   - It does NOT add a try/catch unless you ask for one (`wrapErrors`). Routes
 *     without an inline catch rely on Next.js's default 500; silently wrapping
 *     them would change that 500's body. Opt in per-route to match an EXISTING
 *     inline catch, and only when its epilogue is the generic
 *     `err('Internal server error', { status: 500, code: InternalError })`.
 *
 * The batch authors converting the remaining ~310 handlers: see the four
 * gate helpers below (sessionGate / adminGate / cronGate / publicGate) plus
 * the "resolve" escape hatch for domain gates (commsContext, requireOrderingAccess,
 * requireFinanceRollup, …). A route is a fit when its shape is
 * `parse → gate → work → envelope`; anything with interleaved gate/rate-limit
 * ordering (e.g. the public housekeeper reads that rate-limit BEFORE verifying
 * the link token) either keeps that part inline in the handler or is skipped.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import {
  ok as okEnvelope,
  err as errEnvelope,
  ApiErrorCode,
  type OkOptions,
  type ErrOptions,
} from './api-response';
import { getOrMintRequestId } from './log';
import { requireSession, requireCronSecret, type RequireSessionOptions } from './api-auth';
import { requireAdmin } from './admin-auth';

/**
 * The minimum a resolved gate must carry. Every gate in the codebase already
 * returns a `requestId`; `headers` is present only on routes that echo
 * `x-request-id` back to the client (the public/comms surface does, the
 * admin/settings surface doesn't).
 */
export interface GateContext {
  requestId: string;
  headers?: Record<string, string>;
}

/** Short-circuit branch: the gate rejected the request, return its response. */
export interface GateFail {
  ok: false;
  response: Response | NextResponse;
}

/**
 * A gate resolves to either its success context (flagged `ok: true`, carrying
 * at least a requestId) or a `GateFail`. This is EXACTLY the shape the existing
 * gates (requireSession-wrappers, commsContext, requireOrderingAccess,
 * requireFinanceRollup) already return, so they drop in as `resolve` verbatim.
 */
export type ResolveResult = ({ ok: true } & GateContext) | GateFail;

/** The `ok()` / `err()` helpers pre-bound to the gate's requestId + headers. */
export interface BoundEnvelope {
  /** Success envelope. requestId + headers are injected; pass status/extra as needed. */
  ok<T>(data: T, opts?: Omit<OkOptions, 'requestId'>): NextResponse;
  /** Error envelope. requestId + headers are injected; pass status/code/details as needed. */
  err(error: string, opts?: Omit<ErrOptions, 'requestId'>): NextResponse;
}

/** What the handler receives: the gate's fields (minus its `ok` flag), the bound
 *  envelope helpers, the raw request, and the parsed body. */
export type RouteCtx<R extends ResolveResult, TBody> = Omit<
  Extract<R, { ok: true }>,
  'ok'
> &
  BoundEnvelope & { req: NextRequest; body: TBody };

export interface WrapErrorsConfig<R extends ResolveResult> {
  /** Human-readable message for the 500 body. Default 'Internal server error'. */
  message?: string;
  /** HTTP status for the caught-throw path. Default 500. */
  status?: number;
  /** Machine code. Default ApiErrorCode.InternalError. */
  code?: string;
  /** Side-effect logger (log.error, captureException, …). Never affects the response. */
  log?: (e: unknown, ctx: Extract<R, { ok: true }>) => void;
}

export interface DefineRouteConfig<R extends ResolveResult, TBody> {
  /**
   * `'empty'` → parse JSON, falling back to `{}` on bad JSON, BEFORE the gate.
   * `'none'`  → don't touch the body (GET, or the handler parses it itself).
   * Default `'none'`.
   */
  body?: 'empty' | 'none';
  /** The auth/context gate. Receives the parsed body (or `undefined` for `'none'`). */
  resolve: (req: NextRequest, body: TBody) => Promise<R> | R;
  /** Opt in to a try/catch → 500 epilogue that matches an existing inline catch. */
  wrapErrors?: WrapErrorsConfig<R>;
  handler: (
    ctx: RouteCtx<R, TBody>,
  ) => Promise<Response | NextResponse> | Response | NextResponse;
}

function bindEnvelope(
  requestId: string,
  headers: Record<string, string> | undefined,
): BoundEnvelope {
  return {
    ok: (data, opts) => okEnvelope(data, { requestId, headers, ...opts }),
    err: (error, opts) => errEnvelope(error, { requestId, headers, ...opts }),
  };
}

/**
 * Build a Next.js route handler from a declarative config. Returns
 * `(req) => Promise<Response>` — assign it to `export const GET`/`POST`/etc.
 */
export function defineRoute<R extends ResolveResult, TBody = unknown>(
  cfg: DefineRouteConfig<R, TBody>,
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    // 1) Body (only when 'empty' — the fallback never short-circuits, so
    //    parsing it ahead of the gate is unobservable).
    let body = undefined as unknown as TBody;
    if (cfg.body === 'empty') {
      try {
        body = (await req.json()) as TBody;
      } catch {
        body = {} as TBody;
      }
    }

    // 2) Gate.
    const gate = await cfg.resolve(req, body);
    if (!gate.ok) return gate.response;

    // 3) Bind the envelope helpers to this request's id + headers.
    const success = gate as Extract<R, { ok: true }>;
    const bound = bindEnvelope(success.requestId, success.headers);
    const ctx = Object.assign(
      {},
      success,
      bound,
      { req, body },
    ) as unknown as RouteCtx<R, TBody>;

    // 4) Run the handler, optionally under a matching try/catch epilogue.
    if (cfg.wrapErrors) {
      try {
        return await cfg.handler(ctx);
      } catch (e) {
        cfg.wrapErrors.log?.(e, success);
        return errEnvelope(cfg.wrapErrors.message ?? 'Internal server error', {
          requestId: success.requestId,
          headers: success.headers,
          status: cfg.wrapErrors.status ?? 500,
          code: cfg.wrapErrors.code ?? ApiErrorCode.InternalError,
        });
      }
    }
    return await cfg.handler(ctx);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in gate helpers for the plain-auth families. Domain routes pass their
// existing composite gate (commsContext, requireOrderingAccess, …) as `resolve`
// directly — these cover the routes that used a bare requireSession/requireAdmin/
// requireCronSecret inline.
// ─────────────────────────────────────────────────────────────────────────────

/** Result of {@link sessionGate}. */
export interface SessionGateCtx extends GateContext {
  ok: true;
  userId: string;
  email: string | null;
}

/**
 * `requireSession` + requestId, in the wrapper's gate shape.
 *
 * `attachHeaders` (default false) mirrors the split in the wild: routes that
 * echoed `{ 'x-request-id': requestId }` on every ok/err set it true; routes
 * that passed only `{ requestId }` leave it false. Match the ROUTE you're
 * converting so headers stay byte-identical.
 */
export async function sessionGate(
  req: NextRequest,
  opts: RequireSessionOptions & { attachHeaders?: boolean } = {},
): Promise<SessionGateCtx | GateFail> {
  const requestId = getOrMintRequestId(req);
  const headers = opts.attachHeaders ? { 'x-request-id': requestId } : undefined;
  const { attachHeaders, ...sessionOpts } = opts;
  void attachHeaders;
  const session = await requireSession(req, { requestId, ...sessionOpts });
  if (!session.ok) return { ok: false, response: session.response };
  return { ok: true, requestId, headers, userId: session.userId, email: session.email };
}

/** Result of {@link publicGate}. */
export interface PublicGateCtx extends GateContext {
  ok: true;
  headers: Record<string, string>;
}

/**
 * No auth — just requestId + an `x-request-id` header bag, for public pages
 * that do their own capability check (pid + staffId + link token) inside the
 * handler. Returns `ok: true` unconditionally; the handler runs the gate.
 */
export function publicGate(req: NextRequest): PublicGateCtx {
  const requestId = getOrMintRequestId(req);
  return { ok: true, requestId, headers: { 'x-request-id': requestId } };
}

/** Result of {@link cronGate}. */
export interface CronGateCtx extends GateContext {
  ok: true;
}

/**
 * `requireCronSecret` + requestId. requestId is minted first (matching the
 * routes that mint before the cron check — the order is unobservable since
 * the 401 body carries no requestId either way). No header bag: cron routes
 * pass only `{ requestId }` to their envelopes.
 */
export function cronGate(req: NextRequest): CronGateCtx | GateFail {
  const requestId = getOrMintRequestId(req);
  const gate = requireCronSecret(req);
  if (gate) return { ok: false, response: gate };
  return { ok: true, requestId };
}

/** Result of {@link adminGate}. */
export interface AdminGateCtx extends GateContext {
  ok: true;
  userId: string;
  email: string | null;
  accountId: string;
}

/**
 * `requireAdmin` + requestId. No header bag (the admin surface passes only
 * `{ requestId }`). requestId is minted before the admin check to match the
 * inline routes; the admin 401/403 carries no requestId either way.
 */
export async function adminGate(req: NextRequest): Promise<AdminGateCtx | GateFail> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return { ok: false, response: admin.response };
  return {
    ok: true,
    requestId,
    userId: admin.userId,
    email: admin.email,
    accountId: admin.accountId,
  };
}
