#!/usr/bin/env node
// scripts/generate-mfa-rls-sweep.mjs
//
// Auto-generates supabase/migrations/0161_rls_require_mfa_verified.sql
// by querying prod pg_policies, applying the Phase 2B exemption list,
// and emitting ALTER POLICY statements that AND each existing USING /
// WITH CHECK clause with `public.mfa_verified_or_grace()`.
//
// Phase 2B (audit 2026-05-22). Run once at implementation time; commit
// the generated SQL so the migration diff is auditable. Re-run at
// merge time if main has progressed.
//
// Requires:
//   - libpq psql in PATH (or at /opt/homebrew/opt/libpq/bin/psql)
//   - SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD + SUPABASE_DB_HOST
//     env vars (sourced from ~/.config/staxis/tokens.env or .env.local)
//
// Usage:
//   node scripts/generate-mfa-rls-sweep.mjs
//   # → writes supabase/migrations/0161_rls_require_mfa_verified.sql

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Exemption list — policies that MUST NOT be gated ─────────────────
// (must remain accessible for unverified tokens; otherwise sign-in
// breaks or service-role-only tables get a useless gate)
const EXEMPT_POLICIES = new Set([
  // Auth-flow: AuthContext reads own accounts row before OTP completes
  'accounts:accounts_self_select',
  'accounts:account can read self',
  // Already denies — adding a gate would be a no-op
  'accounts:accounts_deny_writes',
]);

// ── Skip patterns ─────────────────────────────────────────────────────
// Policies whose qual is literally `false` (deny-all) — adding the gate
// is pointless because they never match anyway.
function isDenyAllQual(qual) {
  if (!qual) return false;
  return qual.trim() === 'false';
}

// Service-role-only roles — never user-facing.
function isServiceRoleOnly(roles) {
  if (!roles || roles.length === 0) return false;
  return roles.every((r) => r === 'supabase_auth_admin' || r === 'service_role');
}

// ── DB connection ─────────────────────────────────────────────────────
function dbUrl() {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const host = process.env.SUPABASE_DB_HOST;
  if (!ref || !pw || !host) {
    console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_DB_HOST');
    console.error('Source ~/.config/staxis/tokens.env first');
    process.exit(1);
  }
  return `postgresql://postgres.${ref}:${pw}@${host}:6543/postgres?sslmode=require`;
}

function psqlBin() {
  const candidates = [
    '/opt/homebrew/opt/libpq/bin/psql',
    '/usr/local/opt/libpq/bin/psql',
    'psql',
  ];
  for (const c of candidates) {
    try {
      execSync(`command -v ${c}`, { stdio: 'pipe' });
      return c;
    } catch {
      // try next
    }
  }
  console.error('psql not found. Install libpq.');
  process.exit(1);
}

function runQuery(sql) {
  const url = dbUrl();
  const bin = psqlBin();
  // Use a unique field separator unlikely to appear in qual/with_check
  // text. Multi-character delimiter to avoid collisions.
  const SEP = '|||';
  // Strip embedded newlines from qual/with_check. Cast tablename +
  // policyname to text explicitly — pg_policies.tablename + .policyname
  // are `name` type (64-char limit); mixing them in an array with text
  // makes the array `name[]` and TRUNCATES text elements to 64 chars.
  // (Hit this bug once already; document the cast.)
  const wrapped = `SELECT array_to_string(array[ tablename::text, policyname::text, cmd::text, array_to_string(roles, ','), regexp_replace(coalesce(qual, ''), E'[\\r\\n]+', ' ', 'g'), regexp_replace(coalesce(with_check, ''), E'[\\r\\n]+', ' ', 'g') ], '${SEP}', '') FROM (${sql.replace(/\n/g, ' ')}) sub`;
  // Pass SQL via stdin so newlines and special chars are preserved without
  // shell-quoting headaches.
  const out = execSync(`"${bin}" "${url}" -At`, {
    encoding: 'utf8',
    input: wrapped,
    maxBuffer: 10 * 1024 * 1024,
  });
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(SEP));
}

