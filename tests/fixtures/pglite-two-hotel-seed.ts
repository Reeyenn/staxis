/**
 * Seed TWO hotels into a migrated PGlite database, deriving every row from the
 * real catalog rather than from a hand-written fixture.
 *
 * WHY DERIVED
 * A hand-written fixture covers the tables whoever wrote it remembered. The
 * question this seeder exists to answer — "can hotel A see hotel B's rows?" —
 * is only answered for tables that actually CONTAIN a hotel-B row, so the
 * fixture has to track the schema automatically or the coverage silently rots
 * as tables are added.
 *
 * THE TWO SIDES
 *   • Every uuid on hotel A's rows starts `aaaaaaaa-`; on hotel B's, `bbbbbbbb-`.
 *   • Every free-text column on B carries the marker `ZZLEAKB`.
 *   • LOOKUP columns (name, room_number, username, …) get the SAME value on
 *     both sides on purpose. A handler that filters `.eq('room_number','101')`
 *     but forgets the hotel filter must be able to MATCH hotel B's row —
 *     otherwise the filter itself would hide the bug we are hunting.
 *   • Enum / CHECK-constrained columns take the first value the constraint
 *     allows, so both sides are identical there; they are never identifiers.
 *
 * Detection therefore keys on uuids and on the marker, never on row counts.
 */

import type { PGlite } from '@electric-sql/pglite';
import type { Catalog, ColumnMeta, TableMeta } from './postgrest-pglite';

export type Side = 'A' | 'B';

/**
 * How a row is flavoured.
 *   'hotelA'  — the hotel under test.
 *   'hotelB'  — the other hotel. Poisoned: `bbbbbbbb-` uuids + the marker.
 *   'neutral' — a second row on a table with NO hotel column, seeded only so
 *               hotel B's rows have something to foreign-key to (`accounts`).
 *               Reading one of these is legitimate, so it is NOT poisoned;
 *               `cccccccc-` uuids keep it out of the leak scan.
 */
type Flavour = 'hotelA' | 'hotelB' | 'neutral';

export const PID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const PID_B = 'bbbbbbbb-0000-4000-8000-000000000001';

/** Appears on every free-text column of every hotel-B row. */
export const LEAK_MARKER = 'ZZLEAKB';

/** Values shared by BOTH hotels so a forgotten filter can still match B. */
const SHARED_TEXT: Readonly<Record<string, string>> = Object.freeze({
  name: 'Maria Garcia',
  display_name: 'Maria Garcia',
  full_name: 'Maria Garcia',
  staff_name: 'Maria Garcia',
  assigned_to_name: 'Maria Garcia',
  item_name: 'Maria Garcia',
  username: 'maria',
  room_number: '101',
  room: '101',
  number: '101',
  room_inventory: '101',
  title: 'Test title',
  topic: 'test_topic',
  timezone: 'America/Chicago',
  unit: 'each',
});

