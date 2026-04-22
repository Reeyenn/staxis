/**
 * HotelOps AI — Out-of-Order (OOO) Work Order Sync
 *
 * Pulls CA's "All Room Work Orders" list and mirrors each OOO room into our
 * own work_orders table so Maria sees on-the-ground blockers (AC busted,
 * deep-cleaning, maintenance hold) in the same feed as housekeeper-submitted
 * tickets.
 *
 * ─── Why we do this ─────────────────────────────────────────────────────────
 *
 * From the Maria transcript (Apr 2026): the biggest real-world disconnect is
 * rooms that are "blocked" in CA by the front desk for maintenance or deep
 * cleans, but housekeeping has no idea until they show up with a cart. We
 * already show live PMS occupancy — we should also show the front-desk
 * block list so it's one unified "here's every room that's not ready" view.
 *
 * ─── Endpoint ───────────────────────────────────────────────────────────────
 *
 * Discovered by inspecting the live CA page's AJAX call:
 *   POST https://www.choiceadvantage.com/choicehotels/WorkOrders.jx
 *   body: workOrderType=ROOM
 *   response: { "workOrders": [ { roomNumber, reason, fromDate, toDate,
 *     workOrderNumber, workOrderCode, roomOutOfOrder, notes, floor,
 *     openingClerk, openingDate, assignedTo, ... } ] }
 *
 * `workOrderNumber` is a stable numeric ID per work order — we use it as our
 * dedup key (`ca_work_order_number`). The page only shows work orders where
 * `roomOutOfOrder === true`, which matches exactly what we want to sync.
 *
 * ─── Reconciliation contract ────────────────────────────────────────────────
 *
 *   1. NEW work order in CA response → insert a work_orders row with
 *      source='ca_ooo', severity='medium', description='[CA] <reason>',
 *      blocked_room=true. Store ca_work_order_number + ca_from_date/ca_to_date.
 *
 *   2. EXISTING (by ca_work_order_number) + still in CA → update in place
 *      (dates can shift if the desk extends the block; reason usually doesn't).
 *
 *   3. EXISTING (by ca_work_order_number) + NOT in CA response → mark status
 *      'resolved' with resolved_at=now(). Means the front desk closed the
 *      work order in CA, so the room is rentable again. Housekeeper and
 *      manual tickets (source !== 'ca_ooo') are never touched by this
 *      reconciler.
 *
 *   4. CA fetch failure → we do NOTHING to existing rows. Silence is safer
 *      than mass-resolving everything on a flaky network tick.
 *
 * Runs alongside dashboard-pull on the 15-min cadence. Wrapped in its own
 * try/catch in scraper.js so a CA OOO outage never kills the dashboard pull.
 */

const { ScraperError, ERROR_CODES } = require('./dashboard-pull');
const { mergeStatus } = require('./supabase-helpers');

const WORK_ORDERS_URL = 'https://www.choiceadvantage.com/choicehotels/WorkOrders.jx';

/**
 * Call WorkOrders.jx from within the authenticated Playwright page so the
 * JSESSIONID cookie tags along. Returns the parsed `workOrders` array, or
 * throws a typed ScraperError.
 */
async function fetchOOOWorkOrders(page, log) {
  let body;
  try {
    body = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'workOrderType=ROOM',
      });
      const text = await r.text();
      return { status: r.status, text, loc: location.href };
    }, WORK_ORDERS_URL);
  } catch (err) {
    throw new ScraperError(
      ERROR_CODES.CA_UNREACHABLE,
      `OOO fetch threw: ${err.message}`,
      { page: 'ooo' }
    );
  }

  // If CA bounced us to login the fetch usually returns HTML, not JSON.
  if (body.status !== 200) {
    throw new ScraperError(
      ERROR_CODES.CA_UNREACHABLE,
      `OOO fetch status ${body.status}`,
      { page: 'ooo', diagnostics: { url: body.loc, statusCode: body.status } }
    );
  }

  // Session-expired shape: HTML with login form text in it. Bail loud.
  if (body.text.includes('j_username') || body.text.includes('j_password')) {
    throw new ScraperError(
      ERROR_CODES.SESSION_EXPIRED,
      `OOO fetch returned login form (session expired)`,
      { page: 'ooo', diagnostics: { url: body.loc } }
    );
  }

  let json;
  try {
    json = JSON.parse(body.text);
  } catch (err) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      `OOO fetch non-JSON response: ${err.message}`,
      { page: 'ooo', diagnostics: { url: body.loc, preview: body.text.slice(0, 200) } }
    );
  }

  if (!json || !Array.isArray(json.workOrders)) {
    throw new ScraperError(
      ERROR_CODES.SELECTOR_MISS,
      `OOO response missing workOrders array`,
      { page: 'ooo', diagnostics: { keys: json ? Object.keys(json) : [] } }
    );
  }

  // The endpoint returns all room work orders; we only mirror the ones
  // actually blocking a room. CA's own "All Room Work Orders" page filters
  // the same way (it's the list with the red X icons).
  const ooo = json.workOrders.filter(w => w && w.roomOutOfOrder === true);
  log(`OOO pull — ${ooo.length}/${json.workOrders.length} work orders are OOO`);
  return ooo;
}

