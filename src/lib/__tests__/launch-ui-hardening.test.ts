import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

test('laundry completion writes are checked, serialized, durable, and retryable', () => {
  const page = source('src', 'app', '(staff-link)', 'laundry', '[id]', 'page.tsx');
  assert.match(page, /const queuedSaveRef = useRef<CompletionSnapshot \| null>\(null\)/);
  assert.match(page, /if \(saveInFlightRef\.current \|\| !queuedSaveRef\.current\) return/);
  assert.match(page, /date: snapshot\.date/);
  assert.match(page, /keepalive: true/);
  assert.match(page, /if \(!res\.ok \|\| !body\?\.ok\)/);
  assert.match(page, /if \(!queuedSaveRef\.current\) queuedSaveRef\.current = snapshot/);
  assert.match(page, /onClick=\{\(\) => void drainCompletionSaves\(\)\}/);
  assert.doesNotMatch(page, /saveTimerRef/);
});

test('OTP and reset delivery failures cannot masquerade as successful sends', () => {
  const signup = source('src', 'app', '(public)', 'signup', 'page.tsx');
  const verify = source('src', 'app', '(public)', 'signin', 'verify', 'page.tsx');
  const forgot = source('src', 'app', '(public)', 'signin', 'forgot', 'page.tsx');

  assert.match(signup, /const \{ error: otpErr \} = await supabase\.auth\.signInWithOtp/);
  assert.match(signup, /otpDeliveryFailed \? '&delivery=failed' : ''/);
  assert.match(verify, /const resendCode = async \(\) =>/);
  assert.match(verify, /if \(otpErr\) throw otpErr/);
  assert.match(verify, /Resend code/);
  assert.match(forgot, /const \{ error: resetErr \} = await supabase\.auth\.resetPasswordForEmail/);
  assert.match(forgot, /if \(resetErr\) throw resetErr/);
  assert.match(forgot, /if \(resetErr\) throw resetErr;[\s\S]*?setSent\(true\)/);
});

