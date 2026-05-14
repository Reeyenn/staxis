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
 */

import { resolveMlShardUrl } from '@/lib/ml-routing';
import { log } from '@/lib/log';

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
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
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
