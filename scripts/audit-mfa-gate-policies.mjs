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
  // Mapper-tool admin policies (migrations 0212/0213/0214). Audience is
  // Reeyen + Staxis platform admins only — accessed through /admin/* UI
  // that already enforces is_admin_user(auth.uid()) inside the USING
  // clause. The mfa_verified_or_grace() gate isn't applied here because
  // admin accounts use skip_2fa and the routes are not user-facing.
  'mapping_help_requests:mhr_admin_select',
  'mapping_help_requests:mhr_admin_update',
  'mapping_help_requests:mhr_admin_delete',
  // Storage policies for the mapping-screenshots bucket. Admin SELECT
  // + the no-op anon-deny that 0214 retains as a documentation marker.
  'objects:mapping_screenshots_admin_select',
  'objects:mapping_screenshots_anon_deny',
  // Housekeeping-issue-photos bucket (migration 0225). The "anon deny"
  // policy is a documentation marker — same idiom as the
  // mapping_screenshots_anon_deny entry above. Uploads + reads go through
  // service-role helpers; no authenticated browser role ever touches the
  // bucket. The deny policy applies to anon, not to a 2FA-gated surface,
  // so the mfa_verified_or_grace() check doesn't apply.
  'objects:anon deny housekeeping-issue-photos',
  // Lost-found-item-photos bucket (migration 0229). Same idiom as the
  // housekeeping-issue-photos deny above: uploads + views go through
  // service-role signed-URL helpers; no authenticated browser role touches
  // the bucket. The deny policy applies to anon, not a 2FA-gated surface.
  'objects:anon deny lost-found-item-photos',
]);

// Regex matches `create policy NAME on TABLE` or `alter policy NAME on TABLE`.
// Accepts NAME as either "quoted" or unquoted (identifier). Accepts TABLE
// as either "quoted" or unquoted, optionally schema-qualified (schema.table
// or "schema"."table"). Codex review finding #5: prior version required
// double-quotes around NAME, missing the common unquoted form used by all
// existing *_deny_browser policies. If a future migration uses that form
// without the mfa_verified gate, the guard would silently let it through.
//
// Note: this regex does NOT detect policies created via dynamic SQL inside
// a DO block (e.g., `execute format('create policy ...')`). That class is
// caught by the runtime audit in scripts/audit-pg-policies-runtime.mjs
// which queries prod pg_policies directly.
const POLICY_RX = /(?:create|alter)\s+policy\s+(?:"([^"]+)"|([a-zA-Z_][\w]*))\s+on\s+(?:(?:"([^"]+)"|([a-zA-Z_][\w]*))\.)?(?:"([^"]+)"|([a-zA-Z_][\w]*))/gi;
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
      // POLICY_RX capture groups:
      //   [1] policy name (quoted)
      //   [2] policy name (unquoted)
      //   [3] schema (quoted)        — optional
      //   [4] schema (unquoted)      — optional
      //   [5] table (quoted)
      //   [6] table (unquoted)
      const policyName = m[1] ?? m[2];
      const tableName = m[5] ?? m[6];
      if (!policyName || !tableName) continue;
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
