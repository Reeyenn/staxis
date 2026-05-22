#!/usr/bin/env node
// scripts/audit-mfa-gate-policies.mjs
//
// CI guard for Phase 2B (audit 2026-05-22). Every NEW migration that
// creates or alters an RLS policy targeting `authenticated` or `public`
// roles must include `mfa_verified_or_grace()` somewhere in the policy
// body — otherwise the Door B gate erodes silently as new policies are
// added without the guard.
//
// Run as part of `npm run lint`. Exits 1 if any policy lacks the gate.
//
// Exemption list mirrors the one in generate-mfa-rls-sweep.mjs.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

// Migrations 0157 (password_signin_proofs) and earlier predate Phase 2B —
// don't audit them. Phase 2B itself starts at 0159; 0159 + 0160 + 0162
// don't define policies that need the gate; 0161 IS the gate.
const PHASE_2B_MIGRATION_FLOOR = 159;

// Policies exempt from the gate (auth-flow, etc.). Match the format
// "tablename:policyname".
const EXEMPT = new Set([
  'accounts:accounts_self_select',
  'accounts:account can read self',
  'accounts:accounts_deny_writes',
  // Hook-helper reader policy installed by migration 0160. Targets the
  // supabase_auth_admin role; not user-facing.
  'accounts:accounts_auth_hook_read',
  // Service-role-only — never targets authenticated/anon.
  'mfa_verified_sessions:mfa_verified_sessions_auth_admin_all',
  'password_signin_proofs:password_signin_proofs_auth_admin_all',
  // Trusted-device admin hook reader (Phase B may add this).
  'trusted_devices:trusted_devices_auth_hook_read',
]);

// Regex matches `create policy "X" on Y` or `alter policy "X" on Y`.
// Captures: policy name (between quotes), table (after `on`).
const POLICY_RX = /(?:create|alter)\s+policy\s+"([^"]+)"\s+on\s+(?:public\.)?(\w+)/gi;
// Roles regex — looks for `to authenticated` or `to public` or `to anon,authenticated` etc.
const PUBLIC_OR_AUTH_RX = /\bto\s+([a-z_,\s]*\b(?:authenticated|public|anon)\b[a-z_,\s]*)/i;
// Helper presence regex.
const HELPER_RX = /mfa_verified_or_grace\s*\(\s*\)/i;
// Detect "USING false" deny-all (regardless of formatting). We don't
// require the gate on deny-all policies.
const DENY_ALL_RX = /using\s*\(\s*false\s*\)/i;

function migrationNumber(filename) {
  const m = filename.match(/^(\d+)_/);
  return m ? parseInt(m[1], 10) : -1;
}

function main() {
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  } catch {
    console.log('audit-mfa-gate-policies: no migrations directory; skip');
    process.exit(0);
  }

  const violations = [];

  for (const filename of files) {
    const n = migrationNumber(filename);
    if (n < PHASE_2B_MIGRATION_FLOOR) continue;
    // 0161 is the sweep itself — every policy in it has the gate. Skip
    // the structural check since the file shape is auto-generated.
    if (filename.startsWith('0161_')) continue;

    const path = join(MIGRATIONS_DIR, filename);
    const content = readFileSync(path, 'utf8');

    // For each policy statement, find its scope (next semicolon or end).
    // Crude but works: extract policy header + the following ~30 lines
    // of body.
    const matches = [...content.matchAll(POLICY_RX)];
    for (const m of matches) {
      const [, policyName, tableName] = m;
      const key = `${tableName}:${policyName}`;
      if (EXEMPT.has(key)) continue;

      // Slice the statement body up to the next semicolon.
      const startIdx = m.index;
      const endIdx = content.indexOf(';', startIdx);
      const body = content.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 2000);

      // Only check if the policy targets authenticated/public/anon roles.
      const rolesMatch = PUBLIC_OR_AUTH_RX.exec(body);
      if (!rolesMatch) continue;

      // Skip pure deny-all policies (USING false everywhere).
      if (DENY_ALL_RX.test(body) && !HELPER_RX.test(body)) {
        continue;
      }

      // The gate must appear somewhere in this policy statement.
      if (!HELPER_RX.test(body)) {
        violations.push({ filename, policyName, tableName, key });
      }
    }
  }

  if (violations.length === 0) {
    console.log(`✓ audit-mfa-gate-policies: all post-2B policies include mfa_verified_or_grace() (or are deny-all / exempt)`);
    process.exit(0);
  }

  console.error('✗ audit-mfa-gate-policies: policies missing mfa_verified_or_grace() gate:');
  for (const v of violations) {
    console.error(`  - ${v.filename}: ${v.tableName}:"${v.policyName}"`);
  }
  console.error('');
  console.error('Every new RLS policy targeting authenticated/public/anon must include');
  console.error('`public.mfa_verified_or_grace()` in its USING/WITH CHECK clause.');
  console.error('If the policy is legitimately exempt, add its "tablename:policyname"');
  console.error('to the EXEMPT set in scripts/audit-mfa-gate-policies.mjs and document why.');
  process.exit(1);
}

main();
