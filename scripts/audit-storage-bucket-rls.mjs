#!/usr/bin/env node
// audit-storage-bucket-rls — fails the build if any private storage bucket
// declared in supabase/migrations/ lacks a per-property RLS policy.
//
// Why: migration 0144 closed a HIGH-severity bug where the
// `maintenance-photos` bucket's policy was auth-only, letting any
// authenticated user read another tenant's photos via guessable folder
// paths. The canonical fix is to scope each policy by
// `user_owns_property(((storage.foldername(name))[1])::uuid)`. This
// tripwire prevents a future migration from regressing.
//
// Cumulative-state algorithm:
//   1. Walk every migration in lexicographic order (deploy order).
//   2. Track each `insert into storage.buckets ... values ('X', ..., <public>, ...)`
//      with its name + public flag.
//   3. Track each `create policy ... on storage.objects` that scopes via
//      `bucket_id = 'X'` and capture the policy text.
//   4. Track DROP POLICY removals.
//   5. After all migrations: for every private bucket (public=false), assert
//      at least one policy text contains BOTH `user_owns_property` AND a
//      per-folder extraction (one of: storage.foldername, string_to_array,
//      split_part) — handles semantic equivalents per the v3 review brief.
//
// Escape markers (each requires a real one-line reason):
//   -- @storage: public-by-design — <reason>   (bucket is anon-readable on purpose)
//   -- @storage: service-role-only — <reason>  (no anon/authenticated policy)
//   -- @storage: account-scoped — <reason>     (folder = account_id, not property_id)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

