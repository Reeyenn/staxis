import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

test('laundry completion writes are checked, serialized, durable, and retryable', () => {
  const page = source('src', 'app', 'laundry', '[id]', 'page.tsx');
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
  const signup = source('src', 'app', 'signup', 'page.tsx');
  const verify = source('src', 'app', 'signin', 'verify', 'page.tsx');
  const forgot = source('src', 'app', 'signin', 'forgot', 'page.tsx');

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
  const housekeeping = source('src', 'app', 'housekeeping', 'page.tsx');

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
  const contacts = source('src', 'app', 'communications', '_components', 'ContactsPane.tsx');
  const knowledge = source('src', 'app', 'communications', '_components', 'KnowledgePane.tsx');
  const logbook = source('src', 'app', 'communications', '_components', 'LogbookPane.tsx');
  const snow = source('src', 'app', 'communications', '_components', 'comms-snow.tsx');

  assert.match(app, /comms-mobile-detail/);
  assert.match(app, /min-width:44px;min-height:44px/);
  assert.match(app, /<CommsPropertyApp key=\{activePropertyId \?\? 'no-property'\}/);
  assert.match(app, /<ThreadPanel key=\{`\$\{selConvo\.id\}:\$\{threadParent\.id\}`\}/);
  assert.match(app, /data: boot, loading: bootLoading, error: bootError/);
  assert.match(app, /messagesError=\{messagesError\}/);
  assert.match(app, /if \(!r\.ok\)[\s\S]*?Could not update the acknowledgement/);
  assert.match(pane, /Messages could not load/);
  assert.match(pane, /minWidth: 44, minHeight: 44/);
  assert.match(composer, /if \(!sent\.ok\)[\s\S]*?Message could not be sent/);
  assert.match(composer, /role="alert"/);
  assert.match(overlays, /The worklist could not load/);
  assert.match(overlays, /if \(!r\.ok\)[\s\S]*?The item was not completed/);
  assert.match(overlays, /Staxis could not summarize this activity/);
  assert.doesNotMatch(overlays, /r\.data\?\.summary \?\? L\('You are all caught up'/);
  assert.match(row, /if \(!r\.ok\)[\s\S]*?Acknowledgement was not saved/);
  for (const pane of [calendar, contacts, knowledge, logbook]) {
    assert.match(pane, /error: loadError/);
  }
  assert.match(knowledge, /if \(!docsR\.ok \|\| !docsR\.data\) return \{ error:/);
  assert.match(knowledge, /if \(!foldersR\.ok \|\| !foldersR\.data\) return \{ error:/);
  assert.doesNotMatch(knowledge, /documents: docsR\.ok && docsR\.data \? docsR\.data\.documents : \[\]/);
  assert.match(logbook, /if \(!r\.ok\).*The recap was not posted/);
  assert.match(snow, /export const iconBtn:[\s\S]*?width: 44, height: 44/);
});

test('zero occupied rooms remains a real occupancy reading', () => {
  const dashboard = source('src', 'app', 'dashboard', 'page.tsx');
  assert.match(dashboard, /if \(counts && counts\.total_rooms > 0\)/);
  assert.doesNotMatch(dashboard, /if \(counts && \(counts\.stayovers \+ counts\.checkouts\) > 0\)/);
});

test('static legal pages render inside the root document without nested document tags', () => {
  for (const pageName of ['consent', 'privacy', 'terms']) {
    const page = source('src', 'app', pageName, 'page.tsx');
    assert.match(page, /export const metadata: Metadata/);
    assert.doesNotMatch(page, /<html\b/i);
    assert.doesNotMatch(page, /<head\b/i);
    assert.doesNotMatch(page, /<body\b/i);
  }
});

test('financial and settings reads wait for a matching authorized property context', () => {
  const financials = source('src', 'app', 'financials', 'page.tsx');
  const notifications = source('src', 'app', 'settings', 'notifications', 'page.tsx');
  const users = source('src', 'app', 'settings', 'users', 'page.tsx');

  assert.match(financials, /const allowed = accessContextReady && financialsEnabled/);
  assert.match(financials, /enabled: !!activePropertyId && allowed/);
  for (const page of [notifications, users]) {
    assert.match(page, /capabilityOverridesViewerKey === capabilityViewerKey/);
    assert.match(page, /const propertyId = activePropertyId \?\? ''/);
    assert.match(page, /onChange=\{e => setActivePropertyId\(e\.target\.value\)\}/);
    assert.match(page, /requestId !== loadRequestRef\.current \|\| activeScopeRef\.current !== requestedPropertyId/);
    assert.match(page, /if \(!requestedPropertyId \|\| !allowed/);
  }
});

test('the unwired Staxis queue is explicit and never claims all-clear', () => {
  const queue = source('src', 'components', 'concourse', 'QueueView.tsx');
  assert.match(queue, /Approvals unavailable/);
  assert.match(queue, /Do not use this screen as an all-clear/);
  assert.doesNotMatch(queue, /All caught up/);
  assert.doesNotMatch(queue, /broadcastQueueCount\(0\)/);
});
