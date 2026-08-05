import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import {
  ACCESS_STAGE_C_ACTIVE_RELEVANT_QUERIES_CONTRACT,
  applyMigrationsToPgliteWithHook,
  authorizeAccessStageCRelease,
} from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ANA,
  ACCOUNT_ADMIN,
  ACCOUNT_FRANK,
  ACCOUNT_HANK,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_ADMIN,
  UID_HANK,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const MIGRATION = '0426_authoritative_access_stage_c_final_contract.sql';
const LIVE_0425_DESCRIPTION =
  'Restore missing canonical room identities for is_test properties through the lineage-complete service roster path';
const ACCESS_B_LIVE_SHA = 'ec83bca6dab74a52dfb251d04be11d5c7427703f';
const CURRENT_LIVE_DESCENDANT_SHA = '442fb98d632521ea33346d5c8a97014248a31fa0';
const APPROVED_SOURCE_RUN_ID = '85981f5e-a387-4af3-ae10-b9bc1e1e9567';
const NORMAL_LEGACY_MANIFEST_HASH =
  '275e5e103004de6f31308b8888b231354cb486495c7872807495679f6bf8b00f';
const APPROVED_SOURCE_ISSUES = {
  adminAccess: '0e04070e-deed-41fd-bc9d-5754f86da796',
  adminAccount: 'f5f0e14d-6990-4b71-92e5-d3eeefa4c271',
  gus: 'ef7fe3f4-3812-4d7c-8449-855dc02a32eb',
  greta: 'cc009280-dc0b-4315-82d2-d51de0c582dc',
  dolores: '1965177c-1ff9-490c-9032-4530a866addd',
  wrapper: '1e23f10e-3b3e-4704-b081-f942ee4d2d9d',
} as const;
const APPROVED_SOURCE_STAGE_A_RUN_ID = 'ed3a20c5-1914-4bb6-8f23-4fab520fb385';
const APPROVED_SOURCE_ACCOUNTS = {
  admin: '8428bc8f-4093-44e6-8370-8cbaf62759d6',
  gus: 'c0000001-0000-4000-8000-000000000004',
  greta: 'c0000001-0000-4000-8000-000000000005',
  dolores: 'c0000001-0000-4000-8000-000000000006',
} as const;
const APPROVED_SOURCE_PROPERTIES = {
  admin: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
  testing: '96a26a7f-7129-47db-8855-b7b34407b843',
  portArthur: 'cc000003-0000-4000-8000-000000000003',
} as const;

const UNLISTED_LEGACY_ROWS = [
  {
    accountId: '0237e48f-5fe2-487c-8ae8-ab61df14da88',
    userId: '64713578-6211-4362-83f1-34f443c6433f',
    username: 'tara-alvarez',
    displayName: 'Tara Alvarez',
    role: 'owner',
    propertyId: 'b19f5a42-3bea-4232-8c28-00ce9a069fd2',
    authorityVersion: 1,
  },
  {
    accountId: '378b9d50-6559-4471-843e-6a9fd711eee1',
    userId: '3167d440-3bcf-406f-ab35-1832be043c3f',
    username: 'banana',
    displayName: 'Banana',
    role: 'housekeeping',
    propertyId: 'b93142b5-0964-42f1-9ada-f3c50c8765a9',
    authorityVersion: 1,
  },
  {
    accountId: '57132438-477a-418c-ae05-fef93e1dd64b',
    userId: '8b615141-d0fd-4cb2-8c23-00a3714af5bd',
    username: 'test-hk',
    displayName: 'Test HK',
    role: 'housekeeping',
    propertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    authorityVersion: 1,
  },
  {
    accountId: '6eb64466-ebff-4096-84a4-6675808c70ae',
    userId: '19434b74-ea8e-47d1-848a-d8197e65e42a',
    username: 'test-fd',
    displayName: 'Test FD',
    role: 'front_desk',
    propertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    authorityVersion: 1,
  },
  {
    accountId: '884bae95-7013-4a47-94a6-960a759c6909',
    userId: '0da2359e-ffa7-4b86-9948-cb3d73d9e163',
    username: 'reeyentest',
    displayName: 'Reyeen Test',
    role: 'housekeeping',
    propertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    authorityVersion: 1,
  },
  {
    accountId: '8d2add09-0d2a-4aa3-b1fe-be425507d702',
    userId: '23b39caf-e9f2-41ad-9029-dfd0c1a24b65',
    username: 'binajayesh',
    displayName: 'Binajayesh',
    role: 'owner',
    propertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    authorityVersion: 1,
  },
  {
    accountId: '98d6b43a-b85d-44eb-9634-c30395953236',
    userId: 'd6f95bbb-76aa-4eef-9051-b0cd64ea5646',
    username: 'dwa',
    displayName: 'Dwa',
    role: 'owner',
    propertyId: 'd50f810b-53f8-4294-9fae-44a817f677df',
    authorityVersion: 4,
  },
  {
    accountId: 'e9796543-4680-458b-a80b-ae7f3163b07a',
    userId: '8b1ca426-fa48-43c9-90e4-eb69fed168b6',
    username: 'test-gm',
    displayName: 'Test GM',
    role: 'general_manager',
    propertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    authorityVersion: 1,
  },
  {
    accountId: 'f64f7d03-bc84-4173-b1e2-63552b1447c7',
    userId: 'd6aa3bb7-cffa-4ae2-a9eb-5cbd84ff2750',
    username: 'jaypatel4004',
    displayName: 'Jay Patel',
    role: 'owner',
    propertyId: 'b93142b5-0964-42f1-9ada-f3c50c8765a9',
    authorityVersion: 1,
  },
  {
    accountId: 'fd7dca12-bc39-416c-aedb-58c9819504e5',
    userId: '53da263b-2d4e-4b29-832e-a2ec93413875',
    username: 'gotita7991',
    displayName: 'Gotita',
    role: 'housekeeping',
    propertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    authorityVersion: 1,
  },
] as const;

const UNLISTED_LEGACY_PROPERTIES = [
  ['b19f5a42-3bea-4232-8c28-00ce9a069fd2', 'Home2'],
  ['b93142b5-0964-42f1-9ada-f3c50c8765a9', 'Comfort Suites'],
  ['c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f', 'Test Hotel'],
  ['d50f810b-53f8-4294-9fae-44a817f677df', 'dawdwa'],
] as const;

const NORMAL_LEGACY_RAW_HASHES: Record<string, string> = {
  'b19f5a42-3bea-4232-8c28-00ce9a069fd2': '840d7dba15ed1c65814527ea23d789a45c486b676c1950ff462872ae8240e907',
  'b93142b5-0964-42f1-9ada-f3c50c8765a9': 'a095af95464a3339afbe9a2094823c8abdaf521529ec98ca46514e6c8d8bf368',
  'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f': 'd8b2f89331c1ba838aa4e29bdf46674e274baad1aa0d5f5641fdacd54e189d13',
  'd50f810b-53f8-4294-9fae-44a817f677df': '39a488aa9c88309f865c2832651c36567854bebf796e7d222df8a6d075a94036',
};

function rawHashesForTest(propertyId: string): string {
  const hash = NORMAL_LEGACY_RAW_HASHES[propertyId];
  assert.ok(hash, `missing raw hash for ${propertyId}`);
  return hash;
}

type NormalLegacyFact = {
  bridgeId: string;
  relationshipId: string;
  organizationId: string;
  membershipIds: string[];
  grantIds: string[];
  staffIds: string[];
  accountStaffId: string | null;
  compatibilityOrganizationId: string;
  compatibilityRelationshipId: string | null;
  grantProfile: string;
  grantScopeType: 'organization' | 'property';
  grantPropertyId: string | null;
  grantRelationshipId: string | null;
  revokedMembership?: {
    id: string;
    organizationId: string;
  };
};