// ── Main ──────────────────────────────────────────────────────────────
function main() {
  const rows = runQuery(`
    SELECT *
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `);

  const skipped = [];
  const gated = [];

  for (const fields of rows) {
    const [tablename, policyname, cmd, rolesStr, qualRaw, withCheckRaw] = fields;
    const roles = (rolesStr || '').split(',').filter(Boolean);
    const key = `${tablename}:${policyname}`;

    // Skip explicit exemptions.
    if (EXEMPT_POLICIES.has(key)) {
      skipped.push({ key, reason: 'EXEMPT' });
      continue;
    }
    // Skip deny-all policies — adding mfa gate is pointless.
    if (isDenyAllQual(qualRaw) && (withCheckRaw === '' || isDenyAllQual(withCheckRaw))) {
      skipped.push({ key, reason: 'deny-all (USING false)' });
      continue;
    }
    // Skip service-role-only.
    if (isServiceRoleOnly(roles)) {
      skipped.push({ key, reason: `service-role only (${rolesStr})` });
      continue;
    }

    // Build the ALTER POLICY statement.
    // Quote the policy name (it has spaces in many cases).
    // Each command type accepts:
    //   SELECT/DELETE → USING only
    //   INSERT        → WITH CHECK only
    //   UPDATE/ALL    → USING + WITH CHECK
    const cmdU = cmd.toUpperCase();
    const newQual = qualRaw
      ? `(${qualRaw}) and public.mfa_verified_or_grace()`
      : 'public.mfa_verified_or_grace()';
    const newCheck = withCheckRaw
      ? `(${withCheckRaw}) and public.mfa_verified_or_grace()`
      : 'public.mfa_verified_or_grace()';

    let stmt = `alter policy "${policyname}" on public.${tablename}`;
    if (cmdU === 'SELECT' || cmdU === 'DELETE' || cmdU === 'R' /* legacy */) {
      stmt += `\n  using (${newQual});`;
    } else if (cmdU === 'INSERT') {
      stmt += `\n  with check (${newCheck});`;
    } else if (cmdU === 'UPDATE' || cmdU === 'ALL') {
      // Both USING (for the "old row" check on UPDATE) and WITH CHECK
      // (for the "new row" check). If the original had no WITH CHECK,
      // emit just USING (Postgres preserves the existing CHECK).
      if (qualRaw) stmt += `\n  using (${newQual})`;
      if (withCheckRaw) stmt += `\n  with check (${newCheck})`;
      stmt += `;`;
    } else {
      skipped.push({ key, reason: `unknown cmd: ${cmd}` });
      continue;
    }
    gated.push({ key, cmd, stmt });
  }

  // ── Emit migration file ────────────────────────────────────────────
  const lines = [];
  lines.push('-- Phase 2B / Door B fix (audit 2026-05-22) — RLS sweep.');
  lines.push('-- Auto-generated by scripts/generate-mfa-rls-sweep.mjs from prod');
  lines.push('-- pg_policies. Every authenticated/public policy gets the');
  lines.push('-- mfa_verified_or_grace() gate AND-ed to its existing USING /');
  lines.push('-- WITH CHECK clauses.');
  lines.push('--');
  lines.push('-- Apply order: 0159 (table + helper) → 0160 (hook v2) → wait');
  lines.push('-- ~5-10min for active sessions to refresh tokens → THIS migration');
  lines.push('-- (0161) → wait 24h → 0162 (tighten coalesce default to false).');
  lines.push('');
  lines.push('-- ── Pre-flight: refuse to apply if 0159 not in place yet ──────');
  lines.push('-- Without the helper function, every gated policy will fail to');
  lines.push('-- evaluate and deny every authenticated read. Loud fail > silent');
  lines.push('-- breakage.');
  lines.push('do $$ begin');
  lines.push('  if to_regprocedure(\'public.mfa_verified_or_grace()\') is null then');
  lines.push('    raise exception \'apply migration 0159 first — mfa_verified_or_grace function missing\';');
  lines.push('  end if;');
  lines.push('end$$;');
  lines.push('');
  lines.push('-- ── Skipped (informational, no SQL emitted) ───────────────────');
  for (const s of skipped) {
    lines.push(`-- SKIP ${s.key}: ${s.reason}`);
  }
  lines.push('');
  lines.push(`-- ── Gated policies (${gated.length} total) ─────────────────────`);
  lines.push('');
  for (const g of gated) {
    lines.push(`-- ${g.key} (cmd=${g.cmd})`);
    lines.push(g.stmt);
    lines.push('');
  }
  lines.push('notify pgrst, \'reload schema\';');
  lines.push('');
  lines.push('insert into public.applied_migrations (version, description)');
  lines.push('values (');
  lines.push('  \'0161\',');
  lines.push(`  'Audit 2026-05-22 Phase 2B: RLS sweep — ${gated.length} policies now AND-gated on mfa_verified_or_grace().'`);
  lines.push(')');
  lines.push('on conflict (version) do nothing;');

  const outPath = resolve(
    process.cwd(),
    'supabase/migrations/0161_rls_require_mfa_verified.sql',
  );
  writeFileSync(outPath, lines.join('\n') + '\n');

  console.log(`Wrote ${outPath}`);
  console.log(`Gated:  ${gated.length} policies`);
  console.log(`Skipped: ${skipped.length} policies`);
  for (const s of skipped) console.log(`  - ${s.key}: ${s.reason}`);
}

main();