test('mobile operations layouts retain usable responsive fallbacks', () => {
  const maintenance = source('src', 'app', 'maintenance', '_components', 'WorkOrdersTab.tsx');
  const housekeeping = source('src', 'app', '(hotel)', 'housekeeping', 'page.tsx');

  assert.match(maintenance, /@media \(max-width: 560px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(housekeeping, /overflow-x: auto/);
  assert.match(housekeeping, /minHeight: 44/);
  assert.match(housekeeping, /try \{ return window\.localStorage\.getItem\('hk-tab'\); \} catch \{ return null; \}/);
  assert.match(housekeeping, /try \{ window\.localStorage\.setItem\('hk-tab', tab\); \} catch/);
});

test('communications has a phone list/detail flow and does not collapse failures into empty data', () => {
  const app = source('src', 'app', 'communications', '_components', 'CommsApp.tsx');
  const pane = source('src', 'app', 'communications', '_components', 'MessagePane.tsx');
  const composer = source('src', 'app', 'communications', '_components', 'Composer.tsx');
  const overlays = source('src', 'app', 'communications', '_components', 'CommsOverlays.tsx');
  const row = source('src', 'app', 'communications', '_components', 'MessageRow.tsx');
  const calendar = source('src', 'app', 'communications', '_components', 'CalendarPane.tsx');
  // Contacts and the knowledge hub moved to the Knows tab's "told" half, and
  // on 2026-08-05 that half's four panes collapsed into ONE list of sentences
  // served by /api/memory/knows. So the guard follows the surviving code
  // again: the same claim ("a failed read is never drawn as no data") now has
  // to hold on the page that replaced all four.
  const knows = source('src', 'components', 'concourse', 'KnowsView.tsx');
  const logbook = source('src', 'app', 'communications', '_components', 'LogbookPane.tsx');
  // The worklist left Communications for the Staxis list on 2026-07-30, the
  // same way Contacts and the knowledge hub left before it. These lines follow
  // the SURVIVING code so the protection stays attached to what actually runs.
  const staxisList = source('src', 'components', 'concourse', 'StaxisList.tsx');
  const listRows = source('src', 'components', 'concourse', 'list-rows.tsx');

  assert.match(app, /comms-mobile-detail/);
  assert.match(app, /min-width:44px;min-height:44px/);
  assert.match(app, /<CommsPropertyApp key=\{activePropertyId \?\? 'no-property'\}/);
  assert.match(app, /<ThreadPanel key=\{`\$\{selConvo\.id\}:\$\{threadParent\.id\}`\}/);
  assert.match(app, /data: boot, loading: bootLoading, error: bootError/);
  // The worklist read now belongs to the screen it IS, so it is no longer
  // lazy — it is the page's main content. What still has to hold is that a
  // failed refresh keeps the last-good rows instead of blanking the list.
  assert.match(staxisList, /`\/api\/worklist\?pid=\$\{propertyId\}`[\s\S]*?keepDataOnError: true/);
  assert.doesNotMatch(app, /\/api\/worklist/);
  assert.match(app, /messagesError=\{messagesError\}/);
  assert.match(app, /if \(!r\.ok\)[\s\S]*?Could not update the acknowledgement/);
  assert.match(pane, /Messages could not load/);
  assert.match(pane, /minWidth: 44, minHeight: 44/);
  assert.match(composer, /if \(!sent\.ok\)[\s\S]*?Message could not be sent/);
  assert.match(composer, /role="alert"/);
  // A write that did not land must never look like one that did: the row stays
  // on the list and says so. Restated against the envelope shape the concourse
  // surface uses (envelope.error, not result.ok).
  assert.match(staxisList, /if \(envelope\.error !== undefined\)[\s\S]*?That did not save\. Nothing changed/);
  // A failed read of what you handed out is never drawn as "nothing outstanding".
  assert.match(listRows, /readFailed[\s\S]*?could not read this just now/);
  assert.match(row, /if \(!r\.ok\)[\s\S]*?Acknowledgement was not saved/);
  for (const pane of [calendar, logbook]) {
    assert.match(pane, /error: loadError/);
  }
  // The Knows page keeps the last-good list through a failed refresh, and says
  // so out loud rather than rendering the empty state, which would read as
  // "your hotel has told Staxis nothing".
  assert.match(knows, /keepDataOnError: true/);
  assert.match(knows, /\{error && !data && <div className="kn-note kn-bad">\{KNOWS_COPY\.loadFailed\}<\/div>\}/);
  assert.match(knows, /groups\.length === 0 &&/);
  assert.match(logbook, /if \(!r\.ok\).*The recap was not posted/);

  // The Communications originals are still mounted by CommsApp until the
  // clean-out lands, so they keep their guards until the day they disappear.
  // Existence-checked rather than path-listed: the whole point of the repoint
  // above is that deleting them needs no edit here.
  for (const legacy of ['ContactsPane.tsx', 'KnowledgePane.tsx']) {
    const path = join(process.cwd(), 'src', 'app', 'communications', '_components', legacy);
    if (!existsSync(path)) continue;
    assert.match(readFileSync(path, 'utf8'), /error: loadError/, legacy);
  }
});

test('zero occupied rooms remains a real occupancy reading', async () => {
  // Behavior, not source text: the derivation moved out of page.tsx into
  // occupancyPctFromCounts / buildHistory, which is where the guarantee lives.
  const { occupancyPctFromCounts } = await import('@/app/dashboard/_components/counts-hold');
  const { buildHistory } = await import('@/lib/dashboard/today-series');

  // An empty-but-reporting hotel reads 0%, not "waiting" and not an invented figure.
  const emptyHotel = {
    checkouts: 0, stayovers: 0, vacant_clean: 40, vacant_dirty: 0,
    ooo: 0, total_rooms: 40, total_checkouts_today: 0, in_house: 0,
  };
  assert.equal(occupancyPctFromCounts(emptyHotel, 40), 0);

  // And the chart's today row is pinned to that real zero rather than keeping
  // its generated 46-98% occupancy.
  const rows = buildHistory(40, 0);
  assert.equal(rows[rows.length - 1].occ, 0);

  // The page must derive its headline through that shared helper, so the ring,
  // the Home tile, and the sealed history cannot drift apart again.
  const dashboard = source('src', 'app', '(hotel)', 'dashboard', 'page.tsx');
  assert.match(dashboard, /occupancyPctFromCounts\(counts, totalRooms\)/);
  assert.doesNotMatch(dashboard, /counts\.stayovers \+ counts\.checkouts/);
});

test('static legal pages render inside the root document without nested document tags', () => {
  for (const pageName of ['consent', 'privacy', 'terms']) {
    const page = source('src', 'app', '(public)', pageName, 'page.tsx');
    assert.match(page, /export const metadata: Metadata/);
    assert.doesNotMatch(page, /<html\b/i);
    assert.doesNotMatch(page, /<head\b/i);
    assert.doesNotMatch(page, /<body\b/i);
  }
});

test('financial and notification reads wait for matching authority while retired user bookmarks redirect', () => {
  const financials = source('src', 'app', '(hotel)', 'financials', 'page.tsx');
  const notifications = source(
    'src',
    'app',
    'settings',
    'notifications',
    '_components',
    'NotificationsPanel.tsx',
  );
  const users = source('src', 'app', '(hotel)', 'settings', 'users', 'page.tsx');

  assert.match(financials, /const authorizationContextReady = user\?\.role === 'admin' \|\| authorizationChecked/);
  assert.match(financials, /const allowed = accessContextReady[\s\S]*&& authorizationContextReady[\s\S]*&& financialsEnabled/);
  assert.match(financials, /activePropertyStanding\.seesFinancials/);
  assert.match(financials, /enabled: !!activePropertyId && allowed/);
  assert.match(notifications, /capabilityOverridesViewerKey === capabilityViewerKey/);
  assert.match(notifications, /const propertyId = activePropertyId \?\? ''/);
  assert.match(notifications, /onChange=\{e => setActivePropertyId\(e\.target\.value\)\}/);
  assert.match(notifications, /requestId !== loadRequestRef\.current \|\| activeScopeRef\.current !== requestedPropertyId/);
  assert.match(notifications, /if \(!requestedPropertyId \|\| !allowed/);

  // User management has no second property-scoped client anymore. Old
  // bookmarks resolve server-side to the single Company Access workspace.
  assert.match(users, /redirect\('\/company\?tab=access'\)/);
  assert.doesNotMatch(users, /fetchWithAuth|useEffect|useProperty/);
});

/**
 * The Staxis queue never claims all-clear — AND never claims it is unwired.
 *
 * This test used to REQUIRE the two pilot-era sentences ("Live approvals are not
 * connected for this pilot yet", "Approvals unavailable — do not use this screen
 * as an all-clear"). Both were true when they were written and both were false
 * by the time a manager read them: the cards are live findings and the ones
 * Staxis can fix carry a real approve button. Worse, the second one rendered
 * while the read was still in flight, so every load flashed "Approvals
 * unavailable" over a queue that was about to appear.
 *
 * A test that pins false copy in place is worse than no test, so it now guards
 * the invariant that actually matters in BOTH directions: no claim that
 * everything is fine, and no claim that nothing is connected.
 */
test('the Staxis queue claims neither all-clear nor "not connected"', () => {
  const queue = source('src', 'components', 'concourse', 'QueueView.tsx');
  // Never an all-clear. This is the older and more important half.
  assert.doesNotMatch(queue, /All caught up/);
  assert.doesNotMatch(queue, /all[- ]clear/i);
  assert.doesNotMatch(queue, /broadcastQueueCount\(0\)/);
  // Never the stale pilot claim, in either language.
  assert.doesNotMatch(queue, /not connected for this pilot/i);
  assert.doesNotMatch(queue, /todavía no están conectadas/i);
  assert.doesNotMatch(queue, /Approvals unavailable/);
  // A neutral wait, shown only while the read is genuinely in flight.
  assert.match(queue, /readState === 'loading'/);
  assert.match(queue, /One moment…/);
});
