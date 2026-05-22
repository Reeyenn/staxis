#!/usr/bin/env node
// audit-rls-policy-coverage — fails the build if any tenant-scoped table in
// the public schema lacks RLS or lacks a policy that ties access to the
// caller's identity.
//
// Why: the canonical multi-tenant guard in this codebase is
//   `create policy "owner rw X" on X for all using (user_owns_property(property_id))`.
// A new table with a `property_id` column but no policy is the highest-blast-
// radius regression possible — every user sees every hotel's rows. Lint
// catches that at PR time, before any data is written through it.
//
// Cumulative-state algorithm (handles ALTER TABLE / DROP TABLE correctly):
//   1. Walk every migration in lexicographic order (matches deploy order).
//   2. Track each `CREATE TABLE [IF NOT EXISTS] public.<name> ( ... )`:
//        - column set parsed from the CREATE body.
//        - rls flag (defaults false; set true on ALTER TABLE ... ENABLE).
//        - policies (set of policy names).
//        - allowlist marker (from a `-- @rls: service-role-only` comment
//          adjacent to the CREATE).
//   3. `ALTER TABLE ... ADD COLUMN col type` adds to the column set.
//   4. `ALTER TABLE ... DROP COLUMN col` removes from the column set.
//   5. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` flips rls=true.
//   6. `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` flips rls=false.
//   7. `CREATE POLICY "name" ON public.<table> ...` adds policy + records
//      the policy text (we look for `user_owns_property`, `auth.uid()`, or
//      a reference to the tenant column).
//   8. `DROP POLICY` / `DROP TABLE` cleanup.
//
// At the end, for every still-existing public.* table whose final column set
// contains any of the TENANT_COLUMNS:
//   - RLS must be enabled.
//   - At least one policy must reference user_owns_property, auth.uid(), or
//     the tenant column itself.
//   - OR the table must be on the SERVICE_ROLE_ONLY allowlist (RLS-on +
//     zero policies = deny-all; intentional for the 7 listed tables).
//
// TENANT_COLUMNS:
//   property_id   — the primary multi-tenant key (hotel)
//   account_id    — secondary (user account)
//   data_user_id  — Supabase Auth UID bridge
//   user_id       — per-user data
//   staff_id      — per-staff-member data
//   hotel_id      — Firestore-era leftover; flagged if found

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

const TENANT_COLUMNS = new Set([
  'property_id',
  'account_id',
  'data_user_id',
  'user_id',
  'staff_id',
  'hotel_id',
]);

