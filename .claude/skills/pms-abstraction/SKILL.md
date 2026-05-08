---
name: pms-abstraction
description: Use when adding support for a new PMS, modifying recipe steps, working on the multi-PMS onboarding pipeline, or debugging the CUA service's mapping or extraction logic. Trigger phrases include "add new PMS", "RecipeStep", "pms_recipes", "onboarding_jobs", "recipe-runner", "PMS mapping", "Choice Advantage", "OPERA", "RoomKey", or any task that touches `src/lib/pms/` or `cua-service/src/`.
---

# PMS abstraction (multi-PMS pipeline)

How Staxis onboards an arbitrary hotel PMS without writing custom scrapers per system.

## The architecture

- **`src/lib/pms/`** — shared TypeScript types, the recipe schema, the PMS registry. Imported by both the Next.js app and the CUA worker.
- **`cua-service/`** (Fly.io worker) — polls `onboarding_jobs` rows. For an unmapped PMS, runs Claude vision to learn login + room/staff page locations (~$1-3, ~20-30 vision calls). For a known PMS, runs the saved recipe with cheap Playwright (no Claude calls).
- **`pms_recipes`** (DB table, migration `0031`) — stores the learned recipe per PMS family. One mapping per PMS; every subsequent hotel reuses it.
- **`onboarding_jobs`** (DB table, migration `0031`) — queue of (property_id, pms_type, credentials) rows the worker picks up.
- **`scraper/`** (Railway worker, legacy) — still owns Choice Advantage. **Don't fold it into the new abstraction unless explicitly asked** — it's working code, leave it alone.

## Adding a new PMS

1. Add the PMS type to `src/lib/pms/registry.ts`:
   ```typescript
   export const PMS_TYPES = ['choice_advantage', 'opera', 'roomkey', '<new>'] as const;
   ```

2. Add a check constraint update in a new migration (`supabase/migrations/000N_*.sql`):
   ```sql
   alter table pms_recipes drop constraint pms_recipes_pms_type_check;
   alter table pms_recipes add constraint pms_recipes_pms_type_check
     check (pms_type in ('choice_advantage', 'opera', 'roomkey', '<new>'));
   -- Same for onboarding_jobs.pms_type if it has its own constraint.
   ```
   See the `database-changes` skill for the apply + `NOTIFY pgrst` dance.

3. **Don't fork the recipe runner.** The CUA service already handles "I've never seen this PMS before" via its mapper — Claude vision walks the login form and main pages, generates a recipe, saves it to `pms_recipes`. The new PMS will just work the first time a hotel signs up with it. The mapping run is the cost (one-time per PMS family, $1-3).

4. Test by queuing a real onboarding job:
   ```sql
   insert into onboarding_jobs (property_id, pms_type, credentials, status)
   values ('<test-property-uuid>', '<new>', '{"username":"...","password":"..."}', 'queued');
   ```
   Watch `flyctl logs --app staxis-cua` for `"msg":"job claimed"` followed by mapping progress.

## Adding a new recipe step type

Recipe steps describe how to scrape a page (click this, wait for that, extract this table). New step kinds need to be added in **three places** or they silently no-op:

1. **`src/lib/pms/recipe.ts`** — add the new `RecipeStep` variant to the discriminated union and update the schema.
2. **`cua-service/src/types.ts`** — mirror the type. The CUA service has its OWN copy of PMS types, intentionally, so it can deploy independently from the web app.
3. **`cua-service/src/recipe-runner.ts`** — add the case handler. Without this, the runner gets the new step kind and falls through the switch with no match.

**If you skip step 2 or 3, the new step type compiles fine but does nothing at runtime.** No error, no warning. The mapper will still generate recipes that include the new step (since it sees the type in the schema), but the runner will silently skip them. This is the most common mistake here.

## Debugging recipe drift

If a PMS changes its UI and the saved recipe stops working:

```sql
-- See current recipe for the PMS
select pms_type, recipe, updated_at from pms_recipes where pms_type = 'choice_advantage';

-- Force re-mapping by deleting the recipe (next onboarding job will re-map)
delete from pms_recipes where pms_type = 'choice_advantage';
```

The next queued job will trigger a fresh mapping run. Costs $1-3 again but updates the recipe for everyone using that PMS.

## File map

| File | Purpose |
|---|---|
| `src/lib/pms/registry.ts` | Allowed PMS types, display names |
| `src/lib/pms/recipe.ts` | RecipeStep discriminated union, recipe schema |
| `src/app/api/pms/*` | API routes for the GM-facing PMS settings page |
| `src/app/settings/pms/page.tsx` | UI where GM enters their PMS credentials |
| `cua-service/src/job-runner.ts` | Polls `onboarding_jobs`, claims atomically, dispatches |
| `cua-service/src/mapper.ts` | Claude vision mapping path (new PMS) |
| `cua-service/src/recipe-runner.ts` | Playwright extraction path (known PMS) |
| `cua-service/src/types.ts` | Mirrored PMS types — keep in sync with `src/lib/pms/` |

## See also

- `deploying-cua` skill — for deploying CUA service code changes
- `database-changes` skill — for migration mechanics
