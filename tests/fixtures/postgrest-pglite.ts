/**
 * A PostgREST-shaped client that executes real SQL against PGlite.
 *
 * WHY THIS EXISTS
 * `agent-tool-tenant-isolation.test.ts` walks every registered tool with a
 * hand-written FAKE of the supabase client. The fake answers from a single
 * in-memory row shape, so it can prove that a query CARRIED a hotel filter —
 * but it cannot prove that the filter, evaluated by a real query planner
 * against the real schema, actually keeps the other hotel's rows out. A join,
 * an embedded resource, a view, an RPC body, or a column the fake happened to
 * invent all slip past it.
 *
 * This module closes that gap: it compiles the subset of the PostgREST query
 * builder that this repo actually uses into SQL, runs it on a PGlite database
 * that has the production migrations applied, and returns supabase-shaped
 * `{ data, error, count }`. Installed on the client singletons, every existing
 * handler and every shared `src/lib/**` helper runs UNMODIFIED against a real
 * two-hotel dataset.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never silently degrades. Any builder feature it cannot compile throws
 * `PostgrestShimUnsupported`, which surfaces as a named test failure instead of
 * a green run that proved nothing. That is the whole point — a test harness
 * that quietly ignores `.contains()` would report "no leak" for a query it
 * never actually evaluated.
 *
 * It also does not simulate RLS. PGlite runs as the table owner, so policies
 * are bypassed exactly the way the production service-role key bypasses them.
 * That is the correct model for this test: the AI layer's tenant boundary is
 * app code (`scopedDb`), and app code is what is under test.
 */

import type { PGlite } from '@electric-sql/pglite';

export class PostgrestShimUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgrestShimUnsupported';
  }
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export type ColumnMeta = {
  name: string;
  /** `format_type()` output — 'text', 'uuid', 'text[]', 'jsonb', … */
  dataType: string;
  /** `pg_type.typname` of the column (element type when the column is an array). */
  udt: string;
  isArray: boolean;
  isNullable: boolean;
  hasDefault: boolean;
  /** GENERATED ALWAYS (stored or identity) — never writable. */
  isGenerated: boolean;
  enumLabels: string[] | null;
};

export type TableMeta = {
  name: string;
  /** 'r' base table, 'v' view, 'm' materialized view. */
  kind: string;
  columns: ColumnMeta[];
  byName: Map<string, ColumnMeta>;
  pk: string[];
  /** `pg_get_constraintdef` text of every CHECK on the table. */
  checks: string[];
};

export type ForeignKey = {
  table: string;
  columns: string[];
  /** Schema of the referenced table — `auth` for the account→auth.users link. */
  refSchema: string;
  refTable: string;
  refColumns: string[];
};

export type Catalog = {
  tables: Map<string, TableMeta>;
  fks: ForeignKey[];
  /** Function name → returns a set (so the RPC result is an array). */
  setReturning: Map<string, boolean>;
  /**
   * Function name → the set of parameter names whose declared type is a
   * Postgres ARRAY (`uuid[]`, `text[]`, …).
   *
   * Real PostgREST reads the function signature and turns a JSON array in the
   * request body into a Postgres array for those parameters, and into a JSON
   * document for a `json`/`jsonb` parameter. Without the signature this shim
   * had to guess, and it guessed JSON for everything — so any handler calling
   * an RPC with a `uuid[]` argument failed with "malformed array literal" and
   * the route under test returned a 503 that has no production counterpart.
   */
  arrayParams: Map<string, Set<string>>;
};

type CatalogColumnRow = {
  table_name: string;
  kind: string;
  column_name: string;
  data_type: string;
  udt: string;
  is_array: boolean;
  is_nullable: boolean;
  has_default: boolean;
  is_generated: boolean;
};