/** Hotel-local today, matching what `propertyLocalToday()` computes. */
export function localToday(timeZone = 'America/Chicago'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const PAST_A = new Date(Date.now() - 20 * 60_000).toISOString();
const PAST_B = new Date(Date.now() - 10 * 60_000).toISOString();
const FUTURE_A = new Date(Date.now() + 60 * 60_000).toISOString();
const FUTURE_B = new Date(Date.now() + 120 * 60_000).toISOString();

/** Column names whose timestamp must be in the future to stay "pending". */
const FUTURE_RE = /(expires|expiry|fire_at|due|scheduled|next_|valid_until|ends_at|end_at|deadline)/;

/**
 * Timestamps that mean "this row is over". Stamping them would archive,
 * cancel or close every seeded row and most tools would then correctly find
 * nothing — a fixture that quietly proves nothing. Left NULL where nullable.
 */
const TOMBSTONE_RE =
  /(archived|deleted|canceled|cancelled|fired|resolved|closed|dismissed|revoked|disabled|ended|completed|acknowledged|denied|rejected|approved|paused|expired|purged|read_at|left_at|deactivated)/;

/**
 * Rows whose shape a generic generator cannot guess, one entry per CHECK the
 * database enforces as an exclusive-or. Each says WHY. `null` clears a column
 * the generator filled; the row is otherwise generated as usual.
 *
 * This list is deliberately small and deliberately visible: an entry here is a
 * claim about the schema, and a wrong claim shows up as an unseeded table.
 */
const ROW_PATCHES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  // "Aim at a person OR a department, never both" (0302).
  agent_reminders: { target_department: null },
  // "A role default carries a role and no staff_id" (0245).
  labor_wage_settings: { scope: 'role', staff_id: null },
  // "An interval SLO has a period and no clock time" (0339).
  pms_feed_expectations: { cadence_kind: 'interval', expected_at_local: null },
  // The promotion bar: an authored item needs no supporting-hotel count (0353).
  knowledge_promotions: { origin: 'authored', is_aggregate: false },
  // A support session's reason is free text with a minimum length (0331+).
  staxis_support_sessions: { reason: 'seeded fixture row for tenant isolation' },
  // The close window is ordered: grace_end_at must sit strictly after end_at,
  // and the generic future-timestamp rule gives both the same instant (0322).
  inventory_month_closes: { grace_end_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString() },
  // "A report_email run must name the file it came from" (0340). Every other
  // pms_* table hangs off this one via a NOT NULL ingest_run_id, so failing to
  // seed it would empty the entire PMS half of the fixture.
  pms_ingest_runs: { source_kind: 'cua' },
  // "raw_purged_at is null exactly when storage_path is set", and the content
  // hash is CHECK-pinned to 64 hex characters (0340).
  pms_report_files: {
    raw_purged_at: null,
    storage_path: 'seed/fixture.csv',
    content_sha256: '0'.repeat(64),
  },
  // A chunk has exactly one parent, source_type must name which (0266), and
  // visible_dept is only allowed when visibility is 'dept' (0282).
  knowledge_chunks: { source_type: 'document', article_id: null, visible_dept: null },
  // A trigger checks that the row names a relation that actually exists (0343).
  pms_table_schemas: { table_name: 'pms_reservations' },
});

export type SeedResult = {
  /** `${table}:${side}` → primary-key value of the seeded row. */
  ids: Map<string, string>;
  seeded: string[];
  /** Tables no generated row could satisfy, with the database's own reason. */
  unseeded: Array<{ table: string; error: string }>;
};

// ─── CHECK-constraint mining ────────────────────────────────────────────────

/** Literal values a CHECK constraint permits for one column, if it enumerates. */
function allowedByCheck(table: TableMeta, column: string): string[] | null {
  const out: string[] = [];
  for (const def of table.checks) {
    const anyRe = new RegExp(
      `\\(?"?${column}"?\\)?(?:::[a-z ]+)?\\s*=\\s*ANY\\s*\\(+\\s*\\(?ARRAY\\[([^\\]]*)\\]`,
      'i',
    );
    const anyMatch = anyRe.exec(def);
    if (anyMatch) {
      for (const lit of anyMatch[1].matchAll(/'([^']*)'/g)) out.push(lit[1]);
      continue;
    }
    const eqRe = new RegExp(`\\(?"?${column}"?\\)?(?:::[a-z ]+)?\\s*=\\s*'([^']*)'`, 'gi');
    for (const lit of def.matchAll(eqRe)) out.push(lit[1]);
  }
  return out.length > 0 ? [...new Set(out)] : null;
}

/** Longest string a CHECK will accept for this column, if it caps length. */
function maxLength(table: TableMeta, column: string): number | null {
  for (const def of table.checks) {
    const re = new RegExp(`(?:char_length|length)\\(\\(?"?${column}"?\\)?[^)]*\\)\\s*<=?\\s*(\\d+)`, 'i');
    const m = re.exec(def);
    if (m) return Number(m[1]);
  }
  return null;
}

// ─── Value generation ───────────────────────────────────────────────────────

let uuidCounter = 0;
const uuidCache = new Map<string, string>();

const UUID_PREFIX: Record<Flavour, string> = {
  hotelA: 'aaaaaaaa',
  hotelB: 'bbbbbbbb',
  neutral: 'cccccccc',
};