// Tables intentionally configured as service-role-only:
//   RLS enabled, no public policies → anon/authenticated denied by default,
//   service-role bypasses RLS for legitimate server writes/reads.
//
// Every entry was verified by reading the originating migration:
//   - 0008 api_limits        — server rate limiter; also REVOKEs anon grants
//   - 0011 (BLOCKED)         — pull_metrics, scraper_session: NO RLS YET; fixed in 0200
//   - 0018 scraper_credentials — has explicit deny-browser policy
//   - 0019 idempotency_log   — has explicit deny-browser policy
//   - 0020 sms_jobs          — has explicit deny-browser policy
//   - 0031 onboarding_jobs   — has explicit deny-browser policy
//   - 0035 stripe_processed_events — has explicit deny-browser policy
//   - 0042 pull_jobs         — has explicit deny-browser policy
//   - 0051 app_events        — "writes go through /api/events, reads via /api/admin/activity"
//   - 0052 user_feedback     — "routes use the service role"
//   - 0055 expenses          — fleet-level financial; admin-only via supabaseAdmin
//   - 0056 claude_usage_log  — server telemetry only
//   - 0063 trusted_devices   — "only service-role writes via API routes"
//   - 0093 agent_cost_finalize_failures — "no end-user reads. Service role only"
//   - 0139 processed_twilio_webhooks — has explicit deny-browser policy
//   - 0155 staff_magic_codes — "default-deny" comment
//
// Plus the 7 tables migration 0200 codifies with explicit deny policies:
const SERVICE_ROLE_ONLY = new Set([
  // From the audit — RLS-on, no policies, intentional (per inline comments
  // in their originating migrations).
  'agent_eval_baselines',
  'agent_prompts',
  'agent_conversations_archived',
  'agent_messages_archived',
  'agent_voice_sessions',
  'error_logs',
  'webhook_log',
  // RLS-on, no policies, intentional (long-standing operational tables).
  'api_limits',
  'app_events',
  'user_feedback',
  'expenses',
  'claude_usage_log',
  'trusted_devices',
  'agent_cost_finalize_failures',
  'staff_magic_codes',
  // Phase A (2026-05-22 audit, Hole #1): hook writes proof rows when
  // Supabase tags JWT issuance with authentication_method='password';
  // trust-device reads via supabaseAdmin. Never user-readable — the
  // raw rows would leak that a password sign-in happened.
  'password_signin_proofs',
  // Phase 2B (2026-05-22 audit, Door B): hook writes mfa_verified_sessions
  // rows when a session is bound to a trusted device via trust-device.
  // Read-only by supabase_auth_admin (hook) + service-role. Never user-
  // readable — would leak which sessions are device-trusted vs not.
  'mfa_verified_sessions',
  // RLS-on with explicit deny-browser policies (no end-user access).
  // Listed for clarity; they'd pass the policy check via their deny policy
  // text containing `false` and the table name, but the lint matches on
  // user_owns_property/auth.uid()/tenant-col patterns which intentionally
  // DON'T appear in a deny policy. Allowlisting is the cleaner mechanism.
  'scraper_credentials',
  'idempotency_log',
  'sms_jobs',
  'onboarding_jobs',
  'stripe_processed_events',
  'pull_jobs',
  'processed_twilio_webhooks',
  // Closed by migration 0200 (this audit) — RLS enabled + REVOKE + deny
  // policy. Service-role-only.
  'pull_metrics',
  'scraper_session',
  // Global, non-tenant operational tables (no tenant column anyway).
  'scraper_status',
  'dashboard_by_date',
  'demand_priors',
  'supply_priors',
  'applied_migrations',
]);

function listMigrations() {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

// Re-use the comment scrubber idea from audit-security-definer-search-path,
// but inline a lighter version here so each script remains standalone.
function stripSqlComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inDollar = null;
  while (i < n) {
    if (!inLine && !inBlock && !inDollar) {
      const dq = src.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (dq) { inDollar = dq[0]; out.push(dq[0]); i += dq[0].length; continue; }
    }
    if (inDollar) {
      if (src.slice(i, i + inDollar.length) === inDollar) {
        out.push(inDollar); i += inDollar.length; inDollar = null; continue;
      }
      out.push(src[i]); i++; continue;
    }
    if (inBlock) {
      if (src[i] === '*' && src[i + 1] === '/') { out.push('  '); i += 2; inBlock = false; continue; }
      out.push(src[i] === '\n' ? '\n' : ' '); i++; continue;
    }
    if (inLine) {
      if (src[i] === '\n') { out.push('\n'); inLine = false; i++; continue; }
      out.push(' '); i++; continue;
    }
    if (src[i] === '-' && src[i + 1] === '-') { out.push('  '); i += 2; inLine = true; continue; }
    if (src[i] === '/' && src[i + 1] === '*') { out.push('  '); i += 2; inBlock = true; continue; }
    if (src[i] === "'") {
      out.push("'"); i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") { out.push("''"); i += 2; continue; }
        if (src[i] === "'") { out.push("'"); i++; break; }
        out.push(src[i]); i++;
      }
      continue;
    }
    out.push(src[i]); i++;
  }
  return out.join('');
}

// Returns lowercase bare table name from a "[schema.]name" reference. We only
// care about the public schema; non-public references return null.
function publicTableName(ref) {
  if (!ref) return null;
  const s = ref.toLowerCase().replace(/"/g, '');
  const parts = s.split('.');
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && parts[0] === 'public') return parts[1];
  return null;
}

