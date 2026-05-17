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

import { env } from '@/lib/env';

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
  // ML_SERVICE_URLS is the canonical name; legacy ML_SERVICE_URL is
  // collapsed into it at env-parse time (see src/lib/env.ts). Multi-
  // shard is just multiple comma-separated URLs in one var.
  const raw = env.ML_SERVICE_URLS;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(URL_LIST_DELIMITER)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
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
 * Deterministic 32-bit hash of a property identifier.
 *
 * Earlier draft sliced the first 8 hex chars of the UUID. That worked
 * for UUID v4 (the first 8 chars are uniformly random) but would
 * catastrophically fail for UUID v7 — the first 8 chars are a
 * monotonically increasing timestamp prefix, so every property created
 * in a given second lands on the same shard. We don't use v7 today,
 * but writing code that quietly breaks the day someone changes the
 * UUID generator is exactly the kind of long-term landmine this audit
 * is supposed to find.
 *
 * FNV-1a across the full string mixes ALL bytes into the result —
 * uniform output regardless of input structure (v4, v7, ULIDs, ksuids,
 * or even a non-UUID string from a test fixture). Public-domain prime
 * constants from RFC 1320 / Glenn Fowler.
 *
 * Empty / non-string input collapses to the FNV offset basis (constant
 * 0x811c9dc5), pinning bad input to a deterministic shard rather than
 * crashing — same fail-safe shape as the prior version.
 */
function stableHashUuid(input: string): number {
  if (typeof input !== 'string' || input.length === 0) return 0x811c9dc5;
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime is 16777619; the equivalent shift+add expression is
    // standard for FNV in JS to avoid the >32-bit overflow that
    // straight multiplication would hit.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Internal helper exported for unit tests. Not part of the public API.
 * @internal
 */
export const _internal = { stableHashUuid };