const NORMAL_LEGACY_FACTS: Record<string, NormalLegacyFact> = {
  '0237e48f-5fe2-487c-8ae8-ab61df14da88': {
    bridgeId: 'a40a7aed-616a-4b1d-ba82-8984c930b2f9',
    relationshipId: '17f4b3eb-94fb-4e23-84ba-32398f243332',
    organizationId: '2ae10b42-d73f-4d31-a537-2f88cc05604e',
    membershipIds: ['58c14e77-46a7-46ac-aa81-73f134b7a343'],
    grantIds: ['0e74c68f-8a0e-4cac-b638-e35c2c7578ad'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: '2ae10b42-d73f-4d31-a537-2f88cc05604e',
    compatibilityRelationshipId: null,
    grantProfile: 'organization_owner',
    grantScopeType: 'organization',
    grantPropertyId: null,
    grantRelationshipId: null,
  },
  '378b9d50-6559-4471-843e-6a9fd711eee1': {
    bridgeId: '1c1ceaaf-d309-48ae-9cc1-004ca269759a',
    relationshipId: '7642f7da-2939-4b8d-add5-391147b4b1ea',
    organizationId: '95a093a6-fe52-4826-947a-5c4706cae010',
    membershipIds: ['3107a4af-c2be-49ff-93cf-fcd45a9f57aa'],
    grantIds: ['7a147214-bb54-42a7-b63a-9787bc794390'],
    staffIds: ['eb065978-4dd6-4662-af57-2e939f84a2cb'],
    accountStaffId: 'eb065978-4dd6-4662-af57-2e939f84a2cb',
    compatibilityOrganizationId: '95a093a6-fe52-4826-947a-5c4706cae010',
    compatibilityRelationshipId: '7642f7da-2939-4b8d-add5-391147b4b1ea',
    grantProfile: 'contributor',
    grantScopeType: 'property',
    grantPropertyId: 'b93142b5-0964-42f1-9ada-f3c50c8765a9',
    grantRelationshipId: '7642f7da-2939-4b8d-add5-391147b4b1ea',
  },
  '57132438-477a-418c-ae05-fef93e1dd64b': {
    bridgeId: '13fa0123-ec94-45e1-aa11-c4acb2d91734',
    relationshipId: 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    organizationId: '11110000-0000-4000-8000-0000000000a1',
    membershipIds: ['698598fa-e213-475e-bc27-5e9bd39b1864'],
    grantIds: ['e145f9fa-0b6e-4628-9b0c-9e8de1984594'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: 'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
    compatibilityRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
    grantProfile: 'contributor',
    grantScopeType: 'property',
    grantPropertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    grantRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
  },
  '6eb64466-ebff-4096-84a4-6675808c70ae': {
    bridgeId: '6afed1ee-2fd7-44c0-b20a-6732c45ea44a',
    relationshipId: 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    organizationId: '11110000-0000-4000-8000-0000000000a1',
    membershipIds: ['58217584-b7d6-462f-a95b-971bee7e9bfa'],
    grantIds: ['2988b9ab-aea6-4be4-a8ae-21e8cdd60e2d'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: 'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
    compatibilityRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
    grantProfile: 'contributor',
    grantScopeType: 'property',
    grantPropertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    grantRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
  },
  '884bae95-7013-4a47-94a6-960a759c6909': {
    bridgeId: '4b4fb7e2-e166-4d1c-8836-7985e676b604',
    relationshipId: 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    organizationId: '11110000-0000-4000-8000-0000000000a1',
    membershipIds: ['bfc81cf5-77b5-4d9b-8462-b1da5dfbff02'],
    grantIds: ['9950058a-efd3-4dad-bcca-007576f78954'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: 'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
    compatibilityRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
    grantProfile: 'contributor',
    grantScopeType: 'property',
    grantPropertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    grantRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
  },
  '8d2add09-0d2a-4aa3-b1fe-be425507d702': {
    bridgeId: '528adab1-8728-4ee4-8b8a-99bb1dc91e98',
    relationshipId: 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    organizationId: '11110000-0000-4000-8000-0000000000a1',
    membershipIds: [
      '3b112ba7-2494-48e0-8be6-78b48a5f61f4',
      'a6500631-c240-41ef-874b-8d00beff5c24',
    ],
    grantIds: ['685b8a29-381f-4321-af85-22b65c9ce2b4'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: 'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
    compatibilityRelationshipId: null,
    grantProfile: 'organization_owner',
    grantScopeType: 'organization',
    grantPropertyId: null,
    grantRelationshipId: null,
    revokedMembership: {
      id: '3b112ba7-2494-48e0-8be6-78b48a5f61f4',
      organizationId: '11110000-0000-4000-8000-0000000000a1',
    },
  },
  '98d6b43a-b85d-44eb-9634-c30395953236': {
    bridgeId: '02df6f9e-bba8-4f19-8586-115f1ca6a93c',
    relationshipId: '07d0c0d7-f983-4116-8612-c00da016b44d',
    organizationId: '12ad3f78-75e7-4aa5-b47a-9a0fa4edeb8c',
    membershipIds: ['66471207-2a8b-4287-821c-5c66cb30c521'],
    grantIds: ['be69f144-890f-4016-bde6-345bcc8429e0'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: '12ad3f78-75e7-4aa5-b47a-9a0fa4edeb8c',
    compatibilityRelationshipId: null,
    grantProfile: 'organization_owner',
    grantScopeType: 'organization',
    grantPropertyId: null,
    grantRelationshipId: null,
  },
  'e9796543-4680-458b-a80b-ae7f3163b07a': {
    bridgeId: '43c0dd2a-a2c3-4d3f-aca8-d34c90b546c8',
    relationshipId: 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    organizationId: '11110000-0000-4000-8000-0000000000a1',
    membershipIds: ['ce386157-6b91-42d7-9d8e-b9ab6d615037'],
    grantIds: ['ebb20a3f-7379-4a39-88b0-315e387edc61'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: 'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
    compatibilityRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
    grantProfile: 'property_manager',
    grantScopeType: 'property',
    grantPropertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    grantRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
  },
  'f64f7d03-bc84-4173-b1e2-63552b1447c7': {
    bridgeId: '6521d3fd-634e-4cb9-aa00-46e771bfc25b',
    relationshipId: '7642f7da-2939-4b8d-add5-391147b4b1ea',
    organizationId: '95a093a6-fe52-4826-947a-5c4706cae010',
    membershipIds: ['3194a56a-4298-45af-8cdc-d63711957600'],
    grantIds: ['71ace9d6-a489-490e-88e6-3a7d56f82140'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: '95a093a6-fe52-4826-947a-5c4706cae010',
    compatibilityRelationshipId: null,
    grantProfile: 'organization_owner',
    grantScopeType: 'organization',
    grantPropertyId: null,
    grantRelationshipId: null,
  },
  'fd7dca12-bc39-416c-aedb-58c9819504e5': {
    bridgeId: '9211738b-7a14-4c55-8436-d23fcc3a60cd',
    relationshipId: 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    organizationId: '11110000-0000-4000-8000-0000000000a1',
    membershipIds: ['cdd53ca0-2ff8-41df-a705-748d83e268d3'],
    grantIds: ['0ee6b389-dc6a-4068-a60a-30470ae3e769'],
    staffIds: [],
    accountStaffId: null,
    compatibilityOrganizationId: 'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
    compatibilityRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
    grantProfile: 'contributor',
    grantScopeType: 'property',
    grantPropertyId: 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f',
    grantRelationshipId: '63b96d8c-3534-407b-b623-98bf1756f007',
  },
};

const APPROVED_SOURCE_WRAPPER_RUNS = {
  baseline: '3f8f61d9-ca62-4c09-8bcf-ece54992b53f',
  preflight: '9754d166-09f8-44a7-8bce-7d13718cf35e',
  backfill: 'a396e956-63b8-4581-aef0-2d1ddaf47a6e',
  stageA: APPROVED_SOURCE_STAGE_A_RUN_ID,
  prior: '2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
} as const;

const APPROVED_SOURCE_ADMIN_WRAPPER_DETAILS = {
  authorityMode: 'legacy',
  preflightIssues: [
    {
      code: 'admin_legacy_access',
      runId: APPROVED_SOURCE_WRAPPER_RUNS.baseline,
      details: { role: 'admin', propertyIds: [APPROVED_SOURCE_PROPERTIES.admin] },
    },
    {
      code: 'admin_legacy_access',
      runId: APPROVED_SOURCE_WRAPPER_RUNS.preflight,
      details: { role: 'admin', propertyIds: [APPROVED_SOURCE_PROPERTIES.admin] },
    },
    {
      code: 'backfill_skipped_preflight_admin_legacy_access',
      runId: APPROVED_SOURCE_WRAPPER_RUNS.preflight,
      details: {
        reason: 'preflight_admin_legacy_access',
        backfillRunId: APPROVED_SOURCE_WRAPPER_RUNS.backfill,
        preflightRunId: APPROVED_SOURCE_WRAPPER_RUNS.preflight,
        preflightRunLabel: '0419_same_transaction_pre_backfill',
        preflightIssueCode: 'admin_legacy_access',
        preflightIssueDetails: {
          role: 'admin',
          propertyIds: [APPROVED_SOURCE_PROPERTIES.admin],
        },
        baselinePreflightRunId: APPROVED_SOURCE_WRAPPER_RUNS.baseline,
        baselinePreflightRunLabel: '0418_baseline',
      },
    },
    {
      code: 'admin_legacy_access',
      runId: APPROVED_SOURCE_WRAPPER_RUNS.prior,
      details: { propertyIds: [APPROVED_SOURCE_PROPERTIES.admin] },
    },
    {
      code: 'admin_legacy_account',
      runId: APPROVED_SOURCE_WRAPPER_RUNS.prior,
      details: {
        propertyIds: [APPROVED_SOURCE_PROPERTIES.admin],
        authorityMode: 'legacy',
      },
    },
    {
      code: 'admin_legacy_access',
      runId: APPROVED_SOURCE_RUN_ID,
      details: { propertyIds: [APPROVED_SOURCE_PROPERTIES.admin] },
    },
    {
      code: 'admin_legacy_account',
      runId: APPROVED_SOURCE_RUN_ID,
      details: {
        propertyIds: [APPROVED_SOURCE_PROPERTIES.admin],
        authorityMode: 'legacy',
      },
    },
  ],
  legacyPropertyId: APPROVED_SOURCE_PROPERTIES.admin,
  authorizationStatePresent: true,
};

function approvedSourceNormalizedWrapperDetails(propertyId: string) {
  return {
    authorityMode: 'normalized',
    preflightIssues: [
      {
        code: 'normalized_legacy_residue',
        runId: APPROVED_SOURCE_WRAPPER_RUNS.baseline,
        details: { authorityMode: 'normalized' },
      },
      {
        code: 'normalized_legacy_residue',
        runId: APPROVED_SOURCE_WRAPPER_RUNS.preflight,
        details: { authorityMode: 'normalized' },
      },
      {
        code: 'backfill_skipped_preflight_normalized_legacy_residue',
        runId: APPROVED_SOURCE_WRAPPER_RUNS.preflight,
        details: {
          reason: 'preflight_normalized_legacy_residue',
          backfillRunId: APPROVED_SOURCE_WRAPPER_RUNS.backfill,
          preflightRunId: APPROVED_SOURCE_WRAPPER_RUNS.preflight,
          preflightRunLabel: '0419_same_transaction_pre_backfill',
          preflightIssueCode: 'normalized_legacy_residue',
          preflightIssueDetails: { authorityMode: 'normalized' },
          baselinePreflightRunId: APPROVED_SOURCE_WRAPPER_RUNS.baseline,
          baselinePreflightRunLabel: '0418_baseline',
        },
      },
      {
        code: 'normalized_legacy_residue',
        runId: APPROVED_SOURCE_WRAPPER_RUNS.prior,
        details: { propertyIds: [propertyId] },
      },
      {
        code: 'normalized_legacy_residue',
        runId: APPROVED_SOURCE_RUN_ID,
        details: { propertyIds: [propertyId] },
      },
    ],
    legacyPropertyId: propertyId,
    authorizationStatePresent: true,
  };
}

const APPROVED_SOURCE_WRAPPER_DETAILS = {
  stageAInvariantRunId: APPROVED_SOURCE_STAGE_A_RUN_ID,
  stageAInvariantIssueCount: 5,
  stageAInvariant: {
    ok: false,
    runId: APPROVED_SOURCE_STAGE_A_RUN_ID,
    stage: 'A',
    sample: [
      {
        code: 'invalid_legacy_account_identity',
        details: {
          role: 'admin',
          active: true,
          dataUserId: 'ee473197-d8f2-4a2d-86d6-314b3b6e126d',
        },
        accountId: APPROVED_SOURCE_ACCOUNTS.admin,
        propertyId: null,
      },
      {
        code: 'legacy_row_without_shadow_translation',
        details: APPROVED_SOURCE_ADMIN_WRAPPER_DETAILS,
        accountId: APPROVED_SOURCE_ACCOUNTS.admin,
        propertyId: APPROVED_SOURCE_PROPERTIES.admin,
      },
      {
        code: 'legacy_row_without_shadow_translation',
        details: approvedSourceNormalizedWrapperDetails(APPROVED_SOURCE_PROPERTIES.testing),
        accountId: APPROVED_SOURCE_ACCOUNTS.gus,
        propertyId: APPROVED_SOURCE_PROPERTIES.testing,
      },
      {
        code: 'legacy_row_without_shadow_translation',
        details: approvedSourceNormalizedWrapperDetails(APPROVED_SOURCE_PROPERTIES.testing),
        accountId: APPROVED_SOURCE_ACCOUNTS.dolores,
        propertyId: APPROVED_SOURCE_PROPERTIES.testing,
      },
      {
        code: 'legacy_row_without_shadow_translation',
        details: approvedSourceNormalizedWrapperDetails(APPROVED_SOURCE_PROPERTIES.portArthur),
        accountId: APPROVED_SOURCE_ACCOUNTS.greta,
        propertyId: APPROVED_SOURCE_PROPERTIES.portArthur,
      },
    ],
    issueCount: 5,
    legacySnapshotCount: 17,
    legacyArraysPreserved: true,
    legacyWriteEventCount: 0,
  },
};
const BOOTSTRAP_ACCOUNT = 'c4269000-0000-4000-8000-000000000001';
const BOOTSTRAP_USER = 'c426a000-0000-4000-8000-000000000001';

const INVITE_USER = 'c4261000-0000-4000-8000-000000000001';
const INVITE_STAFF = 'c4262000-0000-4000-8000-000000000001';
const GRANT_ACCOUNT = 'c4260000-0000-4000-8000-000000000002';
const GRANT_USER = 'c4261000-0000-4000-8000-000000000002';
const GRANT_STAFF = 'c4262000-0000-4000-8000-000000000002';
const JOIN_ACCOUNT = 'c4260000-0000-4000-8000-000000000003';
const JOIN_USER = 'c4261000-0000-4000-8000-000000000003';
const JOIN_REQUEST = 'c4263000-0000-4000-8000-000000000001';
const FIRST_PROPERTY = 'c4264000-0000-4000-8000-000000000001';
const FIRST_USER = 'c4261000-0000-4000-8000-000000000004';
const FIRST_CODE = 'STGC-ABCDEFGHJK';
const LIFECYCLE_ACCOUNT = 'c4260000-0000-4000-8000-000000000004';
const LIFECYCLE_USER = 'c4261000-0000-4000-8000-000000000005';
const LIFECYCLE_OPERATION = 'c4265000-0000-4000-8000-000000000001';
const DETACH_ACCOUNT = 'c4260000-0000-4000-8000-000000000005';
const DETACH_USER = 'c4261000-0000-4000-8000-000000000006';
const DETACH_OPERATION = 'c4265000-0000-4000-8000-000000000002';
const TRANSFER_ACCOUNT = 'c4260000-0000-4000-8000-000000000009';
const TRANSFER_USER = 'c4261000-0000-4000-8000-000000000009';
const TRANSFER_OPERATION = 'c4265000-0000-4000-8000-000000000009';

const DIRTY_JOIN_REQUEST = 'c4266000-0000-4000-8000-000000000001';
const DIRTY_ACCESS_REQUEST = 'c4266000-0000-4000-8000-000000000002';
const DIRTY_INVITATION = 'c4266000-0000-4000-8000-000000000003';
const POST_CHECK_JOIN_REQUEST = 'c4266000-0000-4000-8000-000000000004';
const ORDINARY_UNACCEPTED_INVITE = 'c4266000-0000-4000-8000-000000000005';

interface JsonRow {
  value: Record<string, unknown>;
}

interface MigrationRow {
  version: string;
  description: string;
}

interface PreflightIssue {
  issue_code: string;
}

async function rows<T = Record<string, unknown>>(
  pg: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = (await pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

async function jsonRpc(
  pg: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(sql, params);
  assert.ok(result.rows[0], 'expected JSON RPC result');
  return result.rows[0].value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function activeSourceText(...roots: string[]): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') visit(path);
        continue;
      }
      if (/(?:\.ts|\.tsx|\.js|\.mjs|\.cjs)$/.test(entry) && !/\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)) {
        files.push(path);
      }
    }
  };
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) visit(root);
    } catch {
      // Optional support roots (workers/cron/support) are absent in some
      // deployments; the inventory remains deterministic for those that exist.
    }
  }
  return files.sort()
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

async function seedStageCFixture(pg: PGlite): Promise<void> {
  await seedTwoCompanies(pg);
  // The clean final-contract fixture must not rely on the suffix's former
  // broad raw-array clear. Convert the two legacy Waco control accounts
  // through the ordinary Stage B scope seam, then remove only the fixture
  // setup snapshot. Their effective access remains canonical and the final
  // migration therefore starts with no unapproved raw scopes.
  for (const [accountId, propertyId, role] of [
    [ACCOUNT_WANDA, PID_L1, 'owner'],
    [ACCOUNT_HANK, PID_L1, 'housekeeping'],
  ] as const) {
    const state = (await rows<{ authority_version: number }>(
      pg,
      `select authority_version
         from public.account_authorization_state
        where account_id=$1`,
      [accountId],
    ))[0];
    const result = await jsonRpc(
      pg,
      `select public.staxis_set_account_authorization_scope(
         $1,$2,$3::uuid[],$4,$5,$6,'Stage C clean canonical fixture'
       ) as value`,
      [ACCOUNT_ADMIN, accountId, [propertyId], state.authority_version, role, role],
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  await pg.query(
    `update public.accounts
        set property_access='{}'::uuid[]
      where id in ($1,$2)`,
    [ACCOUNT_WANDA, ACCOUNT_HANK],
  );
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);

  // The fixture deliberately plants the admin's historical row through the
  // pre-C seed. Its canonical platform-admin role is already established, so
  // mark that state as the operator would before a production cutover.
  await pg.query(
    `update public.account_authorization_state
        set authority_mode = 'normalized',
            cutover_at = coalesce(cutover_at, now()),
            cutover_reason = coalesce(cutover_reason, 'Stage C canonical-admin fixture')
      where account_id = $1`,
    [ACCOUNT_ADMIN],
  );
}

async function seedProductionResidueFixture(pg: PGlite): Promise<void> {
  // Keep the seeded platform admin in its original legacy mode. The clean
  // Stage C fixture intentionally normalizes that row, but this production
  // incident is specifically the preflight admin residue.
  await seedTwoCompanies(pg);
  // Reuse the real company topology but mark the A1 hotel as the explicit
  // is_test production fixture. The seed's unrelated legacy controls are
  // normalized/emptied so the only failed-run residues are the three
  // approved decision classes below.
  await pg.query(`update public.properties set is_test=true where id=$1`, [PID_A1]);
  await pg.query(
    `update public.accounts set property_access='{}'::uuid[]
      where id in ($1,$2)`,
    [ACCOUNT_WANDA, ACCOUNT_HANK],
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='normalized',
            cutover_at=coalesce(cutover_at, now()),
            cutover_reason=coalesce(cutover_reason, 'Stage C residue fixture cleanup')
      where account_id in ($1,$2)`,
    [ACCOUNT_WANDA, ACCOUNT_HANK],
  );

  // Admin: global role authority, raw A1 residue, no canonical grant.
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='legacy', cutover_at=null,
            cutover_reason='Stage C production-shaped admin residue'
      where account_id=$1`,
    [ACCOUNT_ADMIN],
  );
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_ADMIN, PID_A1]);

  // Duplicate: Maria's canonical hats cover A1/A2; raw A1 is redundant.
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_MARIA, PID_A1]);

  // Revoked-empty: Frank's only A1 membership is explicitly ended/revoked.
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_FRANK, PID_A1]);
  await pg.query(
    `update public.organization_memberships
        set status='revoked', ended_at=coalesce(ended_at, now()), updated_at=now()
      where account_id=$1 and organization_id=$2
        and membership_scope='property' and $3::uuid = any(coalesce(covered_property_ids,'{}'::uuid[]))
        and status='active'`,
    [ACCOUNT_FRANK, ORG_A, PID_A1],
  );

  // The Stage A translator observed the fixture setup writes. Production
  // evidence for this incident is zero, so reset only this test setup audit
  // before the report-only prefix runs.
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function seedUnlistedLegacyRowsFixture(pg: PGlite): Promise<void> {
  const primaryOrganizations: Record<string, { id: string; name: string; type: string; legacyPropertyId: string | null }> = {
    'b19f5a42-3bea-4232-8c28-00ce9a069fd2': { id: '2ae10b42-d73f-4d31-a537-2f88cc05604e', name: 'Home2', type: 'single_hotel', legacyPropertyId: 'b19f5a42-3bea-4232-8c28-00ce9a069fd2' },
    'b93142b5-0964-42f1-9ada-f3c50c8765a9': { id: '95a093a6-fe52-4826-947a-5c4706cae010', name: 'Comfort Suites', type: 'single_hotel', legacyPropertyId: 'b93142b5-0964-42f1-9ada-f3c50c8765a9' },
    'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f': { id: '11110000-0000-4000-8000-0000000000a1', name: 'Test Hotel', type: 'management_company', legacyPropertyId: null },
    'd50f810b-53f8-4294-9fae-44a817f677df': { id: '12ad3f78-75e7-4aa5-b47a-9a0fa4edeb8c', name: 'dawdwa', type: 'single_hotel', legacyPropertyId: 'd50f810b-53f8-4294-9fae-44a817f677df' },
  };
  const primaryRelationships: Record<string, string> = {
    'b19f5a42-3bea-4232-8c28-00ce9a069fd2': '17f4b3eb-94fb-4e23-84ba-32398f243332',
    'b93142b5-0964-42f1-9ada-f3c50c8765a9': '7642f7da-2939-4b8d-add5-391147b4b1ea',
    'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f': 'ae8c748e-e203-45b1-a4b4-9b18f2295a4f',
    'd50f810b-53f8-4294-9fae-44a817f677df': '07d0c0d7-f983-4116-8612-c00da016b44d',
  };
  const rawHashes = NORMAL_LEGACY_RAW_HASHES;

  for (const [propertyId, name] of UNLISTED_LEGACY_PROPERTIES) {
    await pg.query(
      `insert into public.properties(id,name,owner_id,total_rooms,timezone,is_test)
       values ($1,$2,$3,60,'America/Chicago',$4)
       on conflict (id) do nothing`,
      [propertyId, name, UID_ADMIN, propertyId === 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f'],
    );
    await pg.query(
      `update public.organization_property_relationships
          set is_primary_grouping=false
        where property_id=$1 and ends_at is null and is_primary_grouping=true`,
      [propertyId],
    );
    await pg.query(`delete from public.organizations where legacy_property_id=$1`, [propertyId]);
    const organization = primaryOrganizations[propertyId];
    await pg.query(
      `insert into public.organizations(id,name,organization_type,status,legacy_property_id)
       values ($1,$2,$3,'active',$4)`,
      [organization.id, organization.name, organization.type, organization.legacyPropertyId],
    );
    await pg.query(
      `insert into public.organization_property_relationships(
         id,organization_id,property_id,relationship_type,is_primary_grouping,starts_at
       ) values ($1,$2,$3,'operator',true,clock_timestamp() - interval '1 day')`,
      [primaryRelationships[propertyId], organization.id, propertyId],
    );
  }
  await pg.query(
    `insert into public.organizations(id,name,organization_type,status)
     values ('d4a443ce-959e-4d2e-8c26-7d103165c6ba','Legacy Compatibility Company',
             'management_company','active') on conflict (id) do nothing`,
  );
  await pg.query(
    `insert into public.organization_property_relationships(
       id,organization_id,property_id,relationship_type,is_primary_grouping,starts_at
     ) values ('63b96d8c-3534-407b-b623-98bf1756f007',
       'd4a443ce-959e-4d2e-8c26-7d103165c6ba',
       'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f','operator',false,
       clock_timestamp() - interval '1 day') on conflict (id) do nothing`,
  );
  await insertStaff(pg, 'eb065978-4dd6-4662-af57-2e939f84a2cb',
    'b93142b5-0964-42f1-9ada-f3c50c8765a9', 'Banana Staff', 'housekeeping', '555-0101');

  for (const row of UNLISTED_LEGACY_ROWS) {
    await insertCanonicalAccount(pg, row.accountId, row.userId, row.username,
      row.displayName, row.role, `${row.username}@example.test`);
    const fact = NORMAL_LEGACY_FACTS[row.accountId];
    assert.ok(fact, `missing normal-legacy fixture fact for ${row.accountId}`);
    if (fact.accountStaffId) {
      await pg.query(`update public.accounts set staff_id=$2 where id=$1`, [row.accountId, fact.accountStaffId]);
    }
    await pg.query(
      `insert into public.account_property_authorization_bridges(
         id,account_id,property_id,cutover_organization_id,cutover_relationship_id,
         status,source_legacy_scope_hash,cutover_reason
       ) values ($1,$2,$3,$4,$5,'active',$6,'authoritative normal-legacy fixture')`,
      [fact.bridgeId, row.accountId, row.propertyId, fact.organizationId,
        fact.relationshipId, rawHashes[row.propertyId]],
    );
    const compatibilityMembershipIds = fact.membershipIds;
    for (const membershipId of compatibilityMembershipIds) {
      const revoked = fact.revokedMembership?.id === membershipId;
      await pg.query(
        `insert into public.organization_memberships(
           id,organization_id,account_id,job_category,status,starts_at,ended_at,
           membership_scope,staxis_role,covered_property_ids
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          membershipId,
          revoked ? fact.revokedMembership?.organizationId : fact.compatibilityOrganizationId,
          row.accountId,
          row.role === 'owner' ? 'owner_principal' : row.role === 'general_manager' ? 'general_manager' : 'hotel_employee',
          revoked ? 'revoked' : 'active',
          revoked ? '2026-07-26T09:00:19.192312Z' : '2026-07-20T14:37:28.765078Z',
          revoked ? '2026-07-26T13:17:59.320767Z' : null,
          revoked ? 'company' : null,
          revoked ? 'vp' : null,
          null,
        ],
      );
    }
    await pg.query(
      `insert into public.organization_access_grants(
         id,organization_id,membership_id,access_profile,scope_type,
         property_relationship_id,property_id,status,source,version
       ) values ($1,$2,$3,$4,$5,$6,$7,'active','legacy_backfill',1)`,
      [fact.grantIds[0], fact.compatibilityOrganizationId, fact.membershipIds.at(-1),
        fact.grantProfile, fact.grantScopeType, fact.grantRelationshipId, fact.grantPropertyId],
    );
    if (fact.accountStaffId) {
      await pg.query(
        `insert into public.account_property_staff_links(
           account_id,property_id,staff_id,is_active,source,linked_at
         ) values ($1,$2,$3,true,'legacy_backfill',clock_timestamp() - interval '1 day')`,
        [row.accountId, row.propertyId, fact.accountStaffId],
      );
    }
  }

  // Populate every raw scope before cleaning the trigger-created compatibility
  // rows. Shared-property reconciliation can revisit earlier accounts while
  // this batch is being populated, so state is reset only after the batch.
  for (const row of UNLISTED_LEGACY_ROWS) {
    await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`,
      [row.accountId, row.propertyId]);
  }

  for (const row of UNLISTED_LEGACY_ROWS) {
    const fact = NORMAL_LEGACY_FACTS[row.accountId];
    await pg.query(
      `delete from public.organization_access_grants grant_row
        where grant_row.membership_id in (
          select membership.id from public.organization_memberships membership where membership.account_id=$1
        ) and not (grant_row.id = any($2::uuid[]))`,
      [row.accountId, fact.grantIds],
    );
    await pg.query(
      `delete from public.organization_memberships membership
        where membership.account_id=$1 and not (membership.id = any($2::uuid[]))`,
      [row.accountId, fact.membershipIds],
    );
    await pg.query(
      `delete from public.account_property_staff_links
        where account_id=$1 and not (staff_id = any($2::uuid[]))`,
      [row.accountId, fact.staffIds],
    );
    await pg.query(
      `delete from public.account_property_authorization_bridges
        where account_id=$1 and id <> $2`,
      [row.accountId, fact.bridgeId],
    );
  }
  // The c7 test property has an authoritative management-company primary
  // organization. Legacy reconciliation can create a temporary single-hotel
  // anchor while seeding arrays; remove only that generated anchor, never the
  // manifest-bound management company or its relationship.
  await pg.query(
    `delete from public.organizations where legacy_property_id=$1`,
    ['c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f'],
  );
  for (const row of UNLISTED_LEGACY_ROWS) {
    await pg.query(`delete from public.account_authorization_state where account_id=$1`, [row.accountId]);
    await pg.query(
      `insert into public.account_authorization_state(
         account_id,authority_mode,authority_version,legacy_scope_hash,
         normalized_scope_hash,cutover_at,cutover_reason
       ) values ($1,'legacy',$2,$3,encode(sha256(convert_to('', 'UTF8')),'hex'),null,
                 'Unlisted production-shaped legacy scope fixture')`,
      [row.accountId, row.authorityVersion, rawHashes[row.propertyId]],
    );
  }
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function seedPreconvertedNormalLegacyReplayRow(
  pg: PGlite,
  row: (typeof UNLISTED_LEGACY_ROWS)[number],
): Promise<void> {
  const fact = NORMAL_LEGACY_FACTS[row.accountId];
  assert.ok(fact, `missing replay fixture fact for ${row.accountId}`);
  const beforeEvidence = (await rows<{ evidence: unknown }>(
    pg,
    `select public._staxis_stage_c_account_evidence($1,$2) as evidence`,
    [row.accountId, row.propertyId],
  ))[0]?.evidence;
  assert.ok(beforeEvidence, `missing replay before evidence for ${row.accountId}`);
  const imported = await jsonRpc(
    pg,
    `select public._staxis_stage_b_import_legacy_scope(
       $1,'Access Stage C deterministic replay fixture'
     ) as value`,
    [row.accountId],
  );
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.status, 'imported', JSON.stringify(imported));
  await pg.exec(`
    drop trigger if exists trg_accounts_authorization_refresh on public.accounts;
    drop trigger if exists trg_accounts_reconcile_legacy_organization_access on public.accounts;
    drop trigger if exists trg_accounts_authorization_translate_legacy_property_access on public.accounts;
    drop trigger if exists trg_accounts_zz_authorization_translate_legacy_property_access on public.accounts;
  `);
  await pg.query(
    `update public.accounts set property_access='{}'::uuid[] where id=$1`,
    [row.accountId],
  );
  await pg.query(`delete from public.account_authorization_state where account_id=$1`, [row.accountId]);
  await pg.query(
    `insert into public.account_authorization_state(
       account_id,authority_mode,authority_version,legacy_scope_hash,
       normalized_scope_hash,cutover_at,cutover_reason
     ) values ($1,'normalized',$2,$3,$3,clock_timestamp(),
               'Access Stage C deterministic replay fixture')`,
    [row.accountId, row.authorityVersion + 1, rawHashesForTest(row.propertyId)],
  );
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
  const afterEvidence = (await rows<{ evidence: unknown }>(
    pg,
    `select public._staxis_stage_c_account_evidence($1,$2) as evidence`,
    [row.accountId, row.propertyId],
  ))[0]?.evidence;
  assert.ok(afterEvidence, `missing replay after evidence for ${row.accountId}`);
  const compatibility = (await rows<{ compatibility: unknown }>(
    pg,
    `select jsonb_build_object(
       'memberships', coalesce((select jsonb_agg(jsonb_build_object(
         'id', membership.id, 'organizationId', membership.organization_id,
         'status', membership.status, 'endedAtPresent', membership.ended_at is not null,
         'membershipScope', membership.membership_scope, 'staxisRole', membership.staxis_role,
         'coveredPropertyIds', membership.covered_property_ids
       ) order by membership.id) from public.organization_memberships membership
        where membership.account_id=account.id), '[]'::jsonb),
       'grants', coalesce((select jsonb_agg(jsonb_build_object(
         'id', grant_row.id, 'organizationId', grant_row.organization_id,
         'accessProfile', grant_row.access_profile, 'scopeType', grant_row.scope_type,
         'propertyId', grant_row.property_id, 'propertyRelationshipId', grant_row.property_relationship_id,
         'status', grant_row.status, 'source', grant_row.source,
         'expiresAtPresent', grant_row.expires_at is not null,
         'revokedAtPresent', grant_row.revoked_at is not null, 'version', grant_row.version
       ) order by grant_row.id)
        from public.organization_access_grants grant_row
        join public.organization_memberships membership on membership.id=grant_row.membership_id
       where membership.account_id=account.id and grant_row.status='active'), '[]'::jsonb),
       'staffLinks', coalesce((select jsonb_agg(jsonb_build_object(
         'accountId', staff_link.account_id, 'propertyId', staff_link.property_id,
         'staffId', staff_link.staff_id, 'isActive', staff_link.is_active,
         'source', staff_link.source, 'deactivatedAtPresent', staff_link.deactivated_at is not null
       ) order by staff_link.property_id, staff_link.staff_id)
        from public.account_property_staff_links staff_link
       where staff_link.account_id=account.id and staff_link.is_active), '[]'::jsonb),
       'accountStaffId', account.staff_id) as compatibility
      from public.accounts account where account.id=$1`,
    [row.accountId],
  ))[0]?.compatibility;
  assert.ok(compatibility, `missing replay compatibility for ${row.accountId}`);
  const state = (await rows<{ authority_version: number }>(
    pg,
    `select authority_version from public.account_authorization_state where account_id=$1`,
    [row.accountId],
  ))[0];
  assert.equal(state.authority_version, row.authorityVersion + 1);
  await pg.query(
    `insert into public.account_access_cutover_normal_legacy_manifests(
       account_id,source_preflight_run_id,property_id,expected_role,
       expected_authority_mode,expected_authority_version,expected_raw_property_ids,
       expected_raw_scope_hash,expected_canonical_ids,expected_canonical_hash,
       aggregate_manifest_hash,expected_auth_user_id,expected_account_staff_id,
       expected_active,expected_relationship_id,expected_organization_id,
       expected_organization_type,expected_bridge_id,expected_membership_ids,
       expected_grant_ids,expected_staff_ids,expected_compatibility,
       expected_compatibility_hash,status,conversion_txid,auth_user_id_snapshot,
       active_snapshot,relationship_id_snapshot,organization_id_snapshot,
       organization_type_snapshot,evidence_before,evidence_before_hash,
       evidence_after,evidence_after_hash,observed_compatibility,
       observed_compatibility_hash,canonical_ids_after,canonical_hash_after,
       authority_version_after,bridge_id_after,converted_at,details
     ) values (
       $1::uuid,$2::uuid,$3::uuid,$4::text,'legacy',$5::bigint,
       array[$3::uuid]::uuid[],$6::text,'{}'::uuid[],$7::text,$8::text,
       $9::uuid,$10::uuid,
       true,$11::uuid,$12::uuid,$13::text,$14::uuid,$15::uuid[],$16::uuid[],$17::uuid[],$18::jsonb,
       encode(sha256(convert_to($18::jsonb::text,'UTF8')),'hex'),
       'converted',null,$9::uuid,true,$11::uuid,$12::uuid,$13::text,$19::jsonb,
       encode(sha256(convert_to($19::jsonb::text,'UTF8')),'hex'),$20::jsonb,
       encode(sha256(convert_to($20::jsonb::text,'UTF8')),'hex'),
       $18::jsonb,
       encode(sha256(convert_to($18::jsonb::text,'UTF8')),'hex'),
       array[$3::uuid]::uuid[],$6::text,$5::bigint + 1::bigint,$14::uuid,clock_timestamp(),
       jsonb_build_object(
         'source','0426-normal-legacy-production-manifest',
         'aggregateManifestHash',$8::text,
         'compatibilityBefore',$18::jsonb,
         'compatibilityBeforeHash',encode(sha256(convert_to($18::jsonb::text,'UTF8')),'hex'),
         'evidenceBefore',$19::jsonb,
         'evidenceBeforeHash',encode(sha256(convert_to($19::jsonb::text,'UTF8')),'hex'),
         'compatibilityAfter',$18::jsonb,
         'compatibilityAfterHash',encode(sha256(convert_to($18::jsonb::text,'UTF8')),'hex'),
         'accountStaffIdBefore',$10,
         'accountStaffIdAfter',$10,
         'evidenceAfter',$20::jsonb,
         'evidenceAfterHash',encode(sha256(convert_to($20::jsonb::text,'UTF8')),'hex'),
         'canonicalIdsAfter',array[$3]::uuid[],
         'canonicalHashAfter',$6,
         'authorityVersionAfter',$5::bigint + 1::bigint,
         'bridgeIdAfter',$14
       )
     )`,
    [
      row.accountId,
      APPROVED_SOURCE_RUN_ID,
      row.propertyId,
      row.role,
      row.authorityVersion,
      rawHashesForTest(row.propertyId),
      sha256(''),
      NORMAL_LEGACY_MANIFEST_HASH,
      row.userId,
      fact.accountStaffId,
      fact.relationshipId,
      fact.organizationId,
      row.propertyId === 'c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f' ? 'management_company' : 'single_hotel',
      fact.bridgeId,
      fact.membershipIds,
      fact.grantIds,
      fact.staffIds,
      compatibility,
      beforeEvidence,
      afterEvidence,
    ],
  );
}

async function seedWrapperMappingFixture(pg: PGlite): Promise<void> {
  await seedProductionResidueFixture(pg);
  // Add a fourth normalized residue on a distinct account so each wrapper
  // sample maps to one immutable direct issue UUID and one disposition.
  await pg.query(`update public.properties set is_test=true where id=$1`, [PID_A2]);
  await pg.query(
    `update public.accounts set property_access=array[$2::uuid] where id=$1`,
    [ACCOUNT_ANA, PID_A2],
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='normalized',
            cutover_at=coalesce(cutover_at, now()),
            cutover_reason='Stage C wrapper mapping fixture'
      where account_id=$1`,
    [ACCOUNT_ANA],
  );
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function seedApprovedSourceTopologyFixture(pg: PGlite): Promise<void> {
  const users = [
    ['ee473197-d8f2-4a2d-86d6-314b3b6e126d', 'approved-admin@example.test'],
    ['c426b000-0000-4000-8000-000000000004', 'gus@example.test'],
    ['c426b000-0000-4000-8000-000000000005', 'greta@example.test'],
    ['c426b000-0000-4000-8000-000000000006', 'dolores@example.test'],
  ] as const;
  for (const [id, email] of users) {
    await pg.query(
      `insert into auth.users(id,email) values ($1,$2) on conflict (id) do nothing`,
      [id, email],
    );
  }

  const properties = [
    [APPROVED_SOURCE_PROPERTIES.admin, 'Approved Admin Hotel', 50],
    [APPROVED_SOURCE_PROPERTIES.testing, 'Approved Testing Hotel', 62],
    [APPROVED_SOURCE_PROPERTIES.portArthur, 'Approved Port Arthur Hotel', 74],
  ] as const;
  for (const [id, name, totalRooms] of properties) {
    await pg.query(
      `insert into public.properties(id,name,owner_id,total_rooms,timezone)
       values ($1,$2,$3,$4,'America/Chicago') on conflict (id) do nothing`,
      [id, name, 'ee473197-d8f2-4a2d-86d6-314b3b6e126d', totalRooms],
    );
    await pg.query(`update public.properties set is_test=true where id=$1`, [id]);
    await pg.query(
      `update public.organization_property_relationships
          set is_primary_grouping=false
        where property_id=$1 and ends_at is null and is_primary_grouping=true`,
      [id],
    );
    await pg.query(
      `insert into public.organization_property_relationships(
         organization_id,property_id,relationship_type,is_primary_grouping
       ) values ($1,$2,'operator',true) on conflict do nothing`,
      [ORG_A, id],
    );
  }

  const accounts = [
    [APPROVED_SOURCE_ACCOUNTS.admin, 'approved-admin', 'Approved Admin', 'admin', [APPROVED_SOURCE_PROPERTIES.admin], 'ee473197-d8f2-4a2d-86d6-314b3b6e126d'],
    [APPROVED_SOURCE_ACCOUNTS.gus, 'gus', 'Gus', 'general_manager', [APPROVED_SOURCE_PROPERTIES.testing], 'c426b000-0000-4000-8000-000000000004'],
    [APPROVED_SOURCE_ACCOUNTS.greta, 'greta', 'Greta', 'general_manager', [APPROVED_SOURCE_PROPERTIES.portArthur], 'c426b000-0000-4000-8000-000000000005'],
    [APPROVED_SOURCE_ACCOUNTS.dolores, 'dolores', 'Dolores', 'front_desk', [APPROVED_SOURCE_PROPERTIES.testing], 'c426b000-0000-4000-8000-000000000006'],
  ] as const;
  for (const [id, username, displayName, role, propertyAccess, dataUserId] of accounts) {
    await pg.query(
      `insert into public.accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,$2,'x',$3,$4,$5::uuid[],$6) on conflict (id) do nothing`,
      [id, username, displayName, role, propertyAccess, dataUserId],
    );
  }

  await pg.query(
    `select public.staxis_set_membership_hat(
       $1,$2,$3,'property','general_manager',$4,$5
     )`,
    [ACCOUNT_ADMIN, ORG_A, APPROVED_SOURCE_ACCOUNTS.gus, JSON.stringify([APPROVED_SOURCE_PROPERTIES.testing]), 'General Manager'],
  );
  await pg.query(
    `select public.staxis_set_membership_hat(
       $1,$2,$3,'property','general_manager',$4,$5
     )`,
    [ACCOUNT_ADMIN, ORG_A, APPROVED_SOURCE_ACCOUNTS.greta, JSON.stringify([APPROVED_SOURCE_PROPERTIES.portArthur]), 'General Manager'],
  );
  await pg.query(
    `select public.staxis_set_membership_hat(
       $1,$2,$3,'property','front_desk',$4,$5
     )`,
    [ACCOUNT_ADMIN, ORG_A, APPROVED_SOURCE_ACCOUNTS.dolores, JSON.stringify([APPROVED_SOURCE_PROPERTIES.testing]), 'Front Desk'],
  );
  await pg.query(
    `update public.organization_memberships
        set status='revoked', ended_at=coalesce(ended_at,now()), updated_at=now()
      where account_id=$1 and membership_scope='property'
        and $2::uuid = any(coalesce(covered_property_ids,'{}'::uuid[]))
        and status='active'`,
    [APPROVED_SOURCE_ACCOUNTS.dolores, APPROVED_SOURCE_PROPERTIES.testing],
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='legacy',cutover_at=null,
            cutover_reason='Approved 85981 source admin residue'
      where account_id=$1`,
    [APPROVED_SOURCE_ACCOUNTS.admin],
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='normalized',cutover_at=coalesce(cutover_at,now()),
            cutover_reason='Approved 85981 source normalized residue'
      where account_id = any($1::uuid[])`,
    [[APPROVED_SOURCE_ACCOUNTS.gus, APPROVED_SOURCE_ACCOUNTS.greta, APPROVED_SOURCE_ACCOUNTS.dolores]],
  );
}

async function seedApprovedProductionSourceFixture(pg: PGlite): Promise<void> {
  await seedWrapperMappingFixture(pg);
  // The shared two-company seed supplies the canonical topology used by the
  // real migration tests.  Its synthetic residue is irrelevant to the
  // production incident, so normalize and empty those controls before the
  // exact 85981 source run is installed.  The source fixture itself remains
  // the four real account/property tuples below.
  await pg.query(
    `update public.accounts
        set property_access='{}'::uuid[]
      where id = any($1::uuid[])`,
    [[ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK, ACCOUNT_ANA]],
  );
  await pg.query(
    `update public.account_authorization_state
        set authority_mode='normalized',cutover_at=coalesce(cutover_at,now()),
            cutover_reason='Approved source synthetic control cleanup'
      where account_id = any($1::uuid[])`,
    [[ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK, ACCOUNT_ANA]],
  );
  await seedApprovedSourceTopologyFixture(pg);
  const wrapperDetails = APPROVED_SOURCE_WRAPPER_DETAILS;
  await pg.query(
    `insert into public.account_access_cutover_preflight_runs(
       id,status,issue_count,created_by,completed_at,details
     ) values ($1,'failed',6,'approved-read-only-production-source',clock_timestamp(),$2::jsonb)`,
    [APPROVED_SOURCE_RUN_ID, JSON.stringify({ stage: 'A', approvedReadOnly: true })],
  );
  const issues = [
    [APPROVED_SOURCE_ISSUES.adminAccess, APPROVED_SOURCE_ACCOUNTS.admin, 'admin_legacy_access', { propertyIds: [APPROVED_SOURCE_PROPERTIES.admin] }],
    [APPROVED_SOURCE_ISSUES.adminAccount, APPROVED_SOURCE_ACCOUNTS.admin, 'admin_legacy_account', { propertyIds: [APPROVED_SOURCE_PROPERTIES.admin], authorityMode: 'legacy' }],
    [APPROVED_SOURCE_ISSUES.gus, APPROVED_SOURCE_ACCOUNTS.gus, 'normalized_legacy_residue', { propertyIds: [APPROVED_SOURCE_PROPERTIES.testing] }],
    [APPROVED_SOURCE_ISSUES.greta, APPROVED_SOURCE_ACCOUNTS.greta, 'normalized_legacy_residue', { propertyIds: [APPROVED_SOURCE_PROPERTIES.portArthur] }],
    [APPROVED_SOURCE_ISSUES.dolores, APPROVED_SOURCE_ACCOUNTS.dolores, 'normalized_legacy_residue', { propertyIds: [APPROVED_SOURCE_PROPERTIES.testing] }],
    [APPROVED_SOURCE_ISSUES.wrapper, null, 'stage_a_invariant_failure', wrapperDetails],
  ] as const;
  for (const [issueId, accountId, issueCode, details] of issues) {
    await pg.query(
      `insert into public.account_access_cutover_preflight_issues(
         id,run_id,account_id,property_id,issue_code,details
       ) values ($1,$2,$3,null,$4,$5::jsonb)`,
      [issueId, APPROVED_SOURCE_RUN_ID, accountId, issueCode, JSON.stringify(details)],
    );
  }
  await pg.query(
    `update public.account_access_cutover_status
        set last_preflight_run_id=$1
      where id is true`,
    [APPROVED_SOURCE_RUN_ID],
  );
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function seedLegacyRepairManifestPrefix(pg: PGlite): Promise<void> {
  await pg.query(
    `insert into public.account_access_cutover_preflight_runs(
       id,status,issue_count,created_by,completed_at,details
     ) values (
       '2f31759a-2cd9-48ee-a458-c0ddea0e7d93','failed',1,
       'legacy-0426-prefix',clock_timestamp(),'{}'::jsonb
     ) on conflict (id) do nothing`,
  );
  await pg.exec(`
    create table public.account_access_cutover_repair_manifests (
      issue_id uuid primary key,
      preflight_run_id uuid not null
        references public.account_access_cutover_preflight_runs(id),
      source text not null
        check (source in (
          'production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
          'test-fixture'
        )),
      issue_code text not null,
      account_id uuid,
      property_id uuid,
      raw_property_ids uuid[] not null default '{}'::uuid[],
      raw_scope_hash text not null check (raw_scope_hash ~ '^[0-9a-f]{64}$'),
      stage_a_mapping jsonb not null default '{}'::jsonb,
      status text not null default 'unconsumed'
        check (status in ('unconsumed','consumed')),
      consumed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      details jsonb not null default '{}'::jsonb,
      check (
        (source='production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93'
          and preflight_run_id='2f31759a-2cd9-48ee-a458-c0ddea0e7d93'::uuid)
        or source='test-fixture'
      )
    )
  `);
  await pg.query(
    `insert into public.account_access_cutover_repair_manifests(
       issue_id,preflight_run_id,source,issue_code,raw_property_ids,
       raw_scope_hash,details
     ) values ($1,$2,$3,'historical_legacy_prefix','{}'::uuid[],$4,$5::jsonb)`,
    [
      'c426e000-0000-4000-8000-000000000001',
      '2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
      'production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
      sha256(''),
      JSON.stringify({ historical: true, sourceRunId: '2f31759a-2cd9-48ee-a458-c0ddea0e7d93' }),
    ],
  );
}

async function seedUnsupportedResidueFixture(pg: PGlite): Promise<void> {
  await seedProductionResidueFixture(pg);
  await pg.query(`update public.properties set is_test=true where id=$1`, [PID_L1]);
  await pg.query(`update public.accounts set property_access=array[$2::uuid] where id=$1`, [ACCOUNT_HANK, PID_L1]);
  await pg.query(`delete from public.account_access_cutover_legacy_write_events`);
}

async function recordAllProductionResidueDispositions(
  pg: PGlite,
  options: { deployedDescendantSha?: string; accessBMergeSha?: string } = {},
): Promise<string> {
  const runId = (await rows<{ final_preflight_run_id: string }>(
    pg,
    `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
  ))[0].final_preflight_run_id;
  const states = await rows<{
    account_id: string;
    authority_mode: string;
    authority_version: number;
  }>(
    pg,
    `select account_id,authority_mode,authority_version
       from public.account_authorization_state
      where account_id in ($1,$2,$3)
      order by account_id`,
    [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK],
  );
  const byAccount = new Map(states.map((state) => [state.account_id, state]));
  const mariaCanonicalIds = (await rows<{ property_id: string }>(
    pg,
    `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
    [ACCOUNT_MARIA],
  )).map((row) => row.property_id);
  const frankCanonicalIds = (await rows<{ property_id: string }>(
    pg,
    `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
    [ACCOUNT_FRANK],
  )).map((row) => row.property_id);
  await recordRepairDisposition(pg, {
    preflightRunId: runId,
    accountId: ACCOUNT_ADMIN,
    propertyId: PID_A1,
    issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
    decision: 'admin_global',
    deployedDescendantSha: options.deployedDescendantSha,
    accessBMergeSha: options.accessBMergeSha,
    rawPropertyIds: [PID_A1],
    canonicalPropertyIds: [],
    authorityMode: byAccount.get(ACCOUNT_ADMIN)?.authority_mode ?? '',
    authorityVersion: byAccount.get(ACCOUNT_ADMIN)?.authority_version ?? 0,
    reason: 'admin_global_role_residue',
  });
  await recordRepairDisposition(pg, {
    preflightRunId: runId,
    accountId: ACCOUNT_MARIA,
    propertyId: PID_A1,
    issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
    decision: 'canonical_duplicate',
    deployedDescendantSha: options.deployedDescendantSha,
    accessBMergeSha: options.accessBMergeSha,
    rawPropertyIds: [PID_A1],
    canonicalPropertyIds: mariaCanonicalIds,
    authorityMode: byAccount.get(ACCOUNT_MARIA)?.authority_mode ?? '',
    authorityVersion: byAccount.get(ACCOUNT_MARIA)?.authority_version ?? 0,
    reason: 'canonical_duplicate_residue',
  });
  await recordRepairDisposition(pg, {
    preflightRunId: runId,
    accountId: ACCOUNT_FRANK,
    propertyId: PID_A1,
    issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
    decision: 'revoked_canonical_empty',
    deployedDescendantSha: options.deployedDescendantSha,
    accessBMergeSha: options.accessBMergeSha,
    rawPropertyIds: [PID_A1],
    canonicalPropertyIds: frankCanonicalIds,
    authorityMode: byAccount.get(ACCOUNT_FRANK)?.authority_mode ?? '',
    authorityVersion: byAccount.get(ACCOUNT_FRANK)?.authority_version ?? 0,
    reason: 'revoked_canonical_empty_residue',
  });
  return runId;
}

