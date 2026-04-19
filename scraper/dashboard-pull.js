/**
 * HotelOps AI — Dashboard Number Pull
 *
 * Pulls three operational numbers from Choice Advantage's View pages and
 * writes them to scraperStatus/dashboard for display on the Schedule tab:
 *   • View → In House    → Room Count (currently occupied rooms)
 *   • View → Arrivals    → Room Count (arrivals still pending check-in)
 *   • View → Departures  → Room Count (departures still pending check-out)
 *
 * Called from scraper.js every 15 minutes between 5am and 11pm local time.
 *
 * Note on selectors: the three View pages use inconsistent element IDs
 * (#roomCount on Arrivals/Departures, #roomCountValue on In House). The
 * surrounding HTML structure IS consistent though:
 *
 *   <ul class="CHI_Row_Left">
 *     <li><label>Guest Count:</label></li>
 *     <li><p class="CHI_Data">N</p></li>
 *     <li><label>Room Count:</label></li>
 *     <li><p class="CHI_Data">N</p></li>
 *   </ul>
 *
 * So we target by label text and then walk to the next <li>'s .CHI_Data —
 * robust across all three pages.
 */

const VIEW_PAGES = [
  { key: 'inHouse',    url: 'https://www.choiceadvantage.com/choicehotels/ViewInHouseList.init' },
  { key: 'arrivals',   url: 'https://www.choiceadvantage.com/choicehotels/ViewArrivalsList.init' },
  { key: 'departures', url: 'https://www.choiceadvantage.com/choicehotels/ViewDeparturesList.init' },
];

async function readCounts(page) {
  return await page.evaluate(() => {
    const getCount = (labelText) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const lbl = labels.find(l => l.textContent.trim() === labelText);
      if (!lbl) return null;
      const cell = lbl.closest('li');
      const next = cell ? cell.nextElementSibling : null;
      const data = next ? next.querySelector('.CHI_Data') : null;
      if (!data) return null;
      const n = parseInt(data.textContent.trim(), 10);
      return Number.isNaN(n) ? null : n;
    };
    return {
      guestCount: getCount('Guest Count:'),
      roomCount:  getCount('Room Count:'),
    };
  });
}

/**
 * Navigate the three View pages in sequence and write the numbers to
 * scraperStatus/dashboard. Throws if CA bounced us to the login page —
 * caller handles re-login.
 */
async function pullDashboardNumbers(page, db, log) {
  const result = {};

  for (const { key, url } of VIEW_PAGES) {
    log(`Dashboard pull — ${key}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const cur = page.url();
    if (cur.includes('Login') || cur.includes('j_security_check')) {
      throw new Error(`Session expired (redirected to ${cur})`);
    }

    // CA silently redirects expired sessions to a login-ish page whose URL
    // doesn't include "Login" (usually Welcome.init). Detect via the DOM:
    // the login form has j_username / j_password fields. If we see that,
    // treat it as session-expired so the caller can re-login and retry.
    const onLoginPage = await page.evaluate(() => {
      return !!document.querySelector('input[name="j_username"], input[name="j_password"]');
    });
    if (onLoginPage) {
      throw new Error(`Session expired (login form present at ${cur})`);
    }

    // Wait specifically for the "Room Count:" label with a numeric
    // sibling. A generic `ul.CHI_Row_Left label` wait is unreliable
    // because CA uses CHI_Row_Left in multiple places on the page, and
    // interstitial / redirect pages also include CHI_Row_Left markup.
    try {
      await page.waitForFunction(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const rc = labels.find(l => l.textContent.trim() === 'Room Count:');
        if (!rc) return false;
        const li = rc.closest('li');
        const next = li ? li.nextElementSibling : null;
        const data = next ? next.querySelector('.CHI_Data') : null;
        return !!(data && /^\d+$/.test(data.textContent.trim()));
      }, { timeout: 15000 });
    } catch (waitErr) {
      // Log useful diagnostics so we can see what page we actually landed on
      const diag = await page.evaluate(() => ({
        title: document.title,
        h1: (document.querySelector('h1')?.textContent || '').trim(),
        firstLabels: Array.from(document.querySelectorAll('label')).slice(0, 10).map(l => l.textContent.trim()),
        hasLoginForm: !!document.querySelector('input[name="j_username"], input[name="j_password"]'),
      })).catch(() => ({}));
      log(`Dashboard pull ${key} — wait for Room Count failed. URL=${page.url()} title=${diag.title} h1=${diag.h1} login=${diag.hasLoginForm} labels=${JSON.stringify(diag.firstLabels)}`);
      if (diag.hasLoginForm) {
        throw new Error(`Session expired (login form present at ${page.url()})`);
      }
      throw waitErr;
    }

    const { roomCount, guestCount } = await readCounts(page);
    result[key] = { roomCount, guestCount };
    log(`Dashboard pull ${key} — roomCount=${roomCount} guestCount=${guestCount}`);
  }

  const payload = {
    inHouse:    result.inHouse?.roomCount    ?? null,
    arrivals:   result.arrivals?.roomCount   ?? null,
    departures: result.departures?.roomCount ?? null,
    // Guest counts preserved in case the app ever wants "N guests" vs "N rooms"
    inHouseGuests:    result.inHouse?.guestCount    ?? null,
    arrivalsGuests:   result.arrivals?.guestCount   ?? null,
    departuresGuests: result.departures?.guestCount ?? null,
    pulledAt: new Date(),
    error:    null,
  };

  await db.collection('scraperStatus').doc('dashboard').set(payload, { merge: true });

  log(`Dashboard pull OK — inHouse=${payload.inHouse} arrivals=${payload.arrivals} departures=${payload.departures}`);
  return payload;
}

module.exports = { pullDashboardNumbers };
