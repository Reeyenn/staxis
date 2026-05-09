-- 0059_expenses_custom_categories.sql
-- Drop the hard-coded category whitelist on expenses so the Money tab
-- can save custom categories typed in by the user (e.g. "GitHub Pro",
-- "Postmark", "Notion"). Existing rows already pass any text check, so
-- no backfill is needed.

alter table public.expenses drop constraint if exists expenses_category_check;
