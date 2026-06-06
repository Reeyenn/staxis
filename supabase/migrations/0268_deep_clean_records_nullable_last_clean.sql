-- 0268 — Allow deep_clean_records.last_deep_clean to be NULL.
--
-- (Renumbered from 0266 → 0268: 0266 was taken in prod by the knowledge-doc-
--  reading branch (pgvector + knowledge_chunks) and 0267 by a staff /
--  shift_confirmations replica-identity re-fix. Both already applied.)
--
-- Bug (pre-existing since 0001_initial_schema): last_deep_clean was declared
-- `date not null`, but a room can be SCHEDULED for a deep clean before it has
-- ever been deep-cleaned. assignRoomDeepClean() correctly OMITS last_deep_clean
-- for a never-cleaned room (writing a fake "cleaned today" date would lie and
-- corrupt the freshness math + advance the cycle), so the insert hit
--   null value in column "last_deep_clean" ... violates not-null constraint (23502)
-- and the Deep Clean "Schedule" button failed for every never-cleaned room —
-- i.e. ALL overdue rooms on a property that hasn't logged a deep clean yet.
--
-- Fix: drop the NOT NULL. A scheduled-but-never-cleaned record legitimately has
-- last_deep_clean = NULL. Read paths already tolerate it: the row mapper coerces
-- null → '' (fromDeepCleanRecordRow), the Deep Clean tab treats a falsy date as
-- "never cleaned", and daysSinceDeepClean() is hardened in this same change to
-- return Infinity for an empty date. Purely permissive — additive, no effect on
-- existing rows or live main.

alter table public.deep_clean_records
  alter column last_deep_clean drop not null;

insert into public.applied_migrations (version, description)
values (
  '0268',
  'Allow deep_clean_records.last_deep_clean to be NULL so a never-cleaned room can be scheduled (status=in_progress) without a fake clean date — fixes the Deep Clean Schedule button failing with 23502 on never-cleaned rooms. (Renumbered from 0266; 0266/0267 taken by parallel branches.)'
)
on conflict (version) do nothing;

-- Reload PostgREST so the REST layer drops the stale NOT NULL immediately.
notify pgrst, 'reload schema';
