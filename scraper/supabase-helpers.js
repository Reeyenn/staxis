/**
 * Shared Supabase helpers for the scraper process.
 *
 * The scraper runs on Railway and writes to the same Supabase project the
 * Next.js app (Vercel) reads from. It uses the service-role key to bypass RLS
 * so every write works regardless of which property row it belongs to.
 *
 * Helpers here:
 *   - createSupabase()            — one shared service-role client
 *   - verifySupabaseAuth()        — startup preflight that crashes loud on
 *                                   bad env vars (see scraper.js rationale)
 *   - getStatus(key)              — read scraper_status row by key
 *   - mergeStatus(key, patch)     — read-modify-write jsonb merge (Postgres
 *                                   has no native jsonb deep-merge, and the
 *                                   scraper is single-tenant so this is safe)
 *   - incrementCounter(key, deltas) — atomic-ish counter bump for the
 *                                   dashboard_counters row used by the
 *                                   weekly digest
 *
 * Every helper accepts the supabase client as its first argument so tests
 * and the vercel-watchdog can inject their own client if needed.
 */

const { createClient } = require('@supabase/supabase-js');

function createSupabase() {
  // Accept either naming convention. Vercel uses NEXT_PUBLIC_SUPABASE_URL
  // (so the browser bundle can read it) and that same var name got copied
  // onto Railway to keep the rotation playbook simple. But older scraper
  // builds read SUPABASE_URL. Take whichever is set — prefer the explicit
  // server-only SUPABASE_URL if both exist.
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `Supabase env vars missing: ${[
        !url && 'SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)',
        !key && 'SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean).join(', ')}`,
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Read a scraper_status row. Returns `{ ...data, _updated_at }` or `{}` if
 * the row doesn't exist. The `_updated_at` key is prefixed so no legitimate
 * app-level field collides with it.
 */
async function getStatus(supabase, key) {
  const { data, error } = await supabase
    .from('scraper_status')
    .select('data, updated_at')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return {};
  const payload = (data.data && typeof data.data === 'object') ? data.data : {};
  return { ...payload, _updated_at: data.updated_at };
}

/**
 * Merge `patch` into scraper_status.data for `key`. Postgres has no native
 * jsonb deep-merge, so we read-modify-write. The scraper is single-tenant
 * so concurrent writers aren't a concern — the Vercel API and the scraper
 * never both write the same scraper_status row at the same time.
 */
async function mergeStatus(supabase, key, patch) {
  const current = await getStatus(supabase, key).catch(() => ({}));
  // strip the internal metadata field before writing
  const { _updated_at, ...clean } = current;
  void _updated_at;
  const merged = { ...clean, ...patch };
  const { error } = await supabase
    .from('scraper_status')
    .upsert({ key, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

/**
 * Increment numeric fields inside scraper_status.data[key]. Used by the
 * weekly digest to track "672/672 pulls succeeded" without keeping a log
 * table. Non-numeric fields in `extras` are set verbatim (e.g. timestamps).
 *
 *   await incrementCounter(supabase, 'dashboard_counters', {
 *     deltas: { totalSuccesses: 1 },
 *     extras: { lastSuccessAt: new Date().toISOString() },
 *   });
 */
async function incrementCounter(supabase, key, { deltas = {}, extras = {} } = {}) {
  const current = await getStatus(supabase, key).catch(() => ({}));
  const { _updated_at, ...clean } = current;
  void _updated_at;
  const next = { ...clean, ...extras };
  for (const [field, delta] of Object.entries(deltas)) {
    const prev = typeof clean[field] === 'number' ? clean[field] : 0;
    next[field] = prev + delta;
  }
  const { error } = await supabase
    .from('scraper_status')
    .upsert({ key, data: next, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

/**
 * Startup preflight. Crashes the process (exit 1) on bad credentials so
 * Railway's crash-loop + the scraper-health cron's stale-heartbeat SMS surface
 * the problem within 15 minutes — instead of silently writing nothing for
 * hours the way the Firestore version did before 2026-04-20.
 */
async function verifySupabaseAuth(supabase, log) {
  try {
    const { error } = await supabase
      .from('scraper_status')
      .select('key')
      .eq('key', 'heartbeat')
      .maybeSingle();
    if (error) throw new Error(error.message);
    log('Supabase auth verified ✓');
  } catch (err) {
    log(`FATAL: Supabase auth failed at startup: ${err.message}`);
    log('This usually means SUPABASE_SERVICE_ROLE_KEY on Railway is stale or revoked.');
    log('Fix: Supabase dashboard → Project Settings → API → Service role key, then update Railway env vars.');
    process.exit(1);
  }
}

/**
 * Append a row to pull_metrics. Best-effort — logs and swallows errors so
 * a metrics-table outage can never crash the actual pull. The metrics table
 * is observation-only; the dashboard / scraper_status row is the source of
 * truth for "is the pull healthy".
 *
 *   await writePullMetric(supabase, {
 *     property_id: 'uuid…',
 *     pull_type: 'csv_morning',
 *     ok: false,
 *     error_code: 'selector_miss',
 *     total_ms: 14732,
 *     login_ms: 4012,
 *     navigate_ms: 2104,
 *   }, log);
 */
async function writePullMetric(supabase, row, log) {
  try {
    const { error } = await supabase.from('pull_metrics').insert(row);
    if (error) throw error;
  } catch (err) {
    if (log) log(`pull_metrics write failed (non-fatal): ${err.message || err}`);
  }
}

/**
 * Read the persisted Playwright storageState for a property, if any.
 * Returns the parsed jsonb blob or null if no row exists / query fails.
 *
 * The blob is fed into `browser.newContext({ storageState: ... })` at
 * scraper boot. Lets a Railway redeploy pick up where the previous
 * container left off instead of forcing a fresh CA login (saves ~10s
 * cold start, dodges CA's anti-bot heuristics that fire on rapid logins).
 */
async function loadScraperSession(supabase, propertyId, log) {
  try {
    const { data, error } = await supabase
      .from('scraper_session')
      .select('state, refreshed_at')
      .eq('property_id', propertyId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (log) log(`Loaded persisted scraper session (refreshed at ${data.refreshed_at})`);
    return data.state || null;
  } catch (err) {
    if (log) log(`scraper_session load failed (continuing without): ${err.message || err}`);
    return null;
  }
}

/**
 * Persist Playwright's current storageState() for a property. Best-effort —
 * a write failure means we lose the redeploy-survival benefit but doesn't
 * affect the running scraper.
 */
async function saveScraperSession(supabase, propertyId, state, log) {
  try {
    const { error } = await supabase
      .from('scraper_session')
      .upsert(
        { property_id: propertyId, state, refreshed_at: new Date().toISOString() },
        { onConflict: 'property_id' },
      );
    if (error) throw error;
  } catch (err) {
    if (log) log(`scraper_session save failed (non-fatal): ${err.message || err}`);
  }
}

module.exports = {
  createSupabase,
  verifySupabaseAuth,
  getStatus,
  mergeStatus,
  incrementCounter,
  writePullMetric,
  loadScraperSession,
  saveScraperSession,
};
