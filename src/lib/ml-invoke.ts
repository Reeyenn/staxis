/**
 * triggerMlTraining — single primitive for invoking the Python ML service's
 * per-property training endpoints (/train/demand, /train/supply,
 * /train/inventory-rate). Phase M3.1 (2026-05-14).
 *
 * The 4 existing callers (3 ml-train-* cron routes + the inventory retrain
 * admin route) inline the same fetch boilerplate today. The on-onboard hook
 * added in M3.1 commit 6 needs the same primitive. Centralizing here means:
 *   - one place to update auth shape if the ML service ever changes it
 *   - one place to update timeout / retry strategy
 *   - one shape of structured log line for "training was invoked from X"
 *   - consistent shard resolution (resolveMlShardUrl) so multi-shard
 *     deploys route per-property correctly
 *
 * NEVER throws. The function is designed to be safe to call fire-and-forget
 * from request handlers (e.g. on the onboarding wizard finalize) where a
 * failed ML call must not surface to the user — the daily aggregator cron
 * is the safety net that re-tries the next morning.
 *
 * Phase E2E (2026-05-22): added shape validation at the boundary. If
 * FastAPI ever changes its response shape (renames a field, changes a type),
 * `validateMlBoundaryShape` flags it via captureMessage with a deduping
 * fingerprint so the cron heartbeat flips error instead of silently passing
 * malformed payloads through to callers that cast unknown JSON.
 */

import * as Sentry from '@sentry/nextjs';
import { resolveMlShardUrl } from '@/lib/ml-routing';
import { log } from '@/lib/log';
import { env } from '@/lib/env';

/** Layer name in the URL path: POST {shard}/train/{layer} */
export type MlTrainingLayer = 'demand' | 'supply' | 'inventory-rate';

export interface TriggerMlTrainingResult {
  /** True iff HTTP 2xx AND no `error` key in the JSON body AND status != 'error'. */
  ok: boolean;
  /**
   * High-level outcome:
   *   - 'ok'            — training accepted by ML service
   *   - 'not_configured' — ML_SERVICE_URL/ML_SERVICE_SECRET missing (caller treats as no-op)
   *   - 'error'         — ML service returned an error or unreachable
   *   - any other string — pass-through of ML service's `status` field
   *                        (e.g. 'insufficient_data', 'cold_start_installed')
   */
  status: string;
  /** HTTP status code from the ML service, or undefined when not reached. */
  http?: number;
  /** Raw JSON body for inspection; empty object when no body. */
  detail?: unknown;
  /** Top-level `error` field from the ML service body (if present). */
  error?: string;
  elapsedMs: number;
}

interface TriggerMlTrainingOptions {
  /** Item UUID for inventory-rate per-item training. Ignored for demand/supply. */
  itemId?: string;
  /** Request ID forwarded as x-request-id header. */
  requestId?: string;
  /** Defaults to 45_000 (matches the existing cron-route timeout). */
  timeoutMs?: number;
}

