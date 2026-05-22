/**
 * Predict-side mirror of ml-invoke.ts. Phase E2E (2026-05-22).
 *
 * The 2 ml-* prediction cron routes (ml-run-inference, ml-predict-inventory)
 * inline the same fetch boilerplate today AND don't validate that the ML
 * service's response shape still matches what TypeScript expects. This file
 * centralizes both concerns:
 *
 *   - predictDemand, predictSupply, predictOptimizer — used by
 *     ml-run-inference/route.ts (each property gets three sequential calls,
 *     all pinned to the same shard).
 *   - predictInventoryRates — used by ml-predict-inventory/route.ts (one
 *     call per property, aggregate response covering all items).
 *
 * Like triggerMlTraining, these NEVER throw. The cron routes consume a
 * structured result and the heartbeat-degraded logic stays in the route
 * (not the wrapper) so the cron can still emit property_misconfigured app
 * events with route-specific layer names.
 *
 * Shape validation lives in ml-invoke.ts (validateMlBoundaryShape +
 * reportShapeMismatch) and is shared by both train and predict paths.
 */

import { resolveMlShardUrl } from '@/lib/ml-routing';
import { log } from '@/lib/log';
import { env } from '@/lib/env';
import { validateMlBoundaryShape, reportShapeMismatch } from '@/lib/ml-invoke';

/** Layer name in the URL path: POST {shard}/predict/{layer} */
export type MlPredictLayer = 'demand' | 'supply' | 'optimizer' | 'inventory-rate';

export interface MlPredictResult {
  /** True iff HTTP 2xx AND no `error` key AND no shape mismatch. */
  ok: boolean;
  /**
   *   - 'ok'             — request succeeded, response shape valid
   *   - 'not_configured' — ML service env vars missing
   *   - 'error'          — HTTP non-2xx, error field set, or network failure
   *   - 'shape_mismatch' — response shape broke the contract (Sentry alerted)
   *   - any other string — pass-through of ML service's `status` field
   */
  status: string;
  /** HTTP status code from the ML service, or undefined on network error. */
  http?: number;
  /** Raw JSON body (or fallback object for non-JSON). */
  detail?: unknown;
  /** Top-level `error` field from the ML service body (if present). */
  error?: string;
  elapsedMs: number;
}

interface PredictOptions {
  /** Request ID forwarded as x-request-id header. */
  requestId?: string;
  /** Per-call timeout. Defaults differ by layer — see callers. */
  timeoutMs?: number;
}

interface InvokePredictArgs {
  propertyId: string;
  path: string;
  body: Record<string, unknown>;
  options: PredictOptions;
  extraChecks?: (obj: Record<string, unknown>) => string | null;
  defaultTimeoutMs: number;
}