async function recordApprovedSourceDispositions(pg: PGlite): Promise<string> {
  const runId = (await rows<{ final_preflight_run_id: string }>(
    pg,
    `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
  ))[0].final_preflight_run_id;
  assert.equal(runId, APPROVED_SOURCE_RUN_ID);
  const states = await rows<{
    account_id: string;
    authority_mode: string;
    authority_version: number;
  }>(
    pg,
    `select account_id,authority_mode,authority_version
       from public.account_authorization_state
      where account_id = any($1::uuid[])
      order by account_id`,
    [[
      APPROVED_SOURCE_ACCOUNTS.admin,
      APPROVED_SOURCE_ACCOUNTS.gus,
      APPROVED_SOURCE_ACCOUNTS.greta,
      APPROVED_SOURCE_ACCOUNTS.dolores,
    ]],
  );
  const byAccount = new Map(states.map((state) => [state.account_id, state]));
  const canonicalIds = async (accountId: string): Promise<string[]> => (await rows<{ property_id: string }>(
    pg,
    `select distinct property_id
       from public._staxis_account_property_authorizations($1)
      order by property_id`,
    [accountId],
  )).map((row) => row.property_id);
  const dispositions = [
    {
      accountId: APPROVED_SOURCE_ACCOUNTS.admin,
      propertyId: APPROVED_SOURCE_PROPERTIES.admin,
      issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
      issueIds: [APPROVED_SOURCE_ISSUES.adminAccess, APPROVED_SOURCE_ISSUES.adminAccount, APPROVED_SOURCE_ISSUES.wrapper],
      decision: 'admin_global',
      canonicalPropertyIds: [] as string[],
      reason: 'admin_global_role_residue',
    },
    {
      accountId: APPROVED_SOURCE_ACCOUNTS.gus,
      propertyId: APPROVED_SOURCE_PROPERTIES.testing,
      issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
      issueIds: [APPROVED_SOURCE_ISSUES.gus, APPROVED_SOURCE_ISSUES.wrapper],
      decision: 'canonical_duplicate',
      canonicalPropertyIds: await canonicalIds(APPROVED_SOURCE_ACCOUNTS.gus),
      reason: 'canonical_duplicate_residue',
    },
    {
      accountId: APPROVED_SOURCE_ACCOUNTS.greta,
      propertyId: APPROVED_SOURCE_PROPERTIES.portArthur,
      issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
      issueIds: [APPROVED_SOURCE_ISSUES.greta, APPROVED_SOURCE_ISSUES.wrapper],
      decision: 'canonical_duplicate',
      canonicalPropertyIds: await canonicalIds(APPROVED_SOURCE_ACCOUNTS.greta),
      reason: 'canonical_duplicate_residue',
    },
    {
      accountId: APPROVED_SOURCE_ACCOUNTS.dolores,
      propertyId: APPROVED_SOURCE_PROPERTIES.testing,
      issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
      issueIds: [APPROVED_SOURCE_ISSUES.dolores, APPROVED_SOURCE_ISSUES.wrapper],
      decision: 'revoked_canonical_empty',
      canonicalPropertyIds: await canonicalIds(APPROVED_SOURCE_ACCOUNTS.dolores),
      reason: 'revoked_canonical_empty_residue',
    },
  ] as const;
  for (const disposition of dispositions) {
    const state = byAccount.get(disposition.accountId);
    assert.ok(state, `missing source state for ${disposition.accountId}`);
    await recordRepairDisposition(pg, {
      preflightRunId: runId,
      ...disposition,
      authorityMode: state.authority_mode,
      authorityVersion: state.authority_version,
      rawPropertyIds: [disposition.propertyId],
    });
  }
  return runId;
}

async function insertCanonicalAccount(
  pg: PGlite,
  accountId: string,
  userId: string,
  username: string,
  displayName: string,
  role: string,
  email: string,
): Promise<void> {
  await pg.query(`insert into auth.users(id,email) values ($1,$2)`, [userId, email]);
  await pg.query(
    `insert into public.accounts(
       id, username, password_hash, display_name, role, data_user_id
     ) values ($1,$3,'x',$4,$5,$2)`,
    [accountId, userId, username, displayName, role],
  );
}

async function insertStaff(
  pg: PGlite,
  id: string,
  propertyId: string,
  name: string,
  department: string,
  phone: string,
): Promise<void> {
  await pg.query(
    `insert into public.staff(
       id, property_id, name, phone, phone_lookup, language, is_senior,
       department, scheduled_today, weekly_hours, max_weekly_hours,
       max_days_per_week, days_worked_this_week, is_active
     ) values ($1,$2,$3,$4,$5,'en',false,$6,false,0,40,5,0,true)`,
    [id, propertyId, name, phone, phone.replace(/\D/g, '').slice(-10), department],
  );
}

async function propertyIds(pg: PGlite, accountId: string): Promise<string[]> {
  const result = await jsonRpc(
    pg,
    `select public.staxis_list_account_authorized_properties($1) as value`,
    [accountId],
  );
  return (result.propertyIds as string[] | undefined) ?? [];
}

async function recordRepairDisposition(
  pg: PGlite,
  values: {
    preflightRunId: string;
    accountId: string;
    propertyId: string;
    issueCodes: readonly string[];
    issueIds?: readonly string[];
    decision: string;
    operatorLabel?: string;
    accessBMergeSha?: string;
    deployedDescendantSha?: string;
    dispositionId?: string;
    rawPropertyIds: string[];
    rawScopeHash?: string;
    canonicalPropertyIds: string[];
    canonicalScopeHash?: string;
    authorityMode: string;
    authorityVersion: number;
    reason: string;
  },
): Promise<Record<string, unknown>> {
  const manifestCount = (await rows<{ count: number }>(
    pg,
    `select count(*)::integer as count
       from public.account_access_cutover_repair_manifests
      where preflight_run_id=$1`,
    [values.preflightRunId],
  ))[0]?.count ?? 0;
  if (manifestCount === 0) {
    const issueRows = await rows<{
      id: string;
      issue_code: string;
      account_id: string | null;
      property_id: string | null;
      details: Record<string, unknown>;
    }>(
      pg,
      `select id,issue_code,account_id,property_id,details
         from public.account_access_cutover_preflight_issues
        where run_id=$1 order by id`,
      [values.preflightRunId],
    );
    for (const issue of issueRows) {
      const propertyIds = Array.isArray(issue.details.propertyIds)
        ? issue.details.propertyIds.filter((value): value is string => typeof value === 'string')
        : [];
      const manifestPropertyId = issue.property_id ?? (propertyIds.length === 1 ? propertyIds[0] : null);
      await pg.query(
        `insert into public.account_access_cutover_repair_manifests(
           issue_id,preflight_run_id,source,issue_code,account_id,property_id,
           raw_property_ids,raw_scope_hash,stage_a_mapping,details
         ) values (
           $1,$2,'test-fixture',$3,$4,$5,$6::uuid[],
           public._staxis_stage_c_scope_hash($6::uuid[]),
           case when $3='stage_a_invariant_failure'
             then coalesce($7::jsonb #> '{stageAInvariant,sample}','[]'::jsonb)
             else '{}'::jsonb end,
           $7::jsonb
         ) on conflict (issue_id) do nothing`,
        [
          issue.id,
          values.preflightRunId,
          issue.issue_code,
          issue.account_id,
          manifestPropertyId,
          propertyIds,
          issue.details,
        ],
      );
    }
  }
  const operatorLabel = values.operatorLabel ?? 'production-residue-operator';
  const accessBMergeSha = values.accessBMergeSha ?? ACCESS_B_LIVE_SHA;
  const deployedDescendantSha = values.deployedDescendantSha ?? CURRENT_LIVE_DESCENDANT_SHA;
  const issueIds = values.issueIds ?? (await rows<{ issue_id: string; issue_code: string }>(
    pg,
    `select issue_id,issue_code
       from public.account_access_cutover_repair_manifests
      where preflight_run_id=$1
        and (
          issue_code='stage_a_invariant_failure'
          or (account_id=$2 and (property_id=$3 or property_id is null)
              and issue_code = any($4::text[]))
        )
      order by issue_code,issue_id`,
    [values.preflightRunId, values.accountId, values.propertyId, values.issueCodes],
    )).map((row) => row.issue_id);
  return jsonRpc(
    pg,
    `select public.staxis_access_stage_c_record_repair_disposition(
       $1,$2,$3,$4::text[],$5::uuid[],$6,$7,$8,$9,$10::uuid[],$11,$12,
       $13,$14::uuid[],$15,$16,$17,clock_timestamp(),$18
     ) as value`,
    [
      values.preflightRunId,
      values.accountId,
      values.propertyId,
      values.issueCodes,
      issueIds,
      values.decision,
      operatorLabel,
      accessBMergeSha,
      deployedDescendantSha,
      values.rawPropertyIds,
      values.rawScopeHash ?? sha256(values.rawPropertyIds.slice().sort().join(',')),
      values.authorityMode,
      values.authorityVersion,
      values.canonicalPropertyIds,
      values.canonicalScopeHash ?? sha256(values.canonicalPropertyIds.slice().sort().join(',')),
      0,
      values.reason,
      values.dispositionId ?? null,
    ],
  );
}

describe('Access Stage C final contract — real migration boundary', () => {
  describe('clean cutover and canonical runtime operations', () => {
    let pg: PGlite;
    let sharedDataDir: string;
    let report: { applied: string[]; failedAtRuntime: Array<{ file: string; error: string }> };

    before(async () => {
      sharedDataDir = mkdtempSync(join(tmpdir(), 'staxis-access-stage-c-'));
      const migrated = await applyMigrationsToPgliteWithHook(
        async ({ pg: hookPg, file }) => {
          if (file === MIGRATION) await seedStageCFixture(hookPg);
        },
        {
          dataDir: sharedDataDir,
          afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
            if (file === MIGRATION) await authorizeAccessStageCRelease(hookPg);
          },
        },
      );
      pg = migrated.pg;
      report = migrated.report;
      assert.ok(
        report.applied.includes(MIGRATION),
        JSON.stringify(report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      assert.deepEqual(
        report.failedAtRuntime.filter((entry) => entry.file === MIGRATION),
        [],
      );
    });

    after(async () => {
      await pg?.close();
      if (sharedDataDir) rmSync(sharedDataDir, { recursive: true, force: true });
    });

    test('rejects every self-target scope mutation before state, bridges, or audit can change', async () => {
      const before = (await rows<{
        role: string;
        property_access: string[];
        authority_mode: string;
        authority_version: number;
        updated_at: string;
      }>(
        pg,
        `select account.role,account.property_access,state.authority_mode,
                state.authority_version,account.updated_at::text as updated_at
           from public.accounts account
           join public.account_authorization_state state on state.account_id=account.id
          where account.id=$1`,
        [ACCOUNT_ADMIN],
      ))[0];
      const bridgeCountBefore = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.account_property_authorization_bridges where account_id=$1`,
        [ACCOUNT_ADMIN],
      ))[0].count);
      const auditCountBefore = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.admin_audit_log
          where target_type='account' and target_id=$1`,
        [ACCOUNT_ADMIN],
      ))[0].count);
      assert.ok(before);

      for (const newRole of ['staff', 'admin']) {
        const result = await jsonRpc(
          pg,
          `select public.staxis_set_account_authorization_scope(
             $1,$1,'{}'::uuid[],$2,$3,$4,'Stage C self-target guard'
           ) as value`,
          [ACCOUNT_ADMIN, before.authority_version, before.role, newRole],
        );
        assert.deepEqual(result, { ok: false, status: 'forbidden', reason: 'self' });
      }
      const selfNoop = await jsonRpc(
        pg,
        `select public.staxis_set_account_authorization_scope(
           $1,$1,'{}'::uuid[],$2,$3,$3,'Stage C self-target no-op guard'
         ) as value`,
        [ACCOUNT_ADMIN, before.authority_version, before.role],
      );
      assert.deepEqual(selfNoop, { ok: false, status: 'forbidden', reason: 'self' });

      assert.deepEqual(
        (await rows<{
          role: string;
          property_access: string[];
          authority_mode: string;
          authority_version: number;
          updated_at: string;
        }>(
          pg,
          `select account.role,account.property_access,state.authority_mode,
                  state.authority_version,account.updated_at::text as updated_at
             from public.accounts account
             join public.account_authorization_state state on state.account_id=account.id
            where account.id=$1`,
          [ACCOUNT_ADMIN],
        ))[0],
        before,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.account_property_authorization_bridges where account_id=$1`,
          [ACCOUNT_ADMIN],
        ))[0].count),
        bridgeCountBefore,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.admin_audit_log
            where target_type='account' and target_id=$1`,
          [ACCOUNT_ADMIN],
        ))[0].count),
        auditCountBefore,
      );

      const target = (await rows<{
        role: string;
        authority_version: number;
        property_ids: string[];
      }>(
        pg,
        `select account.role,state.authority_version,
                coalesce(array_agg(authz.property_id order by authz.property_id)
                  filter (where authz.property_id is not null), '{}'::uuid[]) as property_ids
           from public.accounts account
           join public.account_authorization_state state on state.account_id=account.id
           left join lateral public._staxis_account_property_authorizations(account.id) authz on true
          where account.id=$1
          group by account.role,state.authority_version`,
        [ACCOUNT_HANK],
      ))[0];
      assert.ok(target);
      const updated = await jsonRpc(
        pg,
        `select public.staxis_set_account_authorization_scope(
           $1,$2,$3::uuid[],$4,$5,$6,'Stage C authorized other-account update'
         ) as value`,
        [ACCOUNT_ADMIN, ACCOUNT_HANK, target.property_ids, target.authority_version, target.role, 'maintenance'],
      );
      assert.equal(updated.ok, true);
      assert.equal(updated.status, 'updated');
      const restoredVersion = updated.authorityVersion as number;
      const restored = await jsonRpc(
        pg,
        `select public.staxis_set_account_authorization_scope(
           $1,$2,$3::uuid[],$4,$5,$6,'Stage C authorized other-account restore'
         ) as value`,
        [ACCOUNT_ADMIN, ACCOUNT_HANK, target.property_ids, restoredVersion, 'maintenance', target.role],
      );
      assert.equal(restored.ok, true);
      assert.equal(restored.status, 'updated');
    });

    test('proves the external 0425 prerequisite, final inventory, receipts, ACLs, RLS, and raw-writer retirement', async () => {
      const applied = await rows<MigrationRow>(
        pg,
        `select version, description from public.applied_migrations where version in ('0425','0426') order by version`,
      );
      assert.deepEqual(applied, [
        { version: '0425', description: LIVE_0425_DESCRIPTION },
        {
          version: '0426',
          description: 'Access Stage C canonical-only contract, final receipts, array teardown, and fail-closed enforcement',
        },
      ]);
      assert.equal(
        await rows<{ stage: string; enforcement_enabled: boolean; details: Record<string, unknown> }>(
          pg,
          `select stage, enforcement_enabled, details
             from public.account_access_cutover_status where id is true`,
        ).then(([row]) => row.stage),
        'C',
      );
      const status = (await rows<{ enforcement_enabled: boolean; details: Record<string, unknown> }>(
        pg,
        `select enforcement_enabled, details from public.account_access_cutover_status where id is true`,
      ))[0];
      assert.equal(status.enforcement_enabled, true);
      assert.equal(status.details.legacyArraysCleared, true);
      assert.equal(status.details.legacyTranslatorRetired, true);
      assert.equal(status.details.legacyImportRetired, true);
      const stageAInvariant = await rows<{ issue_count: number }>(
          pg,
          `select issue_count from public.account_access_cutover_invariant_runs
            where status = 'passed' order by checked_at desc limit 1`,
        );
      assert.ok(stageAInvariant[0], 'Stage A invariant evidence must be retained through the final cutover');
      assert.equal(
        stageAInvariant[0].issue_count,
        0,
      );

      const releaseReceipts = await rows<{
        id: string;
        operator_label: string;
        access_b_merge_sha: string;
        deployed_descendant_sha: string;
        attested_at: string;
        preflight_run_id: string;
        old_deployment_job: string;
        old_deployment_fence_evidence: string;
        old_deployment_fence_hash: string;
        old_deployment_fence_nonce: string;
        authorization_hash: string;
        status: string;
        consumed_at: string | null;
        consumed_session_id: string | null;
        consumed_preflight_run_id: string | null;
      }>(
        pg,
        `select id,operator_label,access_b_merge_sha,deployed_descendant_sha,
                attested_at,preflight_run_id,old_deployment_job,
                old_deployment_fence_evidence,old_deployment_fence_hash,
                old_deployment_fence_nonce,authorization_hash,status,consumed_at,
                consumed_session_id,consumed_preflight_run_id
           from public.account_access_cutover_release_receipts
          order by created_at`,
      );
      assert.equal(releaseReceipts.length, 1);
      const releaseReceipt = releaseReceipts[0];
      assert.equal(releaseReceipt.operator_label, 'pglite-stage-c-operator');
      assert.equal(releaseReceipt.access_b_merge_sha, 'ec83bca6dab74a52dfb251d04be11d5c7427703f');
      assert.equal(releaseReceipt.deployed_descendant_sha, '442fb98d632521ea33346d5c8a97014248a31fa0');
      assert.ok(releaseReceipt.attested_at);
      assert.equal(releaseReceipt.preflight_run_id, status.details.preflightRunId);
      assert.equal(releaseReceipt.old_deployment_job, 'pglite-access-stage-c-test');
      assert.equal(releaseReceipt.old_deployment_fence_hash, sha256(releaseReceipt.old_deployment_fence_evidence));
      assert.equal(releaseReceipt.authorization_hash, sha256('pglite-access-stage-c-release-token'));
      assert.equal(releaseReceipt.status, 'consumed');
      assert.ok(releaseReceipt.consumed_at);
      assert.ok(releaseReceipt.consumed_session_id);
      assert.equal(releaseReceipt.consumed_preflight_run_id, releaseReceipt.preflight_run_id);

      const finalReceiptRows = await rows<{
        account_id: string;
        source_property_ids: string[];
        source_property_count: number;
        source_scope_hash: string;
        canonical_property_ids: string[];
        canonical_property_count: number;
        bridge_count: number;
      }>(
        pg,
        `select account_id,source_property_ids,source_property_count,source_scope_hash,
                canonical_property_ids,canonical_property_count,bridge_count
           from public.account_access_cutover_final_receipts
          order by account_id`,
      );
      assert.ok(finalReceiptRows.length > 0);
      for (const finalReceipt of finalReceiptRows) {
        assert.equal(finalReceipt.source_property_count, finalReceipt.source_property_ids.length);
        assert.equal(finalReceipt.canonical_property_count, finalReceipt.canonical_property_ids.length);
        assert.match(finalReceipt.source_scope_hash, /^[0-9a-f]{64}$/);
        assert.equal(finalReceipt.source_scope_hash, sha256(finalReceipt.source_property_ids.join(',')));
        assert.ok(finalReceipt.bridge_count >= 0);
      }
      const finalReceiptDigest = sha256(
        finalReceiptRows
          .map((receipt) => `${receipt.account_id}:${receipt.source_scope_hash}`)
          .join('|'),
      );
      assert.equal(
        sha256(
          (await rows<{ account_id: string; source_scope_hash: string }>(
            pg,
            `select account_id,source_scope_hash
               from public.account_access_cutover_final_receipts
              order by account_id`,
          )).map((receipt) => `${receipt.account_id}:${receipt.source_scope_hash}`).join('|'),
        ),
        finalReceiptDigest,
      );
      assert.equal(Number(status.details.finalReceipts), finalReceiptRows.length);
      assert.deepEqual(
        (await rows<{ dispositions: number; repairs: number }>(
          pg,
          `select
             (select count(*)::integer from public.account_access_cutover_repair_dispositions) as dispositions,
             (select count(*)::integer from public.account_access_cutover_repair_receipts) as repairs`,
        ))[0],
        { dispositions: 0, repairs: 0 },
        'clean preflight must not create repair dispositions or repair receipts',
      );

      const raw = await rows<{ non_empty: number; null_count: number }>(
        pg,
        `select count(*) filter (where cardinality(coalesce(property_access,'{}'::uuid[])) > 0)::integer as non_empty,
                count(*) filter (where property_access is null)::integer as null_count
           from public.accounts`,
      );
      assert.deepEqual(raw[0], { non_empty: 0, null_count: 0 });
      const finalEvidence = (await rows<{ details: Record<string, unknown> }>(
        pg,
        `select details from public.account_access_cutover_final_receipts
          order by account_id limit 1`,
      ))[0]?.details;
      assert.ok(finalEvidence?.evidenceBefore, 'final receipt must retain before identity/topology evidence');
      assert.ok(finalEvidence?.evidenceAfter, 'final receipt must retain after identity/topology evidence');
      assert.match(String(finalEvidence?.evidenceBeforeHash), /^[0-9a-f]{64}$/);
      assert.match(String(finalEvidence?.evidenceAfterHash), /^[0-9a-f]{64}$/);

      const producerFenceTables = await rows<{ table_name: string; trigger_name: string }>(
        pg,
        `select trigger_relation.relname as table_name, trigger_row.tgname as trigger_name
           from pg_trigger trigger_row
           join pg_class trigger_relation on trigger_relation.oid=trigger_row.tgrelid
           join pg_namespace trigger_schema on trigger_schema.oid=trigger_relation.relnamespace
          where trigger_schema.nspname='public'
            and not trigger_row.tgisinternal
            and trigger_row.tgname like '%000_stage_c_producer%'
          order by table_name`,
      );
      assert.deepEqual(
        producerFenceTables.map((row) => row.table_name),
        [
          'account_access_cutover_legacy_write_events',
          'account_invites',
          'account_lifecycle_intents',
          'accounts',
          'join_requests',
          'organization_access_requests',
          'organization_invitations',
        ],
        'every pending-operation and legacy-evidence producer must share the cutover fence',
      );
      const rawColumnPrivilege = (await rows<{ service_update: boolean; service_username_update: boolean }>(
        pg,
        `select has_column_privilege('service_role','public.accounts','property_access','UPDATE') as service_update,
                has_column_privilege('service_role','public.accounts','username','UPDATE') as service_username_update`,
      ))[0];
      assert.deepEqual(rawColumnPrivilege, { service_update: false, service_username_update: false });
      await assert.rejects(
        pg.exec(`begin; set local role service_role;
          select set_config('staxis.access_stage_c_repair_disposition_id','00000000-0000-0000-0000-000000000001',true);
          update public.accounts set property_access='{}'::uuid[] where id='${ACCOUNT_ADMIN}';`),
        /permission denied|final access contract rejects|property_access/i,
      );
      await pg.exec('rollback;').catch(() => undefined);

      for (const signature of [
        'public.staxis_grant_property_access(uuid,uuid)',
        'public.staxis_remove_property_access(uuid,uuid)',
        'public.staxis_remove_property_access_guarded(uuid,uuid,text,timestamptz)',
        'public.staxis_remove_property_access_guarded_v2(uuid,uuid,text,uuid,uuid,text,timestamptz,text)',
        'public._staxis_stage_b_import_legacy_scope(uuid,text)',
        'public.staxis_translate_legacy_property_access(uuid,uuid[],text)',
        'public._staxis_reconcile_property_trigger()',
        'public._staxis_reconcile_account_trigger()',
        'public._staxis_reconcile_legacy_organization_access(uuid,uuid)',
        'public.staxis_reconcile_legacy_organization_access(uuid,uuid)',
      ]) {
        assert.equal(
          (await rows<{ present: string | null }>(
            pg,
            `select to_regprocedure($1) as present`,
            [signature],
          ))[0].present,
          null,
          `${signature} must be retired after final enforcement`,
        );
      }
      await assert.rejects(
        pg.query(`select public.staxis_grant_property_access($1,$2)`, [ACCOUNT_ADMIN, PID_L1]),
        /function public\.staxis_grant_property_access\(.*does not exist/i,
        'a direct obsolete grant RPC must fail closed after the final cutover',
      );
      for (const signature of [
        'public.staxis_accept_account_invite(text,uuid,uuid,text,text)',
        'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)',
        'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)',
        'public.staxis_finalize_join_code_signup(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)',
      ]) {
        assert.notEqual(
          (await rows<{ present: string | null }>(pg, `select to_regprocedure($1) as present`, [signature]))[0].present,
          null,
          `${signature} must remain available to runtime flows`,
        );
      }
      const triggerNames = await rows<{ tgname: string }>(
        pg,
        `select tgname from pg_trigger
          where tgrelid = 'public.accounts'::regclass and not tgisinternal`,
      );
      assert.ok(triggerNames.some(({ tgname }) => tgname.includes('final_legacy_property_access_fence')));
      assert.equal(
        await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count from pg_trigger
            where tgrelid = 'public.accounts'::regclass
              and not tgisinternal
              and tgname ilike '%translate%legacy%'`,
        ).then(([row]) => Number(row.count)),
        0,
      );
      const propertyTriggerNames = await rows<{ tgname: string }>(
        pg,
        `select tgname from pg_trigger
          where tgrelid = 'public.properties'::regclass and not tgisinternal`,
      );
      assert.ok(propertyTriggerNames.some(({ tgname }) => tgname === 'trg_properties_ensure_canonical_property_topology'));
      assert.ok(!propertyTriggerNames.some(({ tgname }) => tgname === 'trg_properties_reconcile_legacy_organization_access'));

      const rawReaders = await rows<{ proname: string; identity: string }>(
        pg,
        `select routine.proname, pg_get_function_identity_arguments(routine.oid) as identity
          from pg_proc routine
           join pg_namespace namespace on namespace.oid = routine.pronamespace
          where namespace.nspname = 'public'
            and regexp_replace(routine.prosrc, '--[^\\n]*', '', 'g')
                  ~* '[[:alnum:]_]+[[:space:]]*[.][[:space:]]*property_access'`,
      );
      assert.deepEqual(
        rawReaders.map((row) => `${row.proname}(${row.identity})`).sort(),
        [
          '_staxis_reject_final_legacy_property_access_write()',
          'staxis_bootstrap_canonical_admin_authority(p_account_id uuid, p_property_ids uuid[], p_expected_authority_version bigint, p_reason text)',
          'staxis_preflight_authorization_cutover_stage_c()',
        ],
        'only the final fence and report-only preflight may inspect the retired column',
      );
      assert.deepEqual(
        await rows<{ table_name: string; policy_name: string }>(
          pg,
          `select schemaname || '.' || tablename as table_name, policyname as policy_name
             from pg_policies
            where schemaname = 'public'
              and (coalesce(qual,'') || ' ' || coalesce(with_check,''))
                    ~* '[[:alnum:]_]+[.]property_access'`,
        ),
        [],
        'active RLS policies must not read the retired property_access authority',
      );
      assert.deepEqual(
        await rows<{ view_name: string }>(
          pg,
          `select schemaname || '.' || viewname as view_name
             from pg_views
            where schemaname = 'public'
              and definition ~* '[[:alnum:]_]+[.]property_access'`,
        ),
        [],
        'active views must not read the retired property_access authority',
      );

      const receiptShape = (await rows<{ has_fk: boolean; rls: boolean; policy_qual: string }>(
        pg,
        `select exists (
                  select 1 from pg_constraint constraint_row
                   where constraint_row.conrelid = 'public.account_access_cutover_final_receipts'::regclass
                     and constraint_row.contype = 'f'
                     and constraint_row.confrelid = 'public.accounts'::regclass
                ) as has_fk,
                relation.relrowsecurity as rls,
                coalesce(policy.qual::text,'') as policy_qual
           from pg_class relation
           left join pg_policies policy
             on policy.schemaname = 'public'
            and policy.tablename = 'account_access_cutover_final_receipts'
          where relation.oid = 'public.account_access_cutover_final_receipts'::regclass`,
      ))[0];
      assert.deepEqual(receiptShape, { has_fk: false, rls: true, policy_qual: 'false' });
      const receiptAcl = (await rows<{ anon_select: boolean; service_select: boolean; service_execute: boolean; anon_execute: boolean; search_path: string[] | null }>(
        pg,
        `select has_table_privilege('anon','public.account_access_cutover_final_receipts','select') as anon_select,
                has_table_privilege('service_role','public.account_access_cutover_final_receipts','select') as service_select,
                has_function_privilege('service_role','public.staxis_access_stage_c_final_receipt(uuid)','execute') as service_execute,
                has_function_privilege('anon','public.staxis_access_stage_c_final_receipt(uuid)','execute') as anon_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid = 'public.staxis_access_stage_c_final_receipt(uuid)'::regprocedure`,
      ))[0];
      assert.equal(receiptAcl.anon_select, false);
      assert.equal(receiptAcl.service_select, false);
      assert.equal(receiptAcl.service_execute, true);
      assert.equal(receiptAcl.anon_execute, false);
      assert.ok(receiptAcl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));

      const releaseShape = (await rows<{
        rls: boolean;
        policy_qual: string;
        anon_select: boolean;
        authenticated_select: boolean;
        service_select: boolean;
      }>(
        pg,
        `select relation.relrowsecurity as rls,
                coalesce(policy.qual::text,'') as policy_qual,
                has_table_privilege('anon','public.account_access_cutover_release_receipts','select') as anon_select,
                has_table_privilege('authenticated','public.account_access_cutover_release_receipts','select') as authenticated_select,
                has_table_privilege('service_role','public.account_access_cutover_release_receipts','select') as service_select
           from pg_class relation
           left join pg_policies policy
             on policy.schemaname='public'
            and policy.tablename='account_access_cutover_release_receipts'
          where relation.oid='public.account_access_cutover_release_receipts'::regclass`,
      ))[0];
      assert.deepEqual(releaseShape, {
        rls: true,
        policy_qual: 'false',
        anon_select: false,
        authenticated_select: false,
        service_select: true,
      });
      const releaseAcl = await rows<{
        identity: string;
        service_execute: boolean;
        anon_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select pg_get_function_identity_arguments(routine.oid) as identity,
                has_function_privilege('service_role',routine.oid,'execute') as service_execute,
                has_function_privilege('anon',routine.oid,'execute') as anon_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid = any(array[
            'public.staxis_access_stage_c_record_release_receipt(text,text,text,timestamptz,uuid,text,text,text,text,text,uuid)'::regprocedure,
            'public.staxis_access_stage_c_release_receipt(uuid)'::regprocedure,
            'public.staxis_access_stage_c_consume_release()'::regprocedure
          ])
          order by routine.oid`,
      );
      assert.equal(releaseAcl.length, 3);
      for (const acl of releaseAcl) {
        assert.equal(acl.service_execute, true, acl.identity);
        assert.equal(acl.anon_execute, false, acl.identity);
        assert.ok(acl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));
      }
      const repairAcl = await rows<{
        table_name: string;
        rls: boolean;
        policy_qual: string;
        anon_select: boolean;
        service_select: boolean;
        service_insert: boolean;
      }>(
        pg,
        `select relation.relname as table_name,
                relation.relrowsecurity as rls,
                coalesce(policy.qual::text,'') as policy_qual,
                has_table_privilege('anon',relation.oid,'select') as anon_select,
                has_table_privilege('service_role',relation.oid,'select') as service_select,
                has_table_privilege('service_role',relation.oid,'insert') as service_insert
           from pg_class relation
           left join pg_policies policy
             on policy.schemaname='public'
            and policy.tablename=relation.relname
          where relation.oid in (
            'public.account_access_cutover_repair_dispositions'::regclass,
            'public.account_access_cutover_repair_receipts'::regclass
          )
          order by relation.relname`,
      );
      assert.deepEqual(repairAcl, [
        {
          table_name: 'account_access_cutover_repair_dispositions',
          rls: true,
          policy_qual: 'false',
          anon_select: false,
          service_select: true,
          service_insert: false,
        },
        {
          table_name: 'account_access_cutover_repair_receipts',
          rls: true,
          policy_qual: 'false',
          anon_select: false,
          service_select: true,
          service_insert: false,
        },
      ]);
      const repairEvidenceAcl = (await rows<{
        service_execute: boolean;
        anon_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select has_function_privilege('service_role','public.staxis_access_stage_c_repair_evidence(uuid)','execute') as service_execute,
                has_function_privilege('anon','public.staxis_access_stage_c_repair_evidence(uuid)','execute') as anon_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid='public.staxis_access_stage_c_repair_evidence(uuid)'::regprocedure`,
      ))[0];
      assert.deepEqual({
        service_execute: repairEvidenceAcl.service_execute,
        anon_execute: repairEvidenceAcl.anon_execute,
      }, { service_execute: true, anon_execute: false });
      assert.ok(repairEvidenceAcl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));
      assert.equal(
        (await rows<{ present: string | null }>(
          pg,
          `select to_regprocedure($1) as present`,
          ['public.staxis_access_stage_c_record_repair_disposition(uuid,uuid,uuid,text[],uuid[],text,text,text,text,uuid[],text,text,bigint,uuid[],text,bigint,text,timestamptz,uuid)'],
        ))[0].present,
        null,
        'the operator disposition writer must retire after the final suffix',
      );
      const releaseRead = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_release_receipt($1) as value`,
        [releaseReceipt.id],
      );
      assert.equal(releaseRead.id, releaseReceipt.id);
      assert.equal(releaseRead.status, 'consumed');
      await assert.rejects(
        pg.query(
          `update public.account_access_cutover_release_receipts
              set operator_label='tampered' where id=$1`,
          [releaseReceipt.id],
        ),
        /immutable after consumption/i,
      );

      const recoveryAcl = (await rows<{ service_execute: boolean; anon_execute: boolean; service_select: boolean; anon_select: boolean }>(
        pg,
        `select has_function_privilege('service_role','public.staxis_access_stage_c_freeze_and_forward(text,text,uuid)','execute') as service_execute,
                has_function_privilege('anon','public.staxis_access_stage_c_freeze_and_forward(text,text,uuid)','execute') as anon_execute,
                has_table_privilege('service_role','public.account_access_cutover_recovery_actions','select') as service_select,
                has_table_privilege('anon','public.account_access_cutover_recovery_actions','select') as anon_select`,
      ))[0];
      assert.deepEqual(recoveryAcl, {
        service_execute: true,
        anon_execute: false,
        service_select: true,
        anon_select: false,
      });

      const canonicalAcl = await rows<{
        identity: string;
        service_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select pg_get_function_identity_arguments(routine.oid) as identity,
                has_function_privilege('service_role', routine.oid, 'execute') as service_execute,
                has_function_privilege('anon', routine.oid, 'execute') as anon_execute,
                has_function_privilege('authenticated', routine.oid, 'execute') as authenticated_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid = any(array[
            'public.staxis_delete_property_and_legacy_accounts(uuid,uuid,text)'::regprocedure,
            'public.staxis_accept_account_invite(text,uuid,uuid,text,text)'::regprocedure,
            'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)'::regprocedure,
            'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)'::regprocedure,
            'public.staxis_finalize_join_code_signup(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)'::regprocedure,
            'public.staxis_remove_property_access_authoritative(uuid,uuid,text,uuid,uuid,text,bigint,timestamptz,text)'::regprocedure
          ])
          order by routine.oid`,
      );
      assert.equal(canonicalAcl.length, 6);
      for (const acl of canonicalAcl) {
        assert.equal(acl.service_execute, true, acl.identity);
        assert.equal(acl.anon_execute, false, acl.identity);
        assert.equal(acl.authenticated_execute, false, acl.identity);
        assert.ok(
          acl.search_path?.some((setting) => [
            'search_path=public,pg_temp',
            'search_path=pg_catalog,public',
          ].includes(setting.replace(/\s+/g, ''))),
          `${acl.identity} must pin search_path`,
        );
      }

      const sourceRoot = join(__dirname, '..', '..', '..');
      const source = activeSourceText(
        join(sourceRoot, 'src', 'app'),
        join(sourceRoot, 'src', 'lib'),
        join(sourceRoot, 'scripts'),
        join(sourceRoot, 'workers'),
        join(sourceRoot, 'cron'),
        join(sourceRoot, 'support'),
        join(sourceRoot, 'src', 'workers'),
        join(sourceRoot, 'src', 'cron'),
        join(sourceRoot, 'src', 'support'),
      );
      assert.deepEqual(
        source.split('\n').filter((line) =>
          !/p_expected(?:_old|_new)?_property_access\s*:/.test(line)
          && (/(?:accounts\.)?property_access\b/.test(line) || /['"]property_access['"]/.test(line)),
        ),
        [],
        'active app, script, worker, cron, and support runtime source must not read or write the raw property_access column',
      );
      const customerGates = (await rows<{
        maria_a: boolean;
        maria_b: boolean;
        wanda_l: boolean;
        hank_a: boolean;
        admin_b: boolean;
      }>(
        pg,
        `select
           public.staxis_account_reaches_property($1,$2) as maria_a,
           public.staxis_account_reaches_property($1,$3) as maria_b,
           public.staxis_account_reaches_property($4,$5) as wanda_l,
           public.staxis_account_reaches_property($6,$2) as hank_a,
           public.staxis_account_reaches_property($7,$3) as admin_b`,
        [UID_MARIA, PID_A1, PID_B1, UID_WANDA, PID_L1, UID_HANK, UID_ADMIN],
      ))[0];
      assert.deepEqual(customerGates, {
        maria_a: true,
        maria_b: false,
        wanda_l: true,
        hank_a: false,
        admin_b: true,
      });
      for (const obsolete of [
        'staxis_grant_property_access',
        'staxis_remove_property_access',
        'staxis_remove_property_access_guarded',
        'staxis_remove_property_access_guarded_v2',
        'staxis_translate_legacy_property_access',
        '_staxis_translate_legacy_property_access_trigger',
        '_staxis_reconcile_property_trigger',
        '_staxis_reconcile_account_trigger',
        '_staxis_reconcile_legacy_organization_access',
        'staxis_reconcile_legacy_organization_access',
      ]) {
        assert.doesNotMatch(source, new RegExp(`\\b${obsolete}\\b`), `active runtime source still names ${obsolete}`);
      }
      for (const canonical of [
        'staxis_delete_property_and_legacy_accounts',
        'staxis_accept_account_invite',
        'staxis_grant_existing_account_invite_guarded',
        'staxis_decide_staff_join_request',
        'staxis_finalize_join_code_signup',
      ]) {
        assert.match(source, new RegExp(`\\b${canonical}\\b`));
      }
    });

    test('publishes the shared-producer and exclusive-cutover fence contract', async () => {
      const producerFunction = (await rows<{ definition: string }>(
        pg,
        `select pg_get_functiondef('public._staxis_stage_c_producer_lock()'::regprocedure) as definition`,
      ))[0].definition;
      assert.match(producerFunction, /pg_advisory_xact_lock_shared/i);
      assert.doesNotMatch(producerFunction, /pg_try_advisory_xact_lock/i);
      assert.match(producerFunction, /staxis\.access\.stage_c\.cutover/);
      const producerAcl = (await rows<{
        service_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        search_path: string[] | null;
      }>(
        pg,
        `select has_function_privilege('service_role',routine.oid,'execute') as service_execute,
                has_function_privilege('anon',routine.oid,'execute') as anon_execute,
                has_function_privilege('authenticated',routine.oid,'execute') as authenticated_execute,
                routine.proconfig as search_path
           from pg_proc routine
          where routine.oid='public._staxis_stage_c_producer_lock()'::regprocedure`,
      ))[0];
      assert.equal(producerAcl.service_execute, false);
      assert.equal(producerAcl.anon_execute, false);
      assert.equal(producerAcl.authenticated_execute, false);
      assert.ok(producerAcl.search_path?.some((setting) => setting.replace(/\s+/g, '') === 'search_path=pg_catalog,public'));
      const migrationSource = readFileSync(
        join(process.cwd(), 'supabase', 'migrations', MIGRATION),
        'utf8',
      );
      assert.match(
        migrationSource,
        /begin;[\s\S]*?pg_catalog\.pg_advisory_xact_lock\([\s\S]*?staxis\.access\.stage_c\.cutover/,
        'the suffix must take the exclusive half of the producer protocol',
      );
      const cutoverLockKey = (await rows<{ locked: boolean }>(
        pg,
        `select pg_try_advisory_xact_lock(
           pg_catalog.hashtextextended('staxis.access.stage_c.cutover', 0)
         ) as locked`,
      ))[0].locked;
      assert.equal(cutoverLockKey, true, 'the finalizer must be able to take the producer lock in its own session');
      await pg.exec('commit;').catch(() => undefined);
    });

    test('requires a fresh consumed release receipt and rolls back missing, stale, reused, wrong-token, and wrong-SHA gates', async () => {
      const before = (await rows<{ stage: string; enforcement_enabled: boolean; final_receipts: number }>(
        pg,
        `select status.stage, status.enforcement_enabled,
                (select count(*)::integer from public.account_access_cutover_final_receipts) as final_receipts
           from public.account_access_cutover_status status
          where status.id is true`,
      ))[0];
      const release = (await rows<{ id: string; preflight_run_id: string }>(
        pg,
        `select id,preflight_run_id from public.account_access_cutover_release_receipts
          where status='consumed' order by created_at limit 1`,
      ))[0];
      assert.ok(release);

      await pg.query(`select set_config('staxis.access_stage_c_release_id','',false)`);
      await pg.query(`select set_config('staxis.access_stage_c_release_token','',false)`);
      await pg.query(`select set_config('staxis.access_stage_c_release_nonce','',false)`);
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /requires a same-session receipt id, authorization token, nonce/i,
      );

      const preflightRunId = release.preflight_run_id;
      const wrongShaCount = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from public.account_access_cutover_release_receipts`,
      ))[0].count);
      await assert.rejects(
        jsonRpc(
          pg,
          `select public.staxis_access_stage_c_record_release_receipt(
             'wrong-sha-operator','0000000000000000000000000000000000000000',
             '442fb98d632521ea33346d5c8a97014248a31fa0',clock_timestamp(),$1,
             'wrong-sha-job','wrong-sha-evidence',$2,'wrong-sha-nonce-123456','wrong-sha-token-123456'
           ) as value`,
          [preflightRunId, sha256('wrong-sha-evidence')],
        ),
        /wrong Access B SHA/i,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count from public.account_access_cutover_release_receipts`,
        ))[0].count),
        wrongShaCount,
      );

      const staleToken = 'stale-release-token-123456';
      const staleNonce = 'stale-release-nonce-123456';
      const staleEvidence = 'stale external deployment fence evidence';
      const stale = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_record_release_receipt(
           'stale-operator','ec83bca6dab74a52dfb251d04be11d5c7427703f',
           '442fb98d632521ea33346d5c8a97014248a31fa0',$1,$2,
           'stale-job',$3,$4,$5,$6
         ) as value`,
        [new Date(Date.now() - 24 * 60 * 60_000).toISOString(), preflightRunId, staleEvidence, sha256(staleEvidence), staleNonce, staleToken],
      );
      await pg.query(
        `select set_config('staxis.access_stage_c_release_id',$1,false),
                set_config('staxis.access_stage_c_release_token',$2,false),
                set_config('staxis.access_stage_c_release_nonce',$3,false)`,
        [String(stale.receiptId), staleToken, staleNonce],
      );
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /stale, fenced for another session, or has the wrong deployment evidence/i,
      );

      const freshToken = 'fresh-release-token-123456';
      const freshNonce = 'fresh-release-nonce-123456';
      const freshEvidence = 'fresh external deployment fence evidence';
      const fresh = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_record_release_receipt(
           'fresh-operator','ec83bca6dab74a52dfb251d04be11d5c7427703f',
           '442fb98d632521ea33346d5c8a97014248a31fa0',clock_timestamp(),$1,
           'fresh-job',$2,$3,$4,$5
         ) as value`,
        [preflightRunId, freshEvidence, sha256(freshEvidence), freshNonce, freshToken],
      );
      await pg.query(
        `select set_config('staxis.access_stage_c_release_id',$1,false),
                set_config('staxis.access_stage_c_release_token',$2,false),
                set_config('staxis.access_stage_c_release_nonce',$3,false)`,
        [String(fresh.receiptId), 'wrong-fresh-token-123456', freshNonce],
      );
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /authorization token does not match/i,
      );
      await pg.query(`select set_config('staxis.access_stage_c_release_token',$1,false)`, [freshToken]);
      const consumedFresh = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_consume_release() as value`,
      );
      assert.equal(consumedFresh.status, 'consumed');
      await assert.rejects(
        pg.query(`select public.staxis_access_stage_c_consume_release()`),
        /already consumed/i,
      );

      assert.deepEqual(
        (await rows<{ stage: string; enforcement_enabled: boolean; final_receipts: number }>(
          pg,
          `select status.stage, status.enforcement_enabled,
                  (select count(*)::integer from public.account_access_cutover_final_receipts) as final_receipts
             from public.account_access_cutover_status status
            where status.id is true`,
        ))[0],
        before,
        'every rejected release gate must leave final authority unchanged',
      );
    });

    test('rejects empty and update writes while preserving immutable receipts and named recovery evidence', async () => {
      const emptyInsertUser = 'c4261000-0000-4000-8000-000000000007';
      await pg.query(`insert into auth.users(id,email) values ($1,'empty-write@example.test')`, [emptyInsertUser]);
      const inserted = await rows<{ property_access: string[] | null }>(
        pg,
        `insert into public.accounts(id,username,password_hash,display_name,role,data_user_id)
         values ('c4260000-0000-4000-8000-000000000007','empty-write','x','Empty Write','front_desk',$1)
         returning property_access`,
        [emptyInsertUser],
      );
      assert.equal(inserted[0].property_access, null);
      await assert.rejects(
        pg.query(
          `insert into public.accounts(id,username,password_hash,display_name,role,property_access,data_user_id)
           values ('c4260000-0000-4000-8000-000000000008','explicit-empty','x','Explicit Empty','front_desk','{}',$1)`,
          [emptyInsertUser],
        ),
        /final access contract rejects accounts\.property_access writes/i,
      );
      await assert.rejects(
        pg.query(`update public.accounts set property_access = '{}'::uuid[] where id = $1`, [ACCOUNT_WANDA]),
        /final access contract rejects all accounts\.property_access writes/i,
      );
      await assert.rejects(
        pg.query(`select public.staxis_remove_property_access($1,$2)`, [ACCOUNT_ADMIN, PID_L1]),
        /function public\.staxis_remove_property_access\(.*does not exist/i,
        'a direct obsolete revoke RPC must fail closed after the final cutover',
      );

      const receipt = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_final_receipt($1) as value`,
        [ACCOUNT_WANDA],
      );
      assert.equal(receipt.account_id, ACCOUNT_WANDA);
      assert.deepEqual(receipt.source_property_ids, []);
      await assert.rejects(
        pg.query(`update public.account_access_cutover_final_receipts set details = '{}' where account_id = $1`, [ACCOUNT_WANDA]),
        /final receipts are immutable/i,
      );
      await assert.rejects(
        pg.query(`delete from public.account_access_cutover_final_receipts where account_id = $1`, [ACCOUNT_WANDA]),
        /final receipts are immutable/i,
      );

      const recovery = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_freeze_and_forward($1,$2,null) as value`,
        ['stage-c-test-operator', 'stage-c test recovery evidence'],
      );
      assert.equal(recovery.ok, true);
      assert.equal(recovery.authorityChanged, false);
      const recoveryEvidence = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_recovery_evidence(null) as value`,
      );
      assert.ok(Array.isArray(recoveryEvidence));
      assert.equal((recoveryEvidence as unknown[]).length, 1);
    });

    test('preserves canonical invite acceptance, existing-account grant, join approval, onboarding, lifecycle CAS, detach, and idempotency', async () => {
      await insertStaff(pg, INVITE_STAFF, PID_L1, 'Invite Person', 'housekeeping', '512-555-1001');
      await pg.query(`insert into auth.users(id,email) values ($1,'invite-person@example.test')`, [INVITE_USER]);
      const inviteToken = 'a'.repeat(64);
      const inviteClaim = 'c4267000-0000-4000-8000-000000000001';
      await pg.query(
        `insert into public.account_invites(
           hotel_id,email,role,token_hash,expires_at,invited_by,
           target_staff_id,acceptance_claim_token,acceptance_claimed_at
         ) values ($1,'invite-person@example.test','housekeeping',$2,now()+interval '1 day',$3,$4,$5,now())`,
        [PID_L1, inviteToken, ACCOUNT_WANDA, INVITE_STAFF, inviteClaim],
      );
      const accepted = await jsonRpc(
        pg,
        `select public.staxis_accept_account_invite($1,$2,$3,'invite-person','Invite Person') as value`,
        [inviteToken, inviteClaim, INVITE_USER],
      );
      assert.equal(accepted.ok, true);
      assert.equal(accepted.normalized, true);
      const acceptedAccountId = String(accepted.accountId);
      assert.equal((await propertyIds(pg, acceptedAccountId)).includes(PID_L1), true);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from public.account_property_staff_links
          where account_id=$1 and property_id=$2 and staff_id=$3 and is_active`,
        [acceptedAccountId, PID_L1, INVITE_STAFF],
      ))[0].count, 1);
      assert.equal((await rows<{ property_access: string[] | null }>(pg, `select property_access from accounts where id=$1`, [acceptedAccountId]))[0].property_access, null);

      await insertStaff(pg, GRANT_STAFF, PID_A1, 'Grant Person', 'front_desk', '512-555-1002');
      await insertCanonicalAccount(pg, GRANT_ACCOUNT, GRANT_USER, 'grant-person', 'Grant Person', 'front_desk', 'grant-person@example.test');
      const granted = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'grant-person@example.test','front_desk',$5,'property',$6,$7,'stage-c-grant'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, GRANT_ACCOUNT, ORG_A, [PID_A1], GRANT_STAFF],
      );
      assert.equal(granted.ok, true, JSON.stringify(granted));
      assert.equal(granted.normalized, true);
      assert.equal((await propertyIds(pg, GRANT_ACCOUNT)).includes(PID_A1), true);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from organization_memberships
          where account_id=$1 and organization_id=$2 and membership_scope='property'
            and staxis_role='front_desk' and ended_at is null and status='active'`,
        [GRANT_ACCOUNT, ORG_A],
      ))[0].count, 1);
      const grantReplay = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'grant-person@example.test','front_desk',$5,'property',$6,$7,'stage-c-grant-replay'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, GRANT_ACCOUNT, ORG_A, [PID_A1], GRANT_STAFF],
      );
      assert.equal(grantReplay.ok, true);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from organization_memberships
          where account_id=$1 and organization_id=$2 and membership_scope='property'
            and staxis_role='front_desk' and ended_at is null and status='active'`,
        [GRANT_ACCOUNT, ORG_A],
      ))[0].count, 1);

      await insertCanonicalAccount(pg, JOIN_ACCOUNT, JOIN_USER, 'join-person', 'Join Person', 'housekeeping', 'join-person@example.test');
      await pg.query(
        `insert into public.join_requests(id,property_id,account_id,name,phone,language,department,status)
         values ($1,$2,$3,'Join Person','512-555-1003','en','housekeeping','pending')`,
        [JOIN_REQUEST, PID_A1, JOIN_ACCOUNT],
      );
      const approved = await jsonRpc(
        pg,
        `select public.staxis_decide_staff_join_request($1,$2,$3,'approve') as value`,
        [ACCOUNT_MARIA, JOIN_REQUEST, PID_A1],
      );
      assert.equal(approved.ok, true);
      assert.equal(approved.authorityMode, 'normalized');
      assert.equal((await propertyIds(pg, JOIN_ACCOUNT)).includes(PID_A1), true);
      const approvalReplay = await jsonRpc(
        pg,
        `select public.staxis_decide_staff_join_request($1,$2,$3,'approve') as value`,
        [ACCOUNT_MARIA, JOIN_REQUEST, PID_A1],
      );
      assert.deepEqual(approvalReplay, { ok: false, reason: 'already_decided' });

      await pg.query(
        `insert into public.properties(id,owner_id,name,total_rooms,timezone)
         values ($1,$2,'Stage C First Person',12,'America/Chicago')`,
        [FIRST_PROPERTY, UID_ADMIN],
      );
      await pg.query(`insert into auth.users(id,email) values ($1,'first-stage-c@example.test')`, [FIRST_USER]);
      const minted = await jsonRpc(
        pg,
        `select public.staxis_mint_first_person_onboarding_invite(
           $1,$2,$3,$4,'owner','first-stage-c@example.test','stage-c-first-person'
         ) as value`,
        [ACCOUNT_ADMIN, UID_ADMIN, FIRST_PROPERTY, FIRST_CODE],
      );
      assert.equal(minted.ok, true);
      const finalized = await jsonRpc(
        pg,
        `select public.staxis_finalize_join_code_signup(
           $1,$2,$3,0,$4,'first-stage-c','First Stage C','owner',null,'en','stage-c-first-person'
         ) as value`,
        [minted.codeId, FIRST_CODE, FIRST_PROPERTY, FIRST_USER],
      );
      assert.equal(finalized.ok, true, JSON.stringify(finalized));
      assert.equal(finalized.status, 'finalized');
      assert.equal(finalized.pendingApproval, false);
      const firstAccount = (await rows<{ id: string; property_access: string[] | null }>(
        pg,
        `select id,property_access from accounts where data_user_id=$1`,
        [FIRST_USER],
      ))[0];
      assert.equal(firstAccount.property_access, null);
      assert.deepEqual(await propertyIds(pg, firstAccount.id), [FIRST_PROPERTY]);

      await insertCanonicalAccount(pg, LIFECYCLE_ACCOUNT, LIFECYCLE_USER, 'lifecycle-person', 'Lifecycle Person', 'front_desk', 'lifecycle@example.test');
      const lifecycleGrant = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'lifecycle@example.test','front_desk',$5,'property',$6,null,'stage-c-lifecycle-grant'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, LIFECYCLE_ACCOUNT, ORG_A, [PID_A1]],
      );
      assert.equal(lifecycleGrant.ok, true);
      const lifecycleState = (await rows<{ authority_version: number; lifecycle_intent_version: number; updated_at: string }>(
        pg,
        `select state.authority_version,account.lifecycle_intent_version,account.updated_at
           from account_authorization_state state join accounts account on account.id=state.account_id
          where state.account_id=$1`,
        [LIFECYCLE_ACCOUNT],
      ))[0];
      const registered = await jsonRpc(
        pg,
        `select public.staxis_register_account_lifecycle_intent(
           $1,$2,$3,'maria@example.test',$4,$5,false,true,'front_desk',$6,$7,$8
         ) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_MARIA, UID_MARIA, PID_A1, LIFECYCLE_ACCOUNT, LIFECYCLE_USER, [PID_A1], lifecycleState.lifecycle_intent_version],
      );
      assert.equal(registered.status, 'pending');
      const claimed = await jsonRpc(
        pg,
        `select public.staxis_claim_account_lifecycle_intent($1,$2,120) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_ADMIN],
      );
      assert.equal(claimed.status, 'claimed');
      const snapshot = await jsonRpc(
        pg,
        `select public.staxis_record_account_lifecycle_auth_snapshot($1,null,$2) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_ADMIN],
      );
      assert.equal(snapshot.status, 'pending');
      const committed = await jsonRpc(
        pg,
        `select public.staxis_commit_account_lifecycle_intent($1,'request',$2) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_ADMIN],
      );
      assert.equal(committed.status, 'committed');
      const lifecycleReplay = await jsonRpc(
        pg,
        `select public.staxis_register_account_lifecycle_intent(
           $1,$2,$3,'maria@example.test',$4,$5,false,true,'front_desk',$6,$7,$8
         ) as value`,
        [LIFECYCLE_OPERATION, ACCOUNT_MARIA, UID_MARIA, PID_A1, LIFECYCLE_ACCOUNT, LIFECYCLE_USER, [PID_A1], lifecycleState.lifecycle_intent_version],
      );
      assert.equal(lifecycleReplay.status, 'committed');
      assert.equal((await rows<{ active: boolean }>(pg, `select active from accounts where id=$1`, [LIFECYCLE_ACCOUNT]))[0].active, false);

      await insertCanonicalAccount(pg, DETACH_ACCOUNT, DETACH_USER, 'detach-person', 'Detach Person', 'front_desk', 'detach@example.test');
      const detachGrant = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'detach@example.test','front_desk',$5,'property',$6,null,'stage-c-detach-grant'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, PID_A1, DETACH_ACCOUNT, ORG_A, [PID_A1]],
      );
      assert.equal(detachGrant.ok, true);
      const detachState = (await rows<{ authority_version: number; updated_at: string; role: string }>(
        pg,
        `select state.authority_version,account.updated_at,account.role
           from account_authorization_state state join accounts account on account.id=state.account_id
          where state.account_id=$1`,
        [DETACH_ACCOUNT],
      ))[0];
      const detached = await jsonRpc(
        pg,
        `select public.staxis_remove_property_access_authoritative(
           $1,$2,'maria@example.test',$3,$4,$5,$6,$7,'stage-c-detach'
         ) as value`,
        [ACCOUNT_MARIA, UID_MARIA, DETACH_ACCOUNT, PID_A1, detachState.role, detachState.authority_version, detachState.updated_at],
      );
      assert.equal(detached.status, 'ok', JSON.stringify(detached));
      assert.equal((await propertyIds(pg, DETACH_ACCOUNT)).includes(PID_A1), false);
      assert.equal((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count from account_property_authorization_bridges
          where account_id=$1 and property_id=$2 and status='active'`,
        [DETACH_ACCOUNT, PID_A1],
      ))[0].count, 0);
      assert.equal((await rows<{ count: number }>(pg, `select count(*)::integer as count from account_lifecycle_intents where operation_id=$1`, [DETACH_OPERATION]))[0].count, 0);

      await insertCanonicalAccount(pg, TRANSFER_ACCOUNT, TRANSFER_USER, 'transfer-person', 'Transfer Person', 'front_desk', 'transfer@example.test');
      const transferGrant = await jsonRpc(
        pg,
        `select public.staxis_grant_existing_account_invite_guarded(
           $1,$2,$3,$4,'transfer@example.test','front_desk',$5,$6,$7,null,'stage-c-transfer-grant'
         ) as value`,
        [ACCOUNT_ADMIN, UID_ADMIN, PID_L1, TRANSFER_ACCOUNT, null, null, null],
      );
      assert.equal(transferGrant.ok, true, JSON.stringify(transferGrant));
      const transferVersions = (await rows<{
        old_active: boolean;
        old_role: string;
        old_auth_user_id: string;
        old_property_ids: string[];
        old_intent_version: number;
        new_active: boolean;
        new_role: string;
        new_auth_user_id: string;
        new_property_ids: string[];
        new_intent_version: number;
      }>(
        pg,
        `select
           old_account.active as old_active,
           old_account.role as old_role,
           old_account.data_user_id as old_auth_user_id,
           public._staxis_structural_account_property_ids(old_account.id) as old_property_ids,
           old_account.lifecycle_intent_version as old_intent_version,
           new_account.active as new_active,
           new_account.role as new_role,
           new_account.data_user_id as new_auth_user_id,
           public._staxis_structural_account_property_ids(new_account.id) as new_property_ids,
           new_account.lifecycle_intent_version as new_intent_version
          from public.accounts old_account
          join public.accounts new_account on new_account.id = $2
         where old_account.id = $1`,
        [ACCOUNT_WANDA, TRANSFER_ACCOUNT],
      ))[0];
      const transferred = await jsonRpc(
        pg,
        `select public.staxis_transfer_ownership_guarded(
           $1,$2,$3,'staxis-admin@example.test',$4,$5,$6,
           $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'stage-c transfer','stage-c-transfer'
         ) as value`,
        [
          TRANSFER_OPERATION,
          ACCOUNT_ADMIN,
          UID_ADMIN,
          PID_L1,
          ACCOUNT_WANDA,
          TRANSFER_ACCOUNT,
          transferVersions.old_active,
          transferVersions.old_role,
          transferVersions.old_auth_user_id,
          transferVersions.old_property_ids,
          transferVersions.old_intent_version,
          transferVersions.new_active,
          transferVersions.new_role,
          transferVersions.new_auth_user_id,
          transferVersions.new_property_ids,
          transferVersions.new_intent_version,
        ],
      );
      assert.equal(transferred.status, 'ok', JSON.stringify(transferred));
      assert.deepEqual(
        await rows<{ old_role: string; new_role: string }>(
          pg,
          `select
             (select role from public.accounts where id=$1) as old_role,
             (select role from public.accounts where id=$2) as new_role`,
          [ACCOUNT_WANDA, TRANSFER_ACCOUNT],
        ),
        [{ old_role: 'general_manager', new_role: 'owner' }],
      );
      const transferReplay = await jsonRpc(
        pg,
        `select public.staxis_transfer_ownership_guarded(
           $1,$2,$3,'staxis-admin@example.test',$4,$5,$6,
           $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'stage-c transfer','stage-c-transfer'
         ) as value`,
        [
          TRANSFER_OPERATION,
          ACCOUNT_ADMIN,
          UID_ADMIN,
          PID_L1,
          ACCOUNT_WANDA,
          TRANSFER_ACCOUNT,
          transferVersions.old_active,
          transferVersions.old_role,
          transferVersions.old_auth_user_id,
          transferVersions.old_property_ids,
          transferVersions.old_intent_version,
          transferVersions.new_active,
          transferVersions.new_role,
          transferVersions.new_auth_user_id,
          transferVersions.new_property_ids,
          transferVersions.new_intent_version,
        ],
      );
      assert.equal(transferReplay.status, 'already_applied', JSON.stringify(transferReplay));
    });

    test('rejects a wrong-name rollback, then deletes canonical scope without losing receipts', async () => {
      await assert.rejects(
        pg.query(
          `select public.staxis_delete_property_and_legacy_accounts($1,$2,$3)`,
          [ACCOUNT_ADMIN, PID_L1, 'Wrong Waco name'],
        ),
        /confirmed hotel name does not match/i,
      );
      assert.deepEqual(
        await rows<{ property_count: number; wanda_count: number; transfer_count: number }>(
          pg,
          `select
             (select count(*)::integer from public.properties where id=$1) as property_count,
             (select count(*)::integer from public.accounts where id=$2) as wanda_count,
             (select count(*)::integer from public.accounts where id=$3) as transfer_count`,
          [PID_L1, ACCOUNT_WANDA, TRANSFER_ACCOUNT],
        ),
        [{ property_count: 1, wanda_count: 1, transfer_count: 1 }],
      );
      const deleted = await jsonRpc(
        pg,
        `select public.staxis_delete_property_and_legacy_accounts($1,$2,'Waco Inn') as value`,
        [ACCOUNT_ADMIN, PID_L1],
      );
      assert.equal(deleted.canonical, true);
      assert.equal(deleted.propertyRosterLineagePreserved, true);
      assert.equal((await rows<{ count: number }>(pg, `select count(*)::integer as count from properties where id=$1`, [PID_L1]))[0].count, 0);
      assert.equal((await rows<{ count: number }>(pg, `select count(*)::integer as count from accounts where id in ($1,$2)`, [ACCOUNT_WANDA, TRANSFER_ACCOUNT]))[0].count, 0);
      const receipt = await jsonRpc(
        pg,
        `select public.staxis_access_stage_c_final_receipt($1) as value`,
        [ACCOUNT_WANDA],
      );
      assert.deepEqual(receipt.source_property_ids, []);
    });
  });

  test('bootstraps a fresh canonical admin through the service-only seam and is idempotent', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file !== MIGRATION) return;
        await seedStageCFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await authorizeAccessStageCRelease(hookPg);
        },
      },
    );
    try {
      assert.ok(migrated.report.applied.includes(MIGRATION), JSON.stringify(migrated.report.failedAtRuntime));
      const pg = migrated.pg;
      await pg.query(`drop trigger if exists trg_accounts_authorization_refresh on public.accounts`);
      await pg.query(
        `insert into auth.users(id,email) values($1,'stage-c-bootstrap@example.test')`,
        [BOOTSTRAP_USER],
      );
      await pg.query(
        `insert into public.accounts(
           id,username,password_hash,display_name,role,data_user_id
         ) values($1,'stage-c-bootstrap','x','Stage C Bootstrap','admin',$2)`,
        [BOOTSTRAP_ACCOUNT, BOOTSTRAP_USER],
      );
      await pg.query(
        `insert into public.account_authorization_state(
           account_id,authority_mode,authority_version,legacy_scope_hash,normalized_scope_hash
         ) values($1,'legacy',1,$2,$2)`,
        [BOOTSTRAP_ACCOUNT, sha256('')],
      );
      await pg.query(
        `create trigger trg_accounts_authorization_refresh
           after insert or update of active,role on public.accounts
           for each row execute function public._staxis_refresh_account_authorization_from_account()`,
      );

      const firstBootstrap = await jsonRpc(
        pg,
        `select public.staxis_bootstrap_canonical_admin_authority(
           $1::uuid,'{}'::uuid[],$2::bigint,'seed-supabase canonical admin bootstrap'::text
         ) as value`,
        [BOOTSTRAP_ACCOUNT, 1],
      );
      assert.equal(firstBootstrap.ok, true);
      assert.equal(firstBootstrap.status, 'bootstrapped');
      const bootstrappedState = (await rows<{ authority_version: number }>(
        pg,
        `select authority_version from public.account_authorization_state where account_id=$1`,
        [BOOTSTRAP_ACCOUNT],
      ))[0];
      const auditBeforeReplay = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.admin_audit_log
          where action='account.canonical_bootstrap' and target_id=$1`,
        [BOOTSTRAP_ACCOUNT],
      ))[0].count);
      const secondBootstrap = await jsonRpc(
        pg,
        `select public.staxis_bootstrap_canonical_admin_authority(
           $1::uuid,'{}'::uuid[],$2::bigint,'seed-supabase canonical admin bootstrap'::text
         ) as value`,
        [BOOTSTRAP_ACCOUNT, bootstrappedState.authority_version],
      );
      assert.equal(secondBootstrap.ok, true);
      assert.equal(secondBootstrap.status, 'already_canonical');
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.admin_audit_log
            where action='account.canonical_bootstrap' and target_id=$1`,
          [BOOTSTRAP_ACCOUNT],
        ))[0].count),
        auditBeforeReplay,
      );

      const beforeMalformed = (await rows<{
        authority_mode: string;
        authority_version: number;
        property_access: string[];
      }>(
        pg,
        `select state.authority_mode,state.authority_version,account.property_access
           from public.account_authorization_state state
           join public.accounts account on account.id=state.account_id
          where state.account_id=$1`,
        [BOOTSTRAP_ACCOUNT],
      ))[0];
      const bridgesBeforeMalformed = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.account_property_authorization_bridges where account_id=$1`,
        [BOOTSTRAP_ACCOUNT],
      ))[0].count);
      const auditBeforeMalformed = Number((await rows<{ count: number }>(
        pg,
        `select count(*)::integer as count
           from public.admin_audit_log where target_id=$1`,
        [BOOTSTRAP_ACCOUNT],
      ))[0].count);
      const malformedBootstrap = await jsonRpc(
        pg,
        `select public.staxis_bootstrap_canonical_admin_authority(
           $1::uuid,$2::uuid[],$3::bigint,'seed-supabase canonical admin bootstrap'::text
         ) as value`,
        [BOOTSTRAP_ACCOUNT, [PID_A1], beforeMalformed.authority_version],
      );
      assert.deepEqual(malformedBootstrap, {
        ok: false,
        status: 'invalid',
        reason: 'bootstrap_request',
      });
      assert.deepEqual(
        (await rows<{
          authority_mode: string;
          authority_version: number;
          property_access: string[];
        }>(
          pg,
          `select state.authority_mode,state.authority_version,account.property_access
             from public.account_authorization_state state
             join public.accounts account on account.id=state.account_id
            where state.account_id=$1`,
          [BOOTSTRAP_ACCOUNT],
        ))[0],
        beforeMalformed,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.account_property_authorization_bridges where account_id=$1`,
          [BOOTSTRAP_ACCOUNT],
        ))[0].count),
        bridgesBeforeMalformed,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          pg,
          `select count(*)::integer as count
             from public.admin_audit_log where target_id=$1`,
          [BOOTSTRAP_ACCOUNT],
        ))[0].count),
        auditBeforeMalformed,
      );
      await assert.rejects(
        (async () => {
          await pg.query(`begin`);
          await pg.query(`set local role authenticated`);
          await pg.query(
            `select public.staxis_bootstrap_canonical_admin_authority(
               $1::uuid,'{}'::uuid[],$2::bigint,'seed-supabase canonical admin bootstrap'::text
             )`,
            [BOOTSTRAP_ACCOUNT, bootstrappedState.authority_version],
          );
        })(),
        /permission denied/i,
        'ordinary authenticated clients cannot execute the seed bootstrap',
      );
      await pg.query(`rollback`).catch(() => undefined);
      assert.equal(firstBootstrap.status, 'bootstrapped');
      assert.equal(secondBootstrap.status, 'already_canonical');
      assert.equal(malformedBootstrap.reason, 'bootstrap_request');
    } finally {
      await migrated.pg.close();
    }
  });

  test('repairs exact production-shaped admin, duplicate, and revoked-empty residues before consuming the release gate', async () => {
    let sourcePreflightRunId = '';
    let mariaCanonicalIds: string[] = [];
    let frankCanonicalIds: string[] = [];
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          sourcePreflightRunId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const states = await rows<{
            account_id: string;
            authority_mode: string;
            authority_version: number;
          }>(
            hookPg,
            `select account_id,authority_mode,authority_version
               from public.account_authorization_state
              where account_id in ($1,$2,$3)
              order by account_id`,
            [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK],
          );
          const byAccount = new Map(states.map((state) => [state.account_id, state]));
          mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          frankCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_FRANK],
          )).map((row) => row.property_id);
          await recordRepairDisposition(hookPg, {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_ADMIN,
            propertyId: PID_A1,
            issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
            decision: 'admin_global',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: [],
            authorityMode: byAccount.get(ACCOUNT_ADMIN)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_ADMIN)?.authority_version ?? 0,
            reason: 'admin_global_role_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_MARIA,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: mariaCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_MARIA)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_MARIA)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_FRANK,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'revoked_canonical_empty',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: frankCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_FRANK)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_FRANK)?.authority_version ?? 0,
            reason: 'revoked_canonical_empty_residue',
          });
          await authorizeAccessStageCRelease(hookPg);
        },
      },
    );
    try {
      assert.ok(
        migrated.report.applied.includes(MIGRATION),
        JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      assert.deepEqual(
        migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION),
        [],
      );
      const status = (await rows<{
        stage: string;
        enforcement_enabled: boolean;
        details: Record<string, unknown>;
      }>(
        migrated.pg,
        `select stage,enforcement_enabled,details
           from public.account_access_cutover_status where id is true`,
      ))[0];
      assert.deepEqual(
        {
          stage: status.stage,
          enforcement_enabled: status.enforcement_enabled,
          repairSourcePreflightRunId: status.details.repairSourcePreflightRunId,
          repairDispositionCount: status.details.repairDispositionCount,
        },
        {
          stage: 'C',
          enforcement_enabled: true,
          repairSourcePreflightRunId: sourcePreflightRunId,
          repairDispositionCount: 3,
        },
      );
      const productionManifest = await rows<{
        issue_id: string;
        source: string;
        issue_code: string;
        raw_scope_hash: string;
        status: string;
      }>(
        migrated.pg,
        `select issue_id,source,issue_code,raw_scope_hash,status
           from public.account_access_cutover_repair_manifests
          where preflight_run_id=$1 order by issue_id`,
        [sourcePreflightRunId],
      );
      assert.equal(productionManifest.length, 5, 'the fixture has four direct residue rows plus the Stage-A wrapper');
      assert.equal(new Set(productionManifest.map((row) => row.issue_id)).size, 5);
      assert.ok(productionManifest.every((row) => row.source === 'test-fixture' || row.source === 'production-85981f5e-a387-4af3-ae10-b9bc1e1e9567'));
      assert.ok(productionManifest.every((row) => /^[0-9a-f]{64}$/.test(row.raw_scope_hash)));
      assert.ok(productionManifest.every((row) => row.status === 'consumed'));
      const alreadyFinalized = await jsonRpc(
        migrated.pg,
        `select public.staxis_preflight_authorization_cutover_stage_c() as value`,
      );
      assert.deepEqual(alreadyFinalized, { ok: true, alreadyFinalized: true, stage: 'C' });
      const repairReceipts = await rows<{
        account_id: string;
        property_id: string;
        decision: string;
          source_property_ids: string[];
          source_scope_hash: string;
          canonical_property_ids_before: string[];
          canonical_scope_hash_before: string;
          canonical_property_ids_after: string[];
          canonical_scope_hash_after: string;
          authority_mode_before: string;
          authority_mode_after: string;
          authority_version_before: number;
          authority_version_after: number;
          legacy_write_event_count_before: number;
          legacy_write_event_count_after: number;
          evidence_before: Record<string, unknown>;
          evidence_after: Record<string, unknown>;
          evidence_before_hash: string;
          evidence_after_hash: string;
          operator_label: string;
          access_b_merge_sha: string;
          deployed_descendant_sha: string;
          repaired_at: string | Date;
      }>(
        migrated.pg,
        `select account_id,property_id,decision,source_property_ids,source_scope_hash,
                canonical_property_ids_before,canonical_scope_hash_before,
                canonical_property_ids_after,canonical_scope_hash_after,
                authority_mode_before,authority_mode_after,
                authority_version_before,authority_version_after,
                legacy_write_event_count_before,legacy_write_event_count_after,
                evidence_before,evidence_after,evidence_before_hash,evidence_after_hash,
                operator_label,access_b_merge_sha,deployed_descendant_sha,repaired_at
           from public.account_access_cutover_repair_receipts
          where preflight_run_id=$1 order by account_id`,
        [sourcePreflightRunId],
      );
      for (const receipt of repairReceipts) {
        assert.equal(receipt.source_scope_hash, sha256(receipt.source_property_ids.join(',')));
        assert.equal(receipt.canonical_scope_hash_before, sha256(receipt.canonical_property_ids_before.join(',')));
        assert.equal(receipt.canonical_scope_hash_after, sha256(receipt.canonical_property_ids_after.join(',')));
        assert.equal(receipt.legacy_write_event_count_before, 0);
        assert.equal(receipt.legacy_write_event_count_after, 0);
        assert.equal(receipt.operator_label, 'production-residue-operator');
        assert.equal(receipt.access_b_merge_sha, ACCESS_B_LIVE_SHA);
        assert.equal(receipt.deployed_descendant_sha, CURRENT_LIVE_DESCENDANT_SHA);
        assert.ok(receipt.repaired_at instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(receipt.repaired_at));
        assert.ok(receipt.evidence_before.account);
        assert.ok(receipt.evidence_before.topology);
        assert.ok(receipt.evidence_before.staffLinks);
        assert.ok(receipt.evidence_before.bridges);
        assert.ok(receipt.evidence_before.grants);
        assert.ok(receipt.evidence_after.authIdentity);
        assert.match(receipt.evidence_before_hash, /^[0-9a-f]{64}$/);
        assert.match(receipt.evidence_after_hash, /^[0-9a-f]{64}$/);
      }
      assert.deepEqual(
        repairReceipts.map((receipt) => ({
          account_id: receipt.account_id,
          property_id: receipt.property_id,
          decision: receipt.decision,
          source_property_ids: receipt.source_property_ids,
          canonical_property_ids_before: receipt.canonical_property_ids_before,
          canonical_property_ids_after: receipt.canonical_property_ids_after,
          authority_mode_before: receipt.authority_mode_before,
          authority_mode_after: receipt.authority_mode_after,
        })),
        [
          {
            account_id: ACCOUNT_ADMIN,
            property_id: PID_A1,
            decision: 'admin_global',
            source_property_ids: [PID_A1],
            canonical_property_ids_before: [],
            canonical_property_ids_after: [],
            authority_mode_before: 'legacy',
            authority_mode_after: 'normalized',
          },
          {
            account_id: ACCOUNT_MARIA,
            property_id: PID_A1,
            decision: 'canonical_duplicate',
            source_property_ids: [PID_A1],
            canonical_property_ids_before: mariaCanonicalIds,
            canonical_property_ids_after: mariaCanonicalIds,
            authority_mode_before: 'normalized',
            authority_mode_after: 'normalized',
          },
          {
            account_id: ACCOUNT_FRANK,
            property_id: PID_A1,
            decision: 'revoked_canonical_empty',
            source_property_ids: [PID_A1],
            canonical_property_ids_before: [],
            canonical_property_ids_after: [],
            authority_mode_before: 'normalized',
            authority_mode_after: 'normalized',
          },
        ],
      );
      const repairRuns = await rows<{ id: string; status: string; issue_count: number }>(
        migrated.pg,
        `select id,status,issue_count
           from public.account_access_cutover_preflight_runs
          where id in ($1,$2)
          order by id`,
        [sourcePreflightRunId, status.details.repairPreflightRunId],
      );
      assert.deepEqual(
        repairRuns.map((run) => ({ id: run.id, status: run.status, issue_count: Number(run.issue_count) })),
        [
          { id: sourcePreflightRunId, status: 'failed', issue_count: repairRuns.find((run) => run.id === sourcePreflightRunId)?.issue_count ?? 0 },
          { id: String(status.details.repairPreflightRunId), status: 'passed', issue_count: 0 },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      assert.deepEqual(
        await rows<{ account_id: string; property_access: string[] | null }>(
          migrated.pg,
          `select id as account_id,property_access from accounts
            where id in ($1,$2,$3) order by account_id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { account_id: ACCOUNT_ADMIN, property_access: [] },
          { account_id: ACCOUNT_MARIA, property_access: [] },
          { account_id: ACCOUNT_FRANK, property_access: [] },
        ],
      );
      assert.deepEqual(await propertyIds(migrated.pg, ACCOUNT_MARIA), mariaCanonicalIds);
      assert.deepEqual(await propertyIds(migrated.pg, ACCOUNT_FRANK), frankCanonicalIds);
      assert.equal(
        (await jsonRpc(
          migrated.pg,
          `select public.staxis_list_account_authorized_properties($1) as value`,
          [ACCOUNT_ADMIN],
        )).all,
        true,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_legacy_write_events`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_dispositions
            where status='consumed' and consumed_preflight_run_id <> preflight_run_id`,
        ))[0].count),
        3,
      );
      const release = (await rows<{
        preflight_run_id: string;
        consumed_preflight_run_id: string;
        status: string;
        details: Record<string, unknown>;
      }>(
        migrated.pg,
        `select preflight_run_id,consumed_preflight_run_id,status,details
           from public.account_access_cutover_release_receipts`,
      ))[0];
      assert.equal(release.preflight_run_id, sourcePreflightRunId);
      assert.notEqual(release.consumed_preflight_run_id, sourcePreflightRunId);
      assert.equal(release.status, 'consumed');
      assert.equal(release.details.repairEligible, true);
      const evidence = await jsonRpc(
        migrated.pg,
        `select public.staxis_access_stage_c_repair_evidence($1) as value`,
        [sourcePreflightRunId],
      );
      assert.equal((evidence.dispositions as unknown[]).length, 3);
      assert.equal((evidence.receipts as unknown[]).length, 3);
      await assert.rejects(
        migrated.pg.query(
          `update public.account_access_cutover_repair_receipts
              set operator_label='tampered'`,
        ),
        /repair receipts are immutable/i,
      );
      await assert.rejects(
        migrated.pg.query(
          `delete from public.account_access_cutover_repair_dispositions`,
        ),
        /repair dispositions are durable|immutable/i,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('normalizes all ten production-shaped legacy rows with exact bridge parity', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
        },
      },
    );
    try {
      assert.equal(
        migrated.report.applied.includes(MIGRATION),
        true,
        JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      assert.equal(
        Number((await rows<{ count: number }>(migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests
            where status='converted'`))[0].count),
        10,
      );
      const converted = await rows<{
        account_id: string;
        authority_mode: string;
        authority_version: number;
        property_access: string[];
        bridge_id: string;
        bridge_source_hash: string;
        bridge_relationship_id: string;
        bridge_organization_id: string;
        membership_count: number;
        grant_count: number;
        staff_count: number;
      }>(migrated.pg, `
               select account.id as account_id, state.authority_mode, state.authority_version,
               account.property_access, bridge.id as bridge_id,
               bridge.source_legacy_scope_hash as bridge_source_hash,
               bridge.cutover_relationship_id as bridge_relationship_id,
               bridge.cutover_organization_id as bridge_organization_id,
               (select count(*)::integer from public.organization_memberships membership
                 where membership.account_id=account.id) as membership_count,
               (select count(*)::integer from public.organization_access_grants grant_row
                 join public.organization_memberships membership on membership.id=grant_row.membership_id
                where membership.account_id=account.id and grant_row.status='active') as grant_count,
               (select count(*)::integer from public.account_property_staff_links staff_link
                where staff_link.account_id=account.id and staff_link.is_active) as staff_count
          from public.accounts account
          join public.account_authorization_state state on state.account_id=account.id
          join public.account_property_authorization_bridges bridge on bridge.account_id=account.id
         where account.id = any($1::uuid[])
         order by account.id`,
        [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
      );
      assert.equal(converted.length, 10);
      for (const row of UNLISTED_LEGACY_ROWS) {
        const fact = NORMAL_LEGACY_FACTS[row.accountId];
        const actual = converted.find((candidate) => candidate.account_id === row.accountId);
        assert.ok(actual, JSON.stringify({ expected: row.accountId, converted }));
        assert.equal(actual.authority_mode, 'normalized');
        assert.equal(actual.authority_version, row.authorityVersion + 1);
        assert.deepEqual(actual.property_access, []);
        assert.equal(actual.bridge_id, fact.bridgeId);
        assert.equal(actual.bridge_source_hash, rawHashesForTest(row.propertyId));
        assert.equal(actual.bridge_relationship_id, fact.relationshipId);
        assert.equal(actual.bridge_organization_id, fact.organizationId);
        assert.equal(actual.membership_count, fact.membershipIds.length);
        assert.equal(actual.grant_count, fact.grantIds.length);
        assert.equal(actual.staff_count, fact.staffIds.length);
        assert.deepEqual(await propertyIds(migrated.pg, row.accountId), [row.propertyId]);
      }
      assert.equal(
        Number((await rows<{ count: number }>(migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_legacy_write_events`))[0].count),
        0,
      );
      const nonSourceIssues = await rows(migrated.pg,
        `select issue.run_id, issue.account_id, issue.property_id, issue.issue_code, issue.details
           from public.account_access_cutover_preflight_issues issue
          where issue.run_id <> $1
          order by issue.run_id, issue.issue_code, issue.account_id`,
        [APPROVED_SOURCE_RUN_ID]);
      assert.equal(nonSourceIssues.length, 0, JSON.stringify(nonSourceIssues));
      assert.equal(
        Number((await rows<{ count: number }>(migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`))[0].count),
        4,
      );
      assert.equal(
        Number((await rows<{ count: number }>(migrated.pg,
          `select public._staxis_stage_c_active_relevant_queries_excluding_current()::integer as count`))[0].count),
        0,
      );
      const releaseEvidence = JSON.parse((await rows<{ old_deployment_fence_evidence: string }>(
        migrated.pg,
        `select old_deployment_fence_evidence
           from public.account_access_cutover_release_receipts`,
      ))[0].old_deployment_fence_evidence) as Record<string, unknown>;
      assert.equal(releaseEvidence.activeRelevantQueriesExcludingCurrent, 0);
      assert.equal(releaseEvidence.activeRelevantQueriesContract, ACCESS_STAGE_C_ACTIVE_RELEVANT_QUERIES_CONTRACT);
      assert.equal(
        releaseEvidence.activeRelevantQueriesBinding,
        `activeRelevantQueriesExcludingCurrent=0|activeRelevantQueriesContract=${ACCESS_STAGE_C_ACTIVE_RELEVANT_QUERIES_CONTRACT}`,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('replays all ten preconverted normal-legacy rows without reimport, version bump, or duplication', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          for (const replayRow of UNLISTED_LEGACY_ROWS) {
            await seedPreconvertedNormalLegacyReplayRow(hookPg, replayRow);
          }
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
        },
      },
    );
    try {
      assert.equal(
        migrated.report.applied.includes(MIGRATION),
        true,
        JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      const replayStates = await rows<{
        account_id: string;
        authority_mode: string;
        authority_version: number;
        property_access: string[];
      }>(
        migrated.pg,
        `select state.authority_mode,state.authority_version,account.property_access
                ,state.account_id
           from public.account_authorization_state state
           join public.accounts account on account.id=state.account_id
          where state.account_id = any($1::uuid[])
          order by state.account_id`,
        [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
      );
      assert.equal(replayStates.length, UNLISTED_LEGACY_ROWS.length);
      const replayStateByAccount = new Map(replayStates.map((state) => [state.account_id, state]));
      const bridgeCounts = await rows<{ account_id: string; count: number }>(
        migrated.pg,
        `select account_id,count(*)::integer as count
           from public.account_property_authorization_bridges
          where account_id = any($1::uuid[])
          group by account_id`,
        [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
      );
      assert.equal(bridgeCounts.length, UNLISTED_LEGACY_ROWS.length);
      assert.ok(bridgeCounts.every((row) => Number(row.count) === 1));
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests
            where status='converted'`,
        ))[0].count),
        UNLISTED_LEGACY_ROWS.length,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts
            where account_id = any($1::uuid[])`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        4,
      );

      for (const replayRow of UNLISTED_LEGACY_ROWS) {
        const fact = NORMAL_LEGACY_FACTS[replayRow.accountId];
        const replayState = replayStateByAccount.get(replayRow.accountId);
        assert.ok(replayState, `missing replay state for ${replayRow.accountId}`);
        assert.equal(replayState.authority_mode, 'normalized');
        assert.equal(replayState.authority_version, replayRow.authorityVersion + 1);
        assert.deepEqual(replayState.property_access, []);
        assert.deepEqual(await propertyIds(migrated.pg, replayRow.accountId), [replayRow.propertyId]);

        const bridge = (await rows<{
          id: string;
          status: string;
          source_legacy_scope_hash: string;
          cutover_relationship_id: string;
          cutover_organization_id: string;
          retired_at: string | null;
        }>(
          migrated.pg,
          `select id,status,source_legacy_scope_hash,cutover_relationship_id,
                  cutover_organization_id,retired_at
             from public.account_property_authorization_bridges
            where account_id=$1`,
          [replayRow.accountId],
        ))[0];
        assert.deepEqual(bridge, {
          id: fact.bridgeId,
          status: 'active',
          source_legacy_scope_hash: rawHashesForTest(replayRow.propertyId),
          cutover_relationship_id: fact.relationshipId,
          cutover_organization_id: fact.organizationId,
          retired_at: null,
        });

        const memberships = await rows<{
          id: string;
          organization_id: string;
          status: string;
          ended_at: string | null;
        }>(
          migrated.pg,
          `select id,organization_id,status,ended_at
             from public.organization_memberships
            where account_id=$1 order by id`,
          [replayRow.accountId],
        );
        assert.deepEqual(memberships.map((membership) => membership.id), fact.membershipIds);
        assert.equal(memberships.filter((membership) => membership.status === 'active').length, 1);
        const revokedMembership = fact.revokedMembership;
        if (revokedMembership) {
          const revoked = memberships.find((membership) => membership.id === revokedMembership.id);
          assert.deepEqual(revoked, {
            id: revokedMembership.id,
            organization_id: revokedMembership.organizationId,
            status: 'revoked',
            ended_at: revoked?.ended_at,
          });
          assert.ok(revoked?.ended_at);
        }

        const grants = await rows<{
          id: string;
          organization_id: string;
          membership_id: string;
          access_profile: string;
          scope_type: string;
          property_relationship_id: string | null;
          property_id: string | null;
          status: string;
          source: string;
          version: number;
        }>(
          migrated.pg,
          `select grant_row.id,grant_row.organization_id,grant_row.membership_id,
                  grant_row.access_profile,grant_row.scope_type,
                  grant_row.property_relationship_id,grant_row.property_id,
                  grant_row.status,grant_row.source,grant_row.version
             from public.organization_access_grants grant_row
             join public.organization_memberships membership on membership.id=grant_row.membership_id
            where membership.account_id=$1 and grant_row.status='active'
            order by grant_row.id`,
          [replayRow.accountId],
        );
        assert.equal(grants.length, fact.grantIds.length);
        assert.equal(grants[0]?.id, fact.grantIds[0]);
        assert.deepEqual(grants[0], {
          id: fact.grantIds[0],
          organization_id: fact.compatibilityOrganizationId,
          membership_id: fact.membershipIds.at(-1),
          access_profile: fact.grantProfile,
          scope_type: fact.grantScopeType,
          property_relationship_id: fact.grantRelationshipId,
          property_id: fact.grantPropertyId,
          status: 'active',
          source: 'legacy_backfill',
          version: 1,
        });

        const staffLinks = await rows<{
          staff_id: string;
          property_id: string;
          is_active: boolean;
          source: string;
        }>(
          migrated.pg,
          `select staff_id,property_id,is_active,source
             from public.account_property_staff_links
            where account_id=$1 and is_active order by staff_id`,
          [replayRow.accountId],
        );
        assert.deepEqual(staffLinks.map((link) => link.staff_id), fact.staffIds);
        assert.ok(staffLinks.every((link) =>
          link.property_id === replayRow.propertyId && link.is_active && link.source === 'legacy_backfill'));
        assert.equal(
          (await rows<{ staff_id: string | null }>(
            migrated.pg,
            `select staff_id from public.accounts where id=$1`,
            [replayRow.accountId],
          ))[0].staff_id,
          fact.accountStaffId,
        );
      }
    } finally {
      await migrated.pg.close();
    }
  });

  test('rejects a normalized replay when the persisted bridge fact drifts', async () => {
    const replayRow = UNLISTED_LEGACY_ROWS[0];
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await seedPreconvertedNormalLegacyReplayRow(hookPg, replayRow);
          await hookPg.query(
            `update public.account_property_authorization_bridges
                set source_legacy_scope_hash=repeat('0',64)
              where id=$1`,
            [NORMAL_LEGACY_FACTS[replayRow.accountId].bridgeId],
          );
          await hookPg.query(`delete from public.account_access_cutover_legacy_write_events`);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /normal-legacy normalized replay bridge drift/i,
      );
      assert.deepEqual(
        (await rows<{ authority_mode: string; authority_version: number; property_access: string[] }>(
          migrated.pg,
          `select state.authority_mode,state.authority_version,account.property_access
             from public.account_authorization_state state
             join public.accounts account on account.id=state.account_id
            where account.id=$1`,
          [replayRow.accountId],
        ))[0],
        {
          authority_mode: 'normalized',
          authority_version: replayRow.authorityVersion + 1,
          property_access: [],
        },
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests
            where status='converted'`,
        ))[0].count),
        1,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('reuses exact existing bridges and legacy compatibility facts without duplicate authority rows', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
        },
      },
    );
    try {
      assert.equal(
        migrated.report.applied.includes(MIGRATION),
        true,
        JSON.stringify(migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION)),
      );
      for (const row of UNLISTED_LEGACY_ROWS) {
        const fact = NORMAL_LEGACY_FACTS[row.accountId];
        const bridge = (await rows<{
          id: string;
          source_legacy_scope_hash: string;
          cutover_relationship_id: string;
          cutover_organization_id: string;
          status: string;
          retired_at: string | null;
        }>(
          migrated.pg,
          `select id,source_legacy_scope_hash,cutover_relationship_id,
                  cutover_organization_id,status,retired_at
             from public.account_property_authorization_bridges
            where account_id=$1`,
          [row.accountId],
        ))[0];
        assert.deepEqual(bridge, {
          id: fact.bridgeId,
          source_legacy_scope_hash: rawHashesForTest(row.propertyId),
          cutover_relationship_id: fact.relationshipId,
          cutover_organization_id: fact.organizationId,
          status: 'active',
          retired_at: null,
        });
        const memberships = await rows<{
          id: string;
          organization_id: string;
          status: string;
          ended_at: string | null;
          membership_scope: string | null;
          staxis_role: string | null;
        }>(
          migrated.pg,
          `select id,organization_id,status,ended_at,membership_scope,staxis_role
             from public.organization_memberships
            where account_id=$1 order by id`,
          [row.accountId],
        );
        assert.deepEqual(memberships.map((membership) => membership.id), [...fact.membershipIds].sort());
        for (const membership of memberships) {
          if (fact.revokedMembership?.id === membership.id) {
            assert.equal(membership.status, 'revoked');
            assert.ok(membership.ended_at);
            assert.equal(membership.membership_scope, 'company');
            assert.equal(membership.staxis_role, 'vp');
          } else {
            assert.equal(membership.organization_id, fact.compatibilityOrganizationId);
            assert.equal(membership.status, 'active');
            assert.equal(membership.ended_at, null);
            assert.equal(membership.membership_scope, null);
            assert.equal(membership.staxis_role, null);
          }
        }
        const grants = await rows<{
          id: string;
          organization_id: string;
          access_profile: string;
          scope_type: string;
          property_id: string | null;
          property_relationship_id: string | null;
          status: string;
          source: string;
          version: number;
        }>(
          migrated.pg,
          `select grant_row.id,grant_row.organization_id,grant_row.access_profile,
                  grant_row.scope_type,grant_row.property_id,
                  grant_row.property_relationship_id,grant_row.status,
                  grant_row.source,grant_row.version
             from public.organization_access_grants grant_row
             join public.organization_memberships membership
               on membership.id=grant_row.membership_id
            where membership.account_id=$1 and grant_row.status='active'
            order by grant_row.id`,
          [row.accountId],
        );
        assert.deepEqual(grants.map((grant) => grant.id), [...fact.grantIds].sort());
        assert.deepEqual(grants.map((grant) => ({
          organization_id: grant.organization_id,
          access_profile: grant.access_profile,
          scope_type: grant.scope_type,
          property_id: grant.property_id,
          property_relationship_id: grant.property_relationship_id,
          status: grant.status,
          source: grant.source,
          version: grant.version,
        })), [{
          organization_id: fact.compatibilityOrganizationId,
          access_profile: fact.grantProfile,
          scope_type: fact.grantScopeType,
          property_id: fact.grantPropertyId,
          property_relationship_id: fact.grantRelationshipId,
          status: 'active',
          source: 'legacy_backfill',
          version: 1,
        }]);
        const staff = await rows<{ staff_id: string }>(
          migrated.pg,
          `select staff_id from public.account_property_staff_links
            where account_id=$1 and is_active order by staff_id`,
          [row.accountId],
        );
        assert.deepEqual(staff.map((link) => link.staff_id), [...fact.staffIds].sort());
        assert.deepEqual(
          (await rows<{ staff_id: string | null }>(
            migrated.pg,
            `select staff_id from public.accounts where id=$1`,
            [row.accountId],
          ))[0].staff_id,
          fact.accountStaffId,
        );
        assert.equal(
          Number((await rows<{ count: number }>(
            migrated.pg,
            `select count(*)::integer as count
               from public.organization_access_grants grant_row
               join public.organization_memberships membership
                 on membership.id=grant_row.membership_id
              where membership.account_id=$1
                and grant_row.source <> 'legacy_backfill'`,
            [row.accountId],
          ))[0].count),
          0,
        );
        assert.deepEqual(await propertyIds(migrated.pg, row.accountId), [row.propertyId]);
      }
    } finally {
      await migrated.pg.close();
    }
  });

  test('rolls back the ten-row conversion when an existing bridge fact mismatches the manifest', async () => {
    const mismatchedRow = UNLISTED_LEGACY_ROWS[0];
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await hookPg.query(
            `update public.account_property_authorization_bridges
                set source_legacy_scope_hash=repeat('0',64)
              where id=$1`,
            [NORMAL_LEGACY_FACTS[mismatchedRow.accountId].bridgeId],
          );
          await hookPg.query(`delete from public.account_access_cutover_legacy_write_events`);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /normal-legacy bridge identity\/topology\/state mismatch|normal-legacy manifest fact drift/i,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.accounts
            where id = any($1::uuid[]) and cardinality(property_access)>0`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        10,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.accounts account
             join public.account_authorization_state state on state.account_id=account.id
            where account.id = any($1::uuid[]) and state.authority_mode='normalized'`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed before conversion when the bound normal-legacy manifest hash mismatches', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: '0'.repeat(64),
          });
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /normal-legacy conversion requires the exact manifest hash/i,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.accounts
            where id = any($1::uuid[]) and cardinality(property_access)>0`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        10,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed when active relevant query evidence binding drifts', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
            activeRelevantQueriesExcludingCurrent: 1,
          });
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /exact active relevant query count and contract in release fence evidence/i,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.accounts
            where id = any($1::uuid[]) and cardinality(property_access)>0`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        10,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rolls back all ten rows when the guarded normal-legacy CAS clear races', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await recordApprovedSourceDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
          await hookPg.exec(`
            create or replace function public.stage_c_test_normal_legacy_cas_race()
            returns trigger
            language plpgsql
            as $$
            begin
              if old.id = '0237e48f-5fe2-487c-8ae8-ab61df14da88'::uuid
                 and cardinality(coalesce(old.property_access,'{}'::uuid[])) > 0
                 and cardinality(coalesce(new.property_access,'{}'::uuid[])) = 0 then
                raise exception 'stage-c test normal-legacy CAS race';
              end if;
              return new;
            end;
            $$;
            drop trigger if exists stage_c_test_normal_legacy_cas_race on public.accounts;
            create trigger stage_c_test_normal_legacy_cas_race
              before update of property_access on public.accounts
              for each row execute function public.stage_c_test_normal_legacy_cas_race();
          `);
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /stage-c test normal-legacy CAS race|normal-legacy raw-array CAS failed/i,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.accounts
            where id = any($1::uuid[]) and cardinality(property_access)>0`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        10,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.accounts account
             join public.account_authorization_state state on state.account_id=account.id
            where account.id = any($1::uuid[]) and state.authority_mode='normalized'`,
          [UNLISTED_LEGACY_ROWS.map((row) => row.accountId)],
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_normal_legacy_manifests`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed on an unexpected eleventh legacy raw scope without broad-clearing it', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await seedUnlistedLegacyRowsFixture(hookPg);
          await insertCanonicalAccount(
            hookPg,
            'f4269000-0000-4000-8000-000000000011',
            'f4269100-0000-4000-8000-000000000011',
            'eleven',
            'Unexpected Eleventh',
            'housekeeping',
            'eleven@example.test',
          );
          await hookPg.query(
            `update public.accounts set property_access=array[$2::uuid] where id=$1`,
            ['f4269000-0000-4000-8000-000000000011', PID_L1],
          );
          await hookPg.query(
            `delete from public.account_authorization_state where account_id=$1`,
            ['f4269000-0000-4000-8000-000000000011'],
          );
          await hookPg.query(
            `insert into public.account_authorization_state(
               account_id,authority_mode,authority_version,legacy_scope_hash,
               normalized_scope_hash,cutover_at,cutover_reason
             ) values ($1,'legacy',1,encode(sha256(convert_to($2::text,'UTF8')),'hex'),
                       encode(sha256(convert_to('', 'UTF8')),'hex'),null,
                       'Unexpected eleventh raw scope')`,
            ['f4269000-0000-4000-8000-000000000011', PID_L1],
          );
          await hookPg.query(`delete from public.account_access_cutover_legacy_write_events`);

          await recordAllProductionResidueDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg, {
            conversionManifestHash: NORMAL_LEGACY_MANIFEST_HASH,
          });
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /normal-legacy manifest requires exactly ten nonempty rows/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access
             from public.accounts
            where id in ($1,$2,$3,$4)
            order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_HANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_HANK, property_access: [] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.deepEqual(
        (await rows<{ stage: string; enforcement_enabled: boolean }>(
          migrated.pg,
          `select stage,enforcement_enabled
             from public.account_access_cutover_status
            where id is true`,
        ))[0],
        { stage: 'A', enforcement_enabled: false },
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_dispositions
            where status='unconsumed'`,
        ))[0].count),
        3,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at
             from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('binds the approved 85981 source manifest, preserves exact issue hashes, and creates a fresh suffix run', async () => {
    let sourcePreflightRunId = '';
    let freshPreflightRunId = '';
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          sourcePreflightRunId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          assert.equal(sourcePreflightRunId, APPROVED_SOURCE_RUN_ID);
          const reused = await jsonRpc(
            hookPg,
            `select public.staxis_preflight_authorization_cutover_stage_c() as value`,
          );
          assert.deepEqual(reused, {
            ok: false,
            runId: APPROVED_SOURCE_RUN_ID,
            issueCount: 6,
            stage: 'C',
            reusedExisting: true,
          });
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_preflight_runs
                where id=$1`,
              [APPROVED_SOURCE_RUN_ID],
            ))[0].count),
            1,
            'prefix replay must not create a replacement source snapshot',
          );

          const manifests = await rows<{
            issue_id: string;
            source: string;
            raw_property_ids: string[];
            raw_scope_hash: string;
            stage_a_mapping: unknown;
          }>(
            hookPg,
            `select issue_id,source,raw_property_ids,raw_scope_hash,stage_a_mapping
               from public.account_access_cutover_repair_manifests
              where preflight_run_id=$1 order by issue_id`,
            [APPROVED_SOURCE_RUN_ID],
          );
          assert.equal(manifests.length, 6);
          assert.deepEqual(
            manifests.map((row) => row.issue_id),
            Object.values(APPROVED_SOURCE_ISSUES).sort(),
          );
          assert.ok(manifests.every((row) => row.source === 'production-85981f5e-a387-4af3-ae10-b9bc1e1e9567'));
          for (const manifest of manifests) {
            assert.equal(manifest.raw_scope_hash, sha256(manifest.raw_property_ids.join(',')));
          }
          const wrapperManifest = manifests.find((row) => row.issue_id === APPROVED_SOURCE_ISSUES.wrapper);
          assert.ok(wrapperManifest);
          assert.ok(Array.isArray(wrapperManifest.stage_a_mapping));
          assert.equal((wrapperManifest.stage_a_mapping as unknown[]).length, 5);

          await assert.rejects(
            hookPg.query(
              `select public._staxis_materialize_stage_c_production_manifest($1)`,
              ['2f31759a-2cd9-48ee-a458-c0ddea0e7d93'],
            ),
            /rejects non-authoritative source run/i,
            'the superseded 2f source must never substitute for 85981',
          );
          for (const mutation of [
            `update public.account_access_cutover_preflight_issues
                set details=jsonb_build_object('propertyIds', $2::uuid[], 'tampered', true)
              where id=$1`,
            `update public.account_access_cutover_preflight_issues
                set account_id=$2,
                    details=jsonb_build_object('propertyIds', $3::uuid[])
              where id=$1`,
          ]) {
            await hookPg.exec('begin;');
            try {
              const parameters = mutation.includes('account_id')
                ? [APPROVED_SOURCE_ISSUES.gus, ACCOUNT_ANA, [PID_A2]]
                : [APPROVED_SOURCE_ISSUES.gus, [APPROVED_SOURCE_PROPERTIES.testing]];
              await hookPg.query(mutation, parameters);
              await assert.rejects(
                hookPg.query(
                  `select public._staxis_materialize_stage_c_production_manifest($1)`,
                  [APPROVED_SOURCE_RUN_ID],
                ),
                /approved 85981|allowlist|altered|mismatched/i,
                'altered direct source details or an unlisted valid tuple must fail closed',
              );
            } finally {
              await hookPg.exec('rollback;');
            }
          }
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_repair_manifests
                where preflight_run_id=$1`,
              [APPROVED_SOURCE_RUN_ID],
            ))[0].count),
            6,
            'negative source checks must preserve the original six manifests',
          );

          const sourceStates = await rows<{
            account_id: string;
            authority_mode: string;
            authority_version: number;
          }>(
            hookPg,
            `select account_id,authority_mode,authority_version
               from public.account_authorization_state
              where account_id in ($1,$2,$3,$4)
              order by account_id`,
            [
              APPROVED_SOURCE_ACCOUNTS.admin,
              APPROVED_SOURCE_ACCOUNTS.gus,
              APPROVED_SOURCE_ACCOUNTS.dolores,
              APPROVED_SOURCE_ACCOUNTS.greta,
            ],
          );
          const byAccount = new Map(sourceStates.map((state) => [state.account_id, state]));
          const canonicalIds = async (accountId: string): Promise<string[]> => (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id
               from public._staxis_account_property_authorizations($1)
              order by property_id`,
            [accountId],
          )).map((row) => row.property_id);

          await assert.rejects(
            recordRepairDisposition(hookPg, {
              preflightRunId: APPROVED_SOURCE_RUN_ID,
              accountId: APPROVED_SOURCE_ACCOUNTS.admin,
              propertyId: APPROVED_SOURCE_PROPERTIES.admin,
              issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
              issueIds: [APPROVED_SOURCE_ISSUES.adminAccess, APPROVED_SOURCE_ISSUES.adminAccount, APPROVED_SOURCE_ISSUES.wrapper],
              decision: 'admin_global',
              rawPropertyIds: [APPROVED_SOURCE_PROPERTIES.admin],
              rawScopeHash: '0'.repeat(64),
              canonicalPropertyIds: [],
              authorityMode: byAccount.get(APPROVED_SOURCE_ACCOUNTS.admin)?.authority_mode ?? '',
              authorityVersion: byAccount.get(APPROVED_SOURCE_ACCOUNTS.admin)?.authority_version ?? 0,
              reason: 'admin_global_role_residue',
            }),
            /immutable manifest issue UUIDs|evidence no longer matches/i,
            'a caller-supplied raw scope hash cannot replace the approved source hash',
          );

          await assert.rejects(
            recordRepairDisposition(hookPg, {
              preflightRunId: 'c4267000-0000-4000-8000-000000000010',
              accountId: APPROVED_SOURCE_ACCOUNTS.admin,
              propertyId: APPROVED_SOURCE_PROPERTIES.admin,
              issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
              issueIds: [
                APPROVED_SOURCE_ISSUES.adminAccess,
                APPROVED_SOURCE_ISSUES.adminAccount,
                APPROVED_SOURCE_ISSUES.wrapper,
              ],
              decision: 'admin_global',
              rawPropertyIds: [APPROVED_SOURCE_PROPERTIES.admin],
              canonicalPropertyIds: [],
              authorityMode: byAccount.get(APPROVED_SOURCE_ACCOUNTS.admin)?.authority_mode ?? '',
              authorityVersion: byAccount.get(APPROVED_SOURCE_ACCOUNTS.admin)?.authority_version ?? 0,
              reason: 'admin_global_role_residue',
            }),
            /immutable manifest issue UUIDs|exact issue rows/i,
            'a stale source run cannot borrow the approved issue IDs',
          );

          await recordRepairDisposition(hookPg, {
            preflightRunId: APPROVED_SOURCE_RUN_ID,
            accountId: APPROVED_SOURCE_ACCOUNTS.admin,
            propertyId: APPROVED_SOURCE_PROPERTIES.admin,
            issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
            issueIds: [APPROVED_SOURCE_ISSUES.adminAccess, APPROVED_SOURCE_ISSUES.adminAccount, APPROVED_SOURCE_ISSUES.wrapper],
            decision: 'admin_global',
            rawPropertyIds: [APPROVED_SOURCE_PROPERTIES.admin],
            canonicalPropertyIds: [],
            authorityMode: byAccount.get(APPROVED_SOURCE_ACCOUNTS.admin)?.authority_mode ?? '',
            authorityVersion: byAccount.get(APPROVED_SOURCE_ACCOUNTS.admin)?.authority_version ?? 0,
            reason: 'admin_global_role_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: APPROVED_SOURCE_RUN_ID,
            accountId: APPROVED_SOURCE_ACCOUNTS.gus,
            propertyId: APPROVED_SOURCE_PROPERTIES.testing,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            issueIds: [APPROVED_SOURCE_ISSUES.gus, APPROVED_SOURCE_ISSUES.wrapper],
            decision: 'canonical_duplicate',
            rawPropertyIds: [APPROVED_SOURCE_PROPERTIES.testing],
            canonicalPropertyIds: await canonicalIds(APPROVED_SOURCE_ACCOUNTS.gus),
            authorityMode: byAccount.get(APPROVED_SOURCE_ACCOUNTS.gus)?.authority_mode ?? '',
            authorityVersion: byAccount.get(APPROVED_SOURCE_ACCOUNTS.gus)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: APPROVED_SOURCE_RUN_ID,
            accountId: APPROVED_SOURCE_ACCOUNTS.dolores,
            propertyId: APPROVED_SOURCE_PROPERTIES.testing,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            issueIds: [APPROVED_SOURCE_ISSUES.dolores, APPROVED_SOURCE_ISSUES.wrapper],
            decision: 'revoked_canonical_empty',
            rawPropertyIds: [APPROVED_SOURCE_PROPERTIES.testing],
            canonicalPropertyIds: await canonicalIds(APPROVED_SOURCE_ACCOUNTS.dolores),
            authorityMode: byAccount.get(APPROVED_SOURCE_ACCOUNTS.dolores)?.authority_mode ?? '',
            authorityVersion: byAccount.get(APPROVED_SOURCE_ACCOUNTS.dolores)?.authority_version ?? 0,
            reason: 'revoked_canonical_empty_residue',
          });
          await recordRepairDisposition(hookPg, {
            preflightRunId: APPROVED_SOURCE_RUN_ID,
            accountId: APPROVED_SOURCE_ACCOUNTS.greta,
            propertyId: APPROVED_SOURCE_PROPERTIES.portArthur,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            issueIds: [APPROVED_SOURCE_ISSUES.greta, APPROVED_SOURCE_ISSUES.wrapper],
            decision: 'canonical_duplicate',
            rawPropertyIds: [APPROVED_SOURCE_PROPERTIES.portArthur],
            canonicalPropertyIds: await canonicalIds(APPROVED_SOURCE_ACCOUNTS.greta),
            authorityMode: byAccount.get(APPROVED_SOURCE_ACCOUNTS.greta)?.authority_mode ?? '',
            authorityVersion: byAccount.get(APPROVED_SOURCE_ACCOUNTS.greta)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          });
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_repair_dispositions
                where preflight_run_id=$1`,
              [APPROVED_SOURCE_RUN_ID],
            ))[0].count),
            4,
          );
          await authorizeAccessStageCRelease(hookPg);
        },
      },
    );
    try {
      assert.ok(migrated.report.applied.includes(MIGRATION), JSON.stringify(migrated.report.failedAtRuntime));
      assert.deepEqual(migrated.report.failedAtRuntime.filter((entry) => entry.file === MIGRATION), []);
      const status = (await rows<{
        stage: string;
        enforcement_enabled: boolean;
        final_preflight_run_id: string;
        details: Record<string, unknown>;
      }>(
        migrated.pg,
        `select stage,enforcement_enabled,final_preflight_run_id,details
           from public.account_access_cutover_status where id is true`,
      ))[0];
      freshPreflightRunId = String(status.details.repairPreflightRunId);
      assert.equal(status.stage, 'C');
      assert.equal(status.enforcement_enabled, true);
      assert.equal(status.final_preflight_run_id, freshPreflightRunId);
      assert.equal(status.details.repairSourcePreflightRunId, APPROVED_SOURCE_RUN_ID);
      assert.notEqual(freshPreflightRunId, APPROVED_SOURCE_RUN_ID);

      assert.deepEqual(
        await rows<{ id: string; status: string; issue_count: number }>(
          migrated.pg,
          `select id,status,issue_count
             from public.account_access_cutover_preflight_runs
            where id in ($1,$2) order by id`,
          [APPROVED_SOURCE_RUN_ID, freshPreflightRunId],
        ),
        [
          { id: APPROVED_SOURCE_RUN_ID, status: 'failed', issue_count: 6 },
          { id: freshPreflightRunId, status: 'passed', issue_count: 0 },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts
            where preflight_run_id=$1`,
          [APPROVED_SOURCE_RUN_ID],
        ))[0].count),
        4,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_dispositions
            where preflight_run_id=$1 and status='consumed'
              and consumed_preflight_run_id=$2`,
          [APPROVED_SOURCE_RUN_ID, freshPreflightRunId],
        ))[0].count),
        4,
      );
      const consumedIssueIds = await rows<{ issue_ids: string[] }>(
        migrated.pg,
        `select issue_ids
           from public.account_access_cutover_repair_dispositions
          where preflight_run_id=$1 and status='consumed'`,
        [APPROVED_SOURCE_RUN_ID],
      );
      assert.ok(consumedIssueIds.every((row) => row.issue_ids.includes(APPROVED_SOURCE_ISSUES.wrapper)));
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_manifests
            where preflight_run_id=$1 and source=$2 and status='consumed'`,
          [APPROVED_SOURCE_RUN_ID, 'production-85981f5e-a387-4af3-ae10-b9bc1e1e9567'],
        ))[0].count),
        6,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('upgrades a partial 0426 prefix without replacing historical 2f evidence or current 85981 state', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file !== MIGRATION) return;
        await seedLegacyRepairManifestPrefix(hookPg);
        await seedApprovedProductionSourceFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          const constraints = await rows<{
            conname: string;
            convalidated: boolean;
            definition: string;
          }>(
            hookPg,
            `select conname,convalidated,pg_get_constraintdef(oid) as definition
               from pg_catalog.pg_constraint
              where conrelid='public.account_access_cutover_repair_manifests'::regclass
                and contype='c'
              order by conname`,
          );
          const sourceConstraint = constraints.find(
            (constraint) => constraint.conname === 'account_access_cutover_repair_manifests_source_run_exact_check',
          );
          assert.ok(sourceConstraint);
          assert.equal(sourceConstraint.convalidated, false);
          assert.match(sourceConstraint.definition, /production-85981f5e-a387-4af3-ae10-b9bc1e1e9567/);
          assert.doesNotMatch(sourceConstraint.definition, /production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93/);

          const historicalBefore = await rows<{
            issue_id: string;
            preflight_run_id: string;
            source: string;
            details: Record<string, unknown>;
          }>(
            hookPg,
            `select issue_id,preflight_run_id,source,details
               from public.account_access_cutover_repair_manifests
              where preflight_run_id=$1`,
            ['2f31759a-2cd9-48ee-a458-c0ddea0e7d93'],
          );
          assert.deepEqual(historicalBefore, [{
            issue_id: 'c426e000-0000-4000-8000-000000000001',
            preflight_run_id: '2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
            source: 'production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
            details: { historical: true, sourceRunId: '2f31759a-2cd9-48ee-a458-c0ddea0e7d93' },
          }]);

          await assert.rejects(
            hookPg.query(
              `insert into public.account_access_cutover_repair_manifests(
                 issue_id,preflight_run_id,source,issue_code,raw_property_ids,
                 raw_scope_hash
               ) values ($1,$2,$3,'stale_source','{}'::uuid[],$4)`,
              [
                'c426e000-0000-4000-8000-000000000002',
                '2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
                'production-2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
                sha256(''),
              ],
            ),
            /source_run_exact_check|check constraint/i,
            'new 2f artifacts must be rejected after the upgrade',
          );
          await assert.rejects(
            hookPg.query(
              `insert into public.account_access_cutover_repair_manifests(
                 issue_id,preflight_run_id,source,issue_code,raw_property_ids,
                 raw_scope_hash
               ) values ($1,$2,$3,'wrong_run','{}'::uuid[],$4)`,
              [
                'c426e000-0000-4000-8000-000000000003',
                '2f31759a-2cd9-48ee-a458-c0ddea0e7d93',
                'production-85981f5e-a387-4af3-ae10-b9bc1e1e9567',
                sha256(''),
              ],
            ),
            /source_run_exact_check|check constraint/i,
            'the approved source label cannot be paired with a stale run',
          );

          const reused = await jsonRpc(
            hookPg,
            `select public.staxis_preflight_authorization_cutover_stage_c() as value`,
          );
          assert.deepEqual(reused, {
            ok: false,
            runId: APPROVED_SOURCE_RUN_ID,
            issueCount: 6,
            stage: 'C',
            reusedExisting: true,
          });
          assert.deepEqual(
            await jsonRpc(
              hookPg,
              `select jsonb_build_object(
                 'manifestCount', public._staxis_materialize_stage_c_production_manifest($1),
                 'currentCount', (
                   select count(*) from public.account_access_cutover_repair_manifests
                    where preflight_run_id=$1
                 )
               ) as value`,
              [APPROVED_SOURCE_RUN_ID],
            ),
            { manifestCount: 6, currentCount: 6 },
            'replaying the prefix must reuse the exact 85981 manifests',
          );
          assert.deepEqual(
            await rows<{
              issue_id: string;
              preflight_run_id: string;
              source: string;
              details: Record<string, unknown>;
            }>(
              hookPg,
              `select issue_id,preflight_run_id,source,details
                 from public.account_access_cutover_repair_manifests
                where preflight_run_id=$1`,
              ['2f31759a-2cd9-48ee-a458-c0ddea0e7d93'],
            ),
            historicalBefore,
            'replay must preserve the old historical row byte-for-byte at the JSON value level',
          );
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_repair_dispositions
                where preflight_run_id=$1`,
              [APPROVED_SOURCE_RUN_ID],
            ))[0].count),
            0,
          );
          const statusAfterReplay = (await rows<{
            stage: string;
            enforcement_enabled: boolean;
            final_preflight_run_id: string;
          }>(
            hookPg,
            `select stage,enforcement_enabled,final_preflight_run_id
               from public.account_access_cutover_status
              where id is true`,
          ))[0];
          assert.deepEqual(statusAfterReplay, {
            stage: 'A',
            enforcement_enabled: false,
            final_preflight_run_id: APPROVED_SOURCE_RUN_ID,
          });
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_preflight_runs
                where id=$1`,
              [APPROVED_SOURCE_RUN_ID],
            ))[0].count),
            1,
            'prefix replay must not replace the approved failed source snapshot',
          );
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_repair_receipts`,
            ))[0].count),
            0,
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /release gate requires a same-session receipt|repair phase requires a same-session release receipt|preflight rejected finalization/i,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('attributes only matching Stage A wrapper samples to four exact dispositions and preserves receipt rollback', async () => {
    let sourcePreflightRunId = '';
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedWrapperMappingFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          sourcePreflightRunId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const states = await rows<{
            account_id: string;
            authority_mode: string;
            authority_version: number;
          }>(
            hookPg,
            `select account_id,authority_mode,authority_version
               from public.account_authorization_state
              where account_id in ($1,$2,$3,$4)
              order by account_id`,
            [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK, ACCOUNT_ANA],
          );
          const byAccount = new Map(states.map((state) => [state.account_id, state]));
          const mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          const frankCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_FRANK],
          )).map((row) => row.property_id);
          const anaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_ANA],
          )).map((row) => row.property_id);
          const wrapperIssue = (await rows<{ details: Record<string, unknown> }>(
            hookPg,
            `select details
               from public.account_access_cutover_preflight_issues
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId],
          ))[0];
          assert.ok(wrapperIssue, 'Stage A wrapper evidence must be present');

          const adminDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_ADMIN,
            propertyId: PID_A1,
            issueCodes: ['admin_legacy_access', 'admin_legacy_account', 'stage_a_invariant_failure'],
            decision: 'admin_global',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: [],
            authorityMode: byAccount.get(ACCOUNT_ADMIN)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_ADMIN)?.authority_version ?? 0,
            reason: 'admin_global_role_residue',
          };
          const mariaDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_MARIA,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: mariaCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_MARIA)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_MARIA)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          };
          const frankDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_FRANK,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'revoked_canonical_empty',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: frankCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_FRANK)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_FRANK)?.authority_version ?? 0,
            reason: 'revoked_canonical_empty_residue',
          };
          const anaDisposition = {
            preflightRunId: sourcePreflightRunId,
            accountId: ACCOUNT_ANA,
            propertyId: PID_A2,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A2],
            canonicalPropertyIds: anaCanonicalIds,
            authorityMode: byAccount.get(ACCOUNT_ANA)?.authority_mode ?? '',
            authorityVersion: byAccount.get(ACCOUNT_ANA)?.authority_version ?? 0,
            reason: 'canonical_duplicate_residue',
          };

          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...adminDisposition,
              issueCodes: ['admin_legacy_access', 'admin_legacy_account'],
            }),
            /exact issue rows/i,
            'omitting the matching wrapper must not bypass it',
          );
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count
                 from public.account_access_cutover_repair_dispositions`,
            ))[0].count),
            0,
          );

          await hookPg.query(
            `update public.account_access_cutover_preflight_issues
                set details=jsonb_set(details,'{stageAInvariant,sample}',$2::jsonb,true)
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId, JSON.stringify([{
              accountId: ACCOUNT_HANK,
              propertyId: PID_A1,
              code: 'legacy_row_without_shadow_translation',
              details: {},
            }])],
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, mariaDisposition),
            /exact issue rows|immutable manifest issue UUIDs/i,
            'a wrapper sample for another account must not be attributed to this disposition',
          );
          await hookPg.query(
            `update public.account_access_cutover_preflight_issues
                set details=jsonb_set(details,'{stageAInvariant,sample}',$2::jsonb,true)
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId, JSON.stringify([{
              accountId: ACCOUNT_MARIA,
              propertyId: PID_A2,
              code: 'legacy_row_without_shadow_translation',
              details: {},
            }])],
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, mariaDisposition),
            /exact issue rows|immutable manifest issue UUIDs/i,
            'a wrapper sample for another property must not be attributed to this disposition',
          );
          await hookPg.query(
            `update public.account_access_cutover_preflight_issues
                set details=$2::jsonb
              where run_id=$1 and issue_code='stage_a_invariant_failure'`,
            [sourcePreflightRunId, JSON.stringify(wrapperIssue.details)],
          );

          await recordRepairDisposition(hookPg, adminDisposition);
          await recordRepairDisposition(hookPg, mariaDisposition);
          await recordRepairDisposition(hookPg, frankDisposition);
          await recordRepairDisposition(hookPg, anaDisposition);
          const replay = await recordRepairDisposition(hookPg, mariaDisposition);
          assert.equal(replay.idempotentReplay, true);
          const repairable = (await rows<{ value: boolean }>(
            hookPg,
            `select public._staxis_stage_c_preflight_repairable($1) as value`,
            [sourcePreflightRunId],
          ))[0].value;
          assert.equal(
            repairable,
            true,
            'all direct issue rows and wrapper samples must be dispositioned',
          );

          const dispositions = await rows<{
            account_id: string;
            property_id: string;
            issue_codes: string[];
            raw_property_ids: string[];
            raw_scope_hash: string;
            canonical_property_ids: string[];
            canonical_scope_hash: string;
          }>(
            hookPg,
            `select account_id,property_id,issue_codes,raw_property_ids,raw_scope_hash,
                    canonical_property_ids,canonical_scope_hash
               from public.account_access_cutover_repair_dispositions
              where preflight_run_id=$1 order by account_id,property_id`,
            [sourcePreflightRunId],
          );
          assert.equal(dispositions.length, 4);
          for (const disposition of dispositions) {
            assert.ok(disposition.issue_codes.includes('stage_a_invariant_failure'));
            assert.equal(disposition.raw_scope_hash, sha256(disposition.raw_property_ids.join(',')));
            assert.equal(disposition.canonical_scope_hash, sha256(disposition.canonical_property_ids.join(',')));
          }
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /release gate requires a same-session receipt|repair phase requires a same-session release receipt/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3,$4) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_MARIA, ACCOUNT_FRANK, ACCOUNT_ANA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_ANA, property_access: [PID_A2] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_dispositions
            where preflight_run_id=$1 and status='unconsumed'`,
          [sourcePreflightRunId],
        ))[0].count),
        4,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rejects unavailable and unrelated Stage A wrapper samples before recording a disposition', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          const runId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const mariaState = (await rows<{ authority_mode: string; authority_version: number }>(
            hookPg,
            `select authority_mode,authority_version
               from public.account_authorization_state where account_id=$1`,
            [ACCOUNT_MARIA],
          ))[0];
          const mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          for (const code of ['stage_a_invariant_unavailable', 'unrelated_stage_a_sample']) {
            if (code === 'stage_a_invariant_unavailable') {
              await hookPg.query(
                `update public.account_access_cutover_preflight_issues
                    set issue_code='stage_a_invariant_unavailable', details=$2::jsonb
                  where run_id=$1 and issue_code='stage_a_invariant_failure'`,
                [runId, JSON.stringify({ reason: 'Stage A service report unavailable' })],
              );
            } else {
              await hookPg.query(
                `update public.account_access_cutover_preflight_issues
                    set details=jsonb_set(details,'{stageAInvariant,sample}',$2::jsonb,true)
                  where run_id=$1 and issue_code='stage_a_invariant_failure'`,
                [runId, JSON.stringify([{
                  accountId: ACCOUNT_MARIA,
                  propertyId: PID_A1,
                  code,
                  details: {},
                }])],
              );
            }
            await assert.rejects(
              recordRepairDisposition(hookPg, {
                preflightRunId: runId,
                accountId: ACCOUNT_MARIA,
                propertyId: PID_A1,
                issueCodes: code === 'stage_a_invariant_unavailable'
                  ? ['normalized_legacy_residue']
                  : ['normalized_legacy_residue', 'stage_a_invariant_failure'],
                decision: 'canonical_duplicate',
                rawPropertyIds: [PID_A1],
                canonicalPropertyIds: mariaCanonicalIds,
                authorityMode: mariaState.authority_mode,
                authorityVersion: mariaState.authority_version,
                reason: 'canonical_duplicate_residue',
              }),
              code === 'stage_a_invariant_unavailable'
                ? /available Stage A invariant evidence/i
                : /supported Stage A invariant wrapper evidence/i,
            );
            if (code === 'stage_a_invariant_unavailable') {
              await hookPg.query(
                `update public.account_access_cutover_preflight_issues
                    set issue_code='stage_a_invariant_failure', details=$2::jsonb
                  where run_id=$1 and issue_code='stage_a_invariant_unavailable'`,
                [runId, JSON.stringify({
                  stageAInvariant: {
                    sample: [{
                      accountId: ACCOUNT_MARIA,
                      propertyId: PID_A1,
                      code: 'unrelated_stage_a_sample',
                      details: {},
                    }],
                  },
                })],
              );
            }
          }
          assert.equal(
            Number((await rows<{ count: number }>(
              hookPg,
              `select count(*)::integer as count from public.account_access_cutover_repair_dispositions`,
            ))[0].count),
            0,
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_dispositions`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rejects unsupported or stale repair dispositions without mutating the failed preflight state', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedUnsupportedResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          const runId = (await rows<{ final_preflight_run_id: string }>(
            hookPg,
            `select final_preflight_run_id from public.account_access_cutover_status where id is true`,
          ))[0].final_preflight_run_id;
          const mariaState = (await rows<{ authority_mode: string; authority_version: number }>(
            hookPg,
            `select authority_mode,authority_version from public.account_authorization_state where account_id=$1`,
            [ACCOUNT_MARIA],
          ))[0];
          const mariaCanonicalIds = (await rows<{ property_id: string }>(
            hookPg,
            `select distinct property_id from public._staxis_account_property_authorizations($1) order by property_id`,
            [ACCOUNT_MARIA],
          )).map((row) => row.property_id);
          const validMaria = {
            preflightRunId: runId,
            accountId: ACCOUNT_MARIA,
            propertyId: PID_A1,
            issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
            decision: 'canonical_duplicate',
            rawPropertyIds: [PID_A1],
            canonicalPropertyIds: mariaCanonicalIds,
            authorityMode: mariaState.authority_mode,
            authorityVersion: mariaState.authority_version,
            reason: 'canonical_duplicate_residue',
          };
          await recordRepairDisposition(hookPg, validMaria);
          const replay = await recordRepairDisposition(hookPg, validMaria);
          assert.equal(replay.idempotentReplay, true);
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              reason: 'operator prose is not an approved repair reason',
            }),
            /incomplete or malformed/i,
          );

          const hankState = (await rows<{ authority_mode: string; authority_version: number }>(
            hookPg,
            `select authority_mode,authority_version from public.account_authorization_state where account_id=$1`,
            [ACCOUNT_HANK],
          ))[0];
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              preflightRunId: runId,
              accountId: ACCOUNT_HANK,
              propertyId: PID_L1,
              issueCodes: ['normalized_legacy_residue', 'stage_a_invariant_failure'],
              decision: 'revoked_canonical_empty',
              rawPropertyIds: [PID_L1],
              canonicalPropertyIds: [],
              authorityMode: hankState.authority_mode,
              authorityVersion: hankState.authority_version,
              reason: 'revoked_canonical_empty_residue',
            }),
            /ended canonical membership/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              rawScopeHash: '0'.repeat(64),
              reason: 'canonical_duplicate_residue',
            }),
            /evidence no longer matches/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              authorityVersion: mariaState.authority_version - 1,
              reason: 'canonical_duplicate_residue',
            }),
            /evidence no longer matches/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              propertyId: PID_A2,
              reason: 'canonical_duplicate_residue',
            }),
            /active is_test property topology|evidence no longer matches|exact issue rows|immutable manifest issue UUIDs|incomplete or malformed/i,
          );
          await hookPg.query(`update public.properties set is_test=false where id=$1`, [PID_A1]);
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              reason: 'canonical_duplicate_residue',
            }),
            /active is_test property topology/i,
          );
          await hookPg.query(`update public.properties set is_test=true where id=$1`, [PID_A1]);
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              operatorLabel: '',
              reason: 'canonical_duplicate_residue',
            }),
            /incomplete or malformed/i,
          );
          await assert.rejects(
            recordRepairDisposition(hookPg, {
              ...validMaria,
              accessBMergeSha: '0'.repeat(40),
              reason: 'canonical_duplicate_residue',
            }),
            /incomplete or malformed/i,
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /0426 Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2) order by id`,
          [ACCOUNT_HANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_HANK, property_access: [PID_L1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        (await rows<{ stage: string; enforcement_enabled: boolean }>(
          migrated.pg,
          `select stage,enforcement_enabled from public.account_access_cutover_status where id is true`,
        ))[0].stage,
        'A',
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_repair_receipts') as relation`,
        ))[0].relation,
        'account_access_cutover_repair_receipts',
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('rolls back every repair mutation when the release descendant SHA is stale', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await recordAllProductionResidueDispositions(hookPg, {
            deployedDescendantSha: '0'.repeat(40),
          });
          await authorizeAccessStageCRelease(hookPg);
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /active account or release evidence|0426 Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        (await rows<{ authority_mode: string }>(
          migrated.pg,
          `select authority_mode from public.account_authorization_state where account_id=$1`,
          [ACCOUNT_ADMIN],
        ))[0].authority_mode,
        'legacy',
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_dispositions
            where status='unconsumed'`,
        ))[0].count),
        3,
      );
    } finally {
      await migrated.pg.close();
    }
  });

    test('rolls back the repair transaction when a pending queue or legacy write appears after release approval', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await recordAllProductionResidueDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg);
          await hookPg.query(
            `insert into public.join_requests(
               id,property_id,account_id,name,phone,language,department,status
             ) values ($1,$2,$3,'Stage C race','512-555-2201','en','housekeeping','pending')`,
            [DIRTY_JOIN_REQUEST, PID_A1, ACCOUNT_HANK],
          );
          await hookPg.query(
            `insert into public.account_access_cutover_legacy_write_events(
               account_id,operation,previous_property_ids,next_property_ids,
               previous_scope_hash,next_scope_hash,reason
             ) values ($1,'UPDATE',$2::uuid[],$3::uuid[],$4,$5,'Stage C race evidence')`,
            [
              ACCOUNT_MARIA,
              [PID_A1],
              [],
              sha256(PID_A1),
              sha256(''),
            ],
          );
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /in-flight lifecycle or access operation|ordinary legacy writer events|Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.account_access_cutover_legacy_write_events`,
        ))[0].count),
        1,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count from public.join_requests where status='pending'`,
        ))[0].count),
        1,
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('aborts when a producer is injected after the fresh preflight records zero', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(
      async ({ pg: hookPg, file }) => {
        if (file === MIGRATION) await seedProductionResidueFixture(hookPg);
      },
      {
        afterAccessStageCPreparation: async ({ pg: hookPg, file }) => {
          if (file !== MIGRATION) return;
          await recordAllProductionResidueDispositions(hookPg);
          await authorizeAccessStageCRelease(hookPg);
          // This test-only trigger runs after the fresh preflight has already
          // written issue_count=0.  The finalizer's second queue check must
          // therefore reject the transaction instead of committing a zero-
          // issue cutover alongside a newly pending canonical operation.
          await hookPg.exec(`
            create or replace function public.stage_c_test_post_check_inject()
            returns trigger
            language plpgsql
            as $$
            begin
              insert into public.join_requests(
                id,property_id,account_id,name,phone,language,department,status
              ) values (
                '${POST_CHECK_JOIN_REQUEST}', '${PID_A1}', '${ACCOUNT_HANK}',
                'Stage C post-check race','512-555-2202','en','housekeeping','pending'
              );
              return new;
            end;
            $$;
            drop trigger if exists stage_c_test_post_check_inject
              on public.account_access_cutover_preflight_runs;
            create trigger stage_c_test_post_check_inject
              after update of status,issue_count
              on public.account_access_cutover_preflight_runs
              for each row
              when (new.status = 'passed' and new.issue_count = 0)
              execute function public.stage_c_test_post_check_inject();
          `);
        },
      },
    );
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /new in-flight operation after clear/i,
      );
      assert.deepEqual(
        await rows<{ id: string; property_access: string[] }>(
          migrated.pg,
          `select id,property_access from public.accounts
            where id in ($1,$2,$3) order by id`,
          [ACCOUNT_ADMIN, ACCOUNT_FRANK, ACCOUNT_MARIA],
        ),
        [
          { id: ACCOUNT_ADMIN, property_access: [PID_A1] },
          { id: ACCOUNT_MARIA, property_access: [PID_A1] },
          { id: ACCOUNT_FRANK, property_access: [PID_A1] },
        ],
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.account_access_cutover_repair_receipts`,
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await rows<{ count: number }>(
          migrated.pg,
          `select count(*)::integer as count
             from public.join_requests
            where id=$1`,
          [POST_CHECK_JOIN_REQUEST],
        ))[0].count),
        0,
        'the aborted suffix must not strand the injected pending operation',
      );
      assert.deepEqual(
        (await rows<{ status: string; consumed_at: string | null }>(
          migrated.pg,
          `select status,consumed_at
             from public.account_access_cutover_release_receipts`,
        ))[0],
        { status: 'unconsumed', consumed_at: null },
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed before destructive DDL when the external release receipt is missing', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file !== MIGRATION) return;
      await seedStageCFixture(hookPg);
      await hookPg.query(
        `update public.accounts set property_access=array[$2::uuid] where id=$1`,
        [ACCOUNT_WANDA, PID_L1],
      );
      await hookPg.query(`delete from public.account_authorization_state where account_id=$1`, [ACCOUNT_WANDA]);
      await hookPg.query(
        `insert into public.account_authorization_state(
           account_id,authority_mode,authority_version,legacy_scope_hash,
           normalized_scope_hash,cutover_at,cutover_reason
         ) values ($1,'legacy',1,encode(sha256(convert_to($2::text,'UTF8')),'hex'),
                   encode(sha256(convert_to('', 'UTF8')),'hex'),null,
                   'receipt-gate raw-array preservation fixture')`,
        [ACCOUNT_WANDA, PID_L1],
      );
      await hookPg.query(`delete from public.account_access_cutover_legacy_write_events`);
    }, { authorizeAccessStageCRelease: false });
    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /release gate requires a same-session receipt/i,
      );
      assert.deepEqual(
        await rows<{ property_access: string[] }>(
          migrated.pg,
          `select property_access from public.accounts where id=$1`,
          [ACCOUNT_WANDA],
        ),
        [{ property_access: [PID_L1] }],
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      assert.deepEqual(
        (await rows<{ stage: string; enforcement_enabled: boolean }>(
          migrated.pg,
          `select stage,enforcement_enabled from public.account_access_cutover_status where id is true`,
        ))[0],
        { stage: 'A', enforcement_enabled: false },
      );
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed before finalization for pending queues and leaves raw authority untouched', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file !== MIGRATION) return;
      await seedStageCFixture(hookPg);
      await hookPg.query(
        `update public.accounts set property_access=array[$2::uuid] where id=$1`,
        [ACCOUNT_HANK, PID_L1],
      );
      await hookPg.query(`delete from public.account_authorization_state where account_id=$1`, [ACCOUNT_HANK]);
      await hookPg.query(
        `insert into public.account_authorization_state(
           account_id,authority_mode,authority_version,legacy_scope_hash,
           normalized_scope_hash,cutover_at,cutover_reason
         ) values ($1,'legacy',1,encode(sha256(convert_to($2::text,'UTF8')),'hex'),
                   encode(sha256(convert_to('', 'UTF8')),'hex'),null,
                   'queue-gate raw-array preservation fixture')`,
        [ACCOUNT_HANK, PID_L1],
      );
      await hookPg.query(`delete from public.account_access_cutover_legacy_write_events`);
      await hookPg.query(`update public.accounts set active=false where id=$1`, [ACCOUNT_HANK]);
      await hookPg.query(
        `insert into public.join_requests(id,property_id,account_id,name,phone,language,department,status)
         values ($1,$2,$3,'Pending Join','512-555-2001','en','housekeeping','pending')`,
        [DIRTY_JOIN_REQUEST, PID_L1, ACCOUNT_HANK],
      );
      const membership = (await rows<{ id: string }>(
        hookPg,
        `select id from organization_memberships
          where organization_id=$1 and account_id=$2 and membership_scope='property'
            and staxis_role='general_manager' and ended_at is null limit 1`,
        [ORG_A, ACCOUNT_MARIA],
      ))[0];
      const relationship = (await rows<{ id: string }>(
        hookPg,
        `select id from organization_property_relationships
          where organization_id=$1 and property_id=$2 and ends_at is null limit 1`,
        [ORG_A, PID_A1],
      ))[0];
      assert.ok(membership && relationship);
      await hookPg.query(
        `insert into public.organization_access_requests(
           id,organization_id,membership_id,requested_access_profile,scope_type,
           property_relationship_id,property_id,reason,status
         ) values ($1,$2,$3,'viewer','property',$4,$5,'pending Stage C request','pending')`,
        [DIRTY_ACCESS_REQUEST, ORG_A, membership.id, relationship.id, PID_A1],
      );
      await hookPg.query(
        `insert into public.organization_invitations(
           id,organization_id,email,token_hash,access_profile,scope_type,
           property_relationship_id,property_id,expires_at,invited_by_account_id,status
         ) values ($1,$2,'stage-c-pending@example.test',$3,'viewer','property',$4,$5,now()+interval '1 day',$6,'pending')`,
        [DIRTY_INVITATION, ORG_A, sha256('stage-c-pending'), relationship.id, PID_A1, ACCOUNT_MARIA],
      );
    }, { authorizeAccessStageCRelease: false });

    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      const failed = migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION);
      assert.match(failed?.error ?? '', /0426 Stage C preflight rejected finalization/i);
      assert.deepEqual(
        await rows<{ property_access: string[] }>(
          migrated.pg,
          `select property_access from accounts where id=$1`,
          [ACCOUNT_HANK],
        ),
        [{ property_access: [PID_L1] }],
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      const issueCodes = await rows<PreflightIssue>(
        migrated.pg,
        `select issue_code from account_access_cutover_preflight_issues
          where run_id = (select final_preflight_run_id from account_access_cutover_status where id is true)
          order by issue_code`,
      );
      for (const issueCode of [
        'inactive_legacy_account',
        'join_request_in_flight',
        'organization_access_request_in_flight',
        'organization_invitation_in_flight',
      ]) {
        assert.ok(issueCodes.some((issue) => issue.issue_code === issueCode), `${issueCode}: ${issueCodes.map((issue) => issue.issue_code).join(',')}`);
      }
      const run = (await rows<{ status: string; issue_count: number }>(
        migrated.pg,
        `select status,issue_count from account_access_cutover_preflight_runs
          where id = (select final_preflight_run_id from account_access_cutover_status where id is true)`,
      ))[0];
      assert.equal(run.status, 'failed');
      assert.ok(Number(run.issue_count) >= 3);
      const status = (await rows<{ stage: string; enforcement_enabled: boolean }>(
        migrated.pg,
        `select stage,enforcement_enabled from account_access_cutover_status where id is true`,
      ))[0];
      assert.notEqual(status.stage, 'C');
      assert.equal(status.enforcement_enabled, false);
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_recovery_actions') as relation`,
        ))[0].relation,
        'account_access_cutover_recovery_actions',
      );
      const recovery = await jsonRpc(
        migrated.pg,
        `select public.staxis_access_stage_c_freeze_and_forward($1,$2,null) as value`,
        ['stage-c-dirty-operator', 'drain pending queues before retrying Stage C'],
      );
      assert.equal(recovery.ok, true);
      assert.equal(recovery.authorityChanged, false);
      const evidence = await jsonRpc(
        migrated.pg,
        `select public.staxis_access_stage_c_recovery_evidence(null) as value`,
      );
      assert.equal((evidence as unknown as unknown[]).length, 1);
    } finally {
      await migrated.pg.close();
    }
  });

  test('fails closed for an ordinary unclaimed unaccepted invite without changing raw authority', async () => {
    const migrated = await applyMigrationsToPgliteWithHook(async ({ pg: hookPg, file }) => {
      if (file !== MIGRATION) return;
      await seedStageCFixture(hookPg);
      await hookPg.query(
        `update public.accounts set property_access=array[$2::uuid] where id=$1`,
        [ACCOUNT_HANK, PID_L1],
      );
      await hookPg.query(`delete from public.account_authorization_state where account_id=$1`, [ACCOUNT_HANK]);
      await hookPg.query(
        `insert into public.account_authorization_state(
           account_id,authority_mode,authority_version,legacy_scope_hash,
           normalized_scope_hash,cutover_at,cutover_reason
         ) values ($1,'legacy',1,encode(sha256(convert_to($2::text,'UTF8')),'hex'),
                   encode(sha256(convert_to('', 'UTF8')),'hex'),null,
                   'ordinary unaccepted invite raw-array preservation fixture')`,
        [ACCOUNT_HANK, PID_L1],
      );
      await hookPg.query(`delete from public.account_access_cutover_legacy_write_events`);
      await hookPg.query(
        `insert into public.account_invites(
           id,hotel_id,email,role,token_hash,expires_at,invited_by,target_staff_id
         ) values ($1,$2,'ordinary-unaccepted@example.test','housekeeping',$3,
                   now()+interval '1 day',$4,null)`,
        [ORDINARY_UNACCEPTED_INVITE, PID_L1, sha256('ordinary-unaccepted'), ACCOUNT_WANDA],
      );
    }, { authorizeAccessStageCRelease: false });

    try {
      assert.equal(migrated.report.applied.includes(MIGRATION), false);
      assert.match(
        migrated.report.failedAtRuntime.find((entry) => entry.file === MIGRATION)?.error ?? '',
        /0426 Stage C preflight rejected finalization/i,
      );
      assert.deepEqual(
        (await rows<{ property_access: string[]; authority_mode: string; authority_version: number }>(
          migrated.pg,
          `select account.property_access,state.authority_mode,state.authority_version
             from public.accounts account
             join public.account_authorization_state state on state.account_id=account.id
            where account.id=$1`,
          [ACCOUNT_HANK],
        ))[0],
        { property_access: [PID_L1], authority_mode: 'legacy', authority_version: 1 },
      );
      assert.deepEqual(
        (await rows<{ accepted_at: string | null; acceptance_claim_token: string | null }>(
          migrated.pg,
          `select accepted_at,acceptance_claim_token
             from public.account_invites where id=$1`,
          [ORDINARY_UNACCEPTED_INVITE],
        ))[0],
        { accepted_at: null, acceptance_claim_token: null },
      );
      assert.ok(
        (await rows<{ issue_code: string }>(
          migrated.pg,
          `select issue_code from public.account_access_cutover_preflight_issues
            where run_id=(select final_preflight_run_id from public.account_access_cutover_status where id is true)`,
        )).some((issue) => issue.issue_code === 'invite_acceptance_in_flight'),
      );
      assert.equal(
        (await rows<{ relation: string | null }>(
          migrated.pg,
          `select to_regclass('public.account_access_cutover_final_receipts') as relation`,
        ))[0].relation,
        null,
      );
      assert.deepEqual(
        (await rows<{ stage: string; enforcement_enabled: boolean }>(
          migrated.pg,
          `select stage,enforcement_enabled from public.account_access_cutover_status where id is true`,
        ))[0],
        { stage: 'A', enforcement_enabled: false },
      );
    } finally {
      await migrated.pg.close();
    }
  });
});
