#!/usr/bin/env node
// audit-data-invariants — THE RATCHET, part 2: the data layer's doctrine,
// machine-checked.
//
// src/lib/agent/INVARIANTS.md and src/lib/pms/INVARIANTS.md say what the data
// layer guarantees. A doc nobody checks decays into folklore within a quarter,
// and the decay is invisible: the sentence still reads true. This script makes
// four of those claims falsifiable at lint time.
//
//   1. DOC-DRIFT — every "Enforced by:" line that names a constraint / trigger
//      / index / function must name one that actually exists somewhere in
//      supabase/migrations/. Run over BOTH invariant docs, so the existing
//      claims are audited too, not just new ones. This is the highest-leverage
//      check here: it is what makes the rest of the doc trustworthy.
//
//   2. DINV-1 (tenant scoping) — a new pms_* table must carry
//      `property_id ... not null`, unless it is one of the three explicitly
//      family-scoped tables.
//
//   3. DINV-3 (lineage) — a pms_* FACT table created from the ratchet floor
//      onward must carry `source_ingest_id`. Applied from the floor rather
//      than retroactively because the ingest table it references is the
//      ingestion workstream's to name; the existing tables are recorded as a
//      documented gap in src/lib/pms/INVARIANTS.md, not silently ignored.
//
//   4. DINV-6 (money is cents) — a new numeric/float column whose name reads
//      like money must end in `_cents`. `_usd` is exempt (sub-cent AI token
//      telemetry, where integer cents is the WRONG unit). The pre-existing
//      product-side offenders are listed in KNOWN_LEGACY, which may shrink but
//      never grow — a companion test pins its size.
//
// Cumulative migration walker adapted from scripts/audit-rls-policy-coverage.mjs
// (same standalone-script convention: each audit script owns its parsing).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
// Test-only overrides (src/lib/__tests__/data-invariants.test.ts drives this
// script against a synthetic schema to prove the rules actually FIRE). Nothing
// in the app or CI sets them.
const MIGRATIONS = process.env.STAXIS_MIGRATIONS_DIR || join(REPO, 'supabase', 'migrations');

// ─── Configuration ─────────────────────────────────────────────────────────

/** pms_* tables scoped to a PMS FAMILY or globally, not to a hotel. Verified
 *  2026-07-24: these are the only ones without property_id, and each is shared
 *  across hotels by design. */
export const FAMILY_SCOPED_PMS_TABLES = new Set([
  'pms_knowledge_files',
  'pms_table_schemas',
  'pms_writeback_recipes',
  // GLOBAL, not per-hotel: the catalogue of feed TYPES ('roomStatus',
  // 'arrivals', …) and which pms_* table each lands in. A hotel's relationship
  // to a feed — do we expect it, how often, is it late — is the separate
  // per-hotel pms_feed_expectations, which does carry property_id. Adding one
  // here would mean re-seeding six identical rows per hotel and letting them
  // drift apart, which is the failure this split exists to prevent.
  'pms_feed_catalog',
]);

/** pms_* tables that are not per-hotel FACTS (config, caches, plumbing).
 *  DINV-3 lineage does not apply to them. */
const NON_FACT_PMS_TABLES = new Set([
  ...FAMILY_SCOPED_PMS_TABLES,
  'pms_reports_cache',
  'pms_inbox_messages',
  'pms_auth_codes',
  'pms_feed_values',
  'pms_recipes',
  'pms_field_mappings',
]);

/** Migrations from this number onward are held to DINV-3. Everything before
 *  it predates the report-ingestion pipeline that gives lineage a target. */
const LINEAGE_FLOOR = '0350';

const MONEY_WORD = /(cost|price|amount|revenue|fee|charge|balance|total|spend)/i;
const MONEY_TYPES = /^(numeric|decimal|real|double|float|money)/i;

/**
 * Money-shaped columns that predate DINV-6. This list may SHRINK (fix a column,
 * remove its entry) but must never GROW — src/lib/__tests__/data-invariants.test.ts
 * pins its size. New money columns end in _cents or _usd.
 */
export const KNOWN_LEGACY_MONEY_COLUMNS = new Set([
  // Inventory + equipment costing (dollars as numeric, pre-DINV-6).
  'inventory.unit_cost',
  'inventory_counts.unit_cost',
  'inventory_orders.unit_cost',
  'inventory_orders.total_cost',
  'inventory_discards.unit_cost',
  'inventory_discards.cost_value',
  'inventory_reconciliations.unit_cost',
  'inventory_delivery_corrections.previous_unit_cost',
  'inventory_delivery_corrections.previous_total_cost',
  'inventory_delivery_corrections.corrected_unit_cost',
  'inventory_delivery_corrections.corrected_total_cost',
  'equipment.purchase_cost',
  'equipment.replacement_cost',
  // Daily ops logging.
  'daily_logs.labor_cost',
  // Test-only: lets src/lib/__tests__/data-invariants.test.ts prove the
  // stale-exemption rule fires. Never set outside that test.
  ...(process.env.STAXIS_EXTRA_LEGACY_MONEY || '').split(',').filter(Boolean),
]);

