---
name: database-changes
description: Use when adding a new Postgres table, column, or index; modifying RLS policies; or applying any Supabase migration. Trigger phrases include "new table", "add column", "schema change", "migration", "RLS policy", "alter table", or any task that touches `supabase/migrations/` or requires a DDL change.
---

# Changing the database

Covers writing a new migration, applying it to the live Supabase project, and wiring it into the app.

## File structure

- Migrations live in `supabase/migrations/NNNN_description.sql`. Numbering currently has gaps at `0024`, `0026-30` and a duplicate `0015_*`. Copy the latest number and increment.
- Domain modules in `src/lib/db/<domain>.ts` own per-table read/write/subscribe helpers.
- Row mappers in `src/lib/db-mappers.ts` translate Postgres rows ↔ domain objects.
- `src/lib/db.ts` is a re-export shim — add `export * from './db/<domain>'` for new domains.

## Adding a new table — full checklist

1. **Write the migration** in `supabase/migrations/NNNN_*.sql`:
   - Table definition with primary key, foreign keys, NOT NULL constraints.
   - **RLS policy is mandatory** — typically `owner rw` (the property owner can read/write rows where `property_id` matches their JWT claim). Skipping RLS = silent empty results for anon visitors (see CLAUDE.md "RLS bug class").
   - Indexes on any column used in WHERE clauses, especially `(property_id, ...)` composites.
   - If the table needs Realtime, add it to the publication — see `0006_enable_realtime.sql` and `0009_realtime_column_filter.sql` for the pattern.

2. **Apply the migration**:

   **Option A — Supabase SQL Editor (browser)**: paste the file contents → Run.

   **Option B — psql with the DB URL**:
   ```bash
   PGPASSWORD="<password>" psql "postgresql://postgres@db.xjoyasymmdejpmnzbjqu.supabase.co:5432/postgres" \
     -f supabase/migrations/NNNN_*.sql
   ```
   DB password lives in Recovery Codes vault.

3. **Reload PostgREST schema cache** — REQUIRED after any DDL:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```
   PostgREST caches the schema. Without this, routes will return `column "X" does not exist` even though the column is right there. Alternatively: hit `/api/admin/doctor` (with `CRON_SECRET` bearer) which forces a reload.

4. **Verify it landed**:
   ```sql
   SELECT * FROM public.applied_migrations ORDER BY version DESC LIMIT 5;
   ```

5. **Add the domain module** at `src/lib/db/<table>.ts`:
   - `subscribeToX(propertyId, callback)` using `subscribeTable` from `_common.ts` for Realtime.
   - `addX(...)`, `updateX(...)`, `deleteX(...)` functions as needed.
   - Use the **anon** Supabase client (imported via `_common.ts`) — RLS handles scoping.

6. **Add the row mapper** in `src/lib/db-mappers.ts` if there's any column-name or type translation (`fromXRow` / `toXRow`).

7. **Re-export from `src/lib/db.ts`**: `export * from './db/<table>';`.

8. **If the table is touched by public pages** (housekeeper SMS link, laundry, anything anon visitors hit): the page MUST go through `/api/...` routes using `supabaseAdmin`. See CLAUDE.md "RLS bug class" — this is the #1 most-recurring bug.

## Adding a column to an existing table

1. Migration with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`.
2. Apply + `NOTIFY pgrst, 'reload schema';`.
3. Update the row mapper in `src/lib/db-mappers.ts`.
4. Update the TypeScript type in `src/types/index.ts` if it's part of a domain object.
5. If the CUA service uses the column (rare for product tables, common for `properties` columns), update `cua-service/src/types.ts` too — it has its own type copy.

## Common gotchas

- **`accounts.password_hash` is `NOT NULL`** even though Supabase Auth is the authenticator. When inserting into `accounts`, hash with bcrypt cost 10. Dead code path-wise, real column constraint.
- **Adding a check constraint?** Existing rows must pass it before the migration applies. Either backfill first or use `NOT VALID` and validate later.
- **Adding NOT NULL to existing column?** Backfill defaults first or include `DEFAULT '...'` in the same statement.
- **`pms_type` constraint** — adding a new PMS requires updating both the check constraint AND `src/lib/pms/registry.ts`. See the `pms-abstraction` skill.

## Verification

After applying, run:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool
```

All checks should be green. If `supabase_admin_auth` or any read check fails, the schema didn't reload — re-run `NOTIFY pgrst, 'reload schema';`.
