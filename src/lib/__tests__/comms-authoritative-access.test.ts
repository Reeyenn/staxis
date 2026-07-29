import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AuthoritativePropertyAccess } from '@/lib/authorization/server';
import {
  listAccessiblePropertyIds,
  resolvePrivateHotelCommsStaffId,
} from '@/lib/comms/route-helpers';

const ACCOUNT = 'a1000000-0000-4000-8000-000000000001';
const HOTEL_A = 'a1000000-0000-4000-8000-000000000002';
const HOTEL_B = 'a1000000-0000-4000-8000-000000000003';

function authority(propertyIds: string[], all = false): AuthoritativePropertyAccess {
  return {
    all,
    authorityMode: 'normalized',
    authorityVersion: 5,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds: all ? [] : propertyIds,
    legacyPropertyIds: [],
    membershipPropertyIds: all ? [] : propertyIds,
    propertyStandings: [],
  };
}

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

test('communications campaign reads use only the exclusive authoritative projection', async () => {
  let accountSeen: string | null = null;
  let allPropertiesRead = false;
  assert.deepEqual(await listAccessiblePropertyIds(ACCOUNT, {
    loadAuthority: async (accountId) => {
      accountSeen = accountId;
      return authority([HOTEL_A]);
    },
    loadAllPropertyIds: async () => {
      allPropertiesRead = true;
      return [HOTEL_A, HOTEL_B];
    },
  }), [HOTEL_A]);
  assert.equal(accountSeen, ACCOUNT);
  assert.equal(allPropertiesRead, false, 'a customer grant can never fall through to fleet-wide enumeration');

  assert.equal(await listAccessiblePropertyIds(ACCOUNT, {
    loadAuthority: async () => null,
    loadAllPropertyIds: async () => [HOTEL_A],
  }), null, 'an authority outage is not an empty or legacy-fallback scope');

  assert.deepEqual(await listAccessiblePropertyIds(ACCOUNT, {
    loadAuthority: async () => authority([], true),
    loadAllPropertyIds: async () => [HOTEL_A, HOTEL_B],
  }), [HOTEL_A, HOTEL_B], 'only a verified platform-admin projection may enumerate the fleet');
});

test('company-only portfolio standing cannot resolve or create a private hotel staff identity', async () => {
  let staffResolutionCalls = 0;
  const denied = await resolvePrivateHotelCommsStaffId(
    { hotelMutationAllowed: false },
    async () => {
      staffResolutionCalls += 1;
      return 'a1000000-0000-4000-8000-000000000099';
    },
  );
  assert.equal(denied, null);
  assert.equal(staffResolutionCalls, 0);

  const allowed = await resolvePrivateHotelCommsStaffId(
    { hotelMutationAllowed: true },
    async () => {
      staffResolutionCalls += 1;
      return 'a1000000-0000-4000-8000-000000000099';
    },
  );
  assert.equal(allowed, 'a1000000-0000-4000-8000-000000000099');
  assert.equal(staffResolutionCalls, 1);
});

test('communications account/context resolution never revives raw property_access', () => {
  const core = source('src/lib/comms/core.ts');
  const resolver = core.slice(
    core.indexOf('export async function resolveAccount'),
    core.indexOf('/** Coerce any stored value'),
  );
  assert.match(resolver, /listAuthoritativePropertyAccess\(data\.id as string\)/);
  assert.doesNotMatch(resolver, /\.select\([^)]*property_access/);

  const helpers = source('src/lib/comms/route-helpers.ts');
  const context = helpers.slice(helpers.indexOf('export async function commsContext'));
  assert.match(context, /userHasPropertyAccess\(session\.userId, pid\)/);
  assert.match(context, /authoritativeStandingForProperty\(account\.authority, pid\)/);
  assert.match(context, /resolvePrivateHotelCommsStaffId\(/);
  assert.doesNotMatch(context, /account\.propertyAccess\.includes|property_access/);

  const localStandingGate = context.indexOf('resolvePrivateHotelCommsStaffId(');
  const staffResolution = context.indexOf('resolveStaffIdForAccount(');
  assert.ok(
    localStandingGate >= 0 && staffResolution > localStandingGate,
    'company-only/read-only actors must be denied before staff lookup or creation',
  );
});

test('cross-hotel announcement writes are disabled and single-hotel commit reauthorizes', () => {
  const announcement = source('src/app/api/comms/announce/route.ts');
  const orgWideRefusal = announcement.indexOf('if (orgWide)');
  const rateLimit = announcement.indexOf("checkAndIncrementRateLimit('comms-send'", orgWideRefusal);
  const translation = announcement.indexOf('translateNoticeToSpanish(', rateLimit);
  const firstDecision = announcement.indexOf('accountCapabilityDecisionForProperty(');
  const commitDecision = announcement.indexOf('accountCapabilityDecisionForProperty(', firstDecision + 1);
  const write = announcement.indexOf('postAnnouncement(', commitDecision);
  assert.ok(orgWideRefusal >= 0 && rateLimit > orgWideRefusal);
  assert.ok(translation > rateLimit && commitDecision > translation && write > commitDecision);
  assert.match(announcement.slice(orgWideRefusal, rateLimit), /preview and confirmation workflow/);
  assert.match(announcement.slice(commitDecision, write), /requireMutation: true, requireManager: true/);
  assert.equal((announcement.match(/postAnnouncement\(/g) ?? []).length, 1);

  const bootstrap = source('src/app/api/comms/bootstrap/route.ts');
  assert.match(bootstrap, /const canOrgWide = false/);
});

test('private communications tables have no property-wide browser SELECT bypass', () => {
  const migration = source('supabase/migrations/0394_authoritative_browser_mutation_boundary.sql');
  for (const table of [
    'comms_acknowledgements',
    'comms_conversations',
    'comms_log_entries',
    'comms_log_replies',
    'comms_members',
    'comms_messages',
    'comms_presence',
    'comms_reactions',
    'comms_tasks',
    'schedule_templates',
    'schedule_week_signoffs',
  ]) {
    assert.match(migration, new RegExp(`'${table}'`));
  }
  assert.match(migration, /drop policy if exists comms_conversations_select_tenant/);
  assert.match(migration, /drop policy if exists comms_members_select_tenant/);
  assert.match(migration, /drop policy if exists comms_messages_select_tenant/);
  assert.match(migration, /create policy %I[\s\S]*to anon, authenticated using \(false\)/);
  assert.match(migration, /revoke select on public\.%I from anon, authenticated/);
  assert.match(
    migration,
    /create or replace function public\.user_manages_property\(p_id uuid\)[\s\S]*staxis_user_can_mutate_property\(p_id\)/,
  );
});