function listMigrations() {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

// Strip SQL comments while preserving newlines. Inlined for standalone script.
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

// State: bucket name → { public: bool, escapeKind: 'public-by-design'|'service-role-only'|'account-scoped'|null, escapeReason: string|null }
const buckets = new Map();
// state: policy name → { tableQualified: 'storage.objects', bucketIds: Set<string>, text: string }
const policies = new Map();

// Per-folder extraction patterns: a policy is "per-folder scoped" if it
// contains user_owns_property AND any of these.
const PER_FOLDER_FN_RX = /\b(storage\.foldername|string_to_array|split_part)\b/i;

function processMigration(file, raw) {
  const sql = stripSqlComments(raw);
  const lower = sql.toLowerCase();

  // 1. Bucket inserts.
  //
  // The standard Supabase pattern:
  //   insert into storage.buckets (id, name, public, ...) values
  //     ('invoices', 'invoices', false, ...)
  //   on conflict ...
  //
  // We scan VALUES tuples — each ( ... ) at depth 1 after VALUES is a row.
  // For each row, the first text literal is the id (== bucket name in
  // practice). The first boolean after that is the public flag.
  const insertRx = /\binsert\s+into\s+storage\.buckets\b/gi;
  let m;
  while ((m = insertRx.exec(sql)) !== null) {
    const after = sql.slice(m.index);
    const valuesIdx = after.toLowerCase().indexOf('values');
    if (valuesIdx < 0) continue;
    const tail = after.slice(valuesIdx + 6);
    // Parse VALUES tuples until we hit a top-level `;` or `on conflict`.
    let depth = 0;
    let bufStart = -1;
    const tuples = [];
    let stop = false;
    for (let i = 0; i < tail.length && !stop; i++) {
      const c = tail[i];
      if (c === '(') { if (depth === 0) bufStart = i + 1; depth++; }
      else if (c === ')') {
        depth--;
        if (depth === 0 && bufStart >= 0) {
          tuples.push(tail.slice(bufStart, i));
          bufStart = -1;
        }
      } else if (depth === 0 && c === ';') { stop = true; }
      else if (depth === 0) {
        const rest = tail.slice(i).toLowerCase();
        if (rest.startsWith('on conflict') || rest.startsWith('returning')) {
          stop = true;
        }
      }
    }

    for (const tuple of tuples) {
      // First single-quoted string == bucket id/name.
      const sm = tuple.match(/'([^']+)'/);
      if (!sm) continue;
      const bucketName = sm[1];
      // Look for the public flag: true/false token at depth 0 in this tuple.
      // Heuristic: find a boolean literal (true/false). If there are several,
      // take the FIRST one (Supabase column order: id, name, owner, public).
      const boolMatch = tuple.match(/\b(true|false)\b/i);
      const isPublic = boolMatch ? boolMatch[1].toLowerCase() === 'true' : false;

      // Escape markers must be a SQL comment within ~800 chars before the
      // `insert into storage.buckets` line in the ORIGINAL source.
      const insertIdxRaw = raw.indexOf(m[0]);
      const lookback = insertIdxRaw > 0
        ? raw.slice(Math.max(0, insertIdxRaw - 800), insertIdxRaw)
        : '';
      let escapeKind = null;
      let escapeReason = null;
      const escRx = /--\s*@storage:\s*(public-by-design|service-role-only|account-scoped)\b[^\n]*/i;
      const escMatch = lookback.match(escRx);
      if (escMatch) {
        escapeKind = escMatch[1].toLowerCase();
        escapeReason = escMatch[0];
      }

      buckets.set(bucketName, {
        public: isPublic,
        escapeKind,
        escapeReason,
        file,
      });
    }
  }

  // 2. & 3. CREATE / DROP POLICY on storage.objects — process in SOURCE
  //    ORDER so the idiomatic `drop policy if exists "X"; create policy "X"`
  //    pattern leaves the policy created at end-of-migration (the DROP
  //    cleans up any prior version, then the CREATE installs the new one).
  //    A naive "all CREATEs then all DROPs" pass would delete what was
  //    just created in the same migration.
  const createPolRx = /\bcreate\s+policy\s+("[^"]+"|[a-zA-Z_][\w]*)\s+on\s+(storage\.objects)\b/gi;
  const dropPolRx = /\bdrop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|[a-zA-Z_][\w]*)\s+on\s+storage\.objects/gi;

  const events = [];
  let cm;
  while ((cm = createPolRx.exec(sql)) !== null) {
    events.push({ kind: 'create', index: cm.index, name: cm[1].replace(/"/g, '') });
  }
  let dm;
  while ((dm = dropPolRx.exec(sql)) !== null) {
    events.push({ kind: 'drop', index: dm.index, name: dm[1].replace(/"/g, '') });
  }
  events.sort((a, b) => a.index - b.index);

  for (const ev of events) {
    if (ev.kind === 'drop') {
      policies.delete(ev.name);
      continue;
    }
    // CREATE — capture text through next top-level `;`.
    const tail = sql.slice(ev.index);
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] === '(') depth++;
      else if (tail[i] === ')') depth--;
      else if (tail[i] === ';' && depth === 0) { endIdx = i; break; }
    }
    const text = (endIdx > 0 ? tail.slice(0, endIdx) : tail).toLowerCase();
    const bucketIds = new Set();
    const bidRx = /bucket_id\s*(?:=|in)\s*\(?\s*'([^']+)'/gi;
    let bm;
    while ((bm = bidRx.exec(text)) !== null) bucketIds.add(bm[1]);
    policies.set(ev.name, { text, bucketIds });
  }
}

const files = listMigrations();
for (const f of files) {
  processMigration(f, readFileSync(join(MIGRATIONS, f), 'utf8'));
}

// Evaluate each bucket against the policy set.
const violations = [];
for (const [bucketName, bucket] of buckets.entries()) {
  if (bucket.public) {
    // Public buckets must have an explicit escape marker.
    if (bucket.escapeKind !== 'public-by-design') {
      violations.push({
        bucket: bucketName,
        reason: `public = true but no \`-- @storage: public-by-design\` escape marker in ${bucket.file}`,
      });
    }
    continue;
  }
  // Private bucket — find policies referencing it.
  const matching = [];
  for (const [, p] of policies.entries()) {
    if (p.bucketIds.has(bucketName)) matching.push(p);
  }

  // Service-role-only is intentional deny-all: no anon/auth policy needed.
  if (bucket.escapeKind === 'service-role-only') continue;
  // Account-scoped uses account_id folder, not property_id — accept if the
  // policy text uses account or data_user_id with a per-folder extraction.
  if (bucket.escapeKind === 'account-scoped') {
    const accountGuarded = matching.some((p) =>
      PER_FOLDER_FN_RX.test(p.text) && /\b(account_id|data_user_id)\b/.test(p.text)
    );
    if (!accountGuarded) {
      violations.push({
        bucket: bucketName,
        reason: `account-scoped escape declared but no policy ties bucket_id='${bucketName}' to account_id/data_user_id via a per-folder function`,
      });
    }
    continue;
  }

  if (matching.length === 0) {
    violations.push({
      bucket: bucketName,
      reason: `private bucket has zero RLS policies — declare per-property policies or add an escape marker`,
    });
    continue;
  }
  const propertyGuarded = matching.some((p) =>
    /\buser_owns_property\b/.test(p.text) && PER_FOLDER_FN_RX.test(p.text)
  );
  if (!propertyGuarded) {
    violations.push({
      bucket: bucketName,
      reason: `policies exist but none use \`user_owns_property\` + a per-folder extraction (storage.foldername / string_to_array / split_part) — this is the 0144 bug class`,
    });
  }
}

if (violations.length > 0) {
  console.error(
    `✗ audit-storage-bucket-rls: ${violations.length} bucket(s) missing per-property RLS:`,
  );
  for (const v of violations) console.error(`    ${v.bucket} — ${v.reason}`);
  console.error('');
  console.error('Every private storage bucket must scope policies by per-folder property check:');
  console.error('  create policy "<bucket>_owner_rw" on storage.objects for all to authenticated');
  console.error('    using (bucket_id = \'<bucket>\' and user_owns_property(((storage.foldername(name))[1])::uuid))');
  console.error('    with check (bucket_id = \'<bucket>\' and user_owns_property(((storage.foldername(name))[1])::uuid));');
  console.error('');
  console.error('If the bucket legitimately uses a different pattern, add one of:');
  console.error('  -- @storage: public-by-design — <reason>');
  console.error('  -- @storage: service-role-only — <reason>');
  console.error('  -- @storage: account-scoped — <reason>');
  console.error('on the line(s) above `insert into storage.buckets`.');
  process.exit(1);
}

console.log(
  `✓ audit-storage-bucket-rls: scanned ${files.length} migration(s), ${buckets.size} bucket(s); all private buckets per-property protected.`,
);