export async function triggerMlTraining(
  propertyId: string,
  layer: MlTrainingLayer,
  options: TriggerMlTrainingOptions = {},
): Promise<TriggerMlTrainingResult> {
  const t0 = Date.now();
  const mlServiceSecret = env.ML_SERVICE_SECRET;
  const mlServiceUrl = resolveMlShardUrl(propertyId);

  if (!mlServiceUrl || !mlServiceSecret) {
    log.info('ml_train_invoked', {
      layer,
      pid: propertyId,
      mlStatus: 'not_configured',
      durationMs: Date.now() - t0,
    });
    return { ok: false, status: 'not_configured', elapsedMs: Date.now() - t0 };
  }

  const body: Record<string, unknown> = { property_id: propertyId };
  if (options.itemId) body.item_id = options.itemId;

  try {
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/train/${layer}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        ...(options.requestId ? { 'x-request-id': options.requestId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
    const json = await res
      .json()
      .catch(() => ({ error: 'non_json_response', http: res.status }) as Record<string, unknown>);

    const shape = validateMlBoundaryShape(json);
    if (!shape.valid) {
      reportShapeMismatch({
        endpoint: `/train/${layer}`,
        propertyId,
        itemId: options.itemId,
        requestId: options.requestId,
        reason: shape.reason,
        http: res.status,
      });
      log.warn('ml_train_invoked', {
        layer,
        pid: propertyId,
        mlStatus: 'shape_mismatch',
        durationMs: Date.now() - t0,
      });
      return {
        ok: false,
        status: 'error',
        http: res.status,
        error: `response_shape_mismatch: ${shape.reason}`,
        detail: json,
        elapsedMs: Date.now() - t0,
      };
    }

    const status = (json as { status?: string }).status ?? (res.ok ? 'ok' : 'error');
    const error = (json as { error?: string }).error;
    const ok = res.ok && status !== 'error' && !error;

    log.info('ml_train_invoked', {
      layer,
      pid: propertyId,
      mlStatus: status,
      status: res.status,  // HTTP status — LogFields field
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
    log.warn('ml_train_invoked', {
      layer,
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
// Shape validation — shared between training (above) and prediction
// (ml-predict-invoke.ts). The web app only reads `status`, `error`, and a
// small set of optional numeric fields off ML responses; this validator
// asserts only those fields' types, NOT the presence of every Pydantic
// field. That matches the audit principle "only enforce what the caller
// reads" so legitimate FastAPI additions don't flag as drift.
// ---------------------------------------------------------------------------

export type MlShapeValidation = { valid: true } | { valid: false; reason: string };

export function validateMlBoundaryShape(
  json: unknown,
  extraChecks?: (obj: Record<string, unknown>) => string | null,
): MlShapeValidation {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { valid: false, reason: `root_not_object: ${json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json}` };
  }
  const obj = json as Record<string, unknown>;
  if ('status' in obj && typeof obj.status !== 'string') {
    return { valid: false, reason: `status_type: ${typeof obj.status}` };
  }
  // `error: null` is FastAPI/pydantic's legitimate "no error" encoding
  // (Optional[str] = None serializes as null, e.g. TrainInventoryRateResponse).
  // Only a NON-null, non-string error is shape drift. Rejecting null here made
  // every inventory training run report status:'error' despite a clean summary
  // (first observed 2026-07-05, the first live run since this validator landed
  // 2026-05-22 — the crons were disabled 2026-05-30 before it could ever fire).
  if ('error' in obj && obj.error !== null && typeof obj.error !== 'string') {
    return { valid: false, reason: `error_type: ${typeof obj.error}` };
  }
  if (extraChecks) {
    const extra = extraChecks(obj);
    if (extra) return { valid: false, reason: extra };
  }
  return { valid: true };
}

/**
 * Sentry alert for a shape-mismatch event. Uses a deduping fingerprint so a
 * repeated drift (e.g. every cron tick during an outage) collapses into a
 * single Sentry issue per endpoint rather than spamming.
 */
export function reportShapeMismatch(args: {
  endpoint: string;
  propertyId?: string;
  itemId?: string;
  requestId?: string;
  reason: string;
  http: number;
}): void {
  try {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['ml_response_shape_mismatch', args.endpoint]);
      scope.setLevel('warning');
      scope.setExtras({
        endpoint: args.endpoint,
        propertyId: args.propertyId,
        itemId: args.itemId,
        requestId: args.requestId,
        reason: args.reason,
        http: args.http,
      });
      if (args.propertyId) {
        scope.setTag('property.id', args.propertyId);
      }
      scope.setTag('ml.endpoint', args.endpoint);
      Sentry.captureMessage(`ml_response_shape_mismatch: ${args.endpoint}`);
    });
  } catch {
    // Sentry SDK is fire-and-forget; we never want telemetry to break the
    // wrapper. Suppress any rare init/transport failure.
  }
}
