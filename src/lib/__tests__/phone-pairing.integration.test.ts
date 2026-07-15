import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const USER_1 = '11111111-1111-1111-1111-111111111111';
const USER_2 = '22222222-2222-2222-2222-222222222222';
const SESSION_1 = '33333333-3333-3333-3333-333333333333';
const SESSION_2 = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAIRING_1 = '55555555-5555-5555-5555-555555555555';
const PAIRING_2 = '66666666-6666-6666-6666-666666666666';
const FRESH_PAIRING = '77777777-7777-7777-7777-777777777777';
const OTHER_ACCOUNT_PAIRING = '88888888-8888-8888-8888-888888888888';
const ATTEMPT_CAPPED_PAIRING = '99999999-9999-9999-9999-999999999999';

const hash = (character: string) => character.repeat(64);
const iso = (value: string | Date) => new Date(value).toISOString();

type ClaimRow = {
  pairing_id: string;
  challenge_expires_at: string;
  send_count: number;
  send_reservation_id: string | null;
  newly_claimed?: boolean;
};

type VerifyRow = {
  verified: boolean;
  pairing_id: string | null;
  supabase_hashed_token: string | null;
  completion_expires_at: string | null;
};

describe('phone pairing migration state machine — real SQL via PGlite', () => {
  let pg: PGlite;

  async function storeAndFinalize(
    pairingId: string,
    challengeHash: string,
    reservation: ClaimRow,
    otpDigest: string,
    supabaseHashedToken: string,
  ): Promise<string> {
    assert.ok(reservation.send_reservation_id, 'send reservation id is required');
    const stored = await pg.query<{ stored: boolean }>(
      `select public.staxis_store_phone_pairing_otp(
         $1, $2, $3, $4, $5, $6
       ) as stored`,
      [
        pairingId,
        challengeHash,
        reservation.send_count,
        reservation.send_reservation_id,
        otpDigest,
        supabaseHashedToken,
      ],
    );
    assert.equal(stored.rows[0].stored, true);

    const finalized = await pg.query<{ expires_at: string | Date | null }>(
      `select public.staxis_finalize_phone_pairing_send(
         $1, $2, $3, $4
       ) as expires_at`,
      [
        pairingId,
        challengeHash,
        reservation.send_count,
        reservation.send_reservation_id,
      ],
    );
    assert.ok(finalized.rows[0].expires_at);
    return iso(finalized.rows[0].expires_at as string | Date);
  }

  before(async () => {
    pg = new PGlite({ extensions: { pgcrypto } });

    // Only the production objects migration 0309 depends on are stubbed. The
    // migration itself (table, checks, grants, and every RPC) is applied
    // verbatim below, so this test detects PostgreSQL syntax/state drift.
    await pg.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role bypassrls nologin;

      create schema auth;
      create table auth.users (
        id uuid primary key,
        email text
      );
      create table auth.sessions (
        id uuid primary key,
        user_id uuid not null references auth.users(id) on delete cascade
      );

      create table public.properties (
        id uuid primary key
      );
      create table public.accounts (
        id uuid primary key,
        data_user_id uuid not null references auth.users(id) on delete cascade
      );
      create table public.api_limits (
        property_id uuid not null,
        endpoint text not null,
        hour_bucket text not null,
        count integer not null default 0,
        primary key (property_id, endpoint, hour_bucket),
        constraint api_limits_property_id_fkey
          foreign key (property_id) references public.properties(id)
      );
      create table public.trusted_devices (
        id uuid primary key default gen_random_uuid(),
        account_id uuid not null references public.accounts(id) on delete cascade,
        token_hash text not null,
        user_agent text,
        ip text,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        unique (account_id, token_hash)
      );
      create table public.mfa_verified_sessions (
        session_id uuid primary key references auth.sessions(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        verified_at timestamptz not null default now(),
        verified_from_ip text,
        verified_from_ua text
      );
      create table public.applied_migrations (
        version text primary key,
        description text not null
      );

      insert into auth.users (id, email) values
        ('${USER_1}', 'one@example.test'),
        ('${USER_2}', 'two@example.test');
      insert into auth.sessions (id, user_id) values
        ('${SESSION_1}', '${USER_1}'),
        ('${SESSION_2}', '${USER_2}');
      insert into public.accounts (id, data_user_id) values
        ('${ACCOUNT_1}', '${USER_1}'),
        ('${ACCOUNT_2}', '${USER_2}');
    `);

    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0309_phone_pairings.sql'),
      'utf8',
    );
    await pg.exec(migration);
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  test('drops the incompatible api_limits property FK and denies browser table access', async () => {
    const constraints = await pg.query<{ count: number }>(`
      select count(*)::int as count
        from pg_constraint
       where conname = 'api_limits_property_id_fkey'
    `);
    assert.equal(constraints.rows[0].count, 0);

    // A derived UUID scope that is not a properties.id must now work.
    await pg.query(
      `insert into public.api_limits (property_id, endpoint, hour_bucket)
       values ($1, 'auth-phone-pairing-claim', '2030-01-01T00')`,
      ['99999999-9999-9999-9999-999999999999'],
    );

    await assert.rejects(async () => {
      await pg.exec('begin');
      try {
        await pg.exec('set local role anon');
        await pg.query('select count(*) from public.phone_pairings');
      } finally {
        await pg.exec('rollback').catch(() => undefined);
      }
    }, /permission denied/i);
  });

  test('consumes the QR once and atomically caps resends and verification attempts', async () => {
    await pg.query(
      `insert into public.phone_pairings (
         id, account_id, auth_user_id, pairing_token_hash, pair_expires_at
       ) values ($1, $2, $3, $4, now() + interval '60 seconds')`,
      [PAIRING_1, ACCOUNT_1, USER_1, hash('a')],
    );

    const claimed = await pg.query<ClaimRow>(
      `select * from public.staxis_claim_phone_pairing($1, $2, $3, $4)`,
      [hash('a'), hash('b'), 'Phone UA', '192.0.2.10'],
    );
    assert.equal(claimed.rows.length, 1);
    assert.equal(claimed.rows[0].pairing_id, PAIRING_1);
    assert.equal(claimed.rows[0].send_count, 1);
    assert.equal(claimed.rows[0].newly_claimed, true);

    const claimReplay = await pg.query<ClaimRow>(
      `select * from public.staxis_claim_phone_pairing($1, $2, null, null)`,
      [hash('a'), hash('b')],
    );
    assert.equal(claimReplay.rows.length, 1);
    assert.equal(claimReplay.rows[0].newly_claimed, false);
    assert.equal(claimReplay.rows[0].send_count, 1);
    assert.equal(
      new Date(claimReplay.rows[0].challenge_expires_at).getTime(),
      new Date(claimed.rows[0].challenge_expires_at).getTime(),
      'claim replay must not extend the original challenge window',
    );

    const duplicateClaim = await pg.query<ClaimRow>(
      `select * from public.staxis_claim_phone_pairing($1, $2, null, null)`,
      [hash('a'), hash('9')],
    );
    assert.equal(
      duplicateClaim.rows.length,
      0,
      'the same QR cannot rotate to a different challenge',
    );

    const firstExpiry = await storeAndFinalize(
      PAIRING_1,
      hash('b'),
      claimed.rows[0],
      hash('0'),
      'supabase-hash-initial',
    );

    const immediateResend = await pg.query<ClaimRow>(
      `select * from public.staxis_reserve_phone_pairing_resend($1)`,
      [hash('b')],
    );
    assert.equal(immediateResend.rows.length, 0, '10-second cooldown must be atomic');

    await pg.query(
      `update public.phone_pairings
          set last_send_started_at = now() - interval '11 seconds'
        where id = $1`,
      [PAIRING_1],
    );
    const cancelledReservation = await pg.query<ClaimRow>(
      `select * from public.staxis_reserve_phone_pairing_resend($1)`,
      [hash('b')],
    );
    assert.equal(cancelledReservation.rows[0].send_count, 2);
    assert.ok(cancelledReservation.rows[0].send_reservation_id);

    const pendingStored = await pg.query<{ stored: boolean }>(
      `select public.staxis_store_phone_pairing_otp(
         $1, $2, $3, $4, $5, $6
       ) as stored`,
      [
        PAIRING_1,
        hash('b'),
        2,
        cancelledReservation.rows[0].send_reservation_id,
        hash('1'),
        'supabase-hash-cancelled',
      ],
    );
    assert.equal(pendingStored.rows[0].stored, true);
    const cancelled = await pg.query<{ cancelled: boolean }>(
      `select public.staxis_cancel_phone_pairing_send(
         $1, $2, $3, $4
       ) as cancelled`,
      [
        PAIRING_1,
        hash('b'),
        2,
        cancelledReservation.rows[0].send_reservation_id,
      ],
    );
    assert.equal(cancelled.rows[0].cancelled, true);

    const afterCancel = await pg.query<{
      send_count: number;
      otp_digest: string | null;
      challenge_expires_at: string | Date;
      reservation_cleared: boolean;
    }>(`
      select
        send_count,
        otp_digest,
        challenge_expires_at,
        send_reservation_id is null
          and pending_otp_digest is null as reservation_cleared
      from public.phone_pairings
      where id = '${PAIRING_1}'
    `);
    assert.deepEqual({
      ...afterCancel.rows[0],
      challenge_expires_at: iso(afterCancel.rows[0].challenge_expires_at),
    }, {
      send_count: 1,
      otp_digest: hash('0'),
      challenge_expires_at: firstExpiry,
      reservation_cleared: true,
    }, 'failed delivery compensation preserves accepted count, TTL, and prior OTP');

    const secondSend = await pg.query<ClaimRow>(
      `select * from public.staxis_reserve_phone_pairing_resend($1)`,
      [hash('b')],
    );
    assert.equal(secondSend.rows[0].send_count, 2);
    const secondExpiry = await storeAndFinalize(
      PAIRING_1,
      hash('b'),
      secondSend.rows[0],
      hash('1'),
      'supabase-hash-second',
    );
    assert.ok(
      new Date(secondExpiry).getTime() >= new Date(firstExpiry).getTime(),
      'only a finalized send refreshes the 60-second challenge window',
    );

    await pg.query(
      `update public.phone_pairings
          set last_send_started_at = now() - interval '11 seconds'
        where id = $1`,
      [PAIRING_1],
    );
    const thirdSend = await pg.query<ClaimRow>(
      `select * from public.staxis_reserve_phone_pairing_resend($1)`,
      [hash('b')],
    );
    assert.equal(thirdSend.rows[0].send_count, 3);
    await storeAndFinalize(
      PAIRING_1,
      hash('b'),
      thirdSend.rows[0],
      hash('c'),
      'supabase-hash-one',
    );

    await pg.query(
      `update public.phone_pairings
          set last_send_started_at = now() - interval '11 seconds'
        where id = $1`,
      [PAIRING_1],
    );
    const fourthSend = await pg.query<ClaimRow>(
      `select * from public.staxis_reserve_phone_pairing_resend($1)`,
      [hash('b')],
    );
    assert.equal(fourthSend.rows.length, 0, 'three total email sends is a hard cap');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await pg.query<VerifyRow>(
        `select * from public.staxis_verify_phone_pairing($1, $2, $3)`,
        [hash('b'), hash('f'), hash('d')],
      );
      assert.equal(result.rows[0].verified, false, `wrong attempt ${attempt} must fail`);
    }

    const sixthAttempt = await pg.query<VerifyRow>(
      `select * from public.staxis_verify_phone_pairing($1, $2, $3)`,
      [hash('b'), hash('c'), hash('d')],
    );
    assert.equal(sixthAttempt.rows[0].verified, false, 'correct code after five failures is inert');

    const attempts = await pg.query<{ verify_attempt_count: number }>(
      `select verify_attempt_count from public.phone_pairings where id = $1`,
      [PAIRING_1],
    );
    assert.equal(attempts.rows[0].verify_attempt_count, 5);

    // Exhaustion must prevent a fresh email that the verifier can never
    // accept, even when this pairing still has two nominal send slots.
    await pg.query(
      `insert into public.phone_pairings (
         id, account_id, auth_user_id, pairing_token_hash, pair_expires_at
       ) values ($1, $2, $3, $4, now() + interval '60 seconds')`,
      [ATTEMPT_CAPPED_PAIRING, ACCOUNT_1, USER_1, hash('7')],
    );
    const cappedClaim = await pg.query<ClaimRow>(
      `select * from public.staxis_claim_phone_pairing($1, $2, null, null)`,
      [hash('7'), hash('8')],
    );
    await storeAndFinalize(
      ATTEMPT_CAPPED_PAIRING,
      hash('8'),
      cappedClaim.rows[0],
      hash('9'),
      'supabase-hash-capped',
    );
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await pg.query(
        `select * from public.staxis_verify_phone_pairing($1, $2, $3)`,
        [hash('8'), hash('0'), hash('6')],
      );
    }
    await pg.query(
      `update public.phone_pairings
          set last_send_started_at = now() - interval '11 seconds'
        where id = $1`,
      [ATTEMPT_CAPPED_PAIRING],
    );
    const resendAfterAttemptCap = await pg.query<ClaimRow>(
      `select * from public.staxis_reserve_phone_pairing_resend($1)`,
      [hash('8')],
    );
    assert.equal(resendAfterAttemptCap.rows.length, 0);
  });

  test('binds completion to the exact bearer session and commits trust atomically once', async () => {
    await pg.query(
      `insert into public.phone_pairings (
         id, account_id, auth_user_id, pairing_token_hash, pair_expires_at
       ) values ($1, $2, $3, $4, now() + interval '60 seconds')`,
      [PAIRING_2, ACCOUNT_1, USER_1, hash('1')],
    );

    const lifecycleClaim = await pg.query<ClaimRow>(
      `select * from public.staxis_claim_phone_pairing($1, $2, null, null)`,
      [hash('1'), hash('2')],
    );
    await storeAndFinalize(
      PAIRING_2,
      hash('2'),
      lifecycleClaim.rows[0],
      hash('3'),
      'supabase-hash-two',
    );

    const verified = await pg.query<VerifyRow>(
      `select * from public.staxis_verify_phone_pairing($1, $2, $3)`,
      [hash('2'), hash('3'), hash('4')],
    );
    assert.deepEqual(
      {
        verified: verified.rows[0].verified,
        pairingId: verified.rows[0].pairing_id,
        hashedToken: verified.rows[0].supabase_hashed_token,
      },
      {
        verified: true,
        pairingId: PAIRING_2,
        hashedToken: 'supabase-hash-two',
      },
    );

    const retryVerify = await pg.query<VerifyRow>(
      `select * from public.staxis_verify_phone_pairing($1, $2, $3)`,
      [hash('2'), hash('3'), hash('4')],
    );
    assert.deepEqual(
      {
        verified: retryVerify.rows[0].verified,
        pairingId: retryVerify.rows[0].pairing_id,
        hashedToken: retryVerify.rows[0].supabase_hashed_token,
        expiresAt: retryVerify.rows[0].completion_expires_at,
      },
      {
        verified: true,
        pairingId: PAIRING_2,
        hashedToken: 'supabase-hash-two',
        expiresAt: verified.rows[0].completion_expires_at,
      },
      'an exact lost-response retry recovers the same grant without extending it',
    );

    const retainedProof = await pg.query<{
      challenge_retained: boolean;
      otp_retained: boolean;
      supabase_token_retained: boolean;
    }>(`
      select
        challenge_token_hash is not null as challenge_retained,
        otp_digest is not null as otp_retained,
        supabase_hashed_token is not null as supabase_token_retained
      from public.phone_pairings
      where id = '${PAIRING_2}'
    `);
    assert.deepEqual(retainedProof.rows[0], {
      challenge_retained: true,
      otp_retained: true,
      supabase_token_retained: true,
    });

    // SESSION_2 exists but belongs to USER_2. Passing USER_1 proves the RPC
    // checks the exact (session id, user id) row, not merely either value.
    const mismatched = await pg.query<{ pairing_id: string | null }>(
      `select public.staxis_complete_phone_pairing(
         $1, $2, $3, $4, now() + interval '30 days', $5, $6
       ) as pairing_id`,
      [hash('4'), USER_1, SESSION_2, hash('5'), 'Phone UA', '192.0.2.11'],
    );
    assert.equal(mismatched.rows[0].pairing_id, null);

    const beforeCompletion = await pg.query<{ trusted: number; mfa: number }>(`
      select
        (select count(*)::int from public.trusted_devices) as trusted,
        (select count(*)::int from public.mfa_verified_sessions) as mfa
    `);
    assert.deepEqual(beforeCompletion.rows[0], { trusted: 0, mfa: 0 });

    const completed = await pg.query<{ pairing_id: string | null }>(
      `select public.staxis_complete_phone_pairing(
         $1, $2, $3, $4, now() + interval '30 days', $5, $6
       ) as pairing_id`,
      [hash('4'), USER_1, SESSION_1, hash('5'), 'Phone UA', '192.0.2.11'],
    );
    assert.equal(completed.rows[0].pairing_id, PAIRING_2);

    const committed = await pg.query<{
      trusted: number;
      mfa: number;
      completed: boolean;
      completion_grant_retained: boolean;
      completed_session_id: string | null;
      completed_device_token_hash: string | null;
      verify_proof_cleared: boolean;
    }>(`
      select
        (select count(*)::int from public.trusted_devices) as trusted,
        (select count(*)::int from public.mfa_verified_sessions) as mfa,
        p.completed_at is not null as completed,
        p.completion_token_hash is not null as completion_grant_retained,
        p.completed_session_id,
        p.completed_device_token_hash,
        p.challenge_token_hash is null
          and p.otp_digest is null
          and p.supabase_hashed_token is null as verify_proof_cleared
      from public.phone_pairings as p
      where p.id = '${PAIRING_2}'
    `);
    assert.deepEqual(committed.rows[0], {
      trusted: 1,
      mfa: 1,
      completed: true,
      completion_grant_retained: true,
      completed_session_id: SESSION_1,
      completed_device_token_hash: hash('5'),
      verify_proof_cleared: true,
    });

    const retryComplete = await pg.query<{ pairing_id: string | null }>(
      `select public.staxis_complete_phone_pairing(
         $1, $2, $3, $4, now() + interval '30 days', null, null
       ) as pairing_id`,
      [hash('4'), USER_1, SESSION_1, hash('5')],
    );
    assert.equal(
      retryComplete.rows[0].pairing_id,
      PAIRING_2,
      'exact same-session/device completion retry is idempotent',
    );

    const afterRetry = await pg.query<{ trusted: number; mfa: number }>(`
      select
        (select count(*)::int from public.trusted_devices) as trusted,
        (select count(*)::int from public.mfa_verified_sessions) as mfa
    `);
    assert.deepEqual(afterRetry.rows[0], { trusted: 1, mfa: 1 });

    const differentDevice = await pg.query<{ pairing_id: string | null }>(
      `select public.staxis_complete_phone_pairing(
         $1, $2, $3, $4, now() + interval '30 days', null, null
       ) as pairing_id`,
      [hash('4'), USER_1, SESSION_1, hash('6')],
    );
    assert.equal(differentDevice.rows[0].pairing_id, null);

    const verifyAfterCompletion = await pg.query<VerifyRow>(
      `select * from public.staxis_verify_phone_pairing($1, $2, $3)`,
      [hash('2'), hash('3'), hash('4')],
    );
    assert.equal(
      verifyAfterCompletion.rows[0].verified,
      false,
      'completion clears the retained verify proof',
    );

    await pg.query(
      `delete from public.trusted_devices where account_id = $1`,
      [ACCOUNT_1],
    );
    const afterRevocation = await pg.query<{ pairing_id: string | null }>(
      `select public.staxis_complete_phone_pairing(
         $1, $2, $3, $4, now() + interval '30 days', null, null
       ) as pairing_id`,
      [hash('4'), USER_1, SESSION_1, hash('5')],
    );
    assert.equal(afterRevocation.rows[0].pairing_id, null, 'retry cannot revive revoked trust');

    const trustAfterRevocation = await pg.query<{ count: number }>(
      `select count(*)::int as count from public.trusted_devices`,
    );
    assert.equal(trustAfterRevocation.rows[0].count, 0);

    await pg.query(
      `update public.phone_pairings
          set completion_expires_at = now() - interval '1 second'
        where id = $1`,
      [PAIRING_2],
    );
    const expiredRetry = await pg.query<{ pairing_id: string | null }>(
      `select public.staxis_complete_phone_pairing(
         $1, $2, $3, $4, now() + interval '30 days', null, null
       ) as pairing_id`,
      [hash('4'), USER_1, SESSION_1, hash('5')],
    );
    assert.equal(expiredRetry.rows[0].pairing_id, null);
  });

  test('retention cleanup is per-account, 24-hour-safe, and bounded to 100 rows', async () => {
    await pg.exec(`
      insert into public.phone_pairings (
        account_id, auth_user_id, pair_expires_at, created_at
      )
      select
        '${ACCOUNT_1}', '${USER_1}',
        now() - interval '48 hours',
        now() - interval '48 hours' - (n * interval '1 second')
      from generate_series(1, 105) as n;

      insert into public.phone_pairings (
        id, account_id, auth_user_id, pair_expires_at, created_at
      ) values
        ('${FRESH_PAIRING}', '${ACCOUNT_1}', '${USER_1}', now() + interval '60 seconds', now()),
        ('${OTHER_ACCOUNT_PAIRING}', '${ACCOUNT_2}', '${USER_2}', now() - interval '48 hours', now() - interval '48 hours');
    `);

    const first = await pg.query<{ deleted: number }>(
      `select public.staxis_cleanup_phone_pairings($1) as deleted`,
      [ACCOUNT_1],
    );
    assert.equal(first.rows[0].deleted, 100);

    const afterFirst = await pg.query<{ stale_own: number; fresh_kept: number; other_kept: number }>(`
      select
        count(*) filter (
          where account_id = '${ACCOUNT_1}'
            and pair_expires_at < now() - interval '24 hours'
        )::int as stale_own,
        count(*) filter (where id = '${FRESH_PAIRING}')::int as fresh_kept,
        count(*) filter (where id = '${OTHER_ACCOUNT_PAIRING}')::int as other_kept
      from public.phone_pairings
    `);
    assert.deepEqual(afterFirst.rows[0], {
      stale_own: 5,
      fresh_kept: 1,
      other_kept: 1,
    });

    const second = await pg.query<{ deleted: number }>(
      `select public.staxis_cleanup_phone_pairings($1) as deleted`,
      [ACCOUNT_1],
    );
    const third = await pg.query<{ deleted: number }>(
      `select public.staxis_cleanup_phone_pairings($1) as deleted`,
      [ACCOUNT_1],
    );
    assert.equal(second.rows[0].deleted, 5);
    assert.equal(third.rows[0].deleted, 0);
  });
});