export async function loadCatalog(pg: PGlite): Promise<Catalog> {
  const cols = await pg.query<CatalogColumnRow>(`
    select
      c.relname                                   as table_name,
      c.relkind::text                             as kind,
      a.attname                                   as column_name,
      format_type(a.atttypid, a.atttypmod)        as data_type,
      coalesce(el.typname, t.typname)             as udt,
      (t.typcategory = 'A')                       as is_array,
      (not a.attnotnull)                          as is_nullable,
      (a.atthasdef or a.attidentity <> '')        as has_default,
      (a.attgenerated <> '' or a.attidentity = 'a') as is_generated
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    left join pg_type el on el.oid = nullif(t.typelem, 0)
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
    order by c.relname, a.attnum
  `);

  const enums = await pg.query<{ typname: string; enumlabel: string }>(`
    select t.typname, e.enumlabel
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    order by t.typname, e.enumsortorder
  `);
  const enumLabels = new Map<string, string[]>();
  for (const row of enums.rows) {
    const list = enumLabels.get(row.typname) ?? [];
    list.push(row.enumlabel);
    enumLabels.set(row.typname, list);
  }

  const pks = await pg.query<{ relname: string; attname: string }>(`
    select c.relname, a.attname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join unnest(con.conkey) with ordinality k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    where con.contype = 'p' and c.relnamespace = 'public'::regnamespace
    order by c.relname, k.ord
  `);

  const checks = await pg.query<{ relname: string; def: string }>(`
    select c.relname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    where con.contype = 'c' and c.relnamespace = 'public'::regnamespace
  `);

  const fkRows = await pg.query<{
    src_table: string; tgt_schema: string; tgt_table: string; src_cols: string[]; tgt_cols: string[];
  }>(`
    select
      src.relname as src_table,
      tgtns.nspname as tgt_schema,
      tgt.relname as tgt_table,
      (select array_agg(a.attname order by k.ord)
         from unnest(con.conkey) with ordinality k(attnum, ord)
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as src_cols,
      (select array_agg(a.attname order by k.ord)
         from unnest(con.confkey) with ordinality k(attnum, ord)
         join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as tgt_cols
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace tgtns on tgtns.oid = tgt.relnamespace
    where con.contype = 'f'
      and src.relnamespace = 'public'::regnamespace
  `);

  // `proargtypes` covers IN parameters; `proallargtypes` is only populated when
  // the function has OUT/INOUT/TABLE parameters, and then it covers ALL of them
  // in declaration order — so the IN args are still its leading entries, which
  // is what lines up with `proargnames`.
  const fns = await pg.query<{
    proname: string; proretset: boolean; argnames: string[] | null; argisarray: boolean[] | null;
  }>(`
    select
      p.proname,
      p.proretset,
      p.proargnames as argnames,
      (
        select array_agg(t.typcategory = 'A' order by ordinality)
        from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as a(oid, ordinality)
        join pg_type t on t.oid = a.oid
      ) as argisarray
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  `);

  const tables = new Map<string, TableMeta>();
  for (const row of cols.rows) {
    let meta = tables.get(row.table_name);
    if (!meta) {
      meta = {
        name: row.table_name,
        kind: row.kind,
        columns: [],
        byName: new Map(),
        pk: [],
        checks: [],
      };
      tables.set(row.table_name, meta);
    }
    const column: ColumnMeta = {
      name: row.column_name,
      dataType: row.data_type,
      udt: row.udt,
      isArray: row.is_array,
      isNullable: row.is_nullable,
      hasDefault: row.has_default,
      isGenerated: row.is_generated,
      enumLabels: enumLabels.get(row.udt) ?? null,
    };
    meta.columns.push(column);
    meta.byName.set(column.name, column);
  }
  for (const row of pks.rows) tables.get(row.relname)?.pk.push(row.attname);
  for (const row of checks.rows) tables.get(row.relname)?.checks.push(row.def);

  return {
    tables,
    fks: fkRows.rows.map((r) => ({
      table: r.src_table,
      columns: r.src_cols,
      refSchema: r.tgt_schema,
      refTable: r.tgt_table,
      refColumns: r.tgt_cols,
    })),
    setReturning: new Map(fns.rows.map((r) => [r.proname, r.proretset])),
    arrayParams: new Map(fns.rows.map((r) => {
      const names = r.argnames ?? [];
      const flags = r.argisarray ?? [];
      const arrays = new Set<string>();
      for (let i = 0; i < names.length; i += 1) {
        if (flags[i] === true && names[i]) arrays.add(names[i]);
      }
      return [r.proname, arrays] as const;
    })),
  };
}

// ─── Recording ──────────────────────────────────────────────────────────────

export type RecordedFilter = { op: string; column: string; value: unknown };

export type RecordedStatement = {
  kind: 'table' | 'rpc';
  /** Table name, or function name for an RPC. */
  target: string;
  verb: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'rpc';
  /** Structured filters as the caller applied them (before compilation). */
  filters: RecordedFilter[];
  /** Payload of a write, or the argument object of an RPC. */
  payload?: unknown;
  sql: string;
  params: unknown[];
  /** Row count actually returned by the database. */
  rowCount: number;
  /** The rows the database actually handed back (capped, for leak auditing). */
  rows: unknown[];
  /** Populated when the statement failed. */
  error?: string;
};

// ─── Filter tree ────────────────────────────────────────────────────────────

