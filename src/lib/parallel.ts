/**
 * Parallel fan-out helpers for the ML cron routes.
 *
 * Background: the /api/cron/ml-train-* and ml-predict-* routes used to loop
 * sequentially over properties — fine at N=1, painful at N=10 because the
 * total wall-clock is N * avg_call_latency. At Railway-side training
 * latencies of ~3-10s, 10 hotels = 30-100s and we'd risk Vercel's 60s
 * route timeout cap.
 *
 * The fix: run them in parallel with a concurrency cap (so we don't OOM
 * the small Railway ML instance with N concurrent XGBoost fits). 5 is a
 * good compromise — gives ~5x speedup vs sequential while keeping memory
 * pressure manageable. Tunable per call if we ever need to dial it down
 * for memory-heavy stages.
 *
 * `Promise.allSettled`-style semantics: every task runs to completion;
 * failures don't cancel the rest. The caller gets back per-task
 * status/results so partial-success aggregation works the same as the
 * old sequential loop's per-iteration try/catch.
 */

export interface FanoutResult<T, R> {
  input: T;
  ok: true;
  value: R;
}

export interface FanoutFailure<T> {
  input: T;
  ok: false;
  error: unknown;
}

export type FanoutOutcome<T, R> = FanoutResult<T, R> | FanoutFailure<T>;

/**
 * Pull (shard_offset, shard_count) from a request URL and return only
 * the slice of items this shard should process.
 *
 * Why this exists: the ML cron routes loop across every property. At
 * 50+ hotels with realistic ML latency we hit the Vercel function
 * timeout (60-300s depending on plan). Sharding lets us dispatch
 * multiple GitHub Actions jobs concurrently, each handling a slice.
 *
 * Cron workflow dispatches:
 *   GET /api/cron/ml-run-inference?shard_offset=0&shard_count=4
 *   GET /api/cron/ml-run-inference?shard_offset=1&shard_count=4
 *   GET /api/cron/ml-run-inference?shard_offset=2&shard_count=4
 *   GET /api/cron/ml-run-inference?shard_offset=3&shard_count=4
 *
 * Each invocation only sees properties.filter((_, i) => i % 4 === offset).
 * Defaults to (0, 1) — no sharding, all properties to this shard. So
 * adding sharding to the workflow doesn't require touching the route.
 *
 * Returns the filtered items + a header string for logs/responses.
 */
export function applyShardFilter<T>(
  items: T[],
  searchParams: URLSearchParams,
): { items: T[]; shardOffset: number; shardCount: number; header: string } {
  const rawOffset = parseInt(searchParams.get('shard_offset') ?? '0', 10);
  const rawCount = parseInt(searchParams.get('shard_count') ?? '1', 10);
  const shardCount = Number.isFinite(rawCount) && rawCount >= 1 && rawCount <= 64 ? rawCount : 1;
  const shardOffset = Number.isFinite(rawOffset) && rawOffset >= 0 && rawOffset < shardCount ? rawOffset : 0;
  if (shardCount === 1) {
    return { items, shardOffset: 0, shardCount: 1, header: 'shard=1/1 (no sharding)' };
  }
  const filtered = items.filter((_, i) => i % shardCount === shardOffset);
  return {
    items: filtered,
    shardOffset,
    shardCount,
    header: `shard=${shardOffset + 1}/${shardCount} (${filtered.length}/${items.length} properties)`,
  };
}

/**
 * Run an async task over each item in `items` with at most `concurrency`
 * in flight at once. Returns one outcome per input in input order.
 *
 * @param items        Inputs (e.g. properties).
 * @param task         Async function applied to each input.
 * @param concurrency  Max parallel in-flight tasks. Default 5.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  task: (input: T) => Promise<R>,
  concurrency = 5,
): Promise<Array<FanoutOutcome<T, R>>> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<FanoutOutcome<T, R>>(items.length);
  let nextIdx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      const input = items[i];
      try {
        const value = await task(input);
        results[i] = { input, ok: true, value };
      } catch (error) {
        results[i] = { input, ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: cap }, worker));
  return results;
}
