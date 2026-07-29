import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase', 'migrations', '0396_privileged_onboarding_join_codes.sql',
);
const createRoute = read(
  'src', 'app', 'api', 'admin', 'properties', 'create', 'route.ts',
);
const redeemRoute = read(
  'src', 'app', 'api', 'auth', 'use-join-code', 'route.ts',
);
const resumeRoute = read(
  'src', 'app', 'api', 'onboard', 'resume', 'route.ts',
);
const capabilityBoundary = read('src', 'lib', 'join-code-capability.ts');

function assertAppearsInOrder(haystack: string, needles: readonly string[]) {
  let cursor = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(next, -1, `expected migration fragment: ${needle}`);
    assert.ok(next > cursor, `expected ordered migration fragment: ${needle}`);
    cursor = next;
  }
}

describe('privileged onboarding join-code rollout contract', () => {
  test('restores only the typed one-shot onboarding shape behind a lifecycle trigger', () => {
    assert.match(migration, /code_kind = 'privileged_onboarding'/);
    assert.match(migration, /role in \('owner', 'general_manager'\)/);
    assert.match(migration, /max_uses = 1/);
    assert.match(migration, /used_count between 0 and 1/);
    assert.match(migration, /hotel_join_codes_one_privileged_onboarding_idx/);
    assert.match(migration, /_staxis_guard_privileged_onboarding_join_code/);
    assert.match(migration, /onboarding_completed_at is not null/);
    assert.match(migration, /onboarding_state->>'accountCreatedAt'/);
    assert.match(migration, /v_property_owner_id is distinct from v_creator_auth_user_id/);
  });

  test('platform-admin create and public redemption use the service-only transactional RPCs', () => {
    assert.match(createRoute, /staxis_mint_privileged_onboarding_join_code/);
    assert.doesNotMatch(
      createRoute,
      /from\(['"]hotel_join_codes['"]\)[\s\S]{0,120}\.insert\(/,
    );
    assert.match(redeemRoute, /finalizeJoinCodeSignup/);
    assert.match(capabilityBoundary, /staxis_finalize_join_code_signup/);
    assert.doesNotMatch(redeemRoute, /staxis_claim_join_code_slot/);
    assert.doesNotMatch(
      redeemRoute,
      /from\(['"]hotel_join_codes['"]\)[\s\S]{0,120}\.update\(\{\s*used_count/,
    );
    assert.doesNotMatch(
      redeemRoute,
      /from\(['"](?:accounts|join_requests)['"]\)[\s\S]{0,160}\.(?:insert|update)\(/,
    );
    assert.match(
      migration,
      /grant execute on function public\.staxis_mint_privileged_onboarding_join_code\([\s\S]*?\) to service_role/,
    );
    assert.match(
      migration,
      /grant execute on function public\.staxis_finalize_join_code_signup\([\s\S]*?\) to service_role/,
    );
  });

  test('finalization locks property then shared mutex then bearer row before every signup write', () => {
    const functionStart = migration.indexOf(
      'create or replace function public.staxis_finalize_join_code_signup(',
    );
    const functionEnd = migration.indexOf(
      'revoke all on function public.staxis_finalize_join_code_signup(',
      functionStart,
    );
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const finalizer = migration.slice(functionStart, functionEnd);

    assertAppearsInOrder(finalizer, [
      'from public.properties property',
      'for update;',
      "pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0))",
      'from public.hotel_join_codes code_row',
      'and code_row.code = v_code_text',
      'for update;',
      'from public._staxis_current_primary_property_relationships()',
      'update public.hotel_join_codes code_row',
      'insert into public.accounts',
      'insert into public.admin_audit_log',
    ]);
    assert.match(finalizer, /insert into public\.join_requests/);
    assert.match(finalizer, /update public\.properties property\s+set owner_id/);
    assert.match(finalizer, /set onboarding_state = v_next_state/);
  });

  test('resume links are pre-consumed and role-neutral, never fresh owner credentials', () => {
    assert.match(
      resumeRoute,
      /staxis_resolve_or_mint_resume_join_code_guarded/,
    );
    assert.match(migration, /p_hotel_id, v_code_text, null, 'onboarding_resume'/);
    assert.match(migration, /'onboarding_resume'[\s\S]*?role is null[\s\S]*?max_uses = 1[\s\S]*?used_count = 1/);
    assert.doesNotMatch(
      resumeRoute,
      /\.from\(['"]hotel_join_codes['"]\)/,
    );
  });
});