type FilterNode =
  | { kind: 'cmp'; column: string; op: string; value: unknown }
  | { kind: 'or'; parts: FilterNode[] }
  | { kind: 'not'; inner: FilterNode };

// ─── SELECT list ────────────────────────────────────────────────────────────

type SelectItem =
  | { kind: 'star' }
  | { kind: 'column'; column: string; alias: string }
  | { kind: 'embed'; table: string; alias: string; inner: boolean; items: SelectItem[] };

/** Split on commas that are not inside parentheses. */
function splitTopLevel(input: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '' || out.length === 0) out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

// `[\s\S]` rather than the `s` flag — the repo targets an older ES lib.
const EMBED_RE = /^(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_]\w*)(!inner|!left)?\s*\(([\s\S]*)\)$/;
const COLUMN_RE = /^(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_]\w*)$/;

function parseSelect(columns: string): SelectItem[] {
  return splitTopLevel(columns).map((token) => {
    if (token === '*') return { kind: 'star' } as const;
    const embed = EMBED_RE.exec(token);
    if (embed) {
      return {
        kind: 'embed' as const,
        table: embed[2],
        alias: embed[1] ?? embed[2],
        inner: embed[3] === '!inner',
        items: parseSelect(embed[4]),
      };
    }
    const column = COLUMN_RE.exec(token);
    if (column) {
      return { kind: 'column' as const, column: column[2], alias: column[1] ?? column[2] };
    }
    throw new PostgrestShimUnsupported(
      `select fragment "${token}" is not something this shim compiles. ` +
      'Teach postgrest-pglite.ts the syntax rather than weakening the test.',
    );
  });
}

// ─── SQL helpers ────────────────────────────────────────────────────────────

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new PostgrestShimUnsupported(`identifier "${name}" is not a plain column name`);
  }
  return `"${name}"`;
}

function strLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Postgres array literal — used for `contains` on a `text[]` column. */
function arrayLiteral(values: unknown[]): string {
  return `{${values.map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
}

type Compiler = { params: unknown[] };

function bind(compiler: Compiler, value: unknown): string {
  compiler.params.push(value);
  return `$${compiler.params.length}`;
}

// ─── The client ─────────────────────────────────────────────────────────────

export type PglitePostgrest = {
  from: (table: string) => Record<string, unknown>;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  /** Every statement executed since the last `reset()`. */
  statements: RecordedStatement[];
  /**
   * Builder features this shim could not compile. A handler's own try/catch
   * would otherwise swallow the throw and the run would look clean, so every
   * one is recorded here and the test asserts the list is empty.
   */
  unsupported: string[];
  reset: () => void;
  catalog: Catalog;
};

export function createPglitePostgrest(pg: PGlite, catalog: Catalog): PglitePostgrest {
  const statements: RecordedStatement[] = [];
  const unsupported: string[] = [];

  // ── filter compilation ──────────────────────────────────────────────────

  function columnRef(alias: string, table: string, column: string): string {
    void table;
    return `${alias}.${ident(column)}`;
  }

  function compileCmp(
    node: Extract<FilterNode, { kind: 'cmp' }>,
    table: string,
    alias: string,
    c: Compiler,
  ): string {
    const ref = columnRef(alias, table, node.column);
    const meta = catalog.tables.get(table)?.byName.get(node.column);
    switch (node.op) {
      case 'eq': return `${ref} = ${bind(c, node.value)}`;
      case 'neq': return `${ref} <> ${bind(c, node.value)}`;
      case 'gt': return `${ref} > ${bind(c, node.value)}`;
      case 'gte': return `${ref} >= ${bind(c, node.value)}`;
      case 'lt': return `${ref} < ${bind(c, node.value)}`;
      case 'lte': return `${ref} <= ${bind(c, node.value)}`;
      case 'like': return `${ref} like ${bind(c, node.value)}`;
      case 'ilike': return `${ref} ilike ${bind(c, node.value)}`;
      case 'is':
        if (node.value === null) return `${ref} is null`;
        if (typeof node.value === 'boolean') return `${ref} is ${node.value ? 'true' : 'false'}`;
        throw new PostgrestShimUnsupported(`is.${String(node.value)}`);
      case 'in': {
        const list = node.value as unknown[];
        if (!Array.isArray(list)) throw new PostgrestShimUnsupported('in() needs an array');
        if (list.length === 0) return 'false';
        return `${ref} in (${list.map((v) => bind(c, v)).join(', ')})`;
      }
      case 'contains': {
        if (Array.isArray(node.value)) {
          const cast = meta?.dataType ?? 'text[]';
          return `${ref} @> ${bind(c, arrayLiteral(node.value))}::${cast}`;
        }
        return `${ref} @> ${bind(c, JSON.stringify(node.value))}::jsonb`;
      }
      case 'overlaps': {
        const cast = meta?.dataType ?? 'text[]';
        return `${ref} && ${bind(c, arrayLiteral(node.value as unknown[]))}::${cast}`;
      }
      default:
        throw new PostgrestShimUnsupported(
          `filter operator "${node.op}" is not compiled by postgrest-pglite.ts`,
        );
    }
  }

  function compileFilter(node: FilterNode, table: string, alias: string, c: Compiler): string {
    if (node.kind === 'or') {
      return `(${node.parts.map((p) => compileFilter(p, table, alias, c)).join(' or ')})`;
    }
    if (node.kind === 'not') {
      return `(not (${compileFilter(node.inner, table, alias, c)}))`;
    }
    return compileCmp(node, table, alias, c);
  }

  /** PostgREST `.or('a.is.null,b.eq.x')` → an OR node. */
  function parseOr(expression: string): FilterNode {
    const parts = splitTopLevel(expression).map<FilterNode>((clause) => {
      if (/^(and|or|not)\s*\(/i.test(clause)) {
        throw new PostgrestShimUnsupported(`nested "${clause}" inside .or() is not compiled`);
      }
      const first = clause.indexOf('.');
      const second = clause.indexOf('.', first + 1);
      if (first < 0 || second < 0) throw new PostgrestShimUnsupported(`or() clause "${clause}"`);
      const column = clause.slice(0, first);
      const op = clause.slice(first + 1, second);
      const raw = clause.slice(second + 1);
      const value = raw === 'null' ? null : raw;
      return { kind: 'cmp', column, op, value };
    });
    return { kind: 'or', parts };
  }

  // ── embedded resources ──────────────────────────────────────────────────

  type Embed = { join: string; alias: string; item: Extract<SelectItem, { kind: 'embed' }> };

  /**
   * PostgREST lets a filter name an EMBEDDED resource's column —
   * `.eq('organization_memberships.account_id', id)` beside
   * `.select('id, organization_memberships!inner(...)')`. The condition belongs
   * to the join, not to the outer row: paired with `!inner` it is what turns the
   * embed into a restriction on the parent.
   *
   * These are compiled INTO the lateral subquery so the semantics match — the
   * embedded json is null when nothing matched, and the `!inner` rule already
   * in `compileSelect` (`emb0.j is not null`) then drops the parent row. Doing
   * it in the outer WHERE instead would reference a column that is not in
   * scope, which is the shape the old `ident()` guard was catching.
   */
  function embedFilterPrefix(node: FilterNode): string | null {
    if (node.kind === 'cmp') {
      const dot = node.column.indexOf('.');
      return dot > 0 ? node.column.slice(0, dot) : null;
    }
    if (node.kind === 'not') return embedFilterPrefix(node.inner);
    return null;
  }

  function stripEmbedPrefix(node: FilterNode): FilterNode {
    if (node.kind === 'cmp') {
      return { ...node, column: node.column.slice(node.column.indexOf('.') + 1) };
    }
    if (node.kind === 'not') return { kind: 'not', inner: stripEmbedPrefix(node.inner) };
    return node;
  }

  function buildEmbed(
    parent: string,
    item: Extract<SelectItem, { kind: 'embed' }>,
    index: number,
    parentAlias: string,
    conditions: (childAlias: string) => string[] = () => [],
  ): Embed {
    const alias = `emb${index}`;
    const child = `${alias}_t`;
    const forward = catalog.fks.find(
      (f) => f.table === parent && f.refTable === item.table && f.refSchema === 'public',
    );
    const reverse = catalog.fks.find(
      (f) => f.table === item.table && f.refTable === parent && f.refSchema === 'public',
    );
    if (!forward && !reverse) {
      throw new PostgrestShimUnsupported(
        `no foreign key relates "${parent}" to embedded "${item.table}"`,
      );
    }
    const rowJson = jsonForItems(item.items, item.table, child, []);
    const extra = conditions(child);
    const andExtra = extra.length > 0 ? ` and ${extra.join(' and ')}` : '';
    if (forward) {
      const on = forward.columns
        .map((col, i) => `${child}.${ident(forward.refColumns[i])} = ${parentAlias}.${ident(col)}`)
        .join(' and ');
      return {
        alias,
        item,
        join:
          `left join lateral (select ${rowJson} as j from ${ident(item.table)} ${child} ` +
          `where ${on}${andExtra} limit 1) ${alias} on true`,
      };
    }
    const rev = reverse!;
    const on = rev.columns
      .map((col, i) => `${child}.${ident(col)} = ${parentAlias}.${ident(rev.refColumns[i])}`)
      .join(' and ');
    return {
      alias,
      item,
      join:
        `left join lateral (select coalesce(jsonb_agg(${rowJson}), '[]'::jsonb) as j ` +
        `from ${ident(item.table)} ${child} where ${on}${andExtra}) ${alias} on true`,
    };
  }

  /** The jsonb expression that becomes one result row. */
  function jsonForItems(
    items: SelectItem[],
    table: string,
    alias: string,
    embeds: Embed[],
  ): string {
    const hasStar = items.some((i) => i.kind === 'star');
    const plain = items.filter((i): i is Extract<SelectItem, { kind: 'column' }> => i.kind === 'column');
    const pieces: string[] = [];
    if (hasStar) {
      pieces.push(`to_jsonb(${alias})`);
    }
    const pairs: string[] = [];
    for (const column of plain) {
      const meta = catalog.tables.get(table)?.byName.get(column.column);
      if (!meta) {
        throw new PostgrestShimUnsupported(
          `column "${table}.${column.column}" does not exist in the migrated schema`,
        );
      }
      pairs.push(`${strLiteral(column.alias)}, ${alias}.${ident(column.column)}`);
    }
    for (const embed of embeds) {
      pairs.push(`${strLiteral(embed.item.alias)}, ${embed.alias}.j`);
    }
    if (pairs.length > 0) pieces.push(`jsonb_build_object(${pairs.join(', ')})`);
    if (pieces.length === 0) return `'{}'::jsonb`;
    return pieces.join(' || ');
  }

  // ── builder ─────────────────────────────────────────────────────────────

  type BuilderState = {
    table: string;
    verb: RecordedStatement['verb'];
    columns: string;
    selected: boolean;
    count: string | null;
    head: boolean;
    filters: FilterNode[];
    recorded: RecordedFilter[];
    orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean | null }>;
    limit: number | null;
    offset: number | null;
    payload?: unknown;
    onConflict?: string;
    ignoreDuplicates?: boolean;
    shape: 'many' | 'single' | 'maybeSingle' | 'csv';
    throwOnError: boolean;
  };

  function compileSelect(state: BuilderState): { sql: string; countSql: string | null; params: unknown[] } {
    const alias = 't0';
    const items = parseSelect(state.columns);
    const c: Compiler = { params: [] };
    const embedItems = items
      .filter((i): i is Extract<SelectItem, { kind: 'embed' }> => i.kind === 'embed');
    // A dotted filter column belongs to the embed it names; everything else is
    // an ordinary condition on the outer row. An unknown prefix is left in the
    // outer list on purpose so `ident()` still refuses it loudly.
    const embedNames = new Set(embedItems.flatMap((item) => [item.alias, item.table]));
    const scopedFilters = new Map<string, FilterNode[]>();
    const outerFilters: FilterNode[] = [];
    for (const filter of state.filters) {
      const prefix = embedFilterPrefix(filter);
      if (prefix !== null && embedNames.has(prefix)) {
        const bucket = scopedFilters.get(prefix) ?? [];
        bucket.push(stripEmbedPrefix(filter));
        scopedFilters.set(prefix, bucket);
      } else {
        outerFilters.push(filter);
      }
    }
    // Bound BEFORE the outer WHERE because the joins are emitted first and the
    // shim binds positionally.
    const embeds = embedItems
      .map((item, index) => buildEmbed(state.table, item, index, alias, (child) => (
        [...(scopedFilters.get(item.alias) ?? []), ...(item.alias === item.table
          ? []
          : scopedFilters.get(item.table) ?? [])]
          .map((f) => compileFilter(f, item.table, child, c))
      )));

    const rowJson = jsonForItems(items, state.table, alias, embeds);
    const where: string[] = outerFilters.map((f) => compileFilter(f, state.table, alias, c));
    for (const embed of embeds) if (embed.item.inner) where.push(`${embed.alias}.j is not null`);

    const from = `from ${ident(state.table)} ${alias} ${embeds.map((e) => e.join).join(' ')}`;
    const whereSql = where.length > 0 ? ` where ${where.join(' and ')}` : '';
    const orderSql = state.orders.length > 0
      ? ` order by ${state.orders.map((o) => {
          const nulls = o.nullsFirst === null ? '' : o.nullsFirst ? ' nulls first' : ' nulls last';
          return `${alias}.${ident(o.column)} ${o.ascending ? 'asc' : 'desc'}${nulls}`;
        }).join(', ')}`
      : '';
    const limitSql = state.limit !== null ? ` limit ${state.limit}` : '';
    const offsetSql = state.offset !== null ? ` offset ${state.offset}` : '';

    const sql = `select ${rowJson} as __row ${from}${whereSql}${orderSql}${limitSql}${offsetSql}`;
    const countSql = state.count ? `select count(*)::int as n ${from}${whereSql}` : null;
    return { sql, countSql, params: c.params };
  }

  function writableColumns(table: string, row: Record<string, unknown>): string[] {
    const meta = catalog.tables.get(table);
    return Object.keys(row).filter((key) => {
      const column = meta?.byName.get(key);
      if (!column) {
        throw new PostgrestShimUnsupported(
          `column "${table}.${key}" does not exist in the migrated schema`,
        );
      }
      return !column.isGenerated;
    });
  }

  function returningClause(state: BuilderState, alias: string): string {
    if (!state.selected) return '';
    const items = parseSelect(state.columns);
    return ` returning ${jsonForItems(items, state.table, alias, [])} as __row`;
  }

  function compileWrite(state: BuilderState): { sql: string; params: unknown[] } {
    const alias = 't0';
    const c: Compiler = { params: [] };

    if (state.verb === 'insert' || state.verb === 'upsert') {
      const rows = (Array.isArray(state.payload) ? state.payload : [state.payload]) as Array<Record<string, unknown>>;
      if (rows.length === 0) return { sql: 'select 1 where false', params: [] };
      const columns = [...new Set(rows.flatMap((r) => writableColumns(state.table, r)))];
      if (columns.length === 0) {
        throw new PostgrestShimUnsupported(`insert into ${state.table} with no writable columns`);
      }
      const values = rows
        .map((row) => `(${columns.map((col) => (col in row ? bind(c, normalize(state.table, col, row[col])) : 'default')).join(', ')})`)
        .join(', ');
      let conflict = '';
      if (state.verb === 'upsert') {
        const keys = state.onConflict
          ? state.onConflict.split(',').map((s) => s.trim())
          : (catalog.tables.get(state.table)?.pk ?? []);
        if (keys.length === 0) {
          throw new PostgrestShimUnsupported(`upsert on "${state.table}" which has no primary key`);
        }
        conflict = state.ignoreDuplicates
          ? ` on conflict (${keys.map(ident).join(', ')}) do nothing`
          : ` on conflict (${keys.map(ident).join(', ')}) do update set ${columns
              .filter((col) => !keys.includes(col))
              .map((col) => `${ident(col)} = excluded.${ident(col)}`)
              .join(', ') || `${ident(keys[0])} = excluded.${ident(keys[0])}`}`;
      }
      const sql =
        `insert into ${ident(state.table)} as ${alias} (${columns.map(ident).join(', ')}) ` +
        `values ${values}${conflict}${returningClause(state, alias)}`;
      return { sql, params: c.params };
    }

    if (state.verb === 'update') {
      const row = state.payload as Record<string, unknown>;
      const columns = writableColumns(state.table, row);
      const sets = columns
        .map((col) => `${ident(col)} = ${bind(c, normalize(state.table, col, row[col]))}`)
        .join(', ');
      const where = state.filters.map((f) => compileFilter(f, state.table, alias, c));
      const whereSql = where.length > 0 ? ` where ${where.join(' and ')}` : '';
      return {
        sql: `update ${ident(state.table)} as ${alias} set ${sets}${whereSql}${returningClause(state, alias)}`,
        params: c.params,
      };
    }

    const where = state.filters.map((f) => compileFilter(f, state.table, alias, c));
    const whereSql = where.length > 0 ? ` where ${where.join(' and ')}` : '';
    return {
      sql: `delete from ${ident(state.table)} as ${alias}${whereSql}${returningClause(state, alias)}`,
      params: c.params,
    };
  }

  /** JS value → something the pg wire protocol accepts for this column. */
  function normalize(table: string, column: string, value: unknown): unknown {
    if (value === null || value === undefined) return null;
    const meta = catalog.tables.get(table)?.byName.get(column);
    if (meta?.isArray) {
      return Array.isArray(value) ? arrayLiteral(value) : value;
    }
    // A json/jsonb column takes a JSON DOCUMENT, and a bare string, number or
    // boolean is one. supabase-js serialises the whole request body, so
    // PostgREST receives `"some text"` — a valid json scalar — and stores it.
    // Binding the raw JS string here instead produced `invalid input syntax for
    // type json` for exactly the rows that carry a scalar: a tool_result that is
    // an error message, a setting stored as a bare value. That is a fixture
    // failure masquerading as a product one.
    if (meta && (meta.udt === 'json' || meta.udt === 'jsonb')) {
      return JSON.stringify(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  async function run(state: BuilderState): Promise<{ data: unknown; error: unknown; count: number | null; status: number }> {
    const record: RecordedStatement = {
      kind: 'table',
      target: state.table,
      verb: state.verb,
      filters: state.recorded,
      payload: state.payload,
      sql: '',
      params: [],
      rowCount: 0,
      rows: [],
    };
    statements.push(record);

    try {
      let rows: unknown[] = [];
      let count: number | null = null;

      if (state.verb === 'select') {
        const compiled = compileSelect(state);
        record.sql = compiled.sql;
        record.params = compiled.params;
        if (compiled.countSql) {
          const r = await pg.query<{ n: number }>(compiled.countSql, compiled.params);
          count = r.rows[0]?.n ?? 0;
        }
        if (!state.head) {
          const r = await pg.query<{ __row: unknown }>(compiled.sql, compiled.params);
          rows = r.rows.map((x) => x.__row);
        }
      } else {
        const compiled = compileWrite(state);
        record.sql = compiled.sql;
        record.params = compiled.params;
        const r = await pg.query<{ __row: unknown }>(compiled.sql, compiled.params);
        rows = state.selected ? r.rows.map((x) => x.__row) : [];
      }

      record.rowCount = rows.length;
      record.rows = rows.slice(0, 50);

      if (state.shape === 'single' || state.shape === 'maybeSingle') {
        if (rows.length > 1) {
          const error = {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
            details: `Results contain ${rows.length} rows`,
            hint: null,
          };
          if (state.throwOnError) throw Object.assign(new Error(error.message), error);
          return { data: null, error, count, status: 406 };
        }
        if (rows.length === 0) {
          if (state.shape === 'maybeSingle') return { data: null, error: null, count, status: 200 };
          const error = {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
            details: 'Results contain 0 rows',
            hint: null,
          };
          if (state.throwOnError) throw Object.assign(new Error(error.message), error);
          return { data: null, error, count, status: 406 };
        }
        return { data: rows[0], error: null, count, status: 200 };
      }

      if (state.shape === 'csv') {
        return { data: toCsv(rows as Array<Record<string, unknown>>), error: null, count, status: 200 };
      }

      if (state.head) return { data: null, error: null, count, status: 200 };
      if (!state.selected && state.verb !== 'select') return { data: null, error: null, count, status: 204 };
      return { data: rows, error: null, count, status: 200 };
    } catch (e) {
      if (e instanceof PostgrestShimUnsupported) {
        unsupported.push(`${state.verb} ${state.table}: ${e.message}`);
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      record.error = message;
      const error = {
        code: (e as { code?: string }).code ?? 'PGRST000',
        message,
        details: null,
        hint: null,
      };
      if (state.throwOnError) throw e;
      return { data: null, error, count: null, status: 400 };
    }
  }

  function toCsv(rows: Array<Record<string, unknown>>): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
  }

  function makeBuilder(state: BuilderState): Record<string, unknown> {
    const cmp = (op: string) => (column: string, value: unknown) => {
      state.filters.push({ kind: 'cmp', column, op, value });
      state.recorded.push({ op, column, value });
      return api;
    };

    const api: Record<string, unknown> = {
      eq: cmp('eq'),
      neq: cmp('neq'),
      gt: cmp('gt'),
      gte: cmp('gte'),
      lt: cmp('lt'),
      lte: cmp('lte'),
      like: cmp('like'),
      ilike: cmp('ilike'),
      is: cmp('is'),
      in: cmp('in'),
      contains: cmp('contains'),
      containedBy: cmp('containedBy'),
      overlaps: cmp('overlaps'),
      filter: (column: string, op: string, value: unknown) => {
        state.filters.push({ kind: 'cmp', column, op, value });
        state.recorded.push({ op, column, value });
        return api;
      },
      not: (column: string, op: string, value: unknown) => {
        state.filters.push({ kind: 'not', inner: { kind: 'cmp', column, op, value } });
        state.recorded.push({ op: `not.${op}`, column, value });
        return api;
      },
      or: (expression: string) => {
        const node = parseOr(expression);
        state.filters.push(node);
        state.recorded.push({ op: 'or', column: '*', value: expression });
        return api;
      },
      match: (query: Record<string, unknown>) => {
        for (const [column, value] of Object.entries(query)) {
          state.filters.push({ kind: 'cmp', column, op: 'eq', value });
          state.recorded.push({ op: 'eq', column, value });
        }
        return api;
      },
      textSearch: () => {
        throw new PostgrestShimUnsupported('.textSearch() is not compiled by postgrest-pglite.ts');
      },
      order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string }) => {
        if (options?.referencedTable || options?.foreignTable) {
          throw new PostgrestShimUnsupported('.order() on a referenced table is not compiled');
        }
        state.orders.push({
          column,
          ascending: options?.ascending !== false,
          nullsFirst: options?.nullsFirst ?? null,
        });
        return api;
      },
      limit: (n: number) => { state.limit = n; return api; },
      range: (from: number, to: number) => { state.offset = from; state.limit = to - from + 1; return api; },
      abortSignal: () => api,
      returns: () => api,
      overrideTypes: () => api,
      throwOnError: () => { state.throwOnError = true; return api; },
      select: (columns?: string, options?: { count?: string; head?: boolean }) => {
        state.columns = columns ?? '*';
        state.selected = true;
        if (options?.count) state.count = options.count;
        if (options?.head) state.head = true;
        return api;
      },
      single: async () => { state.shape = 'single'; return run(state); },
      maybeSingle: async () => { state.shape = 'maybeSingle'; return run(state); },
      csv: async () => { state.shape = 'csv'; return run(state); },
      then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        run(state).then(onFulfilled, onRejected),
    };
    return api;
  }

  function newState(table: string, verb: RecordedStatement['verb']): BuilderState {
    return {
      table,
      verb,
      columns: '*',
      selected: verb === 'select',
      count: null,
      head: false,
      filters: [],
      recorded: [],
      orders: [],
      limit: null,
      offset: null,
      shape: 'many',
      throwOnError: false,
    };
  }

  function from(table: string): Record<string, unknown> {
    return {
      select: (columns?: string, options?: { count?: string; head?: boolean }) => {
        const state = newState(table, 'select');
        state.columns = columns ?? '*';
        if (options?.count) state.count = options.count;
        if (options?.head) state.head = true;
        return makeBuilder(state);
      },
      insert: (payload: unknown) => {
        const state = newState(table, 'insert');
        state.selected = false;
        state.payload = payload;
        return makeBuilder(state);
      },
      upsert: (payload: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        const state = newState(table, 'upsert');
        state.selected = false;
        state.payload = payload;
        state.onConflict = options?.onConflict;
        state.ignoreDuplicates = options?.ignoreDuplicates;
        return makeBuilder(state);
      },
      update: (payload: unknown) => {
        const state = newState(table, 'update');
        state.selected = false;
        state.payload = payload;
        return makeBuilder(state);
      },
      delete: () => {
        const state = newState(table, 'delete');
        state.selected = false;
        return makeBuilder(state);
      },
    };
  }

  async function rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
    const record: RecordedStatement = {
      kind: 'rpc',
      target: fn,
      verb: 'rpc',
      filters: [],
      payload: args,
      sql: '',
      params: [],
      rowCount: 0,
      rows: [],
    };
    statements.push(record);
    const c: Compiler = { params: [] };
    // Encode each argument the way PostgREST would, from the function's own
    // signature: a JS array bound for an ARRAY parameter becomes a Postgres
    // array literal, anything else object-shaped becomes JSON (which is what a
    // json/jsonb parameter wants). Guessing JSON for arrays is what made a
    // `uuid[]` argument fail with "malformed array literal".
    const arrayArgs = catalog.arrayParams.get(fn) ?? new Set<string>();
    const named = Object.entries(args ?? {})
      .map(([key, value]) => {
        let bound: string;
        if (Array.isArray(value) && arrayArgs.has(key)) {
          bound = bind(c, arrayLiteral(value));
        } else if (typeof value === 'object' && value !== null) {
          bound = bind(c, JSON.stringify(value));
        } else {
          bound = bind(c, value);
        }
        return `${ident(key)} => ${bound}`;
      })
      .join(', ');
    const sql = `select to_jsonb(x) as __row from ${ident(fn)}(${named}) x`;
    record.sql = sql;
    record.params = c.params;
    try {
      const r = await pg.query<{ __row: unknown }>(sql, c.params);
      record.rowCount = r.rows.length;
      const rows = r.rows.map((x) => x.__row);
      record.rows = rows.slice(0, 50);
      if (catalog.setReturning.get(fn)) return { data: rows, error: null };
      return { data: rows.length > 0 ? rows[0] : null, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record.error = message;
      return { data: null, error: { code: (e as { code?: string }).code ?? 'PGRST000', message, details: null, hint: null } };
    }
  }

  return {
    from,
    rpc,
    statements,
    unsupported,
    reset: () => { statements.length = 0; },
    catalog,
  };
}
