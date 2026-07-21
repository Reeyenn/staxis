import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { attachmentBelongsToConversation, parseCommsAttachmentPath } from '@/lib/comms/attachments';
import { commsStaffIdentityId } from '@/lib/comms/identity';
import { isConfirmedAuthUserNotFound } from '@/lib/auth-account-delete';
import { isExplicitLocalDevelopment } from '@/lib/local-sync-auth';
import { isSectionEnabled } from '@/lib/sections/registry';
import { parseStoredEnabledSections, SectionLookupError } from '@/lib/sections/server';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const routeFilesBelow = (dir: string): string[] => {
  const absolute = join(process.cwd(), dir);
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'route.ts') out.push(path);
    }
  };
  walk(absolute);
  return out;
};

const PROPERTY_A = '11111111-1111-1111-1111-111111111111';
const PROPERTY_B = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONVERSATION_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONVERSATION_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OBJECT_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('Communications caller identity', () => {
  test('same-name accounts receive different caller-bound identities', () => {
    const firstSameNameAccount = commsStaffIdentityId(PROPERTY_A, ACCOUNT_A);
    const secondSameNameAccount = commsStaffIdentityId(PROPERTY_A, ACCOUNT_B);
    assert.notEqual(firstSameNameAccount, secondSameNameAccount);
  });

  test('renaming an account cannot change its identity', () => {
    const beforeRename = commsStaffIdentityId(PROPERTY_A, ACCOUNT_A);
    // Display name is deliberately not an input to identity derivation.
    const afterRename = commsStaffIdentityId(PROPERTY_A, ACCOUNT_A);
    assert.equal(afterRename, beforeRename);
  });

  test('one account receives a distinct identity in each property', () => {
    assert.notEqual(
      commsStaffIdentityId(PROPERTY_A, ACCOUNT_A),
      commsStaffIdentityId(PROPERTY_B, ACCOUNT_A),
    );
  });

  test('resolver checks normalized link, then exact auth id, and never queries by name', () => {
    const core = source('src/lib/comms/core.ts');
    const start = core.indexOf('export async function resolveStaffIdForAccount');
    const end = core.indexOf('// ── Conversation ensure/lookup', start);
    const resolver = core.slice(start, end);
    const normalizedLink = resolver.indexOf(".from('account_property_staff_links')");
    const exactAuth = resolver.indexOf(".eq('auth_user_id', account.authUserId)");
    const legacyPointer = resolver.indexOf('if (account.staffId)', exactAuth);
    const atomicLegacyClaim = resolver.indexOf(".is('auth_user_id', null)", legacyPointer);
    const create = resolver.indexOf('.insert({');
    assert.ok(
      normalizedLink >= 0
      && exactAuth > normalizedLink
      && legacyPointer > exactAuth
      && atomicLegacyClaim > legacyPointer
      && create > atomicLegacyClaim,
    );
    assert.doesNotMatch(resolver, /ilike\(|displayName\)[\s\S]*maybeSingle/);
    assert.match(resolver, /update\(\{ auth_user_id: account\.authUserId \}\)[\s\S]*\.is\(['"]auth_user_id['"], null\)/);
    assert.match(resolver, /id: deterministicId[\s\S]*auth_user_id: account\.authUserId/);
  });

  test('uses durable auth-user linkage without attempting an unauthorized normalized-table write', () => {
    const core = source('src/lib/comms/core.ts');
    const start = core.indexOf('export async function resolveStaffIdForAccount');
    const end = core.indexOf('// ── Conversation ensure/lookup', start);
    const resolver = core.slice(start, end);
    const normalizedTableCalls = resolver.match(/\.from\(['"]account_property_staff_links['"]\)/g) ?? [];
    assert.equal(normalizedTableCalls.length, 1);
    assert.match(resolver, /\.eq\(['"]auth_user_id['"], account\.authUserId\)/);

    const migration = source('supabase/migrations/0325_organization_access_foundation.sql');
    assert.match(migration, /grant select on public\.account_property_staff_links to service_role/i);
    assert.doesNotMatch(migration, /grant (insert|update|all) on public\.account_property_staff_links to service_role/i);
  });
});

describe('Communications attachment isolation', () => {
  const voicePath = `${PROPERTY_A}/comms/${CONVERSATION_A}/${OBJECT_ID}.webm`;

  test('parses only the exact property/conversation namespace and infers kind', () => {
    assert.deepEqual(parseCommsAttachmentPath(PROPERTY_A, voicePath), {
      propertyId: PROPERTY_A,
      conversationId: CONVERSATION_A,
      objectId: OBJECT_ID,
      extension: 'webm',
      kind: 'voice',
    });
    assert.equal(parseCommsAttachmentPath(PROPERTY_B, voicePath), null);
    assert.equal(parseCommsAttachmentPath(PROPERTY_A, `${PROPERTY_A}/comms/${CONVERSATION_A}/not-a-uuid.webm`), null);
  });

  test('rejects an attachment from another DM even within the same property', () => {
    assert.equal(
      attachmentBelongsToConversation(PROPERTY_A, CONVERSATION_B, voicePath),
      null,
    );
  });

  test('send and transcribe routes authorize the embedded conversation before side effects', () => {
    for (const path of [
      'src/app/api/comms/send/route.ts',
      'src/app/api/housekeeper/messages/send/route.ts',
    ]) {
      const route = source(path);
      const parse = route.indexOf('parseCommsAttachmentPath');
      const equality = route.indexOf('attachment.conversationId !== convV.value');
      const write = route.indexOf('postMessage(');
      assert.ok(parse >= 0 && equality > parse && write > equality, `${path} must bind attachment to target conversation`);
    }

    const transcribe = source('src/app/api/comms/transcribe/route.ts');
    const embeddedConversation = transcribe.indexOf('getConversation(ctx.pid, attachment.conversationId)');
    const membership = transcribe.indexOf('canAccessConversation(');
    const rateLimit = transcribe.indexOf('checkAndIncrementRateLimit(', embeddedConversation);
    const download = transcribe.indexOf('.download(');
    assert.ok(embeddedConversation >= 0 && membership > embeddedConversation);
    assert.ok(rateLimit > membership && download > membership);
  });
});

describe('section gates fail closed and cover high-risk routes', () => {
  test('only absent keys default on; malformed stored maps are rejected', () => {
    const flags = parseStoredEnabledSections({ inventory: false });
    assert.equal(isSectionEnabled(flags, 'inventory'), false);
    assert.equal(isSectionEnabled(flags, 'communications'), true);
    assert.equal(parseStoredEnabledSections(null), null);
    assert.throws(
      () => parseStoredEnabledSections({ inventory: 'false' }),
      (error) => error instanceof SectionLookupError && error.reason === 'malformed_value',
    );
    assert.throws(() => parseStoredEnabledSections('not-json'), SectionLookupError);
  });

  test('section lookup errors become retryable 503 responses', () => {
    const sectionServer = source('src/lib/sections/server.ts');
    assert.match(sectionServer, /if \(error\)[\s\S]*SectionLookupError\('failed to read enabled_sections'/);
    assert.match(sectionServer, /status: 503[\s\S]*ApiErrorCode\.UpstreamFailure/);
    assert.match(sectionServer, /Retry-After/);

    const financialGate = source('src/lib/financials/api-gate.ts');
    assert.doesNotMatch(financialGate, /isSectionEnabledForProperty/);
    assert.match(financialGate, /requirePropertySectionEnabled\(pid, ['"]financials['"], \{ requestId \}\)/);
    assert.match(financialGate, /sectionGate\.response\.status === 403[\s\S]*continue;[\s\S]*return sectionGate/);
  });

  test('every direct section-map consumer has deliberate lookup-failure behavior', () => {
    const home = source('src/app/api/home/summary/route.ts');
    assert.match(home, /getEnabledSections\(pid\)[\s\S]*catch \(error\)[\s\S]*status: 503[\s\S]*ApiErrorCode\.UpstreamFailure/);

    const adminSections = source('src/app/api/admin/sections/route.ts');
    assert.match(adminSections, /getEnabledSections\(idCheck\.value\)[\s\S]*catch[\s\S]*status: 503[\s\S]*ApiErrorCode\.UpstreamFailure/);

    const housekeeperMe = source('src/app/api/housekeeper/me/route.ts');
    assert.match(housekeeperMe, /let communicationsEnabled = false;[\s\S]*getEnabledSections\(pid\)[\s\S]*catch/);
    assert.match(housekeeperMe, /catch \(error\)[\s\S]*return ok\(/);

    const propertyConfig = source('src/app/api/inventory/property-config/route.ts');
    assert.match(propertyConfig, /requireOrderingAccess\(req, body\.pid\)/);
    assert.match(propertyConfig, /isSectionEnabled\(gate\.enabledSections, ['"]financials['"]\)/);
    assert.doesNotMatch(propertyConfig, /requireSectionEnabled|isSectionEnabledForProperty/);

    const inventoryHistory = source('src/app/api/inventory/history/route.ts');
    assert.match(inventoryHistory, /isSectionEnabled\(sectionGate\.enabledSections, ['"]financials['"]\)/);
    assert.doesNotMatch(inventoryHistory, /isSectionEnabledForProperty/);

    // Internal schedule processors deliberately propagate a section lookup
    // failure before delivery/materialization; their cron boundary catches it.
    const reminders = source('src/lib/reminders/store.ts');
    assert.ok(
      reminders.indexOf('isSectionEnabledForProperty(') < reminders.indexOf('await deliverReminder('),
    );
    const recurring = source('src/lib/recurring-tasks/store.ts');
    assert.ok(
      recurring.indexOf('isSectionEnabledForProperty(') < recurring.indexOf(".from('comms_tasks')"),
    );
    const scheduleCron = source('src/app/api/cron/process-agent-schedules/route.ts');
    assert.match(scheduleCron, /fireDueReminders\(now\)[\s\S]*spawnDueRecurringTodos\(now\)[\s\S]*catch \(error\)/);
  });

  test('every authenticated comms route inherits the central communications gate', () => {
    const helper = source('src/lib/comms/route-helpers.ts');
    const gate = helper.indexOf("requireSectionEnabled(req, pid, 'communications')");
    const identity = helper.indexOf('resolveStaffIdForAccount(');
    assert.ok(gate >= 0 && identity > gate, 'section gate must precede identity creation');
    for (const file of routeFilesBelow('src/app/api/comms')) {
      if (file.endsWith('/language/route.ts')) {
        const language = readFileSync(file, 'utf8');
        assert.match(language, /Property-agnostic/);
        assert.doesNotMatch(language, /comms_conversations|comms_messages|comms_members/);
        continue;
      }
      assert.match(readFileSync(file, 'utf8'), /commsContext/, `${file} must use commsContext`);
    }
  });

  test('all five housekeeper message endpoints explicitly gate Communications', () => {
    for (const path of [
      'src/app/api/housekeeper/messages/route.ts',
      'src/app/api/housekeeper/messages/dm/route.ts',
      'src/app/api/housekeeper/messages/read/route.ts',
      'src/app/api/housekeeper/messages/send/route.ts',
      'src/app/api/housekeeper/messages/thread/route.ts',
    ]) {
      assert.match(source(path), /requirePropertySectionEnabled\([^\n]+['"]communications['"]/, path);
    }
  });

  test('every Inventory and Staff API route has a direct or shared section gate', () => {
    assert.match(source('src/lib/ordering/api-gate.ts'), /requireSectionEnabled\(req, pid, ['"]inventory['"]\)/);
    for (const file of routeFilesBelow('src/app/api/inventory')) {
      assert.match(
        readFileSync(file, 'utf8'),
        /requireSectionEnabled|requireOrderingAccess/,
        `${file} must enforce Inventory section policy`,
      );
    }
    for (const dir of ['src/app/api/staff', 'src/app/api/staff-schedule']) {
      for (const file of routeFilesBelow(dir)) {
        assert.match(readFileSync(file, 'utf8'), /requireSectionEnabled/, `${file} must enforce Staff section policy`);
      }
    }
  });

  test('paid Staxis command and approval execution gate before context/cost work', () => {
    for (const path of [
      'src/app/api/agent/command/route.ts',
      'src/app/api/agent/command/resolve-action/route.ts',
    ]) {
      const route = source(path);
      const gate = route.indexOf("requireSectionEnabled(req, ");
      const context = route.indexOf('loadAgentUserCtx(');
      const cost = route.indexOf('reserveCostBudget(');
      assert.ok(gate >= 0 && context > gate && cost > gate, `${path} must gate before paid work`);
    }
  });
});

describe('capability override lookups fail closed', () => {
  test('a query error is never confused with a genuinely empty override set', () => {
    const server = source('src/lib/capabilities/server.ts');
    assert.match(
      server,
      /if \(error \|\| !Array\.isArray\(data\)\) \{[\s\S]*?throw new CapabilityLookupError/,
    );
    assert.match(server, /for \(const row of data as Array/);
    assert.doesNotMatch(server, /if \(error \|\| !data\) return map/);
    assert.match(
      server,
      /capabilityDecisionForProperty[\s\S]*?isCapabilityLookupError\(error\)[\s\S]*?return 'unavailable'/,
    );
  });

  test('the retryable API response is explicit and machine-readable', () => {
    const gate = source('src/lib/capabilities/api-gate.ts');
    assert.match(gate, /status: 503/);
    assert.match(gate, /ApiErrorCode\.UpstreamFailure/);
    assert.match(gate, /Retry-After['"]?: ['"]5/);
  });

  test('Inventory capability gates distinguish outage from denial', () => {
    for (const path of [
      'src/lib/ordering/api-gate.ts',
      'src/lib/financials/api-gate.ts',
      'src/app/api/inventory/history/route.ts',
      'src/app/api/inventory/month-close/route.ts',
      'src/app/api/inventory/opening-adjustment/route.ts',
      'src/app/api/inventory/property-config/route.ts',
      'src/app/api/inventory/scan-invoice/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /capabilityDecisionForProperty/, path);
      assert.match(route, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/, path);
      assert.match(route, /=== ['"](?:denied|allowed)['"]/, path);
    }
  });

  test('Staff, scheduling, and account-management capability gates return retryable outages', () => {
    for (const path of [
      'src/app/api/staff/contacts/route.ts',
      'src/app/api/staff/join-requests/route.ts',
      'src/app/api/staff/wages/route.ts',
      'src/app/api/staff-schedule/fill/route.ts',
      'src/app/api/staff-schedule/presets/route.ts',
      'src/app/api/staff-schedule/shifts/route.ts',
      'src/app/api/staff-schedule/templates/route.ts',
      'src/app/api/staff-schedule/time-off/route.ts',
      'src/app/api/staff-schedule/week-done/route.ts',
      'src/app/api/auth/accept-invite/route.ts',
      'src/app/api/auth/invites/route.ts',
      'src/app/api/auth/join-codes/route.ts',
      'src/app/api/auth/team/route.ts',
      'src/app/api/settings/users/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /capabilityDecision/i, path);
      assert.match(route, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/, path);
      assert.match(route, /=== ['"]denied['"]/, path);
    }

    const operational = source('src/app/api/staff/operational/route.ts');
    assert.match(operational, /authorization === ['"]unavailable['"][\s\S]*status: 503/);
    assert.match(operational, /authorization === ['"]denied['"][\s\S]*status: 403/);
  });

  test('remaining user-facing capability routes distinguish outages from denials', () => {
    for (const path of [
      'src/app/api/dashboard/labor-cost/route.ts',
      'src/app/api/settings/wages/route.ts',
      'src/app/api/settings/clean-times/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /capabilityDecisionForProperty/, path);
      assert.match(route, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/, path);
      assert.match(route, /=== ['"]denied['"]/, path);
    }

    const forecast = source('src/app/api/housekeeping/forecast/route.ts');
    assert.match(forecast, /capabilityDecisionForProperty/);
    assert.match(forecast, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/);
    assert.match(forecast, /canSeeLaborCost = capabilityDecision === ['"]allowed['"]/);

    const checklistGate = source('src/lib/checklists/access.ts');
    assert.match(checklistGate, /callerCapabilityDecision/);
    assert.match(checklistGate, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/);
    assert.match(checklistGate, /=== ['"]denied['"]/);

    const checklistCopy = source('src/app/api/settings/checklists/copy/route.ts');
    assert.match(checklistCopy, /callerCapabilityDecision/);
    assert.match(checklistCopy, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/);
    assert.match(checklistCopy, /=== ['"]denied['"]/);

    for (const path of [
      'src/app/api/settings/checklists/cleaning/route.ts',
      'src/app/api/settings/checklists/inspection/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /gateChecklistAccess\([^;]+requestId\)/, path);
      assert.match(route, /if \(!gate\.ok\) return gate\.response/, path);
    }
  });

  test('direct override-map HTTP reads turn only known lookup outages into retryable 503s', () => {
    for (const path of [
      'src/app/api/capabilities/overrides/route.ts',
      'src/app/api/admin/access/matrix/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /loadOverridesForProperty/, path);
      assert.match(
        route,
        /catch \(error\)[\s\S]*isCapabilityLookupError\(error\)[\s\S]*capabilityUnavailableResponse\(requestId\)[\s\S]*throw error/,
        path,
      );
    }
  });

  test('HTTP routes never use the boolean capability APIs directly', () => {
    for (const file of routeFilesBelow('src/app/api')) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /\b(?:canForProperty|callerCan)\s*\(/,
        `${file} must use a tri-state capability decision at the HTTP boundary`,
      );
    }
  });

  test('user-id and account/property capability helpers expose tri-state decisions', () => {
    const server = source('src/lib/capabilities/server.ts');
    assert.match(
      server,
      /capabilityDecisionForUserId[\s\S]*resolveAccountRole\(userId\)[\s\S]*capabilityDecisionForProperty/,
    );

    const teamAuth = source('src/lib/team-auth.ts');
    const helperStart = teamAuth.indexOf('export async function accountCapabilityDecisionForProperty');
    const helper = teamAuth.slice(helperStart);
    const capability = helper.indexOf('capabilityDecisionForProperty(');
    const scope = helper.indexOf("access.includes(propertyId)");
    assert.ok(helperStart >= 0 && capability >= 0 && scope > capability);
    assert.match(helper, /capabilityDecision !== ['"]allowed['"][\s\S]*return capabilityDecision/);
    assert.match(helper, /\? ['"]allowed['"][\s\S]*: ['"]denied['"]/);
  });

  test('all non-PMS user-id capability routes return retryable lookup outages', () => {
    for (const path of [
      'src/app/api/comms/announce/route.ts',
      'src/app/api/complaints/draft/route.ts',
      'src/app/api/complaints/log/route.ts',
      'src/app/api/complaints/update/route.ts',
      'src/app/api/housekeeping/auto-assign/route.ts',
      'src/app/api/housekeeping/reassign/route.ts',
      'src/app/api/housekeeping/reset-assignments/route.ts',
      'src/app/api/knowledge/articles/route.ts',
      'src/app/api/knowledge/contacts/route.ts',
      'src/app/api/knowledge/documents/route.ts',
      'src/app/api/knowledge/documents/presign/route.ts',
      'src/app/api/knowledge/events/route.ts',
      'src/app/api/knowledge/folders/route.ts',
      'src/app/api/maintenance/equipment/route.ts',
      'src/app/api/maintenance/equipment/[id]/route.ts',
    ]) {
      const route = source(path);
      assert.match(route, /capabilityDecisionForUserId/, path);
      assert.match(route, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/, path);
      assert.match(route, /=== ['"]denied['"]/, path);
    }

    const home = source('src/app/api/home/summary/route.ts');
    assert.match(home, /capabilityDecisionForUserId/);
    assert.match(home, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/);
    assert.match(home, /canViewFinancials = financialCapabilityDecision === ['"]allowed['"]/);

    const onboarding = source('src/app/api/onboarding/complete/route.ts');
    assert.match(onboarding, /accountCapabilityDecisionForProperty/);
    assert.match(onboarding, /=== ['"]unavailable['"][\s\S]*capabilityUnavailableResponse/);
    assert.match(onboarding, /=== ['"]denied['"]/);
  });

  test('no non-PMS HTTP route imports boolean user/account capability wrappers', () => {
    for (const file of routeFilesBelow('src/app/api')) {
      if (file.includes('/src/app/api/pms/')) continue;
      const route = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        route,
        /import\s+\{[^}]*\bcanForUserId\b[^}]*\}\s+from/,
        `${file} must use capabilityDecisionForUserId`,
      );
      assert.doesNotMatch(
        route,
        /import\s+\{[^}]*\baccountCanForProperty\b[^}]*\}\s+from/,
        `${file} must use accountCapabilityDecisionForProperty`,
      );
    }
  });
});

describe('admin account and local sync fail-closed contracts', () => {
  test('mixed profile/Auth updates are rejected before either write can commit', () => {
    const route = source('src/app/api/auth/accounts/route.ts');
    const putStart = route.indexOf('export async function PUT');
    const deleteStart = route.indexOf('// DELETE /api/auth/accounts', putStart);
    const put = route.slice(putStart, deleteStart);
    const separation = put.indexOf('if (hasAccountUpdates && hasAuthUpdates)');
    const accountWrite = put.indexOf(".from('accounts')", separation);
    const authWrite = put.indexOf('updateUserById(', separation);
    assert.ok(separation >= 0 && accountWrite > separation && authWrite > separation);
    assert.ok(put.indexOf('isValidEmail(normalizedEmail)') < separation);
    assert.ok(put.indexOf('propertyAccess contains an invalid property id') < separation);
    assert.match(put, /password\.length > 0 && password\.length < 6/);
    assert.doesNotMatch(put, /password\.length > 0 && password\.length < 8/);
  });

  test('only confirmed Auth not-found errors permit local account cleanup', () => {
    assert.equal(isConfirmedAuthUserNotFound({ status: 404 }), true);
    assert.equal(isConfirmedAuthUserNotFound({ code: 'user_not_found' }), true);
    assert.equal(isConfirmedAuthUserNotFound({ message: 'User not found' }), false);
    assert.equal(isConfirmedAuthUserNotFound({ status: 503, message: 'User not found' }), false);
    assert.equal(isConfirmedAuthUserNotFound({ status: 503, message: 'upstream timeout' }), false);
    assert.equal(isConfirmedAuthUserNotFound(new Error('network failed')), false);

    const route = source('src/app/api/auth/accounts/route.ts');
    const transientGuard = route.indexOf('if (!isConfirmedAuthUserNotFound(delErr))');
    const cleanup = route.indexOf(".from('accounts')", transientGuard);
    assert.ok(transientGuard >= 0 && cleanup > transientGuard);
    assert.match(route.slice(transientGuard, cleanup), /status: 503[\s\S]*ApiErrorCode\.UpstreamFailure/);
  });

  test('secretless local sync is allowed only in explicit non-Vercel development', () => {
    assert.equal(isExplicitLocalDevelopment('development', undefined), true);
    assert.equal(isExplicitLocalDevelopment('development', 'development'), false);
    assert.equal(isExplicitLocalDevelopment('development', 'preview'), false);
    assert.equal(isExplicitLocalDevelopment('production', 'production'), false);
    assert.equal(isExplicitLocalDevelopment('production', undefined), false);
    assert.equal(isExplicitLocalDevelopment('test', undefined), false);
  });
});
