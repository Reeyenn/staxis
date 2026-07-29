import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrationsToPgliteWithHook } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_MARIA,
  PID_A1,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const LEGACY_ONE_SHOT = 'e1000000-0000-4000-8000-000000000001';
const LEGACY_SHARED = 'e1000000-0000-4000-8000-000000000002';

test('0398 retires unproven credentials and recursively scrubs historical bearer metadata', async () => {
  let seeded = false;
  const migrated = await applyMigrationsToPgliteWithHook(async ({ pg, file, report }) => {
    if (file !== '0398_privileged_onboarding_join_codes.sql') return;
    assert.ok(report.applied.includes('0397_property_scoped_nudge_recipients.sql'));
    await seedTwoCompanies(pg);
    await pg.query(
      `insert into hotel_join_codes(
         id,hotel_id,code,role,expires_at,max_uses,used_count,created_by,created_at
       ) values
         ($1,$3,'OLD1-ABCDEFGHJK',null,clock_timestamp()+interval '1 day',1,1,$4,
          clock_timestamp()),
         ($2,$3,'OLD2-ABCDEFGHJK',null,clock_timestamp()+interval '1 day',100,0,$4,
          clock_timestamp())`,
      [LEGACY_ONE_SHOT, LEGACY_SHARED, PID_A1, ACCOUNT_MARIA],
    );
    await pg.query(
      `insert into admin_audit_log(
         action,target_type,target_id,metadata
       ) values (
         'join_code.create','join_code',$1,
         $2::jsonb
       )`,
      [
        LEGACY_SHARED,
        JSON.stringify({
          code: 'TOP-SECRET',
          safeIdentity: 'keep-me',
          nested: { JoinCode: 'NESTED-SECRET', safeCount: 7 },
          array: [{ TOKEN: 'ARRAY-SECRET', keep: 'still-here' }],
          Bearer: 'CASE-SECRET',
        }),
      ],
    );
    seeded = true;
  });

  try {
    assert.equal(seeded, true);
    const failure = migrated.report.failedAtRuntime.find(
      (entry) => entry.file === '0398_privileged_onboarding_join_codes.sql',
    );
    assert.equal(failure, undefined, failure?.error);

    const rows = await migrated.pg.query<{
      id: string;
      code_kind: string;
      revoked: boolean;
      used_count: number;
      max_uses: number;
    }>(
      `select id,code_kind,(revoked_at is not null) as revoked,used_count,max_uses
       from hotel_join_codes where id in ($1,$2) order by id`,
      [LEGACY_ONE_SHOT, LEGACY_SHARED],
    );
    assert.deepEqual(rows.rows, [
      {
        id: LEGACY_ONE_SHOT,
        code_kind: 'staff_signup',
        revoked: true,
        used_count: 1,
        max_uses: 1,
      },
      {
        id: LEGACY_SHARED,
        code_kind: 'staff_signup',
        revoked: true,
        used_count: 0,
        max_uses: 100,
      },
    ]);

    const oldOneShot = await migrated.pg.query<{
      value: Record<string, unknown>;
    }>(
      `select public.staxis_resolve_join_code_capability('OLD1-ABCDEFGHJK') as value`,
    );
    assert.equal(oldOneShot.rows[0].value.status, 'revoked');
    assert.equal(oldOneShot.rows[0].value.codeKind, 'staff_signup');

    const audit = await migrated.pg.query<{
      metadata: Record<string, unknown>;
      has_bearer_key: boolean;
    }>(
      `select metadata,
              public._staxis_jsonb_has_join_code_bearer_key(metadata) as has_bearer_key
       from admin_audit_log
       where action='join_code.create' and target_id=$1`,
      [LEGACY_SHARED],
    );
    assert.equal(audit.rows[0].has_bearer_key, false);
    assert.deepEqual(audit.rows[0].metadata, {
      safeIdentity: 'keep-me',
      nested: { safeCount: 7 },
      array: [{ keep: 'still-here' }],
      bearer_redacted: true,
      bearer_redaction_reason: '0398 join-code storage boundary',
    });

    await assert.rejects(
      migrated.pg.query(
        `insert into admin_audit_log(action,target_type,target_id,metadata)
         values ('join_code.poison','join_code',$1,$2::jsonb)`,
        [
          LEGACY_SHARED,
          JSON.stringify({ safe: [{ nested: { ToKeN: 'must-not-persist' } }] }),
        ],
      ),
      /admin_audit_log_join_code_bearer_free_check|check constraint/i,
    );
  } finally {
    await migrated.pg.close().catch(() => undefined);
  }
});
