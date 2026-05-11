/**
 * ML service shard routing.
 *
 * Background: today we run ONE Railway Python ML service. Every cron in
 * src/app/api/cron/ml-* reads `ML_SERVICE_URL` directly and POSTs there.
 * That's fine for 1-10 hotels — XGBoost training fits comfortably on a
 * single 512MB Railway instance with the existing concurrency cap of 5.
 *
 * Tier 3 ("before hotel #50") scales this to N shards. Each shard is a
 * separate Railway service; properties are deterministically partitioned
 * by UUID hash. The DB stays shared — model_runs / predictions / priors
 * live in Supabase, so shards don't need to coordinate; they just take
 * different read/write slices.
 *
 * Two env-var modes:
 *
 *   1. Single-shard (today, the default):
 *      ML_SERVICE_URL=https://staxis-ml.railway.app
 *      → resolveMlShardUrl(any pid) returns that URL.
 *      → Net behavior change vs pre-Tier-3 code: zero.
 *
 *   2. Multi-shard (when we deploy shard 1+):
 *      ML_SERVICE_URLS=https://ml-shard-0.railway.app,https://ml-shard-1.railway.app
 *      → resolveMlShardUrl(pid) hashes the UUID and picks one URL.
 *      → Same pid always lands on the same shard (deterministic).
 *      → ML_SERVICE_URL is ignored if ML_SERVICE_URLS is set, so the
 *        cutover is a single env-var change on Vercel.
 *
 * Why client-side routing (cron picks the shard) instead of server-side
 * (each shard refuses requests not in its slice)?
 *   - Cron has the property list in hand already, knows which to call.
 *   - Server-side would waste round trips on rejections.
 *   - One source of truth for the partition function (this file).
 *
 * Resharding (e.g. 2 → 3 shards): properties land on different shards
 * after the change. Safe because training/inference are idempotent and
 * write to the shared Supabase DB — a stray write from the "old" shard
 * during the cutover doesn't cause data loss, at worst one duplicate
 * model_run row that the shadow-evaluate cron handles. Schedule a
 * maintenance window if you want zero overlap.
 */

const URL_LIST_DELIMITER = ',';

/**
 * Resolve the shard URL that owns a given property. Returns null if
 * neither ML_SERVICE_URLS nor ML_SERVICE_URL is set (caller's cue to
 * skip the ML call entirely — what every cron does today when the ML
 * service isn't deployed in a given environment).
 */
export function resolveMlShardUrl(propertyId: string): string | null {
  const urls = listMlShardUrls();
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];
  const idx = stableHashUuid(propertyId) % urls.length;
  return urls[idx];
}

/**
 * Return all configured shard URLs. Used by:
 *   - Fleet-wide health checks that need to ping every shard.
 *   - Resharding scripts that need the current set.
 *
 * Single-shard deploys: a one-element array [ML_SERVICE_URL].
 * Multi-shard:          ML_SERVICE_URLS split + trimmed.
 * Unconfigured:         empty array.
 */
export function listMlShardUrls(): string[] {
  // ML_SERVICE_URLS takes precedence so the multi-shard cutover is a
  // single env-var addition — no need to also clear ML_SERVICE_URL.
  const multi = process.env.ML_SERVICE_URLS;
  if (multi && multi.trim()) {
    return multi
      .split(URL_LIST_DELIMITER)
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
  }
  const single = process.env.ML_SERVICE_URL;
  return single && single.trim() ? [single.trim()] : [];
}

/**
 * Return the "primary" shard URL for fleet-wide operations that don't
 * partition by property — namely the inventory_rate_priors aggregator,
 * which reads from the shared DB across all properties regardless of
 * shard. Any shard CAN run it; we pick the first one deterministically
 * so the same shard hosts the cross-fleet work every day (useful for
 * capacity planning and log grouping).
 *
 * Returns null when nothing is configured.
 */
export function getPrimaryMlShardUrl(): string | null {
  const urls = listMlShardUrls();
  return urls.length > 0 ? urls[0] : null;
}

/**
 * Deterministic 32-bit hash of a UUID. UUIDs are random hex, so the
 * first 8 hex chars are already a uniform 32-bit value — no need for
 * a real hash function. parseInt(slice, 16) and we're done.
 *
 * Non-UUID strings (e.g. a hyphenless property id, or a test value)
 * fall back to 0 rather than crashing — they land on shard 0, which
 * is the same behavior as a single-shard deploy.
 */
function stableHashUuid(uuid: string): number {
  if (typeof uuid !== 'string') return 0;
  const stripped = uuid.replace(/-/g, '');
  if (stripped.length < 8) return 0;
  const n = parseInt(stripped.slice(0, 8), 16);
  return Number.isFinite(n) ? (n >>> 0) : 0;
}

/**
 * Internal helper exported for unit tests. Not part of the public API.
 * @internal
 */
export const _internal = { stableHashUuid };
