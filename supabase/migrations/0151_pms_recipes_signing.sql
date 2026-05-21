-- Migration 0151: pms_recipes HMAC signature columns
--
-- Closes Plan v2 F-AI-2 ("pms_recipes rows are unsigned AND credential
-- placeholders resolve on any selector"). The recipe runner today loads
-- and executes any row passing shape validation; a tampered row that
-- stays on the PMS domain (so safeGoto doesn't catch it) can lift the
-- PMS password via a same-origin share/email form. This is Chain A from
-- the audit.
--
-- Fix: every recipe row carries an HMAC-SHA256 signature over its
-- canonical JSON. The CUA service signs at write time with a key from
-- env (`RECIPE_SIGNING_KEY`); recipe-runner verifies before any browser
-- launch and refuses to replay on mismatch.
--
-- Defence-in-depth (separate code change): credential placeholders
-- `$username` / `$password` are now resolved only inside `login.steps`.
-- Even an unsigned-but-poisoned row that referenced `$password` from a
-- non-login step would now throw before typing.
--
-- Rollout: ENFORCEMENT controlled by env `RECIPE_SIGNING_ENFORCE` on the
-- CUA worker. Values: 'warn' (default — log mismatch but proceed) or
-- 'enforce' (refuse). Backfill script signs existing active/draft rows
-- before flipping enforce. New columns are nullable so deploy ordering
-- (migration → code → backfill → enforce flip) is safe.

alter table public.pms_recipes
  add column if not exists signature bytea,
  add column if not exists signed_with_key_id text,
  add column if not exists signed_at timestamptz;

-- Indexes only matter for "list everything signed/unsigned" admin queries
-- (e.g. the backfill script). The recipe runner always loads by id +
-- pms_type which is already covered by existing indexes.
create index if not exists pms_recipes_unsigned_idx
  on public.pms_recipes(pms_type, version desc)
  where signature is null;

comment on column public.pms_recipes.signature is
  'HMAC-SHA256 over canonical JSON of the recipe field, computed with RECIPE_SIGNING_KEY. NULL means unsigned (rows from before migration 0151 / the rollout flip). Verified by recipe-runner before each replay; refuses on mismatch when RECIPE_SIGNING_ENFORCE=enforce. Closes F-AI-2.';

comment on column public.pms_recipes.signed_with_key_id is
  'Short identifier of the RECIPE_SIGNING_KEY used. Lets the verifier accept a previous-generation key during a rotation grace window (verifier tries the active key first, then the previous one). NULL on unsigned rows.';

comment on column public.pms_recipes.signed_at is
  'Timestamp the signature was written. Used by ops dashboards + the doctor''s recipes_all_signed check.';

insert into applied_migrations (version, description)
values (
  '0151',
  'pms_recipes: HMAC signature columns (signature, signed_with_key_id, signed_at) for F-AI-2 recipe-integrity close'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