// ─── SQL helpers (adapted from audit-rls-policy-coverage.mjs) ──────────────

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

function publicTableName(ref) {
  if (!ref) return null;
  const s = ref.toLowerCase().replace(/"/g, '');
  const parts = s.split('.');
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && parts[0] === 'public') return parts[1];
  return null;
}

/** Split a CREATE TABLE body into top-level column definitions. */
function splitColumnDefs(body) {
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (body[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start === -1 || end === -1) return [];
  const inner = body.slice(start, end);
  const pieces = [];
  let d = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { pieces.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) pieces.push(cur);
  return pieces.map(p => p.trim()).filter(Boolean);
}

const TABLE_CONSTRAINT_START = /^(primary\s+key|unique|check|constraint|foreign\s+key|exclude|like)\b/i;

/** { name, type, notNull, raw } for one column definition, or null. */
function parseColumnDef(def) {
  if (TABLE_CONSTRAINT_START.test(def)) return null;
  const m = def.match(/^"?([a-z_][a-z0-9_]*)"?\s+([a-z][a-z0-9_ ]*)/i);
  if (!m) return null;
  return {
    name: m[1].toLowerCase(),
    type: m[2].trim().toLowerCase(),
    // PRIMARY KEY implies NOT NULL in Postgres — a parser that misses that
    // reports every single-column-PK table as a tenancy violation.
    notNull: /\bnot\s+null\b/i.test(def) || /\bprimary\s+key\b/i.test(def),
    raw: def,
  };
}

function listMigrations() {
  return readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
}

/**
 * Walk every migration in deploy order and build the final schema state:
 * table -> { columns: Map<name, {type, notNull}>, createdIn }.
 */
function buildSchema(files) {
  const tables = new Map();
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, file), 'utf8'));

    const createRx = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s*\(/gi;
    let m;
    while ((m = createRx.exec(sql)) !== null) {
      const name = publicTableName(m[1]);
      if (!name) continue;
      const body = sql.slice(m.index + m[0].length - 1);
      const cols = new Map();
      for (const def of splitColumnDefs(body)) {
        const col = parseColumnDef(def);
        if (col) cols.set(col.name, { type: col.type, notNull: col.notNull });
      }
      if (!tables.has(name)) {
        tables.set(name, { columns: cols, createdIn: file });
      } else {
        // `create table if not exists` on an existing table: merge, don't reset.
        const t = tables.get(name);
        for (const [k, v] of cols) if (!t.columns.has(k)) t.columns.set(k, v);
      }
    }

    const addRx = /alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s+([a-z][a-z0-9_ ]*)/gi;
    while ((m = addRx.exec(sql)) !== null) {
      const name = publicTableName(m[1]);
      if (!name || !tables.has(name)) continue;
      const tail = sql.slice(m.index, m.index + 400);
      tables.get(name).columns.set(m[2].toLowerCase(), {
        type: m[3].trim().toLowerCase(),
        notNull: /\bnot\s+null\b/i.test(tail.split(';')[0]),
        addedIn: file,
      });
    }

    const dropColRx = /alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)\s+drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
    while ((m = dropColRx.exec(sql)) !== null) {
      const name = publicTableName(m[1]);
      if (name && tables.has(name)) tables.get(name).columns.delete(m[2].toLowerCase());
    }

    const dropRx = /drop\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)/gi;
    while ((m = dropRx.exec(sql)) !== null) {
      const name = publicTableName(m[1]);
      if (name) tables.delete(name);
    }
  }
  return tables;
}

// ─── Check 1: doc drift ────────────────────────────────────────────────────

const DOCS = process.env.STAXIS_INVARIANT_DOCS
  ? process.env.STAXIS_INVARIANT_DOCS.split(',').filter(Boolean)
  : [
      join(REPO, 'src', 'lib', 'agent', 'INVARIANTS.md'),
      join(REPO, 'src', 'lib', 'pms', 'INVARIANTS.md'),
    ];