// Parse the column definitions from a CREATE TABLE body. We're not building
// a real SQL parser — we just want to know which column names exist. Take the
// body between the first `(` after the table name and the matching `)`. Then
// split on commas at depth 0 and grab the first identifier on each piece.
function parseColumns(createBody) {
  // Find balanced parens.
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < createBody.length; i++) {
    if (createBody[i] === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (createBody[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (start < 0 || end < 0) return [];
  const body = createBody.slice(start, end);

  // Split on commas at top level.
  const pieces = [];
  let buf = '';
  depth = 0;
  for (const c of body) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { pieces.push(buf); buf = ''; }
    else buf += c;
  }
  if (buf.trim()) pieces.push(buf);

  const cols = [];
  for (let piece of pieces) {
    piece = piece.trim();
    if (!piece) continue;
    // Skip table-level constraints like `primary key (a, b)`, `unique (...)`,
    // `check (...)`, `foreign key (...)`, `constraint NAME ...`.
    const head = piece.toLowerCase().match(/^(primary\s+key|unique|check|foreign\s+key|constraint|exclude|like|using)\b/);
    if (head) continue;
    const m = piece.match(/^"?([a-zA-Z_][\w]*)"?\b/);
    if (m) cols.push(m[1].toLowerCase());
  }
  return cols;
}

// State.
const tables = new Map(); // name → { columns:Set, rls:bool, policies:Set, policyTexts:[], allowlistComment:bool }

function ensureTable(name) {
  if (!tables.has(name)) {
    tables.set(name, {
      columns: new Set(),
      rls: false,
      policies: new Set(),
      policyTexts: [],
      allowlistComment: false,
    });
  }
  return tables.get(name);
}

function processMigration(file, raw) {
  const sql = stripSqlComments(raw);

  // CREATE TABLE [IF NOT EXISTS] public.<name> (...)
  // Capture body until balanced close paren via regex-light scan.
  const createRx = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w\.]*)\s*\(/gi;
  let m;
  while ((m = createRx.exec(sql)) !== null) {
    const name = publicTableName(m[1]);
    if (!name) continue;
    // Walk paren depth from m.index
    const tail = sql.slice(m.index);
    let depth = 0;
    let endIdx = -1;
    for (let i = tail.indexOf('('); i < tail.length; i++) {
      if (tail[i] === '(') depth++;
      else if (tail[i] === ')') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx < 0) continue;
    const fullCreate = tail.slice(0, endIdx + 1);
    const cols = parseColumns(fullCreate);

    const t = ensureTable(name);
    for (const c of cols) t.columns.add(c);

    // Allowlist marker: a `-- @rls: service-role-only` comment must appear
    // within ~20 lines before the CREATE TABLE in the ORIGINAL (non-scrubbed)
    // source.
    const rawBeforeIdx = raw.indexOf(m[0]);
    if (rawBeforeIdx > 0) {
      const lookback = raw.slice(Math.max(0, rawBeforeIdx - 800), rawBeforeIdx);
      if (/--\s*@rls:\s*service-role-only\b/i.test(lookback)) {
        t.allowlistComment = true;
      }
    }
  }

  // ALTER TABLE ... { ENABLE | DISABLE } ROW LEVEL SECURITY
  const rlsRx = /\balter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z_][\w\.]*)\s+(enable|disable)\s+row\s+level\s+security/gi;
  while ((m = rlsRx.exec(sql)) !== null) {
    const name = publicTableName(m[1]);
    if (!name) continue;
    const t = ensureTable(name);
    t.rls = m[2].toLowerCase() === 'enable';
  }

  // ALTER TABLE ... ADD COLUMN <name> <type>
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS <name> <type>
  const addColRx = /\balter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z_][\w\.]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][\w]*)"?/gi;
  while ((m = addColRx.exec(sql)) !== null) {
    const name = publicTableName(m[1]);
    if (!name) continue;
    ensureTable(name).columns.add(m[2].toLowerCase());
  }

  // ALTER TABLE ... DROP COLUMN [IF EXISTS] <name>
  const dropColRx = /\balter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z_][\w\.]*)\s+drop\s+column\s+(?:if\s+exists\s+)?"?([a-zA-Z_][\w]*)"?/gi;
  while ((m = dropColRx.exec(sql)) !== null) {
    const name = publicTableName(m[1]);
    if (!name) continue;
    const t = tables.get(name);
    if (t) t.columns.delete(m[2].toLowerCase());
  }

  // DROP TABLE [IF EXISTS] public.<name>
  const dropTblRx = /\bdrop\s+table\s+(?:if\s+exists\s+)?([a-zA-Z_][\w\.]*)/gi;
  while ((m = dropTblRx.exec(sql)) !== null) {
    const name = publicTableName(m[1]);
    if (!name) continue;
    tables.delete(name);
  }

  // CREATE POLICY "name" ON [public.]<table> ...   USING(...) WITH CHECK(...)
  // We capture the policy header through the next `;` to get the full text.
  const polRx = /\bcreate\s+policy\s+("[^"]+"|[a-zA-Z_][\w]*)\s+on\s+([a-zA-Z_][\w\.]*)/gi;
  while ((m = polRx.exec(sql)) !== null) {
    const polName = m[1].replace(/"/g, '').toLowerCase();
    const table = publicTableName(m[2]);
    if (!table) continue;
    // Capture text until next `;` at top level.
    const after = sql.slice(m.index);
    let endP = after.search(/;/);
    const policyText = (endP > 0 ? after.slice(0, endP) : after).toLowerCase();
    const t = ensureTable(table);
    t.policies.add(polName);
    t.policyTexts.push(policyText);
  }

  // DROP POLICY [IF EXISTS] "name" ON [public.]<table>
  const dropPolRx = /\bdrop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|[a-zA-Z_][\w]*)\s+on\s+([a-zA-Z_][\w\.]*)/gi;
  while ((m = dropPolRx.exec(sql)) !== null) {
    const polName = m[1].replace(/"/g, '').toLowerCase();
    const table = publicTableName(m[2]);
    if (!table) continue;
    const t = tables.get(table);
    if (t) {
      t.policies.delete(polName);
      // We don't try to remove the text — policyTexts is best-effort.
    }
  }
}