async function invokePredict(args: InvokePredictArgs): Promise<MlPredictResult> {
  const { propertyId, path, body, options, extraChecks, defaultTimeoutMs } = args;
  const t0 = Date.now();
  const mlServiceSecret = env.ML_SERVICE_SECRET;
  const mlServiceUrl = resolveMlShardUrl(propertyId);

  if (!mlServiceUrl || !mlServiceSecret) {
    log.info('ml_predict_invoked', {
      path,
      pid: propertyId,
      mlStatus: 'not_configured',
      durationMs: Date.now() - t0,
    });
    return { ok: false, status: 'not_configured', elapsedMs: Date.now() - t0 };
  }

  try {
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        ...(options.requestId ? { 'x-request-id': options.requestId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
    });
    const json = await res
      .json()
      .catch(() => ({ error: 'non_json_response', http: res.status }) as Record<string, unknown>);

    const shape = validateMlBoundaryShape(json, extraChecks);
    if (!shape.valid) {
      reportShapeMismatch({
        endpoint: path,
        propertyId,
        requestId: options.requestId,
        reason: shape.reason,
        http: res.status,
      });
      log.warn('ml_predict_invoked', {
        path,
        pid: propertyId,
        mlStatus: 'shape_mismatch',
        durationMs: Date.now() - t0,
      });
      return {
        ok: false,
        status: 'shape_mismatch',
        http: res.status,
        error: `response_shape_mismatch: ${shape.reason}`,
        detail: json,
        elapsedMs: Date.now() - t0,
      };
    }

    const status = (json as { status?: string }).status ?? (res.ok ? 'ok' : 'error');
    const error = (json as { error?: string }).error;
    const ok = res.ok && status !== 'error' && !error;

    log.info('ml_predict_invoked', {
      path,
      pid: propertyId,
      mlStatus: status,
      status: res.status,
      ok,
      durationMs: Date.now() - t0,
    });

    return {
      ok,
      status,
      http: res.status,
      detail: json,
      error,
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.warn('ml_predict_invoked', {
      path,
      pid: propertyId,
      mlStatus: 'error',
      error,
      durationMs: Date.now() - t0,
    });
    return {
      ok: false,
      status: 'error',
      error,
      elapsedMs: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-endpoint wrappers. Each binds a path, default timeout, and a narrow
// shape check covering ONLY the fields the web app actually reads off the
// response. The remaining FastAPI fields (model_version, algorithm, etc.)
// are intentionally unchecked — FastAPI is allowed to add fields without
// triggering shape_mismatch alarms.
// ---------------------------------------------------------------------------

export interface PredictTimeOptions extends PredictOptions {
  date: string;
  propertyTimezone: string;
}

/** POST /predict/demand. Reads from response: `status`, `error`. */
export async function predictDemand(
  propertyId: string,
  opts: PredictTimeOptions,
): Promise<MlPredictResult> {
  return invokePredict({
    propertyId,
    path: '/predict/demand',
    body: {
      property_id: propertyId,
      date: opts.date,
      property_timezone: opts.propertyTimezone,
    },
    options: opts,
    defaultTimeoutMs: 45_000,
  });
}

/** POST /predict/supply. Reads from response: `status`, `error`. */
export async function predictSupply(
  propertyId: string,
  opts: PredictTimeOptions,
): Promise<MlPredictResult> {
  return invokePredict({
    propertyId,
    path: '/predict/supply',
    body: {
      property_id: propertyId,
      date: opts.date,
      property_timezone: opts.propertyTimezone,
    },
    options: opts,
    defaultTimeoutMs: 45_000,
  });
}

/**
 * POST /predict/optimizer (Layer-3 Monte Carlo). Reads from response:
 * `status`, `error`. Depends on demand+supply rows already being written
 * for the same (property_id, date) — caller must sequence stages.
 */
export async function predictOptimizer(
  propertyId: string,
  opts: PredictTimeOptions,
): Promise<MlPredictResult> {
  return invokePredict({
    propertyId,
    path: '/predict/optimizer',
    body: {
      property_id: propertyId,
      date: opts.date,
      property_timezone: opts.propertyTimezone,
    },
    options: opts,
    defaultTimeoutMs: 45_000,
  });
}

export interface PredictInventoryOptions extends PredictOptions {
  propertyTimezone: string;
}

/**
 * POST /predict/inventory-rate. One call per property; the ML service
 * iterates items internally and returns an aggregate.
 *
 * Reads from response: `status`, `error`, `predicted` (for logging only).
 * Inventory-rate is the only predict endpoint where the web app actually
 * inspects a numeric field on the response (everything else lives in the
 * downstream prediction tables the ML service writes to directly).
 */
export async function predictInventoryRates(
  propertyId: string,
  opts: PredictInventoryOptions,
): Promise<MlPredictResult> {
  return invokePredict({
    propertyId,
    path: '/predict/inventory-rate',
    body: {
      property_id: propertyId,
      property_timezone: opts.propertyTimezone,
    },
    options: opts,
    defaultTimeoutMs: 75_000,
    extraChecks: (obj) => {
      if ('predicted' in obj && typeof obj.predicted !== 'number') {
        return `predicted_type: ${typeof obj.predicted}`;
      }
      return null;
    },
  });
}