/** Identifiers named as enforcement mechanisms on an "Enforced by" line. */
function extractEnforcementIdentifiers(line) {
  const ids = new Set();
  const kw = '(?:check\\s+)?(?:partial\\s+)?(?:unique\\s+)?(?:constraint|trigger|index|function|rpc)';
  const before = new RegExp(`${kw}\\s+\`([^\`]+)\``, 'gi');
  const after = new RegExp(`\`([^\`]+)\`\\s+${kw}`, 'gi');
  for (const rx of [before, after]) {
    let m;
    while ((m = rx.exec(line)) !== null) {
      const id = m[1].trim().replace(/\(\)$/, '').replace(/^public\./, '');
      // DB identifiers are lowercase snake_case. A camelCase backtick is a
      // CODE symbol (a TS wrapper around an RPC, say), not a claim about a
      // database object, so it is not this check's business.
      if (/^[a-z_][a-z0-9_]{3,}$/.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** A line that labels itself as an unmet claim asserts nothing to verify.
 *  Self-labelling is the point: it is greppable, and the doctrine already uses
 *  "NOT ENFORCED" the same way. */
const UNMET_CLAIM = /NOT\s+ENFORCED|NOT\s+DB-ENFORCED|PLANNED|CURRENTLY\s+ABSENT|KNOWN\s+GAP/i;

function checkDocDrift(migrationBlob) {
  const problems = [];
  let claims = 0;
  for (const doc of DOCS) {
    if (!existsSync(doc)) continue;
    const rel = doc.slice(REPO.length + 1);
    const lines = readFileSync(doc, 'utf8').split('\n');
    // The claim may sit on the "Enforced by" line itself OR on the indented
    // sub-bullets beneath it. Both are enforcement claims; only checking the
    // first line would let the real ones hide one indent level down.
    let inBlock = false;
    lines.forEach((line, i) => {
      if (/\*\*Enforced by:?\*\*/i.test(line)) inBlock = true;
      else if (/^\s*-\s+\*\*/.test(line) || /^#{1,6}\s/.test(line)) inBlock = false;
      else if (line.trim() === '' && !/^\s+/.test(lines[i + 1] ?? '')) inBlock = false;
      if (!inBlock) return;
      if (UNMET_CLAIM.test(line)) return;
      for (const id of extractEnforcementIdentifiers(line)) {
        claims++;
        if (!migrationBlob.includes(id)) {
          problems.push(`${rel}:${i + 1} claims \`${id}\` but no migration defines it`);
        }
      }
    });
  }
  return { problems, claims };
}

// ─── Run ───────────────────────────────────────────────────────────────────

const files = listMigrations();
const schema = buildSchema(files);
const migrationBlob = files.map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');

const violations = [];

// 1. doc drift
const drift = checkDocDrift(migrationBlob);
for (const p of drift.problems) violations.push(`[doc-drift] ${p}`);

// 2 + 3. pms_* tenancy + lineage
let pmsChecked = 0;
for (const [name, t] of schema) {
  if (!name.startsWith('pms_')) continue;
  pmsChecked++;
  const created = t.createdIn.slice(0, 4);
  if (!FAMILY_SCOPED_PMS_TABLES.has(name)) {
    const col = t.columns.get('property_id');
    if (!col) {
      violations.push(
        `[DINV-1] ${name} (${t.createdIn}) has no property_id. Every per-hotel pms_ table must ` +
        'carry `property_id uuid not null references public.properties(id)`, or be added to ' +
        'FAMILY_SCOPED_PMS_TABLES with a reason.',
      );
    } else if (!col.notNull) {
      violations.push(`[DINV-1] ${name}.property_id is nullable — a fact with no hotel is unattributable.`);
    }
  }
  if (created >= LINEAGE_FLOOR && !NON_FACT_PMS_TABLES.has(name) && !t.columns.has('source_ingest_id')) {
    violations.push(
      `[DINV-3] ${name} (${t.createdIn}) has no source_ingest_id. Every fact must name the ` +
      'ingestion event that produced it, or be listed in NON_FACT_PMS_TABLES.',
    );
  }
}

// 4. money columns
let moneyChecked = 0;
const seenMoneyColumns = new Set();
for (const [table, t] of schema) {
  for (const [col, meta] of t.columns) {
    if (!MONEY_TYPES.test(meta.type)) continue;
    if (!MONEY_WORD.test(col)) continue;
    moneyChecked++;
    if (/_cents$/.test(col) || /_usd$/.test(col)) continue;
    const key = `${table}.${col}`;
    seenMoneyColumns.add(key);
    if (KNOWN_LEGACY_MONEY_COLUMNS.has(key)) continue;
    violations.push(
      `[DINV-6] ${key} is ${meta.type} — money is an integer count of cents in a *_cents column. ` +
      '(Sub-cent AI token telemetry uses the *_usd suffix.)',
    );
  }
}

// The legacy list must track reality. An entry for a column that no longer
// matches means somebody fixed the column (good) and left the exemption behind
// (bad) — the next money column with that name would be silently exempt.
// Only meaningful against the REAL schema; a synthetic test fixture contains
// none of these columns by construction.
for (const key of (process.env.STAXIS_MIGRATIONS_DIR ? [] : KNOWN_LEGACY_MONEY_COLUMNS)) {
  if (!seenMoneyColumns.has(key)) {
    violations.push(
      `[DINV-6] KNOWN_LEGACY_MONEY_COLUMNS lists ${key}, which is no longer a money-shaped ` +
      'numeric column. Remove the entry — a stale exemption silently covers the next column ' +
      'that takes the name.',
    );
  }
}

if (violations.length > 0) {
  console.error(`✗ audit-data-invariants: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`    ${v}`);
  console.error('');
  console.error('The rules and their reasons live in src/lib/pms/INVARIANTS.md.');
  console.error('Fix the schema, or amend the doc AND the allowlist in this script together —');
  console.error('an invariant the doc claims but nothing enforces is worse than no doc.');
  process.exit(1);
}

console.log(
  `✓ audit-data-invariants: ${files.length} migration(s); ` +
  `${drift.claims} enforcement claim(s) verified across ${DOCS.filter(existsSync).length} doc(s); ` +
  `${pmsChecked} pms_* table(s) tenant-scoped; ${moneyChecked} money column(s) checked.`,
);