function flavourUuid(flavour: Flavour, key: string): string {
  const cacheKey = `${flavour}:${key}`;
  const hit = uuidCache.get(cacheKey);
  if (hit) return hit;
  uuidCounter += 1;
  const tail = uuidCounter.toString(16).padStart(12, '0');
  const value = `${UUID_PREFIX[flavour]}-0001-4000-8000-${tail}`;
  uuidCache.set(cacheKey, value);
  return value;
}

function textFor(flavour: Flavour, table: TableMeta, column: ColumnMeta, mustDiffer: boolean): string {
  const shared = SHARED_TEXT[column.name];
  const own = flavour === 'hotelA' ? 'alpha' : flavour === 'hotelB' ? LEAK_MARKER : 'beta';
  // A column under a UNIQUE key that does NOT include property_id cannot hold
  // the same value on both sides, so the shared-lookup trick is given up there
  // — hotel B keeps the marker, the others take a distinct spelling.
  const base = mustDiffer
    ? (flavour === 'hotelB' ? LEAK_MARKER : `${shared ?? own}-${flavour === 'hotelA' ? 'a' : 'n'}`)
    : (shared ?? own);
  const cap = maxLength(table, column.name);
  return cap !== null && base.length > cap ? base.slice(0, cap) : base;
}

/**
 * Columns under a UNIQUE key that carries no `property_id`. Two hotels cannot
 * both hold the seeder's shared value there, so those columns must diverge.
 */
async function globallyUniqueColumns(pg: PGlite): Promise<Set<string>> {
  const r = await pg.query<{ table_name: string; cols: string[] }>(`
    select c.relname as table_name,
           array(
             select a.attname
             from unnest(i.indkey::int[]) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
             order by k.ord
           ) as cols
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    where i.indisunique
      and c.relnamespace = 'public'::regnamespace
      and 0 <> all (i.indkey::int[])
  `);
  const out = new Set<string>();
  for (const row of r.rows) {
    if (row.cols.length === 0 || row.cols.includes('property_id')) continue;
    for (const col of row.cols) out.add(`${row.table_name}.${col}`);
  }
  return out;
}

// ─── Seeding ────────────────────────────────────────────────────────────────

/** Order tables so a table's foreign-key targets are inserted before it. */
function orderByDependency(tables: TableMeta[], catalog: Catalog): TableMeta[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const out: TableMeta[] = [];
  const visit = (name: string) => {
    if (visited.has(name) || stack.has(name)) return;
    const table = byName.get(name);
    if (!table) return;
    stack.add(name);
    for (const fk of catalog.fks) {
      if (fk.table === name && fk.refSchema === 'public' && fk.refTable !== name) visit(fk.refTable);
    }
    stack.delete(name);
    visited.add(name);
    out.push(table);
  };
  for (const table of tables) visit(table.name);
  return out;
}

