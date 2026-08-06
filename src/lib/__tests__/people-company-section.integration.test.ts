/**
 * SIBLING ISOLATION on My Hotel, against a real database holding TWO COMPANIES.
 *
 * The People screen now shows a hotel's own staff plus, in a separate read-only
 * section, the company people responsible for that hotel. The dangerous half of
 * that sentence is the second one: the moment a screen starts listing "company"
 * people, the obvious wrong implementation lists the company's OTHER hotels'
 * people too, and a GM at Beaumont learns who runs Lufkin, or worse, that a
 * rival management company's Tyler Lodge exists at all.
 *
 * The pure merge is covered in people-company-section.test.ts. This file pins
 * the part a fake client cannot prove: what the private team route actually
 * hands each viewer, out of real rows, through the canonical resolver.
 *
 * What each block would catch:
 *   OWN ROSTER      the GM's own hotel roster still arrives, with the company
 *                   people over it, and the Company section is exactly those.
 *   NO SIBLINGS     no account, hotel id, membership or job from the other
 *                   company appears anywhere in the response body. Asserted on
 *                   the SERIALIZED response, so a leak in a field nobody
 *                   thought to check still fails.
 *   NO REACH TRADE  broad company reach is not hotel authority: a company
 *                   owner cannot open a hotel's private roster just because
 *                   their company operates it.
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production, so the boundary under test is the route's own scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { GET as teamGet } from '@/app/api/auth/team/route';
import {
  buildHotelRoster,
  splitHotelAndCompanyPeople,
  type RosterCompanyJob,
} from '@/app/(hotel)/company/_components/people-roster';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { listAssignees } from '@/lib/worklist/core';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_VERA,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_ANA,
  UID_GIL,
  UID_MARIA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;
let signedInAs: string | null = null;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalListUsers = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);

interface TeamRow {
  accountId: string;
  displayName: string;
  role: string;
  staffId: string | null;
  historicalStaffId: string | null;
  propertyAccess: string[];
}

interface TeamPayload {
  status: number;
  raw: string;
  team: TeamRow[];
  jobs: Record<string, RosterCompanyJob[]>;
}

function authorizedRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: 'Bearer people-company-section-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.24',
    },
  });
}

async function teamFor(authUserId: string, propertyId: string): Promise<TeamPayload> {
  signedInAs = authUserId;
  const response = await teamGet(
    authorizedRequest(`https://staxis.test/api/auth/team?hotelId=${propertyId}`),
  );
  const raw = await response.text();
  const parsed = JSON.parse(raw) as {
    data?: { team?: TeamRow[]; hatsByAccountId?: Record<string, RosterCompanyJob[]> };
  };
  return {
    status: response.status,
    raw,
    team: parsed.data?.team ?? [],
    jobs: parsed.data?.hatsByAccountId ?? {},
  };
}

function sectionFor(payload: TeamPayload, propertyId: string) {
  const split = splitHotelAndCompanyPeople(
    buildHotelRoster(payload.team, []),
    payload.jobs,
    propertyId,
  );
  return {
    hotel: split.hotelGroups
      .flatMap((group) => group.people)
      .map((person) => person.name)
      .sort(),
    company: split.companyPeople.map((person) => person.name).sort(),
  };
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the tests only need the id/email the session gate reads
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );
  // @ts-expect-error the team route only needs an empty page here
  supabaseAdmin.auth.admin.listUsers = async () => ({ data: { users: [] }, error: null });

  await seedTwoCompanies(pg);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  await pg?.close();
});

describe('a GM sees their own hotel, plus the company people over it', () => {
  test('company B: Gil gets Tyler Lodge and the two people responsible for it', async () => {
    const payload = await teamFor(UID_GIL, PID_B1);
    assert.equal(payload.status, 200);

    const sections = sectionFor(payload, PID_B1);
    assert.deepEqual(sections.hotel, ['Gil'], 'the hotel list is the people who work there');
    assert.deepEqual(
      sections.company,
      ['Bo', 'Vera'],
      'the company owner and the VP over this hotel, listed apart',
    );
  });

  test('company A: Maria runs Beaumont and is not filed as oversight there', async () => {
    const payload = await teamFor(UID_MARIA, PID_A1);
    assert.equal(payload.status, 200);

    const sections = sectionFor(payload, PID_A1);
    assert.equal(
      sections.hotel.includes('Maria'),
      true,
      'she holds the GM job at this hotel, so this is her hotel',
    );
    assert.equal(sections.company.includes('Maria'), false);
    assert.deepEqual(
      sections.company,
      ['Ana', 'Fiona'],
      'the company owner and the company controller are the oversight here',
    );
  });
});

describe('the sibling wall', () => {
  test("company B's GM is told nothing about company A", async () => {
    const payload = await teamFor(UID_GIL, PID_B1);
    for (const forbidden of [
      ACCOUNT_ANA,
      ACCOUNT_MARIA,
      ACCOUNT_FRANK,
      ACCOUNT_FIONA,
      PID_A1,
      PID_A2,
      'Beaumont',
      'Lufkin',
      'Gulf Coast',
    ]) {
      assert.equal(
        payload.raw.includes(forbidden),
        false,
        `the other company leaked through: ${forbidden}`,
      );
    }
  });

  test("company A's GM is told nothing about company B", async () => {
    const payload = await teamFor(UID_MARIA, PID_A1);
    for (const forbidden of [
      ACCOUNT_BO,
      ACCOUNT_VERA,
      ACCOUNT_GIL,
      PID_B1,
      'Tyler',
      'Piney Woods',
    ]) {
      assert.equal(
        payload.raw.includes(forbidden),
        false,
        `the other company leaked through: ${forbidden}`,
      );
    }
  });

  test('every company job disclosed names only hotels the viewer can already reach', async () => {
    const payload = await teamFor(UID_GIL, PID_B1);
    const disclosed = Object.values(payload.jobs)
      .flat()
      .flatMap((job) => job.propertyIds);
    assert.equal(disclosed.length > 0, true, 'the fixture must actually disclose some jobs');
    assert.deepEqual([...new Set(disclosed)], [PID_B1]);
  });

  test('the to-do Who list at one hotel never reaches the other', async () => {
    // The Who list is roster-based and was NOT widened for company people. A
    // company person has no staff row at any hotel, so the correct answer for
    // both hotels is "the people who actually work there", which here is
    // nobody: the fixture seeds logins, not employment records.
    const tyler = await listAssignees(PID_B1);
    const beaumont = await listAssignees(PID_A1);
    assert.deepEqual(tyler, []);
    assert.deepEqual(beaumont, []);
  });
});

describe('company reach is not hotel authority', () => {
  test('a company owner cannot open a hotel private roster from company reach alone', async () => {
    const payload = await teamFor(UID_ANA, PID_A2);
    assert.equal(payload.status, 403);
    assert.deepEqual(payload.team, []);
  });
});
