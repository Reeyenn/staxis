/**
 * scraper/properties-loader.js
 *
 * Scaffolding for multi-property scraping. Reads the active properties
 * this scraper instance should poll, with a graceful fallback to the
 * legacy env-var single-property model when the table is empty (or the
 * scraper deployment is in transition).
 *
 * STATUS (2026-04-29):
 *   This module is wired up but NOT yet driving the scraper.js tick loop.
 *   Once `scraper.js` is refactored to iterate across multiple properties
 *   per tick (managing Playwright contexts per-property, deduping login
 *   sessions, etc.), it will switch from reading process.env.HOTELOPS_PROPERTY_ID
 *   to calling `loadActiveProperties(supabase)` here.
 *
 *   See migration 0018_scraper_credentials.sql for the source-of-truth
 *   schema and `Second Brain/02 Projects/HotelOps AI/Project Overview …`
 *   open-problems list under "Auto-tick multi-property scraper loop".
 *
 * Migration plan (sketch):
 *   1. Insert one row in scraper_credentials per active property.
 *      property_id = ..., ca_username = ..., ca_password = ...,
 *      scraper_instance = 'default' or '<railway-deployment-id>'.
 *   2. Set RAILWAY env var SCRAPER_INSTANCE_ID (matches scraper_instance).
 *   3. Refactor scraper.js tick to:
 *        for (const prop of await loadActiveProperties(supabase)) {
 *          await pollProperty(prop);  // existing pull funcs scoped by prop
 *        }
 *   4. Stagger Playwright contexts so two properties' logins don't
 *      collide (different storage state files per property_id).
 *   5. Decommission HOTELOPS_PROPERTY_ID, CA_USERNAME, CA_PASSWORD env
 *      vars on Railway once the table-driven path is verified.
 *
 * What this file currently DOES:
 *   - Provides a single async function to read the active set of
 *     properties this scraper instance is responsible for.
 *   - Falls back to a synthetic "single property from env" record when
 *     the table is empty, so today's behavior is unchanged.
 *   - Caches the result for a short window so the tick loop doesn't
 *     hammer Postgres for the property list every 5 minutes.
 */

const ENV_FALLBACK_INSTANCE_ID = 'default';

/** How long to cache the property list before re-reading from the DB. */
const CACHE_TTL_MS = 60_000;
let _cache = null;
let _cacheAt = 0;

/**
 * @typedef {Object} ScraperProperty
 * @property {string} propertyId    UUID of the property
 * @property {string} caUsername    Choice Advantage login username
 * @property {string} caPassword    Choice Advantage login password
 * @property {string} caLoginUrl    Choice Advantage login URL
 * @property {string} pmsType       'choice_advantage' (other PMS types are future work)
 * @property {string} scraperInstance  Tag matching SCRAPER_INSTANCE_ID env
 * @property {boolean} isActive
 * @property {boolean} fromFallback Whether this row came from env-var fallback
 */

/**
 * Return the set of properties this scraper instance should poll. Reads
 * from `scraper_credentials` filtered by:
 *   - is_active = true
 *   - scraper_instance = SCRAPER_INSTANCE_ID env (or 'default')
 *
 * If the table is empty AND fallback env vars are present, returns a
 * single synthetic property so the legacy single-property scraper
 * behavior continues to work during the migration.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ noCache?: boolean }} [opts]
 * @returns {Promise<ScraperProperty[]>}
 */
async function loadActiveProperties(supabase, opts = {}) {
  const now = Date.now();
  if (!opts.noCache && _cache && now - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const instanceId = process.env.SCRAPER_INSTANCE_ID || ENV_FALLBACK_INSTANCE_ID;

  const { data, error } = await supabase
    .from('scraper_credentials')
    .select('property_id, pms_type, ca_login_url, ca_username, ca_password, is_active, scraper_instance')
    .eq('is_active', true)
    .eq('scraper_instance', instanceId);

  if (error) {
    console.error(
      `[${new Date().toISOString()}] [properties-loader] scraper_credentials query failed: ${error.message}. Falling back to env vars.`,
    );
    const fb = fromEnv();
    if (fb) {
      _cache = [fb];
      _cacheAt = now;
      return _cache;
    }
    // No fallback either — return empty, scraper tick will skip.
    _cache = [];
    _cacheAt = now;
    return _cache;
  }

  let rows = (data || []).map(r => ({
    propertyId: String(r.property_id),
    caUsername: String(r.ca_username),
    caPassword: String(r.ca_password),
    caLoginUrl: String(r.ca_login_url),
    pmsType: String(r.pms_type),
    scraperInstance: String(r.scraper_instance),
    isActive: Boolean(r.is_active),
    fromFallback: false,
  }));

  // Empty table → use env-var fallback so this scraffolding never breaks
  // a fresh deploy that hasn't been migrated yet.
  if (rows.length === 0) {
    const fb = fromEnv();
    if (fb) {
      rows = [fb];
      console.log(
        `[${new Date().toISOString()}] [properties-loader] scraper_credentials empty for instance ${instanceId}; using env-var fallback for property ${fb.propertyId}.`,
      );
    } else {
      console.warn(
        `[${new Date().toISOString()}] [properties-loader] No active properties for instance ${instanceId} and no env fallback. Scraper will idle.`,
      );
    }
  }

  _cache = rows;
  _cacheAt = now;
  return rows;
}

/** Synthesize a single ScraperProperty from process.env. Returns null if env is incomplete. */
function fromEnv() {
  const propertyId = process.env.HOTELOPS_PROPERTY_ID;
  const caUsername = process.env.CA_USERNAME;
  const caPassword = process.env.CA_PASSWORD;
  if (!propertyId || !caUsername || !caPassword) return null;
  return {
    propertyId,
    caUsername,
    caPassword,
    caLoginUrl: 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
    pmsType: 'choice_advantage',
    scraperInstance: process.env.SCRAPER_INSTANCE_ID || ENV_FALLBACK_INSTANCE_ID,
    isActive: true,
    fromFallback: true,
  };
}

/** Bust the cache (e.g. after a credential rotation). Test helper. */
function _resetCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { loadActiveProperties, _resetCache };