export async function seedTwoHotels(pg: PGlite, catalog: Catalog): Promise<SeedResult> {
  const ids = new Map<string, string>();
  const seeded: string[] = [];
  const unseeded: Array<{ table: string; error: string }> = [];

  // The final contract intentionally leaves accounts.property_access as a
  // nullable historical receipt.  Keep this derived fixture useful at both
  // boundaries: pre-C suites still receive the legacy seed, while final
  // suites omit the fenced column and provision the equivalent canonical
  // bridge after the catalog rows exist.
  const hasStageCStatus = Boolean((await pg.query<{ present: boolean }>(
    `select to_regclass('public.account_access_cutover_status') is not null as present`,
  )).rows[0]?.present);
  const finalAccessContract = hasStageCStatus && Boolean((await pg.query<{ present: boolean }>(`
    select exists (
      select 1
        from public.account_access_cutover_status
       where id is true
         and stage = 'C'
         and enforcement_enabled
    )
    and to_regprocedure(
      'public.staxis_set_account_authorization_scope(uuid,uuid,uuid[],bigint,text,text,text)'
    ) is not null as present
  `)).rows[0]?.present);

  const uniqueCols = await globallyUniqueColumns(pg);
  const baseTables = [...catalog.tables.values()].filter((t) => t.kind === 'r');
  const ordered = orderByDependency(baseTables, catalog);

  // `accounts.data_user_id` and `properties.owner_id` point at auth.users, which
  // no migration creates — the pglite harness stubs it. Seed one identity per
  // side first so those foreign keys resolve instead of failing every table
  // downstream of them.
  const authA = flavourUuid('hotelA', 'auth.users');
  const authB = flavourUuid('neutral', 'auth.users');
  await pg.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)
                  on conflict (id) do nothing`,
    [authA, 'alpha@example.test', authB, 'beta@example.test']);
  ids.set('auth.users:A', authA);
  ids.set('auth.users:B', authB);

  // properties — everything else foreign-keys to it.
  ids.set('properties:A', PID_A);
  ids.set('properties:B', PID_B);

  const fkKey = (fk: { refSchema: string; refTable: string }, side: Side) =>
    `${fk.refSchema === 'public' ? '' : `${fk.refSchema}.`}${fk.refTable}:${side}`;

  /**
   * What one column of a foreign key points at. Composite keys matter here:
   * the tenant-safety migrations deliberately use `(item_id, property_id)
   * REFERENCES inventory (id, property_id)` so a row cannot borrow another
   * hotel's item, and a seeder that only understood single-column keys would
   * fail to seed exactly the tables those constraints protect.
   */
  type Link = { refSchema: string; refTable: string; refColumn: string };

  function linkFor(table: string, column: string): Link | null {
    const candidates: Link[] = [];
    for (const fk of catalog.fks) {
      if (fk.table !== table) continue;
      const index = fk.columns.indexOf(column);
      if (index < 0) continue;
      candidates.push({
        refSchema: fk.refSchema,
        refTable: fk.refTable,
        refColumn: fk.refColumns[index],
      });
    }
    if (candidates.length === 0) return null;
    // Prefer the link that points at the target's primary key — that is the
    // one whose value we actually know.
    const pkLink = candidates.find((c) => {
      const target = catalog.tables.get(c.refTable);
      return target?.pk.length === 1 && target.pk[0] === c.refColumn;
    });
    return pkLink ?? candidates[0];
  }

  function valueFor(
    side: Side,
    flavour: Flavour,
    table: TableMeta,
    column: ColumnMeta,
    tier: number,
  ): unknown | undefined {
    const isPk = table.pk.length === 1 && table.pk[0] === column.name;

    if (table.name === 'properties' && column.name === 'id') return side === 'A' ? PID_A : PID_B;
    if (column.name === 'property_id') return side === 'A' ? PID_A : PID_B;
    if (column.name === 'property_access') {
      return finalAccessContract ? undefined : [side === 'A' ? PID_A : PID_B];
    }

    // Tier 2 keeps only what the database demands, tier 3 also drops anything
    // with a default. A row rejected by a CHECK on some decorative column can
    // still get in on a later tier, which is how "at least one B row exists"
    // survives constraints this generator knows nothing about.
    const optional = column.isNullable || (column.hasDefault && !isPk);
    if (tier >= 2 && column.isNullable) return undefined;
    if (tier >= 3 && optional) return undefined;

    const link = linkFor(table.name, column.name);
    if (link) {
      if (link.refColumn === 'property_id') return side === 'A' ? PID_A : PID_B;
      const target = catalog.tables.get(link.refTable);
      const pointsAtPk = link.refSchema !== 'public'
        || (target?.pk.length === 1 && target.pk[0] === link.refColumn);
      const value = pointsAtPk ? ids.get(fkKey(link, side)) : undefined;
      if (value !== undefined) return value;
      if (column.isNullable) return null;
      return undefined; // unresolvable NOT NULL FK — table cannot be seeded
    }

    if (isPk && column.udt === 'uuid') return flavourUuid(flavour, `${table.name}.pk`);

    if (column.enumLabels && column.enumLabels.length > 0) {
      return column.isArray ? [column.enumLabels[0]] : column.enumLabels[0];
    }

    const allowed = allowedByCheck(table, column.name);
    if (allowed && allowed.length > 0) {
      if (column.isArray) return [allowed[0]];
      if (column.udt === 'int2' || column.udt === 'int4' || column.udt === 'int8' || column.udt === 'numeric') {
        const n = Number(allowed[0]);
        return Number.isFinite(n) ? n : 1;
      }
      return allowed[0];
    }

    const scalar = scalarFor(side, flavour, table, column);
    return column.isArray ? [scalar] : scalar;
  }

  /** One value of the column's ELEMENT type — arrays wrap this. */
  function scalarFor(side: Side, flavour: Flavour, table: TableMeta, column: ColumnMeta): unknown {
    switch (column.udt) {
      case 'uuid': return flavourUuid(flavour, `${table.name}.${column.name}`);
      // TRUE only for the "this row counts" flags — a blanket true would set
      // is_summary / archived / is_deleted and hide every seeded row from the
      // very queries this fixture exists to exercise.
      case 'bool': return /(^|_)(is_)?(active|enabled|available|visible|published|confirmed)$/.test(column.name);
      case 'int2': case 'int4': case 'int8': return 1;
      case 'numeric': case 'float4': case 'float8': return 1;
      case 'date':
        // `month_start` columns are CHECK-pinned to the first of a month.
        return /month/.test(column.name) ? `${localToday().slice(0, 7)}-01` : localToday();
      case 'time': case 'timetz':
        return /end/.test(column.name) ? '16:00:00' : '08:00:00';
      case 'timestamp': case 'timestamptz':
        if (TOMBSTONE_RE.test(column.name) && column.isNullable) return null;
        return FUTURE_RE.test(column.name)
          ? (side === 'A' ? FUTURE_A : FUTURE_B)
          : (side === 'A' ? PAST_A : PAST_B);
      case 'json': case 'jsonb':
        return flavour === 'hotelB' ? { marker: LEAK_MARKER } : {};
      case 'interval': return '1 hour';
      // pgvector / full-text columns: no meaningful generic value, and every
      // one of them in this schema is nullable and search-only.
      case 'vector': case 'halfvec': case 'sparsevec': case 'tsvector': case 'bytea':
        return null;
      default: return textFor(flavour, table, column, uniqueCols.has(`${table.name}.${column.name}`));
    }
  }

  function buildRow(side: Side, flavour: Flavour, table: TableMeta, tier: number): Record<string, unknown> | null {
    const row: Record<string, unknown> = {};
    for (const column of table.columns) {
      if (column.isGenerated) continue;
      const value = valueFor(side, flavour, table, column, tier);
      if (value === undefined) {
        if (!column.isNullable && !column.hasDefault) return null;
        continue;
      }
      row[column.name] = value;
    }
    for (const [key, value] of Object.entries(ROW_PATCHES[table.name] ?? {})) {
      if (table.byName.has(key)) row[key] = value;
    }
    return row;
  }

  async function insert(table: TableMeta, row: Record<string, unknown>): Promise<string | null> {
    const columns = Object.keys(row);
    if (columns.length === 0) return null;
    const params = columns.map((key) => {
      const meta = table.byName.get(key)!;
      const value = row[key];
      if (value === null) return null;
      if (meta.isArray && Array.isArray(value)) {
        return `{${value.map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
      }
      if ((meta.udt === 'json' || meta.udt === 'jsonb') && typeof value === 'object') {
        return JSON.stringify(value);
      }
      return value;
    });
    const pk = table.pk.length === 1 ? table.pk[0] : null;
    const sql =
      `insert into "${table.name}" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
      `values (${columns.map((_, i) => `$${i + 1}`).join(', ')})` +
      (pk ? ` returning "${pk}"::text as pk` : '');
    const result = await pg.query<{ pk: string }>(sql, params);
    return pk ? (result.rows[0]?.pk ?? null) : null;
  }

  // A table with no hotel column still needs a second row when a HOTEL table
  // foreign-keys to it — every hotel-B conversation points at a hotel-B
  // account, and `accounts` carries no property_id. That second row is
  // 'neutral', not poisoned: reading the account catalogue is legitimate, so a
  // `cccccccc-` id keeps it out of the leak scan while still satisfying the key.
  const referencedByTenant = new Set<string>();
  for (const fk of catalog.fks) {
    if (fk.refSchema !== 'public') continue;
    if (catalog.tables.get(fk.table)?.byName.has('property_id')) referencedByTenant.add(fk.refTable);
  }

  for (const table of ordered) {
    const tenant = table.byName.has('property_id') || table.name === 'properties';
    const secondRow = tenant || referencedByTenant.has(table.name);
    let lastError = '';
    let ok = true;

    for (const side of (secondRow ? ['B', 'A'] : ['A']) as Side[]) {
      const flavour: Flavour = side === 'A' ? 'hotelA' : tenant ? 'hotelB' : 'neutral';
      let inserted = false;
      for (let tier = 1; tier <= 3 && !inserted; tier += 1) {
        const row = buildRow(side, flavour, table, tier);
        if (!row) { lastError = 'unresolvable NOT NULL foreign key'; break; }
        // Each statement is its own implicit transaction here, so a rejected
        // attempt rolls itself back and the next tier starts from a clean slate.
        try {
          const pk = await insert(table, row);
          if (pk) ids.set(`${table.name}:${side}`, pk);
          inserted = true;
        } catch (e) {
          lastError = (e instanceof Error ? e.message : String(e)).split('\n')[0];
        }
      }
      // A global table only has to seed ONE row to be useful; a hotel table
      // must have BOTH or there is no other hotel to leak.
      if (!inserted && (tenant || side === 'A')) ok = false;
    }

    if (ok) seeded.push(table.name);
    else unseeded.push({ table: table.name, error: lastError });
  }

  if (finalAccessContract) {
    const actorAccountId = 'f4260000-0000-4000-8000-000000000002';
    const actorAuthId = 'f4261000-0000-4000-8000-000000000002';
    await pg.query(
      `insert into auth.users(id, email) values ($1, 'canonical-seeder@example.test')
       on conflict (id) do nothing`,
      [actorAuthId],
    );
    await pg.query(
      `insert into public.accounts(id, username, password_hash, display_name, role, data_user_id)
       values ($1, 'canonical-seeder', 'x', 'Canonical Seeder', 'admin', $2)
       on conflict (id) do nothing`,
      [actorAccountId, actorAuthId],
    );

    const seededAccounts = await pg.query<{
      id: string;
      role: string;
      authority_version: number;
    }>(
      `select account.id, account.role, state.authority_version
         from public.accounts account
         join public.account_authorization_state state on state.account_id = account.id
        where account.id = any($1::uuid[])
        order by account.id`,
      [[ids.get('accounts:A'), ids.get('accounts:B')].filter(Boolean)],
    );
    for (const account of seededAccounts.rows) {
      const propertyId = account.id === ids.get('accounts:B') ? PID_B : PID_A;
      await pg.exec('begin; set local role service_role;');
      try {
        const result = await pg.query<{ value: { ok?: boolean; reason?: string } }>(
          `select public.staxis_set_account_authorization_scope(
             $1, $2, $3::uuid[], $4, $5, $6, $7
           ) as value`,
          [
            actorAccountId,
            account.id,
            account.role === 'admin' ? [] : [propertyId],
            account.authority_version,
            account.role,
            account.role,
            'canonical two-hotel tenant-isolation fixture authority',
          ],
        );
        const value = result.rows[0]?.value;
        if (value?.ok !== true) {
          throw new Error(`canonical seeder rejected ${account.id}: ${JSON.stringify(value)}`);
        }
        await pg.exec('commit;');
      } catch (error) {
        await pg.exec('rollback;').catch(() => undefined);
        throw error;
      }
    }
  }

  return { ids, seeded, unseeded };
}

/**
 * A fingerprint of every hotel-B row in the database. Taken before and after
 * the tool walk: an unfiltered UPDATE or DELETE inside a tool changes it, and
 * that is a cross-tenant WRITE — the failure mode a read-only leak test misses.
 */
export async function fingerprintHotelB(pg: PGlite, catalog: Catalog): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const table of catalog.tables.values()) {
    if (table.kind !== 'r' || !table.byName.has('property_id')) continue;
    try {
      const r = await pg.query<{ digest: string | null; n: number }>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest,
                count(*)::int as n
         from "${table.name}" t where t.property_id = $1`,
        [PID_B],
      );
      out.set(table.name, `${r.rows[0]?.n ?? 0}:${r.rows[0]?.digest ?? ''}`);
    } catch {
      // A table whose row type cannot be cast to text (rare) simply isn't
      // fingerprinted; it is still covered by the value-level leak scan.
    }
  }
  return out;
}