const files = listMigrations();
for (const f of files) {
  processMigration(f, readFileSync(join(MIGRATIONS, f), 'utf8'));
}

const violations = [];
let scoped = 0;
for (const [name, t] of tables.entries()) {
  const tenantCols = [...t.columns].filter((c) => TENANT_COLUMNS.has(c));
  if (tenantCols.length === 0) continue;
  scoped++;

  // Tenant-scoped tables must have RLS on.
  if (!t.rls) {
    violations.push({ name, reason: 'has tenant column(s) but RLS not enabled', tenantCols });
    continue;
  }

  // Look for a policy referencing user_owns_property, auth.uid(), or any of
  // the tenant column names.
  const tenantColNeedles = tenantCols.map((c) => new RegExp(`\\b${c}\\b`));
  const guarded = t.policyTexts.some((text) =>
    /\buser_owns_property\b/.test(text)
    || /\bauth\.uid\s*\(/.test(text)
    || tenantColNeedles.some((rx) => rx.test(text))
  );

  if (!guarded) {
    // Allowlist escape: explicit service-role-only intent.
    if (SERVICE_ROLE_ONLY.has(name) || t.allowlistComment) continue;
    violations.push({
      name,
      reason: 'tenant column(s) but no policy referencing user_owns_property / auth.uid() / tenant column',
      tenantCols,
    });
  }

  // Note: `hotel_id` is treated as a valid tenant column above. It's a
  // Firestore-era naming convention that survives in account_invites +
  // hotel_join_codes; both tables have proper RLS policies built on
  // user_owns_property(hotel_id). No separate Firestore-era flag — the
  // tenant-column policy check is what matters for security.
}

if (violations.length > 0) {
  console.error(
    `✗ audit-rls-policy-coverage: ${violations.length} tenant-scoped table(s) lack proper RLS coverage:`,
  );
  for (const v of violations) {
    console.error(`    ${v.name} — ${v.reason}  [tenant cols: ${v.tenantCols.join(', ')}]`);
  }
  console.error('');
  console.error('Every public-schema table with a tenant column must:');
  console.error('  1. Have RLS enabled (alter table X enable row level security).');
  console.error('  2. Have at least one policy that scopes by tenant (user_owns_property, auth.uid(),');
  console.error('     or a direct comparison to the tenant column).');
  console.error('');
  console.error('If a table is intentionally service-role-only (no browser/anon access), either:');
  console.error('  - Add the table name to SERVICE_ROLE_ONLY in this script with a justification, OR');
  console.error('  - Add a SQL comment `-- @rls: service-role-only — <reason>` near the CREATE TABLE.');
  process.exit(1);
}

console.log(
  `✓ audit-rls-policy-coverage: scanned ${files.length} migration(s), ${tables.size} table(s); ${scoped} tenant-scoped table(s) all have RLS + policy.`,
);