/**
 * Reconcile CA's current OOO list against our existing ca_ooo work orders.
 *
 *   - Insert rows for new work orders (keyed by ca_work_order_number).
 *   - Update dates/reason on existing open rows.
 *   - Auto-resolve open rows that dropped off CA's list.
 *   - Never touch rows with source !== 'ca_ooo'.
 */
async function reconcileOOO(supabase, config, ooo, log) {
  // 1) Load all ca_ooo rows for this property. The list is tiny (typically
  //    <10), so we pull them all and filter in memory to avoid a second
  //    round-trip. Only OPEN statuses are candidates for auto-resolve.
  const OPEN_STATUSES = new Set(['submitted', 'assigned', 'in_progress']);

  const { data: existing, error: fetchErr } = await supabase
    .from('work_orders')
    .select('id, status, ca_work_order_number')
    .eq('property_id', config.PROPERTY_ID)
    .eq('source', 'ca_ooo');
  if (fetchErr) throw fetchErr;

  const openByCaNumber = new Map();
  for (const row of (existing ?? [])) {
    if (!row.ca_work_order_number) continue;
    if (!OPEN_STATUSES.has(row.status)) continue;
    openByCaNumber.set(String(row.ca_work_order_number), { id: row.id });
  }

  // 2) Walk the CA list, upsert each one.
  const caKeys = new Set();
  let created = 0, updated = 0;

  for (const w of ooo) {
    const caKey = String(w.workOrderNumber || '');
    if (!caKey) continue; // no stable ID = can't dedup safely, skip
    caKeys.add(caKey);

    const payload = {
      property_id:          config.PROPERTY_ID,
      room_number:          String(w.roomNumber || w.item || ''),
      description:          `[CA] ${w.reason || 'Out of Order'}`.slice(0, 300),
      severity:             'medium',
      source:               'ca_ooo',
      blocked_room:         true,
      ca_work_order_number: caKey,
      ca_from_date:         w.fromDate || null,
      ca_to_date:           w.toDate || null,
      notes:                (w.notes || '').slice(0, 500),
      submitted_by_name:    w.openingClerk || 'Choice Advantage',
    };

    const open = openByCaNumber.get(caKey);
    if (open) {
      // Update in place — don't bump created_at, don't touch severity if the
      // manager upgraded it manually. Actually we overwrite severity back to
      // medium on purpose: the source of truth for CA-driven tickets is CA.
      // If Maria wants to flag a CA work order as urgent, she'd do it on the
      // CA side (or we can build a "pin" flag later). updated_at is handled
      // by the Postgres trigger.
      const { error: updErr } = await supabase
        .from('work_orders')
        .update(payload)
        .eq('id', open.id);
      if (updErr) throw updErr;
      updated++;
    } else {
      // New row — set status submitted; created_at default fires.
      const { error: insErr } = await supabase
        .from('work_orders')
        .insert({ ...payload, status: 'submitted' });
      if (insErr) throw insErr;
      created++;
    }
  }

  // 3) Anything that WAS open and is no longer in the CA list → resolved.
  let resolved = 0;
  const nowIso = new Date().toISOString();
  for (const [caKey, { id }] of openByCaNumber.entries()) {
    if (caKeys.has(caKey)) continue;
    const { error: resErr } = await supabase
      .from('work_orders')
      .update({ status: 'resolved', resolved_at: nowIso })
      .eq('id', id);
    if (resErr) throw resErr;
    resolved++;
  }

  log(`OOO reconcile — created=${created} updated=${updated} auto-resolved=${resolved}`);
  return { created, updated, resolved, total: ooo.length };
}

/**
 * Top-level entry point called from scraper.js. Writes a status row to
 * scraper_status[key='ooo'] alongside 'dashboard' so the UI / health check
 * can tell whether the OOO mirror is fresh.
 */
async function pullOOOWorkOrders(page, supabase, config, log) {
  let ooo;
  try {
    ooo = await fetchOOOWorkOrders(page, log);
  } catch (err) {
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
    log(`OOO pull FAILED [${code}] ${err.message}`);

    await mergeStatus(supabase, 'ooo', {
      errorCode:    code,
      errorMessage: String(err.message || '').slice(0, 500),
      erroredAt:    new Date().toISOString(),
    }).catch(writeErr => {
      log(`Failed to write OOO error state: ${writeErr.message}`);
    });

    throw err; // let caller decide on re-login/retry
  }

  let stats;
  try {
    stats = await reconcileOOO(supabase, config, ooo, log);
  } catch (err) {
    // Reconcile errors usually mean Supabase is sad — log + write state but
    // don't re-throw as SESSION_EXPIRED so the caller doesn't try to re-login.
    log(`OOO reconcile FAILED: ${err.message}`);
    await mergeStatus(supabase, 'ooo', {
      errorCode:    ERROR_CODES.UNKNOWN,
      errorMessage: `Reconcile failed: ${err.message}`.slice(0, 500),
      erroredAt:    new Date().toISOString(),
    }).catch(() => {});
    throw err;
  }

  // Success → clear error fields, write fresh snapshot + counters.
  await mergeStatus(supabase, 'ooo', {
    pulledAt:         new Date().toISOString(),
    oooCount:         stats.total,
    createdThisTick:  stats.created,
    updatedThisTick:  stats.updated,
    resolvedThisTick: stats.resolved,
    errorCode:        null,
    errorMessage:     null,
    erroredAt:        null,
  });

  return stats;
}

module.exports = { pullOOOWorkOrders };
